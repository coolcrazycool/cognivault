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


def _install_chat(monkeypatch, paths, *, sources, answer):
    async def fake_build_rag_context(query, *args, **kwargs):
        return rag.RagContext(
            system_message={"role": "system", "content": "правила"},
            user_message={"role": "user", "content": f"Источники:\n\nВопрос: {query}"},
            sources=sources,
            context_chars=42,
        )

    async def fake_stream_chat(messages, gcfg):
        yield answer

    monkeypatch.setattr(chat_routes, "resolve_paths", lambda request: paths)
    monkeypatch.setattr(chat_routes.rag, "build_rag_context", fake_build_rag_context)
    monkeypatch.setattr(chat_routes.gigachat, "stream_chat", fake_stream_chat)
    monkeypatch.setattr(chat_routes.gigachat, "_files_present", lambda gcfg: None)


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
        }
    ]
    _install_chat(
        monkeypatch,
        paths,
        sources=sources,
        answer="ответ [Источник 1] и [Источник 7]",
    )

    with TestClient(create_app()) as client:
        resp = client.post(
            "/api/chat",
            json={
                "messages": [
                    {"role": "user", "content": "первый вопрос"},
                    {"role": "assistant", "content": "первый ответ"},
                    {"role": "user", "content": "как настроить ЕФС?"},
                ],
                "rag": True,
            },
        )

    assert resp.status_code == 200
    chat_id = dict(_parse_sse(resp.text))["meta"]["chat_id"]

    records = _records(paths)
    assert len(records) == 1
    rec = records[0]
    assert set(rec) == {
        "type",
        "ts",
        "chat_id",
        "message_index",
        "intent",
        "question_raw",
        "question_standalone",
        "candidates",
        "grades",
        "sources",
        "answer_chars",
        "invalid_citations",
        "rag_used",
        "notice",
        "truncated",
    }
    assert rec["type"] == "request"
    assert rec["chat_id"] == chat_id
    # 3 incoming messages → the answer is index 3 in the persisted chat.
    assert rec["message_index"] == 3
    assert rec["question_raw"] == "как настроить ЕФС?"
    assert rec["intent"] is None and rec["question_standalone"] is None
    assert rec["candidates"] is None and rec["grades"] is None
    assert rec["sources"] == [
        {
            "n": 1,
            "path": "notes/a.md",
            "section_path": "Раздел > Подраздел",
            "depth": "section",
            "score": 0.91,
        }
    ]
    assert rec["answer_chars"] == len("ответ [Источник 1] и [Источник 7]")
    assert rec["invalid_citations"] == [7]
    assert rec["rag_used"] is True
    assert rec["notice"] is None
    assert rec["truncated"] is False


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
