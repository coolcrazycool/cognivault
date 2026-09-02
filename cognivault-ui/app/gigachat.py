"""Async mTLS client for GigaChat's OpenAI-compatible API.

Authentication is the client PEM certificate itself (no bearer token). Two
public entry points share the same config view and typed errors:

* :func:`stream_chat` — async generator yielding content deltas (``str``),
  used by the chat route, which maps the exceptions below to SSE ``error``
  frames (or a pre-flight ``400``);
* :func:`complete_json` — one blocking request, one parsed JSON object, with a
  real read timeout and retries on ``429``/``5xx``. Used by the pipeline steps
  (routing, query rewriting, reranking) that need structured output rather than
  a token stream.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import ssl
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable, NamedTuple

import httpx

from . import llm_trace, mtls
from .llm_errors import (  # re-exported: callers import these from here today
    GigaChatBadJSON,
    GigaChatCertMissing,
    GigaChatDNS,
    GigaChatError,
    GigaChatHTTP,
    GigaChatStreamDropped,
    GigaChatTLS,
)

__all__ = [
    "GigaChatBadJSON",
    "GigaChatCertMissing",
    "GigaChatDNS",
    "GigaChatError",
    "GigaChatHTTP",
    "GigaChatStreamDropped",
    "GigaChatTLS",
    "GigaConfig",
    "complete_json",
    "extract_json",
    "list_models",
    "stream_chat",
]

log = logging.getLogger("cognivault-ui.gigachat")


# --------------------------------------------------------------------------- #
# Config view + typed errors
# --------------------------------------------------------------------------- #


@dataclass
class GigaConfig:
    """Flattened view of the ``gigachat`` config section used for a request."""

    base_url: str
    model: str
    cert_path: str
    key_path: str
    key_passphrase: str
    verify_ssl: bool
    temperature: float
    max_tokens: int

    @classmethod
    def from_dict(cls, gc: dict[str, Any]) -> "GigaConfig":
        return cls(
            base_url=str(gc.get("base_url", "")).rstrip("/"),
            model=str(gc.get("model", "")),
            cert_path=os.path.expanduser(str(gc.get("cert_path", ""))),
            key_path=os.path.expanduser(str(gc.get("key_path", ""))),
            key_passphrase=str(gc.get("key_passphrase", "") or ""),
            verify_ssl=bool(gc.get("verify_ssl", False)),
            temperature=float(gc.get("temperature", 0.2)),
            max_tokens=int(gc.get("max_tokens", 4096)),
        )


# --------------------------------------------------------------------------- #
# TLS wiring
# --------------------------------------------------------------------------- #


def _files_present(gcfg: GigaConfig) -> None:
    """Raise :class:`GigaChatCertMissing` unless both cert and key exist."""
    mtls.files_present(gcfg)


def _build_verify(gcfg: GigaConfig) -> Any:
    return mtls.build_verify(gcfg)


def _make_client(gcfg: GigaConfig) -> httpx.AsyncClient:
    timeout = httpx.Timeout(connect=10.0, read=None, write=30.0, pool=10.0)
    return mtls.make_client(gcfg, timeout)


def _classify_connect_error(exc: Exception) -> GigaChatError:
    return mtls.classify_connect_error(exc, what="GigaChat")


# --------------------------------------------------------------------------- #
# Streaming
# --------------------------------------------------------------------------- #


async def list_models(
    gcfg: GigaConfig,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[dict[str, str]]:
    """Models the gateway offers: ``GET {base_url}/models``.

    The OpenAI-compatible companion to ``/chat/completions`` — same base URL,
    same client certificate. Shape is OpenAI's:
    ``{"object": "list", "data": [{"id", "object", "owned_by"}]}``.

    Returns ``[{"name", "label"}]`` to match the other transport, so the settings
    form does not care which provider answered. Errors propagate: an empty list
    would read as "the gateway offers no models", which is a different claim from
    "we could not ask".
    """
    if not gcfg.base_url:
        raise GigaChatError(
            "GIGACHAT_NOT_CONFIGURED", "Не задан адрес GigaChat", None
        )
    client = _make_json_client(gcfg, 30.0, transport)
    async with client:
        try:
            resp = await client.get(
                f"{gcfg.base_url}/models", headers={"Accept": "application/json"}
            )
        except httpx.HTTPError as exc:
            raise _classify_connect_error(exc) from exc
        if resp.status_code != 200:
            raise GigaChatHTTP(
                "GIGACHAT_HTTP",
                f"GigaChat вернул HTTP {resp.status_code} на список моделей",
                resp.text[:500],
            )
        try:
            body = resp.json()
        except ValueError as exc:
            raise GigaChatBadJSON(
                "GIGACHAT_BAD_JSON",
                "GigaChat вернул не-JSON на список моделей",
                str(exc),
            ) from exc

    items = (body or {}).get("data") if isinstance(body, dict) else body
    out: list[dict[str, str]] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("id") or "").strip()
        if name:
            out.append({"name": name, "label": name})
    return out


async def stream_chat(
    messages: list[dict[str, Any]], gcfg: GigaConfig
) -> AsyncIterator[str]:
    """Stream assistant content deltas from GigaChat's ``/chat/completions``.

    Yields non-empty ``content`` strings. The last successfully seen
    ``finish_reason`` is stored on ``gcfg`` via the attribute ``last_finish_reason``
    so the caller can read it after iteration completes.
    """
    _files_present(gcfg)

    url = f"{gcfg.base_url}/chat/completions"
    body = json.dumps(
        {
            "model": gcfg.model,
            "messages": messages,
            "temperature": gcfg.temperature,
            "max_tokens": gcfg.max_tokens,
            "stream": True,
        },
        ensure_ascii=False,
    ).encode()
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}

    setattr(gcfg, "last_finish_reason", None)
    parsed_any = False

    try:
        client = _make_client(gcfg)
    except ssl.SSLError as exc:
        raise GigaChatTLS(
            "GIGACHAT_TLS", "Не удалось загрузить сертификат/ключ", str(exc)
        ) from exc

    try:
        async with client:
            try:
                stream_cm = client.stream("POST", url, content=body, headers=headers)
            except httpx.ConnectError as exc:
                raise _classify_connect_error(exc) from exc

            async with stream_cm as resp:
                if resp.status_code != 200:
                    raw = await resp.aread()
                    detail = raw[:500].decode("utf-8", errors="replace")
                    raise GigaChatHTTP(
                        f"GIGACHAT_HTTP_{resp.status_code}",
                        f"GigaChat вернул HTTP {resp.status_code}",
                        detail,
                    )

                try:
                    async for line in resp.aiter_lines():
                        if not line or line.startswith(":"):
                            continue
                        if line.startswith("data:"):
                            payload = line[len("data:") :].strip()
                        else:
                            payload = line.strip()
                        if not payload:
                            continue
                        if payload == "[DONE]":
                            break
                        try:
                            chunk = json.loads(payload)
                        except json.JSONDecodeError:
                            log.warning("skipping unparseable SSE line: %r", payload)
                            continue
                        parsed_any = True
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0] or {}
                        finish = choice.get("finish_reason")
                        if finish:
                            setattr(gcfg, "last_finish_reason", finish)
                        delta = choice.get("delta") or {}
                        content = delta.get("content")
                        if content:
                            yield content
                except (httpx.ReadError, httpx.ReadTimeout, httpx.RemoteProtocolError) as exc:
                    raise GigaChatStreamDropped(
                        "GIGACHAT_STREAM_DROPPED",
                        "Соединение с GigaChat прервалось во время ответа",
                        str(exc),
                    ) from exc
    except httpx.ConnectError as exc:
        raise _classify_connect_error(exc) from exc
    except ssl.SSLError as exc:
        raise GigaChatTLS(
            "GIGACHAT_TLS", "Ошибка TLS-соединения с GigaChat", str(exc)
        ) from exc

    if not parsed_any:
        raise GigaChatStreamDropped(
            "GIGACHAT_STREAM_DROPPED",
            "GigaChat не вернул ни одного фрагмента ответа",
        )


# --------------------------------------------------------------------------- #
# Non-streaming JSON completion
# --------------------------------------------------------------------------- #

SleepFn = Callable[[float], Awaitable[None]]
JitterFn = Callable[[], float]

#: Total attempts (first try + retries) for a ``complete_json`` call.
JSON_MAX_ATTEMPTS = 3
#: First retry waits roughly this long; each further retry doubles it.
JSON_BASE_BACKOFF_SECONDS = 1.0
#: Upper bound for a single backoff sleep, ``Retry-After`` included.
JSON_MAX_BACKOFF_SECONDS = 30.0
#: Error ``detail`` payloads are clipped to this many characters.
DETAIL_LIMIT = 500

# Injection points for tests: monkeypatch these module attributes so the retry
# loop neither sleeps for real nor jitters unpredictably. Both are looked up at
# call time, so patching ``app.gigachat._sleep`` takes effect immediately.
_sleep: SleepFn = asyncio.sleep
_jitter: JitterFn = random.random


def _clip(text: str) -> str:
    """Trim an upstream payload to a size that is safe to log and to surface."""
    return text[:DETAIL_LIMIT]


def _strip_code_fences(text: str) -> str:
    """Return the body of the first ```/```json fenced block, else ``text``."""
    marker = text.find("```")
    if marker < 0:
        return text
    rest = text[marker + 3 :]
    newline = rest.find("\n")
    if newline < 0:
        return text
    # The info string ("json", "" …) is irrelevant — we try the body either way.
    body = rest[newline + 1 :]
    closing = body.find("```")
    return body[:closing] if closing >= 0 else body


def _iter_json_candidates(text: str) -> list[str]:
    """Collect balanced ``{...}`` substrings, outermost-first, in order."""
    out: list[str] = []
    for start, ch in enumerate(text):
        if ch != "{":
            continue
        depth = 0
        in_string = False
        escaped = False
        for i in range(start, len(text)):
            c = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif c == "\\":
                    escaped = True
                elif c == '"':
                    in_string = False
                continue
            if c == '"':
                in_string = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    out.append(text[start : i + 1])
                    break
    return out


def extract_json(text: str) -> dict[str, Any]:
    """Parse a JSON **object** out of a model answer.

    Handles the three shapes GigaChat actually produces: bare JSON, a ```json
    fenced block, and a chatty preamble ("Вот результат:") followed by the
    object. Arrays and scalars are rejected — callers expect a mapping.

    Raises :class:`GigaChatBadJSON` (code ``GIGACHAT_BAD_JSON``) when nothing
    parses, carrying a clipped excerpt of the answer in ``detail``.
    """
    if not text or not text.strip():
        raise GigaChatBadJSON(
            "GIGACHAT_BAD_JSON", "GigaChat вернул пустой ответ"
        )

    unparsed = object()
    for candidate_text in (text, _strip_code_fences(text)):
        stripped = candidate_text.strip()
        try:
            parsed: Any = json.loads(stripped)
        except json.JSONDecodeError:
            parsed = unparsed
        if isinstance(parsed, dict):
            return parsed
        if parsed is not unparsed:
            # Whole answer is valid JSON but not an object (array/scalar/null):
            # do not scavenge objects out of it — the contract is a mapping.
            continue
        for candidate in _iter_json_candidates(candidate_text):
            try:
                obj = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                return obj

    raise GigaChatBadJSON(
        "GIGACHAT_BAD_JSON",
        "Не удалось разобрать JSON в ответе GigaChat",
        detail=_clip(text),
    )


def _retry_after(value: str | None) -> float:
    """Parse a ``Retry-After`` header given in seconds; 0 when absent/garbage."""
    if not value:
        return 0.0
    try:
        return max(0.0, float(value.strip()))
    except ValueError:
        return 0.0


def _backoff(attempt: int) -> float:
    """Exponential backoff with up to 25% positive jitter, capped."""
    delay = JSON_BASE_BACKOFF_SECONDS * (2**attempt) * (1.0 + 0.25 * _jitter())
    return min(delay, JSON_MAX_BACKOFF_SECONDS)


class _Completion(NamedTuple):
    """The parts of an OpenAI-shaped completion the callers care about."""

    content: str
    finish_reason: str | None
    usage: dict[str, Any] | None


def _parse_completion(resp: httpx.Response) -> _Completion:
    """``choices[0]`` plus ``usage`` out of an OpenAI-shaped response.

    ``finish_reason`` and ``usage`` used to be read and thrown away here, which
    made an empty answer with ``finish_reason == "length"`` (the model spent the
    whole ``max_tokens`` budget on reasoning) indistinguishable from a model
    that had nothing to say.
    """
    try:
        data = resp.json()
    except ValueError as exc:
        raise GigaChatBadJSON(
            "GIGACHAT_BAD_JSON",
            "Ответ GigaChat не является JSON",
            _clip(resp.text),
        ) from exc
    choices = data.get("choices") if isinstance(data, dict) else None
    if not choices:
        raise GigaChatBadJSON(
            "GIGACHAT_BAD_JSON",
            "GigaChat вернул ответ без choices",
            _clip(resp.text),
        )
    first = choices[0] or {}
    message = first.get("message") or {}
    finish = first.get("finish_reason")
    usage = data.get("usage") if isinstance(data, dict) else None
    return _Completion(
        str(message.get("content", "") or ""),
        str(finish) if finish not in (None, "") else None,
        usage if isinstance(usage, dict) else None,
    )


def _make_json_client(
    gcfg: GigaConfig,
    read_timeout: float,
    transport: httpx.AsyncBaseTransport | None,
) -> httpx.AsyncClient:
    """Build the client for a blocking call — unlike the stream, ``read`` is set.

    When ``transport`` is supplied (tests) the certificate check and the whole
    TLS wiring are skipped: the fake transport never reaches the network.
    """
    timeout = httpx.Timeout(
        connect=10.0, read=read_timeout, write=30.0, pool=10.0
    )
    if transport is not None:
        return httpx.AsyncClient(transport=transport, timeout=timeout)

    _files_present(gcfg)
    verify = _build_verify(gcfg)
    if gcfg.key_passphrase:
        # Cert chain (incl. key) already loaded into the SSLContext.
        return httpx.AsyncClient(verify=verify, timeout=timeout)
    return httpx.AsyncClient(
        cert=(gcfg.cert_path, gcfg.key_path), verify=verify, timeout=timeout
    )


async def complete_json(
    messages: list[dict[str, Any]],
    gcfg: GigaConfig,
    *,
    timeout: float = 10.0,
    temperature: float = 0.0,
    max_tokens: int = 512,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Ask GigaChat for one structured answer and return it as a ``dict``.

    Non-streaming counterpart of :func:`stream_chat`: a single blocking POST to
    ``/chat/completions`` with ``stream: false``, bounded by ``timeout`` seconds
    of read time, retried on ``429``/``5xx`` (see :data:`JSON_MAX_ATTEMPTS`,
    ``Retry-After`` is honoured; other 4xx fail immediately). The assistant text
    goes through :func:`extract_json`, so fenced blocks and preambles are
    tolerated.

    ``temperature``/``max_tokens`` default to deterministic, short answers and
    intentionally override the chat-oriented values on ``gcfg``. Pass
    ``transport`` to drive the call with an ``httpx.MockTransport`` — that also
    disables the certificate pre-flight.

    Raises the module's typed errors: :class:`GigaChatCertMissing`,
    :class:`GigaChatTLS`, :class:`GigaChatDNS`, :class:`GigaChatHTTP`,
    :class:`GigaChatStreamDropped` (connection lost mid-answer) and
    :class:`GigaChatBadJSON`.

    What the call left behind (``finish_reason``, ``usage``, the head of the
    raw text, the model) is stamped onto ``gcfg`` — see :mod:`app.llm_trace`.
    The stamps are written BEFORE the text is parsed, so a reply that fails
    ``extract_json`` still says why (typically ``finish_reason == "length"``
    with an empty ``content_head``).
    """
    llm_trace.reset(gcfg, gcfg.model)
    try:
        client = _make_json_client(gcfg, timeout, transport)
    except ssl.SSLError as exc:
        raise GigaChatTLS(
            "GIGACHAT_TLS", "Не удалось загрузить сертификат/ключ", str(exc)
        ) from exc

    url = f"{gcfg.base_url}/chat/completions"
    body = json.dumps(
        {
            "model": gcfg.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        },
        ensure_ascii=False,  # Cyrillic goes over the wire raw, not as \uXXXX.
    ).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
    }

    attempts = max(1, JSON_MAX_ATTEMPTS)
    last_error: GigaChatError | None = None

    async with client:
        for attempt in range(attempts):
            try:
                resp = await client.post(url, content=body, headers=headers)
            except (httpx.ConnectError, ssl.SSLError) as exc:
                raise _classify_connect_error(exc) from exc
            except httpx.HTTPError as exc:
                # Read/write timeouts, resets, protocol violations: the request
                # left but no usable answer came back.
                raise GigaChatStreamDropped(
                    "GIGACHAT_STREAM_DROPPED",
                    "Соединение с GigaChat прервалось до получения ответа",
                    str(exc) or exc.__class__.__name__,
                ) from exc

            status = resp.status_code
            if status == 200:
                completion = _parse_completion(resp)
                llm_trace.stamp(
                    gcfg,
                    finish_reason=completion.finish_reason,
                    usage=completion.usage,
                    content=completion.content,
                )
                return extract_json(completion.content)

            last_error = GigaChatHTTP(
                f"GIGACHAT_HTTP_{status}",
                f"GigaChat вернул HTTP {status}",
                _clip(resp.text),
            )
            retryable = status == 429 or 500 <= status < 600
            if not retryable or attempt + 1 >= attempts:
                raise last_error

            delay = _backoff(attempt)
            if status == 429:
                delay = min(
                    JSON_MAX_BACKOFF_SECONDS,
                    max(delay, _retry_after(resp.headers.get("Retry-After"))),
                )
            log.warning(
                "gigachat complete_json: HTTP %s, retry %s/%s in %.2fs",
                status,
                attempt + 1,
                attempts - 1,
                delay,
            )
            await _sleep(delay)

    raise last_error or GigaChatHTTP(
        "GIGACHAT_HTTP_000", "Запрос к GigaChat не удался"
    )
