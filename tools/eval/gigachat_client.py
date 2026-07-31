"""Minimal mTLS GigaChat ``chat/completions`` client for the eval harness.

Modelled on ``cognivault-ui/app/gigachat.py`` (the client PEM certificate *is*
the auth — there is no bearer token), but deliberately standalone:

* no streaming — one prompt in, one text out;
* an injectable ``transport=`` so tests can drive it with
  ``httpx.MockTransport`` (same idiom as ``app/confluence/client.py``);
* retries with backoff on ``429`` / ``5xx``;
* :meth:`GigaChatJudge.complete_json` — a tolerant JSON extractor, because the
  judge model habitually wraps its answer in ```json fences and prepends a
  chatty preamble.

Configuration comes from the environment, optionally seeded from the UI's
``~/.cognivault-ui/config.json`` so a working local install needs no extra
setup. ``EVAL_JUDGE_MODEL`` always wins over the model name from either source.

Nothing in this module imports from ``cognivault-ui`` — ``tools/eval`` is
self-contained on purpose (it must run against a *deployed* stack).
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import ssl
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

SleepFn = Callable[[float], Awaitable[None]]
JitterFn = Callable[[], float]

DEFAULT_CONFIG_PATH = "~/.cognivault-ui/config.json"

# Retry policy for the judge calls: 429 / 5xx only, everything else fails fast.
MAX_ATTEMPTS = 4
BASE_BACKOFF_SECONDS = 1.0


# --------------------------------------------------------------------------- #
# Typed errors
# --------------------------------------------------------------------------- #


class GigaChatEvalError(Exception):
    """Base error carrying a stable machine ``code`` plus a short ``detail``."""

    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


class GigaChatCertMissing(GigaChatEvalError):
    """Client certificate or key file is absent."""


class GigaChatHTTPError(GigaChatEvalError):
    """Upstream answered with a non-200 (after retries where applicable)."""


class GigaChatTransportError(GigaChatEvalError):
    """DNS / TLS / connection failure."""


class GigaChatJSONError(GigaChatEvalError):
    """The model's answer could not be parsed as a JSON object."""


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def load_ui_config(path: str | None = None) -> dict[str, Any]:
    """Best-effort read of the UI config JSON; returns ``{}`` when unavailable."""
    candidate = os.path.expanduser(
        path or os.environ.get("COGNIVAULT_UI_CONFIG") or DEFAULT_CONFIG_PATH
    )
    try:
        with open(candidate, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


@dataclass
class JudgeConfig:
    """Everything needed to reach the judge model over mTLS."""

    base_url: str = ""
    model: str = ""
    cert_path: str = ""
    key_path: str = ""
    key_passphrase: str = ""
    ca_path: str = ""
    verify_ssl: bool = False
    temperature: float = 0.0
    max_tokens: int = 1024
    timeout: float = 120.0
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_env(cls, config_path: str | None = None) -> "JudgeConfig":
        """Build a config from ENV, falling back to the UI ``config.json``.

        Precedence, highest first: ``EVAL_JUDGE_MODEL`` (model only) →
        ``GIGACHAT_*`` env vars → ``gigachat`` section of the UI config →
        built-in defaults.
        """
        gc = load_ui_config(config_path).get("gigachat", {})
        if not isinstance(gc, dict):
            gc = {}

        def pick(env_name: str, cfg_key: str, default: str = "") -> str:
            raw = os.environ.get(env_name)
            if raw:
                return raw
            value = gc.get(cfg_key, default)
            return "" if value is None else str(value)

        verify_default = bool(gc.get("verify_ssl", False))
        return cls(
            base_url=pick("GIGACHAT_BASE_URL", "base_url").rstrip("/"),
            model=os.environ.get("EVAL_JUDGE_MODEL")
            or pick("GIGACHAT_MODEL", "model"),
            cert_path=os.path.expanduser(pick("GIGACHAT_CERT_PATH", "cert_path")),
            key_path=os.path.expanduser(pick("GIGACHAT_KEY_PATH", "key_path")),
            key_passphrase=pick("GIGACHAT_KEY_PASSPHRASE", "key_passphrase"),
            ca_path=os.path.expanduser(pick("GIGACHAT_CA_PATH", "ca_path")),
            verify_ssl=_env_bool("GIGACHAT_VERIFY_SSL", verify_default),
            temperature=float(os.environ.get("EVAL_JUDGE_TEMPERATURE", "0") or 0),
            max_tokens=int(os.environ.get("EVAL_JUDGE_MAX_TOKENS", "1024") or 1024),
            timeout=float(os.environ.get("EVAL_JUDGE_TIMEOUT", "120") or 120),
        )


# --------------------------------------------------------------------------- #
# TLS wiring (mirrors app/gigachat.py, extended with a CA bundle)
# --------------------------------------------------------------------------- #


def _files_present(cfg: JudgeConfig) -> None:
    missing = [p for p in (cfg.cert_path, cfg.key_path) if not (p and os.path.isfile(p))]
    if missing:
        raise GigaChatCertMissing(
            "GIGACHAT_CERT_MISSING",
            "Клиентский сертификат или ключ не найдены",
            detail="; ".join(f"нет файла: {p}" for p in missing),
        )


def _build_verify(cfg: JudgeConfig) -> Any:
    """Compute httpx's ``verify`` argument.

    A passphrase-protected key cannot go through the plain ``cert=`` tuple, so
    in that case (and whenever a CA bundle is given) we build an SSLContext and
    load the chain into it — httpx then uses it for client auth too.
    """
    if cfg.key_passphrase or cfg.ca_path:
        ctx = ssl.create_default_context(cafile=cfg.ca_path or None)
        if not cfg.verify_ssl:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        ctx.load_cert_chain(
            certfile=cfg.cert_path,
            keyfile=cfg.key_path,
            password=cfg.key_passphrase or None,
        )
        return ctx
    return cfg.verify_ssl


# --------------------------------------------------------------------------- #
# Tolerant JSON extraction (pure — works without a live contour)
# --------------------------------------------------------------------------- #


def _strip_code_fences(text: str) -> str:
    """Return the body of the first ```/```json fenced block, else ``text``."""
    marker = text.find("```")
    if marker < 0:
        return text
    rest = text[marker + 3 :]
    newline = rest.find("\n")
    if newline < 0:
        return text
    # The info string ("json", "" …) is irrelevant — we try the body either way.
    body = rest[newline + 1 :]
    closing = body.find("```")
    return body[:closing] if closing >= 0 else body


def _iter_json_candidates(text: str) -> list[str]:
    """Yield balanced ``{...}`` substrings, outermost-first, in order."""
    out: list[str] = []
    for start, ch in enumerate(text):
        if ch != "{":
            continue
        depth = 0
        in_string = False
        escaped = False
        for i in range(start, len(text)):
            c = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif c == "\\":
                    escaped = True
                elif c == '"':
                    in_string = False
                continue
            if c == '"':
                in_string = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    out.append(text[start : i + 1])
                    break
    return out


def extract_json(text: str) -> dict[str, Any]:
    """Parse a JSON object out of a model answer.

    Handles the three shapes the judge actually produces: bare JSON, a ```json
    fenced block, and a preamble ("Вот результат:") followed by JSON. Raises
    :class:`GigaChatJSONError` when nothing parses, so callers can degrade the
    sample to "metric unavailable" instead of crashing the run.
    """
    if not text or not text.strip():
        raise GigaChatJSONError("JUDGE_EMPTY", "Судья вернул пустой ответ")

    for candidate_text in (text, _strip_code_fences(text)):
        stripped = candidate_text.strip()
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            return parsed
        for candidate in _iter_json_candidates(candidate_text):
            try:
                obj = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                return obj

    raise GigaChatJSONError(
        "JUDGE_BAD_JSON",
        "Не удалось разобрать JSON в ответе судьи",
        detail=text[:500],
    )


# --------------------------------------------------------------------------- #
# Client
# --------------------------------------------------------------------------- #


class GigaChatJudge:
    """Non-streaming ``chat/completions`` caller used by the eval metrics.

    Usage::

        async with GigaChatJudge(JudgeConfig.from_env()) as judge:
            verdict = await judge.complete_json(prompt)

    Tests bypass TLS entirely by passing ``transport=httpx.MockTransport(...)``;
    in that mode no certificate files are required.
    """

    def __init__(
        self,
        cfg: JudgeConfig | None = None,
        *,
        transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
        sleep: SleepFn | None = None,
        jitter: JitterFn | None = None,
        max_attempts: int = MAX_ATTEMPTS,
    ) -> None:
        self.cfg = cfg or JudgeConfig.from_env()
        self._sleep: SleepFn = sleep or asyncio.sleep
        self._jitter: JitterFn = jitter or random.random
        self._max_attempts = max(1, max_attempts)
        self.calls = 0

        timeout = httpx.Timeout(
            connect=15.0, read=self.cfg.timeout, write=30.0, pool=15.0
        )
        if transport is not None:
            self._client = httpx.AsyncClient(transport=transport, timeout=timeout)
            return

        _files_present(self.cfg)
        try:
            verify = _build_verify(self.cfg)
        except ssl.SSLError as exc:  # bad passphrase / malformed PEM
            raise GigaChatTransportError(
                "GIGACHAT_TLS", "Не удалось загрузить сертификат/ключ", str(exc)
            ) from exc
        if self.cfg.key_passphrase or self.cfg.ca_path:
            self._client = httpx.AsyncClient(verify=verify, timeout=timeout)
        else:
            self._client = httpx.AsyncClient(
                cert=(self.cfg.cert_path, self.cfg.key_path),
                verify=verify,
                timeout=timeout,
            )

    async def __aenter__(self) -> "GigaChatJudge":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------------ #

    def _url(self) -> str:
        return f"{self.cfg.base_url.rstrip('/')}/chat/completions"

    def _body(
        self, prompt: str, system: str | None, temperature: float | None
    ) -> bytes:
        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        payload = {
            "model": self.cfg.model,
            "messages": messages,
            "temperature": (
                self.cfg.temperature if temperature is None else temperature
            ),
            "max_tokens": self.cfg.max_tokens,
            "stream": False,
        }
        # Cyrillic must go over the wire raw, not as \uXXXX escapes.
        return json.dumps(payload, ensure_ascii=False).encode("utf-8")

    async def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        temperature: float | None = None,
    ) -> str:
        """Send one prompt, return the assistant text (retrying 429/5xx)."""
        body = self._body(prompt, system, temperature)
        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
        }
        last_error: GigaChatEvalError | None = None

        for attempt in range(self._max_attempts):
            try:
                self.calls += 1
                resp = await self._client.post(
                    self._url(), content=body, headers=headers
                )
            except httpx.HTTPError as exc:
                last_error = GigaChatTransportError(
                    "GIGACHAT_TRANSPORT",
                    "Не удалось выполнить запрос к GigaChat",
                    str(exc) or exc.__class__.__name__,
                )
                if attempt + 1 >= self._max_attempts:
                    raise last_error from exc
                await self._sleep(self._backoff(attempt))
                continue

            status = resp.status_code
            if status == 200:
                return _first_choice_text(resp)

            retryable = status == 429 or 500 <= status < 600
            last_error = GigaChatHTTPError(
                f"GIGACHAT_HTTP_{status}",
                f"GigaChat вернул HTTP {status}",
                resp.text[:500],
            )
            if not retryable or attempt + 1 >= self._max_attempts:
                raise last_error
            delay = self._backoff(attempt)
            if status == 429:
                delay = max(delay, _retry_after(resp.headers.get("Retry-After")))
            await self._sleep(delay)

        raise last_error or GigaChatHTTPError(
            "GIGACHAT_UNKNOWN", "Запрос к GigaChat не удался"
        )

    async def complete_json(
        self,
        prompt: str,
        *,
        system: str | None = None,
        temperature: float | None = None,
    ) -> dict[str, Any]:
        """:meth:`complete` + :func:`extract_json`."""
        text = await self.complete(prompt, system=system, temperature=temperature)
        return extract_json(text)

    def _backoff(self, attempt: int) -> float:
        return BASE_BACKOFF_SECONDS * (2**attempt) * (1.0 + 0.25 * self._jitter())


def _retry_after(value: str | None) -> float:
    """Parse a ``Retry-After`` header in seconds; 0 when absent/garbage."""
    if not value:
        return 0.0
    try:
        return max(0.0, float(value.strip()))
    except ValueError:
        return 0.0


def _first_choice_text(resp: httpx.Response) -> str:
    """Pull ``choices[0].message.content`` out of an OpenAI-shaped response."""
    try:
        data = resp.json()
    except ValueError as exc:
        raise GigaChatJSONError(
            "GIGACHAT_BAD_RESPONSE",
            "Ответ GigaChat не является JSON",
            resp.text[:500],
        ) from exc
    choices = data.get("choices") or []
    if not choices:
        raise GigaChatHTTPError(
            "GIGACHAT_NO_CHOICES", "GigaChat вернул ответ без choices", resp.text[:500]
        )
    message = (choices[0] or {}).get("message") or {}
    return str(message.get("content", "") or "")
