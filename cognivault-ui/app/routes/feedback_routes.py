"""Answer feedback endpoint: ``POST /api/feedback`` (👍/👎, wave 5.4).

A vote is appended to the caller's own ``rag_log.jsonl`` as a ``"feedback"``
record and matched to the answer it grades by ``(chat_id, message_index)`` — the
same index the chat route writes into its ``"request"`` record. No database, no
per-user state anywhere else.

The body is validated by hand (the project uses no pydantic models) and errors
use the standard ``{"error": {"code", "message"}}`` envelope.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import rag_log
from ..deps import resolve_paths

router = APIRouter(prefix="/api")

# Свободный комментарий пользователя — обрезаем, чтобы одна строка JSONL не
# распухла до мегабайтов.
MAX_COMMENT_CHARS = 1000

_VOTES = ("up", "down")


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status, content={"error": {"code": code, "message": message}}
    )


@router.post("/feedback")
async def post_feedback(request: Request) -> Any:
    """Record a 👍/👎 for one assistant answer.

    Body: ``{chat_id: str, message_index: int, vote: "up"|"down", comment?: str}``.
    Returns ``{"ok": true}``; a malformed body is a 400 ``BAD_REQUEST`` and a
    failed log write a 500 ``LOG_WRITE_FAILED``.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — any parse failure is a client error
        return _error(400, "BAD_REQUEST", "тело запроса должно быть JSON-объектом")
    if not isinstance(body, dict):
        return _error(400, "BAD_REQUEST", "тело запроса должно быть объектом")

    chat_id = str(body.get("chat_id") or "").strip()
    if not chat_id:
        return _error(400, "BAD_REQUEST", "chat_id обязателен")

    index = body.get("message_index")
    # ``bool`` is an ``int`` subclass — reject it explicitly.
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        return _error(400, "BAD_REQUEST", "message_index должен быть целым числом ≥ 0")

    vote = body.get("vote")
    if vote not in _VOTES:
        return _error(400, "BAD_REQUEST", "vote должен быть 'up' или 'down'")

    raw_comment = body.get("comment")
    comment = (
        str(raw_comment).strip()[:MAX_COMMENT_CHARS]
        if isinstance(raw_comment, str)
        else ""
    )

    record: dict[str, Any] = {
        "type": "feedback",
        "ts": rag_log.now_iso(),
        "chat_id": chat_id,
        "message_index": index,
        "vote": vote,
        "comment": comment or None,
    }
    if not rag_log.append(resolve_paths(request), record):
        return _error(500, "LOG_WRITE_FAILED", "не удалось сохранить оценку")
    return {"ok": True}
