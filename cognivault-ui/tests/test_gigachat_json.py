"""Unit tests for app.gigachat.complete_json — the non-streaming JSON call.

Uses httpx.MockTransport for the network and asyncio.run to drive the async API
(no pytest-asyncio needed). The retry loop never sleeps for real: the module
attributes ``_sleep``/``_jitter`` are monkeypatched. pytest is a dev-only
dependency — install it in your sandbox to run these; it is NOT in
requirements.txt.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import gigachat  # noqa: E402
from app.gigachat import (  # noqa: E402
    GigaChatError,
    GigaConfig,
    complete_json,
    extract_json,
)

BASE = "https://giga.example/v1"


def _cfg() -> GigaConfig:
    return GigaConfig(
        base_url=BASE,
        model="GigaChat-Test",
        cert_path="/nonexistent/client.pem",
        key_path="/nonexistent/client.key",
        key_passphrase="",
        verify_ssl=False,
        temperature=0.2,
        max_tokens=4096,
    )


def _completion(text: str, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status,
        json={"choices": [{"message": {"role": "assistant", "content": text}}]},
    )


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    """Make the retry loop instantaneous and deterministic."""
    slept: list[float] = []

    async def _sleep(delay: float) -> None:
        slept.append(delay)

    monkeypatch.setattr(gigachat, "_sleep", _sleep)
    monkeypatch.setattr(gigachat, "_jitter", lambda: 0.0)
    return slept


def _run(handler, **kw):
    return asyncio.run(
        complete_json(
            [{"role": "user", "content": "привет"}],
            _cfg(),
            transport=httpx.MockTransport(handler),
            **kw,
        )
    )


# --------------------------------------------------------------------------- #
# extract_json (pure)
# --------------------------------------------------------------------------- #


def test_extract_json_bare_object():
    assert extract_json('{"intent": "search"}') == {"intent": "search"}


def test_extract_json_fenced_block():
    text = '```json\n{"intent": "search", "reason": "ок"}\n```'
    assert extract_json(text) == {"intent": "search", "reason": "ок"}


def test_extract_json_empty_answer_is_bad_json():
    with pytest.raises(GigaChatError) as exc:
        extract_json("   ")
    assert exc.value.code == "GIGACHAT_BAD_JSON"


# --------------------------------------------------------------------------- #
# Happy paths through the wire
# --------------------------------------------------------------------------- #


def test_plain_json_content():
    def handler(_request: httpx.Request) -> httpx.Response:
        return _completion('{"queries": ["a", "b"], "n": 2}')

    assert _run(handler) == {"queries": ["a", "b"], "n": 2}


def test_json_wrapped_in_code_fence():
    def handler(_request: httpx.Request) -> httpx.Response:
        return _completion('```json\n{"score": 4, "reason": "норм"}\n```\n')

    assert _run(handler) == {"score": 4, "reason": "норм"}


def test_json_after_chatty_preamble():
    def handler(_request: httpx.Request) -> httpx.Response:
        return _completion(
            'Конечно! Вот результат разбора:\n{"intent": "rag", "conf": 0.9}\n'
            "Надеюсь, это поможет."
        )

    assert _run(handler) == {"intent": "rag", "conf": 0.9}


# --------------------------------------------------------------------------- #
# Bad JSON
# --------------------------------------------------------------------------- #


def test_garbage_without_json_raises_bad_json():
    def handler(_request: httpx.Request) -> httpx.Response:
        return _completion("Извините, я не могу ответить на этот вопрос.")

    with pytest.raises(GigaChatError) as exc:
        _run(handler)
    assert exc.value.code == "GIGACHAT_BAD_JSON"
    assert "Извините" in (exc.value.detail or "")


def test_json_array_instead_of_object_raises_bad_json():
    def handler(_request: httpx.Request) -> httpx.Response:
        return _completion('[{"a": 1}, {"b": 2}]')

    with pytest.raises(GigaChatError) as exc:
        _run(handler)
    assert exc.value.code == "GIGACHAT_BAD_JSON"


def test_scalar_instead_of_object_raises_bad_json():
    def handler(_request: httpx.Request) -> httpx.Response:
        return _completion("42")

    with pytest.raises(GigaChatError) as exc:
        _run(handler)
    assert exc.value.code == "GIGACHAT_BAD_JSON"


def test_bad_json_detail_is_clipped():
    def handler(_request: httpx.Request) -> httpx.Response:
        return _completion("нет json " * 400)

    with pytest.raises(GigaChatError) as exc:
        _run(handler)
    assert len(exc.value.detail or "") <= gigachat.DETAIL_LIMIT


# --------------------------------------------------------------------------- #
# Retries
# --------------------------------------------------------------------------- #


def test_429_with_retry_after_retries_once_then_succeeds(_no_real_sleep):
    calls: list[int] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "7"}, text="slow down")
        return _completion('{"ok": true}')

    assert _run(handler) == {"ok": True}
    assert len(calls) == 2
    # Retry-After (7s) wins over the 1s exponential backoff.
    assert _no_real_sleep == [7.0]


def test_500_exhausts_attempts_then_raises(_no_real_sleep):
    calls: list[int] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(500, text="boom")

    with pytest.raises(GigaChatError) as exc:
        _run(handler)
    assert exc.value.code == "GIGACHAT_HTTP_500"
    assert len(calls) == gigachat.JSON_MAX_ATTEMPTS
    # One sleep fewer than attempts, and the delay doubles each time.
    assert _no_real_sleep == [1.0, 2.0]


def test_400_fails_fast_without_retry(_no_real_sleep):
    calls: list[int] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(400, text="bad request")

    with pytest.raises(GigaChatError) as exc:
        _run(handler)
    assert exc.value.code == "GIGACHAT_HTTP_400"
    assert len(calls) == 1
    assert _no_real_sleep == []


# --------------------------------------------------------------------------- #
# Wire format / wiring
# --------------------------------------------------------------------------- #


def test_request_body_shape_and_raw_utf8():
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["raw"] = request.content
        return _completion('{"ok": 1}')

    asyncio.run(
        complete_json(
            [{"role": "user", "content": "Привет, мир"}],
            _cfg(),
            temperature=0.0,
            max_tokens=256,
            transport=httpx.MockTransport(handler),
        )
    )

    raw = seen["raw"]
    assert isinstance(raw, bytes)
    assert seen["url"] == f"{BASE}/chat/completions"
    # Cyrillic must travel as raw UTF-8, not \uXXXX escapes.
    assert "Привет, мир".encode("utf-8") in raw
    assert b"\\u041f" not in raw

    payload = json.loads(raw.decode("utf-8"))
    assert payload["stream"] is False
    assert payload["model"] == "GigaChat-Test"
    assert payload["temperature"] == 0.0
    assert payload["max_tokens"] == 256
    assert payload["messages"] == [{"role": "user", "content": "Привет, мир"}]


def test_transport_skips_cert_check(monkeypatch):
    called: list[int] = []

    def _boom(_gcfg) -> None:
        called.append(1)
        raise AssertionError("_files_present must not run when transport is given")

    monkeypatch.setattr(gigachat, "_files_present", _boom)

    def handler(_request: httpx.Request) -> httpx.Response:
        return _completion('{"ok": 1}')

    assert _run(handler) == {"ok": 1}
    assert called == []


def test_read_timeout_is_bounded_by_the_timeout_argument():
    seen: dict[str, object] = {}

    class _Probe(httpx.AsyncBaseTransport):
        async def handle_async_request(
            self, request: httpx.Request
        ) -> httpx.Response:
            seen["timeout"] = request.extensions.get("timeout")
            return _completion('{"ok": 1}')

    asyncio.run(
        complete_json(
            [{"role": "user", "content": "x"}],
            _cfg(),
            timeout=3.5,
            transport=_Probe(),
        )
    )
    assert seen["timeout"] == {
        "connect": 10.0,
        "read": 3.5,
        "write": 30.0,
        "pool": 10.0,
    }


def test_stream_chat_read_timeout_unchanged(monkeypatch):
    """complete_json must not have altered the streaming client's timeouts."""
    seen: dict[str, object] = {}

    class _Recorder:
        def __init__(self, **kw: object) -> None:
            seen.update(kw)

    monkeypatch.setattr(gigachat.httpx, "AsyncClient", _Recorder)
    gigachat._make_client(_cfg())

    timeout = seen["timeout"]
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.read is None
    assert timeout.connect == 10.0
