"""Per-user Confluence config / secret / manifest persistence.

All three files live under ``<AppPaths.confluence_dir>``:

* ``config.json``   — non-secret settings (base_url, auth_mode, root, sync…).
* ``secret.json``   — the credential (``password`` and/or ``pat``), mode ``0600``.
* ``manifest.json`` — sync bookkeeping (page inventory, meta) written by later
  phases; here we just load/save it.

Writes are atomic (temp file + :func:`os.replace`), matching :mod:`app.config`.
This module is FastAPI-free so it can be unit-tested standalone.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

from ..config import AppPaths

# Non-secret config defaults. Secrets (password/pat) live in secret.json only.
DEFAULT_CONFLUENCE_CONFIG: dict[str, Any] = {
    "base_url": "",
    "auth_mode": "basic",
    "login": "",
    "root_url": "",
    "root_page_id": "",
    "ca_path": "",
    "verify_ssl": True,
    "auto_sync": False,
    "auto_sync_interval_min": 60,
    "replace_mode": False,
    # Attachments (images/binaries) are OFF by default: they are not indexed for
    # semantic search and downloading/uploading them is the slow, hang-prone step.
    # A text-only sync is fast and immune to the attachments-stage idle timeout.
    "sync_attachments": False,
}


def _config_path(paths: AppPaths) -> Path:
    return paths.confluence_dir / "config.json"


def _secret_path(paths: AppPaths) -> Path:
    return paths.confluence_dir / "secret.json"


def _manifest_path(paths: AppPaths) -> Path:
    return paths.confluence_dir / "manifest.json"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _atomic_write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# Config (non-secret)
# --------------------------------------------------------------------------- #


def load_config(paths: AppPaths) -> dict[str, Any]:
    """Return the stored config merged over :data:`DEFAULT_CONFLUENCE_CONFIG`."""
    merged = copy.deepcopy(DEFAULT_CONFLUENCE_CONFIG)
    merged.update(_read_json(_config_path(paths)))
    return merged


def save_config(paths: AppPaths, config: dict[str, Any]) -> dict[str, Any]:
    """Deep-merge ``config`` over the current file and persist atomically."""
    current = _read_json(_config_path(paths))
    current.update(config)
    _atomic_write(_config_path(paths), current)
    return load_config(paths)


# --------------------------------------------------------------------------- #
# Secret (0600)
# --------------------------------------------------------------------------- #


def load_secret(paths: AppPaths) -> dict[str, Any]:
    """Return the stored secret dict (``{}`` when absent)."""
    return _read_json(_secret_path(paths))


def save_secret(paths: AppPaths, secret: dict[str, Any]) -> None:
    """Write the secret with owner-only ``0600`` permissions.

    Uses ``os.open(..., O_WRONLY|O_CREAT|O_TRUNC, 0o600)`` so the file is created
    private from the start; an ``os.chmod`` afterwards keeps the mode tight even
    if the file already existed with looser bits.
    """
    paths.confluence_dir.mkdir(parents=True, exist_ok=True)
    path = _secret_path(paths)
    payload = json.dumps(secret, ensure_ascii=False, indent=2) + "\n"
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
    finally:
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Manifest
# --------------------------------------------------------------------------- #


def load_manifest(paths: AppPaths) -> dict[str, Any]:
    """Return the sync manifest (``{}`` when absent)."""
    return _read_json(_manifest_path(paths))


def save_manifest(paths: AppPaths, manifest: dict[str, Any]) -> None:
    """Persist the sync manifest atomically."""
    _atomic_write(_manifest_path(paths), manifest)


def manifest_url_index(paths: AppPaths) -> dict[str, str]:
    """Return ``{vault_path: confluence_page_url}`` from the sync manifest.

    Builds a reverse index from every synced page's vault ``path`` to its origin
    Confluence page URL (``<base_url>/pages/viewpage.action?pageId=<id>``) so RAG
    source chips can link back to the source page. The page id is the manifest
    ``pages`` key; the vault path is that entry's ``path``. ``base_url`` comes from
    ``manifest.meta.base_url``. Cheap and tolerant: returns ``{}`` when there is no
    manifest / no base_url, and skips malformed entries.
    """
    manifest = load_manifest(paths)
    if not manifest:
        return {}
    meta = manifest.get("meta") or {}
    base_url = str(meta.get("base_url") or "").rstrip("/")
    pages = manifest.get("pages") or {}
    if not base_url or not isinstance(pages, dict):
        return {}
    index: dict[str, str] = {}
    for page_id, entry in pages.items():
        if not page_id or not isinstance(entry, dict):
            continue
        path = entry.get("path")
        if not path:
            continue
        index[str(path)] = f"{base_url}/pages/viewpage.action?pageId={page_id}"
    return index


# --------------------------------------------------------------------------- #
# Redaction (logs / SSE)
# --------------------------------------------------------------------------- #


def redact(line: str, *secrets: str) -> str:
    """Return ``line`` with every non-empty secret substring replaced by ``***``."""
    out = line
    for secret in secrets:
        if secret:
            out = out.replace(secret, "***")
    return out
