"""Environment management endpoints: setup (SSE), export, import."""

from __future__ import annotations

from typing import Any, AsyncIterator

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from .. import envtools
from ..envtools import ImportError_, setup_lock

router = APIRouter(prefix="/api/env")

_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


def _error(status: int, code: str, message: str, detail: str | None = None) -> JSONResponse:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if detail is not None:
        body["error"]["detail"] = detail
    return JSONResponse(status_code=status, content=body)


@router.post("/setup")
async def setup() -> Any:
    """Provision venv + deps, streaming progress as SSE. Single-flight."""
    if setup_lock.locked():
        return _error(409, "SETUP_ALREADY_RUNNING", "Установка уже выполняется")

    async def generator() -> AsyncIterator[str]:
        async with setup_lock:
            async for frame in envtools.setup_stream():
                yield frame

    return StreamingResponse(
        generator(), media_type="text/event-stream", headers=_SSE_HEADERS
    )


@router.get("/export")
async def export() -> Any:
    """Build and download an export zip; the temp file is deleted afterward."""
    zip_path = envtools.export_zip()
    filename = zip_path.name
    return FileResponse(
        path=str(zip_path),
        media_type="application/zip",
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        background=BackgroundTask(_cleanup, str(zip_path)),
    )


def _cleanup(path: str) -> None:
    import os

    try:
        os.remove(path)
    except OSError:
        pass


@router.post("/import")
async def import_env(payload: dict[str, Any]) -> Any:
    """Restore the data dir from an export zip (validated, with backup)."""
    path = str(payload.get("path", "") or "")
    if not path:
        return _error(400, "IMPORT_BAD_ZIP", "не указан путь к архиву")
    try:
        result = envtools.import_zip(path)
    except ImportError_ as exc:
        return _error(400, exc.code, exc.message)
    return result
