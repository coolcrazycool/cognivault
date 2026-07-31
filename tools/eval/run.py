"""Eval-harness (план 5.3): golden-set → живой стек → метрики → отчёт.

Что делает прогон:

1. читает ``golden.jsonl`` (по умолчанию берутся все пары, кроме
   ``accepted: false`` — то есть непровалидированные ``null`` тоже идут в дело);
2. каждый вопрос уходит в UI-API ``POST /api/chat`` с ``rag: true``; SSE-поток
   разбирается в ответ + список ``sources``;
3. текст источников подтягивается из бэкенда (``GET /api/vault/content``) —
   событие ``sources`` отдаёт только метаданные, самих чанков в нём нет,
   поэтому контекст для метрик восстанавливается по ``path``/``section_path``
   (это приближение, см. README);
4. считаются четыре судейские метрики (``metrics.py``), агрегируются средние;
5. пишутся ``report-<label>.json`` и ``report-<label>.md``.

Сравнение прогонов::

    python3 tools/eval/run.py --label baseline
    python3 tools/eval/run.py --label wave-3
    python3 tools/eval/run.py --compare reports/report-baseline.json \\
                                        reports/report-wave-3.json

Абсолютные значения судьи не показательны — смысл только в дельте A/B.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

import httpx

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
    "(поиск, гибрид, реранкер). За это отвечает метрика `retrieval_hit`: попал "
    "ли `source_path` из golden-пары в выданные источники."
)

RETRIEVAL_KEY = "retrieval_hit"


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


async def fetch_contexts(
    backend: BackendClient | None,
    sources: Sequence[dict[str, Any]],
    *,
    cache: dict[str, str],
    cap: int = 4000,
) -> list[str]:
    """Rebuild the text of each source (chunk text is not exposed over SSE).

    Section-level sources are sliced out of the document; file-level ones are
    capped. On any backend failure the source degrades to its header line so the
    judge at least sees which document was cited.
    """
    contexts: list[str] = []
    for source in sources:
        path = str(source.get("path", "") or "")
        section_path = str(source.get("section_path", "") or "")
        header = " > ".join(x for x in (path, section_path) if x)
        if not path or backend is None:
            contexts.append(header)
            continue
        if path not in cache:
            try:
                cache[path] = await backend.content(path)
            except (BackendError, httpx.HTTPError) as exc:
                cache[path] = ""
                _log(f"  ! контекст {path}: {exc}")
        content = cache.get(path, "")
        if not content:
            contexts.append(header)
            continue
        sliced = slice_section(content, section_path, cap) if section_path else None
        text = sliced or content[:cap]
        contexts.append(f"{header}\n{text}".strip())
    return contexts


# --------------------------------------------------------------------------- #
# Run
# --------------------------------------------------------------------------- #


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _retrieval_hit(row: dict[str, Any], sources: Sequence[dict[str, Any]]) -> bool | None:
    """Did the golden pair's own source document make it into the context?"""
    expected = str(row.get("source_path", "") or "")
    if not expected:
        return None
    return any(str(s.get("path", "") or "") == expected for s in sources)


async def run_sample(
    row: dict[str, Any],
    *,
    chat: ChatClient,
    judge: GigaChatJudge,
    backend: BackendClient | None,
    cache: dict[str, str],
    context_cap: int,
) -> dict[str, Any]:
    """Ask one golden question, judge the answer, return a report row."""
    question = str(row.get("question", "") or "")
    ground_truth = str(row.get("ground_truth", "") or "")
    started = time.perf_counter()
    sample: dict[str, Any] = {
        "id": row.get("id"),
        "kind": row.get("kind"),
        "question": question,
        "ground_truth": ground_truth,
        "source_path": row.get("source_path"),
        "section_path": row.get("section_path"),
        "accepted": row.get("accepted"),
        "answer": "",
        "sources": [],
        "context_count": 0,
        RETRIEVAL_KEY: None,
        "metrics": {},
        "error": "",
        "latency_ms": 0,
    }

    try:
        outcome = await chat.ask(question)
    except httpx.HTTPError as exc:
        sample["error"] = f"chat transport: {exc}"
        sample["latency_ms"] = int((time.perf_counter() - started) * 1000)
        return sample

    sample["latency_ms"] = int((time.perf_counter() - started) * 1000)
    sample["answer"] = outcome.answer
    sample["sources"] = outcome.sources
    sample["notice"] = outcome.notice
    sample["event_order"] = outcome.order
    sample[RETRIEVAL_KEY] = _retrieval_hit(row, outcome.sources)

    if outcome.error:
        sample["error"] = outcome.error
        return sample

    contexts = await fetch_contexts(backend, outcome.sources, cache=cache, cap=context_cap)
    sample["context_count"] = len(contexts)

    results = await evaluate_sample(
        judge,
        question=question,
        ground_truth=ground_truth,
        answer=outcome.answer,
        contexts=contexts,
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
            )
            out[index] = sample
            done += 1
            mark = "!" if sample.get("error") else "·"
            _log(f"  [{done}/{len(rows)}] {mark} {sample.get('id')}")

    await asyncio.gather(*(worker(i, row) for i, row in enumerate(rows)))
    return out


# --------------------------------------------------------------------------- #
# Report rendering (pure)
# --------------------------------------------------------------------------- #


def retrieval_hit_rate(samples: Sequence[dict[str, Any]]) -> float | None:
    """Fraction of samples whose golden document appeared in the sources."""
    values = [s.get(RETRIEVAL_KEY) for s in samples]
    hits = [v for v in values if isinstance(v, bool)]
    if not hits:
        return None
    return round(sum(1 for v in hits if v) / len(hits), 4)


def build_report(
    samples: Sequence[dict[str, Any]],
    *,
    label: str,
    golden_path: str,
    ui_url: str,
    judge_model: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble the JSON report (the same dict is rendered to markdown)."""
    failed = [s for s in samples if s.get("error")]
    aggregates = aggregate(samples)
    aggregates[RETRIEVAL_KEY] = retrieval_hit_rate(samples)
    return {
        "label": label,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "golden": golden_path,
        "ui_url": ui_url,
        "judge_model": judge_model,
        "prompt_version": metrics_mod.PROMPT_VERSION,
        "counts": {
            "total": len(samples),
            "failed": len(failed),
            "evaluated": len(samples) - len(failed),
        },
        "aggregate": aggregates,
        "coverage": coverage(samples),
        "samples": list(samples),
        "extra": extra or {},
    }


def _fmt(value: Any) -> str:
    if isinstance(value, bool):
        return "да" if value else "нет"
    if isinstance(value, (int, float)):
        return f"{value:.3f}" if isinstance(value, float) else str(value)
    return "—" if value is None else str(value)


def render_report_md(report: dict[str, Any], *, max_rows: int = 200) -> str:
    """Render the markdown report: disclaimer → aggregates → per-sample table."""
    counts = report.get("counts", {})
    aggregates = report.get("aggregate", {})
    cover = report.get("coverage", {})
    lines: list[str] = []
    lines.append(f"# RAG eval — прогон `{report.get('label')}`")
    lines.append("")
    lines.append(f"> {REPORT_DISCLAIMER}")
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
    lines.append("")
    lines.append("## Средние значения")
    lines.append("")
    lines.append("| Метрика | Значение | Оценено пар |")
    lines.append("|---|---:|---:|")
    for name in METRIC_NAMES:
        lines.append(
            f"| {name} | {_fmt(aggregates.get(name))} | {cover.get(name, 0)} |"
        )
    lines.append(
        f"| {RETRIEVAL_KEY} (доля пар, где нужный документ попал в источники) "
        f"| {_fmt(aggregates.get(RETRIEVAL_KEY))} | {counts.get('total', 0)} |"
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

    failed = [s for s in samples if s.get("error")]
    if failed:
        lines.append("")
        lines.append("## Ошибки прогона")
        lines.append("")
        for sample in failed[:50]:
            lines.append(f"- `{sample.get('id')}`: {sample.get('error')}")
    lines.append("")
    return "\n".join(lines)


def render_compare_md(
    report_a: dict[str, Any], report_b: dict[str, Any], *, noise: float = 0.02
) -> str:
    """Markdown diff table between two reports: метрика, A, B, дельта, знак.

    ``noise`` is the band inside which a delta is reported as "≈" — judge
    scores wobble between runs and a 0.01 move is not a signal.
    """
    label_a = str(report_a.get("label", "A"))
    label_b = str(report_b.get("label", "B"))
    agg_a = report_a.get("aggregate", {}) or {}
    agg_b = report_b.get("aggregate", {}) or {}
    names = list(METRIC_NAMES) + [RETRIEVAL_KEY]

    lines: list[str] = []
    lines.append(f"# Сравнение прогонов: `{label_a}` → `{label_b}`")
    lines.append("")
    lines.append(f"> {REPORT_DISCLAIMER}")
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
    lines.append(f"| Метрика | {label_a} | {label_b} | Δ | Знак |")
    lines.append("|---|---:|---:|---:|:--:|")
    for name in names:
        value_a = agg_a.get(name)
        value_b = agg_b.get(name)
        if isinstance(value_a, (int, float)) and isinstance(value_b, (int, float)):
            delta = round(float(value_b) - float(value_a), 4)
            if abs(delta) < noise:
                sign = "≈"
            elif delta > 0:
                sign = "▲"
            else:
                sign = "▼"
            delta_text = f"{delta:+.3f}"
        else:
            delta, sign, delta_text = None, "—", "—"
        lines.append(
            f"| {name} | {_fmt(value_a)} | {_fmt(value_b)} | {delta_text} | {sign} |"
        )
    lines.append("")
    counts_a = report_a.get("counts", {}) or {}
    counts_b = report_b.get("counts", {}) or {}
    lines.append(
        f"Пар: {counts_a.get('total', 0)} → {counts_b.get('total', 0)}; "
        f"ошибок: {counts_a.get('failed', 0)} → {counts_b.get('failed', 0)}."
    )
    lines.append("")
    lines.append(DIAGNOSTIC_RULE)
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def _default_golden() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden.jsonl")


def _default_out_dir() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Прогнать golden-set через живой стек и посчитать метрики."
    )
    parser.add_argument("--golden", default=_default_golden(), help="путь к golden.jsonl")
    parser.add_argument("--label", default="baseline", help="метка прогона (имя отчёта)")
    parser.add_argument(
        "--ui-url",
        default=None,
        help="базовый URL UI (default: $COGNIVAULT_UI_URL или http://localhost:8080)",
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
        "--context-chars", type=int, default=4000, help="кап текста одного источника"
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
        args.ui_url
        or os.environ.get("COGNIVAULT_UI_URL")
        or "http://localhost:8080"
    ).rstrip("/")
    token = args.token or os.environ.get("COGNIVAULT_UI_TOKEN") or ""
    return url, token


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
        extra={
            "concurrency": args.concurrency,
            "context_chars": args.context_chars,
            "context_fetch": not args.no_context_fetch,
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
    _log("напоминание: абсолютные числа судьи не показательны — сравнивайте прогоны")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    return asyncio.run(main_async(argv))


if __name__ == "__main__":
    raise SystemExit(main())
