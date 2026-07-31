"""Unit tests for the per-user JSONL RAG log (wave 5.1).

Covers: one valid JSON object per line, Cyrillic written as-is, size-based
rotation with at most two files, best-effort failure handling, and the secret
scrubber.
"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import rag_log  # noqa: E402
from app.config import AppPaths  # noqa: E402


def _paths(tmp_path) -> AppPaths:
    return AppPaths(root=tmp_path / ".cognivault-ui")


def test_append_writes_one_json_line_per_record(tmp_path):
    paths = _paths(tmp_path)

    assert rag_log.append(paths, {"type": "request", "chat_id": "a"}) is True
    assert rag_log.append(paths, {"type": "feedback", "chat_id": "a"}) is True

    lines = rag_log.log_path(paths).read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert [json.loads(line)["type"] for line in lines] == ["request", "feedback"]
    assert [r["type"] for r in rag_log.read_records(paths)] == ["request", "feedback"]


def test_append_creates_root_lazily(tmp_path):
    paths = _paths(tmp_path)
    assert not paths.root.exists()
    assert rag_log.append(paths, {"type": "request"}) is True
    assert rag_log.log_path(paths).is_file()


def test_cyrillic_is_not_escaped(tmp_path):
    paths = _paths(tmp_path)
    rag_log.append(paths, {"type": "request", "question_raw": "как настроить ЕФС?"})

    raw = rag_log.log_path(paths).read_text(encoding="utf-8")
    assert "как настроить ЕФС?" in raw
    assert "\\u" not in raw


def test_rotation_keeps_at_most_two_files(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    monkeypatch.setattr(rag_log, "MAX_BYTES", 200)

    big = {"type": "request", "question_raw": "я" * 400}
    rag_log.append(paths, big)  # file now exceeds the threshold
    assert not (tmp_path / ".cognivault-ui" / "rag_log.jsonl.1").exists()

    rag_log.append(paths, {"type": "request", "marker": "second"})
    backup = paths.root / (rag_log.LOG_NAME + rag_log.BACKUP_SUFFIX)
    assert backup.is_file()
    # The current file restarted with just the new record.
    records = rag_log.read_records(paths)
    assert len(records) == 1 and records[0]["marker"] == "second"

    rag_log.append(paths, big)  # second record is small → no rotation yet
    rag_log.append(paths, {"type": "request", "marker": "third"})
    # Still exactly two files: the backup was overwritten, not accumulated.
    names = sorted(p.name for p in paths.root.iterdir())
    assert names == ["rag_log.jsonl", "rag_log.jsonl.1"]
    assert json.loads(backup.read_text(encoding="utf-8").splitlines()[0])["marker"] == (
        "second"
    )


def test_write_failure_is_swallowed(tmp_path):
    """A broken destination must return False, never raise into the caller."""
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("i am a file", encoding="utf-8")
    paths = AppPaths(root=blocker)

    assert rag_log.append(paths, {"type": "request"}) is False
    assert rag_log.read_records(paths) == []


def test_unserialisable_record_is_swallowed(tmp_path):
    paths = _paths(tmp_path)
    assert rag_log.append(paths, {"type": "request", "bad": object()}) is False


def test_secrets_are_never_written(tmp_path):
    paths = _paths(tmp_path)
    rag_log.append(
        paths,
        {
            "type": "request",
            "chat_id": "c1",
            "token": "super-secret-token",
            "Authorization": "Bearer super-secret-token",
            "nested": {"password": "hunter2", "key_path": "/certs/client.key"},
            "sources": [{"path": "a.md", "pat": "conf-pat"}],
        },
    )

    raw = rag_log.log_path(paths).read_text(encoding="utf-8")
    for leaked in ("super-secret-token", "Bearer", "hunter2", "conf-pat", "client.key"):
        assert leaked not in raw
    record = rag_log.read_records(paths)[0]
    assert record["chat_id"] == "c1"
    assert record["nested"] == {}
    assert record["sources"] == [{"path": "a.md"}]


def test_read_records_skips_broken_lines(tmp_path):
    paths = _paths(tmp_path)
    rag_log.append(paths, {"type": "request", "ok": 1})
    with rag_log.log_path(paths).open("a", encoding="utf-8") as fh:
        fh.write("{not json\n")
    rag_log.append(paths, {"type": "request", "ok": 2})

    assert [r["ok"] for r in rag_log.read_records(paths)] == [1, 2]


def test_now_iso_is_utc():
    ts = rag_log.now_iso()
    assert ts.endswith("+00:00")


@pytest.mark.parametrize("value", [{}, {"type": "feedback", "vote": "up"}])
def test_append_returns_true_for_plain_records(tmp_path, value):
    assert rag_log.append(_paths(tmp_path), value) is True
