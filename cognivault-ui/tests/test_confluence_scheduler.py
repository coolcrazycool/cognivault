"""Unit tests for app.confluence.scheduler (phase 5: auto-update scheduler).

Covers the due-time math, the server-mode user iteration (only ``auto_sync:true``
users with a stored ``cv_token`` run; the rest are skipped), single-flight lock
contention, and a single tick actually draining a (monkeypatched) ``sync_stream``
into the per-user ``last-auto-sync.log``. Also asserts that a ``TestClient``
startup in local mode does NOT spawn the background loop.

No pytest-asyncio: the async ``_tick`` / ``run_scheduler`` are driven with
``asyncio.run``. ``sync_stream`` is always monkeypatched (an async generator
yielding a couple of frames) so no real network is touched.
"""

from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import settings  # noqa: E402
from app.config import AppPaths  # noqa: E402
from app.confluence import scheduler, store, sync  # noqa: E402
from app.main import create_app  # noqa: E402

NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _clean_locks():
    """Each test starts with an empty lock table."""
    sync.SYNC_LOCKS.clear()
    yield
    sync.SYNC_LOCKS.clear()


def _user(root, *, auto_sync, cv_token=None, last_sync_at=None, interval=60):
    """Create a user dir with a Confluence config/secret/manifest under ``root``."""
    paths = AppPaths(root=root)
    store.save_config(
        paths,
        {
            "base_url": "https://confluence.example.com",
            "root_url": "https://confluence.example.com/x?pageId=1",
            "auto_sync": auto_sync,
            "auto_sync_interval_min": interval,
        },
    )
    secret = {"pat": "tok"}
    if cv_token is not None:
        secret["cv_token"] = cv_token
    store.save_secret(paths, secret)
    if last_sync_at is not None:
        store.save_manifest(paths, {"meta": {"last_sync_at": last_sync_at}, "pages": {}})
    return paths


def _fake_stream():
    """Return ``(calls, fake_sync_stream)`` recording every invocation's kwargs."""
    calls: list[dict] = []

    async def fake_sync_stream(**kwargs):
        calls.append(kwargs)
        yield 'event: step\ndata: {"name": "resolve_root"}\n\n'
        yield 'event: done\ndata: {"synced": 1}\n\n'

    return calls, fake_sync_stream


def _lock(key: str) -> None:
    """Acquire (and leave held) the SYNC_LOCKS entry for ``key``.

    Mirrors the existing route tests: ``.locked()`` is a plain bool so the loop
    the lock was acquired in need not stay alive."""

    async def _hold() -> None:
        await sync._lock_for(key).acquire()

    asyncio.run(_hold())
    assert sync.SYNC_LOCKS[key].locked() is True


# --------------------------------------------------------------------------- #
# Due-time math
# --------------------------------------------------------------------------- #


def test_is_due_never_synced_is_due():
    cfg = {"auto_sync": True, "auto_sync_interval_min": 60}
    assert scheduler.is_due(cfg, {}, NOW, 30) is True


def test_is_due_auto_sync_off_never_due():
    cfg = {"auto_sync": False, "auto_sync_interval_min": 1}
    assert scheduler.is_due(cfg, {}, NOW, 0) is False


def test_is_due_recently_synced_not_due():
    cfg = {"auto_sync": True, "auto_sync_interval_min": 60}
    last = (NOW - timedelta(minutes=10)).isoformat()
    manifest = {"meta": {"last_sync_at": last}}
    assert scheduler.is_due(cfg, manifest, NOW, 30) is False


def test_is_due_interval_elapsed_is_due():
    cfg = {"auto_sync": True, "auto_sync_interval_min": 60}
    last = (NOW - timedelta(minutes=90)).isoformat()
    manifest = {"meta": {"last_sync_at": last}}
    assert scheduler.is_due(cfg, manifest, NOW, 30) is True


def test_is_due_interval_clamped_up_to_min():
    """A tiny user interval is clamped to MIN — 10 min elapsed < 30 min MIN."""
    cfg = {"auto_sync": True, "auto_sync_interval_min": 5}
    last = (NOW - timedelta(minutes=10)).isoformat()
    manifest = {"meta": {"last_sync_at": last}}
    # Clamped to MIN=30 → not yet due.
    assert scheduler.is_due(cfg, manifest, NOW, 30) is False
    # 40 min elapsed > 30 min MIN → due.
    last2 = (NOW - timedelta(minutes=40)).isoformat()
    assert scheduler.is_due(
        cfg, {"meta": {"last_sync_at": last2}}, NOW, 30
    ) is True


def test_is_due_unparseable_timestamp_is_due():
    cfg = {"auto_sync": True, "auto_sync_interval_min": 60}
    manifest = {"meta": {"last_sync_at": "not-a-date"}}
    assert scheduler.is_due(cfg, manifest, NOW, 30) is True


# --------------------------------------------------------------------------- #
# Server-mode iteration
# --------------------------------------------------------------------------- #


def _server_mode(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "is_server", lambda: True)
    monkeypatch.setattr(settings, "data_root", lambda: tmp_path)
    monkeypatch.setattr(settings, "confluence_min_auto_interval_min", lambda: 30)
    monkeypatch.setattr(settings, "confluence_max_concurrency", lambda: 3)


def test_server_tick_runs_only_eligible_users(tmp_path, monkeypatch):
    users = tmp_path / "users"
    # aaa: eligible (auto_sync, cv_token, never synced) → runs.
    p_a = _user(users / "aaa", auto_sync=True, cv_token="cv-a")
    # bbb: auto_sync but NO cv_token → skipped with a warning.
    _user(users / "bbb", auto_sync=True, cv_token=None)
    # ccc: auto_sync off → skipped.
    _user(users / "ccc", auto_sync=False, cv_token="cv-c")

    _server_mode(monkeypatch, tmp_path)
    calls, fake = _fake_stream()
    monkeypatch.setattr(scheduler, "sync_stream", fake)

    asyncio.run(scheduler._tick(NOW))

    # Only the eligible user's sync ran.
    assert len(calls) == 1
    kw = calls[0]
    assert kw["lock_key"] == "aaa"
    assert kw["cv"] == {"base_url": "http://cognivault:3000", "token": "cv-a"}
    assert kw["replace"] is False
    # base_url derived from the per-user root link (source of truth).
    assert kw["cfg"]["base_url"] == "https://confluence.example.com"
    # The per-user auto-sync log was written with the drained frames.
    log_text = (p_a.confluence_dir / "last-auto-sync.log").read_text()
    assert "event: done" in log_text


def test_server_tick_skips_locked_user(tmp_path, monkeypatch):
    users = tmp_path / "users"
    _user(users / "aaa", auto_sync=True, cv_token="cv-a")

    _server_mode(monkeypatch, tmp_path)
    calls, fake = _fake_stream()
    monkeypatch.setattr(scheduler, "sync_stream", fake)

    _lock("aaa")  # a manual sync is already in flight for this user
    asyncio.run(scheduler._tick(NOW))

    assert calls == []  # skipped this tick


def test_server_tick_skips_not_due_user(tmp_path, monkeypatch):
    users = tmp_path / "users"
    recent = (NOW - timedelta(minutes=5)).isoformat()
    _user(users / "aaa", auto_sync=True, cv_token="cv-a", last_sync_at=recent)

    _server_mode(monkeypatch, tmp_path)
    calls, fake = _fake_stream()
    monkeypatch.setattr(scheduler, "sync_stream", fake)

    asyncio.run(scheduler._tick(NOW))
    assert calls == []


# --------------------------------------------------------------------------- #
# Local-mode iteration
# --------------------------------------------------------------------------- #


def test_local_tick_runs_and_writes_log(tmp_path, monkeypatch):
    paths = AppPaths(root=tmp_path / ".cognivault-ui")
    store.save_config(
        paths,
        {
            "base_url": "https://confluence.example.com",
            "root_url": "https://confluence.example.com/x?pageId=1",
            "auto_sync": True,
        },
    )
    store.save_secret(paths, {"pat": "tok"})

    monkeypatch.setattr(settings, "is_server", lambda: False)
    monkeypatch.setattr(settings, "confluence_min_auto_interval_min", lambda: 30)
    monkeypatch.setattr(settings, "confluence_max_concurrency", lambda: 3)
    monkeypatch.setattr(scheduler, "PATHS", paths)

    calls, fake = _fake_stream()
    monkeypatch.setattr(scheduler, "sync_stream", fake)

    asyncio.run(scheduler._tick(NOW))

    assert len(calls) == 1
    assert calls[0]["lock_key"] == "local"
    assert calls[0]["cv"] is None  # local uses the file-based token
    assert "event: done" in (paths.confluence_dir / "last-auto-sync.log").read_text()


def test_local_tick_skipped_when_locked(tmp_path, monkeypatch):
    paths = AppPaths(root=tmp_path / ".cognivault-ui")
    store.save_config(
        paths,
        {
            "base_url": "https://confluence.example.com",
            "root_url": "https://confluence.example.com/x?pageId=1",
            "auto_sync": True,
        },
    )
    store.save_secret(paths, {"pat": "tok"})

    monkeypatch.setattr(settings, "is_server", lambda: False)
    monkeypatch.setattr(settings, "confluence_min_auto_interval_min", lambda: 30)
    monkeypatch.setattr(settings, "confluence_max_concurrency", lambda: 3)
    monkeypatch.setattr(scheduler, "PATHS", paths)

    calls, fake = _fake_stream()
    monkeypatch.setattr(scheduler, "sync_stream", fake)

    _lock("local")
    asyncio.run(scheduler._tick(NOW))
    assert calls == []


# --------------------------------------------------------------------------- #
# The loop terminates; startup does not spawn it under test
# --------------------------------------------------------------------------- #


def test_run_scheduler_runs_one_tick_and_stops(monkeypatch):
    ticks: list[datetime] = []

    async def fake_tick(now):
        ticks.append(now)

    monkeypatch.setattr(scheduler, "_tick", fake_tick)
    # max_iterations bounds the loop so it never sleeps / hangs.
    asyncio.run(scheduler.run_scheduler(max_iterations=1))
    assert len(ticks) == 1


def test_run_scheduler_swallows_tick_errors(monkeypatch):
    async def boom(now):
        raise RuntimeError("boom")

    monkeypatch.setattr(scheduler, "_tick", boom)
    # A raising tick must not propagate out of the loop.
    asyncio.run(scheduler.run_scheduler(max_iterations=1))


def test_local_testclient_startup_does_not_spawn_scheduler(monkeypatch):
    """In local mode (default) the background loop must NOT auto-start."""
    monkeypatch.setattr(settings, "is_server", lambda: False)
    monkeypatch.delenv("CONFLUENCE_AUTO_SYNC_SCHEDULER", raising=False)
    with TestClient(create_app()) as client:
        assert client.get("/healthz").status_code == 200
        app = client.app
        assert getattr(app.state, "confluence_scheduler_task", None) is None
