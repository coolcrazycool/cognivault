"""Application paths, defaults, and config load/save.

This module is intentionally free of any FastAPI / third-party imports so it can
be imported and exercised standalone (bootstrap, tests, quick checks).
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #


class AppPaths:
    """Filesystem layout under ``~/.cognivault-ui``.

    Directories are created lazily (see :meth:`ensure_dirs`); simply importing
    or instantiating this class touches nothing on disk.
    """

    def __init__(self, root: Path | None = None) -> None:
        self.root: Path = root or Path(os.path.expanduser("~/.cognivault-ui"))

    @property
    def config_file(self) -> Path:
        return self.root / "config.json"

    @property
    def certs_dir(self) -> Path:
        return self.root / "certs"

    @property
    def history_dir(self) -> Path:
        return self.root / "history"

    @property
    def venv_dir(self) -> Path:
        return self.root / "venv"

    @property
    def tmp_dir(self) -> Path:
        return self.root / "tmp"

    @property
    def confluence_dir(self) -> Path:
        return self.root / "confluence"

    def ensure_dirs(self) -> None:
        """Create the root plus the writable sub-directories if missing."""
        for d in (
            self.root,
            self.certs_dir,
            self.history_dir,
            self.tmp_dir,
            self.confluence_dir,
        ):
            d.mkdir(parents=True, exist_ok=True)


# Module-level singleton used across the app.
PATHS = AppPaths()


# --------------------------------------------------------------------------- #
# Defaults
# --------------------------------------------------------------------------- #

DEFAULT_CONFIG: dict[str, Any] = {
    "version": 1,
    "cognivault": {"base_url": "http://localhost:3000", "token": ""},
    "gigachat": {
        "base_url": "https://gigachat-ift.sberdevices.delta.sbrf.ru/v1",
        "model": "GigaChat-3-Ultra-preview",
        "cert_path": "~/.cognivault-ui/certs/client_crt.crt",
        "key_path": "~/.cognivault-ui/certs/client_key.key",
        "key_passphrase": "",
        "verify_ssl": False,
        "temperature": 0.2,
        "max_tokens": 4096,
        "model_context_tokens": 32768,
    },
    "rag": {
        "default_on": False,
        # Auto smart-expansion is the default. When mode == "auto" the RAG
        # pipeline uses its OWN internals (hybrid search, k=10, section/whole-file
        # expansion, computed char budget) and ignores any stale stored
        # source/limit, so installs whose config predates these keys get the new
        # behaviour automatically (deep-merge just fills in mode="auto").
        "mode": "auto",
        "source": "hybrid",
        "limit": 10,
        "min_score": None,
        "token_budget": 3000,
        "max_context_chars": 24000,
        "file_full_chars": 6000,
        "section_max_chars": 4000,
        "max_expanded_files": 2,
    },
    "env": {
        "pip_index_url": "https://sberosc.sigma.sbrf.ru/repo/pypi/simple",
        "pip_token": "",
    },
    "ui": {"theme": "auto"},
}


# --------------------------------------------------------------------------- #
# pip.conf helper (stdlib only — importable by the app AND the bootstrap)
# --------------------------------------------------------------------------- #


def migrate_pip_index_url(url: str) -> str:
    """Self-heal a stale SberOSC pip index URL missing the ``/repo/`` prefix.

    Early test runs persisted ``https://sberosc.<host>/pypi/simple`` (the wrong
    path — the mirror actually lives under ``/repo/pypi/simple``). Because stored
    config overrides the built-in default, that stale value keeps breaking pip.

    This is deliberately conservative: only when the host is a SberOSC host
    (hostname contains ``sberosc.``) AND the path is *exactly* ``/pypi/simple``
    do we rewrite the path to ``/repo/pypi/simple``. Scheme, ``user:token@``
    userinfo, host, port, query and fragment are preserved. Everything else —
    already-correct ``/repo/pypi/simple``, ``nexus-ci`` URLs, any non-sberosc
    index — is returned unchanged.
    """
    try:
        parts = urlsplit(url)
    except (ValueError, TypeError):
        return url
    host = parts.hostname or ""
    if "sberosc." in host and parts.path == "/pypi/simple":
        return urlunsplit(parts._replace(path="/repo/pypi/simple"))
    return url


def build_pip_conf(index_url: str, token: str) -> tuple[str, str, str]:
    """Build a pip ``[global]`` config for the SberOSC mirror.

    Returns ``(pip_conf_text, redacted_index_url, trusted_host)`` where:

    * ``pip_conf_text`` is a ready-to-write ``pip.conf`` body pinning
      ``index-url``/``trusted-host``/``default-timeout`` (the SberOSC-recommended
      method — inline ``--index-url``/``--trusted-host`` flags break transitive
      dependency resolution).
    * ``redacted_index_url`` is the effective index URL with the token masked as
      ``***`` — safe for logging / SSE.
    * ``trusted_host`` is the hostname parsed from ``index_url``.

    When ``token`` is non-empty and ``index_url`` carries no ``@`` userinfo yet,
    ``token:<token>@`` is injected right after the scheme, yielding
    ``https://token:<token>@<rest>``. Empty token (or a URL that already has
    credentials) leaves the URL unchanged.
    """
    parts = urlsplit(index_url)
    trusted_host = parts.hostname or ""
    has_userinfo = "@" in parts.netloc

    if token and not has_userinfo:
        prefix = f"{parts.scheme}://" if parts.scheme else ""
        rest = index_url[len(prefix):] if prefix and index_url.startswith(prefix) else index_url
        auth_url = f"{prefix}token:{token}@{rest}"
        redacted_index_url = f"{prefix}token:***@{rest}"
    else:
        auth_url = index_url
        redacted_index_url = index_url

    pip_conf_text = (
        "[global]\n"
        f"index-url={auth_url}\n"
        f"trusted-host={trusted_host}\n"
        "default-timeout=120\n"
    )
    return pip_conf_text, redacted_index_url, trusted_host

# Keys whose *string* values are filesystem paths and should be expanduser'd.
_PATH_KEYS: dict[str, tuple[str, ...]] = {
    "gigachat": ("cert_path", "key_path"),
}


# --------------------------------------------------------------------------- #
# Merge / expand helpers
# --------------------------------------------------------------------------- #


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge ``override`` into a copy of ``base`` and return it.

    Dicts are merged key-by-key; any non-dict value in ``override`` (including
    ``None``) replaces the corresponding value in ``base``.
    """
    result = copy.deepcopy(base)
    for key, value in override.items():
        if (
            key in result
            and isinstance(result[key], dict)
            and isinstance(value, dict)
        ):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _expand_paths(config: dict[str, Any]) -> dict[str, Any]:
    """Return a copy with known path fields run through ``expanduser``."""
    result = copy.deepcopy(config)
    for section, keys in _PATH_KEYS.items():
        sect = result.get(section)
        if not isinstance(sect, dict):
            continue
        for key in keys:
            val = sect.get(key)
            if isinstance(val, str) and val:
                sect[key] = os.path.expanduser(val)
    return result


# --------------------------------------------------------------------------- #
# Load / save
# --------------------------------------------------------------------------- #


def load_config(paths: AppPaths | None = None) -> dict[str, Any]:
    """Read config fresh from disk, deep-merged over the defaults.

    A missing or unreadable/invalid file yields the defaults (with expanded
    paths). Path fields are always expanded so callers get absolute paths.
    """
    paths = paths or PATHS
    stored: dict[str, Any] = {}
    try:
        raw = paths.config_file.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            stored = parsed
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        stored = {}
    merged = deep_merge(DEFAULT_CONFIG, stored)
    env = merged.get("env")
    if isinstance(env, dict) and isinstance(env.get("pip_index_url"), str):
        env["pip_index_url"] = migrate_pip_index_url(env["pip_index_url"])
    return _expand_paths(merged)


def _read_raw_config(paths: AppPaths) -> dict[str, Any]:
    """Read the on-disk config verbatim (no defaults, no expansion)."""
    try:
        parsed = json.loads(paths.config_file.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


class ConfigError(ValueError):
    """Raised when a partial config update has an invalid shape."""


def _validate_partial(partial: dict[str, Any]) -> None:
    """Loosely validate a partial config object before persisting.

    We only guard against obviously wrong shapes: top level must be an object,
    and any key that is a dict in DEFAULT_CONFIG must be a dict here too.
    """
    if not isinstance(partial, dict):
        raise ConfigError("config must be a JSON object")
    for key, value in partial.items():
        default_val = DEFAULT_CONFIG.get(key)
        if isinstance(default_val, dict) and not isinstance(value, dict):
            raise ConfigError(f"section '{key}' must be an object")


def save_config(
    partial: dict[str, Any], paths: AppPaths | None = None
) -> dict[str, Any]:
    """Deep-merge ``partial`` over the CURRENT file contents and persist.

    Writes atomically (temp file + ``os.replace``). Returns the freshly loaded
    (defaults-merged, path-expanded) config. Raises :class:`ConfigError` on a
    bad shape.
    """
    paths = paths or PATHS
    _validate_partial(partial)
    paths.ensure_dirs()

    current = _read_raw_config(paths)
    updated = deep_merge(current, partial)

    tmp = paths.config_file.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(tmp, paths.config_file)

    return load_config(paths)
