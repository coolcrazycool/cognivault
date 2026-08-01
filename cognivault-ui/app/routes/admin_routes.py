"""Reindex / collection-rebuild proxy for the settings drawer.

The operator has no shell or vector-database access, so both maintenance
operations have to be reachable from the chat UI. This router is a thin proxy
over CogniVault's ``/api/admin`` surface: it validates the body by hand (no
pydantic in this codebase), maps upstream statuses onto the standard
``{"error": {...}}`` envelope, and remembers the id of the last job it started.

**Polling, not SSE.** The Confluence sync streams because the UI process itself
does the work and produces the events; here the work happens upstream and the
contract is already a job id plus a status endpoint — an SSE bridge would just
be this server polling on the browser's behalf, with no extra fidelity and three
real drawbacks:

* a reindex, and especially a rebuild, can run far longer than any sane HTTP
  stream; the job must outlive the page, and an SSE connection dies with it;
* a returning operator has to be able to see a job that is already running.
  Polling reattaches trivially (``GET status``); a stream has nothing to rejoin;
* upstream has no push channel, so a stream would add a moving part without
  adding information.

**Job state lives in PROCESS MEMORY** (:data:`_JOBS`), never in the per-user
JSON config — that file is settings, and a job id is neither user-configurable
nor meaningful after the job ends. Keeping it here is what lets the UI answer
"is something running?" for a user who reloaded the page (or opened a second
tab), and what lets a **409** from upstream *attach* to the running job instead
of surfacing an error. The reindex key is per tenant; a rebuild is cluster-wide,
so its key is global — every user watches the same job.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from .. import cognivault, settings
from ..cognivault import CogniVaultError
from ..deps import cv_context, get_token, user_bucket

router = APIRouter(prefix="/api/admin")

REINDEX = "reindex"
REBUILD = "rebuild"

# ``kind:tenant`` -> jobId of the last job this process started. Bounded by the
# number of tenants; entries are overwritten, and dropped when upstream stops
# recognising the id.
_JOBS: dict[str, str] = {}

_REINDEX_BUSY = "Переиндексация уже выполняется"
_REBUILD_BUSY = "Пересоздание коллекции уже выполняется"
_COLLECTION_UNAVAILABLE = (
    "Эта версия CogniVault не умеет пересоздавать коллекцию — обновите сервис"
)
_REINDEX_UNAVAILABLE = (
    "Эта версия CogniVault не умеет переиндексировать по запросу — обновите сервис"
)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _error(
    status: int, code: str, message: str, detail: str | None = None
) -> JSONResponse:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if detail is not None:
        body["error"]["detail"] = detail
    return JSONResponse(status_code=status, content=body)


def _upstream_code(body: str) -> str:
    """The ``error.code`` out of a CogniVault error body, or ``""``."""
    try:
        data = json.loads(body or "")
    except (ValueError, TypeError):
        return ""
    if isinstance(data, dict) and isinstance(data.get("error"), dict):
        return str(data["error"].get("code", "") or "")
    return ""


def _job_key(kind: str, request: Request) -> str:
    """Single-flight/attach key: per tenant for a reindex, global for a rebuild."""
    if kind == REBUILD:
        return "rebuild:*"  # destructive and cluster-wide — one job for everyone
    if settings.is_server():
        return f"{kind}:{user_bucket(get_token(request))}"
    return f"{kind}:local"


def _idle() -> dict[str, Any]:
    """The "nothing is running" status shape, shared by both status routes."""
    return {"jobId": None, "status": "idle"}


def _remember(kind: str, request: Request, result: dict[str, Any]) -> dict[str, Any]:
    """Store the started job's id and shape the start response."""
    job_id = str(result.get("jobId") or "")
    if job_id:
        _JOBS[_job_key(kind, request)] = job_id
    return {
        "jobId": job_id or None,
        "status": str(result.get("status") or "running"),
        "message": str(result.get("message") or ""),
        "attached": False,
    }


def _start_failure(
    kind: str,
    request: Request,
    exc: CogniVaultError,
    *,
    busy_message: str,
    missing_code: str,
    missing_message: str,
) -> Any:
    """Map a failed start onto a response — attaching on 409 where possible.

    A **409** means the operator (or a second tab, or a double click) got there
    first. That is not an error to report: when this process knows the running
    job's id we answer ``200 {attached: true}`` and the browser simply starts
    polling it. Only when the id is unknown — a job started by another replica or
    before a restart — does the 409 reach the UI, and then as a plain "already
    running" notice rather than a failure.
    """
    code = _upstream_code(exc.body)
    if exc.status == 409:
        known = _JOBS.get(_job_key(kind, request))
        if known:
            return {
                "jobId": known,
                "status": "running",
                "message": busy_message,
                "attached": True,
            }
        return _error(409, code or "IN_PROGRESS", busy_message)
    if exc.status == 400 and code == "CONFIRM_MISMATCH":
        return _error(
            400,
            "CONFIRM_MISMATCH",
            "Название коллекции не совпадает — ничего не запущено",
        )
    if exc.status == 404:
        return _error(501, missing_code, missing_message)
    return _error(
        502, "CV_ADMIN_FAILED", f"CogniVault вернул {exc.status}", exc.body
    )


_TERMINAL = ("completed", "failed")


async def _status(kind: str, request: Request, job_id: str | None) -> Any:
    """Shared status read: explicit id, else the remembered one, else idle.

    Two forgetting rules keep the remembered id honest, so "remembered" always
    means "still running" and reopening the drawer can never replay a finished
    job at whoever shows up next:

    * an upstream **404** — the id expired or the service restarted;
    * a terminal status — the client polling it has just seen the result.
    """
    key = _job_key(kind, request)
    resolved = (job_id or "").strip() or _JOBS.get(key, "")
    if not resolved:
        return _idle()
    reader = (
        cognivault.rebuild_status if kind == REBUILD else cognivault.reindex_status
    )
    try:
        result = await reader(resolved, cv=cv_context(request))
    except CogniVaultError as exc:
        if exc.status == 404:
            _JOBS.pop(key, None)
            return _idle()
        return _error(
            502, "CV_ADMIN_FAILED", f"CogniVault вернул {exc.status}", exc.body
        )
    if isinstance(result, dict) and str(result.get("status", "")) in _TERMINAL:
        _JOBS.pop(key, None)
    return result


# --------------------------------------------------------------------------- #
# Vault reindex (non-destructive, this user's documents)
# --------------------------------------------------------------------------- #


@router.post("/reindex")
async def start_reindex(
    request: Request, body: dict[str, Any] = Body(default_factory=dict)
) -> Any:
    """Start a re-chunk/re-embed of the caller's vault. Returns immediately."""
    scope = body.get("scope", "full")
    if not isinstance(scope, str) or not scope.strip():
        return _error(400, "BAD_REQUEST", "Поле «scope» должно быть непустой строкой")

    try:
        result = await cognivault.reindex(scope.strip(), cv=cv_context(request))
    except CogniVaultError as exc:
        return _start_failure(
            REINDEX,
            request,
            exc,
            busy_message=_REINDEX_BUSY,
            missing_code="REINDEX_UNAVAILABLE",
            missing_message=_REINDEX_UNAVAILABLE,
        )
    return _remember(REINDEX, request, result)


@router.get("/reindex/status")
async def get_reindex_status(request: Request, jobId: str | None = None) -> Any:
    """Progress of a reindex — the given job, the remembered one, or idle."""
    return await _status(REINDEX, request, jobId)


# --------------------------------------------------------------------------- #
# Collection rebuild (destructive, cluster-wide)
# --------------------------------------------------------------------------- #


@router.get("/collection")
async def get_collection(request: Request) -> Any:
    """Physical collection name, alias, scheme version and point count.

    The UI needs the collection name for the typed confirmation and the two
    scheme versions to tell the operator whether the lexical branch is degraded.
    An older backend has no such endpoint: that becomes a ``501`` the UI reads as
    "no rebuild surface here" rather than a hard failure.
    """
    try:
        return await cognivault.collection_info(cv=cv_context(request))
    except CogniVaultError as exc:
        if exc.status == 404:
            return _error(
                501, "COLLECTION_API_UNAVAILABLE", _COLLECTION_UNAVAILABLE
            )
        return _error(
            502, "CV_ADMIN_FAILED", f"CogniVault вернул {exc.status}", exc.body
        )


@router.post("/collection/rebuild")
async def start_rebuild(
    request: Request, body: dict[str, Any] = Body(default_factory=dict)
) -> Any:
    """Drop and rebuild the whole collection. Destructive for every user.

    ``confirm`` must carry the physical collection name the operator typed. We
    only check that something was typed — the backend owns the comparison and
    answers ``400 CONFIRM_MISMATCH``, so the expected value is never duplicated
    (or leaked into a decision) here.
    """
    confirm = body.get("confirm")
    if not isinstance(confirm, str) or not confirm.strip():
        return _error(
            400,
            "CONFIRM_REQUIRED",
            "Введите название коллекции, чтобы подтвердить пересоздание",
        )

    try:
        result = await cognivault.rebuild_collection(
            confirm.strip(), cv=cv_context(request)
        )
    except CogniVaultError as exc:
        return _start_failure(
            REBUILD,
            request,
            exc,
            busy_message=_REBUILD_BUSY,
            missing_code="COLLECTION_API_UNAVAILABLE",
            missing_message=_COLLECTION_UNAVAILABLE,
        )
    return _remember(REBUILD, request, result)


@router.get("/collection/rebuild/status")
async def get_rebuild_status(request: Request, jobId: str | None = None) -> Any:
    """Progress of a rebuild — the given job, the remembered one, or idle."""
    return await _status(REBUILD, request, jobId)
