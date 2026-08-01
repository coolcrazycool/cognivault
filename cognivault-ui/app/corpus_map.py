"""Footprint of the knowledge base — the «состав базы» block of the RAG context.

A RAG answer is assembled from at most :data:`app.rag._MAX_CONTEXT_BLOCKS`
fragments. Nothing in that context tells the model how much it is *not* holding,
so a single page that happens to be a numbered list reads exactly like the whole
corpus and gets answered from with full confidence.

This module renders a small, constant-size block that states the scale: how many
documents the base has, how many fragments the model was actually given, and how
the corpus is divided at the top. It answers no question — it removes the
omniscience pose.

Design constraints, all load-bearing:

* **Constant size.** The block is folded at depth 1 (or 2 — see :func:`_fold`)
  with counts, capped at :data:`_MAX_SECTIONS` sections, :data:`_MAX_CHILDREN`
  sub-sections each, and hard-capped at :data:`_MAX_MAP_CHARS` characters. A
  corpus ten times bigger renders the same size block with bigger numbers.
* **Zero model calls.** Everything here is one cached ``GET /api/vault/files``
  plus pure Python.
* **Silent degradation.** :func:`corpus_block` returns ``None`` on *any* failure
  (endpoint down, malformed payload, empty vault); the caller then renders the
  turn exactly as it did before this module existed.
* **Code-owned text, not a prompt.** The caption that forbids citing the block
  travels *with* the block. Delivering it as prompt wording would never reach a
  user who has already saved a custom ``prompts.system`` — their copy is frozen
  at the day they saved it.
* **Short timeout, cached per user.** The listing is fetched with
  :data:`_LIST_TIMEOUT` (not the client default) and cached per
  ``(base_url, token)``; a hanging vault must not add its timeout to every
  single RAG turn.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from typing import Any

from . import cognivault

# Extensions that count as a *document*. Deliberately narrower than "every file
# in the vault": a Confluence sync also writes attachments
# (``Confluence/attachments/<page-id>/<file>``), and counting a folder of PNGs as
# a section of the knowledge base would make the block lie about its scale.
_DOC_EXTENSIONS = frozenset(
    {"md", "markdown", "txt", "pdf", "csv", "canvas", "excalidraw"}
)

# Label for documents that sit directly at the folded level (no sub-folder).
_ROOT_LABEL = "(корень)"

# Size guards. The first two shape the fold, the third is the hard ceiling the
# rendered text is squeezed under (see :func:`_compose`).
_MAX_SECTIONS = 12
_MAX_CHILDREN = 4
_MAX_MAP_CHARS = 700

# How many single-folder levels the fold may descend through before it gives up
# (see :func:`_fold`). A guard against a pathological vault, not a design limit:
# a Confluence sync needs 4.
_MAX_DESCENT = 8

# Listing cache. A vault listing changes on the indexer's timescale, not the
# turn's; the failure TTL is shorter so a brief outage self-heals quickly.
_CACHE_TTL_SECONDS = 300.0
_CACHE_TTL_FAILURE_SECONDS = 60.0
_CACHE_CAP = 256
_LIST_TIMEOUT = 5.0

# The two fixed sentences around the numbers.
#
# The caption is the whole "not citable" contract: it sits inside the block, in
# the same message, one line above the numbers — not in the editable system
# prompt, where a user with a saved override would never see it.
_CAPTION = (
    "Состав базы знаний (справочная навигация). Это НЕ источник: ссылаться на "
    "него нельзя, [Источник N] — только на блок «Источники» ниже."
)
_TAIL = "Это объёмы разделов, а не перечень их содержимого."

_DOC_FORMS = ("документ", "документа", "документов")
_FRAGMENT_FORMS = ("фрагмент", "фрагмента", "фрагментов")
_SECTION_FORMS = ("раздел", "раздела", "разделов")
_SUBSECTION_FORMS = ("подраздел", "подраздела", "подразделов")


# --------------------------------------------------------------------------- #
# Pure rendering
# --------------------------------------------------------------------------- #


@dataclass
class _Section:
    label: str
    count: int
    children: list[tuple[str, int]] = field(default_factory=list)


def _plural(n: int, forms: tuple[str, str, str]) -> str:
    """Russian plural form of ``forms`` for ``n`` (1 / 2-4 / 5+)."""
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return forms[0]
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return forms[1]
    return forms[2]


def _documents(paths: list[Any]) -> list[list[str]]:
    """Split a vault listing into path segments, keeping documents only.

    Tolerant by design — the listing is upstream data: non-strings, Windows
    separators, leading slashes, ``.`` segments and non-document extensions are
    all dropped rather than raising.
    """
    docs: list[list[str]] = []
    for raw in paths or []:
        if not isinstance(raw, str):
            continue
        segments = [
            s for s in raw.replace("\\", "/").strip().split("/") if s and s != "."
        ]
        if not segments:
            continue
        name = segments[-1]
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in _DOC_EXTENSIONS:
            continue
        docs.append(segments)
    return docs


def _group(docs: list[list[str]], depth: int) -> list[_Section]:
    """Group documents by their segment at ``depth``, with sub-section counts.

    A document that IS the segment at ``depth`` (i.e. a file sitting directly at
    that level) is counted under :data:`_ROOT_LABEL`. Sections are ordered by
    document count, ties broken by name, so the fold is deterministic.
    """
    counts: dict[str, int] = {}
    children: dict[str, dict[str, int]] = {}
    for segments in docs:
        if len(segments) <= depth:
            continue
        if len(segments) == depth + 1:
            label, child = _ROOT_LABEL, None
        else:
            label = segments[depth]
            child = segments[depth + 1] if len(segments) > depth + 2 else None
        counts[label] = counts.get(label, 0) + 1
        if child:
            bucket = children.setdefault(label, {})
            bucket[child] = bucket.get(child, 0) + 1

    sections = [
        _Section(
            label=label,
            count=count,
            children=sorted(
                children.get(label, {}).items(), key=lambda kv: (-kv[1], kv[0])
            ),
        )
        for label, count in counts.items()
    ]
    sections.sort(key=lambda s: (-s.count, s.label))
    return sections


def _fold(docs: list[list[str]]) -> tuple[list[_Section], str]:
    """Fold the corpus into top sections, descending while the level is a corridor.

    Returns ``(sections, prefix)``. Depth 1 is the default; a vault whose
    documents ALL live under one folder would render a single useless section,
    so the fold descends and reports the swallowed folders as ``prefix``.

    The descent LOOPS rather than taking a single step, because a real
    Confluence sync nests several levels before it branches:
    ``Confluence/<space>/<ancestor>/…`` (``build_vault_path`` in
    ``app.confluence.convert``). On the corpus this module was built for the
    branch point is at depth 4 — one step short of it left the block reporting
    ``- Confluence — 127 (OASISEXT: 127)`` and nothing else, i.e. paying for a
    block that says nothing about the shape of the base.

    Descending is safe at every step precisely because the level has exactly one
    folder and every document is under it — no document is dropped. It stops as
    soon as the level branches, and it never descends INTO the files themselves:
    a level whose only entry is :data:`_ROOT_LABEL` is worse than the folder
    above it, so the previous level is kept.
    """
    sections = _group(docs, 0)
    prefix: list[str] = []
    depth = 0
    while (
        len(sections) == 1
        and sections[0].label != _ROOT_LABEL
        and depth < _MAX_DESCENT
    ):
        deeper = _group(docs, depth + 1)
        if not deeper or (len(deeper) == 1 and deeper[0].label == _ROOT_LABEL):
            break
        prefix.append(sections[0].label)
        sections = deeper
        depth += 1
    return sections, "/".join(prefix)


def _children_suffix(section: _Section) -> str:
    """``" (Fincert: 12, ППРБ: 9, ещё 6 подразделов)"`` — or empty."""
    if not section.children:
        return ""
    shown = section.children[:_MAX_CHILDREN]
    parts = [f"{name}: {count}" for name, count in shown]
    hidden = len(section.children) - len(shown)
    if hidden:
        parts.append(f"ещё {hidden} {_plural(hidden, _SUBSECTION_FORMS)}")
    return f" ({', '.join(parts)})"


def _compose(
    total: int,
    n_sources: int | None,
    sections: list[_Section],
    shown: int,
    prefix: str,
    with_children: bool,
) -> str:
    """Render the block with ``shown`` sections, optionally with sub-sections."""
    line = f"Всего документов в базе: {total}."
    if isinstance(n_sources, int) and n_sources > 0:
        line += (
            f" Ниже в блоке «Источники» — {n_sources} "
            f"{_plural(n_sources, _FRAGMENT_FORMS)}; остальное содержимое базы "
            "не показано."
        )
    caption = (
        f"Разделы внутри «{prefix}» (число документов):"
        if prefix
        else "Разделы верхнего уровня (число документов):"
    )
    lines = [_CAPTION, line, caption]
    for section in sections[:shown]:
        suffix = _children_suffix(section) if with_children else ""
        lines.append(f"- {section.label} — {section.count}{suffix}")
    rest = sections[shown:]
    if rest:
        docs = sum(s.count for s in rest)
        lines.append(
            f"- ещё {len(rest)} {_plural(len(rest), _SECTION_FORMS)} — "
            f"{docs} {_plural(docs, _DOC_FORMS)}"
        )
    lines.append(_TAIL)
    return "\n".join(lines)


def render(
    paths: list[Any],
    n_sources: int | None = None,
    max_chars: int = _MAX_MAP_CHARS,
) -> str | None:
    """Render the corpus footprint block, or ``None`` if there is nothing to say.

    ``n_sources`` is the number of blocks in the «Источники» section of the same
    message; it is what turns the block from trivia into a scale statement
    («127 documents, you were given 5 fragments»). ``None`` omits that sentence.

    The result is squeezed under ``max_chars`` by degrading in a fixed order:
    sub-sections first, then sections from the smallest up (their documents are
    still counted in a trailing «ещё N разделов» line, so the total always adds
    up).
    """
    docs = _documents(paths)
    if not docs:
        return None
    sections, prefix = _fold(docs)
    if not sections:
        return None
    total = len(docs)

    shown = min(len(sections), _MAX_SECTIONS)
    for with_children in (True, False):
        text = _compose(total, n_sources, sections, shown, prefix, with_children)
        if len(text) <= max_chars:
            return text
    while shown > 1:
        shown -= 1
        text = _compose(total, n_sources, sections, shown, prefix, False)
        if len(text) <= max_chars:
            return text
    # One section and still over the cap: an absurdly long folder name. The
    # honest numbers are worth more than the ceiling, and the block is still
    # O(1) in the size of the corpus.
    return _compose(total, n_sources, sections, 1, prefix, False)


# --------------------------------------------------------------------------- #
# Cached listing
# --------------------------------------------------------------------------- #

# key -> (expires_at, paths | None). ``None`` caches a FAILURE for a shorter TTL.
_cache: dict[str, tuple[float, list[str] | None]] = {}


def _cache_key(cv: dict[str, Any] | None) -> str:
    """Cache identity: the vault, not the caller.

    In server mode the token IS the tenant, so it must be part of the key — one
    user's footprint may never be served to another. It is hashed rather than
    stored, so nothing that gets dumped or logged carries a credential.
    """
    base, token = cognivault._resolve_cv(cv)  # noqa: SLF001 — same package
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()[:16] if token else "-"
    return f"{base}|{digest}"


def reset_cache() -> None:
    """Drop the cached listings (tests; a manual re-sync)."""
    _cache.clear()


async def files(cv: dict[str, Any] | None = None) -> list[str] | None:
    """Cached vault listing for ``cv``; ``None`` when it is unavailable.

    Never raises: a listing failure means "no footprint block this turn", which
    is exactly the behaviour that predates this module.
    """
    key = _cache_key(cv)
    now = time.monotonic()
    entry = _cache.get(key)
    if entry is not None:
        expires_at, cached = entry
        if now < expires_at:
            return cached
        _cache.pop(key, None)

    try:
        paths = await cognivault.list_files(cv, recursive=True, timeout=_LIST_TIMEOUT)
    except Exception:  # noqa: BLE001 — навигация не должна ронять ход
        paths = None

    if len(_cache) >= _CACHE_CAP:
        # Cheap eviction: drop everything rather than track LRU (mirrors
        # `deps._cache_put`).
        _cache.clear()
    ttl = _CACHE_TTL_SECONDS if paths else _CACHE_TTL_FAILURE_SECONDS
    _cache[key] = (now + ttl, paths)
    return paths


async def corpus_block(
    cv: dict[str, Any] | None = None, n_sources: int | None = None
) -> str | None:
    """The rendered footprint block for this turn, or ``None``.

    The single entry point used by :mod:`app.rag`. Every failure mode — listing
    unavailable, empty vault, nothing but attachments, an unexpected payload —
    collapses to ``None`` and the turn proceeds exactly as before.
    """
    paths = await files(cv)
    if not paths:
        return None
    try:
        return render(paths, n_sources)
    except Exception:  # noqa: BLE001 — pure code, but the turn is worth more
        return None
