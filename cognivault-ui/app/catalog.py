"""Cached access to ``GET /api/vault/catalog`` — what the base actually contains.

The catalogue is the backend's answer to "which documents exist and what is each
one about": one row per **indexed** document with its path, title, byte size and
the one-paragraph annotation the indexer wrote for it. Two very different
consumers read it through this module:

* :mod:`app.corpus_tree` — builds the section tree that a corpus-wide question is
  answered from;
* :mod:`app.corpus_map` — needs one field of it, ``document_extensions``, to know
  what counts as a document at all.

Why the second one matters more than it looks. The footprint used to carry its
own allowlist (``md, markdown, txt, pdf, csv, canvas, excalidraw``) and it was
wrong: the indexer never scans ``txt`` or ``markdown``, so every ``.txt`` in a
vault was counted as a document the model could be asked about and search could
never return. The service now derives the real set from the very constant the
poller scans by and serves it here, so the two cannot drift. A client that keeps
its own list is re-introducing the same lie in a new place — hence there is no
built-in fallback in this module, and a caller that cannot reach the catalogue
must degrade to showing nothing rather than to guessing.

Everything here is best-effort and never raises: a catalogue failure means "no
structural block this turn", which is exactly the behaviour that predates it.

The cache mirrors :mod:`app.corpus_map`'s listing cache deliberately — same TTLs,
same per-``(base_url, token)`` identity with the token hashed, same cheap
"drop everything" eviction. Two caches rather than one because the two upstream
calls fail independently: a vault whose catalogue endpoint is missing (an older
backend) must still get a footprint from the listing.
"""

from __future__ import annotations

import hashlib
import time
from typing import Any

from . import cognivault

# The catalogue is ~25 KB of JSON for a 127-document corpus and is fetched at
# most once per TTL, so one page covers a normal vault. Truncation stays
# DETECTABLE rather than silent: the payload carries `total`, and the tree
# reports the difference (see `app.corpus_tree`).
_PAGE_LIMIT = 2000

# Short on purpose — this runs on the chat hot path, behind the same reasoning as
# `corpus_map._LIST_TIMEOUT`: a slow vault must not add its timeout to every turn.
_TIMEOUT = 6.0

# The catalogue changes on the indexer's timescale, not the turn's. The failure
# TTL is shorter so a brief outage self-heals quickly.
_CACHE_TTL_SECONDS = 300.0
_CACHE_TTL_FAILURE_SECONDS = 60.0
_CACHE_CAP = 256

# key -> (expires_at, payload | None). ``None`` caches a FAILURE, briefly.
_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}


def _cache_key(cv: dict[str, Any] | None) -> str:
    """Cache identity: the vault, not the caller (see ``corpus_map._cache_key``)."""
    base, token = cognivault._resolve_cv(cv)  # noqa: SLF001 — same package
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()[:16] if token else "-"
    return f"{base}|{digest}"


def reset_cache() -> None:
    """Drop the cached catalogues (tests; a manual re-sync)."""
    _cache.clear()


async def payload(cv: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """The cached catalogue response for ``cv``, or ``None`` when unavailable.

    ``None`` covers every failure mode at once — endpoint missing on an older
    backend, auth rejected, timeout, a non-dict body — because every caller
    treats them identically: render nothing.
    """
    key = _cache_key(cv)
    now = time.monotonic()
    entry = _cache.get(key)
    if entry is not None:
        expires_at, cached = entry
        if now < expires_at:
            return cached
        _cache.pop(key, None)

    data: dict[str, Any] | None
    try:
        data = await cognivault.catalog(cv, limit=_PAGE_LIMIT, timeout=_TIMEOUT)
    except Exception:  # noqa: BLE001 — навигация не должна ронять ход
        data = None
    if not isinstance(data, dict) or not data:
        data = None

    if len(_cache) >= _CACHE_CAP:
        # Cheap eviction: drop everything rather than track LRU (mirrors
        # `corpus_map.files`).
        _cache.clear()
    ttl = _CACHE_TTL_SECONDS if data else _CACHE_TTL_FAILURE_SECONDS
    _cache[key] = (now + ttl, data)
    return data


def extensions_of(data: dict[str, Any] | None) -> frozenset[str] | None:
    """``document_extensions`` as a lower-case set, or ``None`` if unusable.

    Pure, so the parsing is testable without a transport. Anything that is not a
    non-empty list of non-empty strings yields ``None`` — the caller then shows
    nothing, which is the whole point: there is no allowlist to fall back to.
    """
    if not isinstance(data, dict):
        return None
    raw = data.get("document_extensions")
    if not isinstance(raw, list):
        return None
    out = {
        item.strip().lstrip(".").lower()
        for item in raw
        if isinstance(item, str) and item.strip().strip(".")
    }
    return frozenset(out) or None


async def document_extensions(
    cv: dict[str, Any] | None = None,
) -> frozenset[str] | None:
    """What this service counts as a document, or ``None`` when unknown.

    THE definition, fetched — never a local list. ``None`` is a real answer and
    means "do not count documents at all this turn".
    """
    return extensions_of(await payload(cv))


def documents_of(data: dict[str, Any] | None) -> list[dict[str, Any]]:
    """The ``documents`` array, tolerant of a malformed payload (``[]`` then)."""
    if not isinstance(data, dict):
        return []
    raw = data.get("documents")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]
