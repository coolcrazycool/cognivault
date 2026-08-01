"""Eval-harness (план 5.3): golden-set → живой стек → метрики → отчёт.

Что делает прогон:

1. читает ``golden.jsonl`` (по умолчанию берутся все пары, кроме
   ``accepted: false`` — то есть непровалидированные ``null`` тоже идут в дело);
2. каждый вопрос уходит в UI-API ``POST /api/chat`` с ``rag: true``; SSE-поток
   разбирается в ответ + список ``sources``;
3. контекст для метрик берётся из ``rag_log.jsonl`` UI — там лежит **ровно тот**
   блок «Источники», который видела модель (``context_text``), плюс
   ``chunk_index`` каждого источника и снимок настроек прогона. Если лог
   недоступен, включается фолбэк: текст восстанавливается из метаданных через
   ``GET /api/vault/content``, и весь прогон помечается ПРИБЛИЖЁННЫМ;
4. считаются четыре судейские метрики (``metrics.py``); упавшие сэмплы
   в средние НЕ попадают и выносятся в отчёт отдельной строкой;
5. пишутся ``report-<label>.json`` и ``report-<label>.md``.

Сравнение прогонов::

    python3 tools/eval/run.py --label baseline
    python3 tools/eval/run.py --label wave-3
    python3 tools/eval/run.py --compare reports/report-baseline.json \\
                                        reports/report-wave-3.json

Абсолютные значения судьи не показательны — смысл только в дельте A/B, и
``--compare`` считает её **парно** (по одним и тем же вопросам) с разбросом и
числом пар, чтобы отличать сигнал от шума судьи.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
import statistics
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

import httpx

import gen_golden as gen_golden_mod
import metrics as metrics_mod
from gen_golden import BackendClient, BackendError, resolve_backend
from gigachat_client import GigaChatEvalError, GigaChatJudge, JudgeConfig
from metrics import METRIC_NAMES, aggregate, coverage, evaluate_sample

#: Печатается в шапке каждого отчёта — судья врёт в абсолютных числах.
REPORT_DISCLAIMER = (
    "**Абсолютным значениям метрик доверять нельзя.** Их выставляет та же "
    "LLM (GigaChat), что генерирует ответы, по судейским промптам: сдвиг "
    "калибровки, чувствительность к формулировке промпта и разброс между "
    "вызовами делают «0.78 faithfulness» числом без самостоятельного смысла. "
    "Осмысленна только **дельта между прогонами** этого же харнесса на том же "
    "golden-set и той же версии промптов судьи "
    "(`prompt_version`). Сравнивайте `--compare A.json B.json`, а не абсолют."
)

DIAGNOSTIC_RULE = (
    "**Правило диагностики (план, критерий Волны 5):** если нужный чанк был "
    "в контексте, а ответ неверен — чинить генерацию (промпт, порядок блоков, "
    "модель); если нужного чанка в контексте не было — чинить ретрив "
    "(поиск, гибрид, реранкер). За это отвечает метрика `retrieval_hit`: попала "
    "ли пара `(path, chunk_index)` из golden-пары в выданные источники "
    "(гранулярность падает до раздела/файла, если в golden-паре чанк не указан "
    "— см. `retrieval_granularity`)."
)

APPROXIMATE_WARNING = (
    "**ПРИБЛИЖЁННЫЙ ПРОГОН.** Текст контекста для части пар восстановлен из "
    "метаданных (`path`/`section_path`), а не взят из `rag_log.jsonl`. "
    "Восстановление смещает метрики В ОБЕ СТОРОНЫ: для `depth=\"chunk\"` в "
    "судью уходит целая секция (метрики завышаются), для `depth=\"file\"` — "
    "первые N символов файла (занижаются). Сдвиг зависит от состава `depth`, "
    "поэтому A/B-дельта между прогоном по логу и прогоном по метаданным "
    "недостоверна. Дайте харнессу `--rag-log <путь к rag_log.jsonl>`."
)

#: Уровни `retrieval_granularity`, на которых попадание засчитывается ГРУБЕЕ,
#: чем по паре ``(path, chunk_index)``: любой чанк того же раздела (или файла)
#: считается попаданием.
DEGRADED_GRANULARITIES = ("section", "file")

#: Печатается, когда хотя бы одна пара мерилась не на уровне чанка. Раньше это
#: было видно только по словарю `retrieval_granularity` в шапке — то есть
#: молча: число `retrieval_hit` выглядело точным, будучи завышенным.
GRANULARITY_WARNING = (
    "**`retrieval_hit` измерен НЕ на уровне чанка: {degraded} из {measured} "
    "пар.** У этих пар в golden-set нет `source_chunk_index`, поэтому "
    "попаданием считался любой чанк нужного раздела (`section`) или файла "
    "(`file`) — метрика ЗАВЫШЕНА относительно честного сравнения по паре "
    "`(path, chunk_index)`, и её нельзя сравнивать с прогоном, где чанк "
    "известен. Это ограничение генератора, а не сбой: `gen_golden.py` режет "
    "корпус собственным упрощённым сплиттером (H1–H3 + кап по символам), а "
    "бэкенд нумерует чанки по-своему (короткие секции сливаются, длинные "
    "режутся по бюджету токенов, таблицы — построчно, table-summary "
    "дописывается в хвост массива). Проставленный «на глаз» индекс давал бы "
    "ЛОЖНЫЕ ПРОМАХИ, что хуже честного огрубления, поэтому генератор пишет "
    "`null`. Поднять точность можно только вручную: проставить "
    "`source_chunk_index` в `golden.jsonl` по выдаче `/api/search`."
)

RETRIEVAL_KEY = "retrieval_hit"
REFUSAL_KEY = "refusal_ok"

#: Формулировки отказа («в источниках ответа нет») — ветка, которую меряют
#: golden-пары с ``expected_refusal``. Держать в согласии с `rag.SYSTEM_PROMPT`.
_REFUSAL_PATTERNS = (
    r"ответа\s+на\s+этот\s+вопрос\s+не\s+нашлось",
    r"в\s+доступных\s+мне\s+документах",
    r"в\s+базе\s+знаний\s+нет\s+данных",
    r"в\s+источниках\s+(?:нет|отсутству)",
    r"не\s+нашлось\s+ответа",
    r"информаци\w+\s+(?:нет|не\s+найдено)",
)
_REFUSAL_RE = re.compile("|".join(_REFUSAL_PATTERNS), re.IGNORECASE)


def is_refusal(answer: str, *, finish_reason: str | None = None) -> bool:
    """Ответил ли ассистент отказом «в источниках этого нет».

    Две улики: служебный ``finish_reason == "no_context"`` (грейдер не оставил
    ни одного фрагмента — генерации не было вовсе) и формулировка отказа из
    системного промпта.
    """
    if finish_reason == "no_context":
        return True
    return bool(_REFUSAL_RE.search(answer or ""))


# --------------------------------------------------------------------------- #
# SSE parsing (pure)
# --------------------------------------------------------------------------- #


class SSEDecoder:
    """Incremental SSE decoder: feed lines, get ``(event, data)`` tuples.

    Tolerant on purpose — an unknown/extra field is ignored and a ``data:``
    payload that is not JSON is surfaced as ``{"raw": "<text>"}`` rather than
    raising, so a malformed frame cannot abort a whole eval run.
    """

    def __init__(self) -> None:
        self._event: str | None = None
        self._data: list[str] = []

    def push(self, line: str) -> list[tuple[str, dict[str, Any]]]:
        """Feed one line (without trailing newline); return completed events."""
        stripped = line.rstrip("\r")
        if stripped == "":
            return self._flush()
        if stripped.startswith(":"):
            return []
        if stripped.startswith("event:"):
            self._event = stripped[len("event:") :].strip()
            return []
        if stripped.startswith("data:"):
            self._data.append(stripped[len("data:") :].lstrip())
            return []
        return []

    def close(self) -> list[tuple[str, dict[str, Any]]]:
        """Flush a trailing frame that was not terminated by a blank line."""
        return self._flush()

    def _flush(self) -> list[tuple[str, dict[str, Any]]]:
        if self._event is None and not self._data:
            return []
        payload = "\n".join(self._data)
        data: dict[str, Any]
        try:
            parsed = json.loads(payload) if payload else {}
            data = parsed if isinstance(parsed, dict) else {"value": parsed}
        except json.JSONDecodeError:
            data = {"raw": payload}
        event = self._event or "message"
        self._event = None
        self._data = []
        return [(event, data)]


def parse_sse(text: str) -> list[tuple[str, dict[str, Any]]]:
    """Parse a whole SSE body into ``[(event, data), ...]``."""
    decoder = SSEDecoder()
    out: list[tuple[str, dict[str, Any]]] = []
    for line in text.split("\n"):
        out.extend(decoder.push(line))
    out.extend(decoder.close())
    return out


@dataclass
class ChatOutcome:
    """Everything the harness needs from one ``/api/chat`` stream."""

    answer: str = ""
    sources: list[dict[str, Any]] = field(default_factory=list)
    chat_id: str = ""
    notice: str = ""
    finish_reason: str | None = None
    error: str = ""
    order: list[str] = field(default_factory=list)


def collect_chat(events: Iterable[tuple[str, dict[str, Any]]]) -> ChatOutcome:
    """Fold an SSE event stream into a :class:`ChatOutcome`.

    Reads the ``sources`` payload leniently (``.get`` only) — the contract is
    being extended (``grade``, ``url``, …) by other waves and must not break
    the harness.
    """
    outcome = ChatOutcome()
    for event, data in events:
        outcome.order.append(event)
        if event == "meta":
            outcome.chat_id = str(data.get("chat_id", "") or "")
        elif event == "sources":
            raw = data.get("sources")
            if isinstance(raw, list):
                outcome.sources = [s for s in raw if isinstance(s, dict)]
        elif event == "notice":
            outcome.notice = str(data.get("message", "") or "")
        elif event == "token":
            outcome.answer += str(data.get("text", "") or "")
        elif event == "done":
            outcome.finish_reason = data.get("finish_reason")
        elif event == "error":
            code = str(data.get("code", "") or "")
            message = str(data.get("message", "") or "")
            outcome.error = f"{code}: {message}".strip(": ")
    return outcome


# --------------------------------------------------------------------------- #
# Golden set
# --------------------------------------------------------------------------- #


def load_golden(path: str, *, include_rejected: bool = False) -> list[dict[str, Any]]:
    """Read golden.jsonl, dropping ``accepted: false`` rows unless asked."""
    rows: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{lineno}: не JSON ({exc})") from exc
            if not isinstance(row, dict):
                raise ValueError(f"{path}:{lineno}: строка не объект")
            if not include_rejected and row.get("accepted") is False:
                continue
            rows.append(row)
    return rows


# --------------------------------------------------------------------------- #
# Chat + context retrieval
# --------------------------------------------------------------------------- #


class ChatClient:
    """Thin SSE client for the UI's ``POST /api/chat`` (server mode: Bearer)."""

    def __init__(
        self,
        base_url: str,
        token: str = "",
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 300.0,
    ) -> None:
        self._base = (base_url or "").rstrip("/")
        headers = {"Accept": "text/event-stream"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.AsyncClient(
            headers=headers,
            transport=transport,
            timeout=httpx.Timeout(connect=15.0, read=timeout, write=30.0, pool=15.0),
        )

    async def __aenter__(self) -> "ChatClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def ask(self, question: str, *, chat_id: str = "") -> ChatOutcome:
        """Ask one RAG question and fold the SSE stream into a outcome."""
        payload: dict[str, Any] = {
            "messages": [{"role": "user", "content": question}],
            "rag": True,
        }
        if chat_id:
            payload["chat_id"] = chat_id
        # Cyrillic goes over the wire raw, not as \uXXXX escapes.
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json; charset=utf-8"}

        decoder = SSEDecoder()
        events: list[tuple[str, dict[str, Any]]] = []
        async with self._client.stream(
            "POST", f"{self._base}/api/chat", content=body, headers=headers
        ) as resp:
            if resp.status_code != 200:
                raw = await resp.aread()
                detail = raw[:500].decode("utf-8", errors="replace")
                outcome = ChatOutcome()
                outcome.error = f"HTTP {resp.status_code}: {detail}"
                return outcome
            async for line in resp.aiter_lines():
                events.extend(decoder.push(line))
        events.extend(decoder.close())
        return collect_chat(events)


def slice_section(content: str, section_path: str, cap: int = 4000) -> str | None:
    """Slice the section named by the tail of ``section_path`` out of ``content``.

    Mirrors the UI's own section slicing closely enough for judging: find the
    heading whose text equals the last ``>``-segment, keep everything up to the
    next heading of the same or higher level, cap the result.
    """
    tail = section_path.split(">")[-1].strip().lower() if section_path else ""
    if not tail or not content:
        return None
    lines = content.splitlines()
    start = -1
    start_level = 0
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith("#"):
            continue
        level = len(stripped) - len(stripped.lstrip("#"))
        title = stripped.lstrip("#").strip().lower()
        if title == tail:
            start = index
            start_level = level
            break
    if start < 0:
        return None
    out: list[str] = [lines[start]]
    for line in lines[start + 1 :]:
        stripped = line.strip()
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            if level <= start_level:
                break
        out.append(line)
    text = "\n".join(out).strip()
    return text[:cap] if text else None


# --------------------------------------------------------------------------- #
# Context: the real thing from rag_log.jsonl, or an approximate rebuild
# --------------------------------------------------------------------------- #

#: Заголовок блока контекста (`rag._header`): `### Источник N: title — path…`.
_BLOCK_RE = re.compile(r"^###\s+Источник\s+\d+\s*:", re.MULTILINE)


def split_context_blocks(context_text: str) -> list[str]:
    """Разрезать отрендеренный блок «Источники» на отдельные фрагменты.

    Судейские метрики оценивают фрагменты по отдельности (`context_precision`
    считает долю релевантных), поэтому монолитный блок нужно вернуть в список.
    Разрез идёт по заголовкам `### Источник N:`; если их нет (пустой контекст
    или чужой рендер), возвращается один элемент.
    """
    text = (context_text or "").strip()
    if not text:
        return []
    bounds = [m.start() for m in _BLOCK_RE.finditer(text)]
    if not bounds:
        return [text]
    bounds.append(len(text))
    out: list[str] = []
    if bounds[0] > 0:  # преамбула до первого заголовка — не теряем
        head = text[: bounds[0]].strip()
        if head:
            out.append(head)
    for start, end in zip(bounds, bounds[1:]):
        block = text[start:end].strip()
        if block:
            out.append(block)
    return out


class RagLogIndex:
    """Записи ``rag_log.jsonl`` типа ``request``, разложенные по ``chat_id``.

    Лог — единственное место, где сохранён **фактический** контекст хода. Он
    же несёт ``chunk_index`` источников и снимок настроек, поэтому отчёт умеет
    зафиксировать параметры прогона.
    """

    def __init__(
        self, records: Iterable[dict[str, Any]] = (), path: str | None = None
    ) -> None:
        self._by_chat: dict[str, dict[str, Any]] = {}
        self._path = path
        self._mtime: float | None = None
        self.absorb(records)

    def absorb(self, records: Iterable[dict[str, Any]]) -> None:
        for record in records:
            if not isinstance(record, dict) or record.get("type") != "request":
                continue
            chat_id = str(record.get("chat_id", "") or "")
            if chat_id:
                self._by_chat[chat_id] = record

    def __len__(self) -> int:
        return len(self._by_chat)

    def get(self, chat_id: str) -> dict[str, Any] | None:
        """Запись хода; при промахе перечитывает файл (лог растёт по ходу прогона).

        Запись появляется в логе только когда ход ДОСЕЛЕ закончился, а харнесс
        спрашивает её сразу после стрима — поэтому снимок, снятый при старте,
        всегда пуст. Перечитываем при промахе, но только если файл изменился.
        """
        if not chat_id:
            return None
        record = self._by_chat.get(chat_id)
        if record is None and self.refresh():
            record = self._by_chat.get(chat_id)
        return record

    def refresh(self) -> bool:
        """Перечитать файл, если он изменился. ``True`` — что-то перечитали."""
        if not self._path:
            return False
        try:
            mtime = os.path.getmtime(self._path)
        except OSError:
            return False
        if self._mtime is not None and mtime <= self._mtime:
            return False
        self._mtime = mtime
        try:
            with open(self._path, "r", encoding="utf-8") as fh:
                self.absorb(parse_jsonl(fh.read()))
        except OSError:
            return False
        return True

    @classmethod
    def from_text(cls, text: str) -> "RagLogIndex":
        return cls(parse_jsonl(text))

    @classmethod
    def load(cls, path: str) -> "RagLogIndex | None":
        """Открыть лог; ``None`` — файла нет (значит, будет фолбэк)."""
        if not os.path.exists(path):
            return None
        index = cls(path=path)
        index.refresh()
        return index


def parse_jsonl(text: str) -> list[dict[str, Any]]:
    """Разобрать JSONL, молча пропуская битые строки (последняя может рваться)."""
    out: list[dict[str, Any]] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            out.append(parsed)
    return out


@dataclass
class ResolvedContext:
    """Контекст одного сэмпла + откуда он взялся."""

    contexts: list[str] = field(default_factory=list)
    origin: str = "none"  # rag_log | metadata | none
    sources: list[dict[str, Any]] = field(default_factory=list)
    error: str = ""

    @property
    def approximate(self) -> bool:
        """``True`` — контекст восстановлен, а не взят из лога."""
        return self.origin != "rag_log"


def context_from_log(record: dict[str, Any]) -> ResolvedContext | None:
    """Достать фактический контекст хода из записи лога.

    ``None`` — в записи нет ``context_text`` (старый UI): пусть решает фолбэк.
    Пустой контекст при ``rag_used`` — это НЕ ошибка: значит, ретрив честно
    ничего не дал, и метрики должны это увидеть.
    """
    if "context_text" not in record:
        return None
    sources = [s for s in (record.get("sources") or []) if isinstance(s, dict)]
    if record.get("context_truncated_in_log"):
        _log(f"  ! контекст хода {record.get('chat_id')} обрезан в логе")
    return ResolvedContext(
        contexts=split_context_blocks(str(record.get("context_text", "") or "")),
        origin="rag_log",
        sources=sources,
    )


async def rebuild_contexts(
    backend: BackendClient | None,
    sources: Sequence[dict[str, Any]],
    *,
    cache: dict[str, str],
    cap: int = 4000,
) -> ResolvedContext:
    """ФОЛБЭК: восстановить текст источников из метаданных.

    Работает только когда ``rag_log.jsonl`` недоступен. Section-level источники
    вырезаются из документа, file-level режутся по ``cap`` — и то и другое
    ЗАМЕТНО расходится с тем, что видела модель (см. :data:`APPROXIMATE_WARNING`),
    поэтому такой прогон помечается приближённым.

    Ошибка бэкенда больше не «деградирует до заголовка»: раньше это давало
    судье пустой контекст, нули уезжали в среднее и читались как регрессия.
    Теперь сэмпл получает ``error`` и выбывает из агрегатов.
    """
    resolved = ResolvedContext(origin="metadata", sources=list(sources))
    failures: list[str] = []
    for source in sources:
        path = str(source.get("path", "") or "")
        section_path = str(source.get("section_path", "") or "")
        header = " > ".join(x for x in (path, section_path) if x)
        if not path or backend is None:
            failures.append(f"{path or '(без пути)'}: текст недоступен")
            continue
        if path not in cache:
            try:
                cache[path] = await backend.content(path)
            except (BackendError, httpx.HTTPError) as exc:
                cache[path] = ""
                _log(f"  ! контекст {path}: {exc}")
        content = cache.get(path, "")
        if not content:
            failures.append(f"{path}: пустой ответ бэкенда")
            continue
        sliced = slice_section(content, section_path, cap) if section_path else None
        text = sliced or content[:cap]
        resolved.contexts.append(f"{header}\n{text}".strip())
    if failures:
        resolved.error = "context: " + "; ".join(failures[:5])
    return resolved


# --------------------------------------------------------------------------- #
# Run
# --------------------------------------------------------------------------- #


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def retrieval_hit(
    row: dict[str, Any], sources: Sequence[dict[str, Any]]
) -> tuple[bool | None, str]:
    """Попал ли нужный ФРАГМЕНТ в контекст, и с какой точностью это проверено.

    Возвращает ``(hit, granularity)``, где granularity — ``chunk`` / ``section``
    / ``file`` / ``none``.

    Правило по убыванию точности:

    1. ``chunk`` — golden-пара знает свой ``source_chunk_index``: сверяем пару
       ``(path, chunk_index)`` по ``chunk_indexes`` источника (лог их пишет).
       Блок с ``depth == "file"`` несёт весь документ, поэтому считается
       покрывающим любой чанк своего файла;
    2. ``section`` — чанк неизвестен, но известен ``section_path``: сверяем
       ``(path, section_path)``;
    3. ``file`` — совсем без чанка и раздела: старое пофайловое сравнение,
       помеченное как таковое (оно завышает hit — файл мог попасть другим
       фрагментом).

    ``None`` — у golden-пары нет ``source_path`` (например, вопрос-отказ),
    проверять нечего.
    """
    expected_path = str(row.get("source_path", "") or "")
    if not expected_path:
        return None, "none"

    own = [s for s in sources if str(s.get("path", "") or "") == expected_path]
    if not own:
        granularity = (
            "chunk"
            if row.get("source_chunk_index") is not None
            else ("section" if row.get("section_path") else "file")
        )
        return False, granularity

    expected_chunk = row.get("source_chunk_index")
    if isinstance(expected_chunk, int):
        for source in own:
            if source.get("depth") == "file":
                return True, "chunk"
            indexes = source.get("chunk_indexes")
            if not isinstance(indexes, list):
                single = source.get("chunk_index")
                indexes = [single] if isinstance(single, int) else []
            if expected_chunk in indexes:
                return True, "chunk"
        return False, "chunk"

    expected_section = str(row.get("section_path", "") or "").strip()
    if expected_section:
        for source in own:
            if source.get("depth") == "file":
                return True, "section"
            if str(source.get("section_path", "") or "").strip() == expected_section:
                return True, "section"
        return False, "section"

    return True, "file"


async def run_sample(
    row: dict[str, Any],
    *,
    chat: ChatClient,
    judge: GigaChatJudge,
    backend: BackendClient | None,
    cache: dict[str, str],
    context_cap: int,
    rag_log: RagLogIndex | None = None,
) -> dict[str, Any]:
    """Ask one golden question, judge the answer, return a report row.

    A sample that could not be produced end-to-end (chat error, unusable
    context) carries ``failed: True`` and empty ``metrics`` — :func:`build_report`
    keeps such rows out of every average instead of letting their zeros read as
    a regression.
    """
    question = str(row.get("question", "") or "")
    ground_truth = str(row.get("ground_truth", "") or "")
    expects_refusal = bool(row.get("expected_refusal"))
    started = time.perf_counter()
    sample: dict[str, Any] = {
        "id": row.get("id"),
        "kind": row.get("kind"),
        "question": question,
        "ground_truth": ground_truth,
        "source_path": row.get("source_path"),
        "source_chunk_index": row.get("source_chunk_index"),
        "section_path": row.get("section_path"),
        "expected_refusal": expects_refusal,
        "accepted": row.get("accepted"),
        "answer": "",
        "sources": [],
        "context_count": 0,
        "context_origin": "none",
        RETRIEVAL_KEY: None,
        "retrieval_granularity": "none",
        REFUSAL_KEY: None,
        "metrics": {},
        "error": "",
        "failed": False,
        "latency_ms": 0,
    }

    def fail(message: str) -> dict[str, Any]:
        sample["error"] = message
        sample["failed"] = True
        return sample

    try:
        outcome = await chat.ask(question)
    except httpx.HTTPError as exc:
        sample["latency_ms"] = int((time.perf_counter() - started) * 1000)
        return fail(f"chat transport: {exc}")

    sample["latency_ms"] = int((time.perf_counter() - started) * 1000)
    sample["answer"] = outcome.answer
    sample["chat_id"] = outcome.chat_id
    sample["notice"] = outcome.notice
    sample["finish_reason"] = outcome.finish_reason
    sample["event_order"] = outcome.order

    if outcome.error:
        return fail(outcome.error)

    # Контекст: сперва фактический из лога, иначе — приближённое восстановление.
    record = rag_log.get(outcome.chat_id) if rag_log is not None else None
    resolved = context_from_log(record) if record else None
    if resolved is None:
        resolved = await rebuild_contexts(
            backend, outcome.sources, cache=cache, cap=context_cap
        )
    if record is not None:
        sample["run_settings"] = record.get("settings")
        sample["timings_ms"] = record.get("timings_ms")

    # Метаданные источников: из лога они богаче (`chunk_index`), из SSE — беднее.
    sample["sources"] = resolved.sources or outcome.sources
    sample["context_count"] = len(resolved.contexts)
    sample["context_origin"] = resolved.origin
    sample[REFUSAL_KEY] = is_refusal(outcome.answer, finish_reason=outcome.finish_reason)
    hit, granularity = retrieval_hit(row, sample["sources"])
    sample[RETRIEVAL_KEY] = hit
    sample["retrieval_granularity"] = granularity

    if resolved.error:
        return fail(resolved.error)

    results = await evaluate_sample(
        judge,
        question=question,
        ground_truth=ground_truth,
        answer=outcome.answer,
        contexts=resolved.contexts,
    )
    sample["metrics"] = {name: result.to_dict() for name, result in results.items()}
    return sample


async def run_all(
    rows: Sequence[dict[str, Any]],
    *,
    chat: ChatClient,
    judge: GigaChatJudge,
    backend: BackendClient | None,
    concurrency: int,
    context_cap: int,
    rag_log: RagLogIndex | None = None,
) -> list[dict[str, Any]]:
    """Run every golden pair with bounded concurrency (GigaChat is fragile)."""
    semaphore = asyncio.Semaphore(max(1, concurrency))
    cache: dict[str, str] = {}
    out: list[dict[str, Any]] = [{} for _ in rows]
    done = 0

    async def worker(index: int, row: dict[str, Any]) -> None:
        nonlocal done
        async with semaphore:
            sample = await run_sample(
                row,
                chat=chat,
                judge=judge,
                backend=backend,
                cache=cache,
                context_cap=context_cap,
                rag_log=rag_log,
            )
            out[index] = sample
            done += 1
            mark = "!" if sample.get("failed") else "·"
            _log(f"  [{done}/{len(rows)}] {mark} {sample.get('id')}")

    await asyncio.gather(*(worker(i, row) for i, row in enumerate(rows)))
    return out


# --------------------------------------------------------------------------- #
# Report rendering (pure)
# --------------------------------------------------------------------------- #


def is_failed(sample: dict[str, Any]) -> bool:
    """Сэмпл, который не удалось довести до конца — не данные, а сбой прогона.

    Такие строки не участвуют ни в одном среднем: их нули — это «бэкенд лёг»,
    а не «качество упало». Число упавших идёт в отчёт отдельной строкой.
    """
    return bool(sample.get("failed") or sample.get("error"))


def successful(samples: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [s for s in samples if not is_failed(s)]


def retrieval_hit_rate(samples: Sequence[dict[str, Any]]) -> float | None:
    """Доля успешных пар, где нужный фрагмент попал в контекст."""
    hits = [
        s.get(RETRIEVAL_KEY)
        for s in successful(samples)
        if isinstance(s.get(RETRIEVAL_KEY), bool)
    ]
    if not hits:
        return None
    return round(sum(1 for v in hits if v) / len(hits), 4)


def refusal_rate(samples: Sequence[dict[str, Any]]) -> float | None:
    """Доля пар «ответа в корпусе нет», где ассистент честно отказался."""
    values = [
        s.get(REFUSAL_KEY)
        for s in successful(samples)
        if s.get("expected_refusal") and isinstance(s.get(REFUSAL_KEY), bool)
    ]
    if not values:
        return None
    return round(sum(1 for v in values if v) / len(values), 4)


def metric_values(samples: Sequence[dict[str, Any]], name: str) -> list[float]:
    """Оценки метрики по успешным сэмплам (для среднего и разброса)."""
    out: list[float] = []
    for sample in successful(samples):
        entry = (sample.get("metrics") or {}).get(name) or {}
        score = entry.get("score") if isinstance(entry, dict) else None
        if isinstance(score, (int, float)) and not isinstance(score, bool):
            out.append(float(score))
    return out


def dispersion(samples: Sequence[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Разброс каждой метрики по сэмплам: ``{mean, sd, n, stderr}``.

    Без него из отчёта нельзя понять, сколько «весит» дельта: среднее 0.72 по
    12 парам с sd 0.35 и по 80 парам с sd 0.05 — разные утверждения.
    """
    out: dict[str, dict[str, Any]] = {}
    for name in METRIC_NAMES:
        values = metric_values(samples, name)
        n = len(values)
        mean = round(sum(values) / n, 4) if n else None
        sd = round(statistics.stdev(values), 4) if n > 1 else (0.0 if n == 1 else None)
        stderr = round(sd / math.sqrt(n), 4) if sd is not None and n > 1 else None
        out[name] = {"mean": mean, "sd": sd, "n": n, "stderr": stderr}
    return out


def granularity_counts(samples: Sequence[dict[str, Any]]) -> dict[str, int]:
    """Чем именно мерился ``retrieval_hit`` — чанком, разделом или файлом."""
    out: dict[str, int] = {}
    for sample in successful(samples):
        key = str(sample.get("retrieval_granularity", "none") or "none")
        out[key] = out.get(key, 0) + 1
    return out


def granularity_degradation(samples: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Насколько огрублён ``retrieval_hit`` в этом прогоне.

    ``{degraded, measured, levels}``: сколько пар из измеренных засчитывались по
    разделу/файлу вместо чанка. Ноль ``degraded`` — прогон честно чанковый;
    всё остальное отчёт обязан сказать вслух (см. :data:`GRANULARITY_WARNING`),
    иначе завышенный `retrieval_hit` читается как точный.
    """
    levels = granularity_counts(samples)
    measured = sum(count for key, count in levels.items() if key != "none")
    degraded = sum(levels.get(key, 0) for key in DEGRADED_GRANULARITIES)
    return {"degraded": degraded, "measured": measured, "levels": levels}


def _granularity_label(report: dict[str, Any]) -> str:
    """``chunk: 3, section: 10`` — чем мерилась каждая пара."""
    levels = (report.get("retrieval_degradation") or {}).get("levels") or {}
    pairs = [(key, count) for key, count in sorted(levels.items()) if key != "none"]
    return ", ".join(f"{key}: {count}" for key, count in pairs) or "—"


def run_parameters(
    samples: Sequence[dict[str, Any]],
    *,
    judge_model: str,
    judge_temperature: float | None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Всё, без чего прогон не воспроизвести.

    Настройки отвечающей системы (модель, температура, ширина ретрива, порог
    грейдера, отпечатки промптов) берутся из снимка в ``rag_log.jsonl``. Если
    в одном прогоне они разные — это само по себе дефект прогона, поэтому в
    отчёт уезжает ``"(смешанные)"``, а не первое попавшееся значение.
    """
    seen: list[str] = []
    settings: Any = None
    for sample in samples:
        snapshot = sample.get("run_settings")
        if not isinstance(snapshot, dict):
            continue
        key = json.dumps(snapshot, ensure_ascii=False, sort_keys=True)
        if key not in seen:
            seen.append(key)
            settings = snapshot
    params: dict[str, Any] = {
        "judge_model": judge_model,
        "judge_temperature": judge_temperature,
        "judge_prompt_version": metrics_mod.PROMPT_VERSION,
        "golden_prompt_version": getattr(gen_golden_mod, "PROMPT_VERSION", None),
        "ui_settings": "(смешанные)" if len(seen) > 1 else settings,
    }
    params.update(extra or {})
    return params


def build_report(
    samples: Sequence[dict[str, Any]],
    *,
    label: str,
    golden_path: str,
    ui_url: str,
    judge_model: str,
    judge_temperature: float | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble the JSON report (the same dict is rendered to markdown)."""
    failed = [s for s in samples if is_failed(s)]
    ok = successful(samples)
    # Средние — ТОЛЬКО по успешным: у упавшего сэмпла нули означают «прогон
    # сломался», и в среднем они читались бы как регрессия качества.
    aggregates = aggregate(ok)
    aggregates[RETRIEVAL_KEY] = retrieval_hit_rate(samples)
    aggregates[REFUSAL_KEY] = refusal_rate(samples)
    origins: dict[str, int] = {}
    for sample in samples:
        key = str(sample.get("context_origin", "none") or "none")
        origins[key] = origins.get(key, 0) + 1
    approximate = any(
        sample.get("context_origin") not in (None, "rag_log")
        for sample in ok
        if sample.get("context_count")
    )
    return {
        "label": label,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "golden": golden_path,
        "ui_url": ui_url,
        "judge_model": judge_model,
        "prompt_version": metrics_mod.PROMPT_VERSION,
        "approximate": approximate,
        "context_origin": origins,
        "counts": {
            "total": len(samples),
            "failed": len(failed),
            "evaluated": len(ok),
        },
        "aggregate": aggregates,
        "dispersion": dispersion(samples),
        "coverage": coverage(ok),
        "retrieval_granularity": granularity_counts(samples),
        "retrieval_degradation": granularity_degradation(samples),
        "run_params": run_parameters(
            samples,
            judge_model=judge_model,
            judge_temperature=judge_temperature,
            extra=extra,
        ),
        "samples": list(samples),
        "extra": extra or {},
    }


def _fmt(value: Any) -> str:
    if isinstance(value, bool):
        return "да" if value else "нет"
    if isinstance(value, (int, float)):
        return f"{value:.3f}" if isinstance(value, float) else str(value)
    return "—" if value is None else str(value)


def _fmt_spread(entry: Any) -> str:
    """``mean ±sd (n)`` — одно значение без разброса ничего не говорит."""
    if not isinstance(entry, dict):
        return "—"
    mean, sd, n = entry.get("mean"), entry.get("sd"), entry.get("n", 0)
    if mean is None:
        return "—"
    tail = f" ±{sd:.3f}" if isinstance(sd, (int, float)) else ""
    return f"{mean:.3f}{tail} (n={n})"


def _render_run_params(report: dict[str, Any]) -> list[str]:
    """Секция «Параметры прогона» — всё, без чего результат не повторить."""
    params = report.get("run_params") or {}
    lines = ["## Параметры прогона", ""]
    lines.append(
        "Дельта между прогонами имеет смысл, только если всё ниже совпадает "
        "(кроме того, что вы намеренно меняете)."
    )
    lines.append("")
    lines.append("| Параметр | Значение |")
    lines.append("|---|---|")
    ui = params.get("ui_settings")
    rows: list[tuple[str, Any]] = [
        ("судья: модель", params.get("judge_model")),
        ("судья: температура", params.get("judge_temperature")),
        ("судья: версия промптов", params.get("judge_prompt_version")),
        ("генератор golden: версия промптов", params.get("golden_prompt_version")),
    ]
    if isinstance(ui, dict):
        giga = ui.get("gigachat") or {}
        rag_cfg = ui.get("rag") or {}
        prompts = ui.get("prompts") or {}
        rows.extend(
            [
                ("ответ: модель", giga.get("model")),
                ("ответ: температура", giga.get("temperature")),
                ("ответ: max_tokens", giga.get("max_tokens")),
                ("ретрив: ширина (rerank_candidates)", rag_cfg.get("rerank_candidates")),
                ("ретрив: режим", rag_cfg.get("mode")),
                ("грейдер: включён", rag_cfg.get("grader_enabled")),
                ("грейдер: порог", rag_cfg.get("grader_threshold")),
                ("грейдер: keep_top", rag_cfg.get("grader_keep_top")),
                ("condense включён", rag_cfg.get("condense_enabled")),
                ("бюджет контекста, симв.", rag_cfg.get("max_context_chars")),
                ("промпт system (отпечаток)", prompts.get("system") or "встроенный"),
                (
                    "промпт reminder (отпечаток)",
                    prompts.get("context_reminder") or "встроенный",
                ),
            ]
        )
    else:
        rows.append(("настройки UI", ui if ui else "не найдены (нет rag_log)"))
    for name, value in rows:
        lines.append(f"| {name} | `{_fmt(value)}` |")
    lines.append("")
    return lines


def render_report_md(report: dict[str, Any], *, max_rows: int = 200) -> str:
    """Render the markdown report: disclaimer → aggregates → per-sample table."""
    counts = report.get("counts", {})
    aggregates = report.get("aggregate", {})
    cover = report.get("coverage", {})
    spread = report.get("dispersion", {}) or {}
    lines: list[str] = []
    lines.append(f"# RAG eval — прогон `{report.get('label')}`")
    lines.append("")
    lines.append(f"> {REPORT_DISCLAIMER}")
    lines.append("")
    if report.get("approximate"):
        lines.append(f"> {APPROXIMATE_WARNING}")
        lines.append("")
    degradation = report.get("retrieval_degradation") or {}
    if degradation.get("degraded"):
        lines.append(
            "> "
            + GRANULARITY_WARNING.format(
                degraded=degradation.get("degraded", 0),
                measured=degradation.get("measured", 0),
            )
        )
        lines.append("")
    lines.append(f"- дата: `{report.get('generated_at')}`")
    lines.append(f"- golden-set: `{report.get('golden')}`")
    lines.append(f"- UI: `{report.get('ui_url')}`")
    lines.append(
        f"- судья: `{report.get('judge_model')}`, "
        f"промпты: `{report.get('prompt_version')}`"
    )
    lines.append(
        f"- пар: {counts.get('total', 0)} "
        f"(оценено {counts.get('evaluated', 0)}, ошибок {counts.get('failed', 0)})"
    )
    lines.append(
        f"- **упало и исключено из средних: {counts.get('failed', 0)}** "
        "(сбой чата или недоступный текст контекста — не качество)"
    )
    lines.append(f"- источник контекста: `{report.get('context_origin', {})}`")
    lines.append(
        f"- гранулярность `retrieval_hit`: `{report.get('retrieval_granularity', {})}`"
    )
    lines.append("")
    lines.extend(_render_run_params(report))
    lines.append("## Средние значения")
    lines.append("")
    lines.append("| Метрика | Значение | Разброс по сэмплам | Оценено пар |")
    lines.append("|---|---:|---|---:|")
    for name in METRIC_NAMES:
        lines.append(
            f"| {name} | {_fmt(aggregates.get(name))} "
            f"| {_fmt_spread(spread.get(name))} | {cover.get(name, 0)} |"
        )
    lines.append(
        f"| {RETRIEVAL_KEY} (доля успешных пар, где нужный фрагмент попал в контекст; "
        f"гранулярность — {_granularity_label(report)}) "
        f"| {_fmt(aggregates.get(RETRIEVAL_KEY))} | — | {counts.get('evaluated', 0)} |"
    )
    lines.append(
        f"| {REFUSAL_KEY} (доля пар «ответа нет в корпусе», где был отказ) "
        f"| {_fmt(aggregates.get(REFUSAL_KEY))} | — | "
        f"{sum(1 for s in report.get('samples', []) if s.get('expected_refusal'))} |"
    )
    lines.append("")
    lines.append(DIAGNOSTIC_RULE)
    lines.append("")
    lines.append("## По парам")
    lines.append("")
    lines.append(
        "| id | тип | чанк найден | faith | ans_rel | ctx_prec | ctx_rec | вопрос |"
    )
    lines.append("|---|---|---|---:|---:|---:|---:|---|")
    samples = list(report.get("samples", []))
    for sample in samples[:max_rows]:
        metrics = sample.get("metrics") or {}

        def score(name: str) -> str:
            entry = metrics.get(name) or {}
            return _fmt(entry.get("score") if isinstance(entry, dict) else None)

        question = str(sample.get("question", "")).replace("|", "\\|")
        if len(question) > 90:
            question = question[:90] + "…"
        lines.append(
            f"| {sample.get('id')} | {sample.get('kind')} "
            f"| {_fmt(sample.get(RETRIEVAL_KEY))} "
            f"| {score('faithfulness_ru')} | {score('answer_relevancy_ru')} "
            f"| {score('context_precision')} | {score('context_recall')} "
            f"| {question} |"
        )
    if len(samples) > max_rows:
        lines.append("")
        lines.append(f"_…ещё {len(samples) - max_rows} пар — см. JSON-отчёт._")

    failed = [s for s in samples if is_failed(s)]
    if failed:
        lines.append("")
        lines.append(f"## Упавшие пары ({len(failed)}) — исключены из средних")
        lines.append("")
        for sample in failed[:50]:
            lines.append(f"- `{sample.get('id')}`: {sample.get('error')}")
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Paired comparison
# --------------------------------------------------------------------------- #


def sample_scores(report: dict[str, Any], name: str) -> dict[str, float]:
    """``{sample_id: score}`` по успешным сэмплам — основа парного сравнения."""
    out: dict[str, float] = {}
    for sample in report.get("samples", []) or []:
        if not isinstance(sample, dict) or is_failed(sample):
            continue
        ident = sample.get("id")
        entry = (sample.get("metrics") or {}).get(name) or {}
        score = entry.get("score") if isinstance(entry, dict) else None
        if ident is not None and isinstance(score, (int, float)) and not isinstance(
            score, bool
        ):
            out[str(ident)] = float(score)
    return out


def paired_delta(
    report_a: dict[str, Any], report_b: dict[str, Any], name: str
) -> dict[str, Any]:
    """Парная дельта метрики: те же вопросы в обоих прогонах.

    Разность средних смешивает изменение качества с изменением СОСТАВА
    оценённых пар (в одном прогоне судья не ответил на три вопроса, в другом —
    на другие три). Парная дельта считается по пересечению id, поэтому состав
    из уравнения уходит, а остаток — собственно эффект.

    ``{delta, sd, n, stderr, значимость}``; ``n`` — число ПАР, а не сэмплов.
    """
    a = sample_scores(report_a, name)
    b = sample_scores(report_b, name)
    common = sorted(set(a) & set(b))
    deltas = [b[i] - a[i] for i in common]
    n = len(deltas)
    if not n:
        return {"delta": None, "sd": None, "n": 0, "stderr": None}
    mean = sum(deltas) / n
    sd = statistics.stdev(deltas) if n > 1 else 0.0
    stderr = sd / math.sqrt(n) if n > 1 else None
    return {
        "delta": round(mean, 4),
        "sd": round(sd, 4),
        "n": n,
        "stderr": round(stderr, 4) if stderr is not None else None,
    }


def delta_sign(delta: float | None, stderr: float | None, noise: float) -> str:
    """▲/▼ только когда сдвиг больше и шума судьи, и двух стандартных ошибок.

    Раньше знак ставился по одной константе 0.02 — при разбросе 0.3 по 12 парам
    это регулярно объявляло сигналом обычную дрожь судьи.
    """
    if delta is None:
        return "—"
    band = noise if stderr is None else max(noise, 2.0 * stderr)
    if abs(delta) < band:
        return "≈"
    return "▲" if delta > 0 else "▼"


def render_compare_md(
    report_a: dict[str, Any], report_b: dict[str, Any], *, noise: float = 0.02
) -> str:
    """Markdown diff table between two reports.

    Каждая метрика показывается со своим разбросом в обоих прогонах, парной
    дельтой по общим вопросам, числом пар и знаком, который учитывает
    стандартную ошибку, а не только фиксированный порог ``noise`` (он остаётся
    нижней границей: судья дрожит и на больших выборках).
    """
    label_a = str(report_a.get("label", "A"))
    label_b = str(report_b.get("label", "B"))
    agg_a = report_a.get("aggregate", {}) or {}
    agg_b = report_b.get("aggregate", {}) or {}
    spread_a = report_a.get("dispersion", {}) or {}
    spread_b = report_b.get("dispersion", {}) or {}

    lines: list[str] = []
    lines.append(f"# Сравнение прогонов: `{label_a}` → `{label_b}`")
    lines.append("")
    lines.append(f"> {REPORT_DISCLAIMER}")
    lines.append("")
    if report_a.get("approximate") or report_b.get("approximate"):
        lines.append(f"> {APPROXIMATE_WARNING}")
        lines.append("")
    if _granularity_label(report_a) != _granularity_label(report_b):
        lines.append(
            "> **ВНИМАНИЕ:** `retrieval_hit` в прогонах измерен с разной "
            f"точностью (`{_granularity_label(report_a)}` vs "
            f"`{_granularity_label(report_b)}`) — доля попаданий сравнима "
            "только при одинаковой гранулярности, её дельта ниже недостоверна."
        )
        lines.append("")
    if report_a.get("prompt_version") != report_b.get("prompt_version"):
        lines.append(
            "> **ВНИМАНИЕ:** прогоны сделаны разными версиями судейских промптов "
            f"(`{report_a.get('prompt_version')}` vs "
            f"`{report_b.get('prompt_version')}`) — дельта недостоверна."
        )
        lines.append("")
    if report_a.get("golden") != report_b.get("golden"):
        lines.append(
            "> **ВНИМАНИЕ:** прогоны сделаны на разных golden-set "
            f"(`{report_a.get('golden')}` vs `{report_b.get('golden')}`) — "
            "дельта недостоверна."
        )
        lines.append("")
    if _params_differ(report_a, report_b):
        lines.append(
            "> **ВНИМАНИЕ:** различаются параметры прогонов (модель/температура/"
            "ширина ретрива/порог грейдера/промпты) — см. «Параметры прогонов» "
            "ниже; дельта отражает их сумму, а не одно изменение."
        )
        lines.append("")

    lines.append(
        f"| Метрика | {label_a} | {label_b} | Δ (парная) | ±sd | пар | Знак |"
    )
    lines.append("|---|---|---|---:|---:|---:|:--:|")
    for name in METRIC_NAMES:
        pair = paired_delta(report_a, report_b, name)
        delta = pair["delta"]
        delta_text = f"{delta:+.3f}" if delta is not None else "—"
        sd_text = f"{pair['sd']:.3f}" if pair["sd"] is not None else "—"
        lines.append(
            f"| {name} | {_fmt_spread(spread_a.get(name))} "
            f"| {_fmt_spread(spread_b.get(name))} | {delta_text} | {sd_text} "
            f"| {pair['n']} | {delta_sign(delta, pair['stderr'], noise)} |"
        )
    # Доли (hit/refusal) парного разложения не имеют — только среднее по прогону.
    for name in (RETRIEVAL_KEY, REFUSAL_KEY):
        value_a, value_b = agg_a.get(name), agg_b.get(name)
        if isinstance(value_a, (int, float)) and isinstance(value_b, (int, float)):
            delta = round(float(value_b) - float(value_a), 4)
            delta_text, sign = f"{delta:+.3f}", delta_sign(delta, None, noise)
        else:
            delta_text, sign = "—", "—"
        lines.append(
            f"| {name} | {_fmt(value_a)} | {_fmt(value_b)} | {delta_text} | — | — "
            f"| {sign} |"
        )
    lines.append("")
    lines.append(
        "«пар» — число вопросов, оценённых В ОБОИХ прогонах; дельта считается "
        "только по ним, поэтому смена состава оценённых пар её не искажает. "
        "Знак ▲/▼ ставится, когда |Δ| больше и порога шума "
        f"({noise:.2f}), и двух стандартных ошибок парной дельты."
    )
    lines.append("")
    counts_a = report_a.get("counts", {}) or {}
    counts_b = report_b.get("counts", {}) or {}
    lines.append(
        f"Пар: {counts_a.get('total', 0)} → {counts_b.get('total', 0)}; "
        f"упало (исключено из средних): {counts_a.get('failed', 0)} → "
        f"{counts_b.get('failed', 0)}."
    )
    lines.append("")
    lines.append("## Параметры прогонов")
    lines.append("")
    lines.append(f"### `{label_a}`")
    lines.append("")
    lines.extend(_render_run_params(report_a)[2:])
    lines.append(f"### `{label_b}`")
    lines.append("")
    lines.extend(_render_run_params(report_b)[2:])
    lines.append(DIAGNOSTIC_RULE)
    lines.append("")
    return "\n".join(lines)


def _params_differ(report_a: dict[str, Any], report_b: dict[str, Any]) -> bool:
    """Отличаются ли параметры, влияющие на воспроизводимость."""
    def key(report: dict[str, Any]) -> str:
        params = dict(report.get("run_params") or {})
        return json.dumps(params, ensure_ascii=False, sort_keys=True, default=str)

    return bool(report_a.get("run_params")) and key(report_a) != key(report_b)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def _default_golden() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden.jsonl")


def _default_out_dir() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")


#: UI слушает 8787 (см. `bootstrap.print_instructions`, `run.sh`, Dockerfile).
DEFAULT_UI_URL = "http://localhost:8787"


def _default_rag_log() -> str:
    """``rag_log.jsonl`` того же пользователя, чей `config.json` читает харнесс."""
    root = os.environ.get("COGNIVAULT_UI_ROOT") or "~/.cognivault-ui"
    return os.path.join(os.path.expanduser(root), "rag_log.jsonl")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Прогнать golden-set через живой стек и посчитать метрики."
    )
    parser.add_argument("--golden", default=_default_golden(), help="путь к golden.jsonl")
    parser.add_argument("--label", default="baseline", help="метка прогона (имя отчёта)")
    parser.add_argument(
        "--ui-url",
        default=None,
        help=f"базовый URL UI (default: $COGNIVAULT_UI_URL или {DEFAULT_UI_URL})",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="Bearer-токен UI в server-режиме (default: $COGNIVAULT_UI_TOKEN)",
    )
    parser.add_argument("--limit", type=int, default=0, help="ограничить число пар (0 = все)")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=2,
        help="параллельных вопросов (держите маленьким — GigaChat)",
    )
    parser.add_argument("--out-dir", default=_default_out_dir(), help="куда писать отчёты")
    parser.add_argument(
        "--include-rejected",
        action="store_true",
        help="брать и пары с accepted: false",
    )
    parser.add_argument(
        "--backend-url", default=None, help="URL бэкенда CogniVault (для текста источников)"
    )
    parser.add_argument("--backend-token", default=None, help="Bearer-токен бэкенда")
    parser.add_argument(
        "--no-context-fetch",
        action="store_true",
        help="не тянуть текст источников (метрики по контексту станут бессмысленны)",
    )
    parser.add_argument(
        "--context-chars",
        type=int,
        default=4000,
        help="кап текста одного источника В ФОЛБЭКЕ (при прогоне по логу не нужен)",
    )
    parser.add_argument(
        "--rag-log",
        default=None,
        help=(
            "путь к rag_log.jsonl UI — оттуда берётся ФАКТИЧЕСКИЙ контекст хода "
            f"(default: $COGNIVAULT_UI_RAG_LOG или {_default_rag_log()})"
        ),
    )
    parser.add_argument(
        "--no-rag-log",
        action="store_true",
        help=(
            "не читать rag_log.jsonl — контекст восстанавливать из метаданных. "
            "Прогон будет помечен ПРИБЛИЖЁННЫМ и не сравним с прогоном по логу."
        ),
    )
    parser.add_argument("--config", default=None, help="путь к config.json UI")
    parser.add_argument(
        "--compare",
        nargs=2,
        metavar=("A.json", "B.json"),
        help="только сравнить два готовых JSON-отчёта и выйти",
    )
    return parser


def _resolve_ui(args: argparse.Namespace) -> tuple[str, str]:
    url = (
        args.ui_url or os.environ.get("COGNIVAULT_UI_URL") or DEFAULT_UI_URL
    ).rstrip("/")
    token = args.token or os.environ.get("COGNIVAULT_UI_TOKEN") or ""
    return url, token


def _resolve_rag_log(args: argparse.Namespace) -> RagLogIndex | None:
    """Открыть лог запросов UI; ``None`` — прогон пойдёт по фолбэку."""
    if args.no_rag_log:
        _log("rag-log отключён (--no-rag-log): прогон будет ПРИБЛИЖЁННЫМ")
        return None
    path = (
        args.rag_log
        or os.environ.get("COGNIVAULT_UI_RAG_LOG")
        or _default_rag_log()
    )
    index = RagLogIndex.load(path)
    if index is None:
        _log(
            f"ВНИМАНИЕ: {path} не найден — контекст будет восстанавливаться из "
            "метаданных, прогон помечен ПРИБЛИЖЁННЫМ (--rag-log укажет путь)"
        )
    else:
        _log(f"rag-log: {path} (записей на старте: {len(index)})")
    return index


def do_compare(args: argparse.Namespace) -> int:
    """Render (and persist) the diff table for two existing reports."""
    path_a, path_b = args.compare
    with open(path_a, "r", encoding="utf-8") as fh:
        report_a = json.load(fh)
    with open(path_b, "r", encoding="utf-8") as fh:
        report_b = json.load(fh)
    text = render_compare_md(report_a, report_b)
    print(text)
    os.makedirs(args.out_dir, exist_ok=True)
    out_path = os.path.join(
        args.out_dir,
        f"compare-{report_a.get('label', 'a')}-vs-{report_b.get('label', 'b')}.md",
    )
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(text)
    _log(f"diff-таблица: {out_path}")
    return 0


async def main_async(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.compare:
        return do_compare(args)

    try:
        rows = load_golden(args.golden, include_rejected=args.include_rejected)
    except (OSError, ValueError) as exc:
        _log(f"ОШИБКА: не удалось прочитать golden-set: {exc}")
        return 2
    if args.limit > 0:
        rows = rows[: args.limit]
    if not rows:
        _log("ОШИБКА: в golden-set нет пар (все accepted: false?)")
        return 2

    ui_url, ui_token = _resolve_ui(args)
    backend_url, backend_token = resolve_backend(
        args.backend_url, args.backend_token, args.config
    )
    cfg = JudgeConfig.from_env(args.config)

    _log(f"golden: {args.golden} — пар: {len(rows)}")
    _log(f"UI: {ui_url} (токен: {'есть' if ui_token else 'нет'})")
    _log(f"судья: {cfg.model} @ {cfg.base_url} (промпты {metrics_mod.PROMPT_VERSION})")

    try:
        judge = GigaChatJudge(cfg)
    except GigaChatEvalError as exc:
        _log(f"ОШИБКА GigaChat: {exc}")
        return 2

    rag_log_index = _resolve_rag_log(args)
    backend = None if args.no_context_fetch else BackendClient(backend_url, backend_token)
    chat = ChatClient(ui_url, ui_token)
    try:
        samples = await run_all(
            rows,
            chat=chat,
            judge=judge,
            backend=backend,
            concurrency=args.concurrency,
            context_cap=args.context_chars,
            rag_log=rag_log_index,
        )
    finally:
        await chat.aclose()
        await judge.aclose()
        if backend is not None:
            await backend.aclose()

    report = build_report(
        samples,
        label=args.label,
        golden_path=args.golden,
        ui_url=ui_url,
        judge_model=cfg.model,
        judge_temperature=cfg.temperature,
        extra={
            "concurrency": args.concurrency,
            "context_chars": args.context_chars,
            "context_fetch": not args.no_context_fetch,
            "rag_log": not args.no_rag_log and rag_log_index is not None,
            "judge_calls": judge.calls,
        },
    )

    os.makedirs(args.out_dir, exist_ok=True)
    json_path = os.path.join(args.out_dir, f"report-{args.label}.json")
    md_path = os.path.join(args.out_dir, f"report-{args.label}.md")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(render_report_md(report))

    _log(f"отчёты: {json_path}, {md_path}")
    for name, value in report["aggregate"].items():
        _log(f"  {name}: {_fmt(value)}")
    failed = report["counts"]["failed"]
    if failed:
        _log(f"  упало и исключено из средних: {failed}")
    if report.get("approximate"):
        _log("ВНИМАНИЕ: прогон ПРИБЛИЖЁННЫЙ — контекст восстановлен из метаданных")
    degradation = report.get("retrieval_degradation") or {}
    if degradation.get("degraded"):
        _log(
            f"ВНИМАНИЕ: retrieval_hit огрублён у {degradation['degraded']} из "
            f"{degradation['measured']} пар (нет source_chunk_index) — "
            f"гранулярность {_granularity_label(report)}, число ЗАВЫШЕНО"
        )
    _log("напоминание: абсолютные числа судьи не показательны — сравнивайте прогоны")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    return asyncio.run(main_async(argv))


if __name__ == "__main__":
    raise SystemExit(main())
