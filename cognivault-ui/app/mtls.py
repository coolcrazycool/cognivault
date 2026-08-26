"""Shared mTLS wiring for the chat backends.

Both the direct GigaChat client and the KitAI client authenticate with the same
thing — the client PEM certificate — against the same closed contour, so the
certificate handling, the passphrase workaround and the connect-error
classification live here once instead of being copied per transport.

Callers pass any object exposing ``cert_path``, ``key_path``, ``key_passphrase``
and ``verify_ssl``; nothing here needs a concrete config class.
"""

from __future__ import annotations

import os
import ssl
from typing import Any, Protocol

import httpx

from .llm_errors import GigaChatCertMissing, GigaChatDNS, GigaChatError, GigaChatTLS


class TlsConfig(Protocol):
    """The slice of a backend config the TLS layer needs."""

    cert_path: str
    key_path: str
    key_passphrase: str
    verify_ssl: bool


def files_present(cfg: TlsConfig) -> None:
    """Raise :class:`GigaChatCertMissing` unless both cert and key exist."""
    missing = [p for p in (cfg.cert_path, cfg.key_path) if not (p and os.path.isfile(p))]
    if missing:
        raise GigaChatCertMissing(
            "GIGACHAT_CERT_MISSING",
            "Клиентский сертификат или ключ не найдены",
            detail="; ".join(f"нет файла: {p}" for p in missing),
        )


def build_verify(cfg: TlsConfig) -> Any:
    """Compute the ``verify`` argument for httpx.

    A passphrase-protected key cannot be supplied through the plain ``cert``
    tuple, so we build an :class:`ssl.SSLContext`, load the cert chain with the
    password, and hand that to httpx via ``verify=`` (it also drives client auth).
    """
    if cfg.key_passphrase:
        ctx = ssl.create_default_context()
        if not cfg.verify_ssl:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        ctx.load_cert_chain(
            certfile=cfg.cert_path,
            keyfile=cfg.key_path,
            password=cfg.key_passphrase,
        )
        return ctx
    return cfg.verify_ssl


def make_client(cfg: TlsConfig, timeout: httpx.Timeout) -> httpx.AsyncClient:
    """An httpx client wired for client-certificate auth."""
    verify = build_verify(cfg)
    if cfg.key_passphrase:
        # Cert chain (incl. key) already loaded into the SSLContext.
        return httpx.AsyncClient(verify=verify, timeout=timeout)
    return httpx.AsyncClient(
        cert=(cfg.cert_path, cfg.key_path), verify=verify, timeout=timeout
    )


def classify_connect_error(exc: Exception, *, what: str = "GigaChat") -> GigaChatError:
    """Turn a connection failure into a typed, user-readable error.

    ``what`` names the host in the message — the same three failure modes appear
    for both backends, but pointing the operator at the wrong endpoint wastes an
    afternoon on the Sber network.
    """
    text = str(exc).lower()
    if isinstance(exc, ssl.SSLError) or "ssl" in text or "certificate" in text:
        return GigaChatTLS("GIGACHAT_TLS", f"Ошибка TLS-соединения с {what}", str(exc))
    if (
        "getaddrinfo" in text
        or "name or service not known" in text
        or "nodename nor servname" in text
    ):
        return GigaChatDNS(
            "GIGACHAT_DNS",
            f"Не удалось разрешить адрес {what} — проверьте VPN/корпоративную сеть",
            str(exc),
        )
    return GigaChatTLS(
        "GIGACHAT_TLS", f"Не удалось установить соединение с {what}", str(exc)
    )
