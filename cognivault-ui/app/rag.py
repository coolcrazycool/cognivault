"""Retrieval-augmented context assembly.

Given a user query and config, retrieve fragments from CogniVault and build two
messages: a **system** message carrying only the answering *rules*, and a final
**user** message carrying the corpus footprint (:mod:`app.corpus_map`), the
numbered «Источники» block, a short reminder and the question itself. Keeping
the retrieved text in the last user turn (instead of the system prompt)
measurably improves instruction following and citation discipline on long
contexts.

The default ``mode == "auto"`` path performs *smart context expansion*: intent
routing + query condensing (:mod:`app.rag_pipeline`), hybrid retrieval, a batched
relevance grader, group-by-file, and a per-file decision between a bare chunk, the
section body (supplied by the backend's ``group_by_section`` search), or the whole
document — all under a character budget derived from the model's context window
and a hard cap on the number of blocks. The legacy ``semantic``/``context``
sources remain for backward compatibility.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable

from . import cognivault, corpus_map, corpus_scope, corpus_tree, rag_pipeline
from .tokens import CHARS_PER_TOKEN, estimate_messages_tokens

log = logging.getLogger("cognivault-ui.rag")

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

# System turn for the branches that deliberately skip retrieval
# (`_NO_RAG_INTENTS`). Without it the chat route would send the model a *bare*
# history: a real knowledge-base question misrouted to `smalltalk` would then be
# answered from the model's parametric memory — indistinguishable from a normal
# answer and without a single source. Short on purpose: these turns are
# greetings and "say that again", not retrieval.
NO_RAG_SYSTEM_PROMPT = """Ты — ассистент по базе знаний пользователя. Для этой реплики поиск по базе НЕ
выполнялся, источников нет.

- Отвечай только по истории диалога выше: приветствие, благодарность, просьба
  переформулировать или повторить уже сказанное.
- Не сообщай фактических утверждений из собственных знаний — ничего, чего нет в
  истории диалога.
- Если для ответа нужен поиск по базе знаний — прямо скажи об этом и попроси
  задать вопрос отдельной репликой.
- Отвечай на русском языке, кратко и по делу."""

# System turn for a question about the base ITSELF — «что ты знаешь?», «о чём
# эта база?» — recognised deterministically by `corpus_scope.match_meta`.
#
# It cannot be `NO_RAG_SYSTEM_PROMPT`: that one forbids stating anything absent
# from the dialogue history, which forbids describing the assistant's own scope
# — exactly the answer being asked for. It cannot be `SYSTEM_PROMPT` either:
# there is no «Источники» block to answer from and no [Источник N] to cite.
#
# Deliberately NOT user-editable. A new editable prompt key would have to be
# registered in four places and would then be frozen for anyone who saves it —
# while this text's whole job is to keep an ungrounded answer from being
# generated. The material it points at (the tree) IS configurable, by the vault.
META_SYSTEM_PROMPT = """Ты — ассистент по базе знаний пользователя. Этот вопрос — о том, что вообще есть
в базе, а не о содержании конкретного документа. Поиск по документам для него не
выполнялся: вместо блока «Источники» ниже дана структура базы — реальные названия
разделов и число документов в каждом.

- Ответь по структуре ниже: какого объёма база, из каких разделов состоит и что
  в них лежит.
- Опирайся ТОЛЬКО на эту структуру. Не придумывай разделов, продуктов и
  документов, которых в ней нет.
- Это названия страниц и папок, а не пересказ их содержимого: не утверждай, что
  написано внутри раздела — только что такой раздел есть и сколько в нём
  документов.
- Не ставь [Источник N]: в этом ходе источников нет.
- В конце предложи задать конкретный вопрос по нужному разделу — тогда будет
  выполнен поиск по документам.
- Отвечай на русском языке, кратко и по делу."""

# System turn for the OTHER meta family: a question about the assistant itself —
# «кто ты?», «что ты умеешь?», «всегда ли ответ в Markdown с заголовками?».
#
# `META_SYSTEM_PROMPT` cannot answer these: it orders the model to rely ONLY on
# the section tree, and the tree says nothing about the assistant's own output.
# That is why `x23-meta` of the acceptance set — reclassified by the customer
# from "trap" to "must be answered" — still ended in the grader's refusal: a
# question about how the service behaves has no answering document in any vault
# and never will.
#
# The material under this prompt is `_operating_rules()` — the configuration in
# force, not a story about it — plus the section tree when it is available. The
# ban on inventing corpus facts is unchanged and repeated here: the assistant may
# describe ITSELF freely because it is looking at its own rules, and may say
# about the base only what the structure block shows.
META_SELF_SYSTEM_PROMPT = """Ты — ассистент по базе знаний пользователя. Этот вопрос — о тебе самом: кто ты,
что умеешь и как работаешь. Поиск по документам для него не выполнялся.

- Ниже даны ТВОИ рабочие правила и — если она доступна — структура базы знаний.
  Отвечай только по ним.
- О себе отвечай по блоку «Как ты работаешь»: это описание твоей действующей
  конфигурации. Не приписывай себе возможностей, которых в нём нет, и не
  отказывайся отвечать на вопрос о себе — материал для ответа перед тобой.
- О содержимом базы говори только то, что видно в структуре: названия разделов
  и число документов. Не придумывай разделов, продуктов и документов, которых в
  ней нет, и не суди по названию страницы о том, что написано внутри.
- Не ставь [Источник N]: в этом ходе источников нет.
- В конце предложи задать конкретный вопрос по базе — тогда будет выполнен
  поиск по документам.
- Отвечай на русском языке, кратко и по делу."""

# The code-owned half of `_operating_rules()`: what is true of every turn of this
# service regardless of any stored prompt. Every claim here is a property of the
# code — the pipeline is `_build_auto`, the refusal text is `_NO_ANSWER`, and the
# markdown subset is exactly what `static/app.js:renderMarkdown` parses. A claim
# that depends on the user's prompt does NOT belong here; it comes from the
# effective prompt text instead (see `_operating_rules`).
_PIPELINE_RULES = """Порядок работы над обычным вопросом:
- по вопросу выполняется гибридный поиск (смысловой + лексический) по
  проиндексированной базе знаний;
- найденные фрагменты оценивает отдельная проверка релевантности, нерелевантные
  отбрасываются;
- если релевантных фрагментов не осталось, ответ ровно один: «В доступных мне
  документах ответа на этот вопрос не нашлось»;
- ответ отдаётся в интерфейс потоком, по мере генерации.
Разметка ответа: интерфейс показывает ответ как Markdown и разбирает заголовки
(«###»), маркированные и нумерованные списки, **жирный**, `код`, блоки кода и
ссылки вида [текст](адрес); Markdown-таблицы интерфейс НЕ разбирает. Разметка не
обязательна: короткий ответ остаётся обычным абзацем, заголовки появляются
только там, где ответ длинный и делится на части.
Этот ход — исключение из порядка выше: поиск по документам для него не
выполнялся."""

_OPERATING_RULES_CAPTION = (
    "Как ты работаешь — твоя действующая конфигурация. Это НЕ документ из базы "
    "знаний и не её содержимое: ссылаться на этот блок как [Источник N] нельзя."
)

_ANSWER_RULES_CAPTION = (
    "Правила, по которым ты отвечаешь на вопросы по базе знаний (действующий "
    "текст, включая изменения, сохранённые пользователем):"
)

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

# Intent recorded for a turn routed by `corpus_scope.match_meta`. Not part of the
# condense taxonomy (`rag_pipeline._INTENTS`) — the model never emits it; it is
# assigned by code, and the query log needs it to be distinguishable from a
# `kb_question` that happened to find nothing.
_META_INTENT = "meta"

# Hard cap on blocks in the context (expanded + bare combined). Beyond ~5 the
# tail is mostly noise that dilutes attention and invites wrong citations.
_MAX_CONTEXT_BLOCKS = 5

# Token reserves (see `_compute_budget`). The history reserve is only the
# fallback used when the caller passed no history — otherwise it is measured.
_HISTORY_RESERVE_TOKENS = 2000
_SYSTEM_RESERVE_TOKENS = 500
# Chars-per-token comes from `app.tokens` — one constant for the whole project.
_CHARS_PER_TOKEN = CHARS_PER_TOKEN
_BUDGET_HEADROOM = 0.85

# Marker inserted between two chunks of one file that are NOT adjacent in the
# source document, so the model cannot read the join as continuous prose.
_CHUNK_GAP_MARKER = "[…]"


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
      nothing usable). Also set — with :data:`NO_RAG_SYSTEM_PROMPT` and *without*
      a ``user_message`` — on the deliberate no-retrieval intents, so a
      misrouted turn still cannot be answered from the model's own knowledge;
    * ``user_message`` — the final user turn: [состав базы] → «Источники» →
      напоминание → вопрос. Set only when there is a sources block; a
      ``user_message`` always implies a ``system_message``, but not the other
      way round. The leading footprint block (:mod:`app.corpus_map`) is absent
      whenever the vault listing was unavailable;
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
    * ``answer_override`` — ready-made answer; the route must skip generation;
    * ``scope`` — ``document`` / ``corpus`` from the condense step (see
      :mod:`app.corpus_scope`); ``document`` whenever the model did not say;
    * ``hedge`` — the evidence-concentration caveat, appended to the generated
      answer by the route. ``None`` on all but a corpus-wide question whose
      fragments collapsed to one document. It QUALIFIES the answer; it never
      replaces one, and it is never the refusal (that is the grader's alone).
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
    scope: str = corpus_scope.DEFAULT_SCOPE
    hedge: str | None = None


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

    ``content_kind`` (``'text'`` / ``'table_rows'`` / …) lets the grader preview
    treat tabular chunks differently; an older backend does not send it and the
    empty string means "unknown" — every consumer must degrade to the plain-text
    behaviour then.
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
                "content_kind": r.get("content_kind") or "",
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


def _history_reserve_tokens(
    messages: list[dict[str, Any]] | None, model_ctx: int
) -> int:
    """Tokens to hold back for the dialogue history.

    Measured from the actual outgoing history when the caller passed one — the
    estimator already exists, so a flat 2000 was either wasteful (first turn) or
    wishful (long thread). ``None`` (no history supplied) keeps the old flat
    reserve. Capped at half the window: the chat route trims the history to fit
    anyway, so reserving more than that would only starve the context block.
    """
    if messages is None:
        measured = _HISTORY_RESERVE_TOKENS
    else:
        measured = estimate_messages_tokens(messages)
    return max(0, min(measured, model_ctx // 2))


def _compute_budget(
    rcfg: dict[str, Any],
    gcfg: dict[str, Any],
    messages: list[dict[str, Any]] | None = None,
) -> int:
    """Context char budget with Russian headroom.

    ``min(max_context_chars, (model_ctx - max_tokens - history - system) *
    chars_per_token * headroom)``, where ``chars_per_token`` is the project-wide
    :data:`app.tokens.CHARS_PER_TOKEN` and ``history`` is measured from
    ``messages`` (see :func:`_history_reserve_tokens`).
    """
    max_context_chars = int(rcfg.get("max_context_chars", 24000))
    model_ctx = int(gcfg.get("model_context_tokens", 32768))
    max_tokens = int(gcfg.get("max_tokens", 4096))
    history = _history_reserve_tokens(messages, model_ctx)
    avail = model_ctx - max_tokens - history - _SYSTEM_RESERVE_TOKENS
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
    """Join the distinct chunk texts of one file into a single block.

    Chunks of one file are rendered as ONE numbered source, so a bare ``\\n\\n``
    join lets the model read two fragments from opposite ends of the document as
    continuous prose (and cite them as one statement). Non-adjacent chunks are
    therefore separated by :data:`_CHUNK_GAP_MARKER`; only chunks whose
    ``chunk_index`` values are consecutive are joined silently. A missing
    ``chunk_index`` counts as "adjacency unknown" → marker.
    """
    seen: set[str] = set()
    parts: list[tuple[int | None, str]] = []
    for f in frags:
        t = (f.get("text") or "").strip()
        if not t or t in seen:
            continue
        seen.add(t)
        idx = f.get("chunk_index")
        parts.append((idx if isinstance(idx, int) else None, t))

    out: list[str] = []
    prev: int | None = None
    for i, (idx, text) in enumerate(parts):
        if i and not (prev is not None and idx is not None and idx == prev + 1):
            out.append(_CHUNK_GAP_MARKER)
        out.append(text)
        prev = idx
    return "\n\n".join(out)


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
    blocks: list[str],
    query: str,
    reminder: str | None = None,
    corpus: str | None = None,
) -> tuple[dict[str, Any], int]:
    """Render the final user turn from rendered ``blocks`` and the question.

    Order is load-bearing: the corpus footprint first, then the sources, then
    the reminder, then the question last — models follow the instruction
    closest to the end of the prompt, so the reminder keeps the tail and the
    footprint takes the head. A custom ``reminder`` only replaces the text of
    that middle section; the section order and the «Источники:» / «Вопрос:»
    headers stay fixed.

    ``corpus`` is the structural head block — the section tree
    (:mod:`app.corpus_tree`) or the footprint (:mod:`app.corpus_map`), see
    :func:`_head_block`; ``None`` when neither was available, and then this
    renders exactly what it always did. It sits ABOVE «Источники:» on purpose:
    the model has to read "127 documents" and "here are 5 fragments" as one
    statement, so the two cannot be separated by the whole dialogue history.
    Its size is deliberately outside ``context_chars`` and outside the budget the
    source blocks were selected under — it is added after selection and can
    therefore never cost a fragment its place.

    Returns ``(message, context_chars)`` where ``context_chars`` measures only
    the sources block (not the boilerplate, not the footprint).
    """
    context_block = "".join(blocks).rstrip()
    text = reminder if reminder is not None else CONTEXT_REMINDER
    head = f"{corpus}\n\n" if corpus else ""
    content = f"{head}Источники:\n\n{context_block}\n\n{text}\n\nВопрос: {query}"
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
# Meta branch — a question about the base itself
# --------------------------------------------------------------------------- #


async def _head_block(
    rcfg: dict[str, Any], cv: dict[str, Any] | None, n_sources: int | None
) -> str | None:
    """The structural block that opens the final user turn, or ``None``.

    Two renderings of the same fact, one slot. With ``rag.corpus_tree_enabled``
    on and a reachable catalogue it is the full section tree
    (:mod:`app.corpus_tree`) — every indexed document by name, marked where the
    names hide something; otherwise it is the constant-size footprint
    (:mod:`app.corpus_map`), which is what every install had before this flag.

    They are alternatives rather than neighbours because the tree is a superset:
    it carries the same "N documents, you were given K fragments" sentence, and
    rendering both would spend ~700 characters restating a shorter, coarser fold
    of a list already printed in full below it.

    What this block is NOT is a source. It is added to the message AFTER the
    «Источники» block has been selected and rendered under its own budget, so it
    can neither displace a retrieved fragment nor shrink one, and a turn the
    grader refused never gets here at all.
    """
    if corpus_tree.enabled(rcfg):
        tree = await corpus_tree.tree_block(cv, n_sources)
        if tree:
            return tree
    return await corpus_map.corpus_block(cv, n_sources)


def _operating_rules(prompts: dict[str, Any] | None) -> str:
    """The assistant's own rules, as material a meta turn can answer FROM.

    Two halves, and the split is the point. :data:`_PIPELINE_RULES` is
    code-owned: retrieval, the relevance check, the one refusal sentence and the
    markdown subset the UI actually parses are properties of this repository and
    are true whatever anyone stored in their config. The other half is the
    EFFECTIVE answering prompt — quoted, not applied — because "how do you
    answer" has a different true answer for a user who rewrote it, and a frozen
    code copy of the shipped text would describe a service they are not running.

    Quoting is not applying: the prompt travels inside the user message as
    labelled material, while the system turn stays
    :data:`META_SELF_SYSTEM_PROMPT`. A stored ruleset that orders the model to
    answer only from «Источники» therefore cannot turn this turn into a refusal
    — which is exactly why the meta branch stopped applying it in the first
    place.
    """
    return "\n".join(
        (
            _OPERATING_RULES_CAPTION,
            _ANSWER_RULES_CAPTION,
            _resolve_prompt(prompts, "system", SYSTEM_PROMPT),
            _PIPELINE_RULES,
        )
    )


async def _structure_block(
    rcfg: dict[str, Any], cv: dict[str, Any] | None
) -> str | None:
    """The richest structure available for a meta turn, or ``None``.

    The catalogue tree when ``rag.corpus_tree_enabled`` is on and the catalogue
    answers; the folded listing otherwise; ``None`` when neither is reachable.
    """
    if corpus_tree.enabled(rcfg):
        tree = await corpus_tree.overview_block(cv)
        if tree:
            return tree
    return await corpus_map.overview_block(cv)


async def _build_meta(
    query: str,
    kind: str,
    rcfg: dict[str, Any],
    cv: dict[str, Any] | None,
    prompts: dict[str, Any] | None = None,
) -> RagContext | None:
    """Context for a recognised meta question, or ``None`` to fall through.

    No model call, no retrieval, no sources: the message is the material plus
    the question. The user's ``prompts.system`` is not applied as the system turn
    on purpose — it is the ruleset for answering from «Источники», and this turn
    has none; applying it would order the model to refuse.

    The two families differ in material, which is what makes the distinction
    load-bearing rather than a word in a log line:

    * ``corpus`` («о чём эта база?») is answered from the STRUCTURE alone. With
      no structure there is nothing grounded to say, so this family fails closed
      — ``None``, and the caller routes the turn exactly as it did before:
      retrieval, grader, and the grader's refusal if the base really has
      nothing. Generating the shape of a base from the model's imagination is
      the one outcome worse than a refusal.
    * ``assistant`` («кто ты?», «всегда ли ответ в Markdown?») is answered from
      the assistant's OWN rules (:func:`_operating_rules`), with the structure
      appended when it is available. This family never falls through: the
      material is code-owned and cannot go missing, and falling through would
      send a question about the service into a retrieval that has no answering
      document anywhere — i.e. straight back into the refusal this branch
      exists to remove.
    """
    structure = await _structure_block(rcfg, cv)
    if kind == corpus_scope.META_CORPUS:
        if not structure:
            log.info(
                "meta-вопрос (%s) распознан, но структура базы недоступна — "
                "ход идёт обычным путём",
                kind,
            )
            return None
        blocks = [structure]
        system = META_SYSTEM_PROMPT
    else:
        blocks = [_operating_rules(prompts)]
        if structure:
            blocks.append(structure)
        else:
            log.info(
                "meta-вопрос (%s): структура базы недоступна, отвечаем только "
                "по собственным правилам",
                kind,
            )
        system = META_SELF_SYSTEM_PROMPT
    body = "\n\n".join(blocks)
    return RagContext(
        system_message=_system_message(system),
        user_message={
            "role": "user",
            "content": f"{body}\n\nВопрос: {query}",
        },
        intent=_META_INTENT,
        standalone_question=query,
        scope=corpus_scope.CORPUS_SCOPE,
    )


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
    budget = _compute_budget(rcfg, gcfg, messages)

    # 0a. A question about the base itself, recognised by anchored patterns —
    # zero model calls, and therefore the only step that works on the FIRST turn,
    # where condense is skipped for want of a history. That is not an
    # optimisation: «что ты знаешь?» is almost always the opening message.
    #
    # This branch does not weaken the refusal. The grader refuses when the base
    # has no answer to a question about its CONTENT; this question is about the
    # base's shape, which no document in it was ever going to contain, and the
    # answer is built from the real tree rather than generated freely.
    meta_kind = corpus_scope.match_meta(query)
    if meta_kind:
        meta = await _build_meta(query, meta_kind, rcfg, cv, prompts)
        if meta is not None:
            return meta

    # 0b. Hidden call 1: route the turn and rewrite it into a standalone query.
    intent, rq, scope = await rag_pipeline.condense(query, messages, rcfg, gcfg)
    if intent in _NO_RAG_INTENTS:
        # Chit-chat / "say that again": no retrieval, the model answers from the
        # untouched history — but NOT without rules. A misrouted knowledge-base
        # question would otherwise be answered from parametric memory, so these
        # branches still carry a system turn that forbids exactly that.
        # `user_message` stays `None`: there is no «Источники» block to build.
        return RagContext(
            system_message=_system_message(NO_RAG_SYSTEM_PROMPT),
            intent=intent,
            standalone_question=rq,
            scope=scope,
        )

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
            notice=_RETRIEVAL_UNAVAILABLE,
            intent=intent,
            standalone_question=rq,
            scope=scope,
        )

    fragments = _norm_semantic(raw.get("results") or [])
    fragments = [
        f for f in fragments if _passes_min_score(f.get("score"), min_score)
    ]
    if not fragments:
        return RagContext(intent=intent, standalone_question=rq, scope=scope)

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
            scope=scope,
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
            scope=scope,
        )

    # Structural head block — the section tree, or the footprint. Fetched only
    # now, so a turn that ended in a refusal or found nothing never pays for it.
    # Cached per vault; `None` on any failure, and then the message is exactly
    # what it was before either feature existed.
    corpus = await _head_block(rcfg, cv, len(sources))

    # Evidence-concentration caveat. Pure Python, zero tokens, and — because
    # `scope` is `document` unless the model explicitly said otherwise — it
    # cannot fire on a question about one document, which is what the whole
    # control group of 56 enumerations is. Both lookups read the listing cache
    # the head block just filled, so they cost no request: the count is the
    # denominator of the caveat, the container set is what keeps it off the
    # section-index pages that answer a corpus-scoped question completely.
    hedge_text = (
        corpus_scope.hedge(
            scope,
            sources,
            await corpus_map.document_count(cv),
            await corpus_map.container_paths(cv),
        )
        if scope == corpus_scope.CORPUS_SCOPE
        else None
    )

    user_message, context_chars = _render_context_message(
        blocks,
        rq,
        _resolve_prompt(prompts, "context_reminder", CONTEXT_REMINDER),
        corpus,
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
        scope=scope,
        hedge=hedge_text,
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

    corpus = await _head_block(rcfg, cv, len(sources))
    user_message, context_chars = _render_context_message(
        blocks,
        query,
        _resolve_prompt(prompts, "context_reminder", CONTEXT_REMINDER),
        corpus,
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

    Returns a :class:`RagContext`. A ``user_message`` always comes with a
    ``system_message`` (RAG applies); the deliberate no-retrieval intents
    (``smalltalk``/``clarify``) return a ``system_message`` alone — the
    no-sources ruleset — and everything else returns neither.

    One branch runs before any of that: a question recognised by
    :func:`app.corpus_scope.match_meta` as being about the base itself is
    answered from the rendered section tree (``intent="meta"``, no sources, no
    model calls before generation). It falls through to the normal path when the
    vault listing is unavailable — and, by construction, for anything the narrow
    pattern list does not match. In that last case
    ``notice`` explains a retrieval failure, ``answer_override`` carries the
    canned refusal when the grader graded every candidate and rejected them all
    (the rank insurance does not override a total refusal — an invented answer
    costs more than an honest "not found"), and both being ``None`` means
    retrieval simply found nothing. In ``mode == "auto"`` (the
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
