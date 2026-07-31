"""Per-user RAG request/feedback log — plain JSONL under ``<paths.root>``.

One JSON object per line in ``rag_log.jsonl`` (wave 5.1/5.4 of the RAG quality
plan). Two record ``type``s share the file: ``"request"`` (written by the chat
route once a turn finishes, even a truncated/errored one) and ``"feedback"``
(written by ``POST /api/feedback``); a feedback record is matched to its request
by ``(chat_id, message_index)``.

Deliberate choices:

* **Not the ``logging`` module.** The UI never calls ``logging.basicConfig``, so
  the root logger sits at WARNING and ``log.info`` output would go nowhere. The
  log is a data artefact for eval runs, not operator noise — a file write is the
  honest implementation.
* **No atomic temp-file + ``os.replace``** (unlike ``history.py``/``config.py``).
  Records are appended, never rewritten: a single ``write()`` of one short line
  to a file opened in ``"a"`` mode is effectively atomic on POSIX, and a partial
  line would only ever cost the last record. Rewriting the whole file for every
  turn would be far worse.
* **Best-effort.** Every failure path is swallowed and reported as ``False`` —
  telemetry must never break a chat.
* **No secrets.** Records carry no user id (the file already lives in the
  caller's own directory) and :func:`append` scrubs any key that looks like a
  credential before writing.

Deployment note: in the production manifest ``/data`` is an ``emptyDir``, so
this log (and the votes in it) does not survive a pod restart. That is fine for
eval runs — collect the file before recycling the pod.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import AppPaths

LOG_NAME = "rag_log.jsonl"

# Rotate at 5 MiB, keep the current file plus a single ``.1`` backup.
MAX_BYTES = 5 * 1024 * 1024
BACKUP_SUFFIX = ".1"

# Keys whose values are (or may embed) credentials. Never written, at any depth.
_SECRET_KEYS = frozenset(
    {
        "authorization",
        "token",
        "pat",
        "password",
        "secret",
        "passphrase",
        "key_passphrase",
        "api_key",
        "openai_key",
        "cert",
        "cert_path",
        "key_path",
    }
)


def now_iso() -> str:
    """Current UTC timestamp, ISO-8601 — the ``ts`` of every record."""
    return datetime.now(timezone.utc).isoformat()


def log_path(paths: AppPaths) -> Path:
    """Absolute path of the caller's JSONL log."""
    return paths.root / LOG_NAME


def _scrub(value: Any) -> Any:
    """Drop credential-shaped keys anywhere in a record (defence in depth)."""
    if isinstance(value, dict):
        return {
            k: _scrub(v)
            for k, v in value.items()
            if str(k).lower() not in _SECRET_KEYS
        }
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    return value


def _rotate(path: Path) -> None:
    """Move the log aside once it exceeds :data:`MAX_BYTES` (keep 2 files)."""
    try:
        if path.stat().st_size <= MAX_BYTES:
            return
    except OSError:
        return
    # ``os.replace`` overwrites the previous backup — exactly the 2-file policy.
    os.replace(path, path.with_name(path.name + BACKUP_SUFFIX))


def append(paths: AppPaths, record: dict[str, Any]) -> bool:
    """Append one JSON line to the caller's log. Returns ``True`` on success.

    Never raises: any I/O or serialisation problem is swallowed and reported as
    ``False`` so a logging failure can never break the chat stream.
    """
    try:
        paths.root.mkdir(parents=True, exist_ok=True)
        path = log_path(paths)
        _rotate(path)
        line = json.dumps(_scrub(record), ensure_ascii=False)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        return True
    except Exception:  # noqa: BLE001 — telemetry is strictly best-effort
        return False


def read_records(paths: AppPaths) -> list[dict[str, Any]]:
    """Parse the current log into records, skipping unparsable lines.

    Convenience for eval tooling and tests; the write path never reads back.
    """
    path = log_path(paths)
    out: list[dict[str, Any]] = []
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return out
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            out.append(parsed)
    return out
