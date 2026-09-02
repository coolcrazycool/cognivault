"""What a hidden LLM call left behind — stamped onto the config object.

``complete_json`` returns the parsed dict and nothing else; many callers and
tests depend on that shape, so the metadata of the call (``finish_reason``,
``usage``, the head of the raw text, the model actually sent) travels the same
way ``stream_chat`` already reports ``last_finish_reason``: as attributes on the
config object the caller passed in. :func:`app.rag_pipeline._call` builds a
fresh config per call (``llm.config_for``), so the stamps are per call even
when grader batches run concurrently.

Why it matters: a grader batch that dies with ``KitaiQueryFailed … 404 "No such
model"`` or a ``GigaChatBadJSON: пустой ответ`` (the model spent ``max_tokens``
on reasoning and emitted no content, ``finish_reason == "length"``) used to be
one ``log.warning`` in the pod log and nothing in ``rag_log.jsonl``. The eval
harness could see the reranker was dead, never why.

Both providers stamp the same four names, reset at the start of each call:

* ``last_finish_reason`` — ``str | None``;
* ``last_usage`` — ``{"prompt_tokens", "completion_tokens", "total_tokens"}``
  or ``None`` when the response carried no usage;
* ``last_content_head`` — first :data:`CONTENT_HEAD_CHARS` characters of the
  raw assistant text, ``""`` when nothing came back;
* ``last_model`` — the model name that went over the wire.
"""

from __future__ import annotations

from typing import Any

#: How much of the raw assistant text is kept. Enough to see «```json\n{"gra»
#: cut mid-way or an empty string; far too little to be a second copy of the
#: answer in every record.
CONTENT_HEAD_CHARS = 300

_USAGE_KEYS = ("prompt_tokens", "completion_tokens", "total_tokens")


def reset(cfg: Any, model: str | None) -> None:
    """Clear the stamps before a call. ``last_model`` is known up front."""
    setattr(cfg, "last_finish_reason", None)
    setattr(cfg, "last_usage", None)
    setattr(cfg, "last_content_head", "")
    setattr(cfg, "last_model", model or None)


def stamp(
    cfg: Any,
    *,
    finish_reason: Any,
    usage: Any,
    content: Any,
) -> None:
    """Record what the response said. Called BEFORE the text is parsed, so a
    reply that then fails ``extract_json`` still leaves its trace."""
    setattr(
        cfg,
        "last_finish_reason",
        str(finish_reason) if finish_reason not in (None, "") else None,
    )
    setattr(cfg, "last_usage", usage_of(usage))
    setattr(cfg, "last_content_head", str(content or "")[:CONTENT_HEAD_CHARS])


def usage_of(raw: Any) -> dict[str, int] | None:
    """The three standard counters out of an OpenAI-shaped ``usage`` object.

    Defensive on purpose: KitAI passes the upstream response through and the
    platform does not promise the shape; a missing or malformed block is
    ``None`` rather than an exception in a best-effort telemetry path.
    """
    if not isinstance(raw, dict):
        return None
    out: dict[str, int] = {}
    for key in _USAGE_KEYS:
        value = raw.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            out[key] = int(value)
    return out or None


def read(cfg: Any) -> dict[str, Any]:
    """The stamps as a plain dict — tolerant of a config nobody stamped.

    A test double for ``complete_json`` stamps nothing; ``getattr`` defaults
    keep the record honest (``None``) instead of raising, and ``model`` falls
    back to the config's own field so the record still names what was asked.
    """
    model = getattr(cfg, "last_model", None) or getattr(cfg, "model", None) or None
    return {
        "finish_reason": getattr(cfg, "last_finish_reason", None),
        "usage": getattr(cfg, "last_usage", None),
        "content_head": getattr(cfg, "last_content_head", "") or "",
        "model": model,
    }


__all__ = ["CONTENT_HEAD_CHARS", "read", "reset", "stamp", "usage_of"]
