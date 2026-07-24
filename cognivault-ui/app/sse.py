"""Server-Sent Events framing helpers."""

from __future__ import annotations

import json
from typing import Any


def format_sse(event: str, data: dict[str, Any]) -> str:
    """Serialise a single SSE message.

    Cyrillic and other non-ASCII content is kept verbatim (``ensure_ascii=False``)
    so the browser receives readable UTF-8 rather than ``\\uXXXX`` escapes.
    """
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


def sse_error(code: str, message: str, detail: str | None = None) -> str:
    """Build a terminal SSE ``error`` frame with the standard payload shape."""
    data: dict[str, Any] = {"code": code, "message": message}
    if detail is not None:
        data["detail"] = detail
    return format_sse("error", data)
