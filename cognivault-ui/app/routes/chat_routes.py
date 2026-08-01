"""Chat endpoint: SSE streaming with optional RAG."""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import time
from datetime import datetime
from typing import Any, AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .. import cognivault, gigachat, history, rag, rag_log, rag_pipeline, settings
from ..config import AppPaths
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

# `finish_reason` для ветки готового ответа (`RagContext.answer_override`):
# грейдер не оставил ни одного пригодного фрагмента, GigaChat в этом ходе не
# вызывался — значит подставить его `last_finish_reason` нечем, код наш.
_NO_CONTEXT_FINISH_REASON = "no_context"

# Заголовок блока источников в отрендеренном user-сообщении
# (`rag._render_context_message`). Сам блок идёт сразу за ним и имеет ровно
# `ctx.context_chars` символов — по этому инварианту он вырезается обратно в
# лог без парсинга разметки. Ищется поиском, а не по началу строки: перед
# источниками может стоять блок «состав базы» (`app.corpus_map`), и он в лог
# контекста не входит — там должно остаться ровно то, что оценивает eval.
_SOURCES_PREFIX = "Источники:\n\n"

# Инструментирование стадий конвейера. Роут владеет только своими вызовами, а
# condense/поиск/грейдер живут внутри `rag.build_rag_context`; поэтому seams
# оборачиваются один раз при импорте (см. `rag_log.instrument` — обёртка
# идемпотентна, а monkeypatch в тестах её просто снимает). Сами модули при этом
# не правятся: тайминги — забота лога, а не конвейера.
for _module, _attr, _stage in (
    (rag_pipeline, "condense", "condense"),
    (rag_pipeline, "grade", "grade"),
    (cognivault, "hybrid_search", "search"),
    (cognivault, "semantic_search", "search"),
    (cognivault, "content", "content"),
):
    rag_log.instrument(_module, _attr, _stage)


def _effective_config(paths: AppPaths) -> dict[str, Any]:
    """Активный конфиг ЭТОГО пользователя.

    Предпочитаем пер-пользовательский ``settings.effective_config_for(paths)``;
    пока/если его нет — мягко откатываемся на глобальный
    ``settings.effective_config()``. Обращение через :func:`getattr`, чтобы
    маршрут не ломался на сборке без новой функции.
    """
    per_user = getattr(settings, "effective_config_for", None)
    if callable(per_user):
        return per_user(paths)
    return settings.effective_config()


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


def _linked_candidates(
    candidates: list[dict[str, Any]] | None, grades: list[dict[str, Any]] | None
) -> list[dict[str, Any]] | None:
    """Give every candidate the id its grade is filed under.

    The grader numbers fragments 1..N positionally over the candidate list
    (``rag_pipeline._parse_grades``), so ``grades[i].id`` and ``candidates[i]``
    describe the same chunk — but nothing in the record said so, which made
    ``grades[].id`` a number pointing at nothing. Copying the id onto the
    candidate closes the loop: ``candidates[k].id == grades[m].id`` ⇒ same chunk.

    An id already present upstream wins, so a future pipeline that numbers
    candidates itself is not overridden.
    """
    if candidates is None:
        return None
    by_index = {i: g for i, g in enumerate(grades or []) if isinstance(g, dict)}
    out: list[dict[str, Any]] = []
    for i, candidate in enumerate(candidates):
        item = dict(candidate)
        grade = by_index.get(i) or {}
        item["id"] = item.get("id") or grade.get("id") or i + 1
        out.append(item)
    return out


def _chunk_indexes_for(
    source: dict[str, Any], candidates: list[dict[str, Any]] | None
) -> list[int]:
    """Which retrieved chunks of a file this context block actually carries.

    ``sources`` is a UI-facing shape and has no chunk identity, so a golden pair
    could never be checked at chunk level — only "was the file cited". The
    identity is recoverable from ``candidates``, which do carry
    ``chunk_index``:

    * ``depth == "file"`` — the whole document is in the context, so every
      retrieved chunk of that path counts as present;
    * otherwise the block was rendered from one fragment and its ``score`` is
      that fragment's score, which pins the exact candidate;
    * if the score matches nothing (merged chunks, a ``None`` score, an older
      pipeline) fall back to every retrieved chunk of the path — an
      over-approximation, but the honest one: those chunks were merged into the
      block.
    """
    path = source.get("path")
    if not path or not candidates:
        return []
    own = [c for c in candidates if c.get("path") == path]
    indexes = [c.get("chunk_index") for c in own]
    if source.get("depth") != "file":
        score = source.get("score")
        if score is not None:
            exact = [c.get("chunk_index") for c in own if c.get("score") == score]
            if exact:
                indexes = exact
    return [i for i in indexes if isinstance(i, int)]


def _log_sources(
    sources: list[dict[str, Any]], candidates: list[dict[str, Any]] | None
) -> list[dict[str, Any]]:
    """Per-source rows of the query log: identity + verdict, no free text."""
    out: list[dict[str, Any]] = []
    for source in sources:
        explicit = source.get("chunk_index")
        indexes = (
            [explicit]
            if isinstance(explicit, int)
            else _chunk_indexes_for(source, candidates)
        )
        out.append(
            {
                "n": source.get("n"),
                "path": source.get("path"),
                "section_path": source.get("section_path"),
                "depth": source.get("depth"),
                "score": source.get("score"),
                "grade": source.get("grade"),
                # Primary chunk plus every chunk the block covers: a whole-file
                # or merged block legitimately answers for several of them.
                "chunk_index": indexes[0] if indexes else None,
                "chunk_indexes": indexes,
            }
        )
    return out


def _rendered_context(user_message: dict[str, Any] | None, context_chars: int) -> str:
    """The «Источники» block exactly as it went to the model.

    Cut by length, not by parsing: ``context_chars`` is by construction the
    length of the rendered block that follows :data:`_SOURCES_PREFIX`. The
    prefix is *located* rather than assumed to be at position 0 — the corpus
    footprint block may precede it — and if it is absent altogether (a custom
    renderer) the whole content is logged rather than a wrong slice of it.
    """
    if not isinstance(user_message, dict):
        return ""
    content = str(user_message.get("content", "") or "")
    start = content.find(_SOURCES_PREFIX)
    if start < 0 or context_chars <= 0:
        return content
    start += len(_SOURCES_PREFIX)
    return content[start : start + context_chars]


@router.post("/chat")
async def chat(request: Request) -> Any:
    """Stream a GigaChat completion (optionally RAG-augmented) as SSE.

    Pre-flight validation may return a plain JSON error (e.g. missing certs)
    before the stream starts; once streaming begins, errors are terminal SSE
    ``error`` frames.

    Frame order is part of the contract: ``meta`` → (``notice`` | ``sources``)
    → ``token``\\* → ``done``. ``sources`` is always emitted *before* the first
    token so the retrieval/grading latency hides behind the first paint.

    Three RAG outcomes are routed here (wave 2):

    * ``answer_override`` — the answer is already known (nothing survived the
      grader): one ``token`` frame, no GigaChat call at all;
    * ``smalltalk``/``clarify`` — ``system_message`` without ``user_message``:
      the no-RAG rules turn in front of the untouched history, no ``sources``
      frame. The system turn is *not* optional here — without it the model
      answers chit-chat from its own parametric memory;
    * ``kb_question`` — the normal path: rules system turn + history without its
      last user turn + the user turn carrying the sources block.
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

    cfg = _effective_config(paths)
    gcfg = GigaConfig.from_dict(cfg.get("gigachat", {}))

    # Настраиваемые тексты промптов ответа: `None`/пусто в любом поле означает
    # «взять встроенный дефолт» — разбирается в `rag._resolve_prompt`.
    prompts = cfg.get("prompts")
    if not isinstance(prompts, dict):
        prompts = None

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
        context_text = ""
        rag_used = False
        finish_reason: str | None = None
        truncated = False
        errored = False
        invalid_citations: list[int] = []
        notice: str | None = None
        # Телеметрия конвейера волны 2 (интент + condense, кандидаты, грейды).
        # Остаётся `None` вне RAG-режима и на старом `RagContext`.
        intent: str | None = None
        question_standalone: str | None = None
        candidates: list[dict[str, Any]] | None = None
        grades: list[dict[str, Any]] | None = None
        # Стадии конвейера. `condense`/`search`/`grade`/`content` приходят из
        # инструментированных seams (см. верх модуля), остальное меряем здесь.
        turn_started = time.perf_counter()

        def _elapsed_ms(since: float) -> float:
            return round((time.perf_counter() - since) * 1000.0, 1)

        with rag_log.collect_stages() as stages:
            try:
                yield format_sse("meta", {"chat_id": chat_id})

                send = list(outgoing)

                if use_rag:
                    query = _last_user_content(outgoing)
                    rag_started = time.perf_counter()
                    ctx = await rag.build_rag_context(
                        query, rcfg, cv, giga_dict, outgoing, prompts=prompts
                    )
                    stages["rag"] = _elapsed_ms(rag_started)
                    sources = ctx.sources
                    context_chars = ctx.context_chars
                    notice = ctx.notice
                    # Поля волны 2 читаем мягко: они keyword-defaulted и могут
                    # отсутствовать на более старом `RagContext`.
                    intent = getattr(ctx, "intent", None)
                    question_standalone = getattr(ctx, "standalone_question", None)
                    candidates = getattr(ctx, "candidates", None)
                    grades = getattr(ctx, "grades", None)
                    answer_override = getattr(ctx, "answer_override", None)

                    if answer_override:
                        # Ответ уже готов (шаблонный отказ: ни один кандидат не
                        # прошёл грейдер) — генерацию пропускаем целиком, GigaChat
                        # в этой ветке не вызывается вообще. Кадры те же, что в
                        # обычном ходе: meta → sources (пустой) → token → done.
                        rag_used = True
                        sources = []
                        context_chars = 0
                        full_text = answer_override
                        finish_reason = _NO_CONTEXT_FINISH_REASON
                        log.info(
                            "chat %s: answer_override (intent=%s), генерация пропущена",
                            chat_id,
                            intent,
                        )
                        yield format_sse("sources", {"sources": [], "context_chars": 0})
                        yield format_sse("token", {"text": full_text})
                        yield format_sse(
                            "done", {"chat_id": chat_id, "finish_reason": finish_reason}
                        )
                        return

                    # Сбой поиска (`notice`) — единственная ветка, где системный
                    # турн не подставляется: жаловаться уже есть на что, а правил
                    # для ответа без источников RAG-слой в этом случае не даёт.
                    if ctx.notice:
                        yield format_sse("notice", {"message": ctx.notice})
                    elif ctx.system_message is not None:
                        # Системный турн ставится ВСЕГДА, когда он есть, даже без
                        # `user_message`: у `smalltalk`/`clarify` источников нет,
                        # но правила («не выдавай факты из собственных знаний»)
                        # обязаны доехать до модели — иначе ответ приходит из
                        # параметрической памяти и внешне неотличим от нормального.
                        # Любой пришедший system отбрасывается ради предсказуемости.
                        prior = [m for m in outgoing if m.get("role") != "system"]
                        if ctx.user_message is None:
                            # Заменить последний вопрос нечем — история идёт целиком.
                            send = [ctx.system_message, *prior]
                        else:
                            rag_used = True
                            # Тот самый текст, который увидела модель. Метрики eval
                            # считаются по нему, а не по пересобранным из метаданных
                            # секциям — иначе оценка систематически смещена.
                            context_text = _rendered_context(
                                ctx.user_message, context_chars
                            )
                            # Attach a Confluence page url to any source whose vault
                            # path is a synced Confluence page (absent otherwise).
                            # Mutates the source dicts in place so the persisted
                            # history keeps the link.
                            for source in sources:
                                u = url_index.get(source.get("path"))
                                if u:
                                    source["url"] = u
                            yield format_sse(
                                "sources",
                                {"sources": sources, "context_chars": context_chars},
                            )
                            # [rules-only system] + [история без последнего вопроса]
                            # + [user-сообщение с источниками и тем же вопросом].
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
                        "chat %s: history trimmed, dropped %d message(s)",
                        chat_id,
                        dropped,
                    )

                stream_started = time.perf_counter()
                async for delta in gigachat.stream_chat(send, gcfg):
                    if "first_token" not in stages:
                        stages["first_token"] = _elapsed_ms(stream_started)
                    full_text += delta
                    yield format_sse("token", {"text": delta})
                stages["stream"] = _elapsed_ms(stream_started)

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
                yield format_sse(
                    "done", {"chat_id": chat_id, "finish_reason": finish_reason}
                )

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

                stages["total"] = _elapsed_ms(turn_started)
                answer_text, answer_cut = rag_log.truncate(full_text)
                context_logged, context_cut = rag_log.truncate(context_text)

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
                        # Волна 2: классификатор намерения + переписывание вопроса
                        # в самодостаточный. Вне RAG-режима остаются `None`.
                        "intent": intent,
                        "question_raw": question_raw,
                        "question_standalone": question_standalone,
                        # Кандидаты поиска ДО отбора ({id, path, chunk_index,
                        # score, rank}) и оценки батч-грейдера ({id, path,
                        # chunk_index, score}) — вход и выход волны-2 реранкинга.
                        # `id` общий: grades[m].id == candidates[k].id ⇒ тот же чанк.
                        "candidates": _linked_candidates(candidates, grades),
                        "grades": grades,
                        "sources": _log_sources(sources, candidates),
                        # Что именно увидела модель и что она ответила. Без этой
                        # пары правило диагностики («чанк был в контексте, но
                        # ответ неверен») проверить нечем.
                        "context_text": context_logged,
                        "context_chars": context_chars,
                        "context_truncated_in_log": context_cut,
                        "answer_text": answer_text,
                        "answer_chars": len(full_text),
                        "answer_truncated_in_log": answer_cut,
                        # `length` здесь = ответ обрезан лимитом модели; раньше
                        # вычислялось и выбрасывалось, обрыв был невидим.
                        "finish_reason": finish_reason,
                        "invalid_citations": invalid_citations,
                        "rag_used": rag_used,
                        "notice": notice,
                        "truncated": truncated,
                        "errored": errored,
                        # Действующие настройки хода — что должен повторить
                        # следующий прогон, чтобы дельта что-то значила.
                        "settings": rag_log.settings_snapshot(rcfg, giga_dict, prompts),
                        "timings_ms": dict(stages),
                    },
                )

    return StreamingResponse(
        generator(), media_type="text/event-stream", headers=_SSE_HEADERS
    )
