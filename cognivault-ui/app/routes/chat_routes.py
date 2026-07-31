"""Chat endpoint: SSE streaming with optional RAG."""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
from datetime import datetime
from typing import Any, AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .. import gigachat, history, rag, rag_log, settings
from ..confluence import store as confluence_store
from ..deps import cv_context, resolve_paths
from ..gigachat import GigaChatCertMissing, GigaChatError, GigaConfig
from ..sse import format_sse, sse_error
from ..tokens import estimate_messages_tokens, trim_history

log = logging.getLogger("cognivault-ui.chat")

router = APIRouter(prefix="/api")

# Запас поверх system + max_tokens: разметка чата, служебные токены модели.
_TRIM_RESERVE_TOKENS = 500

# Цитаты вида «[Источник 3]», «[Источники 1, 2]», «[Источника 4; 5]».
_CITATION_RE = re.compile(
    r"\[\s*Источник(?:и|а)?\s+(\d+(?:\s*[,;]\s*\d+)*)\s*\]"
)

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


def _fit_to_context(
    send: list[dict[str, Any]], giga_dict: dict[str, Any]
) -> tuple[list[dict[str, Any]], int]:
    """Урезать историю в ``send`` под контекстное окно модели.

    Бюджет ``= model_context_tokens - max_tokens - <system> - 500``.
    Системный префикс не режется — его стоимость вычитается из бюджета целиком.

    Остальное уходит в :func:`trim_history`, который защищает хвост, начиная с
    ПОСЛЕДНЕГО ``user``-сообщения, и при этом учитывает его размер в оценке. В
    RAG-режиме последним сообщением идёт как раз user-сообщение с блоком
    «Источники» — значит контекст никогда не режется, а его токены всё равно
    вычитаются из бюджета: обрезается только история между system и ним.

    Возвращает ``(список для модели, число отброшенных сообщений)``.
    """
    head = 0
    while head < len(send) and send[head].get("role") == "system":
        head += 1
    system_prefix = send[:head]
    convo = send[head:]

    model_ctx = int(giga_dict.get("model_context_tokens", 32768) or 32768)
    max_tokens = int(giga_dict.get("max_tokens", 4096) or 4096)
    budget = (
        model_ctx
        - max_tokens
        - estimate_messages_tokens(system_prefix)
        - _TRIM_RESERVE_TOKENS
    )

    convo, dropped = trim_history(convo, max(0, budget))
    return [*system_prefix, *convo], dropped


def _last_user_content(messages: list[dict[str, Any]]) -> str:
    for msg in reversed(messages):
        if msg.get("role") == "user":
            return str(msg.get("content", ""))
    return ""


def _without_last_user_turn(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """История без последнего ``user``-хода (и всего, что после него).

    В RAG-режиме сам вопрос переезжает в финальное user-сообщение вместе с
    источниками, поэтому дублировать его в истории не нужно.
    """
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            return list(messages[:i])
    return list(messages)


def _invalid_citations(text: str, n_sources: int) -> list[int]:
    """Номера ``[Источник N]`` из ответа, выходящие за ``1..n_sources``.

    Дешёвая серверная проверка галлюцинированных ссылок: модель иногда
    цитирует источник, которого в контексте не было. Возвращает отсортированный
    список уникальных «плохих» номеров (пустой — всё в порядке).
    """
    if not text:
        return []
    found: set[int] = set()
    for match in _CITATION_RE.finditer(text):
        for part in re.split(r"[,;]", match.group(1)):
            part = part.strip()
            if part.isdigit():
                found.add(int(part))
    return sorted(n for n in found if n < 1 or n > n_sources)


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

    # Position of the answer we are about to produce inside the persisted chat
    # (``save_chat`` writes ``[*user_messages, assistant]``). The UI uses the same
    # index when it POSTs a 👍/👎 to ``/api/feedback``, so the two line up.
    message_index = len(user_messages)
    question_raw = _last_user_content(outgoing)

    async def generator() -> AsyncIterator[str]:
        full_text = ""
        sources: list[dict[str, Any]] = []
        context_chars = 0
        rag_used = False
        finish_reason: str | None = None
        truncated = False
        errored = False
        invalid_citations: list[int] = []
        notice: str | None = None

        try:
            yield format_sse("meta", {"chat_id": chat_id})

            send = list(outgoing)

            if use_rag:
                query = _last_user_content(outgoing)
                ctx = await rag.build_rag_context(
                    query, rcfg, cv, giga_dict, outgoing
                )
                sources = ctx.sources
                context_chars = ctx.context_chars
                notice = ctx.notice
                if ctx.notice:
                    yield format_sse("notice", {"message": ctx.notice})
                elif ctx.system_message is not None and ctx.user_message is not None:
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
                    # [rules-only system] + [история без последнего вопроса] +
                    # [user-сообщение с источниками и тем же вопросом].
                    # Любой пришедший system отбрасывается ради предсказуемости.
                    prior = [m for m in outgoing if m.get("role") != "system"]
                    send = [
                        ctx.system_message,
                        *_without_last_user_turn(prior),
                        ctx.user_message,
                    ]

            # Урезаем ТОЛЬКО то, что уходит в модель: `outgoing`/`user_messages`
            # (RAG-эвристика и persistence) остаются нетронутыми.
            send, dropped = _fit_to_context(send, giga_dict)
            if dropped:
                log.info(
                    "chat %s: history trimmed, dropped %d message(s)", chat_id, dropped
                )

            async for delta in gigachat.stream_chat(send, gcfg):
                full_text += delta
                yield format_sse("token", {"text": delta})

            # Серверная валидация цитат: номера вне 1..len(sources) — признак
            # галлюцинации. Значение уезжает и в assistant-сообщение (history),
            # и в JSONL-лог запросов.
            invalid_citations = _invalid_citations(full_text, len(sources))
            if invalid_citations:
                log.warning(
                    "chat %s: ответ ссылается на несуществующие источники %s "
                    "(в контексте их %d)",
                    chat_id,
                    invalid_citations,
                    len(sources),
                )

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
                "invalid_citations": invalid_citations,
            }
            # Persist even partial/errored turns so the user keeps their history.
            if full_text or not errored:
                try:
                    history.save_chat(chat_id, [*user_messages, assistant], paths)
                except Exception:  # noqa: BLE001
                    log.exception("failed to persist chat %s", chat_id)

            # Лог качества RAG (волна 5.1). Пишется в `finally`, поэтому даже
            # оборванный или ошибочный ответ оставляет запись. `rag_log.append`
            # никогда не бросает — чат не зависит от телеметрии.
            rag_log.append(
                paths,
                {
                    "type": "request",
                    "ts": rag_log.now_iso(),
                    "chat_id": chat_id,
                    "message_index": message_index,
                    # Появятся в волне 2 вместе с классификатором намерения и
                    # переписыванием вопроса в самодостаточный.
                    "intent": None,
                    "question_raw": question_raw,
                    "question_standalone": None,
                    # Кандидаты поиска до отбора живут внутри `rag.py` и наружу
                    # (в `RagContext`) пока не выходят — появятся в волне 2
                    # вместе с грейдером, тогда же здесь станут списком
                    # {path, chunk_index, score}.
                    "candidates": None,
                    "grades": None,
                    "sources": [
                        {
                            "n": s.get("n"),
                            "path": s.get("path"),
                            "section_path": s.get("section_path"),
                            "depth": s.get("depth"),
                            "score": s.get("score"),
                        }
                        for s in sources
                    ],
                    "answer_chars": len(full_text),
                    "invalid_citations": invalid_citations,
                    "rag_used": rag_used,
                    "notice": notice,
                    "truncated": truncated,
                },
            )

    return StreamingResponse(
        generator(), media_type="text/event-stream", headers=_SSE_HEADERS
    )
