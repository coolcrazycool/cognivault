"""Async mTLS streaming client for GigaChat's OpenAI-compatible API.

Authentication is the client PEM certificate itself (no bearer token). The
public entry point :func:`stream_chat` is an async generator that yields content
deltas (``str``) and raises the typed exceptions below, which the chat route
maps to SSE ``error`` frames (or a pre-flight ``400``).
"""

from __future__ import annotations

import json
import logging
import os
import ssl
from dataclasses import dataclass
from typing import Any, AsyncIterator

import httpx

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


class GigaChatError(Exception):
    """Base class for GigaChat errors carrying an SSE-ready code/message/detail."""

    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


class GigaChatCertMissing(GigaChatError):
    """Client cert or key file is absent — surfaced as a pre-flight 400."""


class GigaChatDNS(GigaChatError):
    pass


class GigaChatTLS(GigaChatError):
    pass


class GigaChatHTTP(GigaChatError):
    pass


class GigaChatStreamDropped(GigaChatError):
    pass


# --------------------------------------------------------------------------- #
# TLS wiring
# --------------------------------------------------------------------------- #


def _files_present(gcfg: GigaConfig) -> None:
    """Raise :class:`GigaChatCertMissing` unless both cert and key exist."""
    missing = [
        p for p in (gcfg.cert_path, gcfg.key_path) if not (p and os.path.isfile(p))
    ]
    if missing:
        raise GigaChatCertMissing(
            "GIGACHAT_CERT_MISSING",
            "Клиентский сертификат или ключ не найдены",
            detail="; ".join(f"нет файла: {p}" for p in missing),
        )


def _build_verify(gcfg: GigaConfig) -> Any:
    """Compute the ``verify`` argument for httpx.

    A passphrase-protected key cannot be supplied through the plain ``cert``
    tuple, so we build an :class:`ssl.SSLContext`, load the cert chain with the
    password, and hand that to httpx via ``verify=`` (it also drives client auth).
    """
    if gcfg.key_passphrase:
        ctx = ssl.create_default_context()
        if not gcfg.verify_ssl:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        ctx.load_cert_chain(
            certfile=gcfg.cert_path,
            keyfile=gcfg.key_path,
            password=gcfg.key_passphrase,
        )
        return ctx
    return gcfg.verify_ssl


def _make_client(gcfg: GigaConfig) -> httpx.AsyncClient:
    timeout = httpx.Timeout(connect=10.0, read=None, write=30.0, pool=10.0)
    verify = _build_verify(gcfg)
    if gcfg.key_passphrase:
        # Cert chain (incl. key) already loaded into the SSLContext.
        return httpx.AsyncClient(verify=verify, timeout=timeout)
    return httpx.AsyncClient(
        cert=(gcfg.cert_path, gcfg.key_path), verify=verify, timeout=timeout
    )


def _classify_connect_error(exc: Exception) -> GigaChatError:
    text = str(exc).lower()
    if isinstance(exc, ssl.SSLError) or "ssl" in text or "certificate" in text:
        return GigaChatTLS("GIGACHAT_TLS", "Ошибка TLS-соединения с GigaChat", str(exc))
    if (
        "getaddrinfo" in text
        or "name or service not known" in text
        or "nodename nor servname" in text
    ):
        return GigaChatDNS(
            "GIGACHAT_DNS",
            "Не удалось разрешить адрес GigaChat — проверьте VPN/корпоративную сеть",
            str(exc),
        )
    return GigaChatTLS(
        "GIGACHAT_TLS", "Не удалось установить соединение с GigaChat", str(exc)
    )


# --------------------------------------------------------------------------- #
# Streaming
# --------------------------------------------------------------------------- #


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
