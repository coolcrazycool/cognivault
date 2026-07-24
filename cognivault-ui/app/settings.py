"""Deployment-mode settings: ``local`` (single-user, config-file) vs ``server``
(centralized, multi-tenant, env-driven).

``local`` is the historical behaviour and the default. ``server`` mode builds the
same config dict shape as :func:`app.config.load_config` — but entirely from
environment variables — so every downstream reader can stay mode-agnostic by
going through :func:`effective_config`.

This module is import-time validated: an invalid ``COGNIVAULT_UI_MODE`` raises a
``RuntimeError`` so a misconfigured deployment fails fast at startup.
"""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

from .config import DEFAULT_CONFIG, load_config

_VALID_MODES = ("local", "server")


def _resolve_mode() -> str:
    raw = os.environ.get("COGNIVAULT_UI_MODE", "local").strip().lower()
    if raw not in _VALID_MODES:
        raise RuntimeError(
            f"COGNIVAULT_UI_MODE must be one of {_VALID_MODES!r}, got {raw!r}"
        )
    return raw


# Validated once at import — a bad value crashes startup on purpose.
MODE: str = _resolve_mode()


def is_server() -> bool:
    return MODE == "server"


# --------------------------------------------------------------------------- #
# Env parsing helpers (tolerant: fall back to the default on a bad value)
# --------------------------------------------------------------------------- #


def _env_str(name: str, default: str) -> str:
    val = os.environ.get(name)
    return val if val is not None and val != "" else default


def _env_bool(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None or val == "":
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    val = os.environ.get(name)
    if val is None or val == "":
        return default
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    val = os.environ.get(name)
    if val is None or val == "":
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _env_opt_float(name: str, default: float | None) -> float | None:
    """Optional float: unset → ``default`` (typically ``None``)."""
    val = os.environ.get(name)
    if val is None or val == "":
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- #
# Data root / bind address (server mode)
# --------------------------------------------------------------------------- #


def data_root() -> Path:
    """Root dir for per-user state in server mode (``UI_DATA_DIR``, default ``/data``)."""
    return Path(_env_str("UI_DATA_DIR", "/data"))


def bind_host() -> str:
    return _env_str("UI_HOST", "0.0.0.0")


def bind_port() -> int:
    return _env_int("UI_PORT", 8787)


# --------------------------------------------------------------------------- #
# Server-mode config (same shape as load_config, from ENV only)
# --------------------------------------------------------------------------- #


def server_config() -> dict[str, Any]:
    """Build the effective config for server mode purely from the environment.

    The returned dict mirrors :func:`app.config.load_config`'s shape so all
    downstream readers work unchanged. The CogniVault ``token`` is intentionally
    empty here — in server mode the token is per-request (Bearer header), never
    a shared credential.
    """
    rag = copy.deepcopy(DEFAULT_CONFIG["rag"])
    rag.update(
        {
            "mode": _env_str("RAG_MODE", str(rag["mode"])),
            "source": _env_str("RAG_SOURCE", str(rag["source"])),
            "limit": _env_int("RAG_LIMIT", int(rag["limit"])),
            "min_score": _env_opt_float("RAG_MIN_SCORE", rag["min_score"]),
            "max_context_chars": _env_int(
                "RAG_MAX_CONTEXT_CHARS", int(rag["max_context_chars"])
            ),
            "file_full_chars": _env_int(
                "RAG_FILE_FULL_CHARS", int(rag["file_full_chars"])
            ),
            "section_max_chars": _env_int(
                "RAG_SECTION_MAX_CHARS", int(rag["section_max_chars"])
            ),
            "max_expanded_files": _env_int(
                "RAG_MAX_EXPANDED_FILES", int(rag["max_expanded_files"])
            ),
        }
    )

    gigachat = {
        "base_url": _env_str("GIGACHAT_BASE_URL", DEFAULT_CONFIG["gigachat"]["base_url"]),
        "model": _env_str("GIGACHAT_MODEL", "GigaChat-3-Ultra-preview"),
        "cert_path": os.path.expanduser(
            _env_str("GIGACHAT_CERT_PATH", "/certs/client_crt.crt")
        ),
        "key_path": os.path.expanduser(
            _env_str("GIGACHAT_KEY_PATH", "/certs/client_key.key")
        ),
        "key_passphrase": _env_str("GIGACHAT_KEY_PASSPHRASE", ""),
        "verify_ssl": _env_bool("GIGACHAT_VERIFY_SSL", False),
        "temperature": _env_float("GIGACHAT_TEMPERATURE", 0.2),
        "max_tokens": _env_int("GIGACHAT_MAX_TOKENS", 4096),
        "model_context_tokens": _env_int("GIGACHAT_MODEL_CONTEXT_TOKENS", 32768),
    }

    return {
        "version": 1,
        "cognivault": {
            "base_url": _env_str("COGNIVAULT_BASE_URL", "http://cognivault:3000"),
            "token": "",
        },
        "gigachat": gigachat,
        "rag": rag,
        "ui": {"theme": "auto"},
    }


def effective_config() -> dict[str, Any]:
    """Return the active config: env-driven in server mode, file-driven locally."""
    if is_server():
        return server_config()
    return load_config()
