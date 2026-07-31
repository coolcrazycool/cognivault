"""Обрезка истории чата под контекстное окно модели (итерация 0.D).

Покрывает:
* :func:`app.tokens.estimate_tokens` / :func:`app.tokens.estimate_messages_tokens`;
* :func:`app.tokens.trim_history` — короткая история не режется, длинная режется
  парами, последний вопрос пользователя всегда на месте, порядок сохранён,
  одиночное огромное сообщение не выбрасывается;
* ``POST /api/chat`` — реально уходящий в ``gigachat.stream_chat`` список
  усечён, system первым, порядок SSE-событий не изменился.

pytest + Starlette ``TestClient`` (без сети). LOCAL-режим, ``resolve_paths``
монипатчится в tmp-каталог.
"""

from __future__ import annotations

import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import settings  # noqa: E402
from app.config import AppPaths  # noqa: E402
from app.main import create_app  # noqa: E402
from app.rag import RagContext  # noqa: E402
from app.routes import chat_routes  # noqa: E402
from app.tokens import estimate_messages_tokens, estimate_tokens, trim_history  # noqa: E402


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


def _turn(i: int, size: int = 600) -> list[dict]:
    """Одна пара реплик user+assistant с предсказуемым объёмом."""
    return [
        {"role": "user", "content": f"в{i} " + "я" * size},
        {"role": "assistant", "content": f"о{i} " + "б" * size},
    ]


# --------------------------------------------------------------------------- #
# estimate_tokens
# --------------------------------------------------------------------------- #


def test_estimate_tokens_empty():
    assert estimate_tokens("") == 0


def test_estimate_tokens_rounds_up():
    assert estimate_tokens("a") == 1
    assert estimate_tokens("abc") == 1
    assert estimate_tokens("abcd") == 2
    assert estimate_tokens("я" * 300) == 100


def test_estimate_messages_tokens_adds_per_message_overhead():
    msgs = [{"role": "user", "content": "abc"}, {"role": "assistant", "content": "abc"}]
    # 1 токен на content + фиксированный оверхед на сообщение.
    assert estimate_messages_tokens(msgs) == 2 * (1 + 4)


def test_estimate_messages_tokens_tolerates_missing_content():
    assert estimate_messages_tokens([{"role": "user"}]) == 4
    assert estimate_messages_tokens([]) == 0


# --------------------------------------------------------------------------- #
# trim_history
# --------------------------------------------------------------------------- #


def test_trim_history_short_untouched():
    msgs = [*_turn(1, 10), {"role": "user", "content": "вопрос"}]
    out, dropped = trim_history(msgs, 10_000)
    assert dropped == 0
    assert out == msgs


def test_trim_history_empty():
    assert trim_history([], 100) == ([], 0)


def test_trim_history_drops_oldest_in_pairs():
    msgs = [*_turn(1), *_turn(2), *_turn(3), {"role": "user", "content": "последний"}]
    # Одна пара ≈ 2 * (200 + 4) ≈ 408 токенов; бюджета хватит примерно на две.
    out, dropped = trim_history(msgs, 900)

    assert dropped % 2 == 0
    assert dropped > 0
    assert estimate_messages_tokens(out) <= 900
    # Осталась именно хвостовая часть исходного списка, порядок не нарушен.
    assert out == msgs[dropped:]
    # Парность: история (без последнего вопроса) — чередование user/assistant.
    assert [m["role"] for m in out[:-1]] == ["user", "assistant"] * ((len(out) - 1) // 2)


def test_trim_history_keeps_last_user_question():
    msgs = [*_turn(1), *_turn(2), *_turn(3), {"role": "user", "content": "последний"}]
    out, dropped = trim_history(msgs, 300)
    assert out[-1] == {"role": "user", "content": "последний"}
    assert dropped == len(msgs) - len(out)


def test_trim_history_keeps_huge_last_message_even_over_budget():
    msgs = [*_turn(1), {"role": "user", "content": "щ" * 30_000}]
    out, dropped = trim_history(msgs, 100)
    assert out == [msgs[-1]]
    assert dropped == 2
    # Бюджет превышен сознательно — вопрос пользователя не выбрасывается.
    assert estimate_messages_tokens(out) > 100


def test_trim_history_preserves_order_of_survivors():
    msgs = [*_turn(1), *_turn(2), *_turn(3), *_turn(4), {"role": "user", "content": "q"}]
    out, _ = trim_history(msgs, 1000)
    idx = [msgs.index(m) for m in out]
    assert idx == sorted(idx)


# --------------------------------------------------------------------------- #
# _fit_to_context
# --------------------------------------------------------------------------- #


def test_fit_to_context_keeps_system_prefix_and_trims_rest():
    system = {"role": "system", "content": "ctx " + "к" * 3000}
    send = [system, *_turn(1, 30_000), *_turn(2, 30_000), {"role": "user", "content": "q"}]
    out, dropped = chat_routes._fit_to_context(
        send, {"model_context_tokens": 32768, "max_tokens": 4096}
    )
    assert out[0] is system
    assert dropped > 0
    assert out[-1] == {"role": "user", "content": "q"}
    assert len(out) < len(send)


def test_fit_to_context_defaults_when_keys_missing():
    send = [{"role": "user", "content": "привет"}]
    out, dropped = chat_routes._fit_to_context(send, {})
    assert (out, dropped) == (send, 0)


# --------------------------------------------------------------------------- #
# Интеграция: что реально уходит в GigaChat
# --------------------------------------------------------------------------- #


def _install_chat_stubs(monkeypatch, tmp_path, *, rag: bool):
    """Замокать GigaChat/RAG и вернуть список перехваченных `messages`."""
    captured: list[list[dict]] = []

    async def fake_stream_chat(messages, gcfg):
        captured.append([dict(m) for m in messages])
        yield "ответ"

    async def fake_build_rag_context(query, *args, **kwargs):
        return RagContext(
            system_message={"role": "system", "content": "правила ответа"},
            user_message={"role": "user", "content": f"Источники:\n\nВопрос: {query}"},
            sources=[
                {"n": 1, "title": "T", "path": "a.md", "section_path": "",
                 "score": 0.9, "depth": "chunk"}
            ],
            context_chars=3,
        )

    monkeypatch.setattr(chat_routes, "resolve_paths", lambda request: _paths(tmp_path))
    monkeypatch.setattr(chat_routes.gigachat, "stream_chat", fake_stream_chat)
    monkeypatch.setattr(chat_routes.gigachat, "_files_present", lambda gcfg: None)
    if rag:
        monkeypatch.setattr(chat_routes.rag, "build_rag_context", fake_build_rag_context)
    return captured


def _long_thread(turns: int = 40) -> list[dict]:
    msgs: list[dict] = []
    for i in range(turns):
        msgs.extend(_turn(i, 1500))
    msgs.append({"role": "user", "content": "финальный вопрос"})
    return msgs


def test_chat_trims_long_history_before_sending(monkeypatch, tmp_path):
    captured = _install_chat_stubs(monkeypatch, tmp_path, rag=True)
    messages = _long_thread()

    with TestClient(create_app()) as client:
        resp = client.post("/api/chat", json={"messages": messages, "rag": True})

    assert resp.status_code == 200
    assert captured, "stream_chat не был вызван"
    sent = captured[0]

    assert sent[0]["role"] == "system"
    assert len(sent) < len(messages) + 1
    # Последним идёт user-сообщение с контекстом, вопрос внутри него.
    assert sent[-1]["role"] == "user"
    assert sent[-1]["content"].endswith("Вопрос: финальный вопрос")
    # Парность истории между system и последним вопросом сохранена.
    roles = [m["role"] for m in sent[1:-1]]
    assert roles == ["user", "assistant"] * (len(roles) // 2)
    assert len(roles) % 2 == 0


def test_chat_short_history_not_trimmed(monkeypatch, tmp_path):
    captured = _install_chat_stubs(monkeypatch, tmp_path, rag=False)
    messages = [*_turn(1, 10), {"role": "user", "content": "коротко"}]

    with TestClient(create_app()) as client:
        resp = client.post("/api/chat", json={"messages": messages})

    assert resp.status_code == 200
    assert [m["content"] for m in captured[0]] == [m["content"] for m in messages]


def test_chat_sse_event_order_unchanged(monkeypatch, tmp_path):
    _install_chat_stubs(monkeypatch, tmp_path, rag=True)

    with TestClient(create_app()) as client:
        resp = client.post(
            "/api/chat", json={"messages": _long_thread(), "rag": True}
        )

    events = [name for name, _ in _parse_sse(resp.text)]
    assert events[0] == "meta"
    assert events[1] == "sources"
    assert events[-1] == "done"
    assert set(events[2:-1]) == {"token"}


def test_chat_persists_untrimmed_history(monkeypatch, tmp_path):
    """Обрезка касается только модели — на диск ложится полная история."""
    from app import history

    captured = _install_chat_stubs(monkeypatch, tmp_path, rag=True)
    saved: list[list[dict]] = []
    monkeypatch.setattr(
        history, "save_chat", lambda cid, msgs, paths: saved.append(list(msgs))
    )

    messages = _long_thread()
    with TestClient(create_app()) as client:
        client.post("/api/chat", json={"messages": messages, "rag": True})

    assert saved, "save_chat не был вызван"
    persisted_user_side = [m for m in saved[0] if m.get("role") != "assistant"]
    # Все пользовательские реплики сохранены, хотя в модель ушла лишь часть.
    assert len(persisted_user_side) == len([m for m in messages if m["role"] == "user"])
    assert len(captured[0]) < len(messages)
