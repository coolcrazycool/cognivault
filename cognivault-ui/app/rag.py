"""Retrieval-augmented context assembly.

Given a user query and config, retrieve fragments from CogniVault and build two
messages: a **system** message carrying only the answering *rules*, and a final
**user** message carrying the numbered «Источники» block, a short reminder and
the question itself. Keeping the retrieved text in the last user turn (instead
of the system prompt) measurably improves instruction following and citation
discipline on long contexts.

The default ``mode == "auto"`` path performs *smart context expansion*: intent
routing + query condensing (:mod:`app.rag_pipeline`), hybrid retrieval, a batched
relevance grader, group-by-file, and a per-file decision between a bare chunk, the
section body (supplied by the backend's ``group_by_section`` search), or the whole
document — all under a character budget derived from the model's context window
and a hard cap on the number of blocks. The legacy ``semantic``/``context``
sources remain for backward compatibility.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from . import cognivault, rag_pipeline

# Order in which grouped ``/context`` buckets are flattened.
_CONTEXT_GROUP_ORDER = (
    "summary",
    "architecture",
    "adrs",
    "glossary",
    "implementation",
)

# Rules only — the retrieved text lives in the final user message (see
# `_render_context_message`), never here.
#
# Public name on purpose: the config API serves this text as the *default* the
# UI shows in the "prompts" editor, and a stored `None` means "keep using it",
# so later improvements here reach users who already saved their settings.
SYSTEM_PROMPT = """Ты — ассистент по базе знаний пользователя. Отвечаешь на вопросы строго на основе
предоставленных фрагментов документации.

Задачи:
- Отвечай только на основе информации из блока «Источники». Не используй собственные
  знания для фактических утверждений.
- После каждого фактического утверждения указывай источник в формате [Источник N].
  Используй только номера, которые есть в блоке «Источники». Не выдумывай источники.
- Если источники противоречат друг другу — приведи обе версии с указанием источников.
- Если ответа в источниках нет — напиши: «В доступных мне документах ответа на этот
  вопрос не нашлось» и кратко укажи смежную полезную информацию из источников, если она есть.
- Если источники отвечают лишь частично — дай частичный ответ и явно скажи, какой
  информации не хватает.
- В источниках встречаются markdown-таблицы: внимательно сопоставляй значения ячеек
  с заголовками их столбцов и строк.
- Отвечай на русском языке, кратко и по делу."""

# Repeated right before the question: the tail of a long context is the part the
# model attends to best. Public for the same reason as `SYSTEM_PROMPT`.
CONTEXT_REMINDER = """Напоминание: отвечай только по источникам выше, ставь [Источник N] после каждого
утверждения; если ответа в источниках нет — скажи об этом."""

# Backwards-compatible aliases (the private names predate the config API).
_SYSTEM_PROMPT = SYSTEM_PROMPT
_CONTEXT_REMINDER = CONTEXT_REMINDER

# Keys of the ``prompts`` config section, in the order the UI shows them.
PROMPT_KEYS = ("system", "context_reminder")

_RETRIEVAL_UNAVAILABLE = "Поиск по базе недоступен — отвечаю без контекста"

# Canned answer when the grader judged every candidate irrelevant: generating
# from noise is worse than an honest "no".
_NO_ANSWER = "В доступных мне документах ответа на этот вопрос не нашлось."

# Auto-mode internal retrieval width (independent of any stored `limit`): the
# grader re-ranks this many candidates down to `_MAX_CONTEXT_BLOCKS`.
#
# Wave 3 widened this 20 → 40: recall at the retrieval stage is the ceiling for
# everything downstream, and the grader is what makes a wider net safe. The cost
# is the grading stage, not the answer: 40 candidates are graded in batches of 12
# (`rag_pipeline._BATCH_SIZE`), i.e. FOUR grader calls instead of two — roughly
# double the cost of that stage, still one parallel wave of latency. The knob is
# editable from the UI (`rag.rerank_candidates`) if an install needs 20 back.
_RERANK_CANDIDATES = 40

# Intents that skip retrieval entirely — the model answers from the history.
_NO_RAG_INTENTS = ("smalltalk", "clarify")

# Hard cap on blocks in the context (expanded + bare combined). Beyond ~5 the
# tail is mostly noise that dilutes attention and invites wrong citations.
_MAX_CONTEXT_BLOCKS = 5

# Token reserves (see `_compute_budget`).
_HISTORY_RESERVE_TOKENS = 2000
_SYSTEM_RESERVE_TOKENS = 500
# Rough chars-per-token for Russian, with headroom.
_CHARS_PER_TOKEN = 2.0
_BUDGET_HEADROOM = 0.85


# --------------------------------------------------------------------------- #
# Result contract
# --------------------------------------------------------------------------- #


@dataclass
class RagContext:
    """Everything :func:`build_rag_context` hands back to the chat route.

    A dataclass rather than a tuple on purpose: every wave adds fields and a
    positional tuple would break callers silently. All fields are
    keyword-defaulted for the same reason.

    * ``system_message`` — rules-only system turn (``None`` when RAG produced
      nothing usable);
    * ``user_message`` — the final user turn: «Источники» → напоминание →
      вопрос. Always set together with ``system_message``;
    * ``sources`` — UI/citation metadata, ``n`` matching the block numbers,
      ``grade`` carrying the grader's 1..5 score (``None`` when not graded);
    * ``notice`` — user-visible reason RAG was skipped (retrieval failure);
    * ``context_chars`` — size of the rendered sources block, for telemetry;
    * ``intent`` — ``smalltalk`` / ``clarify`` / ``kb_question`` from the
      condense step; the first two mean retrieval was skipped on purpose;
    * ``standalone_question`` — the rewritten, self-contained question actually
      used for retrieval and for the final user turn;
    * ``candidates`` — every retrieved candidate BEFORE selection
      (``path``, ``chunk_index``, ``score``, ``rank``), for the query log;
    * ``grades`` — grader output (``id``, ``path``, ``chunk_index``, ``score``),
      ``None`` when grading was skipped;
    * ``answer_override`` — ready-made answer; the route must skip generation.
    """

    system_message: dict[str, Any] | None = None
    user_message: dict[str, Any] | None = None
    sources: list[dict[str, Any]] = field(default_factory=list)
    notice: str | None = None
    context_chars: int = 0
    intent: str | None = None
    standalone_question: str | None = None
    candidates: list[dict[str, Any]] | None = None
    grades: list[dict[str, Any]] | None = None
    answer_override: str | None = None


# --------------------------------------------------------------------------- #
# Normalisation
# --------------------------------------------------------------------------- #


def _norm_semantic(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalise ``search/{semantic,hybrid}`` results to the fragment shape.

    ``chunk_index`` and ``rank`` are carried through (the backend started
    emitting them) for the query log and later re-ranking; they are deliberately
    *not* copied into ``sources``, which stays a UI-facing shape.

    ``section_text`` and ``parent_id`` arrive only from a hybrid search issued
    with ``group_by_section=True``; both default to the empty string so the
    semantic fallback (and any older backend) normalises without a KeyError and
    simply degrades to bare chunk text downstream.
    """
    out: list[dict[str, Any]] = []
    for r in results:
        out.append(
            {
                "text": r.get("text", "") or "",
                "path": r.get("path", "") or "",
                "title": r.get("title") or r.get("path") or "",
                "section_path": r.get("section_path") or "",
                "score": r.get("score"),
                "chunk_index": r.get("chunk_index"),
                "rank": r.get("rank"),
                "section_text": r.get("section_text") or "",
                "parent_id": r.get("parent_id") or "",
            }
        )
    return out


def _norm_context(response: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten grouped ``/context`` buckets (in canonical order) to fragments."""
    out: list[dict[str, Any]] = []
    for group in _CONTEXT_GROUP_ORDER:
        items = response.get(group) or []
        if not isinstance(items, list):
            continue
        for item in items:
            source = item.get("source") or {}
            sections = source.get("sections") or []
            section_path = item.get("section") or (
                " > ".join(str(s) for s in sections) if sections else ""
            )
            out.append(
                {
                    "text": item.get("text", "") or "",
                    "path": source.get("path", "") or "",
                    "title": source.get("title") or source.get("path") or "",
                    "section_path": section_path or "",
                    "score": source.get("score"),
                }
            )
    return out


def _passes_min_score(score: Any, min_score: float | None) -> bool:
    if min_score is None:
        return True
    if not isinstance(score, (int, float)):
        return True  # can't filter what we can't compare
    return score >= min_score


# --------------------------------------------------------------------------- #
# Pure helpers (unit-tested)
# --------------------------------------------------------------------------- #

def _best_score(frags: list[dict[str, Any]]) -> float:
    scores = [
        f.get("score") for f in frags if isinstance(f.get("score"), (int, float))
    ]
    return max(scores) if scores else float("-inf")


def _group_by_path(
    fragments: list[dict[str, Any]],
) -> tuple[dict[str, list[dict[str, Any]]], list[str]]:
    """Group fragments by ``path``, preserving first-seen order."""
    groups: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    for f in fragments:
        p = f.get("path") or ""
        if p not in groups:
            groups[p] = []
            order.append(p)
        groups[p].append(f)
    return groups, order


def _compute_budget(rcfg: dict[str, Any], gcfg: dict[str, Any]) -> int:
    """Context char budget with Russian headroom.

    ``min(max_context_chars, (model_ctx - max_tokens - history - system) *
    chars_per_token * headroom)``.
    """
    max_context_chars = int(rcfg.get("max_context_chars", 24000))
    model_ctx = int(gcfg.get("model_context_tokens", 32768))
    max_tokens = int(gcfg.get("max_tokens", 4096))
    avail = model_ctx - max_tokens - _HISTORY_RESERVE_TOKENS - _SYSTEM_RESERVE_TOKENS
    computed = avail * _CHARS_PER_TOKEN * _BUDGET_HEADROOM
    return max(0, int(min(max_context_chars, computed)))


def _decide_file_depth(
    content_len: int, n_hits: int, file_full_chars: int, remaining_budget: int
) -> str:
    """Choose ``file`` vs ``section`` for an expanded document.

    * small file (``<= file_full_chars``) → whole file;
    * many hits (``>= 3``) AND the whole file still fits the remaining budget →
      whole file;
    * otherwise → section expansion.
    """
    if content_len <= file_full_chars:
        return "file"
    if n_hits >= 3 and content_len <= remaining_budget:
        return "file"
    return "section"


def _best_grade(frags: list[dict[str, Any]]) -> int | None:
    """Highest grader score among the fragments merged into one block."""
    grades = [f.get("grade") for f in frags if isinstance(f.get("grade"), int)]
    return max(grades) if grades else None


def _merge_chunk_text(frags: list[dict[str, Any]]) -> str:
    """Join the distinct chunk texts of one file into a single block."""
    seen: set[str] = set()
    parts: list[str] = []
    for f in frags:
        t = (f.get("text") or "").strip()
        if t and t not in seen:
            seen.add(t)
            parts.append(t)
    return "\n\n".join(parts)


# --------------------------------------------------------------------------- #
# Block rendering
# --------------------------------------------------------------------------- #


def _header(n: int, title: str, path: str, section_path: str) -> str:
    """Markdown heading of one context block.

    ``### Источник N: {title} — {path}[ > {section_path}]`` — the ``>`` tail is
    omitted entirely when the fragment has no section, so no dangling separator
    ever reaches the model.
    """
    header = f"### Источник {n}: {title} — {path}"
    if section_path:
        header += f" > {section_path}"
    return header


def _block(header: str, text: str) -> str:
    return f"{header}\n{text}\n\n"


def _resolve_prompt(prompts: dict[str, Any] | None, key: str, default: str) -> str:
    """Pick the user's override for ``key``, or the built-in default.

    A missing key, ``None``, a non-string value and an empty/whitespace-only
    string all mean *"use the default"*: the config stores ``None`` for "never
    customised", and a user who clears the field in the UI sends back an empty
    string — both must land on the shipped prompt so later improvements to it
    still reach them.
    """
    if not isinstance(prompts, dict):
        return default
    value = prompts.get(key)
    if not isinstance(value, str) or not value.strip():
        return default
    return value.strip()


def _render_context_message(
    blocks: list[str], query: str, reminder: str | None = None
) -> tuple[dict[str, Any], int]:
    """Render the final user turn from rendered ``blocks`` and the question.

    Order is load-bearing: sources first, then the reminder, then the question
    last — models follow the instruction closest to the end of the prompt.
    A custom ``reminder`` only replaces the text of the middle section; the
    section order and the «Источники:» / «Вопрос:» headers stay fixed.

    Returns ``(message, context_chars)`` where ``context_chars`` measures only
    the sources block (not the boilerplate).
    """
    context_block = "".join(blocks).rstrip()
    text = reminder if reminder is not None else CONTEXT_REMINDER
    content = f"Источники:\n\n{context_block}\n\n{text}\n\nВопрос: {query}"
    return {"role": "user", "content": content}, len(context_block)


def _system_message(prompt: str | None = None) -> dict[str, Any]:
    """Rules-only system turn (no retrieved text).

    ``prompt`` is the user's override; ``None`` means the built-in
    :data:`SYSTEM_PROMPT`.
    """
    return {
        "role": "system",
        "content": prompt if prompt is not None else SYSTEM_PROMPT,
    }


# --------------------------------------------------------------------------- #
# Auto pipeline
# --------------------------------------------------------------------------- #


async def _build_auto(
    query: str,
    rcfg: dict[str, Any],
    gcfg: dict[str, Any],
    messages: list[dict[str, Any]] | None,
    cv: dict[str, Any] | None,
    prompts: dict[str, Any] | None = None,
) -> RagContext:
    min_score = rcfg.get("min_score")
    file_full_chars = int(rcfg.get("file_full_chars", 6000))
    section_max_chars = int(rcfg.get("section_max_chars", 4000))
    max_expanded_files = int(rcfg.get("max_expanded_files", 2))
    limit = int(rcfg.get("rerank_candidates", _RERANK_CANDIDATES))
    budget = _compute_budget(rcfg, gcfg)

    # 0. Hidden call 1: route the turn and rewrite it into a standalone query.
    intent, rq = await rag_pipeline.condense(query, messages, rcfg, gcfg)
    if intent in _NO_RAG_INTENTS:
        # Chit-chat / "say that again": no retrieval, the model answers from
        # the untouched history.
        return RagContext(intent=intent, standalone_question=rq)

    # 1. Retrieve with hybrid search, graceful fallback to semantic.
    #
    # `group_by_section` makes the backend deduplicate hits by section and return
    # the full section body (`section_text`, capped server-side at
    # `section_max_chars`) alongside each chunk — the index knows the true section
    # boundaries, which beats re-deriving them from the rendered document here.
    # The semantic fallback returns neither field; `add_sections` degrades to the
    # bare chunk in that case.
    try:
        try:
            raw = await cognivault.hybrid_search(
                rq,
                limit,
                cv=cv,
                group_by_section=True,
                section_max_chars=section_max_chars,
            )
        except Exception:  # noqa: BLE001 — hybrid missing/404 => semantic fallback
            raw = await cognivault.semantic_search(rq, limit, cv=cv)
    except Exception:  # noqa: BLE001 — any retrieval failure => graceful fallback
        return RagContext(
            notice=_RETRIEVAL_UNAVAILABLE, intent=intent, standalone_question=rq
        )

    fragments = _norm_semantic(raw.get("results") or [])
    fragments = [
        f for f in fragments if _passes_min_score(f.get("score"), min_score)
    ]
    if not fragments:
        return RagContext(intent=intent, standalone_question=rq)

    candidates = [
        {
            "path": f.get("path", ""),
            "chunk_index": f.get("chunk_index"),
            "score": f.get("score"),
            "rank": f.get("rank"),
        }
        for f in fragments
    ]

    # 1b. Hidden call 2: grade every candidate, then select. Runs BEFORE
    # grouping and smart expansion so whole-file/section expansion only ever
    # happens for fragments the judge kept.
    grade_list = await rag_pipeline.grade(rq, fragments, rcfg, gcfg)
    for f, g in zip(fragments, grade_list):
        f["grade"] = g
    graded = any(g is not None for g in grade_list)
    grades_meta: list[dict[str, Any]] | None = (
        [
            {
                "id": i + 1,
                "path": c["path"],
                "chunk_index": c["chunk_index"],
                "score": g,
            }
            for i, (c, g) in enumerate(zip(candidates, grade_list))
        ]
        if graded
        else None
    )

    fragments, refused = rag_pipeline.select(fragments, grade_list, rcfg)
    if refused:
        return RagContext(
            intent=intent,
            standalone_question=rq,
            candidates=candidates,
            grades=grades_meta,
            answer_override=_NO_ANSWER,
        )

    # 2-4. Group by file, rank files by their best hit: the grader's verdict
    # first (it re-ranks), the raw cosine score only as a tie-break / when the
    # grader was skipped.
    groups, order = _group_by_path(fragments)

    def _file_rank(p: str) -> tuple[float, float]:
        grade = _best_grade(groups[p])
        return (float(grade) if grade is not None else 0.0, _best_score(groups[p]))

    ranked = sorted(order, key=_file_rank, reverse=True)
    expanded_paths = ranked[:max_expanded_files]
    bare_paths = ranked[max_expanded_files:]

    # Fetch full content for the top files (bare-chunk fallback on error).
    contents: dict[str, str | None] = {}
    for p in expanded_paths:
        try:
            contents[p] = await cognivault.content(p, cv=cv)
        except Exception:  # noqa: BLE001 — missing content => bare chunks
            contents[p] = None

    blocks: list[str] = []
    sources: list[dict[str, Any]] = []
    used = 0
    n = 0
    seen: set[tuple[str, str]] = set()

    def add(
        title: str,
        path: str,
        section_path: str,
        score: Any,
        text: str,
        depth: str,
        grade: int | None,
    ) -> bool:
        nonlocal used, n
        if n >= _MAX_CONTEXT_BLOCKS:
            return False
        candidate_n = n + 1
        block = _block(_header(candidate_n, title, path, section_path), text)
        if blocks and used + len(block) > budget:
            return False
        n = candidate_n
        blocks.append(block)
        used += len(block)
        sources.append(
            {
                "n": n,
                "title": title,
                "path": path,
                "section_path": section_path,
                "score": score,
                "depth": depth,
                "grade": grade,
            }
        )
        return True

    def add_sections(frags: list[dict[str, Any]], title: str, path: str) -> None:
        """Add one block per fragment, preferring the backend's section body.

        ``section_text`` comes from the hybrid search (``group_by_section=True``)
        and is already capped at ``section_max_chars`` upstream. When it is empty
        — semantic fallback, an older backend, or a section whose text the index
        does not have — the bare chunk is used instead and the block is labelled
        ``depth="chunk"``. No ``content`` is needed here any more; the whole-file
        branch still fetches it via :func:`cognivault.content`.
        """
        for f in frags:
            sp = f.get("section_path") or ""
            section_text = (f.get("section_text") or "").strip()
            if section_text:
                depth, text = "section", section_text
            else:
                depth, text = "chunk", (f.get("text") or "")
            key = (path, text)
            if not text or key in seen:
                continue
            grade = f.get("grade") if isinstance(f.get("grade"), int) else None
            if not add(title, path, sp, f.get("score"), text, depth, grade):
                break
            seen.add(key)

    # 5-7. Expanded files first (already score-ranked).
    for p in expanded_paths:
        if n >= _MAX_CONTEXT_BLOCKS:
            break
        frags = groups[p]
        title = frags[0].get("title") or p
        best = _best_score(frags)
        best_grade = _best_grade(frags)
        content = contents.get(p)
        if content is None:
            add(title, p, "", best, _merge_chunk_text(frags), "chunk", best_grade)
            continue
        remaining = budget - used
        depth = _decide_file_depth(len(content), len(frags), file_full_chars, remaining)
        if depth == "file":
            block_len = len(_block(_header(n + 1, title, p, ""), content))
            if blocks and used + block_len > budget:
                # Never partially cut a whole file — downgrade to its section.
                add_sections(frags, title, p)
            else:
                add(title, p, "", best, content, "file", best_grade)
        else:
            add_sections(frags, title, p)

    # Remaining files stay as bare (merged) chunks — capped by `_MAX_CONTEXT_BLOCKS`
    # as well as by the char budget, so a long tail cannot dilute the context.
    for p in bare_paths:
        frags = groups[p]
        title = frags[0].get("title") or p
        best = _best_score(frags)
        sp = frags[0].get("section_path") or ""
        text = _merge_chunk_text(frags)
        if not add(title, p, sp, best, text, "chunk", _best_grade(frags)):
            break

    if not sources:
        return RagContext(
            intent=intent,
            standalone_question=rq,
            candidates=candidates,
            grades=grades_meta,
        )

    user_message, context_chars = _render_context_message(
        blocks, rq, _resolve_prompt(prompts, "context_reminder", CONTEXT_REMINDER)
    )
    return RagContext(
        system_message=_system_message(
            _resolve_prompt(prompts, "system", SYSTEM_PROMPT)
        ),
        user_message=user_message,
        sources=sources,
        context_chars=context_chars,
        intent=intent,
        standalone_question=rq,
        candidates=candidates,
        grades=grades_meta,
    )


# --------------------------------------------------------------------------- #
# Legacy pipeline (semantic / context, flat chunks)
# --------------------------------------------------------------------------- #


async def _build_legacy(
    query: str,
    rcfg: dict[str, Any],
    cv: dict[str, Any] | None,
    prompts: dict[str, Any] | None = None,
) -> RagContext:
    source = str(rcfg.get("source", "semantic"))
    limit = int(rcfg.get("limit", 5))
    token_budget = int(rcfg.get("token_budget", 3000))
    min_score = rcfg.get("min_score")
    max_chars = int(rcfg.get("max_context_chars", 12000))

    try:
        if source == "context":
            raw = await cognivault.context(query, token_budget, min_score, cv=cv)
            fragments = _norm_context(raw)
        elif source == "hybrid":
            raw = await cognivault.hybrid_search(query, limit, cv=cv)
            fragments = _norm_semantic(raw.get("results") or [])
        else:
            raw = await cognivault.semantic_search(query, limit, cv=cv)
            fragments = _norm_semantic(raw.get("results") or [])
    except Exception:  # noqa: BLE001 — any retrieval failure => graceful fallback
        return RagContext(notice=_RETRIEVAL_UNAVAILABLE)

    fragments = [
        f for f in fragments if _passes_min_score(f.get("score"), min_score)
    ]
    if not fragments:
        return RagContext()

    blocks: list[str] = []
    sources: list[dict[str, Any]] = []
    total = 0
    n = 0
    for frag in fragments:
        if n >= _MAX_CONTEXT_BLOCKS:
            break
        n += 1
        title = frag.get("title") or frag.get("path") or ""
        path = frag.get("path") or ""
        section_path = frag.get("section_path") or ""
        block = _block(_header(n, title, path, section_path), frag.get("text", ""))
        if total + len(block) > max_chars and blocks:
            n -= 1
            break
        blocks.append(block)
        total += len(block)
        sources.append(
            {
                "n": n,
                "title": title,
                "path": path,
                "section_path": section_path,
                "score": frag.get("score"),
                "depth": "chunk",
                # Legacy modes never run the grader — keep the shape uniform.
                "grade": None,
            }
        )

    if not sources:
        return RagContext()

    user_message, context_chars = _render_context_message(
        blocks, query, _resolve_prompt(prompts, "context_reminder", CONTEXT_REMINDER)
    )
    return RagContext(
        system_message=_system_message(
            _resolve_prompt(prompts, "system", SYSTEM_PROMPT)
        ),
        user_message=user_message,
        sources=sources,
        context_chars=context_chars,
    )


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


async def build_rag_context(
    query: str,
    rcfg: dict[str, Any],
    cvcfg: dict[str, Any] | None,
    gcfg: dict[str, Any] | None = None,
    messages: list[dict[str, Any]] | None = None,
    prompts: dict[str, Any] | None = None,
) -> RagContext:
    """Assemble the RAG messages + sources for ``query``.

    Returns a :class:`RagContext`. ``system_message`` and ``user_message`` are
    either both set (RAG applies) or both ``None``; in the latter case
    ``notice`` explains a retrieval failure, ``intent`` explains a deliberate
    skip (``smalltalk``/``clarify``), ``answer_override`` carries the canned
    refusal when the grader rejected every candidate, and all three being
    ``None`` means retrieval simply found nothing. In ``mode == "auto"`` (the
    default) this runs condense → retrieve → grade → select → smart expansion
    using its own internals regardless of any stale stored ``source``/``limit``.

    ``messages`` is the outgoing chat history; it feeds the condense call (which
    is skipped when the history is empty).

    ``cvcfg`` is the CogniVault call context threaded into *every* upstream
    request: in server mode it is the per-request ``{"base_url", "token"}``; in
    local mode it is ``None``, meaning "read the config file" (historical
    behaviour). Passing it through fixes the latent bug where the retrieval
    sub-builders re-read the file instead of honouring the caller's context.

    ``prompts`` is the user's ``{"system": ..., "context_reminder": ...}`` config
    section (pass it by name — the positional part of this signature is frozen).
    A missing key, ``None`` or a blank string falls back to :data:`SYSTEM_PROMPT`
    / :data:`CONTEXT_REMINDER`, so an untouched (or cleared) setting keeps
    tracking the shipped prompt.
    """
    mode = str(rcfg.get("mode", "auto"))
    if mode == "auto":
        return await _build_auto(query, rcfg, gcfg or {}, messages, cvcfg, prompts)
    return await _build_legacy(query, rcfg, cvcfg, prompts)
