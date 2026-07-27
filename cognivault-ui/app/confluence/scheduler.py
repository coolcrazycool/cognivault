"""Background auto-sync scheduler for the Confluence source (phase 5).

A single long-lived asyncio task (started from :mod:`app.main`) wakes every
~60s and, for every user who has opted into ``auto_sync``, runs an incremental
:func:`app.confluence.sync.sync_stream` when the configured interval has elapsed.
It is deliberately conservative:

* **One sync at a time.** Due users are processed sequentially so the scheduler
  never fans out concurrent syncs and blows the CogniVault / Confluence budget.
* **Exception-safe.** Every per-user run is wrapped so a single failure only
  writes a log line — it never crashes the loop. A crash in the scheduler must
  never affect request serving.
* **Cancellable.** The loop sleeps on a ``stop_event`` so shutdown is prompt.
* **Single-flight aware.** It reuses :data:`app.confluence.sync.SYNC_LOCKS`, so a
  manual sync already in flight for a user is simply skipped this tick.

The scheduler is tokenless at rest: in server mode it can only act for a user
who previously opted in via ``PUT /config`` (which stores that caller's
CogniVault bearer token as ``secret["cv_token"]``). A user without a stored
``cv_token`` is skipped with a warning — there is no way to write to their vault.

Sync progress is not streamed anywhere; the SSE frames for the most recent
automatic run are drained into ``<confluence_dir>/last-auto-sync.log`` (truncated
per run) purely for after-the-fact debugging.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .. import settings
from ..config import PATHS, AppPaths
from .client import parse_base_url
from .store import load_config, load_manifest, load_secret
from .sync import SYNC_LOCKS, sync_stream

log = logging.getLogger("cognivault_ui.confluence.scheduler")

# Filename (under each user's confluence dir) that captures the SSE frames of the
# most recent automatic run — truncated on every run.
_AUTO_SYNC_LOG = "last-auto-sync.log"

# How often the loop wakes to look for due users.
_TICK_SECONDS = 60.0


# --------------------------------------------------------------------------- #
# Due-time math (pure helpers — unit-tested directly)
# --------------------------------------------------------------------------- #


def _parse_iso(value: str) -> datetime | None:
    """Parse an ISO-8601 timestamp; return ``None`` when unparseable.

    A naive timestamp is assumed to be UTC so it can be compared with the
    timezone-aware ``now`` the loop supplies.
    """
    try:
        dt = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _interval_min(cfg: dict[str, Any], min_interval: int) -> int:
    """Effective interval: the user's interval, clamped up to ``min_interval``."""
    raw = cfg.get("auto_sync_interval_min", 60)
    try:
        interval = int(raw)
    except (TypeError, ValueError):
        interval = 60
    return max(interval, int(min_interval))


def is_due(
    cfg: dict[str, Any],
    manifest: dict[str, Any],
    now: datetime,
    min_interval: int,
) -> bool:
    """Return whether a user's Confluence source is due for an automatic sync.

    Due when ``auto_sync`` is enabled AND either it has never synced
    (``manifest.meta.last_sync_at`` empty/unparseable) or the effective interval
    (``max(auto_sync_interval_min, min_interval)`` minutes) has elapsed since the
    last sync.
    """
    if not cfg.get("auto_sync"):
        return False
    meta = manifest.get("meta") or {}
    last_raw = meta.get("last_sync_at")
    if not last_raw:
        return True
    last = _parse_iso(str(last_raw))
    if last is None:
        # An unreadable timestamp shouldn't wedge the user forever.
        return True
    return last + timedelta(minutes=_interval_min(cfg, min_interval)) <= now


# --------------------------------------------------------------------------- #
# One sync run
# --------------------------------------------------------------------------- #


def _locked(lock_key: str) -> bool:
    """True when a sync (manual or automatic) is already in flight for ``lock_key``."""
    lock = SYNC_LOCKS.get(lock_key)
    return lock is not None and lock.locked()


async def _run_one(
    *,
    paths: AppPaths,
    cfg: dict[str, Any],
    secret: dict[str, Any],
    cv: dict[str, Any] | None,
    lock_key: str,
    now_iso: str,
) -> None:
    """Drain a full ``sync_stream`` into the per-user auto-sync log (truncated).

    ``sync_stream`` self-guards single-flight, but we still pre-check the lock in
    the caller so a manual sync in flight is skipped without spinning one up.
    """
    paths.confluence_dir.mkdir(parents=True, exist_ok=True)
    log_path = paths.confluence_dir / _AUTO_SYNC_LOG
    frames: list[str] = []
    async for frame in sync_stream(
        cv=cv,
        paths=paths,
        cfg=cfg,
        secret=secret,
        replace=False,
        max_concurrency=settings.confluence_max_concurrency(),
        now_iso=now_iso,
        lock_key=lock_key,
    ):
        frames.append(frame)
    try:
        log_path.write_text("".join(frames), encoding="utf-8")
    except OSError as exc:  # best-effort — never fail the run over a log write
        log.warning("не удалось записать %s: %s", log_path, exc)


# --------------------------------------------------------------------------- #
# One scheduler tick (extracted so tests never sleep)
# --------------------------------------------------------------------------- #


def _server_effective_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """Overlay the admin-locked TLS settings and derive the REST base.

    Mirrors the route's ``_effective_config``: ``ca_path``/``verify_ssl`` come
    from the environment, and ``base_url`` is derived from the root link
    (source of truth, incl. any context path), falling back to the admin default.
    """
    derived = parse_base_url(str(cfg.get("root_url", "") or ""))
    return {
        **cfg,
        "base_url": derived or settings.confluence_base_url(),
        "ca_path": settings.confluence_ca_path(),
        "verify_ssl": settings.confluence_verify_ssl(),
    }


def _server_cv(token: str) -> dict[str, Any]:
    """CogniVault call context for the background scheduler, acting as ``token``."""
    cog = settings.server_config().get("cognivault", {})
    base = str(cog.get("base_url", "") or "").rstrip("/")
    return {"base_url": base, "token": token}


async def _tick_local(now: datetime, min_interval: int) -> None:
    """Local mode: the single config-file user (``PATHS`` / lock key ``local``)."""
    paths = PATHS
    cfg = load_config(paths)
    manifest = load_manifest(paths)
    if not is_due(cfg, manifest, now, min_interval):
        return
    if _locked("local"):
        log.info("auto-sync: локальная синхронизация уже выполняется — пропуск")
        return
    secret = load_secret(paths)
    log.info("auto-sync: запуск локальной синхронизации")
    await _run_one(
        paths=paths,
        cfg=cfg,
        secret=secret,
        cv=None,
        lock_key="local",
        now_iso=now.isoformat(),
    )


async def _tick_server(now: datetime, min_interval: int) -> None:
    """Server mode: iterate ``<UI_DATA_DIR>/users/<bucket>`` sequentially."""
    users_dir = Path(settings.data_root()) / "users"
    if not users_dir.is_dir():
        return
    for bucket_dir in sorted(users_dir.iterdir()):
        if not bucket_dir.is_dir():
            continue
        bucket = bucket_dir.name
        try:
            paths = AppPaths(root=bucket_dir)
            cfg = load_config(paths)
            if not cfg.get("auto_sync"):
                continue
            cfg = _server_effective_config(cfg)
            manifest = load_manifest(paths)
            if not is_due(cfg, manifest, now, min_interval):
                continue
            secret = load_secret(paths)
            cv_token = str(secret.get("cv_token", "") or "")
            if not cv_token:
                # Tokenless at rest: we cannot write to this user's vault until
                # they re-opt-in via PUT /config (which stores their token).
                log.warning(
                    "auto-sync: у пользователя %s нет cv_token — пропуск", bucket
                )
                continue
            if _locked(bucket):
                log.info(
                    "auto-sync: синхронизация пользователя %s уже выполняется — пропуск",
                    bucket,
                )
                continue
            log.info("auto-sync: запуск синхронизации пользователя %s", bucket)
            await _run_one(
                paths=paths,
                cfg=cfg,
                secret=secret,
                cv=_server_cv(cv_token),
                lock_key=bucket,
                now_iso=now.isoformat(),
            )
        except Exception:  # noqa: BLE001 — per-user isolation; never crash the tick
            log.exception("auto-sync: сбой для пользователя %s", bucket)


async def _tick(now: datetime) -> None:
    """Run exactly one scheduler pass. Extracted so tests can drive it directly."""
    min_interval = settings.confluence_min_auto_interval_min()
    if settings.is_server():
        await _tick_server(now, min_interval)
    else:
        await _tick_local(now, min_interval)


# --------------------------------------------------------------------------- #
# The loop
# --------------------------------------------------------------------------- #


async def run_scheduler(
    stop_event: asyncio.Event | None = None,
    *,
    interval: float = _TICK_SECONDS,
    max_iterations: int | None = None,
) -> None:
    """Run the auto-sync loop until cancelled or ``stop_event`` is set.

    Wakes every ``interval`` seconds, running one :func:`_tick`. Any exception a
    tick raises is logged and swallowed so a transient failure never stops the
    loop. ``max_iterations`` bounds the loop for tests; production leaves it
    ``None`` (run forever).
    """
    log.info("Confluence auto-sync scheduler запущен (interval=%ss)", interval)
    iterations = 0
    try:
        while True:
            if stop_event is not None and stop_event.is_set():
                break
            now = datetime.now(timezone.utc)
            try:
                await _tick(now)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — a bad tick must not kill the loop
                log.exception("auto-sync: сбой цикла планировщика")

            iterations += 1
            if max_iterations is not None and iterations >= max_iterations:
                break

            # Cancellable sleep: wake early when stop_event fires.
            if stop_event is not None:
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=interval)
                except asyncio.TimeoutError:
                    pass
            else:
                await asyncio.sleep(interval)
    except asyncio.CancelledError:
        log.info("Confluence auto-sync scheduler остановлен")
        raise
