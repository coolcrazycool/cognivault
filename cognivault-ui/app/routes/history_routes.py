"""Chat history endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import history
from ..deps import resolve_paths

router = APIRouter(prefix="/api")


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status, content={"error": {"code": code, "message": message}}
    )


@router.get("/history")
async def get_history(request: Request) -> dict[str, Any]:
    """List the newest chats (summaries only), bucketed by the caller."""
    return {"chats": history.list_chats(resolve_paths(request))}


@router.get("/history/{chat_id}")
async def get_chat(chat_id: str, request: Request) -> Any:
    """Return a single chat by id (from the caller's bucket)."""
    paths = resolve_paths(request)
    try:
        chat = history.load_chat(chat_id, paths)
    except ValueError:
        return _error(400, "BAD_REQUEST", "некорректный id")
    if chat is None:
        return _error(404, "NOT_FOUND", "чат не найден")
    return chat


@router.delete("/history/{chat_id}")
async def remove_chat(chat_id: str, request: Request) -> Any:
    """Delete a chat by id (from the caller's bucket)."""
    paths = resolve_paths(request)
    try:
        removed = history.delete_chat(chat_id, paths)
    except ValueError:
        return _error(400, "BAD_REQUEST", "некорректный id")
    if not removed:
        return _error(404, "NOT_FOUND", "чат не найден")
    return {"deleted": chat_id}
