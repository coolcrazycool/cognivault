"""Tests for the reindex / collection-rebuild client and route layer.

Two halves, both offline:

* ``app.cognivault`` — the five admin helpers driven with ``asyncio.run`` over an
  ``httpx.MockTransport`` (the same fake-transport pattern the Confluence client
  tests use): body/headers/query shape, and the three statuses that carry
  meaning (409 already running, 400 confirm mismatch, 404 older backend);
* ``app.routes.admin_routes`` — the proxy, through Starlette's ``TestClient`` in
  LOCAL mode (no bearer header needed) with ``httpx.AsyncClient`` monkeypatched
  so every upstream call lands on the mock instead of the network.

Covered end to end: happy path, 409 attaching to the job already running,
confirm mismatch, and a 404 from a backend that predates ``/api/admin/collection``.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import cognivault, config, settings  # noqa: E402
from app.cognivault import CogniVaultError  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes import admin_routes  # noqa: E402

CV_BASE = "https://cv.example.com"
CV = {"base_url": CV_BASE, "token": "cv-token"}


# --------------------------------------------------------------------------- #
# CogniVault mock
# --------------------------------------------------------------------------- #


class CVMock:
    """Programmable ``(method, path) -> (status, payload)`` CogniVault stub."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], tuple[int, object]] = {}
        self.requests: list[httpx.Request] = []

    def set(self, method: str, path: str, status: int, payload: object) -> None:
        self.routes[(method, path)] = (status, payload)

    def last(self, method: str, path: str) -> httpx.Request:
        for req in reversed(self.requests):
            if req.method == method and req.url.path == path:
                return req
        raise AssertionError(f"no {method} {path} was made")

    def count(self, method: str, path: str) -> int:
        return sum(
            1 for r in self.requests if r.method == method and r.url.path == path
        )

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        entry = self.routes.get((request.method, request.url.path))
        if entry is None:
            return httpx.Response(
                404,
                json={"error": {"code": "NOT_FOUND", "message": "no such route"}},
                request=request,
            )
        status, payload = entry
        return httpx.Response(status, json=payload, request=request)


def _patch_async_client(monkeypatch, mock: CVMock) -> None:
    """Default every ``httpx.AsyncClient`` onto the mock transport."""
    real = httpx.AsyncClient
    transport = httpx.MockTransport(mock.handler)

    def factory(*args, **kwargs):
        kwargs.setdefault("transport", transport)
        return real(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)


@pytest.fixture
def cvm(monkeypatch) -> CVMock:
    mock = CVMock()
    _patch_async_client(monkeypatch, mock)
    return mock


# --------------------------------------------------------------------------- #
# Client: app.cognivault
# --------------------------------------------------------------------------- #


def test_reindex_posts_scope_and_returns_job(cvm):
    cvm.set(
        "POST",
        "/api/admin/reindex",
        202,
        {"jobId": "job-1", "status": "running", "message": "started"},
    )
    result = asyncio.run(cognivault.reindex("full", cv=CV))
    assert result["jobId"] == "job-1"
    req = cvm.last("POST", "/api/admin/reindex")
    assert json.loads(req.content.decode("utf-8")) == {"scope": "full"}
    assert req.headers["authorization"] == "Bearer cv-token"


def test_reindex_409_raises_with_status(cvm):
    cvm.set(
        "POST",
        "/api/admin/reindex",
        409,
        {"error": {"code": "REINDEX_IN_PROGRESS", "message": "busy"}},
    )
    with pytest.raises(CogniVaultError) as excinfo:
        asyncio.run(cognivault.reindex("full", cv=CV))
    assert excinfo.value.status == 409
    assert "REINDEX_IN_PROGRESS" in excinfo.value.body


def test_reindex_status_sends_job_id(cvm):
    cvm.set(
        "GET",
        "/api/admin/reindex/status",
        200,
        {"jobId": "job-1", "status": "running", "filesProcessed": 3, "totalFiles": 9},
    )
    result = asyncio.run(cognivault.reindex_status("job-1", cv=CV))
    assert result["filesProcessed"] == 3
    assert cvm.last("GET", "/api/admin/reindex/status").url.params["jobId"] == "job-1"


def test_collection_info_happy(cvm):
    cvm.set(
        "GET",
        "/api/admin/collection",
        200,
        {
            "collection": "cognivault_v2",
            "alias": "cognivault",
            "schemeVersion": 2,
            "expectedSchemeVersion": 3,
            "pointsCount": 1234,
        },
    )
    info = asyncio.run(cognivault.collection_info(cv=CV))
    assert info["collection"] == "cognivault_v2"
    assert info["schemeVersion"] != info["expectedSchemeVersion"]


def test_collection_info_404_on_older_backend(cvm):
    with pytest.raises(CogniVaultError) as excinfo:
        asyncio.run(cognivault.collection_info(cv=CV))
    assert excinfo.value.status == 404


def test_rebuild_collection_forwards_confirm(cvm):
    cvm.set(
        "POST",
        "/api/admin/collection/rebuild",
        202,
        {"jobId": "reb-1", "status": "running", "message": "dropping"},
    )
    result = asyncio.run(cognivault.rebuild_collection("cognivault_v2", cv=CV))
    assert result["jobId"] == "reb-1"
    req = cvm.last("POST", "/api/admin/collection/rebuild")
    assert json.loads(req.content.decode("utf-8")) == {"confirm": "cognivault_v2"}


def test_rebuild_collection_confirm_mismatch_raises_400(cvm):
    cvm.set(
        "POST",
        "/api/admin/collection/rebuild",
        400,
        {"error": {"code": "CONFIRM_MISMATCH", "message": "nope"}},
    )
    with pytest.raises(CogniVaultError) as excinfo:
        asyncio.run(cognivault.rebuild_collection("wrong", cv=CV))
    assert excinfo.value.status == 400
    assert "CONFIRM_MISMATCH" in excinfo.value.body


def test_rebuild_status_returns_phase(cvm):
    cvm.set(
        "GET",
        "/api/admin/collection/rebuild/status",
        200,
        {
            "jobId": "reb-1",
            "status": "running",
            "phase": "indexing",
            "usersTotal": 4,
            "usersDone": 1,
        },
    )
    result = asyncio.run(cognivault.rebuild_status("reb-1", cv=CV))
    assert result["phase"] == "indexing"
    params = cvm.last("GET", "/api/admin/collection/rebuild/status").url.params
    assert params["jobId"] == "reb-1"


# --------------------------------------------------------------------------- #
# Routes: app.routes.admin_routes
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def _local_mode(monkeypatch, tmp_path):
    """LOCAL mode, a config file pointing at the mock CogniVault, empty job table."""
    root = tmp_path / ".cognivault-ui"
    root.mkdir(parents=True, exist_ok=True)
    (root / "config.json").write_text(
        json.dumps({"cognivault": {"base_url": CV_BASE, "token": "cv-token"}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(settings, "is_server", lambda: False)
    monkeypatch.setattr(config.PATHS, "root", root)
    admin_routes._JOBS.clear()
    yield
    admin_routes._JOBS.clear()


@pytest.fixture
def client(cvm) -> TestClient:
    return TestClient(create_app())


def _reindex_started(cvm: CVMock) -> None:
    cvm.set(
        "POST",
        "/api/admin/reindex",
        202,
        {"jobId": "job-1", "status": "running", "message": "started"},
    )


def test_route_reindex_happy_path(client, cvm):
    _reindex_started(cvm)
    res = client.post("/api/admin/reindex", json={"scope": "full"})
    assert res.status_code == 200
    body = res.json()
    assert body["jobId"] == "job-1"
    assert body["attached"] is False
    assert admin_routes._JOBS["reindex:local"] == "job-1"


def test_route_reindex_defaults_scope_to_full(client, cvm):
    _reindex_started(cvm)
    client.post("/api/admin/reindex", json={})
    sent = json.loads(cvm.last("POST", "/api/admin/reindex").content.decode("utf-8"))
    assert sent == {"scope": "full"}


def test_route_reindex_rejects_blank_scope(client, cvm):
    res = client.post("/api/admin/reindex", json={"scope": "   "})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "BAD_REQUEST"
    assert cvm.count("POST", "/api/admin/reindex") == 0


def test_route_reindex_409_attaches_to_running_job(client, cvm):
    _reindex_started(cvm)
    first = client.post("/api/admin/reindex", json={"scope": "full"})
    assert first.json()["jobId"] == "job-1"

    # Second click: upstream says a job is already running. That is not an error —
    # the same job id comes back with attached=true so the UI keeps polling it.
    cvm.set(
        "POST",
        "/api/admin/reindex",
        409,
        {"error": {"code": "REINDEX_IN_PROGRESS", "message": "busy"}},
    )
    second = client.post("/api/admin/reindex", json={"scope": "full"})
    assert second.status_code == 200
    body = second.json()
    assert body["jobId"] == "job-1"
    assert body["attached"] is True
    assert body["status"] == "running"


def test_route_reindex_409_without_known_job_reports_conflict(client, cvm):
    cvm.set(
        "POST",
        "/api/admin/reindex",
        409,
        {"error": {"code": "REINDEX_IN_PROGRESS", "message": "busy"}},
    )
    res = client.post("/api/admin/reindex", json={"scope": "full"})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "REINDEX_IN_PROGRESS"


def test_route_reindex_status_idle_without_any_job(client, cvm):
    res = client.get("/api/admin/reindex/status")
    assert res.status_code == 200
    assert res.json() == {"jobId": None, "status": "idle"}
    assert cvm.count("GET", "/api/admin/reindex/status") == 0


def test_route_reindex_status_uses_remembered_job(client, cvm):
    _reindex_started(cvm)
    client.post("/api/admin/reindex", json={"scope": "full"})
    cvm.set(
        "GET",
        "/api/admin/reindex/status",
        200,
        {"jobId": "job-1", "status": "running", "filesProcessed": 2, "totalFiles": 7},
    )
    res = client.get("/api/admin/reindex/status")  # no jobId — a returning user
    assert res.status_code == 200
    assert res.json()["filesProcessed"] == 2
    assert cvm.last("GET", "/api/admin/reindex/status").url.params["jobId"] == "job-1"


def test_route_reindex_status_forgets_finished_job(client, cvm):
    _reindex_started(cvm)
    client.post("/api/admin/reindex", json={"scope": "full"})
    cvm.set(
        "GET",
        "/api/admin/reindex/status",
        200,
        {
            "jobId": "job-1",
            "status": "completed",
            "filesProcessed": 7,
            "totalFiles": 7,
            "errors": [{"path": "a.md", "error": "boom"}],
            "errorCount": 1,
        },
    )
    first = client.get("/api/admin/reindex/status")
    assert first.json()["status"] == "completed"
    assert first.json()["errors"][0]["path"] == "a.md"
    # The job is over: it is no longer "in progress" for whoever opens the drawer next.
    assert "reindex:local" not in admin_routes._JOBS
    assert client.get("/api/admin/reindex/status").json()["status"] == "idle"


def test_route_reindex_status_unknown_job_becomes_idle(client, cvm):
    _reindex_started(cvm)
    client.post("/api/admin/reindex", json={"scope": "full"})
    # upstream forgot the job (restart / expiry) → 404 from the mock's default
    res = client.get("/api/admin/reindex/status")
    assert res.json() == {"jobId": None, "status": "idle"}
    assert "reindex:local" not in admin_routes._JOBS


def test_route_collection_passthrough(client, cvm):
    cvm.set(
        "GET",
        "/api/admin/collection",
        200,
        {
            "collection": "cognivault_v2",
            "alias": "cognivault",
            "schemeVersion": 2,
            "expectedSchemeVersion": 3,
            "pointsCount": 42,
        },
    )
    res = client.get("/api/admin/collection")
    assert res.status_code == 200
    assert res.json()["collection"] == "cognivault_v2"


def test_route_collection_404_degrades_to_501(client, cvm):
    """An older backend has no collection endpoints — say so, don't blow up."""
    res = client.get("/api/admin/collection")
    assert res.status_code == 501
    assert res.json()["error"]["code"] == "COLLECTION_API_UNAVAILABLE"


def test_route_rebuild_404_degrades_to_501(client, cvm):
    res = client.post("/api/admin/collection/rebuild", json={"confirm": "cognivault_v2"})
    assert res.status_code == 501
    assert res.json()["error"]["code"] == "COLLECTION_API_UNAVAILABLE"


def test_route_reindex_survives_older_backend(client, cvm):
    """Reindex keeps working even when the collection endpoints are missing."""
    _reindex_started(cvm)
    assert client.get("/api/admin/collection").status_code == 501
    assert client.post("/api/admin/reindex", json={"scope": "full"}).status_code == 200


def test_route_rebuild_requires_confirm(client, cvm):
    res = client.post("/api/admin/collection/rebuild", json={})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "CONFIRM_REQUIRED"
    assert cvm.count("POST", "/api/admin/collection/rebuild") == 0


def test_route_rebuild_confirm_mismatch(client, cvm):
    cvm.set(
        "POST",
        "/api/admin/collection/rebuild",
        400,
        {"error": {"code": "CONFIRM_MISMATCH", "message": "does not match"}},
    )
    res = client.post("/api/admin/collection/rebuild", json={"confirm": "cognivault"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "CONFIRM_MISMATCH"
    assert "rebuild:*" not in admin_routes._JOBS


def test_route_rebuild_happy_path(client, cvm):
    cvm.set(
        "POST",
        "/api/admin/collection/rebuild",
        202,
        {"jobId": "reb-1", "status": "running", "message": "dropping"},
    )
    res = client.post(
        "/api/admin/collection/rebuild", json={"confirm": "  cognivault_v2  "}
    )
    assert res.status_code == 200
    assert res.json()["jobId"] == "reb-1"
    sent = json.loads(
        cvm.last("POST", "/api/admin/collection/rebuild").content.decode("utf-8")
    )
    assert sent == {"confirm": "cognivault_v2"}  # trimmed before forwarding
    assert admin_routes._JOBS["rebuild:*"] == "reb-1"


def test_route_rebuild_409_attaches_to_running_job(client, cvm):
    cvm.set(
        "POST",
        "/api/admin/collection/rebuild",
        202,
        {"jobId": "reb-1", "status": "running", "message": "dropping"},
    )
    client.post("/api/admin/collection/rebuild", json={"confirm": "cognivault_v2"})
    cvm.set(
        "POST",
        "/api/admin/collection/rebuild",
        409,
        {"error": {"code": "REBUILD_IN_PROGRESS", "message": "busy"}},
    )
    res = client.post("/api/admin/collection/rebuild", json={"confirm": "cognivault_v2"})
    assert res.status_code == 200
    assert res.json() == {
        "jobId": "reb-1",
        "status": "running",
        "message": "Пересоздание коллекции уже выполняется",
        "attached": True,
    }


def test_route_rebuild_status_reports_phase(client, cvm):
    cvm.set(
        "POST",
        "/api/admin/collection/rebuild",
        202,
        {"jobId": "reb-1", "status": "running", "message": "dropping"},
    )
    client.post("/api/admin/collection/rebuild", json={"confirm": "cognivault_v2"})
    cvm.set(
        "GET",
        "/api/admin/collection/rebuild/status",
        200,
        {
            "jobId": "reb-1",
            "status": "running",
            "phase": "indexing",
            "usersTotal": 4,
            "usersDone": 2,
            "filesProcessed": 120,
            "errorCount": 0,
        },
    )
    res = client.get("/api/admin/collection/rebuild/status")
    assert res.status_code == 200
    body = res.json()
    assert body["phase"] == "indexing"
    assert (body["usersDone"], body["usersTotal"]) == (2, 4)


def test_route_rebuild_job_is_cluster_wide(client, cvm):
    """The rebuild key is global: a second user watches the SAME job."""
    cvm.set(
        "POST",
        "/api/admin/collection/rebuild",
        202,
        {"jobId": "reb-1", "status": "running", "message": "dropping"},
    )
    client.post("/api/admin/collection/rebuild", json={"confirm": "cognivault_v2"})
    assert set(admin_routes._JOBS) == {"rebuild:*"}


def test_route_upstream_failure_becomes_502(client, cvm):
    cvm.set("POST", "/api/admin/reindex", 500, {"error": {"code": "BOOM"}})
    res = client.post("/api/admin/reindex", json={"scope": "full"})
    assert res.status_code == 502
    assert res.json()["error"]["code"] == "CV_ADMIN_FAILED"
