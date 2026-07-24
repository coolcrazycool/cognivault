"""Config and status endpoints."""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from .. import cognivault, history, settings
from ..config import PATHS, ConfigError, load_config, save_config
from ..deps import get_token, resolve_paths

router = APIRouter(prefix="/api")


def _public_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """Safe, admin-set-only subset of the config for server mode.

    No token, no cert paths, no passphrase, no base_urls — only what the UI needs
    to render (model params + RAG display knobs).
    """
    gc = cfg.get("gigachat", {})
    rc = cfg.get("rag", {})
    return {
        "mode": "server",
        "gigachat": {
            "model": gc.get("model"),
            "temperature": gc.get("temperature"),
            "max_tokens": gc.get("max_tokens"),
            "model_context_tokens": gc.get("model_context_tokens"),
        },
        "rag": {
            "mode": rc.get("mode"),
            "max_context_chars": rc.get("max_context_chars"),
            "file_full_chars": rc.get("file_full_chars"),
            "section_max_chars": rc.get("section_max_chars"),
            "max_expanded_files": rc.get("max_expanded_files"),
            "limit": rc.get("limit"),
        },
    }


def _error(status: int, code: str, message: str, detail: str | None = None) -> JSONResponse:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if detail is not None:
        body["error"]["detail"] = detail
    return JSONResponse(status_code=status, content=body)


@router.get("/config")
async def get_config() -> dict[str, Any]:
    """Return the config for the UI.

    Public in both modes (no auth). SERVER mode returns a SAFE subset (no
    secrets); LOCAL mode returns the full effective config plus ``mode: local``.
    """
    if settings.is_server():
        return _public_config(settings.server_config())
    return {**load_config(), "mode": "local"}


@router.put("/config")
async def put_config(
    partial: dict[str, Any], _token: str = Depends(get_token)
) -> Any:
    """Deep-merge a partial config over the stored file and persist atomically.

    Forbidden in server mode — settings are administrator-provided via env.
    """
    if settings.is_server():
        return _error(403, "MODE_FORBIDDEN", "настройки заданы администратором")
    try:
        return save_config(partial)
    except ConfigError as exc:
        return _error(400, "CONFIG_INVALID", str(exc))


@router.get("/status")
async def get_status(
    request: Request, _token: str = Depends(get_token)
) -> dict[str, Any]:
    """Aggregate cognivault/gigachat/history status for the UI.

    SERVER mode drops the ``env`` block and the config-file path, checks the
    configured ``/certs`` files, probes the server CogniVault base, and buckets
    ``history_count`` by the caller's token.
    """
    cfg = settings.effective_config()
    gc = cfg.get("gigachat", {})
    cert_path = os.path.expanduser(str(gc.get("cert_path", "")))
    key_path = os.path.expanduser(str(gc.get("key_path", "")))
    gigachat_status = {
        "cert_exists": bool(cert_path) and os.path.isfile(cert_path),
        "key_exists": bool(key_path) and os.path.isfile(key_path),
    }

    if settings.is_server():
        cv = {"base_url": str(cfg.get("cognivault", {}).get("base_url", "")), "token": ""}
        ok, latency_ms, error = await cognivault.health(cv=cv)
        return {
            "mode": "server",
            "cognivault": {"ok": ok, "latency_ms": latency_ms, "error": error},
            "gigachat": gigachat_status,
            "history_count": history.count_chats(resolve_paths(request)),
        }

    ok, latency_ms, error = await cognivault.health()
    gigachat_status["base_url"] = str(gc.get("base_url", ""))
    return {
        "config": {
            "exists": PATHS.config_file.is_file(),
            "path": str(PATHS.config_file),
        },
        "cognivault": {"ok": ok, "latency_ms": latency_ms, "error": error},
        "gigachat": gigachat_status,
        "env": {
            "dir_exists": PATHS.root.is_dir(),
            "venv_exists": PATHS.venv_dir.is_dir(),
        },
        "history_count": history.count_chats(),
    }
