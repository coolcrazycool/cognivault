"""Retrieval-augmented context assembly.

Given a user query and config, retrieve fragments from CogniVault, build a
Russian system prompt embedding a numbered context block, and return the
matching sources list for the UI.

The default ``mode == "auto"`` path performs *smart context expansion*: hybrid
retrieval, group-by-file, and a per-file decision between a bare chunk, a section
slice, or the whole document — all under a character budget derived from the
model's context window. The legacy ``semantic``/``context`` sources remain for
backward compatibility.
"""

from __future__ import annotations

import re
from typing import Any, Callable

from . import cognivault

# Order in which grouped ``/context`` buckets are flattened.
_CONTEXT_GROUP_ORDER = (
    "summary",
    "architecture",
    "adrs",
    "glossary",
    "implementation",
)

_SYSTEM_TEMPLATE = """Ты — ассистент, отвечающий на вопросы по базе знаний пользователя.
Ниже приведены фрагменты документов, найденные по текущему вопросу.

Правила:
1. Отвечай, опираясь в первую очередь на приведённые фрагменты.
2. Если во фрагментах нет ответа, честно скажи об этом — не выдумывай.
3. При использовании фрагмента ссылайся на него в тексте как [Источник N].
4. Некоторые источники — целые документы или разделы; используй только относящиеся к вопросу части.
5. Отвечай на русском языке, кратко и по делу.

Фрагменты базы знаний:
{context_block}"""

_RETRIEVAL_UNAVAILABLE = "Поиск по базе недоступен — отвечаю без контекста"

# Auto-mode internal retrieval width (independent of any stored `limit`).
_AUTO_LIMIT = 10

# Token reserves (see `_compute_budget`).
_HISTORY_RESERVE_TOKENS = 2000
_SYSTEM_RESERVE_TOKENS = 500
# Rough chars-per-token for Russian, with headroom.
_CHARS_PER_TOKEN = 2.0
_BUDGET_HEADROOM = 0.85


# --------------------------------------------------------------------------- #
# Normalisation
# --------------------------------------------------------------------------- #


def _norm_semantic(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalise ``search/{semantic,hybrid}`` results to the fragment shape."""
    out: list[dict[str, Any]] = []
    for r in results:
        out.append(
            {
                "text": r.get("text", "") or "",
                "path": r.get("path", "") or "",
                "title": r.get("title") or r.get("path") or "",
                "section_path": r.get("section_path") or "",
                "score": r.get("score"),
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

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")

# First-word anaphora triggers (lowercased, punctuation-stripped).
_ANAPHORA_WORDS = {"а", "и", "но", "это", "этот", "там", "его", "её", "ее", "их"}


def _norm_heading(text: str) -> str:
    """Case/space-insensitive heading key."""
    return re.sub(r"\s+", " ", text).strip().casefold()


def _slice_section(content: str, section_path: str, cap: int) -> str | None:
    """Slice ``content`` to the section named by the tail of ``section_path``.

    Splits on markdown headings (``^#{1,6}\\s+``), finds the heading whose text
    matches the last ``>``-separated segment of ``section_path`` (case/space
    insensitive), and returns from that heading until the next heading of the
    SAME-or-higher level, capped at ``cap`` chars. Returns ``None`` when no
    heading matches (renamed heading / reindex race) so the caller can fall back
    to the raw chunk text.
    """
    tail = section_path.split(">")[-1].strip() if section_path else ""
    if not tail:
        return None
    target = _norm_heading(tail)
    lines = content.split("\n")
    start: int | None = None
    start_level = 0
    for i, line in enumerate(lines):
        m = _HEADING_RE.match(line)
        if m and _norm_heading(m.group(2)) == target:
            start = i
            start_level = len(m.group(1))
            break
    if start is None:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        m = _HEADING_RE.match(lines[j])
        if m and len(m.group(1)) <= start_level:
            end = j
            break
    section = "\n".join(lines[start:end]).strip()
    return section[:cap]


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


def _first_word(text: str) -> str:
    stripped = text.strip().casefold()
    if not stripped:
        return ""
    word = stripped.split()[0]
    return re.sub(r"[^\w]+$", "", word)


def _needs_anaphora(query: str) -> bool:
    """Short or referential questions likely depend on the previous turn."""
    q = query.strip()
    if len(q) < 25:
        return True
    return _first_word(q) in _ANAPHORA_WORDS


def _previous_user_content(messages: list[dict[str, Any]] | None) -> str:
    """Text of the user message BEFORE the current (last) user message."""
    if not messages:
        return ""
    users = [m for m in messages if m.get("role") == "user"]
    if len(users) >= 2:
        return str(users[-2].get("content", "") or "")
    return ""


def _retrieval_query(query: str, messages: list[dict[str, Any]] | None) -> str:
    """Prepend the previous user turn for retrieval when the question is anaphoric.

    Only affects retrieval — the actual question sent to GigaChat is unchanged.
    """
    if not _needs_anaphora(query):
        return query
    prev = _previous_user_content(messages)
    if prev and prev.strip() != query.strip():
        return f"{prev} {query}"
    return query


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
    header = f"[Источник {n}] {title} — {path}"
    if section_path:
        header += f" > {section_path}"
    return header


def _block(header: str, text: str) -> str:
    return f"{header}\n{text}\n\n"


# --------------------------------------------------------------------------- #
# Auto pipeline
# --------------------------------------------------------------------------- #


async def _build_auto(
    query: str,
    rcfg: dict[str, Any],
    gcfg: dict[str, Any],
    messages: list[dict[str, Any]] | None,
    cv: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str | None, int]:
    min_score = rcfg.get("min_score")
    file_full_chars = int(rcfg.get("file_full_chars", 6000))
    section_max_chars = int(rcfg.get("section_max_chars", 4000))
    max_expanded_files = int(rcfg.get("max_expanded_files", 2))
    budget = _compute_budget(rcfg, gcfg)

    rq = _retrieval_query(query, messages)

    # 1. Retrieve with hybrid search, graceful fallback to semantic.
    try:
        try:
            raw = await cognivault.hybrid_search(rq, _AUTO_LIMIT, cv=cv)
        except Exception:  # noqa: BLE001 — hybrid missing/404 => semantic fallback
            raw = await cognivault.semantic_search(rq, _AUTO_LIMIT, cv=cv)
    except Exception:  # noqa: BLE001 — any retrieval failure => graceful fallback
        return None, [], _RETRIEVAL_UNAVAILABLE, 0

    fragments = _norm_semantic(raw.get("results") or [])
    fragments = [
        f for f in fragments if _passes_min_score(f.get("score"), min_score)
    ]
    if not fragments:
        return None, [], None, 0

    # 2-4. Group by file, rank files by their best hit.
    groups, order = _group_by_path(fragments)
    ranked = sorted(order, key=lambda p: _best_score(groups[p]), reverse=True)
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
    ) -> bool:
        nonlocal used, n
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
            }
        )
        return True

    def add_sections(frags: list[dict[str, Any]], content: str, title: str, path: str) -> None:
        for f in frags:
            sp = f.get("section_path") or ""
            sliced = _slice_section(content, sp, section_max_chars)
            if sliced is None:
                depth, text = "chunk", (f.get("text") or "")
            else:
                depth, text = "section", sliced
            key = (path, text)
            if not text or key in seen:
                continue
            if not add(title, path, sp, f.get("score"), text, depth):
                break
            seen.add(key)

    # 5-7. Expanded files first (already score-ranked).
    for p in expanded_paths:
        frags = groups[p]
        title = frags[0].get("title") or p
        best = _best_score(frags)
        content = contents.get(p)
        if content is None:
            add(title, p, "", best, _merge_chunk_text(frags), "chunk")
            continue
        remaining = budget - used
        depth = _decide_file_depth(len(content), len(frags), file_full_chars, remaining)
        if depth == "file":
            block_len = len(_block(_header(n + 1, title, p, ""), content))
            if blocks and used + block_len > budget:
                # Never partially cut a whole file — downgrade to its section.
                add_sections(frags, content, title, p)
            else:
                add(title, p, "", best, content, "file")
        else:
            add_sections(frags, content, title, p)

    # Remaining files stay as bare (merged) chunks.
    for p in bare_paths:
        frags = groups[p]
        title = frags[0].get("title") or p
        best = _best_score(frags)
        sp = frags[0].get("section_path") or ""
        if not add(title, p, sp, best, _merge_chunk_text(frags), "chunk"):
            break

    if not sources:
        return None, [], None, 0

    context_block = "".join(blocks).rstrip()
    system_message = {
        "role": "system",
        "content": _SYSTEM_TEMPLATE.format(context_block=context_block),
    }
    return system_message, sources, None, len(context_block)


# --------------------------------------------------------------------------- #
# Legacy pipeline (semantic / context, flat chunks)
# --------------------------------------------------------------------------- #


async def _build_legacy(
    query: str, rcfg: dict[str, Any], cv: dict[str, Any] | None
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str | None, int]:
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
        return None, [], _RETRIEVAL_UNAVAILABLE, 0

    fragments = [
        f for f in fragments if _passes_min_score(f.get("score"), min_score)
    ]
    if not fragments:
        return None, [], None, 0

    blocks: list[str] = []
    sources: list[dict[str, Any]] = []
    total = 0
    n = 0
    for frag in fragments:
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
            }
        )

    if not sources:
        return None, [], None, 0

    context_block = "".join(blocks).rstrip()
    system_message = {
        "role": "system",
        "content": _SYSTEM_TEMPLATE.format(context_block=context_block),
    }
    return system_message, sources, None, len(context_block)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


async def build_rag_context(
    query: str,
    rcfg: dict[str, Any],
    cvcfg: dict[str, Any] | None,
    gcfg: dict[str, Any] | None = None,
    messages: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str | None, int]:
    """Assemble a RAG system message + sources for ``query``.

    Returns ``(system_message | None, sources, notice | None, context_chars)``.
    In ``mode == "auto"`` (the default) this runs the smart-expansion pipeline
    using its own internals regardless of any stale stored ``source``/``limit``.
    On retrieval failure returns ``(None, [], notice, 0)`` so the caller can fall
    back to a plain chat.

    ``cvcfg`` is the CogniVault call context threaded into *every* upstream
    request: in server mode it is the per-request ``{"base_url", "token"}``; in
    local mode it is ``None``, meaning "read the config file" (historical
    behaviour). Passing it through fixes the latent bug where the retrieval
    sub-builders re-read the file instead of honouring the caller's context.
    """
    mode = str(rcfg.get("mode", "auto"))
    if mode == "auto":
        return await _build_auto(query, rcfg, gcfg or {}, messages, cvcfg)
    return await _build_legacy(query, rcfg, cvcfg)
