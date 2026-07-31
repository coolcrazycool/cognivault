"""Tests for the judge client: tolerant JSON parsing + retry/transport wiring.

Style follows ``cognivault-ui/tests``: ``sys.path.insert``, no conftest, no new
dependencies. The network is ``httpx.MockTransport``; ``asyncio.run`` drives the
async API (no pytest-asyncio).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gigachat_client import (  # noqa: E402
    GigaChatHTTPError,
    GigaChatJSONError,
    GigaChatJudge,
    JudgeConfig,
    extract_json,
)


def _cfg() -> JudgeConfig:
    return JudgeConfig(base_url="https://giga.example/v1", model="GigaChat-Test")


def _judge(handler, **kw) -> GigaChatJudge:
    async def _sleep(_delay: float) -> None:
        return None

    return GigaChatJudge(
        _cfg(),
        transport=httpx.MockTransport(handler),
        sleep=kw.pop("sleep", _sleep),
        jitter=kw.pop("jitter", lambda: 0.0),
        **kw,
    )


def _completion(text: str, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status, json={"choices": [{"message": {"role": "assistant", "content": text}}]}
    )


# --------------------------------------------------------------------------- #
# extract_json
# --------------------------------------------------------------------------- #


def test_extract_json_bare_object():
    assert extract_json('{"score": 5}') == {"score": 5}


def test_extract_json_fenced_block():
    text = 'Вот результат:\n```json\n{"score": 4, "reason": "ок"}\n```\n'
    assert extract_json(text) == {"score": 4, "reason": "ок"}


def test_extract_json_fence_without_language():
    text = "```\n{\"verdicts\": [{\"id\": 1, \"verdict\": 1}]}\n```"
    assert extract_json(text)["verdicts"][0]["id"] == 1


def test_extract_json_preamble_and_trailing_text():
    text = 'Конечно! {"score": 3, "noncommittal": false} — надеюсь, это помогло.'
    assert extract_json(text) == {"score": 3, "noncommittal": False}


def test_extract_json_nested_braces_in_string():
    text = 'Ответ: {"reason": "фрагмент {1} про Qdrant", "verdict": 1}'
    parsed = extract_json(text)
    assert parsed["verdict"] == 1
    assert "{1}" in parsed["reason"]


def test_extract_json_broken_raises():
    with pytest.raises(GigaChatJSONError):
        extract_json("судья ушёл в отказ, JSON не будет")


def test_extract_json_empty_raises():
    with pytest.raises(GigaChatJSONError):
        extract_json("   ")


def test_extract_json_skips_unparseable_first_object():
    text = 'мусор {не json, зато скобки} потом {"score": 2}'
    assert extract_json(text) == {"score": 2}


# --------------------------------------------------------------------------- #
# HTTP behaviour
# --------------------------------------------------------------------------- #


def test_complete_returns_message_content():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/chat/completions")
        payload = json.loads(request.content.decode("utf-8"))
        assert payload["stream"] is False
        assert payload["messages"][-1]["content"] == "Привет"
        return _completion("Ответ")

    async def go() -> str:
        async with _judge(handler) as judge:
            return await judge.complete("Привет")

    assert asyncio.run(go()) == "Ответ"


def test_body_keeps_cyrillic_raw():
    seen: dict[str, bytes] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = request.content
        return _completion("ok")

    async def go() -> None:
        async with _judge(handler) as judge:
            await judge.complete("Кириллица")

    asyncio.run(go())
    assert "Кириллица".encode("utf-8") in seen["body"]
    assert b"\\u04" not in seen["body"]


def test_retries_on_429_then_succeeds():
    calls = {"n": 0}
    delays: list[float] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(429, headers={"Retry-After": "2"}, text="slow down")
        return _completion('{"score": 5}')

    async def sleep(delay: float) -> None:
        delays.append(delay)

    async def go() -> dict:
        async with _judge(handler, sleep=sleep) as judge:
            return await judge.complete_json("prompt")

    assert asyncio.run(go()) == {"score": 5}
    assert calls["n"] == 3
    assert delays and min(delays) >= 2.0  # Retry-After respected


def test_retries_on_500_and_gives_up():
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500, text="boom")

    async def go() -> None:
        async with _judge(handler) as judge:
            await judge.complete("prompt")

    with pytest.raises(GigaChatHTTPError) as exc:
        asyncio.run(go())
    assert exc.value.code == "GIGACHAT_HTTP_500"
    assert calls["n"] == 4  # MAX_ATTEMPTS


def test_client_error_is_not_retried():
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, text="bad request")

    async def go() -> None:
        async with _judge(handler) as judge:
            await judge.complete("prompt")

    with pytest.raises(GigaChatHTTPError):
        asyncio.run(go())
    assert calls["n"] == 1


def test_complete_json_unwraps_fenced_answer():
    def handler(_request: httpx.Request) -> httpx.Response:
        return _completion('```json\n{"verdicts": [{"id": 1, "verdict": 0}]}\n```')

    async def go() -> dict:
        async with _judge(handler) as judge:
            return await judge.complete_json("prompt")

    assert asyncio.run(go())["verdicts"] == [{"id": 1, "verdict": 0}]


def test_judge_model_env_override(monkeypatch):
    monkeypatch.setenv("EVAL_JUDGE_MODEL", "GigaChat-Judge")
    monkeypatch.setenv("GIGACHAT_MODEL", "GigaChat-Chat")
    monkeypatch.setenv("GIGACHAT_BASE_URL", "https://giga.example/v1")
    monkeypatch.setenv("COGNIVAULT_UI_CONFIG", "/nonexistent/config.json")
    cfg = JudgeConfig.from_env()
    assert cfg.model == "GigaChat-Judge"
    assert cfg.base_url == "https://giga.example/v1"
