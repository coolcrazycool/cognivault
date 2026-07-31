"""Маршрутизация интентов в ``POST /api/chat`` (волна 2, пункты 2.1/2.3).

Проверяется поведение роута, а не сам конвейер: `rag.build_rag_context`
замокан и возвращает готовый `RagContext` для каждого из трёх исходов.

* ``smalltalk``/``clarify`` — сообщений нет и ``notice`` нет: обычная генерация
  по истории как есть, кадр ``sources`` не эмитится;
* ``answer_override`` — ответ уже готов: GigaChat не вызывается, ровно один
  кадр ``token``, ``sources`` пустой, ``done`` с ``finish_reason="no_context"``;
* ``kb_question`` — обычный путь, ``sources`` приходит ДО первого ``token``
  (требование 2.3: маскировка латентности двух новых вызовов).

Плюс запись ``"request"`` в ``rag_log.jsonl``: ``intent``/``question_standalone``
всегда, ``candidates``/``grades`` — для ``kb_question``.

pytest + Starlette ``TestClient``, LOCAL-режим, ``resolve_paths`` в tmp-каталог.
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
from app.history import load_chat  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes import chat_routes  # noqa: E402

REFUSAL = "В базе знаний нет данных по этому вопросу."


def _paths(tmp_path) -> AppPaths:
    return AppPaths(root=tmp_path / ".cognivault-ui")


@pytest.fixture(autouse=True)
def _local_mode(monkeypatch):
    monkeypatch.setattr(settings, "is_server", lambda: False)


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


def _events(text: str) -> list[str]:
    return [name for name, _ in _parse_sse(text)]


def _ctx(**fields) -> rag.RagContext:
    """`RagContext` с полями волны 2, даже если датакласс их ещё не объявил.

    Роут читает новые поля через ``getattr``, поэтому тест не должен зависеть
    от того, приземлился ли уже расширенный контракт в ``app/rag.py``.
    """
    known = {"system_message", "user_message", "sources", "notice", "context_chars"}
    ctx = rag.RagContext(**{k: v for k, v in fields.items() if k in known})
    for key, value in fields.items():
        if key not in known:
            setattr(ctx, key, value)
    return ctx


def _install(monkeypatch, paths, ctx, *, answer="ответ модели"):
    """Замокать RAG-слой и GigaChat; вернуть список перехваченных вызовов."""
    calls: list[dict] = []

    async def fake_build_rag_context(query, *args, **kwargs):
        calls.append({"kind": "rag", "query": query})
        return ctx

    async def fake_stream_chat(messages, gcfg):
        calls.append({"kind": "stream", "messages": [dict(m) for m in messages]})
        yield answer

    monkeypatch.setattr(chat_routes, "resolve_paths", lambda request: paths)
    monkeypatch.setattr(chat_routes.rag, "build_rag_context", fake_build_rag_context)
    monkeypatch.setattr(chat_routes.gigachat, "stream_chat", fake_stream_chat)
    monkeypatch.setattr(chat_routes.gigachat, "_files_present", lambda gcfg: None)
    return calls


def _kb_ctx(question: str = "как настроить ЕФС в 1С?") -> rag.RagContext:
    return _ctx(
        system_message={"role": "system", "content": "правила"},
        user_message={"role": "user", "content": f"Источники:\n\nВопрос: {question}"},
        sources=[
            {
                "n": 1,
                "title": "Док",
                "path": "notes/a.md",
                "section_path": "Раздел",
                "depth": "section",
                "score": 0.91,
                "grade": 5,
            }
        ],
        context_chars=128,
        intent="kb_question",
        standalone_question=question,
        candidates=[
            {"path": "notes/a.md", "chunk_index": 0, "score": 0.91, "rank": 1},
            {"path": "notes/b.md", "chunk_index": 2, "score": 0.42, "rank": 2},
        ],
        grades=[
            {"id": 1, "path": "notes/a.md", "chunk_index": 0, "score": 5},
            {"id": 2, "path": "notes/b.md", "chunk_index": 2, "score": 2},
        ],
    )


def _post(client, messages, **extra):
    return client.post("/api/chat", json={"messages": messages, "rag": True, **extra})


# --------------------------------------------------------------------------- #
# smalltalk / clarify
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("intent", ["smalltalk", "clarify"])
def test_smalltalk_generates_without_sources(tmp_path, monkeypatch, intent):
    """Нет сообщений и нет notice → обычная генерация, кадра `sources` нет."""
    paths = _paths(tmp_path)
    ctx = _ctx(intent=intent, standalone_question=None)
    calls = _install(monkeypatch, paths, ctx, answer="и тебе привет")

    messages = [
        {"role": "user", "content": "как настроить ЕФС?"},
        {"role": "assistant", "content": "вот так"},
        {"role": "user", "content": "спасибо!"},
    ]
    with TestClient(create_app()) as client:
        resp = _post(client, messages)

    assert resp.status_code == 200
    events = _events(resp.text)
    assert "sources" not in events
    assert "notice" not in events
    assert events == ["meta", "token", "done"]

    stream = [c for c in calls if c["kind"] == "stream"]
    assert stream, "stream_chat не был вызван"
    # История уходит как есть: ни системных правил, ни блока «Источники».
    assert stream[0]["messages"] == messages

    rec = rag_log.read_records(paths)[0]
    assert rec["intent"] == intent
    assert rec["rag_used"] is False
    assert rec["sources"] == []
    assert rec["notice"] is None


def test_smalltalk_log_keeps_raw_question(tmp_path, monkeypatch):
    """Для smalltalk `question_standalone` пуст, но `question_raw` — нет."""
    paths = _paths(tmp_path)
    _install(monkeypatch, paths, _ctx(intent="smalltalk"))

    with TestClient(create_app()) as client:
        _post(client, [{"role": "user", "content": "привет"}])

    rec = rag_log.read_records(paths)[0]
    assert rec["question_raw"] == "привет"
    assert rec["question_standalone"] is None
    assert rec["candidates"] is None and rec["grades"] is None


# --------------------------------------------------------------------------- #
# answer_override — готовый ответ без генерации
# --------------------------------------------------------------------------- #


def test_answer_override_skips_gigachat(tmp_path, monkeypatch):
    """Ответ отдаётся одним токеном, GigaChat не вызывается вообще."""
    paths = _paths(tmp_path)
    ctx = _ctx(
        intent="kb_question",
        standalone_question="как настроить ЕФС в 1С?",
        answer_override=REFUSAL,
        candidates=[{"path": "notes/a.md", "chunk_index": 0, "score": 0.3, "rank": 1}],
        grades=[{"id": 1, "path": "notes/a.md", "chunk_index": 0, "score": 2}],
    )
    calls = _install(monkeypatch, paths, ctx)

    with TestClient(create_app()) as client:
        resp = _post(client, [{"role": "user", "content": "как настроить ЕФС?"}])

    assert resp.status_code == 200
    frames = _parse_sse(resp.text)
    assert [name for name, _ in frames] == ["meta", "sources", "token", "done"]

    by_event = dict(frames)
    assert by_event["sources"] == {"sources": [], "context_chars": 0}
    assert by_event["token"] == {"text": REFUSAL}
    assert by_event["done"]["finish_reason"] == "no_context"

    assert [c["kind"] for c in calls] == ["rag"], "stream_chat не должен вызываться"


def test_answer_override_persists_like_a_normal_answer(tmp_path, monkeypatch):
    """В истории и в логе отказ выглядит обычным RAG-ответом без источников."""
    paths = _paths(tmp_path)
    _install(
        monkeypatch,
        paths,
        _ctx(
            intent="kb_question",
            standalone_question="как настроить ЕФС в 1С?",
            answer_override=REFUSAL,
            sources=[{"n": 1, "path": "notes/a.md", "score": 0.3, "grade": 2}],
            context_chars=99,
            grades=[{"id": 1, "path": "notes/a.md", "chunk_index": 0, "score": 2}],
        ),
    )

    with TestClient(create_app()) as client:
        resp = _post(client, [{"role": "user", "content": "как настроить ЕФС?"}])
        chat_id = dict(_parse_sse(resp.text))["meta"]["chat_id"]

    chat = load_chat(chat_id, paths)
    assistant = chat["messages"][-1]
    assert assistant["role"] == "assistant"
    assert assistant["content"] == REFUSAL
    # Поиск выполнялся, поэтому ход считается RAG-ходом; но в контекст ничего
    # не попало — источников нет и context_chars нулевой.
    assert assistant["rag"] is True
    assert assistant["sources"] == []
    assert assistant["context_chars"] == 0
    assert assistant["truncated"] is False
    assert assistant["invalid_citations"] == []

    rec = rag_log.read_records(paths)[0]
    assert rec["rag_used"] is True
    assert rec["sources"] == []
    assert rec["answer_chars"] == len(REFUSAL)
    assert rec["intent"] == "kb_question"
    assert rec["question_standalone"] == "как настроить ЕФС в 1С?"
    assert rec["grades"]


# --------------------------------------------------------------------------- #
# kb_question — обычный путь и порядок кадров (2.3)
# --------------------------------------------------------------------------- #


def test_kb_question_emits_sources_before_first_token(tmp_path, monkeypatch):
    """`sources` приходит ДО первого `token` — латентность 2 вызовов скрыта."""
    paths = _paths(tmp_path)
    calls = _install(monkeypatch, paths, _kb_ctx(), answer="ответ [Источник 1]")

    with TestClient(create_app()) as client:
        resp = _post(client, [{"role": "user", "content": "как настроить ЕФС?"}])

    assert resp.status_code == 200
    events = _events(resp.text)
    assert events == ["meta", "sources", "token", "done"]
    assert events.index("sources") < events.index("token")
    assert "notice" not in events

    payload = dict(_parse_sse(resp.text))["sources"]
    assert payload["context_chars"] == 128
    assert payload["sources"][0]["grade"] == 5

    stream = [c for c in calls if c["kind"] == "stream"]
    assert stream, "stream_chat не был вызван"
    assert [m["role"] for m in stream[0]["messages"]] == ["system", "user"]


def test_kb_question_logs_pipeline_telemetry(tmp_path, monkeypatch):
    """Запись лога несёт интент, самодостаточный вопрос, кандидатов и грейды."""
    paths = _paths(tmp_path)
    _install(monkeypatch, paths, _kb_ctx(), answer="ответ [Источник 1]")

    with TestClient(create_app()) as client:
        _post(
            client,
            [
                {"role": "user", "content": "расскажи про ЕФС"},
                {"role": "assistant", "content": "ЕФС — это…"},
                {"role": "user", "content": "а как её настроить?"},
            ],
        )

    rec = rag_log.read_records(paths)[0]
    assert rec["type"] == "request"
    assert rec["intent"] == "kb_question"
    assert rec["question_raw"] == "а как её настроить?"
    assert rec["question_standalone"] == "как настроить ЕФС в 1С?"
    assert [c["path"] for c in rec["candidates"]] == ["notes/a.md", "notes/b.md"]
    assert [g["score"] for g in rec["grades"]] == [5, 2]
    assert rec["rag_used"] is True
    assert rec["sources"][0]["path"] == "notes/a.md"


def test_notice_branch_still_wins_over_sources(tmp_path, monkeypatch):
    """Сбой поиска: `notice` вместо `sources`, генерация по истории как есть."""
    paths = _paths(tmp_path)
    ctx = _ctx(notice="Поиск недоступен", intent="kb_question", standalone_question="ЕФС")
    _install(monkeypatch, paths, ctx)

    with TestClient(create_app()) as client:
        resp = _post(client, [{"role": "user", "content": "как настроить ЕФС?"}])

    events = _events(resp.text)
    assert events == ["meta", "notice", "token", "done"]
    rec = rag_log.read_records(paths)[0]
    assert rec["notice"] == "Поиск недоступен"
    assert rec["rag_used"] is False
    assert rec["intent"] == "kb_question"
