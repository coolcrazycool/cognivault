"""Async client for the CogniVault REST API.

The base URL and bearer token are read from the freshly-loaded config on every
call so that a config change takes effect without a restart.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx

from .config import load_config


class CogniVaultError(Exception):
    """A typed error from a CogniVault upstream call.

    Carries an HTTP-ish ``status`` and a short ``body`` excerpt so routes can
    surface a meaningful envelope to the browser.
    """

    def __init__(self, message: str, status: int, body: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.body = body


def _cv_config() -> tuple[str, str]:
    """Return ``(base_url, token)`` from current config (base_url trailing '/' stripped)."""
    cfg = load_config()
    cv = cfg.get("cognivault", {})
    base = str(cv.get("base_url", "")).rstrip("/")
    token = str(cv.get("token", "") or "")
    return base, token


def _resolve_cv(cv: dict[str, Any] | None) -> tuple[str, str]:
    """Resolve ``(base_url, token)`` from an explicit ``cv`` dict or the config file.

    When ``cv`` is provided (server mode: per-request context) its ``base_url``/
    ``token`` are used; when ``None`` (local mode) the on-disk config is read via
    :func:`_cv_config`, preserving the exact historical behaviour.
    """
    if cv is not None:
        base = str(cv.get("base_url", "")).rstrip("/")
        token = str(cv.get("token", "") or "")
        return base, token
    return _cv_config()


def _auth_headers(token: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if extra:
        headers.update(extra)
    return headers


def _excerpt(text: str, limit: int = 500) -> str:
    return text[:limit]


async def health(cv: dict[str, Any] | None = None) -> tuple[bool, int, str | None]:
    """Probe ``GET {base}/health`` (no auth, 3s timeout).

    Returns ``(ok, latency_ms, error)``. Never raises.
    """
    base, _ = _resolve_cv(cv)
    if not base:
        return False, 0, "base_url не настроен"
    url = f"{base}/health"
    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url)
        latency = int((time.perf_counter() - start) * 1000)
        if resp.status_code == 200:
            return True, latency, None
        return False, latency, f"HTTP {resp.status_code}"
    except httpx.HTTPError as exc:
        latency = int((time.perf_counter() - start) * 1000)
        return False, latency, str(exc) or exc.__class__.__name__


async def semantic_search(
    query: str, limit: int, cv: dict[str, Any] | None = None
) -> dict[str, Any]:
    """POST ``/api/vault/search/semantic``.

    The body is sent as raw UTF-8 (``ensure_ascii=False``) so Cyrillic queries
    are not escaped over the wire.
    """
    base, token = _resolve_cv(cv)
    url = f"{base}/api/vault/search/semantic"
    body = json.dumps({"query": query, "limit": limit}, ensure_ascii=False).encode(
        "utf-8"
    )
    headers = _auth_headers(
        token, {"Content-Type": "application/json; charset=utf-8"}
    )
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, content=body, headers=headers)
    if resp.status_code != 200:
        raise CogniVaultError(
            f"semantic search failed ({resp.status_code})",
            resp.status_code,
            _excerpt(resp.text),
        )
    return resp.json()


async def hybrid_search(
    query: str, limit: int, cv: dict[str, Any] | None = None
) -> dict[str, Any]:
    """POST ``/api/vault/search/hybrid``.

    Same request/response contract as :func:`semantic_search` (raw UTF-8 body,
    Bearer auth, ``{results: [...]}`` response). Used by the auto RAG mode; the
    caller falls back to :func:`semantic_search` if this errors/404s.
    """
    base, token = _resolve_cv(cv)
    url = f"{base}/api/vault/search/hybrid"
    body = json.dumps({"query": query, "limit": limit}, ensure_ascii=False).encode(
        "utf-8"
    )
    headers = _auth_headers(
        token, {"Content-Type": "application/json; charset=utf-8"}
    )
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, content=body, headers=headers)
    if resp.status_code != 200:
        raise CogniVaultError(
            f"hybrid search failed ({resp.status_code})",
            resp.status_code,
            _excerpt(resp.text),
        )
    return resp.json()


async def content(path: str, cv: dict[str, Any] | None = None) -> str:
    """GET ``/api/vault/content?path=<path>`` returning the document body.

    The upstream returns ``{path, content}``; this returns just the ``content``
    string. Raises :class:`CogniVaultError` (with status + body excerpt) on a
    non-200 so the caller can fall back to bare chunks.
    """
    base, token = _resolve_cv(cv)
    url = f"{base}/api/vault/content"
    headers = _auth_headers(token)
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, params={"path": path}, headers=headers)
    if resp.status_code != 200:
        raise CogniVaultError(
            f"content failed ({resp.status_code})",
            resp.status_code,
            _excerpt(resp.text),
        )
    data = resp.json()
    return str(data.get("content", "") or "")


async def context(
    query: str,
    token_budget: int,
    min_score: float | None,
    filters: dict[str, Any] | None = None,
    cv: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """POST ``/api/vault/context`` returning the grouped context response."""
    base, token = _resolve_cv(cv)
    url = f"{base}/api/vault/context"
    payload: dict[str, Any] = {
        "query": query,
        "token_budget": token_budget,
        "min_score": min_score,
    }
    if filters:
        payload["filters"] = filters
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = _auth_headers(
        token, {"Content-Type": "application/json; charset=utf-8"}
    )
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, content=body, headers=headers)
    if resp.status_code != 200:
        raise CogniVaultError(
            f"context failed ({resp.status_code})",
            resp.status_code,
            _excerpt(resp.text),
        )
    return resp.json()


async def upload(
    file_bytes: bytes, filename: str, cv: dict[str, Any] | None = None
) -> dict[str, Any]:
    """POST ``/api/vault/upload`` as multipart (field ``file``).

    Raises :class:`CogniVaultError` (with status + body excerpt) on non-200.
    """
    base, token = _resolve_cv(cv)
    url = f"{base}/api/vault/upload"
    headers = _auth_headers(token)
    files = {"file": (filename, file_bytes, "application/zip")}
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, files=files, headers=headers)
    if resp.status_code != 200:
        raise CogniVaultError(
            f"upload failed ({resp.status_code})",
            resp.status_code,
            _excerpt(resp.text),
        )
    return resp.json()
