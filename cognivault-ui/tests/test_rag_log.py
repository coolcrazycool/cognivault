"""Unit tests for the per-user JSONL RAG log (wave 5.1).

Covers: one valid JSON object per line, Cyrillic written as-is, size-based
rotation with at most two files, best-effort failure handling, the secret
scrubber, the free-text cap, the settings snapshot and the stage timer.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import types

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


# --------------------------------------------------------------------------- #
# Free-text cap
# --------------------------------------------------------------------------- #


def test_truncate_flags_only_when_it_cuts():
    assert rag_log.truncate("короткий") == ("короткий", False)
    assert rag_log.truncate("абвгд", limit=3) == ("абв", True)
    assert rag_log.truncate("", limit=3) == ("", False)


def test_truncate_default_follows_the_constant(monkeypatch):
    monkeypatch.setattr(rag_log, "MAX_TEXT_CHARS", 4)
    assert rag_log.truncate("абвгде") == ("абвг", True)


# --------------------------------------------------------------------------- #
# Settings snapshot
# --------------------------------------------------------------------------- #


def test_settings_snapshot_keeps_knobs_and_drops_credentials():
    snapshot = rag_log.settings_snapshot(
        {
            "mode": "auto",
            "rerank_candidates": 40,
            "grader_threshold": 4,
            "grader_enabled": True,
            "min_score": None,
            "default_on": True,  # не в белом списке
        },
        {
            "model": "GigaChat-3-Ultra-preview",
            "temperature": 0.2,
            "max_tokens": 4096,
            "model_context_tokens": 32768,
            "cert_path": "/certs/client_crt.crt",
            "key_path": "/certs/client_key.key",
            "key_passphrase": "hunter2",
        },
        None,
    )

    assert snapshot["rag"]["rerank_candidates"] == 40
    assert snapshot["rag"]["grader_threshold"] == 4
    assert "default_on" not in snapshot["rag"]
    assert snapshot["gigachat"] == {
        "model": "GigaChat-3-Ultra-preview",
        "temperature": 0.2,
        "max_tokens": 4096,
        "model_context_tokens": 32768,
    }
    assert json.dumps(snapshot, ensure_ascii=False).find("hunter2") == -1


def test_settings_snapshot_fingerprints_prompt_overrides():
    default = rag_log.settings_snapshot({}, {}, {"system": None, "context_reminder": " "})
    custom = rag_log.settings_snapshot({}, {}, {"system": "мои правила"})
    same = rag_log.settings_snapshot({}, {}, {"system": "  мои правила  "})

    assert default["prompts"] == {"system": None, "context_reminder": None}
    assert custom["prompts"]["system"] == same["prompts"]["system"]
    assert custom["prompts"]["system"] != "мои правила"  # отпечаток, не текст
    assert custom["prompts"]["context_reminder"] is None


def test_settings_snapshot_tolerates_missing_sections():
    assert rag_log.settings_snapshot(None, None, None) == {
        "rag": {},
        "gigachat": {},
        "prompts": {"system": None, "context_reminder": None},
    }


# --------------------------------------------------------------------------- #
# Stage timings
# --------------------------------------------------------------------------- #


def test_stages_accumulate_within_a_collector():
    with rag_log.collect_stages() as stages:
        with rag_log.stage("search"):
            pass
        with rag_log.stage("search"):
            pass
        with rag_log.stage("grade"):
            pass

    assert sorted(stages) == ["grade", "search"]
    assert all(value >= 0 for value in stages.values())


def test_stage_outside_a_collector_is_a_noop():
    with rag_log.stage("search"):
        pass  # ничего не падает и никуда не пишется
    assert rag_log.record_stage("search", 5.0) is None


def test_instrument_wraps_a_coroutine_once():
    async def search(query):
        return f"результат {query}"

    module = types.SimpleNamespace(search=search)

    assert rag_log.instrument(module, "search", "search") is True
    assert rag_log.instrument(module, "search", "search") is False  # идемпотентно
    assert rag_log.instrument(module, "missing", "search") is False

    async def go():
        with rag_log.collect_stages() as stages:
            value = await module.search("q")
        return value, stages

    value, stages = asyncio.run(go())
    assert value == "результат q"  # поведение не изменилось
    assert "search" in stages
    assert module.search.__name__ == "search"
