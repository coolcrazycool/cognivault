"""Confluence → CogniVault sync orchestration.

Glues the phase-1/2 building blocks — the :mod:`.client` REST client, the
:mod:`.convert` Storage-Format→Markdown pipeline, and the :mod:`.store`
persistence layer — into a single streaming sync driver.

:func:`sync_stream` is an async generator that yields Server-Sent Event frames
(via :func:`app.sse.format_sse`) describing progress: one ``step`` frame per
stage, ``log`` frames (redacted of the password/PAT), ``page`` frames per page,
a terminal ``error`` frame on an unrecoverable failure, or a final ``done``
frame with the run summary. It never calls :func:`datetime.now`; the wall-clock
``last_sync_at`` is supplied by the caller as ``now_iso``.

Idempotency / resumability: identity is the ``confluence_id`` recorded in the
manifest. Incremental writes try POST and fall back to PUT (and vice-versa) so
CogniVault-vs-manifest drift self-heals, and a content-hash gate skips rewriting
pages whose rendered body is unchanged (avoiding rewrite loops).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import time
import zipfile
from typing import Any, AsyncIterator

import httpx

from .. import cognivault
from ..sse import format_sse, sse_error
from . import store
from .client import (
    ConfluenceClient,
    ConfluenceError,
    JitterFn,
    SleepFn,
    parse_page_url,
    resolve_display_url,
)
from .convert import (
    build_frontmatter,
    build_vault_path,
    collision_suffix,
    render_document,
    storage_to_markdown,
)

# One lock per tenant so two syncs for the same user cannot interleave. Keyed by
# the caller-supplied ``lock_key`` (e.g. the user bucket). P4's ``/sync`` route
# inspects this map for its own 409 pre-check.
SYNC_LOCKS: dict[str, asyncio.Lock] = {}

# Flush the in-memory pages zip once it reaches ~40 MB (initial bulk load).
_MAX_ZIP_BYTES = 40 * 1024 * 1024
# Skip attachments larger than ~20 MB with a warning.
_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
# Persist the manifest every N processed pages so a crash loses little work.
_MANIFEST_FLUSH_EVERY = 20
# Emit an enumeration heartbeat every N discovered pages.
_ENUM_HEARTBEAT_EVERY = 100

# Markdown emitted by the converter for still-unresolved *dynamic* macros
# (include / excerpt-include / jira). Used only to decide whether the optional,
# default-off export_view enhancement has anything to do for a page.
_DYNAMIC_PLACEHOLDER_MARKERS = ("[Включение:", "[JIRA:")


def _is_too_large(exc: cognivault.CogniVaultError) -> bool:
    """True when a CogniVault write failed because the JSON body exceeded the
    server's size limit.

    CogniVault runs on Fastify, whose default ``bodyLimit`` (~1 MB) rejects an
    oversized ``/api/vault/content`` PUT/POST with **HTTP 413**
    (``FST_ERR_CTP_BODY_TOO_LARGE``). Some proxies surface the same condition as
    a 400 mentioning the payload/limit, so we sniff those defensively too. This
    stays deliberately narrow: any other failure is a genuine error and must
    keep flowing to the ``page action=failed`` path.
    """
    if exc.status == 413:
        return True
    if exc.status == 400:
        body = (exc.body or "").lower()
        return any(
            marker in body
            for marker in (
                "too large",
                "body_too_large",
                "body limit",
                "bodylimit",
                "request entity",
                "payload too large",
            )
        )
    return False


def _lock_for(key: str) -> asyncio.Lock:
    """Return (creating on first use) the per-key sync lock."""
    lock = SYNC_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        SYNC_LOCKS[key] = lock
    return lock


def _make_zip(entries: list[tuple[str, bytes]]) -> bytes:
    """Build a deflate zip from ``(archive_path, bytes)`` entries."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, data in entries:
            zf.writestr(path, data)
    return buf.getvalue()


async def sync_stream(
    *,
    cv: dict[str, Any] | None,
    paths: Any,
    cfg: dict[str, Any],
    secret: dict[str, Any],
    replace: bool = False,
    max_concurrency: int = 3,
    now_iso: str = "",
    lock_key: str = "default",
    transport: httpx.BaseTransport | None = None,
    sleep: SleepFn | None = None,
    jitter: JitterFn | None = None,
) -> AsyncIterator[str]:
    """Run a full Confluence→CogniVault sync, yielding SSE frames.

    Parameters mirror the persistence + call context the route resolves:
    ``cv`` is the CogniVault call context (``None`` → read config file), ``paths``
    an :class:`AppPaths`, ``cfg``/``secret`` the Confluence store dicts. ``replace``
    wipes the vault first; ``now_iso`` stamps ``manifest.meta.last_sync_at``. The
    ``transport``/``sleep``/``jitter`` hooks are injected by tests.
    """
    password = str(secret.get("password", "") or "")
    pat = str(secret.get("pat", "") or "")

    def log(line: str) -> str:
        return format_sse("log", {"line": store.redact(line, password, pat)})

    # ---- single-flight guard ------------------------------------------------
    lock = _lock_for(lock_key)
    if lock.locked():
        yield sse_error("SYNC_ALREADY_RUNNING", "синхронизация уже выполняется")
        return

    async with lock:
        started = time.perf_counter()

        counts = {
            "synced": 0,
            "updated": 0,
            "skipped": 0,
            "deleted": 0,
            "attachments": 0,
            "failed": 0,
        }

        manifest = store.load_manifest(paths)
        pages: dict[str, Any] = dict(manifest.get("pages") or {})
        meta: dict[str, Any] = dict(manifest.get("meta") or {})

        # ---- step 1: replace -----------------------------------------------
        if replace:
            yield format_sse("step", {"name": "replace", "label": "Полная замена"})
            try:
                result = await cognivault.clear_vault(cv)
            except cognivault.CogniVaultError as exc:
                yield sse_error("CV_ERROR", exc.message, exc.body)
                return
            yield log(
                f"очистка хранилища: удалено {result['deleted']} из {result['total']}, "
                f"ошибок {len(result['failed'])}"
            )
            pages = {}
            meta = {}

        # Initial (bulk zip) vs incremental (per-note create/update).
        initial = not pages

        try:
            async with ConfluenceClient.from_config(
                cfg,
                secret,
                max_concurrency=max_concurrency,
                transport=transport,
                sleep=sleep,
                jitter=jitter,
            ) as client:
                # ---- step 2: resolve root ---------------------------------
                yield format_sse(
                    "step", {"name": "resolve_root", "label": "Определение корня"}
                )
                root_url = str(cfg.get("root_url", "") or "")
                root_id = parse_page_url(root_url)
                if root_id is None:
                    root_id = await resolve_display_url(client, root_url)
                if not root_id:
                    yield sse_error(
                        "BAD_URL", "не удалось определить страницу из URL"
                    )
                    return
                root_page = await client.get_page(root_id)
                root_space = str(root_page.get("space", "") or "")
                yield log(
                    f"корень: id={root_id} «{root_page.get('title', '')}» "
                    f"space={root_space}"
                )

                # ---- step 3: enumerate ------------------------------------
                yield format_sse(
                    "step", {"name": "enumerate", "label": "Обход дерева"}
                )
                enumerated = await client.enumerate_subtree(root_id)
                remote: dict[str, tuple[int, str]] = {}
                for n, item in enumerate(enumerated, start=1):
                    remote[item["id"]] = (item["version"], item["title"])
                    if n % _ENUM_HEARTBEAT_EVERY == 0:
                        yield log(f"обнаружено страниц: {n}")
                yield log(f"всего страниц в дереве: {len(remote)}")

                # ---- step 4: diff -----------------------------------------
                new_ids = [pid for pid in remote if pid not in pages]
                changed_ids = [
                    pid
                    for pid in remote
                    if pid in pages and pages[pid].get("version") != remote[pid][0]
                ]
                skipped_candidates = [
                    pid
                    for pid in remote
                    if pid in pages and pages[pid].get("version") == remote[pid][0]
                ]
                deleted_ids = [pid for pid in pages if pid not in remote]
                yield format_sse(
                    "step",
                    {
                        "name": "diff",
                        "label": "Сравнение",
                        "new": len(new_ids),
                        "changed": len(changed_ids),
                        "unchanged": len(skipped_candidates),
                        "deleted": len(deleted_ids),
                    },
                )

                # ---- step 5: pages ----------------------------------------
                yield format_sse(
                    "step", {"name": "pages", "label": "Синхронизация страниц"}
                )

                # Optional, default-OFF: try to fill dynamic-macro placeholders
                # (include / excerpt-include / jira) from the server-rendered
                # export_view. Off by default so the well-tested storage-format
                # path is the norm; see the guarded block in the page loop.
                resolve_dynamic = bool(cfg.get("resolve_dynamic_macros", False))

                # Best-effort crawl-title map for internal link resolution:
                # every remote page keyed by "<space>::<title>" → predicted path
                # (root's space for all; ancestors unknown at enumerate time).
                crawl_titles: dict[str, str] = {}
                for pid, (_ver, title) in remote.items():
                    predicted = build_vault_path(
                        {"space": root_space, "title": title, "id": pid, "ancestors": []}
                    )
                    crawl_titles[f"{root_space}::{title}"] = predicted

                # Seed used-paths with manifest paths of pages we will NOT rewrite
                # so a new/changed page colliding onto them is disambiguated.
                used_paths: set[str] = set()
                targets = [("new", pid) for pid in new_ids] + [
                    ("changed", pid) for pid in changed_ids
                ]
                target_ids = {pid for _kind, pid in targets}
                for pid, entry in pages.items():
                    if pid not in target_ids:
                        p = entry.get("path")
                        if p:
                            used_paths.add(p)

                total = len(targets)
                index = 0
                processed_since_flush = 0
                refs_by_page: dict[str, list[str]] = {}
                zip_entries: list[tuple[str, bytes]] = []
                zip_bytes = 0
                sem = asyncio.Semaphore(max(1, max_concurrency))

                async def _fetch(pid: str) -> dict[str, Any]:
                    async with sem:
                        return await client.get_page(pid)

                chunk_size = max(1, max_concurrency)
                for start in range(0, total, chunk_size):
                    chunk = targets[start : start + chunk_size]
                    fetched = await asyncio.gather(
                        *[_fetch(pid) for _kind, pid in chunk],
                        return_exceptions=True,
                    )
                    for (kind, pid), result in zip(chunk, fetched):
                        index += 1
                        title = remote[pid][1]
                        if isinstance(result, BaseException):
                            counts["failed"] += 1
                            yield format_sse(
                                "page",
                                {
                                    "id": pid,
                                    "title": title,
                                    "action": "failed",
                                    "index": index,
                                    "total": total,
                                },
                            )
                            yield log(f"страница {pid}: {result}")
                            continue
                        try:
                            page = result
                            body_md, refs = storage_to_markdown(
                                page, crawl_titles, set()
                            )

                            # Best-effort, default-OFF enhancement. When enabled
                            # and the rendered body still carries a dynamic-macro
                            # placeholder, the server-side export_view holds the
                            # macro's live HTML. We only *signal* the opportunity
                            # for now — actually splicing per-macro fragments back
                            # into the markdown is fiddly (matching each
                            # placeholder to its export_view node, re-converting
                            # HTML→md, keeping the P3 tests green) and not worth
                            # risking the correct storage-format path.
                            # TODO(confluence): resolve include/excerpt/jira from
                            # client.get_export_view(pid) and splice the rendered
                            # fragment under each placeholder line.
                            if resolve_dynamic and any(
                                m in body_md for m in _DYNAMIC_PLACEHOLDER_MARKERS
                            ):
                                yield log(
                                    f"страница {pid}: динамические макросы оставлены "
                                    f"как заглушки (resolve_dynamic_macros включён, "
                                    f"но export_view-подстановка ещё не реализована)"
                                )

                            content_hash = hashlib.sha256(
                                body_md.encode("utf-8")
                            ).hexdigest()
                            old = pages.get(pid)

                            # Hash gate: a "changed" page whose rendered body is
                            # byte-identical only bumps the manifest version.
                            if (
                                kind == "changed"
                                and old is not None
                                and old.get("content_hash") == content_hash
                            ):
                                old["version"] = remote[pid][0]
                                refs_by_page[pid] = refs
                                counts["skipped"] += 1
                                yield format_sse(
                                    "page",
                                    {
                                        "id": pid,
                                        "title": title,
                                        "action": "skipped",
                                        "index": index,
                                        "total": total,
                                    },
                                )
                                processed_since_flush += 1
                                continue

                            # Resolve the target path (disambiguate collisions).
                            target = build_vault_path(page)
                            if target in used_paths and (
                                old is None or old.get("path") != target
                            ):
                                parent = target.rsplit("/", 1)[0]
                                target = (
                                    f"{parent}/{collision_suffix(title, pid)}.md"
                                )
                            used_paths.add(target)

                            rendered = render_document(
                                build_frontmatter(page, content_hash), body_md
                            )

                            if initial:
                                data = rendered.encode("utf-8")
                                zip_entries.append((target, data))
                                zip_bytes += len(data)
                                if zip_bytes >= _MAX_ZIP_BYTES:
                                    await cognivault.upload(
                                        _make_zip(zip_entries),
                                        "confluence-pages.zip",
                                        cv,
                                    )
                                    zip_entries = []
                                    zip_bytes = 0
                            else:
                                try:
                                    status = await cognivault.create_note(
                                        target, rendered, cv
                                    )
                                    if status == cognivault.EXISTS:
                                        st2 = await cognivault.update_note(
                                            target, rendered, cv
                                        )
                                        if st2 == cognivault.MISSING:
                                            await cognivault.create_note(
                                                target, rendered, cv
                                            )
                                except cognivault.CogniVaultError as exc:
                                    # Oversized page: the /api/vault/content JSON
                                    # body blew Fastify's ~1 MB limit (413). The
                                    # multipart /upload path allows ~50 MB, so
                                    # write this single page through a one-file
                                    # zip instead. Only the size error is caught
                                    # here; every other failure re-raises to the
                                    # per-page ``failed`` handler below.
                                    if not _is_too_large(exc):
                                        raise
                                    yield log(
                                        f"страница {pid} «{title}» превышает лимит "
                                        f"тела JSON — запись через zip (upload)"
                                    )
                                    await cognivault.upload(
                                        _make_zip(
                                            [(target, rendered.encode("utf-8"))]
                                        ),
                                        "confluence-page.zip",
                                        cv,
                                    )
                                # Moved page: old note under a different path.
                                if old is not None and old.get("path") not in (
                                    None,
                                    target,
                                ):
                                    await cognivault.delete_note(old["path"], cv)

                            pages[pid] = {
                                "path": target,
                                "version": remote[pid][0],
                                "content_hash": content_hash,
                                "attachments": (old or {}).get("attachments", {}) or {},
                            }
                            refs_by_page[pid] = refs

                            action = "new" if kind == "new" else "updated"
                            counts["synced" if kind == "new" else "updated"] += 1
                            yield format_sse(
                                "page",
                                {
                                    "id": pid,
                                    "title": title,
                                    "action": action,
                                    "index": index,
                                    "total": total,
                                },
                            )
                        except cognivault.CogniVaultError as exc:
                            counts["failed"] += 1
                            yield format_sse(
                                "page",
                                {
                                    "id": pid,
                                    "title": title,
                                    "action": "failed",
                                    "index": index,
                                    "total": total,
                                },
                            )
                            yield log(f"страница {pid}: CogniVault {exc.message}")
                        except Exception as exc:  # noqa: BLE001 — per-page isolation
                            counts["failed"] += 1
                            yield format_sse(
                                "page",
                                {
                                    "id": pid,
                                    "title": title,
                                    "action": "failed",
                                    "index": index,
                                    "total": total,
                                },
                            )
                            yield log(f"страница {pid}: {exc}")

                        processed_since_flush += 1
                        if processed_since_flush >= _MANIFEST_FLUSH_EVERY:
                            store.save_manifest(
                                paths, {"meta": meta, "pages": pages}
                            )
                            processed_since_flush = 0

                # Flush any remaining bulk-zip pages.
                if zip_entries:
                    await cognivault.upload(
                        _make_zip(zip_entries), "confluence-pages.zip", cv
                    )

                # ---- step 6: attachments ----------------------------------
                if any(refs_by_page.values()):
                    yield format_sse(
                        "step", {"name": "attachments", "label": "Вложения"}
                    )
                    att_entries: list[tuple[str, bytes]] = []
                    for pid, refs in refs_by_page.items():
                        if not refs:
                            continue
                        try:
                            atts = await client.list_attachments(pid)
                        except ConfluenceError as exc:
                            yield log(
                                f"вложения {pid}: пропущены ({exc.message})"
                            )
                            continue
                        by_name = {a["filename"]: a for a in atts}
                        old_att = (pages.get(pid) or {}).get("attachments", {}) or {}
                        new_att: dict[str, Any] = {}
                        for fname in refs:
                            a = by_name.get(fname)
                            if not a:
                                continue
                            size = a.get("size") or 0
                            if size and size > _MAX_ATTACHMENT_BYTES:
                                yield log(
                                    f"вложение {fname} ({size} б) пропущено — превышает лимит"
                                )
                                continue
                            try:
                                data = await client.download(a["download_url"])
                            except ConfluenceError as exc:
                                yield log(
                                    f"вложение {fname}: пропущено ({exc.message})"
                                )
                                continue
                            zippath = f"Confluence/attachments/{pid}/{fname}"
                            att_entries.append((zippath, data))
                            new_att[fname] = {"path": zippath, "size": len(data)}
                            counts["attachments"] += 1
                        # Delete attachments no longer referenced.
                        for fname, m in old_att.items():
                            if fname not in new_att and m.get("path"):
                                try:
                                    await cognivault.delete_note(m["path"], cv)
                                except cognivault.CogniVaultError:
                                    pass
                        if pid in pages:
                            pages[pid]["attachments"] = new_att
                    if att_entries:
                        await cognivault.upload(
                            _make_zip(att_entries),
                            "confluence-attachments.zip",
                            cv,
                        )

                # ---- step 7: deletes --------------------------------------
                if deleted_ids:
                    yield format_sse(
                        "step", {"name": "deletes", "label": "Удаление"}
                    )
                    dtotal = len(deleted_ids)
                    for dindex, pid in enumerate(deleted_ids, start=1):
                        entry = pages.get(pid, {})
                        try:
                            if entry.get("path"):
                                await cognivault.delete_note(entry["path"], cv)
                            for _fname, m in (entry.get("attachments") or {}).items():
                                if m.get("path"):
                                    try:
                                        await cognivault.delete_note(m["path"], cv)
                                    except cognivault.CogniVaultError:
                                        pass
                        except cognivault.CogniVaultError as exc:
                            yield log(f"удаление {pid}: {exc.message}")
                        pages.pop(pid, None)
                        counts["deleted"] += 1
                        yield format_sse(
                            "page",
                            {
                                "id": pid,
                                "title": entry.get("path", ""),
                                "action": "deleted",
                                "index": dindex,
                                "total": dtotal,
                            },
                        )

                # ---- step 8: finalize -------------------------------------
                yield format_sse(
                    "step", {"name": "finalize", "label": "Завершение"}
                )
                meta = {
                    "root_page_id": root_id,
                    "base_url": str(cfg.get("base_url", "") or ""),
                    "last_sync_at": now_iso,
                    "last_status": "partial" if counts["failed"] else "ok",
                    "page_count": len(pages),
                }
                store.save_manifest(paths, {"meta": meta, "pages": pages})

                duration_s = round(time.perf_counter() - started, 3)
                yield format_sse(
                    "done",
                    {
                        "synced": counts["synced"],
                        "updated": counts["updated"],
                        "skipped": counts["skipped"],
                        "deleted": counts["deleted"],
                        "attachments": counts["attachments"],
                        "failed": counts["failed"],
                        "duration_s": duration_s,
                    },
                )
        except ConfluenceError as exc:
            yield sse_error(exc.code, exc.message, exc.detail)
        except cognivault.CogniVaultError as exc:
            yield sse_error("CV_ERROR", exc.message, exc.body)
