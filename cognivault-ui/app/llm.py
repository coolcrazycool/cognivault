"""Chat-backend facade: one surface, two transports.

Everything upstream — the chat route, the two hidden pipeline calls — talks to
this module and never names a provider. Dispatch is by config TYPE, not by a
string threaded through every call: :func:`config_for` reads the provider key
once and hands back the matching config object, and each function below switches
on what it was given. A new backend adds a branch here and nothing else.

Two providers today:

* ``gigachat`` — the direct mTLS client (:mod:`app.gigachat`). Real token
  streaming. Kept as the rollback path.
* ``kitai``    — the KitAI platform (:mod:`app.kitai`). No streaming surface:
  the answer arrives whole, after polling.

Embeddings are NOT here. They are produced by the TypeScript backend against its
own provider (`EMBEDDING_PROVIDER`), and switching the chat model must not
disturb them — a different embedder means a different vector space and a full
re-index.
"""

from __future__ import annotations

import logging
from typing import Any, AsyncIterator

from . import gigachat, kitai
from .gigachat import GigaConfig
from .kitai import KitaiConfig
from .llm_errors import GigaChatError

log = logging.getLogger("cognivault-ui.llm")

PROVIDERS = ("gigachat", "kitai")
DEFAULT_PROVIDER = "gigachat"

ChatConfig = GigaConfig | KitaiConfig


def provider_of(gc: dict[str, Any]) -> str:
    """Provider name from the ``gigachat`` config section.

    An unknown value falls back to the default rather than raising: a typo in an
    env var should not take the chat down, and the log line says what happened.
    """
    name = str(gc.get("provider", "") or DEFAULT_PROVIDER).strip().lower()
    if name not in PROVIDERS:
        log.warning(
            "неизвестный chat-провайдер %r — использую %s", name, DEFAULT_PROVIDER
        )
        return DEFAULT_PROVIDER
    return name


def config_for(gc: dict[str, Any]) -> ChatConfig:
    """Build the config object for whichever provider is selected."""
    if provider_of(gc) == "kitai":
        return KitaiConfig.from_dict(gc)
    return GigaConfig.from_dict(gc)


def supports_streaming(cfg: ChatConfig) -> bool:
    """Whether tokens arrive progressively.

    The chat route shows a "модель думает" indicator instead of a growing answer
    when this is false — the wait is the same either way, but a still spinner is
    honest where a typewriter replaying finished text is not.
    """
    return isinstance(cfg, GigaConfig)


def files_present(cfg: ChatConfig) -> None:
    """Pre-flight the client certificate, before any SSE frame is emitted."""
    if isinstance(cfg, KitaiConfig):
        kitai.mtls.files_present(cfg)
        return
    gigachat._files_present(cfg)  # noqa: SLF001 — same package, deliberate reuse


def stream_chat(
    messages: list[dict[str, Any]], cfg: ChatConfig
) -> AsyncIterator[str]:
    """Assistant content, chunk by chunk.

    Not `async def`: both backends are async *generators*, and wrapping one in a
    coroutine would make the caller await before the first chunk.
    """
    if isinstance(cfg, KitaiConfig):
        return kitai.stream_chat(messages, cfg)
    return gigachat.stream_chat(messages, cfg)


async def complete_json(
    messages: list[dict[str, Any]],
    cfg: ChatConfig,
    **kwargs: Any,
) -> dict[str, Any]:
    """One call, one parsed JSON object — for the hidden pipeline steps."""
    if isinstance(cfg, KitaiConfig):
        return await kitai.complete_json(messages, cfg, **kwargs)
    return await gigachat.complete_json(messages, cfg, **kwargs)


async def list_models(cfg: ChatConfig) -> list[dict[str, str]]:
    """Models the active provider offers, as ``[{"name", "label"}]``.

    Both transports publish a catalogue, so both are asked:
    KitAI at ``/api/v1/meta/model``, GigaChat at the OpenAI-compatible
    ``{base_url}/models``. Failures propagate — the caller turns them into a
    free-text field, because an empty list would claim the provider offers
    nothing, which is not the same as "we could not ask".
    """
    if isinstance(cfg, KitaiConfig):
        return await kitai.list_models(cfg)
    return await gigachat.list_models(cfg)


__all__ = [
    "DEFAULT_PROVIDER",
    "PROVIDERS",
    "ChatConfig",
    "GigaChatError",
    "complete_json",
    "config_for",
    "files_present",
    "list_models",
    "provider_of",
    "stream_chat",
    "supports_streaming",
]
