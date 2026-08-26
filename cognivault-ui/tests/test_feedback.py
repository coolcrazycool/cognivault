"""Route tests for ``POST /api/feedback`` (wave 5.4) + the chat request log.

Covers:
* a successful ``up``/``down`` vote lands in ``rag_log.jsonl`` as ``"feedback"``;
* manual body validation (bad vote, missing chat_id, bad message_index) → 400;
* server mode without a bearer header → 401 (router-level auth);
* an over-long ``comment`` is truncated;
* a normal ``/api/chat`` turn (rag + gigachat mocked) leaves a ``"request"``
  record whose ``message_index`` matches the answer's position in the chat.

pytest + Starlette ``TestClient``; LOCAL mode unless a test says otherwise, and
``resolve_paths`` monkeypatched to a tmp dir.
"""

from __future__ import annotations

import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import rag, rag_log, settings  # noqa: E402
from app.config import AppPaths  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes import chat_routes, feedback_routes  # noqa: E402


def _paths(tmp_path) -> AppPaths:
    return AppPaths(root=tmp_path / ".cognivault-ui")


@pytest.fixture(autouse=True)
def _local_mode(monkeypatch):
    monkeypatch.setattr(settings, "is_server", lambda: False)


def _records(paths: AppPaths) -> list[dict]:
    return rag_log.read_records(paths)


def _parse_sse(text: str) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    for block in text.split("\n\n"):
        event = None
        data = None
        for line in block.splitlines():
            if line.startswith("event: "):
                event = line[len("event: ") :]
            elif line.startswith("data: "):
                data = json.loads(line[len("data: ") :])
        if event is not None:
            out.append((event, data or {}))
    return out


# --------------------------------------------------------------------------- #
# POST /api/feedback
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("vote", ["up", "down"])
def test_feedback_vote_is_logged(tmp_path, monkeypatch, vote):
    paths = _paths(tmp_path)
    monkeypatch.setattr(feedback_routes, "resolve_paths", lambda request: paths)

    with TestClient(create_app()) as client:
        resp = client.post(
            "/api/feedback",
            json={"chat_id": "20260731-101010-ab12", "message_index": 3, "vote": vote},
        )

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    records = _records(paths)
    assert len(records) == 1
    assert records[0]["type"] == "feedback"
    assert records[0]["chat_id"] == "20260731-101010-ab12"
    assert records[0]["message_index"] == 3
    assert records[0]["vote"] == vote
    assert records[0]["comment"] is None
    assert records[0]["ts"]


def test_feedback_comment_is_truncated(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    monkeypatch.setattr(feedback_routes, "resolve_paths", lambda request: paths)

    with TestClient(create_app()) as client:
        resp = client.post(
            "/api/feedback",
            json={
                "chat_id": "c1",
                "message_index": 0,
                "vote": "down",
                "comment": "ы" * 5000,
            },
        )

    assert resp.status_code == 200
    comment = _records(paths)[0]["comment"]
    assert len(comment) == feedback_routes.MAX_COMMENT_CHARS == 1000
    assert set(comment) == {"ы"}


@pytest.mark.parametrize(
    "body",
    [
        {"chat_id": "c1", "message_index": 0, "vote": "meh"},
        {"chat_id": "c1", "message_index": 0},
        {"message_index": 0, "vote": "up"},
        {"chat_id": "", "message_index": 0, "vote": "up"},
        {"chat_id": "c1", "vote": "up"},
        {"chat_id": "c1", "message_index": "0", "vote": "up"},
        {"chat_id": "c1", "message_index": -1, "vote": "up"},
        {"chat_id": "c1", "message_index": True, "vote": "up"},
        ["not", "an", "object"],
    ],
)
def test_feedback_rejects_bad_body(tmp_path, monkeypatch, body):
    paths = _paths(tmp_path)
    monkeypatch.setattr(feedback_routes, "resolve_paths", lambda request: paths)

    with TestClient(create_app()) as client:
        resp = client.post("/api/feedback", json=body)

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "BAD_REQUEST"
    assert not rag_log.log_path(paths).exists()


def test_feedback_requires_token_in_server_mode(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    monkeypatch.setattr(settings, "is_server", lambda: True)
    monkeypatch.setattr(feedback_routes, "resolve_paths", lambda request: paths)

    with TestClient(create_app()) as client:
        anon = client.post(
            "/api/feedback",
            json={"chat_id": "c1", "message_index": 0, "vote": "up"},
        )
        authed = client.post(
            "/api/feedback",
            json={"chat_id": "c1", "message_index": 0, "vote": "up"},
            headers={"Authorization": "Bearer tok"},
        )

    assert anon.status_code == 401
    assert anon.json()["error"]["code"] == "UNAUTHORIZED"
    assert authed.status_code == 200
    assert len(_records(paths)) == 1


def test_feedback_reports_write_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(feedback_routes, "resolve_paths", lambda request: _paths(tmp_path))
    monkeypatch.setattr(feedback_routes.rag_log, "append", lambda paths, record: False)

    with TestClient(create_app()) as client:
        resp = client.post(
            "/api/feedback",
            json={"chat_id": "c1", "message_index": 0, "vote": "up"},
        )

    assert resp.status_code == 500
    assert resp.json()["error"]["code"] == "LOG_WRITE_FAILED"


# --------------------------------------------------------------------------- #
# /api/chat leaves a "request" record
# --------------------------------------------------------------------------- #


#: Every key a ``"request"`` record must carry. Kept as a literal set so that
#: dropping a field (the harness reads all of them) fails loudly here.
REQUEST_KEYS = {
    "type",
    "ts",
    "chat_id",
    "message_index",
    "intent",
    "question_raw",
    "question_standalone",
    "scope",
    "hedge",
    "candidates",
    "grades",
    "sources",
    "context_text",
    "context_chars",
    "context_truncated_in_log",
    "head_block",
    "answer_text",
    "answer_chars",
    "answer_truncated_in_log",
    "finish_reason",
    "invalid_citations",
    "rag_used",
    "notice",
    "truncated",
    "errored",
    "settings",
    "timings_ms",
}

CONTEXT_BLOCK = "### Источник 1: Док — notes/a.md > Раздел\nтело раздела\n"


def _install_chat(monkeypatch, paths, *, sources, answer, finish_reason="stop"):
    async def fake_build_rag_context(query, *args, **kwargs):
        return rag.RagContext(
            system_message={"role": "system", "content": "правила"},
            user_message={
                "role": "user",
                "content": (
                    f"Источники:\n\n{CONTEXT_BLOCK}\n\nнапоминание\n\nВопрос: {query}"
                ),
            },
            sources=sources,
            context_chars=len(CONTEXT_BLOCK),
        )

    async def fake_stream_chat(messages, gcfg):
        gcfg.last_finish_reason = finish_reason
        yield answer

    monkeypatch.setattr(chat_routes, "resolve_paths", lambda request: paths)
    monkeypatch.setattr(chat_routes.rag, "build_rag_context", fake_build_rag_context)
    monkeypatch.setattr(chat_routes.llm, "stream_chat", fake_stream_chat)
    monkeypatch.setattr(chat_routes.llm, "files_present", lambda gcfg: None)


def _ask(client, **extra):
    return client.post(
        "/api/chat",
        json={
            "messages": [
                {"role": "user", "content": "первый вопрос"},
                {"role": "assistant", "content": "первый ответ"},
                {"role": "user", "content": "как настроить ЕФС?"},
            ],
            "rag": True,
            **extra,
        },
    )


def test_chat_writes_request_record(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    sources = [
        {
            "n": 1,
            "title": "Док",
            "path": "notes/a.md",
            "section_path": "Раздел > Подраздел",
            "score": 0.91,
            "depth": "section",
            "grade": 5,
        }
    ]
    _install_chat(
        monkeypatch,
        paths,
        sources=sources,
        answer="ответ [Источник 1] и [Источник 7]",
    )

    with TestClient(create_app()) as client:
        resp = _ask(client)

    assert resp.status_code == 200
    chat_id = dict(_parse_sse(resp.text))["meta"]["chat_id"]

    records = _records(paths)
    assert len(records) == 1
    rec = records[0]
    assert set(rec) == REQUEST_KEYS
    assert rec["type"] == "request"
    assert rec["chat_id"] == chat_id
    # 3 incoming messages → the answer is index 3 in the persisted chat.
    assert rec["message_index"] == 3
    assert rec["question_raw"] == "как настроить ЕФС?"
    # Поля конвейера волны 2 приходят из `RagContext`; здесь он замокан пустым,
    # поэтому они `None`. Заполненный случай — в `test_chat_intent_routing.py`.
    assert rec["intent"] is None and rec["question_standalone"] is None
    assert rec["candidates"] is None and rec["grades"] is None
    assert rec["sources"] == [
        {
            "n": 1,
            "path": "notes/a.md",
            "section_path": "Раздел > Подраздел",
            "depth": "section",
            "score": 0.91,
            "grade": 5,
            # Кандидатов нет (RagContext замокан) — чанк восстановить не из чего.
            "chunk_index": None,
            "chunk_indexes": [],
        }
    ]
    assert rec["answer_chars"] == len("ответ [Источник 1] и [Источник 7]")
    assert rec["invalid_citations"] == [7]
    assert rec["rag_used"] is True
    assert rec["notice"] is None
    assert rec["truncated"] is False
    assert rec["errored"] is False


def test_request_record_carries_answer_and_rendered_context(tmp_path, monkeypatch):
    """Ответ и ТОТ САМЫЙ блок «Источники» — вход правила диагностики."""
    paths = _paths(tmp_path)
    _install_chat(monkeypatch, paths, sources=[{"n": 1, "path": "notes/a.md"}], answer="ответ")

    with TestClient(create_app()) as client:
        _ask(client)

    rec = _records(paths)[0]
    assert rec["answer_text"] == "ответ"
    assert rec["answer_truncated_in_log"] is False
    # Ровно блок источников: без «Источники:», напоминания и вопроса.
    assert rec["context_text"] == CONTEXT_BLOCK
    assert rec["context_chars"] == len(CONTEXT_BLOCK)
    assert rec["context_truncated_in_log"] is False


def test_request_record_flags_truncation_of_long_text(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    monkeypatch.setattr(chat_routes.rag_log, "MAX_TEXT_CHARS", 10)
    _install_chat(monkeypatch, paths, sources=[], answer="я" * 50)

    with TestClient(create_app()) as client:
        _ask(client)

    rec = _records(paths)[0]
    assert rec["answer_text"] == "я" * 10
    assert rec["answer_chars"] == 50
    assert rec["answer_truncated_in_log"] is True


@pytest.mark.parametrize("reason", ["stop", "length"])
def test_request_record_keeps_finish_reason(tmp_path, monkeypatch, reason):
    """Обрыв по `length` виден в логе — раньше значение выбрасывалось."""
    paths = _paths(tmp_path)
    _install_chat(monkeypatch, paths, sources=[], answer="ответ", finish_reason=reason)

    with TestClient(create_app()) as client:
        _ask(client)

    assert _records(paths)[0]["finish_reason"] == reason


def test_request_record_snapshots_settings_without_secrets(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    _install_chat(monkeypatch, paths, sources=[], answer="ответ")

    with TestClient(create_app()) as client:
        _ask(client, rag_limit=7, temperature=0.9, max_tokens=1234)

    snapshot = _records(paths)[0]["settings"]
    assert snapshot["rag"]["limit"] == 7
    assert snapshot["rag"]["grader_threshold"] == 4
    assert snapshot["rag"]["rerank_candidates"] == 40
    assert snapshot["gigachat"]["max_tokens"] == 1234
    assert snapshot["gigachat"]["model"]
    # Дефолтные (некастомизированные) промпты — отпечатка нет.
    assert snapshot["prompts"] == {"system": None, "context_reminder": None}
    # Ни путей к сертификатам, ни паролей, ни токенов.
    raw = rag_log.log_path(paths).read_text(encoding="utf-8")
    for leaked in ("cert_path", "key_path", "passphrase", "client_crt", "client_key"):
        assert leaked not in raw


def test_request_record_reports_stage_timings(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    _install_chat(monkeypatch, paths, sources=[], answer="ответ")

    with TestClient(create_app()) as client:
        _ask(client)

    timings = _records(paths)[0]["timings_ms"]
    # Стадии, которыми владеет сам роут (RAG-слой и GigaChat здесь замоканы,
    # поэтому condense/search/grade в этот прогон не попадают).
    assert {"rag", "stream", "first_token", "total"} <= set(timings)
    assert all(isinstance(v, (int, float)) and v >= 0 for v in timings.values())
    assert timings["total"] >= timings["stream"]


def test_chat_record_and_feedback_share_the_file(tmp_path, monkeypatch):
    """A vote for the answer just produced sits next to its request record."""
    paths = _paths(tmp_path)
    _install_chat(monkeypatch, paths, sources=[], answer="ответ без RAG")
    monkeypatch.setattr(feedback_routes, "resolve_paths", lambda request: paths)

    with TestClient(create_app()) as client:
        resp = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "вопрос"}], "rag": False},
        )
        chat_id = dict(_parse_sse(resp.text))["meta"]["chat_id"]
        vote = client.post(
            "/api/feedback",
            json={"chat_id": chat_id, "message_index": 1, "vote": "up"},
        )

    assert vote.status_code == 200
    records = _records(paths)
    assert [r["type"] for r in records] == ["request", "feedback"]
    assert records[0]["rag_used"] is False
    assert records[0]["message_index"] == records[1]["message_index"] == 1
    assert records[0]["chat_id"] == records[1]["chat_id"] == chat_id
