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
║ корпуса после, вариант против варианта. Читать отчёт как «продовый           ║
║ baseline» — ошибка.                                                          ║
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

ПЛАТФОРМА ВАРИАНТОВ
-------------------
Один замер = одна конфигурация (`Variant`): слияние (rrf / взвешенный rrf / dbsf /
одна ветка), глубины веток, трансформация запроса (плотная и разреженная стороны
раздельно), композиция текста документа, конвейер пост-обработки. Всё остальное
фиксировано, поэтому разница двух отчётов атрибутируется РОВНО одному решению.
Разреженная сторона любого варианта проходит через НАСТОЯЩИЙ `bm25.ts` — трансформы
меняют текст ДО векторизации, а не саму векторизацию. Вариант, трогающий плотную
сторону, помечается в отчёте: его вывод модельно-специфичен (e5 ≠ EmbeddingsGigaR);
вывод варианта, трогающего только bm25/слияние/пост-обработку, переносится в прод.

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
* абсолютную полноту: золотой набор размечает правильный документ (плюс
  необязательные `alt_source_paths`) на вопрос, поэтому «промах» иногда значит
  «нашёл другой не менее правильный». Числа сравнимы между собой, но не являются
  оценкой доли верных ответов;
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
from typing import Any, Callable, Iterable, Sequence

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
    "корпус до правки против корпуса после, вариант против варианта."
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
    #: Необязательное поле golden-строки: другие пути, попадание в которые тоже
    #: засчитывается (один и тот же факт живёт в нескольких документах). Строки без
    #: поля работают как раньше — кортеж просто пуст.
    alt_source_paths: tuple[str, ...] = ()


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
        alts = row.get("alt_source_paths") or []
        queries.append(
            Query(
                id=str(row.get("id", "")),
                question=str(row.get("question", "")),
                category=category_of(row),
                source_path=str(source) if source else None,
                section_path=str(section) if section else None,
                expected_refusal=bool(row.get("expected_refusal")),
                alt_source_paths=tuple(str(p) for p in alts if p),
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
    Трансформы вариантов меняют ТЕКСТ до этого вызова, но не сам вызов: разреженный
    вектор всегда считает продовый модуль.
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


class SparseMemo:
    """Кэш разреженных векторов по тексту, живущий один прогон.

    В свипе несколько вариантов почти всегда делят одни и те же тексты (вариант,
    меняющий только слияние, не меняет ни документы, ни запросы) — недостающие тексты
    собираются в ОДИН вызов tsx, повторные не стоят ничего.
    """

    def __init__(self) -> None:
        self._cache: dict[str, dict[str, list[float]]] = {}
        self.computed = 0

    def vectors(self, texts: Sequence[str]) -> list[dict[str, list[float]]]:
        missing = [t for t in dict.fromkeys(texts) if t not in self._cache]
        if missing:
            for text, vector in zip(missing, sparse_vectors(missing)):
                self._cache[text] = vector
            self.computed += len(missing)
        return [self._cache[t] for t in texts]


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

    Кэш на диске по ключу sha256(модель, текст): повторный прогон (а их будет много —
    корпус «до», корпус «после», каждый вариант свипа) не считает ничего заново.
    Вариант, не меняющий текст документов, попадает в кэш целиком. Кэш же гарантирует
    побитовую воспроизводимость отчёта — на MPS порядок сложений в батче не обязан
    совпадать между запусками.
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
        self._dirty = False


# --------------------------------------------------------------------------- #
# Платформа вариантов: реестры хуков
# --------------------------------------------------------------------------- #
#
# Вариант меняет ОДНО решение за раз; всё, что он может менять, объявлено здесь как
# именованный хук в реестре. Агент, проверяющий гипотезу, регистрирует свой хук в
# файле, который передаётся через `--hooks my_hooks.py`, — прод и сам инструмент при
# этом не трогаются. Неизвестное имя в спеке варианта — громкая ошибка, не молчаливый
# дефолт: опечатка в спеке иначе мерила бы не то, что задумано.


@dataclass
class StageContext:
    """Что видит стадия пост-обработки (и реранкер) помимо списка кандидатов."""

    query_text: str
    chunks: Sequence[Chunk]
    dense_docs: np.ndarray
    """Плотные вектора документов ЭТОГО варианта (нормированы; строка = чанк)."""
    dense_query: np.ndarray
    fused_scores: dict[int, float]
    """Сырой счёт слияния по документу — то, чем стадия может пользоваться как
    релевантностью."""
    limit: int


QueryTransform = Callable[[str], str]
DocComposer = Callable[[Chunk], str]
PostStage = Callable[[list[int], StageContext, dict[str, Any]], list[int]]
Reranker = Callable[[str, list[int], StageContext], list[int]]

QUERY_TRANSFORMS: dict[str, QueryTransform] = {}
DOC_COMPOSERS: dict[str, DocComposer] = {}
POST_STAGES: dict[str, PostStage] = {}
RERANKERS: dict[str, Reranker] = {}


def register_query_transform(name: str) -> Callable[[QueryTransform], QueryTransform]:
    """Хук «текст запроса → текст запроса». Применяется ДО векторизации; для
    разреженной стороны итоговый текст всё равно проходит через настоящий bm25.ts."""

    def wrap(fn: QueryTransform) -> QueryTransform:
        QUERY_TRANSFORMS[name] = fn
        return fn

    return wrap


def register_doc_composer(name: str) -> Callable[[DocComposer], DocComposer]:
    """Хук «чанк → текст, который индексируется» (отдельно для каждой стороны)."""

    def wrap(fn: DocComposer) -> DocComposer:
        DOC_COMPOSERS[name] = fn
        return fn

    return wrap


def register_post_stage(name: str) -> Callable[[PostStage], PostStage]:
    """Стадия пост-обработки: (кандидаты, контекст, параметры) → кандидаты."""

    def wrap(fn: PostStage) -> PostStage:
        POST_STAGES[name] = fn
        return fn

    return wrap


def register_reranker(name: str) -> Callable[[Reranker], Reranker]:
    """Реранкер: (текст запроса, кандидаты, контекст) → новый порядок (подмножество)."""

    def wrap(fn: Reranker) -> Reranker:
        RERANKERS[name] = fn
        return fn

    return wrap


# --- встроенные хуки: identity + по одному референсу на интерфейс ------------


@register_query_transform("identity")
def _qt_identity(text: str) -> str:
    return text


@register_query_transform("split_identifiers")
def _qt_split_identifiers(text: str) -> str:
    """Референс, доказывающий интерфейс: `snake_case` → слова. Настоящие трансформы
    (стоп-слова, инструкция, транслитерация) регистрируются через `--hooks`."""
    return text.replace("_", " ")


@register_doc_composer("as_indexed")
def _dc_as_indexed(chunk: Chunk) -> str:
    return chunk.text


@register_doc_composer("strip_breadcrumb")
def _dc_strip_breadcrumb(chunk: Chunk) -> str:
    """Референс: чанк без первой строки-крошки (если она равна `section_path`)."""
    crumb = chunk.section_path + "\n"
    if chunk.section_path and chunk.text.startswith(crumb):
        return chunk.text[len(crumb) :].lstrip("\n")
    return chunk.text


@register_doc_composer("prepend_title")
def _dc_prepend_title(chunk: Chunk) -> str:
    """Референс: заголовок файла повторён перед текстом чанка."""
    return f"{chunk.title}\n\n{chunk.text}" if chunk.title else chunk.text


# --------------------------------------------------------------------------- #
# Слияние
# --------------------------------------------------------------------------- #


def rrf_fuse(
    rankings: Sequence[Sequence[int]],
    k: float = RRF_K,
    weights: Sequence[float] | None = None,
) -> list[tuple[int, float]]:
    """RRF ровно как в qdrant 1.16: сумма `1 / (позиция + k)`, позиция С НУЛЯ.

    `weights` — взвешенный RRF: вклад ветки умножается на её вес (все 1.0 = формула
    Qdrant). Возвращает пары (документ, счёт) по убыванию счёта; ничьи — по индексу
    документа (см. `top_indices` о том, почему у Qdrant тут ничего не определено).
    """
    if weights is None:
        weights = [1.0] * len(rankings)
    if len(weights) != len(rankings):
        raise ValueError(f"весов {len(weights)} на {len(rankings)} веток")
    scores: dict[int, float] = {}
    for ranking, weight in zip(rankings, weights):
        for position, doc in enumerate(ranking):
            scores[doc] = scores.get(doc, 0.0) + weight / (position + k)
    return sorted(scores.items(), key=lambda pair: (-pair[1], pair[0]))


def normalize_scores(scores: Sequence[float], norm: str) -> list[float]:
    """Нормировка счётов ветки ВНУТРИ её списка кандидатов.

    `minmax`: (s − min) / (max − min); вырожденный список (все равны) — все 1.0,
    то есть «каждый кандидат — топ своей ветки», а не «каждый — дно».
    `zscore`: (s − mean) / σ (σ по популяции); σ = 0 — все 0.0.
    """
    if not scores:
        return []
    values = [float(s) for s in scores]
    if norm == "minmax":
        lo, hi = min(values), max(values)
        if hi <= lo:
            return [1.0] * len(values)
        return [(v - lo) / (hi - lo) for v in values]
    if norm == "zscore":
        mean = statistics.fmean(values)
        sd = statistics.pstdev(values)
        if sd == 0:
            return [0.0] * len(values)
        return [(v - mean) / sd for v in values]
    raise ValueError(f"неизвестная нормировка {norm!r} (minmax | zscore)")


def dbsf_fuse(
    branches: Sequence[Sequence[tuple[int, float]]],
    weights: Sequence[float] | None = None,
    norm: str = "minmax",
) -> list[tuple[int, float]]:
    """Слияние по нормированным счётам (Qdrant зовёт это семейство DBSF).

    Каждая ветка нормируется внутри своего списка кандидатов (`normalize_scores`),
    потом суммируется с весом. Документ, которого в ветке нет, вклада от неё не
    получает — «не найден» и «найден последним» различаются только при `minmax`,
    где дно списка тоже даёт 0. Ничьи — по индексу документа.
    """
    if weights is None:
        weights = [1.0] * len(branches)
    if len(weights) != len(branches):
        raise ValueError(f"весов {len(weights)} на {len(branches)} веток")
    fused: dict[int, float] = {}
    for branch, weight in zip(branches, weights):
        normed = normalize_scores([score for _, score in branch], norm)
        for (doc, _), value in zip(branch, normed):
            fused[doc] = fused.get(doc, 0.0) + weight * value
    return sorted(fused.items(), key=lambda pair: (-pair[1], pair[0]))


# --------------------------------------------------------------------------- #
# Спека варианта
# --------------------------------------------------------------------------- #

FUSION_MODES = ("rrf", "dbsf", "dense", "bm25")


@dataclass(frozen=True)
class FusionSpec:
    """Как сливать ветки. `dense`/`bm25` — вырожденные случаи из одной ветки."""

    mode: str = "rrf"
    k: float = RRF_K
    #: (вес dense, вес bm25); (1.0, 1.0) — то, что делает Qdrant без параметров.
    weights: tuple[float, float] = (1.0, 1.0)
    #: только для dbsf: minmax | zscore.
    norm: str = "minmax"


@dataclass(frozen=True)
class Variant:
    """Одна конфигурация ретривала. Всё, что не задано, — продовое поведение."""

    name: str
    fusion: FusionSpec = FusionSpec()
    #: Внешний лимит; None → CLI `--limit` (прод: 40).
    limit: int | None = None
    #: Глубины; None → формулы `service.ts` от лимита.
    fetch_limit: int | None = None
    candidate_limit: int | None = None
    #: Имена хуков из реестров.
    query_dense: str = "identity"
    query_sparse: str = "identity"
    doc_dense: str = "as_indexed"
    doc_sparse: str = "as_indexed"
    #: Конвейер пост-обработки; None → продовый (дедуп чанков + группировка разделов).
    post: tuple[tuple[str, dict[str, Any]], ...] | None = None


def _require_keys(raw: dict[str, Any], allowed: set[str], where: str) -> None:
    unknown = set(raw) - allowed
    if unknown:
        raise SystemExit(
            f"вариант: неизвестные ключи {sorted(unknown)} в {where} "
            f"(допустимы {sorted(allowed)}) — опечатка мерила бы дефолт молча"
        )


def _parse_fusion(raw: dict[str, Any]) -> FusionSpec:
    _require_keys(raw, {"mode", "k", "weights", "norm"}, "fusion")
    mode = str(raw.get("mode", "rrf"))
    if mode not in FUSION_MODES:
        raise SystemExit(f"вариант: fusion.mode {mode!r} не из {FUSION_MODES}")
    weights_raw = raw.get("weights")
    if weights_raw is None:
        weights = (1.0, 1.0)
    elif isinstance(weights_raw, dict):
        _require_keys(weights_raw, {"dense", "bm25"}, "fusion.weights")
        weights = (float(weights_raw.get("dense", 1.0)), float(weights_raw.get("bm25", 1.0)))
    else:
        if len(weights_raw) != 2:
            raise SystemExit("вариант: fusion.weights — [dense, bm25] или объект")
        weights = (float(weights_raw[0]), float(weights_raw[1]))
    norm = str(raw.get("norm", "minmax"))
    if norm not in ("minmax", "zscore"):
        raise SystemExit(f"вариант: fusion.norm {norm!r} не из (minmax, zscore)")
    return FusionSpec(mode=mode, k=float(raw.get("k", RRF_K)), weights=weights, norm=norm)


def _parse_post(raw: Sequence[Any]) -> tuple[tuple[str, dict[str, Any]], ...]:
    stages: list[tuple[str, dict[str, Any]]] = []
    for item in raw:
        if isinstance(item, str):
            name, params = item, {}
        elif isinstance(item, dict):
            name = str(item.get("stage", ""))
            params = {key: value for key, value in item.items() if key != "stage"}
        else:
            raise SystemExit(f"вариант: стадия {item!r} — строка или объект со 'stage'")
        if name not in POST_STAGES:
            raise SystemExit(
                f"вариант: неизвестная стадия {name!r} (есть {sorted(POST_STAGES)})"
            )
        if name == "rerank":
            impl = str(params.get("impl", "identity"))
            if impl not in RERANKERS:
                raise SystemExit(
                    f"вариант: неизвестный реранкер {impl!r} (есть {sorted(RERANKERS)})"
                )
        stages.append((name, params))
    return tuple(stages)


def parse_variant(raw: dict[str, Any]) -> Variant:
    """Спека (JSON/dict) → `Variant`. Любое неизвестное имя — громкая ошибка."""
    _require_keys(raw, {"name", "fusion", "depths", "query", "doc", "post"}, "спеке")
    name = str(raw.get("name", "")).strip()
    if not name:
        raise SystemExit("вариант: нужно имя (`name`) — оно идёт в отчёт и в файл")

    depths = raw.get("depths") or {}
    _require_keys(depths, {"limit", "fetch_limit", "candidate_limit"}, "depths")
    query = raw.get("query") or {}
    _require_keys(query, {"dense", "sparse"}, "query")
    doc = raw.get("doc") or {}
    _require_keys(doc, {"dense", "sparse"}, "doc")

    def _hook(table: dict[str, Any], value: Any, default: str, kind: str) -> str:
        hook_name = str(value) if value is not None else default
        if hook_name not in table:
            raise SystemExit(
                f"вариант: неизвестный {kind} {hook_name!r} (есть {sorted(table)})"
            )
        return hook_name

    return Variant(
        name=name,
        fusion=_parse_fusion(raw.get("fusion") or {}),
        limit=None if depths.get("limit") is None else int(depths["limit"]),
        fetch_limit=None if depths.get("fetch_limit") is None else int(depths["fetch_limit"]),
        candidate_limit=(
            None if depths.get("candidate_limit") is None else int(depths["candidate_limit"])
        ),
        query_dense=_hook(QUERY_TRANSFORMS, query.get("dense"), "identity", "query-трансформ"),
        query_sparse=_hook(QUERY_TRANSFORMS, query.get("sparse"), "identity", "query-трансформ"),
        doc_dense=_hook(DOC_COMPOSERS, doc.get("dense"), "as_indexed", "doc-композер"),
        doc_sparse=_hook(DOC_COMPOSERS, doc.get("sparse"), "as_indexed", "doc-композер"),
        post=None if raw.get("post") is None else _parse_post(raw["post"]),
    )


#: Встроенные варианты. `prod` — то, что делает бэкенд; остальные меняют одно решение.
_BUILTIN_VARIANT_SPECS: dict[str, dict[str, Any]] = {
    "prod": {"name": "prod"},
    "rrf-k60": {"name": "rrf-k60", "fusion": {"mode": "rrf", "k": 60}},
    "rrf-dense2x": {
        "name": "rrf-dense2x",
        "fusion": {"mode": "rrf", "weights": {"dense": 2.0, "bm25": 1.0}},
    },
    "dbsf": {"name": "dbsf", "fusion": {"mode": "dbsf", "norm": "minmax"}},
    "dense-only": {"name": "dense-only", "fusion": {"mode": "dense"}},
    "bm25-only": {"name": "bm25-only", "fusion": {"mode": "bm25"}},
}

#: Реестр вариантов: встроенные + зарегистрированные из `--hooks`.
VARIANTS: dict[str, dict[str, Any]] = dict(_BUILTIN_VARIANT_SPECS)


def register_variant(spec: dict[str, Any]) -> dict[str, Any]:
    """Регистрирует вариант по имени (для hooks-файлов). Спека валидируется сразу."""
    variant = parse_variant(spec)
    VARIANTS[variant.name] = spec
    return spec


def load_hooks(path: Path) -> None:
    """Исполняет hooks-файл: обычный Python-модуль, который импортирует
    `audit_retrieval` и зовёт `register_*`. Инструмент при этом не правится.
    """
    import importlib.util

    # При запуске скриптом модуль живёт как `__main__`; без этого alias хук
    # импортировал бы ВТОРУЮ копию модуля с пустыми реестрами.
    sys.modules.setdefault("audit_retrieval", sys.modules[__name__])
    spec = importlib.util.spec_from_file_location(f"rag_audit_hooks_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"не загружается hooks-файл {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


def variant_depths(variant: Variant, cli_limit: int) -> tuple[int, int, int]:
    """(limit, fetch_limit, candidate_limit): формулы `service.ts`, если не задано."""
    limit = variant.limit if variant.limit is not None else cli_limit
    fetch_limit, candidate_limit = branch_limits(limit)
    if variant.fetch_limit is not None:
        fetch_limit = variant.fetch_limit
    if variant.candidate_limit is not None:
        candidate_limit = variant.candidate_limit
    return limit, fetch_limit, candidate_limit


def variant_touches(variant: Variant) -> list[str]:
    """Какие стороны замера вариант трогает — от этого зависит переносимость вывода."""
    touches: list[str] = []
    if variant.query_dense != "identity" or variant.doc_dense != "as_indexed":
        touches.append("dense")
    if variant.query_sparse != "identity" or variant.doc_sparse != "as_indexed":
        touches.append("sparse")
    if variant.fusion != FusionSpec():
        touches.append("fusion")
    if variant.limit is not None or variant.fetch_limit is not None or variant.candidate_limit is not None:
        touches.append("depth")
    if variant.post is not None:
        touches.append("post")
    return touches


def transfer_note(touches: Sequence[str]) -> str:
    """Честная сноска: чей вывод переносится в прод, а чей — модельно-специфичен."""
    if "dense" in touches:
        return (
            "вариант трогает ПЛОТНУЮ сторону: вывод зависит от multilingual-e5-base и в "
            "прод (EmbeddingsGigaR) переносится только как гипотеза для живой проверки"
        )
    if touches:
        return (
            "вариант трогает только bm25/слияние/глубины/пост-обработку — эти слои в "
            "проде те же самые, вывод переносится"
        )
    return "продовая конфигурация (базовая точка сравнения)"


def variant_query_texts(variant: Variant, queries: Sequence[Query]) -> tuple[list[str], list[str]]:
    """(тексты для плотной стороны — с префиксом e5, тексты для разреженной).

    Трансформ применяется ДО префикса: префикс — свойство модели, а не запроса.
    Разреженный текст префикса не получает никогда — bm25 его не знает.
    """
    dense_fn = QUERY_TRANSFORMS[variant.query_dense]
    sparse_fn = QUERY_TRANSFORMS[variant.query_sparse]
    dense = [QUERY_PREFIX + dense_fn(q.question) for q in queries]
    sparse = [sparse_fn(q.question) for q in queries]
    return dense, sparse


def variant_doc_texts(variant: Variant, chunks: Sequence[Chunk]) -> tuple[list[str], list[str]]:
    """(тексты документов для плотной стороны — без префикса, он добавится при
    эмбеддинге; тексты для разреженной стороны)."""
    dense_fn = DOC_COMPOSERS[variant.doc_dense]
    sparse_fn = DOC_COMPOSERS[variant.doc_sparse]
    return [dense_fn(c) for c in chunks], [sparse_fn(c) for c in chunks]


def fuse_candidates(
    fusion: FusionSpec,
    dense_pairs: Sequence[tuple[int, float]],
    sparse_pairs: Sequence[tuple[int, float]],
) -> list[tuple[int, float]]:
    """Слияние двух веток по спеке. Пустая разреженная ветка (одни стоп-слова)
    выпадает из слияния вместе со своим весом — как в `hybrid()`."""
    if fusion.mode == "dense":
        return list(dense_pairs)
    if fusion.mode == "bm25":
        return list(sparse_pairs)
    branches: list[Sequence[tuple[int, float]]] = [dense_pairs]
    weights: list[float] = [fusion.weights[0]]
    if sparse_pairs:
        branches.append(sparse_pairs)
        weights.append(fusion.weights[1])
    if fusion.mode == "rrf":
        rankings = [[doc for doc, _ in branch] for branch in branches]
        return rrf_fuse(rankings, k=fusion.k, weights=weights)
    if fusion.mode == "dbsf":
        return dbsf_fuse(branches, weights=weights, norm=fusion.norm)
    raise ValueError(f"неизвестный режим слияния {fusion.mode!r}")


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
    """Продовый хвост `SearchService.hybrid` одним вызовом: дедуп чанков,
    группировка разделов, срез до limit. Вариантный конвейер (`apply_stages`)
    в дефолте делает ровно это же — функция оставлена как эталон для тестов."""
    result = dedupe_chunks(docs, chunks)
    if group_by_section:
        result = dedupe_sections(result, chunks)
    return result[:limit]


# --- стадии пост-обработки ---------------------------------------------------


@register_post_stage("dedupe_chunks")
def _stage_dedupe_chunks(docs: list[int], ctx: StageContext, params: dict[str, Any]) -> list[int]:
    return dedupe_chunks(docs, ctx.chunks)


@register_post_stage("group_by_section")
def _stage_group_by_section(
    docs: list[int], ctx: StageContext, params: dict[str, Any]
) -> list[int]:
    return dedupe_sections(docs, ctx.chunks)


@register_post_stage("dedupe_near")
def _stage_dedupe_near(docs: list[int], ctx: StageContext, params: dict[str, Any]) -> list[int]:
    """Референс дедупликации почти-дубликатов: точное совпадение нормализованного
    текста (casefold + схлопнутые пробелы). Настоящая близость (Жаккар по термам,
    косинус) регистрируется через `--hooks` своей стадией."""
    seen: set[str] = set()
    kept: list[int] = []
    for doc in docs:
        key = " ".join(ctx.chunks[doc].text.casefold().split())
        if key in seen:
            continue
        seen.add(key)
        kept.append(doc)
    return kept


@register_post_stage("mmr")
def _stage_mmr(docs: list[int], ctx: StageContext, params: dict[str, Any]) -> list[int]:
    """Референс MMR-диверсификации: жадно берётся argmax
    `λ·rel − (1−λ)·max_sim_к_выбранным`, rel — minmax-нормированный счёт слияния,
    sim — скалярное произведение плотных векторов (они нормированы = косинус).
    Параметр: `lambda` (по умолчанию 0.5). Ничьи достаются более раннему кандидату.
    """
    lam = float(params.get("lambda", 0.5))
    if len(docs) <= 1:
        return list(docs)
    rel_values = normalize_scores([ctx.fused_scores.get(doc, 0.0) for doc in docs], "minmax")
    rel = dict(zip(docs, rel_values))
    remaining = list(docs)
    selected = [remaining.pop(0)]
    while remaining:
        best: int | None = None
        best_score = -math.inf
        for doc in remaining:
            sim = max(float(ctx.dense_docs[doc] @ ctx.dense_docs[s]) for s in selected)
            score = lam * rel[doc] - (1.0 - lam) * sim
            if score > best_score:
                best, best_score = doc, score
        assert best is not None
        selected.append(best)
        remaining.remove(best)
    return selected


@register_reranker("identity")
def _rr_identity(query_text: str, docs: list[int], ctx: StageContext) -> list[int]:
    return docs


@register_post_stage("rerank")
def _stage_rerank(docs: list[int], ctx: StageContext, params: dict[str, Any]) -> list[int]:
    """Плагинный реранкер: `{"stage": "rerank", "impl": "имя"}`. Референс —
    `identity`. Возврат обязан быть перестановкой подмножества кандидатов, иначе
    реранкер мог бы молча ДОБАВЛЯТЬ документы, которых поиск не находил."""
    impl = str(params.get("impl", "identity"))
    fn = RERANKERS[impl]
    result = fn(ctx.query_text, list(docs), ctx)
    if len(result) != len(set(result)) or not set(result) <= set(docs):
        raise SystemExit(
            f"реранкер {impl!r} вернул не перестановку подмножества кандидатов"
        )
    return result


def apply_stages(
    docs: list[int], ctx: StageContext, stages: Sequence[tuple[str, dict[str, Any]]]
) -> list[int]:
    """Прогоняет конвейер стадий и режет до `ctx.limit` — срез ПОСЛЕ всех стадий,
    как в `hybrid()`: всё, что стадии выбрасывают, уже выброшено."""
    for name, params in stages:
        docs = POST_STAGES[name](docs, ctx, params)
    return docs[: ctx.limit]


def default_post_pipeline(group_by_section: bool) -> tuple[tuple[str, dict[str, Any]], ...]:
    """Продовый конвейер: дедуп чанков (+ группировка разделов, как её зовёт чат)."""
    stages: list[tuple[str, dict[str, Any]]] = [("dedupe_chunks", {})]
    if group_by_section:
        stages.append(("group_by_section", {}))
    return tuple(stages)


# --------------------------------------------------------------------------- #
# Метрики
# --------------------------------------------------------------------------- #


def first_relevant_rank(ranked: Sequence[int], relevant: set[int]) -> int | None:
    """Место (с единицы) первого релевантного документа, либо None."""
    for position, doc in enumerate(ranked, start=1):
        if doc in relevant:
            return position
    return None


def relevant_file_docs(by_path: dict[str, set[int]], query: Query) -> set[int]:
    """Чанки, попадание в которые засчитывается по файлу: `source_path` ЛИБО любой
    из `alt_source_paths`. Строки без поля работают как раньше (кортеж пуст)."""
    docs: set[int] = set()
    for path in (query.source_path, *query.alt_source_paths):
        if path:
            docs |= by_path.get(path, set())
    return docs


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
    variant: Variant,
    stages: Sequence[tuple[str, dict[str, Any]]],
    cli_limit: int,
    query_text: str = "",
) -> dict[str, BranchRun]:
    """Три конфигурации на один вопрос: dense-only, bm25-only и слияние варианта.

    `dense`/`bm25` считаются ВСЕГДА — это внутренние референсы, к которым вариантный
    `hybrid` можно приложить в том же отчёте. Конвейер пост-обработки применяется ко
    всем трём одинаково: разница между ветками должна объясняться способностью найти
    документ, а не разной пост-обработкой.
    """
    limit, fetch_limit, candidate_limit = variant_depths(variant, cli_limit)

    dense_scores = corpus.dense @ dense_query  # оба вектора нормированы => косинус
    sparse_scores = corpus.sparse.scores(sparse_query)

    dense_ranked = top_indices(dense_scores, candidate_limit)
    # Пустой разреженный запрос (одни стоп-слова) ветки не даёт — как в `lexical()`.
    sparse_ranked = (
        top_indices(sparse_scores, candidate_limit, positive_only=True)
        if sparse_query["indices"]
        else []
    )

    dense_pairs = [(doc, float(dense_scores[doc])) for doc in dense_ranked]
    sparse_pairs = [(doc, float(sparse_scores[doc])) for doc in sparse_ranked]
    fused = fuse_candidates(variant.fusion, dense_pairs, sparse_pairs)[:fetch_limit]

    def finish(pairs: Sequence[tuple[int, float]]) -> BranchRun:
        ctx = StageContext(
            query_text=query_text,
            chunks=corpus.chunks,
            dense_docs=corpus.dense,
            dense_query=dense_query,
            fused_scores=dict(pairs),
            limit=limit,
        )
        ranked = apply_stages([doc for doc, _ in pairs], ctx, stages)
        return BranchRun(ranked=ranked, raw_top_score=float(pairs[0][1]) if pairs else 0.0)

    return {
        "dense": finish(dense_pairs[:fetch_limit]),
        "bm25": finish(sparse_pairs[:fetch_limit]),
        "hybrid": finish(fused),
    }


BRANCHES = ("dense", "bm25", "hybrid")


def evaluate(
    corpus: Corpus,
    queries: Sequence[Query],
    dense_queries: np.ndarray,
    sparse_queries: Sequence[dict[str, list[float]]],
    variant: Variant,
    stages: Sequence[tuple[str, dict[str, Any]]],
    cli_limit: int,
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
            corpus,
            dense_queries[position],
            sparse_queries[position],
            variant,
            stages,
            cli_limit,
            query_text=query.question,
        )
        record: dict[str, Any] = {
            "id": query.id,
            "category": query.category,
            "expected_refusal": query.expected_refusal,
            "branches": {},
        }
        # Попадание по файлу: source_path ЛИБО любой из alt_source_paths.
        relevant_files = relevant_file_docs(corpus.by_path, query)
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
            "with_alt_paths": [q.id for q in answerable if q.alt_source_paths],
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


def _describe_fusion(fusion: dict[str, Any]) -> str:
    mode = fusion.get("mode", "rrf")
    if mode == "rrf":
        return f"rrf k={fusion.get('k')} weights={fusion.get('weights')}"
    if mode == "dbsf":
        return f"dbsf norm={fusion.get('norm')} weights={fusion.get('weights')}"
    return mode


def print_summary(report: dict[str, Any]) -> None:
    out = sys.stdout.write
    out("\n" + "=" * 78 + "\n")
    out("АУДИТ ВЫДАЧИ (стык 3). " + CAVEAT + "\n")
    out("=" * 78 + "\n")

    corpus = report["corpus"]
    retrieval = report["retrieval"]
    golden = report["golden"]
    variant = report.get("variant", {})
    truncated = corpus["truncated_for_model"]
    truncated_text = (
        "не измерено, всё из кэша" if truncated is None else f"обрезано под 512 токенов e5: {truncated}"
    )
    out(
        f"\nкорпус: {corpus['label']} — {corpus['chunks']} чанков, {corpus['files']} файлов"
        f" ({truncated_text})\n"
    )
    if variant:
        touches = ", ".join(variant.get("touches") or []) or "—"
        out(f"вариант: {variant.get('name')} (трогает: {touches})\n")
        out(f"  {variant.get('transfer')}\n")
    out(
        f"поиск: limit={retrieval['limit']}, fetch={retrieval['fetch_limit']}, "
        f"глубина ветки={retrieval['candidate_limit']}, "
        f"слияние={_describe_fusion(retrieval.get('fusion', {}))}, "
        f"пост={retrieval.get('post')}\n"
    )
    out(
        f"золотой набор: {golden['rows']} строк, отвечаемых {golden['answerable']}, "
        f"ловушек {golden['refusal_traps']}, без пути {golden['answerable_without_path']}"
        + (
            f", с alt-путями {golden['with_alt_paths']}"
            if golden.get("with_alt_paths")
            else ""
        )
        + "\n"
    )

    out("\n=== ПОПАДАНИЕ ПО ФАЙЛУ (путь чанка = source_path или alt_source_paths) ===\n")
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
        print_delta(delta, out)

    timing = report["timing"]
    out(
        f"\nвремя: всего {timing['total_s']:.1f}s "
        f"(разреженные {timing['sparse_s']:.1f}s, плотные {timing['dense_s']:.1f}s, "
        f"поиск {timing['search_s']:.1f}s; посчитано векторов {timing['embeddings_computed']})\n"
    )


def print_delta(delta: dict[str, Any], out: Callable[[str], Any]) -> None:
    out("\n=== ДЕЛЬТА (этот отчёт минус базовый) ===\n")
    out(f"базовый: {delta['baseline_label']}\n")
    if delta.get("config_diff"):
        out("отличия конфигурации (базовый → этот):\n")
        for line in delta["config_diff"]:
            out(f"  {line}\n")
    out("\nпо файлу:\n")
    for branch in BRANCHES:
        row = delta["branches"][branch]["file"]
        changes = delta.get("rank_changes", {}).get(branch)
        suffix = ""
        if changes is not None:
            moved = ", ".join(
                f"{c['id']} {c['was']}→{c['now']}" for c in changes["changes"][:8]
            )
            more = "…" if len(changes["changes"]) > 8 else ""
            suffix = (
                f"  | сменили ранг: {changes['n_changed']}"
                f" (лучше {changes['improved']}, хуже {changes['regressed']})"
                + (f": {moved}{more}" if moved else "")
            )
        out(
            f"{branch:<10} hit@1 {row['hit_at']['1']:+.3f}  hit@5 {row['hit_at']['5']:+.3f}  "
            f"hit@10 {row['hit_at']['10']:+.3f}  MRR {row['mrr']:+.4f}{suffix}\n"
        )
    noise = delta.get("noise")
    if noise:
        out(
            f"\nшум: 1 вопрос из {noise['answerable_n']} = ±{noise['one_question']:.3f} к hit@*.\n"
        )
        for branch in BRANCHES:
            verdict = noise["verdicts"].get(branch)
            if verdict:
                out(f"  {branch}: {verdict}\n")
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


def print_sweep(reports: Sequence[dict[str, Any]]) -> None:
    """Сводная таблица свипа: hybrid, попадание по файлу; дельты — к первому варианту."""
    out = sys.stdout.write
    reference = reports[0]
    n = reference["golden"]["answerable"]
    quantum = 1.0 / n if n else 0.0
    name_width = max(16, max(len(r["variant"]["name"]) for r in reports) + 2)
    out("\n" + "=" * 78 + "\n")
    out(f"СВОДКА ВАРИАНТОВ (ветка hybrid, попадание по файлу, n={n}). " + CAVEAT + "\n")
    out("=" * 78 + "\n")
    out(
        f"{'вариант':<{name_width}}{'трогает':<14}"
        f"{'hit@1':>7}{'hit@3':>7}{'hit@5':>7}{'hit@10':>7}{'MRR':>7}"
        f"{'найдено':>9}  сменили ранг vs {reference['variant']['name']}\n"
    )
    for report in reports:
        stats = report["branches"]["hybrid"]["file"]
        touches = ",".join(report["variant"]["touches"]) or "—"
        if report is reference:
            moved = "—"
        else:
            changes = report["delta"]["rank_changes"]["hybrid"]
            moved = f"{changes['n_changed']} (лучше {changes['improved']}, хуже {changes['regressed']})"
        out(
            f"{report['variant']['name']:<{name_width}}{touches:<14}"
            f"{stats['hit_at']['1']:>7.2f}{stats['hit_at']['3']:>7.2f}"
            f"{stats['hit_at']['5']:>7.2f}{stats['hit_at']['10']:>7.2f}"
            f"{stats['mrr']:>7.3f}{stats['found']:>9}  {moved}\n"
        )
    out(
        f"\nшум: 1 вопрос = ±{quantum:.3f} к hit@*; дельта, не превышающая этого, — в\n"
        "пределах шума одного вопроса и выводом не является. Смотреть на «сменили ранг»:\n"
        "0 сменивших = выдача идентична, различие аггрегатов было бы артефактом.\n"
    )
    for report in reports:
        out(f"  {report['variant']['name']:<{name_width}} {report['variant']['transfer']}\n")
    total = sum(r["timing"]["total_s"] for r in reports)
    out(f"\nвремя свипа: {total:.1f}s на {len(reports)} вариантов\n")


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


def rank_changes(report: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    """Сколько вопросов реально сменили ранг по файлу — сигнал, который не размывается
    усреднением: на 28 вопросах один сменивший двигает hit@1 на 0.036, и только счётчик
    отличает «изменение» от «шума одного вопроса»."""
    base_by_id = {record["id"]: record for record in baseline.get("per_query", [])}
    out: dict[str, Any] = {}
    for branch in BRANCHES:
        changes: list[dict[str, Any]] = []
        improved = 0
        regressed = 0
        for record in report.get("per_query", []):
            old = base_by_id.get(record["id"])
            if old is None:
                continue
            now = record["branches"].get(branch, {}).get("file_rank")
            was = old["branches"].get(branch, {}).get("file_rank")
            if now == was:
                continue
            better = was is None or (now is not None and now < was)
            if better:
                improved += 1
            else:
                regressed += 1
            changes.append({"id": record["id"], "was": was, "now": now})
        out[branch] = {
            "n_changed": len(changes),
            "improved": improved,
            "regressed": regressed,
            "changes": changes,
        }
    return out


def _config_diff(new: Any, old: Any, prefix: str = "") -> list[str]:
    """Плоский список отличий двух конфигураций поиска: «ключ: было → стало»."""
    if isinstance(new, dict) or isinstance(old, dict):
        new_dict = new if isinstance(new, dict) else {}
        old_dict = old if isinstance(old, dict) else {}
        lines: list[str] = []
        for key in sorted(set(new_dict) | set(old_dict)):
            lines.extend(_config_diff(new_dict.get(key), old_dict.get(key), f"{prefix}{key}."))
        return lines
    if new != old:
        return [f"{prefix[:-1]}: {old!r} → {new!r}"]
    return []


def compute_delta(report: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    """Разница метрик с базовым отчётом, по веткам и по категориям.

    Разные ВАРИАНТЫ на одном корпусе — штатное сравнение: отличия конфигурации
    перечисляются в `config_diff`, чтобы было видно, чему атрибутировать дельту.
    Разные МОДЕЛИ делают сравнение недействительным; разный корпус ПЛЮС разная
    конфигурация — дельту нельзя приписать одному фактору, об этом говорится прямо.
    """
    notes: list[str] = []
    if report["model"]["name"] != baseline.get("model", {}).get("name"):
        notes.append("РАЗНЫЕ МОДЕЛИ — сравнение недействительно")
    config_diff = _config_diff(report["retrieval"], baseline.get("retrieval"))
    corpus_differs = report.get("corpus", {}).get("source") != baseline.get("corpus", {}).get(
        "source"
    )
    if config_diff and corpus_differs:
        notes.append(
            "меняются и корпус, и конфигурация поиска — дельту нельзя атрибутировать "
            "одному фактору"
        )
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

    changes = rank_changes(report, baseline)
    n_answerable = int(report["golden"]["answerable"] or 0)
    quantum = round(1.0 / n_answerable, 4) if n_answerable else 0.0
    verdicts: dict[str, str] = {}
    for branch in BRANCHES:
        n_changed = changes[branch]["n_changed"]
        if n_changed == 0:
            verdicts[branch] = "выдача не изменилась — любая дельта аггрегатов была бы артефактом"
        elif n_changed == 1:
            verdicts[branch] = "сменил ранг 1 вопрос — дельта в пределах шума одного вопроса"
        else:
            verdicts[branch] = (
                f"сменили ранг {n_changed} вопросов "
                f"(лучше {changes[branch]['improved']}, хуже {changes[branch]['regressed']}) — "
                "смотреть на баланс, а не только на аггрегат"
            )

    return {
        "baseline_label": baseline["corpus"]["label"],
        "baseline_chunks": baseline["corpus"]["chunks"],
        "config_diff": config_diff,
        "section_comparable_ids": sorted(comparable),
        "branches": branches,
        "rank_changes": changes,
        "noise": {
            "answerable_n": n_answerable,
            "one_question": quantum,
            "explanation": (
                f"на {n_answerable} отвечаемых вопросах один сменивший ранг двигает hit@* "
                f"на {quantum}; дельта, не превышающая этого, — шум одного вопроса"
            ),
            "verdicts": verdicts,
        },
        "note": "; ".join(notes),
    }


# --------------------------------------------------------------------------- #
# Прогон одного варианта
# --------------------------------------------------------------------------- #


def run_variant(
    variant: Variant,
    chunks: list[Chunk],
    queries: list[Query],
    embedder: DenseEmbedder,
    sparse_memo: SparseMemo,
    args: argparse.Namespace,
) -> dict[str, Any]:
    """Строит индексы по спеке варианта и собирает полный отчёт того же формата,
    что и раньше, — вся машинерия сравнения (`--baseline`, свип) работает поверх."""
    started = time.monotonic()
    stages = (
        variant.post
        if variant.post is not None
        else default_post_pipeline(not args.no_group_by_section)
    )
    limit, fetch_limit, candidate_limit = variant_depths(variant, args.limit)

    doc_dense_texts, doc_sparse_texts = variant_doc_texts(variant, chunks)
    query_dense_texts, query_sparse_texts = variant_query_texts(variant, queries)

    t0 = time.monotonic()
    computed_before_sparse = sparse_memo.computed
    doc_sparse = sparse_memo.vectors(doc_sparse_texts)
    query_sparse = sparse_memo.vectors(query_sparse_texts)
    sparse_s = time.monotonic() - t0

    t0 = time.monotonic()
    computed_before = embedder.computed
    truncated_before = embedder.truncated
    doc_dense = embedder.embed([PASSAGE_PREFIX + text for text in doc_dense_texts])
    query_dense = embedder.embed(query_dense_texts)
    embedder.flush()
    dense_s = time.monotonic() - t0
    computed_here = embedder.computed - computed_before
    truncated_here = embedder.truncated - truncated_before

    corpus = Corpus(chunks=chunks, dense=doc_dense, sparse=SparseIndex(doc_sparse))

    t0 = time.monotonic()
    result = evaluate(corpus, queries, query_dense, query_sparse, variant, stages, args.limit)
    search_s = time.monotonic() - t0

    touches = variant_touches(variant)
    report: dict[str, Any] = {
        "tool": "cognivault-rag-audit/audit_retrieval",
        "format_version": 2,
        "caveat": CAVEAT,
        "not_measured": [
            "качество ответа модели (генерации здесь нет)",
            "грейдер/реранкер из UI (скрытый вызов GigaChat, офлайн недоступен)",
            "абсолютная полнота: размечен один правильный документ на вопрос (+alt-пути)",
        ],
        "variant": {
            "name": variant.name,
            "fusion": {
                "mode": variant.fusion.mode,
                "k": variant.fusion.k,
                "weights": list(variant.fusion.weights),
                "norm": variant.fusion.norm,
            },
            "query": {"dense": variant.query_dense, "sparse": variant.query_sparse},
            "doc": {"dense": variant.doc_dense, "sparse": variant.doc_sparse},
            "post": [
                {"stage": name, **params} if params else name for name, params in stages
            ],
            "touches": touches,
            "transfer": transfer_note(touches),
        },
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
            "truncated_for_model": truncated_here if computed_here else None,
            "truncation_note": (
                "чанк длиннее 512 токенов e5 обрезается; у продового эмбеддера окно своё, "
                "поэтому это ограничение локального замера, а не свойство прода"
            ),
        },
        "retrieval": {
            "limit": limit,
            "fetch_limit": fetch_limit,
            "candidate_limit": candidate_limit,
            "fusion": {
                "mode": variant.fusion.mode,
                "k": variant.fusion.k,
                "weights": list(variant.fusion.weights),
                "norm": variant.fusion.norm,
            },
            "rrf_position_base": 0,
            "query_transform": {"dense": variant.query_dense, "sparse": variant.query_sparse},
            "doc_text": {"dense": variant.doc_dense, "sparse": variant.doc_sparse},
            "post": [
                {"stage": name, **params} if params else name for name, params in stages
            ],
            "group_by_section": any(name == "group_by_section" for name, _ in stages),
            "source_of_truth": "src/features/search/service.ts + qdrant v1.16.3",
        },
        **result,
    }
    report["timing"] = {
        "sparse_s": round(sparse_s, 2),
        "dense_s": round(dense_s, 2),
        "search_s": round(search_s, 2),
        "total_s": round(time.monotonic() - started, 2),
        "embeddings_computed": computed_here,
        "sparse_vectors_computed": sparse_memo.computed - computed_before_sparse,
    }
    return report


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
    parser.add_argument(
        "--out",
        required=True,
        type=Path,
        help="куда писать retrieval-report.json (для свипа из >1 варианта — каталог)",
    )
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
        "--baseline",
        type=Path,
        default=None,
        help="отчёт другого корпуса/варианта — посчитать дельту (только для одного варианта)",
    )
    parser.add_argument(
        "--variant",
        action="append",
        default=None,
        metavar="ИМЯ|JSON",
        help="имя варианта из реестра либо инлайн-JSON спеки; повторяемый — свип",
    )
    parser.add_argument(
        "--variants-file",
        type=Path,
        default=None,
        help="JSON-файл со списком спек вариантов (свип)",
    )
    parser.add_argument(
        "--hooks",
        action="append",
        type=Path,
        default=None,
        metavar="FILE.py",
        help="python-файл, регистрирующий свои трансформы/стадии/реранкеры/варианты",
    )
    parser.add_argument(
        "--list-variants", action="store_true", help="перечислить известные варианты и хуки"
    )
    return parser


def _collect_variants(args: argparse.Namespace) -> list[Variant]:
    specs: list[dict[str, Any]] = []
    for entry in args.variant or []:
        text = entry.strip()
        if text.startswith("{"):
            specs.append(json.loads(text))
        elif text in VARIANTS:
            specs.append(VARIANTS[text])
        else:
            raise SystemExit(
                f"неизвестный вариант {text!r}; есть {sorted(VARIANTS)} "
                "(или инлайн-JSON, или регистрация через --hooks)"
            )
    if args.variants_file is not None:
        loaded = json.loads(args.variants_file.read_text(encoding="utf-8"))
        if not isinstance(loaded, list):
            raise SystemExit(f"{args.variants_file}: ожидается JSON-список спек")
        specs.extend(loaded)
    if not specs:
        specs = [VARIANTS["prod"]]
    variants = [parse_variant(spec) for spec in specs]
    names = [v.name for v in variants]
    if len(names) != len(set(names)):
        raise SystemExit(f"имена вариантов повторяются: {names}")
    return variants


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    for hooks_path in args.hooks or []:
        load_hooks(hooks_path)

    if args.list_variants:
        out = sys.stdout.write
        out("варианты:     " + ", ".join(sorted(VARIANTS)) + "\n")
        out("query-хуки:   " + ", ".join(sorted(QUERY_TRANSFORMS)) + "\n")
        out("doc-хуки:     " + ", ".join(sorted(DOC_COMPOSERS)) + "\n")
        out("пост-стадии:  " + ", ".join(sorted(POST_STAGES)) + "\n")
        out("реранкеры:    " + ", ".join(sorted(RERANKERS)) + "\n")
        return 0

    variants = _collect_variants(args)
    sweep = len(variants) > 1
    if sweep and args.baseline is not None:
        raise SystemExit(
            "--baseline несовместим со свипом: в свипе базовым служит ПЕРВЫЙ вариант"
        )

    chunks = load_chunks(args.chunks)
    queries = to_queries(load_golden(str(args.golden)))

    embedder = DenseEmbedder(args.model, args.cache, args.device)
    sparse_memo = SparseMemo()

    reports: list[dict[str, Any]] = []
    for variant in variants:
        reports.append(run_variant(variant, chunks, queries, embedder, sparse_memo, args))

    if not sweep:
        report = reports[0]
        if args.baseline is not None:
            baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
            report["delta"] = compute_delta(report, baseline)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(
            json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
        )
        print_summary(report)
        sys.stdout.write(f"\nотчёт: {args.out}\n")
        return 0

    # Свип: первый вариант — базовый, дельта каждого остального встроена в его отчёт.
    args.out.mkdir(parents=True, exist_ok=True)
    reference = reports[0]
    for report in reports[1:]:
        report["delta"] = compute_delta(report, reference)
    for report in reports:
        path = args.out / f"{report['variant']['name']}.json"
        path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
        )
    print_sweep(reports)
    sys.stdout.write(f"\nотчёты: {args.out}/<вариант>.json\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
