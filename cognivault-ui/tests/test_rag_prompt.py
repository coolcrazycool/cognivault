"""RAG-промпт волны 1: правила в system, контекст — в последнем user-сообщении.

Покрывает:
* :func:`app.rag.build_rag_context` — новый контракт :class:`app.rag.RagContext`,
  разделение «правила / источники», порядок «Источники → Напоминание → Вопрос»,
  нумерация блоков, жёсткий кап на число блоков, пустой ``section_path``;
* ``POST /api/chat`` — сборка ``[system, ...история..., user-с-контекстом]``,
  прежний последний вопрос не дублируется, история между ними режется;
* :func:`app.routes.chat_routes._invalid_citations` — серверная валидация цитат.

Мокается ТОЛЬКО транспорт (``rag.cognivault.hybrid_search`` / ``.content``) и
скрытые LLM-вызовы волны 2 (``rag_pipeline.gigachat.complete_json``), поэтому
тестируется настоящий ``rag.py``, а не заглушка.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import rag, rag_pipeline, settings  # noqa: E402
from app.config import AppPaths  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes import chat_routes  # noqa: E402


def _paths(tmp_path) -> AppPaths:
    return AppPaths(root=tmp_path / ".cognivault-ui")


@pytest.fixture(autouse=True)
def _local_mode(monkeypatch):
    """Force LOCAL mode (no bearer header required)."""
    monkeypatch.setattr(settings, "is_server", lambda: False)


def _parse_sse(text: str) -> list[tuple[str, dict]]:
    """Parse an SSE body into ``[(event, data_dict), ...]``."""
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
# Фикстуры данных
# --------------------------------------------------------------------------- #


def _hit(i: int, *, section: str = "", text: str | None = None) -> dict:
    return {
        "path": f"doc{i}.md",
        "title": f"Документ {i}",
        "section_path": section,
        "score": 1.0 - i / 100,
        "text": text if text is not None else f"содержимое фрагмента номер {i}",
        "chunk_index": i,
        "rank": i,
    }


def _install_retrieval(monkeypatch, hits: list[dict], contents: dict | None = None):
    """Замокать транспорт CogniVault: hybrid-поиск и выдачу документов.

    Заодно затыкается GigaChat волны 2: condense возвращает вопрос как есть,
    грейдер — «5» каждому фрагменту (порядок поиска сохраняется, ср. tie-break
    по ранку), поэтому эти тесты продолжают проверять сборку промпта, а не
    отбор — он живёт в ``test_rag_pipeline.py``.
    """
    calls: list[tuple[str, int]] = []

    async def fake_hybrid(query, limit, cv=None):
        calls.append((query, limit))
        return {"results": hits}

    async def fake_content(path, cv=None):
        if contents and path in contents:
            return contents[path]
        raise RuntimeError("content unavailable")

    async def fake_complete_json(messages, gcfg, **kwargs):
        prompt = messages[-1]["content"]
        if "Определи тип реплики" in prompt:
            tail = prompt.split("Последняя реплика пользователя: ", 1)[1]
            return {
                "intent": "kb_question",
                "standalone_question": tail.split("\n", 1)[0],
            }
        return {"grades": [{"id": i, "score": 5} for i in range(1, 41)]}

    monkeypatch.setattr(rag.cognivault, "hybrid_search", fake_hybrid)
    monkeypatch.setattr(rag.cognivault, "content", fake_content)
    monkeypatch.setattr(
        rag_pipeline.gigachat, "complete_json", fake_complete_json, raising=False
    )
    return calls


def _build(query: str, hits: list[dict], **rcfg) -> rag.RagContext:
    """Синхронная обёртка над ``build_rag_context`` в auto-режиме."""
    cfg = {"mode": "auto", "max_expanded_files": 0}
    cfg.update(rcfg)
    return asyncio.run(rag.build_rag_context(query, cfg, None, {}, None))


# --------------------------------------------------------------------------- #
# Нормализация
# --------------------------------------------------------------------------- #


def test_norm_semantic_keeps_chunk_index_and_rank():
    out = rag._norm_semantic([_hit(1)])
    assert out[0]["chunk_index"] == 1
    assert out[0]["rank"] == 1


def test_sources_do_not_leak_internal_fields(monkeypatch):
    _install_retrieval(monkeypatch, [_hit(1)])
    ctx = _build("вопрос про архитектуру сервиса", [_hit(1)])
    assert set(ctx.sources[0]) == {
        "n", "title", "path", "section_path", "score", "depth", "grade"
    }


def test_auto_mode_retrieves_rerank_candidates_wide(monkeypatch):
    """Ширина ретрива в auto — `rerank_candidates` (волна 2: 20), не `limit`."""
    calls = _install_retrieval(monkeypatch, [_hit(1)])
    _build("вопрос про архитектуру сервиса", [_hit(1)], limit=3)
    assert calls[0][1] == 20

    calls.clear()
    _build("вопрос про архитектуру сервиса", [_hit(1)], rerank_candidates=40)
    assert calls[0][1] == 40


# --------------------------------------------------------------------------- #
# system: только правила
# --------------------------------------------------------------------------- #


def test_system_message_holds_rules_only(monkeypatch):
    hits = [_hit(1, text="секретный текст фрагмента про кластер")]
    _install_retrieval(monkeypatch, hits)
    ctx = _build("что известно про кластер и его настройку", hits)

    assert isinstance(ctx, rag.RagContext)
    system = ctx.system_message["content"]
    # Правила на месте.
    assert "[Источник N]" in system
    assert "Не выдумывай источники" in system
    assert "markdown-таблицы" in system
    # А текста источников — нет.
    assert "секретный текст фрагмента" not in system
    assert "Источники:" not in system
    assert "### Источник" not in system


def test_context_lives_in_user_message(monkeypatch):
    hits = [_hit(1, text="секретный текст фрагмента про кластер")]
    _install_retrieval(monkeypatch, hits)
    ctx = _build("что известно про кластер и его настройку", hits)

    assert ctx.user_message["role"] == "user"
    assert "секретный текст фрагмента про кластер" in ctx.user_message["content"]
    assert ctx.context_chars > 0


# --------------------------------------------------------------------------- #
# user: порядок «Источники → Напоминание → Вопрос»
# --------------------------------------------------------------------------- #


def test_user_message_section_order(monkeypatch):
    hits = [_hit(1), _hit(2)]
    _install_retrieval(monkeypatch, hits)
    query = "какие сервисы описаны в документации проекта"
    ctx = _build(query, hits)

    content = ctx.user_message["content"]
    i_sources = content.index("Источники:")
    i_reminder = content.index("Напоминание:")
    i_question = content.index("Вопрос:")
    assert i_sources < i_reminder < i_question
    assert content.startswith("Источники:")
    assert content.endswith(f"Вопрос: {query}")


def test_block_numbering_matches_sources(monkeypatch):
    hits = [_hit(1), _hit(2), _hit(3)]
    _install_retrieval(monkeypatch, hits)
    ctx = _build("перечисли все известные документы по теме", hits)

    content = ctx.user_message["content"]
    assert [s["n"] for s in ctx.sources] == [1, 2, 3]
    for src in ctx.sources:
        header = f"### Источник {src['n']}: {src['title']} — {src['path']}"
        assert header in content
    # Нумерация сплошная и не начинается с нуля.
    assert "### Источник 0:" not in content
    assert "### Источник 4:" not in content


def test_header_with_section_path(monkeypatch):
    hits = [_hit(1, section="Раздел > Подраздел")]
    _install_retrieval(monkeypatch, hits)
    ctx = _build("расскажи про подраздел документа подробнее", hits)

    assert (
        "### Источник 1: Документ 1 — doc1.md > Раздел > Подраздел"
        in ctx.user_message["content"]
    )


def test_empty_section_path_has_no_dangling_separator(monkeypatch):
    hits = [_hit(1, section="")]
    _install_retrieval(monkeypatch, hits)
    ctx = _build("что написано в первом документе базы знаний", hits)

    header = [
        line
        for line in ctx.user_message["content"].splitlines()
        if line.startswith("### Источник")
    ][0]
    assert header == "### Источник 1: Документ 1 — doc1.md"
    assert ">" not in header.rstrip()


# --------------------------------------------------------------------------- #
# Кап на число блоков (пункт 1.4)
# --------------------------------------------------------------------------- #


def test_context_capped_at_max_blocks(monkeypatch):
    hits = [_hit(i) for i in range(1, 11)]
    _install_retrieval(monkeypatch, hits)
    ctx = _build("подробный вопрос по всей базе знаний сразу", hits)

    assert rag._MAX_CONTEXT_BLOCKS == 5
    assert len(ctx.sources) == 5
    assert ctx.user_message["content"].count("### Источник ") == 5
    assert "### Источник 6:" not in ctx.user_message["content"]
    # Отброшены именно худшие по score.
    assert [s["path"] for s in ctx.sources] == [f"doc{i}.md" for i in range(1, 6)]


def test_cap_applies_to_expanded_files_too(monkeypatch):
    """Экспансия документов не может обойти кап."""
    hits = [_hit(i) for i in range(1, 11)]
    contents = {f"doc{i}.md": f"# Документ {i}\n\nполный текст {i}" for i in range(1, 11)}
    _install_retrieval(monkeypatch, hits, contents)
    ctx = _build(
        "подробный вопрос по всей базе знаний сразу", hits, max_expanded_files=8
    )

    assert len(ctx.sources) <= rag._MAX_CONTEXT_BLOCKS


# --------------------------------------------------------------------------- #
# Пустая/сломанная выдача
# --------------------------------------------------------------------------- #


def test_no_results_yields_empty_context(monkeypatch):
    _install_retrieval(monkeypatch, [])
    ctx = _build("вопрос, на который ничего не находится", [])
    assert (ctx.system_message, ctx.user_message, ctx.sources, ctx.notice) == (
        None, None, [], None
    )


def test_retrieval_failure_yields_notice(monkeypatch):
    async def boom(*args, **kwargs):
        raise RuntimeError("нет связи")

    monkeypatch.setattr(rag.cognivault, "hybrid_search", boom)
    monkeypatch.setattr(rag.cognivault, "semantic_search", boom)
    ctx = _build("любой вопрос при недоступном поиске", [])
    assert ctx.notice == rag._RETRIEVAL_UNAVAILABLE
    assert ctx.system_message is None and ctx.user_message is None


# --------------------------------------------------------------------------- #
# Валидация цитат
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "text,n,expected",
    [
        ("всё хорошо [Источник 1] и [Источник 2]", 3, []),
        ("плохо [Источник 9]", 3, [9]),
        ("[Источники 1, 7] и [Источника 2; 8]", 3, [7, 8]),
        ("[Источник 0]", 3, [0]),
        ("без цитат вообще", 3, []),
        ("", 3, []),
        ("[Источник 1]", 0, [1]),
    ],
)
def test_invalid_citations(text, n, expected):
    assert chat_routes._invalid_citations(text, n) == expected


# --------------------------------------------------------------------------- #
# Интеграция: что реально уходит в GigaChat
# --------------------------------------------------------------------------- #


def _install_chat(monkeypatch, tmp_path, hits, *, answer="ответ", contents=None):
    """Замокать транспорт + GigaChat; вернуть перехваченные ``messages``."""
    captured: list[list[dict]] = []

    async def fake_stream_chat(messages, gcfg):
        captured.append([dict(m) for m in messages])
        yield answer

    _install_retrieval(monkeypatch, hits, contents)
    monkeypatch.setattr(chat_routes, "resolve_paths", lambda request: _paths(tmp_path))
    monkeypatch.setattr(chat_routes.gigachat, "stream_chat", fake_stream_chat)
    monkeypatch.setattr(chat_routes.gigachat, "_files_present", lambda gcfg: None)
    return captured


def test_chat_sends_system_history_and_context_message(monkeypatch, tmp_path):
    hits = [_hit(1), _hit(2)]
    captured = _install_chat(monkeypatch, tmp_path, hits)
    messages = [
        {"role": "user", "content": "первый вопрос пользователя"},
        {"role": "assistant", "content": "первый ответ ассистента"},
        {"role": "user", "content": "второй вопрос пользователя"},
    ]

    with TestClient(create_app()) as client:
        resp = client.post("/api/chat", json={"messages": messages, "rag": True})

    assert resp.status_code == 200
    assert captured, "stream_chat не был вызван"
    sent = captured[0]

    assert [m["role"] for m in sent] == ["system", "user", "assistant", "user"]
    # system — только правила.
    assert "[Источник N]" in sent[0]["content"]
    assert "### Источник" not in sent[0]["content"]
    # История сохранена как есть.
    assert sent[1]["content"] == "первый вопрос пользователя"
    assert sent[2]["content"] == "первый ответ ассистента"
    # Последнее сообщение — контекст + тот же вопрос, без дубля в истории.
    last = sent[-1]["content"]
    assert last.startswith("Источники:")
    assert last.endswith("Вопрос: второй вопрос пользователя")
    assert [m for m in sent[:-1] if m["content"] == "второй вопрос пользователя"] == []


def test_chat_without_rag_keeps_plain_history(monkeypatch, tmp_path):
    captured = _install_chat(monkeypatch, tmp_path, [_hit(1)])
    messages = [{"role": "user", "content": "просто вопрос"}]

    with TestClient(create_app()) as client:
        resp = client.post("/api/chat", json={"messages": messages})

    assert resp.status_code == 200
    assert captured[0] == [{"role": "user", "content": "просто вопрос"}]


def test_chat_trims_history_but_never_the_context_message(monkeypatch, tmp_path):
    """Бюджет учитывает system и финальное сообщение; режется только середина."""
    hits = [_hit(1, text="ф" * 6000)]
    captured = _install_chat(monkeypatch, tmp_path, hits)

    messages: list[dict] = []
    for i in range(40):
        messages.append({"role": "user", "content": f"в{i} " + "я" * 1500})
        messages.append({"role": "assistant", "content": f"о{i} " + "б" * 1500})
    messages.append({"role": "user", "content": "финальный вопрос"})

    with TestClient(create_app()) as client:
        resp = client.post("/api/chat", json={"messages": messages, "rag": True})

    assert resp.status_code == 200
    sent = captured[0]
    assert len(sent) < len(messages) + 1, "история должна быть урезана"
    assert sent[0]["role"] == "system"
    # Контекст цел: он в защищённом хвосте trim_history.
    assert sent[-1]["content"].startswith("Источники:")
    assert sent[-1]["content"].endswith("Вопрос: финальный вопрос")
    assert "ф" * 6000 in sent[-1]["content"]
    # Между system и контекстом — только целые пары user/assistant.
    roles = [m["role"] for m in sent[1:-1]]
    assert roles == ["user", "assistant"] * (len(roles) // 2)
    # Бюджет соблюдён: system + история + контекст влезают в окно.
    from app.tokens import estimate_messages_tokens

    assert estimate_messages_tokens(sent) <= 32768 - 4096


def test_chat_reports_invalid_citation(monkeypatch, tmp_path, caplog):
    hits = [_hit(1), _hit(2), _hit(3)]
    _install_chat(
        monkeypatch, tmp_path, hits, answer="утверждение [Источник 9] и [Источник 2]"
    )
    saved: list[list[dict]] = []
    monkeypatch.setattr(
        chat_routes.history, "save_chat",
        lambda cid, msgs, paths: saved.append([dict(m) for m in msgs]),
    )

    with caplog.at_level(logging.WARNING, logger="cognivault-ui.chat"):
        with TestClient(create_app()) as client:
            resp = client.post(
                "/api/chat",
                json={
                    "messages": [{"role": "user", "content": "вопрос про источники"}],
                    "rag": True,
                },
            )

    assert resp.status_code == 200
    events = dict(_parse_sse(resp.text))
    assert len(events["sources"]["sources"]) == 3
    # Попало в структуру ассистентского сообщения…
    assert saved and saved[0][-1]["invalid_citations"] == [9]
    # …и в лог.
    assert any("9" in rec.getMessage() for rec in caplog.records)


def test_chat_valid_citations_are_silent(monkeypatch, tmp_path):
    hits = [_hit(1), _hit(2), _hit(3)]
    _install_chat(monkeypatch, tmp_path, hits, answer="факт [Источники 1, 3]")
    saved: list[list[dict]] = []
    monkeypatch.setattr(
        chat_routes.history, "save_chat",
        lambda cid, msgs, paths: saved.append([dict(m) for m in msgs]),
    )

    with TestClient(create_app()) as client:
        client.post(
            "/api/chat",
            json={
                "messages": [{"role": "user", "content": "вопрос про источники"}],
                "rag": True,
            },
        )

    assert saved and saved[0][-1]["invalid_citations"] == []
