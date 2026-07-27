"""Unit tests for app.confluence.sync (phase 3: orchestration + write wrappers).

Both Confluence *and* CogniVault are mocked with ``httpx.MockTransport``; the
async generator is driven with ``asyncio.run`` (no pytest-asyncio). pytest is a
dev-only dependency — install it in your sandbox to run these; it is NOT in
requirements.txt.

The Confluence transport is passed straight into ``sync_stream`` (which forwards
it to ``ConfluenceClient``). CogniVault's write wrappers build their own
``httpx.AsyncClient`` internally, so we monkeypatch ``httpx.AsyncClient`` to
default in the CogniVault transport — the Confluence client always passes its own
transport explicitly, so ``setdefault`` never disturbs it.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path

import httpx
import pytest
import yaml

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import cognivault  # noqa: E402
from app.config import AppPaths  # noqa: E402
from app.confluence import store, sync  # noqa: E402

CONF_BASE = "https://confluence.example.com"
CV_BASE = "https://cv.example.com"

_TABLE_HTML = (
    "<table><tbody>"
    "<tr><th>Метрика</th><th>Q1</th><th>Q2</th></tr>"
    '<tr><td rowspan="2" colspan="2">Объединённая</td><td>10</td></tr>'
    "<tr><td>20</td></tr>"
    "</tbody></table>"
)
_CODE_HTML = (
    '<ac:structured-macro ac:name="code">'
    '<ac:parameter ac:name="language">python</ac:parameter>'
    '<ac:plain-text-body><![CDATA[print("привет")]]></ac:plain-text-body>'
    "</ac:structured-macro>"
)


# --------------------------------------------------------------------------- #
# Confluence mock
# --------------------------------------------------------------------------- #


class ConfMock:
    """A tiny mutable Confluence tree served over MockTransport."""

    def __init__(self) -> None:
        self.pages: dict[str, dict] = {
            "100": {
                "id": "100",
                "title": "Root Space Home",
                "space": "ENG",
                "version": 1,
                "ancestors": [],
                "body": "<p>Корневая страница</p>",
            },
            "101": {
                "id": "101",
                "title": "Дизайн API",
                "space": "ENG",
                "version": 3,
                "ancestors": ["Root Space Home"],
                "body": _TABLE_HTML,
            },
            "102": {
                "id": "102",
                "title": "Guide",
                "space": "ENG",
                "version": 2,
                "ancestors": ["Root Space Home"],
                "body": _CODE_HTML,
            },
        }
        # Descendants of the root (excludes the root itself).
        self.children = ["101", "102"]
        # Page ids for which get_page should hard-fail (partial-failure test).
        self.fail_ids: set[str] = set()

    def _payload(self, p: dict) -> dict:
        return {
            "id": p["id"],
            "title": p["title"],
            "space": {"key": p["space"]},
            "version": {"number": p["version"], "when": "2026-07-27T00:00:00.000Z"},
            "ancestors": [{"title": t} for t in p["ancestors"]],
            "metadata": {"labels": {"results": []}},
            "body": {"storage": {"value": p["body"]}},
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/rest/api/content/search":
            results = [
                {
                    "id": self.pages[c]["id"],
                    "title": self.pages[c]["title"],
                    "version": {"number": self.pages[c]["version"]},
                }
                for c in self.children
            ]
            return httpx.Response(
                200, json={"results": results, "_links": {}}, request=request
            )
        if path.endswith("/child/attachment"):
            return httpx.Response(
                200, json={"results": [], "_links": {}}, request=request
            )
        m = re.match(r"^/rest/api/content/(\d+)$", path)
        if m:
            pid = m.group(1)
            if pid in self.fail_ids:
                return httpx.Response(500, text="boom", request=request)
            if pid not in self.pages:
                return httpx.Response(404, request=request)
            return httpx.Response(200, json=self._payload(self.pages[pid]), request=request)
        raise AssertionError(f"unexpected Confluence path {path}")


# --------------------------------------------------------------------------- #
# CogniVault mock
# --------------------------------------------------------------------------- #


class CVMock:
    """Captures uploads (unzipped) and content POST/PUT/DELETE calls."""

    def __init__(self) -> None:
        self.vault: dict[str, bytes] = {}  # path -> file bytes
        self.existing: set[str] = set()  # paths CogniVault "has" (for 409/404)
        self.calls: list[tuple[str, str]] = []  # (method, path)
        self.uploads = 0

    @staticmethod
    def _unzip_multipart(request: httpx.Request) -> dict[str, bytes]:
        raw = request.content
        ctype = request.headers.get("content-type", "")
        boundary = ctype.split("boundary=", 1)[1].encode()
        marker = b"\r\n\r\n"
        start = raw.find(marker) + len(marker)
        end = raw.find(b"--" + boundary, start)
        blob = raw[start:end].rstrip(b"\r\n")
        out: dict[str, bytes] = {}
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            for name in zf.namelist():
                out[name] = zf.read(name)
        return out

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        method = request.method
        if path == "/api/vault/upload":
            self.uploads += 1
            files = self._unzip_multipart(request)
            for name, data in files.items():
                self.vault[name] = data
                self.existing.add(name)
            return httpx.Response(200, json={"ok": True}, request=request)
        if path == "/api/vault/files":
            return httpx.Response(
                200, json={"files": sorted(self.existing)}, request=request
            )
        if path == "/api/vault/content":
            body = json.loads(request.content or b"{}")
            p = body.get("path", "")
            self.calls.append((method, p))
            if method == "POST":
                if p in self.existing:
                    return httpx.Response(409, text="exists", request=request)
                self.existing.add(p)
                self.vault[p] = (body.get("content", "") or "").encode("utf-8")
                return httpx.Response(201, json={"ok": True}, request=request)
            if method == "PUT":
                if p not in self.existing:
                    return httpx.Response(404, text="missing", request=request)
                self.vault[p] = (body.get("content", "") or "").encode("utf-8")
                return httpx.Response(200, json={"ok": True}, request=request)
            if method == "DELETE":
                self.existing.discard(p)
                self.vault.pop(p, None)
                return httpx.Response(200, json={"ok": True}, request=request)
        raise AssertionError(f"unexpected CogniVault {method} {path}")


# --------------------------------------------------------------------------- #
# Harness
# --------------------------------------------------------------------------- #


def _cfg() -> dict:
    return {
        "base_url": CONF_BASE,
        "auth_mode": "pat",
        "root_url": f"{CONF_BASE}/pages/viewpage.action?pageId=100",
    }


_SECRET = {"pat": "secret-pat-value"}
_CV = {"base_url": CV_BASE, "token": "cv-token"}


def _run_sync(conf: ConfMock, cvm: CVMock, paths: AppPaths, **kw) -> list[tuple[str, dict]]:
    """Drive sync_stream to completion, returning parsed (event, data) frames.

    Monkeypatches ``httpx.AsyncClient`` (module-wide) to inject the CogniVault
    transport as a default; the Confluence client passes its own transport, so
    ``setdefault`` leaves it untouched.
    """
    real_client = httpx.AsyncClient
    cv_transport = httpx.MockTransport(cvm.handler)

    def factory(*a, **kwargs):
        kwargs.setdefault("transport", cv_transport)
        return real_client(*a, **kwargs)

    async def run() -> list[str]:
        frames: list[str] = []
        agen = sync.sync_stream(
            cv=_CV,
            paths=paths,
            cfg=_cfg(),
            secret=_SECRET,
            transport=httpx.MockTransport(conf.handler),
            now_iso="2026-07-27T12:00:00Z",
            **kw,
        )
        async for frame in agen:
            frames.append(frame)
        return frames

    saved = httpx.AsyncClient
    httpx.AsyncClient = factory  # type: ignore[assignment,misc]
    try:
        raw = asyncio.run(run())
    finally:
        httpx.AsyncClient = saved  # type: ignore[assignment,misc]
    return _parse(raw)


def _parse(frames: list[str]) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    for f in frames:
        lines = f.strip().split("\n")
        event = lines[0].split("event: ", 1)[1]
        data = json.loads(lines[1].split("data: ", 1)[1])
        out.append((event, data))
    return out


def _events(frames: list[tuple[str, dict]], name: str) -> list[dict]:
    return [d for e, d in frames if e == name]


def _done(frames: list[tuple[str, dict]]) -> dict:
    dones = _events(frames, "done")
    assert dones, f"no done frame; frames={frames}"
    return dones[0]


def _tmp_paths() -> AppPaths:
    return AppPaths(root=Path(tempfile.mkdtemp(prefix="cvsync-")))


# --------------------------------------------------------------------------- #
# Tests: initial sync (bulk zip)
# --------------------------------------------------------------------------- #


def test_initial_sync_writes_all_pages_via_zip():
    conf, cvm, paths = ConfMock(), CVMock(), _tmp_paths()
    frames = _run_sync(conf, cvm, paths)

    done = _done(frames)
    assert done["synced"] == 3
    assert done["failed"] == 0

    # Bulk path used: an upload, and no per-note content POSTs.
    assert cvm.uploads >= 1
    assert cvm.calls == []

    expected = {
        "Confluence/ENG/Root Space Home.md",
        "Confluence/ENG/Root Space Home/Дизайн API.md",
        "Confluence/ENG/Root Space Home/Guide.md",
    }
    assert expected <= set(cvm.vault.keys())

    # Frontmatter round-trips through yaml.safe_load.
    doc = cvm.vault["Confluence/ENG/Root Space Home/Guide.md"].decode("utf-8")
    assert doc.startswith("---\n")
    fm = yaml.safe_load(doc.split("---\n")[1])
    assert fm["confluence_id"] == "102"
    assert fm["source"] == "confluence"
    assert fm["version"] == 2
    assert fm["content_hash"]
    # The code block survived conversion verbatim.
    assert 'print("привет")' in doc

    # Manifest populated with {path, version, content_hash}.
    manifest = store.load_manifest(paths)
    assert manifest["meta"]["page_count"] == 3
    assert manifest["meta"]["last_sync_at"] == "2026-07-27T12:00:00Z"
    assert manifest["meta"]["last_status"] == "ok"
    for pid in ("100", "101", "102"):
        entry = manifest["pages"][pid]
        assert entry["path"] and entry["version"] and entry["content_hash"]


# --------------------------------------------------------------------------- #
# Tests: incremental — one page changed → PUT only that page
# --------------------------------------------------------------------------- #


def test_incremental_updates_only_changed_page():
    conf, cvm, paths = ConfMock(), CVMock(), _tmp_paths()
    _run_sync(conf, cvm, paths)  # seed manifest + vault
    cvm.calls.clear()

    # Bump 102's version AND change its body so the hash gate lets it through.
    conf.pages["102"]["version"] = 3
    conf.pages["102"]["body"] = (
        '<ac:structured-macro ac:name="code">'
        '<ac:parameter ac:name="language">python</ac:parameter>'
        '<ac:plain-text-body><![CDATA[print("обновлено")]]></ac:plain-text-body>'
        "</ac:structured-macro>"
    )

    frames = _run_sync(conf, cvm, paths)
    done = _done(frames)
    assert done["updated"] == 1
    assert done["synced"] == 0
    assert done["failed"] == 0

    guide = "Confluence/ENG/Root Space Home/Guide.md"
    # POST (409 EXISTS) then PUT for the changed page — and nothing else touched.
    assert ("POST", guide) in cvm.calls
    assert ("PUT", guide) in cvm.calls
    touched = {p for _m, p in cvm.calls}
    assert touched == {guide}

    manifest = store.load_manifest(paths)
    assert manifest["pages"]["102"]["version"] == 3
    assert manifest["pages"]["100"]["version"] == 1  # unchanged


def test_incremental_version_only_bump_is_skipped():
    conf, cvm, paths = ConfMock(), CVMock(), _tmp_paths()
    _run_sync(conf, cvm, paths)
    cvm.calls.clear()

    # Version bump but identical body → hash gate → skipped (no write).
    conf.pages["101"]["version"] = 99

    frames = _run_sync(conf, cvm, paths)
    done = _done(frames)
    assert done["skipped"] == 1
    assert done["updated"] == 0
    assert cvm.calls == []  # no content writes at all

    manifest = store.load_manifest(paths)
    assert manifest["pages"]["101"]["version"] == 99  # manifest version advanced


# --------------------------------------------------------------------------- #
# Tests: deletion
# --------------------------------------------------------------------------- #


def test_deleted_page_is_removed():
    conf, cvm, paths = ConfMock(), CVMock(), _tmp_paths()
    _run_sync(conf, cvm, paths)
    cvm.calls.clear()

    guide = "Confluence/ENG/Root Space Home/Guide.md"
    # Drop 102 from the tree.
    conf.children = ["101"]
    del conf.pages["102"]

    frames = _run_sync(conf, cvm, paths)
    done = _done(frames)
    assert done["deleted"] == 1

    assert ("DELETE", guide) in cvm.calls
    manifest = store.load_manifest(paths)
    assert "102" not in manifest["pages"]
    assert manifest["meta"]["page_count"] == 2


# --------------------------------------------------------------------------- #
# Tests: replace mode clears the vault first
# --------------------------------------------------------------------------- #


def test_replace_mode_clears_vault_first():
    conf, cvm, paths = ConfMock(), CVMock(), _tmp_paths()
    # Pre-existing junk file that replace must wipe.
    cvm.existing.add("Old/stale.md")
    cvm.vault["Old/stale.md"] = b"stale"

    frames = _run_sync(conf, cvm, paths, replace=True)
    done = _done(frames)
    assert done["synced"] == 3

    # clear_vault listed + deleted the junk file before re-uploading.
    assert ("DELETE", "Old/stale.md") in cvm.calls
    assert "Old/stale.md" not in cvm.vault
    assert "Confluence/ENG/Root Space Home.md" in cvm.vault


# --------------------------------------------------------------------------- #
# Tests: write-wrapper fallbacks (POST-409→PUT, PUT-404→POST) + delete tolerance
# --------------------------------------------------------------------------- #


def test_write_wrapper_signals_and_fallbacks():
    cvm = CVMock()
    real_client = httpx.AsyncClient
    cv_transport = httpx.MockTransport(cvm.handler)

    def factory(*a, **kwargs):
        kwargs.setdefault("transport", cv_transport)
        return real_client(*a, **kwargs)

    async def run() -> dict:
        out: dict = {}
        out["create_new"] = await cognivault.create_note("A.md", "x", _CV)
        out["create_dup"] = await cognivault.create_note("A.md", "x", _CV)  # 409
        out["update_ok"] = await cognivault.update_note("A.md", "y", _CV)
        out["update_missing"] = await cognivault.update_note("B.md", "z", _CV)  # 404
        out["delete_ok"] = await cognivault.delete_note("A.md", _CV)
        out["delete_gone"] = await cognivault.delete_note("A.md", _CV)  # 404 tolerated
        return out

    saved = httpx.AsyncClient
    httpx.AsyncClient = factory  # type: ignore[assignment,misc]
    try:
        out = asyncio.run(run())
    finally:
        httpx.AsyncClient = saved  # type: ignore[assignment,misc]

    assert out["create_new"] == cognivault.CREATED
    assert out["create_dup"] == cognivault.EXISTS  # POST-409 signal → PUT fallback
    assert out["update_ok"] == cognivault.UPDATED
    assert out["update_missing"] == cognivault.MISSING  # PUT-404 signal → POST fallback
    assert out["delete_ok"] == cognivault.DELETED
    assert out["delete_gone"] == cognivault.DELETED  # 404 tolerated as already-gone


def test_incremental_put_404_falls_back_to_post():
    """A changed page whose note vanished from CogniVault self-heals via POST.

    The manifest says the page exists, but CVMock has no such note, so the
    incremental create → EXISTS path is not taken; instead POST creates it fresh.
    """
    conf, cvm, paths = ConfMock(), CVMock(), _tmp_paths()
    _run_sync(conf, cvm, paths)
    cvm.calls.clear()

    guide = "Confluence/ENG/Root Space Home/Guide.md"
    # Simulate drift: CogniVault lost the note (manifest still has it).
    cvm.existing.discard(guide)
    cvm.vault.pop(guide, None)

    conf.pages["102"]["version"] = 5
    conf.pages["102"]["body"] = _CODE_HTML.replace("привет", "healed")

    frames = _run_sync(conf, cvm, paths)
    assert _done(frames)["updated"] == 1
    # POST succeeds (201) because the note was gone — no PUT needed.
    assert ("POST", guide) in cvm.calls
    assert guide in cvm.vault


# --------------------------------------------------------------------------- #
# Tests: partial failure isolates the bad page
# --------------------------------------------------------------------------- #


def test_partial_failure_excludes_page_from_manifest():
    conf, cvm, paths = ConfMock(), CVMock(), _tmp_paths()
    conf.fail_ids = {"101"}  # get_page(101) → 500 → ConfluenceError

    frames = _run_sync(conf, cvm, paths)
    done = _done(frames)
    assert done["failed"] == 1
    assert done["synced"] == 2  # root + 102 still succeed

    page_frames = _events(frames, "page")
    failed = [p for p in page_frames if p["action"] == "failed"]
    assert len(failed) == 1 and failed[0]["id"] == "101"

    manifest = store.load_manifest(paths)
    assert "101" not in manifest["pages"]
    assert set(manifest["pages"]) == {"100", "102"}


# --------------------------------------------------------------------------- #
# Tests: SYNC lock prevents concurrent runs
# --------------------------------------------------------------------------- #


def test_sync_lock_prevents_concurrent_runs():
    conf, cvm, paths = ConfMock(), CVMock(), _tmp_paths()

    async def run() -> list[str]:
        lock = sync._lock_for("tenant-x")
        await lock.acquire()  # simulate an in-flight sync
        try:
            frames: list[str] = []
            agen = sync.sync_stream(
                cv=_CV,
                paths=paths,
                cfg=_cfg(),
                secret=_SECRET,
                lock_key="tenant-x",
                transport=httpx.MockTransport(conf.handler),
            )
            async for frame in agen:
                frames.append(frame)
            return frames
        finally:
            lock.release()

    parsed = _parse(asyncio.run(run()))
    assert len(parsed) == 1
    event, data = parsed[0]
    assert event == "error"
    assert data["code"] == "SYNC_ALREADY_RUNNING"


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
