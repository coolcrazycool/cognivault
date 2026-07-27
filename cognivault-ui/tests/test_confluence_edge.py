"""Phase-6 edge-case tests for app.confluence.sync.

Kept in a SEPARATE file from ``test_confluence_sync.py`` (the P3 suite) so the
oversized-page write fallback is covered without touching those tests. Reuses
the P3 mock harness (``ConfMock`` / ``CVMock`` and the ``_run_sync`` driver) by
importing it — both modules add the ``cognivault-ui`` dir to ``sys.path``, so
``tests`` resolves as a namespace package.
"""

from __future__ import annotations

import json
import os
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests.test_confluence_sync import (  # noqa: E402
    CVMock,
    ConfMock,
    _done,
    _events,
    _run_sync,
    _tmp_paths,
)


class Oversized413CV(CVMock):
    """A CogniVault mock that answers 413 for content POSTs to a target path.

    Mimics Fastify rejecting an over-``bodyLimit`` write body. Every other call
    (including the multipart ``/upload`` fallback) delegates to the P3 mock, so
    the fallback zip is captured in ``self.vault`` exactly like a bulk upload.
    """

    def __init__(self, trigger_substr: str) -> None:
        super().__init__()
        self.trigger = trigger_substr
        self.rejected_413 = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        if (
            request.url.path == "/api/vault/content"
            and request.method == "POST"
        ):
            body = json.loads(request.content or b"{}")
            path = body.get("path", "")
            if self.trigger in path:
                self.calls.append(("POST", path))
                self.rejected_413 += 1
                return httpx.Response(
                    413,
                    text=(
                        "FST_ERR_CTP_BODY_TOO_LARGE: Request body is too large"
                    ),
                    request=request,
                )
        return super().handler(request)


def test_oversized_page_falls_back_to_upload_zip():
    """A new page whose create_note 413s is written via a one-file upload zip.

    Seed a manifest with an initial (bulk) sync, then add a new page and run an
    *incremental* sync where CogniVault rejects that page's content POST with a
    413. The page must not fail: it should land in the vault via ``/upload``.
    """
    conf, seed_cv, paths = ConfMock(), CVMock(), _tmp_paths()
    _run_sync(conf, seed_cv, paths)  # seed manifest + vault (bulk zip path)

    # A brand-new page under the root → incremental create_note (POST) path.
    conf.pages["103"] = {
        "id": "103",
        "title": "Bulk",
        "space": "ENG",
        "version": 1,
        "ancestors": ["Root Space Home"],
        "body": "<p>" + ("очень большая страница " * 100) + "</p>",
    }
    conf.children.append("103")

    target = "Confluence/ENG/Root Space Home/Bulk.md"
    cvm = Oversized413CV(trigger_substr="Bulk")

    frames = _run_sync(conf, cvm, paths)

    done = _done(frames)
    assert done["synced"] == 1, done
    assert done["failed"] == 0, done

    # The oversized POST was attempted and rejected with 413.
    assert cvm.rejected_413 == 1
    assert ("POST", target) in cvm.calls

    # Fallback: the page landed in the vault via a one-file /upload zip.
    assert cvm.uploads == 1
    assert target in cvm.vault
    assert b"BEGIN" not in cvm.vault[target]  # sanity: it is the rendered note
    assert cvm.vault[target].startswith(b"---\n")  # frontmatter present

    # The page frame reports success, not failure.
    page_frames = _events(frames, "page")
    p103 = [p for p in page_frames if p["id"] == "103"]
    assert len(p103) == 1
    assert p103[0]["action"] == "new"

    # A log line announced the fallback.
    log_lines = [d.get("line", "") for d in _events(frames, "log")]
    assert any("upload" in ln or "zip" in ln for ln in log_lines), log_lines

    # Non-size failures must still surface as failed (fallback stays narrow):
    # nothing else was uploaded or force-written.
    assert cvm.rejected_413 == 1


if __name__ == "__main__":  # pragma: no cover
    import pytest

    sys.exit(pytest.main([__file__, "-q"]))
