#!/usr/bin/env python3
"""Аудит стыка чанки → выдача: что поиск реально достаёт по золотому набору.

Инструмент берёт выгрузку чанков (`audit_chunk.ts --chunks`), строит по ней обе
стороны индекса — плотную и разреженную, — прогоняет ТРИ ветки, которые реализует
бэкенд (`src/features/search/service.ts`), и считает попадания против
`tools/eval/golden.jsonl`. Офлайн: ни Qdrant, ни GigaChat, ни живого стенда.

╔══════════════════════════════════════════════════════════════════════════════╗
║ МОДЕЛЬ НЕ ПРОДОВАЯ.                                                          ║
║ Плотные вектора считает `intfloat/multilingual-e5-base` — в проде эмбеддинги  ║
║ даёт GigaChat EmbeddingsGigaR по mTLS, и он офлайн недоступен. АБСОЛЮТНЫЕ     ║
║ ЧИСЛА В ПРОД НЕ ПЕРЕНОСЯТСЯ. Переносятся СРАВНЕНИЯ при прочих равных:        ║
║ ветка против ветки, категория против категории, корпус до правки против       ║
║ корпуса после. Читать отчёт как «продовый baseline» — ошибка.                 ║
╚══════════════════════════════════════════════════════════════════════════════╝

Что здесь настоящее, а что заменено
-----------------------------------
| слой              | здесь                                   | в проде                |
|-------------------|-----------------------------------------|------------------------|
| чанкер            | `src/lib/chunker.ts` (через audit_chunk) | он же                  |
| разреженный вектор| `src/lib/bm25.ts` (через sparse_vectors) | он же                  |
| IDF               | формула Qdrant 1.16 `fancy_idf`          | Qdrant, server-side    |
| слияние           | RRF Qdrant 1.16, k=2, позиция с нуля     | Qdrant, server-side    |
| глубины веток     | константы из `service.ts`                | они же                 |
| плотный вектор    | multilingual-e5-base                     | GigaChat EmbeddingsGigaR|

Три из четырёх слоёв — тот же код или та же формула. Заменён один: эмбеддер.

ЗАЧЕМ мерить это офлайн
-----------------------
Стыки 1 и 2 меряют промежуточное: сколько текста дошло, целы ли таблицы. Улучшение
там не обязано превращаться в улучшение выдачи — ровно это и проверяется здесь,
прогоном ОДНОЙ модели и ОДНОГО набора запросов по двум корпусам (до правок и после).
Живой стенд такой ответ дать не может: он один и он «сейчас».

Чего инструмент НЕ меряет (и не притворяется)
---------------------------------------------
* качество ответа модели — здесь нет генерации, только retrieval;
* работу грейдера/реранкера из UI — он делает скрытый вызов GigaChat, офлайн его нет;
* абсолютную полноту: золотой набор размечает ОДИН правильный документ на вопрос,
  поэтому «промах» иногда значит «нашёл другой не менее правильный». Числа сравнимы
  между собой, но не являются оценкой доли верных ответов;
* пороговый отказ по счёту, который вернёт API: `service.ts` перенормирует выдачу на
  топ (rank 1 → 1.0), так что видимый снаружи счёт первого места ВСЕГДА 1.0. Разделение
  ловушек и отвечаемых вопросов здесь считается по СЫРЫМ счётам ветки — это верхняя
  граница того, что порог мог бы дать, если бы сырой счёт вообще доезжал до клиента.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]

# Правила чтения золотого набора живут в харнессе `tools/eval/run.py`, и берутся
# ИМПОРТОМ, а не копией: строки `accepted: false` выбрасываются, пустая категория
# схлопывается в `unclassified`. Своя копия этих правил рано или поздно разъехалась бы
# с харнессом, и два отчёта по одному файлу считали бы разные наборы вопросов.
sys.path.insert(0, str(REPO_ROOT / "tools" / "eval"))
try:
    from run import category_of, load_golden  # type: ignore[import-not-found]
except ImportError as exc:  # pragma: no cover — окружение без зависимостей харнесса
    raise SystemExit(
        f"не импортируется tools/eval/run.py ({exc}). "
        "Нужны его зависимости (httpx); правила отбора golden-строк берутся оттуда, "
        "чтобы не разъехаться с харнессом."
    ) from exc


CAVEAT = (
    "МОДЕЛЬ НЕ ПРОДОВАЯ: плотные вектора считает multilingual-e5-base, в проде — "
    "GigaChat EmbeddingsGigaR. Абсолютные числа в прод не переносятся; переносятся "
    "сравнения при прочих равных: ветка против ветки, категория против категории, "
    "корпус до правки против корпуса после."
)

DEFAULT_MODEL = "intfloat/multilingual-e5-base"
#: e5 — асимметричная модель: вопрос и документ размечаются разными префиксами.
QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "
#: Окно e5. Чанк длиннее обрежется — сколько таких, инструмент считает и печатает.
MAX_SEQUENCE_TOKENS = 512

# --------------------------------------------------------------------------- #
# Константы поиска — списаны с `src/features/search/service.ts` и Qdrant 1.16
# --------------------------------------------------------------------------- #

#: `FUSION_OVERSAMPLE` из service.ts — во сколько раз ветка глубже внешнего лимита.
FUSION_OVERSAMPLE = 2
#: `FUSION_CANDIDATE_FLOOR` — нижняя граница глубины ветки.
FUSION_CANDIDATE_FLOOR = 40
#: `POST_FILTER_OVERFETCH` — запас на пост-фильтры (дедуп чанков, группировка разделов).
POST_FILTER_OVERFETCH = 2
#: `POST_FILTER_OVERFETCH_CAP` — потолок этого запаса.
POST_FILTER_OVERFETCH_CAP = 200
#: `_RERANK_CANDIDATES` из `cognivault-ui/app/rag.py` — сколько просит чат-конвейер.
DEFAULT_LIMIT = 40

#: `DEFAULT_RRF_K` из qdrant v1.16.3, `lib/segment/src/common/reciprocal_rank_fusion.rs`.
#: Проверено по исходнику, а не угадано: `position_score(pos, k) = 1 / (pos + k)`,
#: позиция считается С НУЛЯ, `fusion: "rrf"` без параметров берёт k = 2.
#: (Комментарий в `service.ts` описывает диапазон 0.016–0.033, что соответствует k = 60;
#: это расхождение вынесено в отчёт отдельной строкой.)
RRF_K = 2

#: Отсечки, по которым печатается hit@k.
HIT_KS = (1, 3, 5, 10)


# --------------------------------------------------------------------------- #
# Данные
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Chunk:
    """Строка выгрузки `audit_chunk.ts --chunks`."""

    path: str
    title: str
    chunk_index: int
    section_path: str
    parent_id: str
    content_kind: str
    tokens: int
    chars: int
    text: str


@dataclass(frozen=True)
class Query:
    """Вопрос золотого набора, приведённый к тому, что нужно для замера."""

    id: str
    question: str
    category: str
    source_path: str | None
    section_path: str | None
    expected_refusal: bool


@dataclass
class BranchRun:
    """Выдача одной ветки на один вопрос."""

    ranked: list[int]
    """Индексы чанков после пост-фильтров, максимум `limit`."""
    raw_top_score: float
    """Сырой счёт первого места ДО перенормировки — единственное, на чём мог бы
    работать пороговый отказ."""


def load_chunks(path: Path) -> list[Chunk]:
    """Читает JSONL-выгрузку чанков. Порядок строк — порядок индексации."""
    chunks: list[Chunk] = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{lineno}: не JSON ({exc})") from exc
            chunks.append(
                Chunk(
                    path=str(row["path"]),
                    title=str(row.get("title", "")),
                    chunk_index=int(row.get("chunk_index", 0)),
                    section_path=str(row.get("section_path", "")),
                    parent_id=str(row.get("parent_id", "")),
                    content_kind=str(row.get("content_kind", "text")),
                    tokens=int(row.get("tokens", 0)),
                    chars=int(row.get("chars", 0)),
                    text=str(row.get("text", "")),
                )
            )
    if not chunks:
        raise ValueError(f"{path}: пусто")
    return chunks


def to_queries(rows: Iterable[dict[str, Any]]) -> list[Query]:
    """golden-строки → вопросы замера, с теми же полями, что читает харнесс."""
    queries: list[Query] = []
    for row in rows:
        source = row.get("source_path")
        section = row.get("section_path")
        queries.append(
            Query(
                id=str(row.get("id", "")),
                question=str(row.get("question", "")),
                category=category_of(row),
                source_path=str(source) if source else None,
                section_path=str(section) if section else None,
                expected_refusal=bool(row.get("expected_refusal")),
            )
        )
    return queries


# --------------------------------------------------------------------------- #
# Разреженная сторона: настоящий `src/lib/bm25.ts` через npx tsx
# --------------------------------------------------------------------------- #


def sparse_vectors(texts: Sequence[str]) -> list[dict[str, list[float]]]:
    """Гоняет `sparse_vectors.ts` — то есть НАСТОЯЩИЙ `buildSparseVector`.

    Один вызов на весь набор: запуск tsx стоит секунды, и делать его на каждый текст
    было бы дороже самого счёта. Реализовать токенизацию на Python нельзя — расхождение
    со стеммером/стоп-словами/FNV было бы незаметным и сломало бы весь смысл замера.
    """
    script = REPO_ROOT / "tools" / "rag_audit" / "sparse_vectors.ts"
    with tempfile.TemporaryDirectory(prefix="rag-audit-sparse-") as tmp:
        in_path = Path(tmp) / "in.json"
        out_path = Path(tmp) / "out.json"
        in_path.write_text(json.dumps({"texts": list(texts)}), encoding="utf-8")
        result = subprocess.run(
            ["npx", "tsx", str(script), str(in_path), str(out_path)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise SystemExit(
                f"sparse_vectors.ts упал ({result.returncode}): {result.stderr[-2000:]}"
            )
        payload = json.loads(out_path.read_text(encoding="utf-8"))
    vectors = payload["vectors"]
    if len(vectors) != len(texts):
        raise SystemExit(f"sparse_vectors.ts вернул {len(vectors)} векторов на {len(texts)} текстов")
    return vectors


def fancy_idf(n: float, df: float) -> float:
    """IDF ровно как в Qdrant 1.16 (`query_context.rs::fancy_idf`).

    `ln((n - df + 0.5) / (df + 0.5) + 1)`. Считать её здесь приходится потому, что в
    проде IDF применяет сам Qdrant (`sparse_vectors: {bm25: {modifier: 'idf'}}`), а
    `bm25.ts` отдаёт только tf-часть. Вес умножается на IDF у ЗАПРОСА, не у документа —
    так это сделано в Qdrant, и от этого зависит счёт.
    """
    return math.log((n - df + 0.5) / (df + 0.5) + 1.0)


class SparseIndex:
    """Инвертированный индекс над разреженными векторами чанков.

    Счёт = скалярное произведение вектора документа на вектор запроса, у которого веса
    домножены на IDF, — то, что делает Qdrant для `idf-dot`.
    """

    def __init__(self, doc_vectors: Sequence[dict[str, list[float]]]) -> None:
        self.n_docs = len(doc_vectors)
        self.postings: dict[int, list[tuple[int, float]]] = {}
        for doc, vector in enumerate(doc_vectors):
            for index, value in zip(vector["indices"], vector["values"]):
                self.postings.setdefault(int(index), []).append((doc, float(value)))
        self.df = {index: len(posting) for index, posting in self.postings.items()}

    def scores(self, query_vector: dict[str, list[float]]) -> np.ndarray:
        out = np.zeros(self.n_docs, dtype=np.float64)
        for index, value in zip(query_vector["indices"], query_vector["values"]):
            posting = self.postings.get(int(index))
            if posting is None:
                continue
            weight = float(value) * fancy_idf(float(self.n_docs), float(self.df[int(index)]))
            for doc, doc_value in posting:
                out[doc] += weight * doc_value
        return out


# --------------------------------------------------------------------------- #
# Плотная сторона: e5 + кэш на диске
# --------------------------------------------------------------------------- #


class DenseEmbedder:
    """multilingual-e5-base со средним пулингом по маске и L2-нормировкой.

    Кэш на диске по ключу sha256(модель, текст): повторный прогон (а их будет два —
    корпус «до» и корпус «после», с большим пересечением текстов) не считает ничего
    заново. Кэш же гарантирует побитовую воспроизводимость отчёта — на MPS порядок
    сложений в батче не обязан совпадать между запусками.
    """

    def __init__(self, model_name: str, cache_path: Path, device: str | None = None) -> None:
        self.model_name = model_name
        self.cache_path = cache_path
        self._cache: dict[str, np.ndarray] = {}
        self._dirty = False
        self.truncated = 0
        self.computed = 0
        if cache_path.exists():
            with np.load(cache_path) as data:
                self._cache = {key: data[key] for key in data.files}
        self._device = device
        self._model = None
        self._tokenizer = None

    def _key(self, text: str) -> str:
        digest = hashlib.sha256()
        digest.update(self.model_name.encode("utf-8"))
        digest.update(b"\x00")
        digest.update(text.encode("utf-8"))
        return digest.hexdigest()

    def _load(self) -> None:
        if self._model is not None:
            return
        import torch  # локальный импорт: без него тул всё ещё умеет --help
        from transformers import AutoModel, AutoTokenizer

        if self._device is None:
            self._device = "mps" if torch.backends.mps.is_available() else "cpu"
        self._tokenizer = AutoTokenizer.from_pretrained(self.model_name)
        self._model = AutoModel.from_pretrained(self.model_name).to(self._device).eval()

    def embed(self, texts: Sequence[str], batch_size: int = 16) -> np.ndarray:
        missing = [text for text in texts if self._key(text) not in self._cache]
        # dict.fromkeys — уникальные, но в порядке появления: батчи детерминированы.
        missing = list(dict.fromkeys(missing))
        if missing:
            self._load()
            import torch

            assert self._tokenizer is not None and self._model is not None
            for start in range(0, len(missing), batch_size):
                batch = missing[start : start + batch_size]
                encoded = self._tokenizer(
                    batch,
                    padding=True,
                    truncation=True,
                    max_length=MAX_SEQUENCE_TOKENS,
                    return_tensors="pt",
                )
                lengths = encoded["attention_mask"].sum(dim=1)
                self.truncated += int((lengths >= MAX_SEQUENCE_TOKENS).sum())
                encoded = {key: value.to(self._device) for key, value in encoded.items()}
                with torch.no_grad():
                    output = self._model(**encoded).last_hidden_state
                mask = encoded["attention_mask"].unsqueeze(-1).to(output.dtype)
                pooled = (output * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1e-9)
                pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)
                vectors = pooled.to("cpu").numpy().astype(np.float32)
                for text, vector in zip(batch, vectors):
                    self._cache[self._key(text)] = vector
                self.computed += len(batch)
            self._dirty = True
        return np.stack([self._cache[self._key(text)] for text in texts])

    def flush(self) -> None:
        if not self._dirty:
            return
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(self.cache_path, **self._cache)


# --------------------------------------------------------------------------- #
# Ветки поиска — повторяют `service.ts`
# --------------------------------------------------------------------------- #


def branch_limits(limit: int) -> tuple[int, int]:
    """(`fetchLimit`, `candidateLimit`) ровно по формулам `SearchService.hybrid`."""
    fetch_limit = min(limit * POST_FILTER_OVERFETCH, POST_FILTER_OVERFETCH_CAP)
    candidate_limit = max(fetch_limit * FUSION_OVERSAMPLE, FUSION_CANDIDATE_FLOOR)
    return fetch_limit, candidate_limit


def top_indices(scores: np.ndarray, limit: int, *, positive_only: bool = False) -> list[int]:
    """Топ-`limit` по убыванию счёта; ничьи разбираются по индексу чанка.

    Qdrant ничьи не разбирает вовсе («does not break ties»), то есть порядок внутри
    группы равных у него не определён. Здесь он зафиксирован — иначе отчёт перестал бы
    быть детерминированным; это осознанное отличие, а не воспроизведение.
    """
    order = np.lexsort((np.arange(len(scores)), -scores))
    result: list[int] = []
    for doc in order[: max(limit, 0)]:
        if positive_only and scores[doc] <= 0:
            break
        result.append(int(doc))
    return result


def rrf_fuse(rankings: Sequence[Sequence[int]], k: int = RRF_K) -> list[tuple[int, float]]:
    """RRF ровно как в qdrant 1.16: сумма `1 / (позиция + k)`, позиция С НУЛЯ.

    Возвращает пары (документ, счёт) по убыванию счёта; ничьи — по индексу документа
    (см. `top_indices` о том, почему у Qdrant тут ничего не определено).
    """
    scores: dict[int, float] = {}
    for ranking in rankings:
        for position, doc in enumerate(ranking):
            scores[doc] = scores.get(doc, 0.0) + 1.0 / (position + k)
    return sorted(scores.items(), key=lambda pair: (-pair[1], pair[0]))


def dedupe_sections(docs: Sequence[int], chunks: Sequence[Chunk]) -> list[int]:
    """`SearchService.dedupeSections`: от раздела остаётся лучший чанк.

    Ключ составной — `(path, parent_id)`: `parent_id` выводится из позиции раздела
    внутри файла и уникален только внутри него. Чанки без `parent_id` проходят насквозь.
    """
    seen: set[str] = set()
    kept: list[int] = []
    for doc in docs:
        chunk = chunks[doc]
        if not chunk.parent_id:
            kept.append(doc)
            continue
        key = f"{chunk.path} {chunk.parent_id}"
        if key in seen:
            continue
        seen.add(key)
        kept.append(doc)
    return kept


def dedupe_chunks(docs: Sequence[int], chunks: Sequence[Chunk]) -> list[int]:
    """`SearchService.dedupeChunks`: повтор пары `(path, chunk_index)` выбрасывается."""
    seen: set[str] = set()
    kept: list[int] = []
    for doc in docs:
        chunk = chunks[doc]
        key = f"{chunk.path}::{chunk.chunk_index}"
        if key in seen:
            continue
        seen.add(key)
        kept.append(doc)
    return kept


def post_filter(
    docs: Sequence[int], chunks: Sequence[Chunk], limit: int, group_by_section: bool
) -> list[int]:
    """Хвост `SearchService.hybrid`: дедуп чанков, группировка разделов, срез до limit.

    Применяется ко ВСЕМ трём веткам одинаково. В проде `semantic`/`lexical` группировки
    не делают — но их и не зовёт чат-конвейер, а сравнивать ветки имеет смысл только
    на одинаковом хвосте: иначе разница между ними частью объяснялась бы разной
    пост-обработкой, а не разной способностью найти документ.
    """
    result = dedupe_chunks(docs, chunks)
    if group_by_section:
        result = dedupe_sections(result, chunks)
    return result[:limit]


# --------------------------------------------------------------------------- #
# Метрики
# --------------------------------------------------------------------------- #


def first_relevant_rank(ranked: Sequence[int], relevant: set[int]) -> int | None:
    """Место (с единицы) первого релевантного документа, либо None."""
    for position, doc in enumerate(ranked, start=1):
        if doc in relevant:
            return position
    return None


def hit_at_k(ranks: Sequence[int | None], k: int) -> float:
    """Доля вопросов, у которых релевантный документ попал в первые `k`."""
    if not ranks:
        return 0.0
    return sum(1 for rank in ranks if rank is not None and rank <= k) / len(ranks)


def mean_reciprocal_rank(ranks: Sequence[int | None]) -> float:
    """MRR: среднее 1/место; вопрос без попадания даёт 0."""
    if not ranks:
        return 0.0
    return sum(0.0 if rank is None else 1.0 / rank for rank in ranks) / len(ranks)


def summarize_ranks(ranks: Sequence[int | None], ks: Sequence[int] = HIT_KS) -> dict[str, Any]:
    return {
        "n": len(ranks),
        "hit_at": {str(k): round(hit_at_k(ranks, k), 4) for k in ks},
        "mrr": round(mean_reciprocal_rank(ranks), 4),
        "found": sum(1 for rank in ranks if rank is not None),
    }


def group_by_category(
    pairs: Sequence[tuple[str, int | None]], ks: Sequence[int] = HIT_KS
) -> dict[str, dict[str, Any]]:
    """Разрез метрик по `category` — тот же ключ, что режет отчёт харнесса."""
    groups: dict[str, list[int | None]] = {}
    for category, rank in pairs:
        groups.setdefault(category, []).append(rank)
    return {category: summarize_ranks(ranks, ks) for category, ranks in sorted(groups.items())}


def roc_auc(positive: Sequence[float], negative: Sequence[float]) -> float | None:
    """Вероятность, что случайный отвечаемый вопрос получит счёт выше случайной ловушки.

    0.5 — популяции неразличимы, 1.0 — разделены полностью. Считается точно, перебором
    пар (наборы здесь десятки элементов), ничьи считаются за половину.
    """
    if not positive or not negative:
        return None
    wins = 0.0
    for p in positive:
        for n in negative:
            if p > n:
                wins += 1.0
            elif p == n:
                wins += 0.5
    return wins / (len(positive) * len(negative))


def best_threshold(positive: Sequence[float], negative: Sequence[float]) -> dict[str, Any] | None:
    """Лучший порог «счёт ниже — отказываемся» и его точность.

    Перебираются все счёта как кандидаты в порог; берётся тот, что максимизирует долю
    верных решений на обеих популяциях сразу.
    """
    if not positive or not negative:
        return None
    total = len(positive) + len(negative)
    best = None
    for threshold in sorted({*positive, *negative}):
        correct = sum(1 for p in positive if p >= threshold) + sum(
            1 for n in negative if n < threshold
        )
        accuracy = correct / total
        if best is None or accuracy > best["accuracy"]:
            best = {
                "threshold": round(threshold, 6),
                "accuracy": round(accuracy, 4),
                "answerable_kept": sum(1 for p in positive if p >= threshold),
                "answerable_total": len(positive),
                "traps_refused": sum(1 for n in negative if n < threshold),
                "traps_total": len(negative),
            }
    return best


def distribution(values: Sequence[float]) -> dict[str, Any]:
    if not values:
        return {"n": 0}
    ordered = sorted(values)
    return {
        "n": len(ordered),
        "min": round(ordered[0], 6),
        "p25": round(ordered[max(0, len(ordered) // 4)], 6),
        "median": round(statistics.median(ordered), 6),
        "p75": round(ordered[min(len(ordered) - 1, (3 * len(ordered)) // 4)], 6),
        "max": round(ordered[-1], 6),
        "mean": round(statistics.fmean(ordered), 6),
    }


# --------------------------------------------------------------------------- #
# Прогон
# --------------------------------------------------------------------------- #


@dataclass
class Corpus:
    chunks: list[Chunk]
    dense: np.ndarray
    sparse: SparseIndex
    by_path: dict[str, set[int]] = field(default_factory=dict)
    by_section: dict[tuple[str, str], set[int]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for doc, chunk in enumerate(self.chunks):
            self.by_path.setdefault(chunk.path, set()).add(doc)
            self.by_section.setdefault((chunk.path, chunk.section_path), set()).add(doc)


def run_branches(
    corpus: Corpus,
    dense_query: np.ndarray,
    sparse_query: dict[str, list[float]],
    limit: int,
    group_by_section: bool,
) -> dict[str, BranchRun]:
    """Три конфигурации на один вопрос: dense-only, bm25-only, hybrid RRF."""
    fetch_limit, candidate_limit = branch_limits(limit)

    dense_scores = corpus.dense @ dense_query  # оба вектора нормированы => косинус
    sparse_scores = corpus.sparse.scores(sparse_query)

    dense_ranked = top_indices(dense_scores, candidate_limit)
    # Пустой разреженный запрос (одни стоп-слова) ветки не даёт — как в `lexical()`.
    sparse_ranked = (
        top_indices(sparse_scores, candidate_limit, positive_only=True)
        if sparse_query["indices"]
        else []
    )

    rankings = [dense_ranked] + ([sparse_ranked] if sparse_ranked else [])
    fused = rrf_fuse(rankings)[:fetch_limit]

    runs: dict[str, BranchRun] = {}

    dense_final = post_filter(dense_ranked[:fetch_limit], corpus.chunks, limit, group_by_section)
    runs["dense"] = BranchRun(
        ranked=dense_final,
        raw_top_score=float(dense_scores[dense_ranked[0]]) if dense_ranked else 0.0,
    )

    sparse_final = post_filter(sparse_ranked[:fetch_limit], corpus.chunks, limit, group_by_section)
    runs["bm25"] = BranchRun(
        ranked=sparse_final,
        raw_top_score=float(sparse_scores[sparse_ranked[0]]) if sparse_ranked else 0.0,
    )

    hybrid_final = post_filter([doc for doc, _ in fused], corpus.chunks, limit, group_by_section)
    runs["hybrid"] = BranchRun(
        ranked=hybrid_final,
        raw_top_score=float(fused[0][1]) if fused else 0.0,
    )
    return runs


BRANCHES = ("dense", "bm25", "hybrid")


def evaluate(
    corpus: Corpus,
    queries: Sequence[Query],
    dense_queries: np.ndarray,
    sparse_queries: Sequence[dict[str, list[float]]],
    limit: int,
    group_by_section: bool,
) -> dict[str, Any]:
    """Полный прогон: выдача на каждый вопрос → метрики по веткам и категориям."""
    answerable = [q for q in queries if not q.expected_refusal and q.source_path]
    traps = [q for q in queries if q.expected_refusal]
    # `x23-meta` — вопрос о корпусе целиком, правильного документа у него нет по замыслу.
    no_path = [q for q in queries if not q.expected_refusal and not q.source_path]

    # Метка раздела может не существовать в ЭТОМ корпусе: правки конвертера вернули
    # потерянные подзаголовки, дерево разделов стало мельче, и часть меток золотого
    # набора указывает на раздел, которого больше нет. Такие строки исключаются из
    # разрезa по разделам ЯВНО и перечисляются в отчёте — засчитать их промахом значило
    # бы записать чинку в регрессию.
    section_rows = [q for q in answerable if q.section_path]
    reachable = [q for q in section_rows if (q.source_path, q.section_path) in corpus.by_section]
    unreachable = [q for q in section_rows if q not in reachable]

    per_query: list[dict[str, Any]] = []
    file_ranks: dict[str, list[int | None]] = {b: [] for b in BRANCHES}
    file_pairs: dict[str, list[tuple[str, int | None]]] = {b: [] for b in BRANCHES}
    section_ranks: dict[str, list[int | None]] = {b: [] for b in BRANCHES}
    section_pairs: dict[str, list[tuple[str, int | None]]] = {b: [] for b in BRANCHES}
    top_scores: dict[str, dict[str, list[float]]] = {
        b: {"answerable": [], "trap": []} for b in BRANCHES
    }

    for position, query in enumerate(queries):
        runs = run_branches(
            corpus, dense_queries[position], sparse_queries[position], limit, group_by_section
        )
        record: dict[str, Any] = {
            "id": query.id,
            "category": query.category,
            "expected_refusal": query.expected_refusal,
            "branches": {},
        }
        relevant_files = corpus.by_path.get(query.source_path or "", set())
        relevant_sections = corpus.by_section.get((query.source_path or "", query.section_path or ""), set())

        for branch in BRANCHES:
            run = runs[branch]
            file_rank = first_relevant_rank(run.ranked, relevant_files) if relevant_files else None
            section_rank = (
                first_relevant_rank(run.ranked, relevant_sections) if relevant_sections else None
            )
            record["branches"][branch] = {
                "file_rank": file_rank,
                "section_rank": section_rank,
                "raw_top_score": round(run.raw_top_score, 6),
                "top_path": corpus.chunks[run.ranked[0]].path if run.ranked else None,
            }
            if query in answerable:
                file_ranks[branch].append(file_rank)
                file_pairs[branch].append((query.category, file_rank))
                top_scores[branch]["answerable"].append(run.raw_top_score)
            if query in reachable:
                section_ranks[branch].append(section_rank)
                section_pairs[branch].append((query.category, section_rank))
            if query.expected_refusal:
                top_scores[branch]["trap"].append(run.raw_top_score)
        per_query.append(record)

    branches: dict[str, Any] = {}
    refusal: dict[str, Any] = {}
    for branch in BRANCHES:
        branches[branch] = {
            "file": summarize_ranks(file_ranks[branch]),
            "file_by_category": group_by_category(file_pairs[branch]),
            "section": summarize_ranks(section_ranks[branch]),
            "section_by_category": group_by_category(section_pairs[branch]),
        }
        positive = top_scores[branch]["answerable"]
        negative = top_scores[branch]["trap"]
        overlap = bool(positive and negative and max(negative) >= min(positive))
        refusal[branch] = {
            "answerable": distribution(positive),
            "traps": distribution(negative),
            "roc_auc": None if roc_auc(positive, negative) is None else round(roc_auc(positive, negative), 4),
            "separated": not overlap,
            "best_threshold": best_threshold(positive, negative),
        }

    return {
        "golden": {
            "rows": len(queries),
            "answerable": len(answerable),
            "refusal_traps": len(traps),
            "answerable_without_path": [q.id for q in no_path],
            "with_section_path": len(section_rows),
            "section_labels": [q.id for q in section_rows],
            "section_labels_reachable": len(reachable),
            "section_labels_missing_in_corpus": [q.id for q in unreachable],
        },
        "branches": branches,
        "refusal": refusal,
        "per_query": per_query,
    }


# --------------------------------------------------------------------------- #
# Печать
# --------------------------------------------------------------------------- #


def _fmt_row(name: str, stats: dict[str, Any]) -> str:
    hits = stats["hit_at"]
    return (
        f"{name:<16} n={stats['n']:<3} "
        f"hit@1 {hits['1']:.2f}  hit@3 {hits['3']:.2f}  "
        f"hit@5 {hits['5']:.2f}  hit@10 {hits['10']:.2f}  MRR {stats['mrr']:.3f}"
    )


def print_summary(report: dict[str, Any]) -> None:
    out = sys.stdout.write
    out("\n" + "=" * 78 + "\n")
    out("АУДИТ ВЫДАЧИ (стык 3). " + CAVEAT + "\n")
    out("=" * 78 + "\n")

    corpus = report["corpus"]
    retrieval = report["retrieval"]
    golden = report["golden"]
    truncated = corpus["truncated_for_model"]
    truncated_text = (
        "не измерено, всё из кэша" if truncated is None else f"обрезано под 512 токенов e5: {truncated}"
    )
    out(
        f"\nкорпус: {corpus['label']} — {corpus['chunks']} чанков, {corpus['files']} файлов"
        f" ({truncated_text})\n"
    )
    out(
        f"поиск: limit={retrieval['limit']}, fetch={retrieval['fetch_limit']}, "
        f"глубина ветки={retrieval['candidate_limit']}, RRF k={retrieval['rrf_k']} "
        f"(позиция с нуля), group_by_section={retrieval['group_by_section']}\n"
    )
    out(
        f"золотой набор: {golden['rows']} строк, отвечаемых {golden['answerable']}, "
        f"ловушек {golden['refusal_traps']}, без пути {golden['answerable_without_path']}\n"
    )

    out("\n=== ПОПАДАНИЕ ПО ФАЙЛУ (путь чанка = source_path) ===\n")
    for branch in BRANCHES:
        out(_fmt_row(branch, report["branches"][branch]["file"]) + "\n")

    out("\n=== ПОПАДАНИЕ ПО РАЗДЕЛУ (path + section_path) ===\n")
    if golden["section_labels_missing_in_corpus"]:
        out(
            f"метка раздела отсутствует в этом корпусе (исключены): "
            f"{', '.join(golden['section_labels_missing_in_corpus'])}\n"
        )
    for branch in BRANCHES:
        out(_fmt_row(branch, report["branches"][branch]["section"]) + "\n")

    out("\n=== ПО КАТЕГОРИЯМ (по файлу) ===\n")
    categories = sorted(report["branches"]["hybrid"]["file_by_category"])
    header = f"{'категория':<16}{'n':>3}  " + "  ".join(f"{b:>18}" for b in BRANCHES)
    out(header + "\n")
    out(f"{'':<16}{'':>3}  " + "  ".join(f"{'hit@1/hit@5/MRR':>18}" for _ in BRANCHES) + "\n")
    for category in categories:
        cells = []
        n = 0
        for branch in BRANCHES:
            stats = report["branches"][branch]["file_by_category"].get(category)
            if stats is None:
                cells.append(f"{'—':>18}")
                continue
            n = stats["n"]
            cells.append(
                f"{stats['hit_at']['1']:.2f}/{stats['hit_at']['5']:.2f}/{stats['mrr']:.3f}".rjust(18)
            )
        out(f"{category:<16}{n:>3}  " + "  ".join(cells) + "\n")

    out("\n=== ЛОВУШКИ ПРОТИВ ОТВЕЧАЕМЫХ: сырой счёт первого места ===\n")
    out(
        "перенормировка `rescaleToTop` делает видимый снаружи счёт первого места 1.0\n"
        "ВСЕГДА — цифры ниже это СЫРОЙ счёт ветки, то есть верхняя граница того, что\n"
        "порог мог бы дать, если бы сырой счёт вообще доезжал до клиента.\n"
    )
    for branch in BRANCHES:
        item = report["refusal"][branch]
        a, t = item["answerable"], item["traps"]
        out(f"\n{branch}:\n")
        out(
            f"  отвечаемые (n={a['n']}): min {a['min']:.4f}  медиана {a['median']:.4f}  max {a['max']:.4f}\n"
        )
        out(
            f"  ловушки    (n={t['n']}): min {t['min']:.4f}  медиана {t['median']:.4f}  max {t['max']:.4f}\n"
        )
        verdict = "РАЗДЕЛЕНЫ" if item["separated"] else "ПЕРЕСЕКАЮТСЯ"
        out(f"  AUC {item['roc_auc']}  →  популяции {verdict}\n")
        best = item["best_threshold"]
        if best:
            out(
                f"  лучший порог {best['threshold']}: точность {best['accuracy']:.2f} "
                f"(отвечаемых удержано {best['answerable_kept']}/{best['answerable_total']}, "
                f"ловушек отклонено {best['traps_refused']}/{best['traps_total']})\n"
            )

    delta = report.get("delta")
    if delta:
        out("\n=== ДО/ПОСЛЕ (этот корпус минус базовый) ===\n")
        out(f"базовый корпус: {delta['baseline_label']}\n")
        out("\nпо файлу:\n")
        for branch in BRANCHES:
            row = delta["branches"][branch]["file"]
            out(
                f"{branch:<10} hit@1 {row['hit_at']['1']:+.3f}  hit@5 {row['hit_at']['5']:+.3f}  "
                f"hit@10 {row['hit_at']['10']:+.3f}  MRR {row['mrr']:+.4f}\n"
            )
        out(
            f"\nпо разделу (общее подмножество, {len(delta['section_comparable_ids'])} вопросов):\n"
        )
        for branch in BRANCHES:
            row = delta["branches"][branch]["section"]
            was = delta["branches"][branch]["section_baseline"]
            now = delta["branches"][branch]["section_now"]
            out(
                f"{branch:<10} hit@1 {was['hit_at']['1']:.2f}→{now['hit_at']['1']:.2f} "
                f"({row['hit_at']['1']:+.3f})  "
                f"MRR {was['mrr']:.3f}→{now['mrr']:.3f} ({row['mrr']:+.4f})\n"
            )
        out("\nпо категориям (hit@5 / MRR, ветка hybrid):\n")
        for category, row in sorted(delta["branches"]["hybrid"]["file_by_category"].items()):
            out(f"  {category:<16} hit@5 {row['hit_at']['5']:+.3f}  MRR {row['mrr']:+.4f}\n")
        if delta.get("note"):
            out(f"\n{delta['note']}\n")

    timing = report["timing"]
    out(
        f"\nвремя: всего {timing['total_s']:.1f}s "
        f"(разреженные {timing['sparse_s']:.1f}s, плотные {timing['dense_s']:.1f}s, "
        f"поиск {timing['search_s']:.1f}s; посчитано векторов {timing['embeddings_computed']})\n"
    )


# --------------------------------------------------------------------------- #
# Сравнение с базовым отчётом
# --------------------------------------------------------------------------- #


def _delta_stats(new: dict[str, Any], old: dict[str, Any]) -> dict[str, Any]:
    return {
        "n": new["n"],
        "n_baseline": old["n"],
        "hit_at": {
            k: round(new["hit_at"][k] - old["hit_at"].get(k, 0.0), 4) for k in new["hit_at"]
        },
        "mrr": round(new["mrr"] - old["mrr"], 4),
    }


def section_stats_on(report: dict[str, Any], ids: set[str]) -> dict[str, dict[str, Any]]:
    """Метрики по разделам, пересчитанные на заданном наборе вопросов.

    Нужны для честной дельты: метка раздела, живая только в одном из корпусов, иначе
    сдвигала бы знаменатель, и «стало лучше» частью объяснялось бы сменой набора строк.
    """
    ranks: dict[str, list[int | None]] = {branch: [] for branch in BRANCHES}
    for record in report["per_query"]:
        if record["id"] not in ids:
            continue
        for branch in BRANCHES:
            ranks[branch].append(record["branches"][branch]["section_rank"])
    return {branch: summarize_ranks(ranks[branch]) for branch in BRANCHES}


def compute_delta(report: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    """Разница метрик с базовым отчётом, по веткам и по категориям.

    Сравнение честно только при совпадающих модели, лимите и наборе вопросов — они
    сверяются, и расхождение попадает в `note`, а не заминается.
    """
    notes: list[str] = []
    if report["model"]["name"] != baseline.get("model", {}).get("name"):
        notes.append("РАЗНЫЕ МОДЕЛИ — сравнение недействительно")
    if report["retrieval"] != baseline.get("retrieval"):
        notes.append("РАЗНЫЕ ПАРАМЕТРЫ ПОИСКА — сравнение недействительно")
    if report["golden"]["answerable"] != baseline.get("golden", {}).get("answerable"):
        notes.append("РАЗНЫЙ НАБОР ОТВЕЧАЕМЫХ ВОПРОСОВ")
    new_missing = set(report["golden"]["section_labels_missing_in_corpus"])
    old_missing = set(baseline["golden"]["section_labels_missing_in_corpus"])
    # Пересечение достижимых меток: строка `section` в дельте считается ТОЛЬКО на нём,
    # иначе разный знаменатель выдал бы себя за изменение качества.
    comparable = set(report["golden"].get("section_labels", [])) - new_missing - old_missing
    new_section = section_stats_on(report, comparable)
    old_section = section_stats_on(baseline, comparable)
    if new_missing != old_missing:
        notes.append(
            f"метки раздела {sorted(new_missing ^ old_missing)} живы только в одном из "
            f"корпусов; строка `section` пересчитана на общем подмножестве "
            f"({len(comparable)} вопросов)"
        )

    branches = {}
    for branch in BRANCHES:
        new_branch = report["branches"][branch]
        old_branch = baseline["branches"][branch]
        by_category = {}
        for category, stats in new_branch["file_by_category"].items():
            old_stats = old_branch["file_by_category"].get(category)
            if old_stats is None:
                continue
            by_category[category] = _delta_stats(stats, old_stats)
        branches[branch] = {
            "file": _delta_stats(new_branch["file"], old_branch["file"]),
            "file_by_category": by_category,
            "section": _delta_stats(new_section[branch], old_section[branch]),
            "section_now": new_section[branch],
            "section_baseline": old_section[branch],
        }
    return {
        "baseline_label": baseline["corpus"]["label"],
        "baseline_chunks": baseline["corpus"]["chunks"],
        "section_comparable_ids": sorted(comparable),
        "branches": branches,
        "note": "; ".join(notes),
    }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Стык 3: офлайновая оценка выдачи по золотому набору. " + CAVEAT,
    )
    parser.add_argument(
        "--chunks", required=True, type=Path, help="JSONL от `audit_chunk.ts --chunks`"
    )
    parser.add_argument(
        "--golden",
        type=Path,
        default=REPO_ROOT / "tools" / "eval" / "golden.jsonl",
        help="золотой набор (по умолчанию tools/eval/golden.jsonl)",
    )
    parser.add_argument("--out", required=True, type=Path, help="куда писать retrieval-report.json")
    parser.add_argument(
        "--cache", type=Path, default=Path("/tmp/audit/embeddings.npz"), help="кэш эмбеддингов"
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help="имя модели HuggingFace")
    parser.add_argument("--device", default=None, help="mps/cpu/cuda (по умолчанию — авто)")
    parser.add_argument(
        "--limit", type=int, default=DEFAULT_LIMIT, help="внешний лимит поиска (прод: 40)"
    )
    parser.add_argument(
        "--no-group-by-section",
        action="store_true",
        help="не схлопывать чанки одного раздела (прод-конвейер схлопывает)",
    )
    parser.add_argument("--label", default=None, help="имя корпуса в отчёте")
    parser.add_argument(
        "--baseline", type=Path, default=None, help="отчёт другого корпуса — посчитать дельту"
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    started = time.monotonic()

    chunks = load_chunks(args.chunks)
    queries = to_queries(load_golden(str(args.golden)))
    group_by_section = not args.no_group_by_section

    args.out.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.monotonic()
    doc_sparse = sparse_vectors([c.text for c in chunks])
    query_sparse = sparse_vectors([q.question for q in queries])
    sparse_s = time.monotonic() - t0

    t0 = time.monotonic()
    embedder = DenseEmbedder(args.model, args.cache, args.device)
    doc_dense = embedder.embed([PASSAGE_PREFIX + c.text for c in chunks])
    query_dense = embedder.embed([QUERY_PREFIX + q.question for q in queries])
    embedder.flush()
    dense_s = time.monotonic() - t0

    corpus = Corpus(chunks=chunks, dense=doc_dense, sparse=SparseIndex(doc_sparse))

    t0 = time.monotonic()
    result = evaluate(corpus, queries, query_dense, query_sparse, args.limit, group_by_section)
    search_s = time.monotonic() - t0

    fetch_limit, candidate_limit = branch_limits(args.limit)
    report: dict[str, Any] = {
        "tool": "cognivault-rag-audit/audit_retrieval",
        "format_version": 1,
        "caveat": CAVEAT,
        "not_measured": [
            "качество ответа модели (генерации здесь нет)",
            "грейдер/реранкер из UI (скрытый вызов GigaChat, офлайн недоступен)",
            "абсолютная полнота: размечен один правильный документ на вопрос",
        ],
        "model": {
            "name": args.model,
            "query_prefix": QUERY_PREFIX,
            "passage_prefix": PASSAGE_PREFIX,
            "max_sequence_tokens": MAX_SEQUENCE_TOKENS,
            "is_production_embedder": False,
            "production_embedder": "GigaChat EmbeddingsGigaR",
        },
        "corpus": {
            "label": args.label or str(args.chunks),
            "source": str(args.chunks),
            "chunks": len(chunks),
            "files": len({c.path for c in chunks}),
            # Считается только для тех текстов, что реально прогонялись через
            # токенизатор: при полном попадании в кэш число не измерено, и врать нулём
            # нельзя — это разные вещи.
            "truncated_for_model": embedder.truncated if embedder.computed else None,
            "truncation_note": (
                "чанк длиннее 512 токенов e5 обрезается; у продового эмбеддера окно своё, "
                "поэтому это ограничение локального замера, а не свойство прода"
            ),
        },
        "retrieval": {
            "limit": args.limit,
            "fetch_limit": fetch_limit,
            "candidate_limit": candidate_limit,
            "rrf_k": RRF_K,
            "rrf_position_base": 0,
            "group_by_section": group_by_section,
            "source_of_truth": "src/features/search/service.ts + qdrant v1.16.3",
        },
        **result,
    }

    if args.baseline is not None:
        baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
        report["delta"] = compute_delta(report, baseline)

    report["timing"] = {
        "sparse_s": round(sparse_s, 2),
        "dense_s": round(dense_s, 2),
        "search_s": round(search_s, 2),
        "total_s": round(time.monotonic() - started, 2),
        "embeddings_computed": embedder.computed,
    }

    args.out.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    print_summary(report)
    sys.stdout.write(f"\nотчёт: {args.out}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
