"""Vault upload proxy endpoint."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, UploadFile
from fastapi.responses import JSONResponse

from .. import cognivault
from ..cognivault import CogniVaultError
from ..deps import cv_context

router = APIRouter(prefix="/api")

_ZIP_MAGIC = b"PK\x03\x04"


def _error(status: int, code: str, message: str, detail: str | None = None) -> JSONResponse:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if detail is not None:
        body["error"]["detail"] = detail
    return JSONResponse(status_code=status, content=body)


@router.post("/upload")
async def upload(request: Request, file: UploadFile) -> Any:
    """Accept a zip and forward it to CogniVault's vault upload endpoint."""
    data = await file.read()
    filename = file.filename or "upload.zip"

    is_zip = data.startswith(_ZIP_MAGIC) or filename.lower().endswith(".zip")
    if not is_zip:
        return _error(400, "NOT_A_ZIP", "Ожидается ZIP-архив")

    try:
        result = await cognivault.upload(data, filename, cv=cv_context(request))
    except CogniVaultError as exc:
        return _error(
            502,
            "CV_UPLOAD_FAILED",
            f"CogniVault вернул {exc.status}",
            exc.body,
        )
    return result
