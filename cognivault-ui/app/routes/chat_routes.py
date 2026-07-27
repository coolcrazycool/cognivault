"""Chat endpoint: SSE streaming with optional RAG."""

from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime
from typing import Any, AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .. import gigachat, history, rag, settings
from ..confluence import store as confluence_store
from ..deps import cv_context, resolve_paths
from ..gigachat import GigaChatCertMissing, GigaChatError, GigaConfig
from ..sse import format_sse, sse_error

log = logging.getLogger("cognivault-ui.chat")

router = APIRouter(prefix="/api")

_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


def _new_chat_id() -> str:
    return f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}"


def _error(status: int, code: str, message: str, detail: str | None = None) -> JSONResponse:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if detail is not None:
        body["error"]["detail"] = detail
    return JSONResponse(status_code=status, content=body)


def _last_user_content(messages: list[dict[str, Any]]) -> str:
    for msg in reversed(messages):
        if msg.get("role") == "user":
            return str(msg.get("content", ""))
    return ""


@router.post("/chat")
async def chat(request: Request) -> Any:
    """Stream a GigaChat completion (optionally RAG-augmented) as SSE.

    Pre-flight validation may return a plain JSON error (e.g. missing certs)
    before the stream starts; once streaming begins, errors are terminal SSE
    ``error`` frames.
    """
    body = await request.json()
    if not isinstance(body, dict):
        return _error(400, "BAD_REQUEST", "тело запроса должно быть объектом")

    messages = body.get("messages") or []
    if not isinstance(messages, list) or not messages:
        return _error(400, "BAD_REQUEST", "messages обязательны")

    use_rag = bool(body.get("rag", False))
    chat_id = str(body.get("chat_id") or "") or _new_chat_id()

    # Per-request identity/context: which CogniVault + which history bucket.
    cv = cv_context(request)
    paths = resolve_paths(request)

    # Reverse index {vault_path: confluence_page_url} so RAG source chips can link
    # back to their origin Confluence page. Defensive: a manifest error must never
    # break chat — fall back to no urls.
    try:
        url_index = confluence_store.manifest_url_index(paths)
    except Exception:  # noqa: BLE001 — link enrichment is best-effort
        url_index = {}

    cfg = settings.effective_config()
    gcfg = GigaConfig.from_dict(cfg.get("gigachat", {}))

    # Per-request overrides.
    if "temperature" in body and body["temperature"] is not None:
        gcfg.temperature = float(body["temperature"])
    if "max_tokens" in body and body["max_tokens"] is not None:
        gcfg.max_tokens = int(float(body["max_tokens"]))

    rcfg = dict(cfg.get("rag", {}))
    if "rag_limit" in body and body["rag_limit"] is not None:
        rcfg["limit"] = int(body["rag_limit"])

    # Gigachat config view for the RAG char budget (respect per-request max_tokens).
    giga_dict = dict(cfg.get("gigachat", {}))
    giga_dict["max_tokens"] = gcfg.max_tokens

    # Pre-flight: cert/key presence (raises a typed error we convert to 400).
    try:
        gigachat._files_present(gcfg)  # noqa: SLF001 — deliberate pre-flight reuse
    except GigaChatCertMissing as exc:
        return _error(400, exc.code, exc.message, exc.detail)

    # Normalise incoming messages to {role, content} for GigaChat.
    outgoing: list[dict[str, Any]] = [
        {"role": m.get("role"), "content": m.get("content", "")}
        for m in messages
        if isinstance(m, dict)
    ]
    # User messages to persist (exclude any system prompts entirely).
    user_messages = [m for m in outgoing if m.get("role") != "system"]

    async def generator() -> AsyncIterator[str]:
        full_text = ""
        sources: list[dict[str, Any]] = []
        context_chars = 0
        rag_used = False
        finish_reason: str | None = None
        truncated = False
        errored = False

        try:
            yield format_sse("meta", {"chat_id": chat_id})

            send = list(outgoing)

            if use_rag:
                query = _last_user_content(outgoing)
                system_message, sources, notice, context_chars = await rag.build_rag_context(
                    query, rcfg, cv, giga_dict, outgoing
                )
                if notice:
                    yield format_sse("notice", {"message": notice})
                elif system_message is not None:
                    rag_used = True
                    # Attach a Confluence page url to any source whose vault path
                    # is a synced Confluence page (absent otherwise). Mutates the
                    # source dicts in place so the persisted history keeps the link.
                    for source in sources:
                        u = url_index.get(source.get("path"))
                        if u:
                            source["url"] = u
                    yield format_sse(
                        "sources", {"sources": sources, "context_chars": context_chars}
                    )
                    # Replace any prior system message for predictable behavior.
                    send = [m for m in outgoing if m.get("role") != "system"]
                    send.insert(0, system_message)

            async for delta in gigachat.stream_chat(send, gcfg):
                full_text += delta
                yield format_sse("token", {"text": delta})

            finish_reason = getattr(gcfg, "last_finish_reason", None)
            yield format_sse("done", {"chat_id": chat_id, "finish_reason": finish_reason})

        except GigaChatError as exc:
            errored = True
            log.warning("gigachat error [%s]: %s", exc.code, exc.message)
            yield sse_error(exc.code, exc.message, exc.detail)
        except asyncio.CancelledError:
            truncated = True
            raise
        except Exception as exc:  # noqa: BLE001 — last-resort terminal error frame
            errored = True
            log.exception("unexpected chat error")
            yield sse_error("CHAT_FAILED", "Внутренняя ошибка чата", str(exc))
        finally:
            assistant = {
                "role": "assistant",
                "content": full_text,
                "rag": rag_used,
                "sources": sources if rag_used else [],
                "context_chars": context_chars if rag_used else 0,
                "truncated": truncated,
            }
            # Persist even partial/errored turns so the user keeps their history.
            if full_text or not errored:
                try:
                    history.save_chat(chat_id, [*user_messages, assistant], paths)
                except Exception:  # noqa: BLE001
                    log.exception("failed to persist chat %s", chat_id)

    return StreamingResponse(
        generator(), media_type="text/event-stream", headers=_SSE_HEADERS
    )
