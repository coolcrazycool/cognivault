#!/usr/bin/env python3
"""Аудит стыка выдача → окно: доезжает ли ответ до модели после обрезки раздела.

Метрики стыка 3 (`audit_retrieval.py`) отвечают на вопрос «поднялся ли нужный
документ наверх». Они СТРУКТУРНО не могут ответить на следующий: чат-конвейер
просит `group_by_section: true`, попадание схлопывается в свой раздел, и текст
раздела режется до `section_max_chars` (по умолчанию 4000) окном, ЦЕНТРИРОВАННЫМ
на найденном чанке. Уехала ли вместе с обрезком та самая фраза, которая отвечает
на вопрос, — не знает никто.

Замер устроен так. Для каждого отвечаемого вопроса золотого набора прогоняется
продовая конфигурация поиска, берётся ПЕРВЫЙ правильный чанк выдачи, по нему
строится окно раздела РОВНО так, как это делает `SearchService.sectionWindow`
(через мост `section_windows.ts` — не копия, а сама функция), и измеряется, дошло
ли до модели содержание эталонного ответа `ground_truth`.

МЕРА СОДЕРЖАНИЯ
---------------
Точное вхождение не годится: `ground_truth` — пересказ в 1–3 предложения, а не
цитата. Мера считает СОДЕРЖАТЕЛЬНЫЕ ТЕРМЫ:

1. Термы берутся НАСТОЯЩИМ `tokenize` из `src/lib/bm25.ts` (стеммер Snowball,
   стоп-слова, свёртка «ё»→«е») — тем же, которым индексируется корпус. Своя
   токенизация мерила бы расхождение двух токенизаторов.
2. Из термов эталона вычитаются термы ВОПРОСА. Терм, который уже есть в вопросе,
   попадает в окно почти по построению — именно по нему чанк и нашёлся, — и
   одинаково завышал бы любую конфигурацию. Остаются термы, которые ОТВЕТ
   добавляет к вопросу; на них и считается основная мера.
3. Знаменатель — не все такие термы, а ДОСТИЖИМЫЕ: те, что есть в ПОЛНОМ тексте
   раздела. Терм, которого в разделе нет вовсе (пересказ выбрал другое слово,
   факт живёт на другой странице), не мог бы доехать ни при каком лимите;
   держать его в знаменателе значило бы смешивать «обрезка потеряла ответ» с
   «пересказ не совпал словами». Величина этого разрыва отчитывается отдельно
   (`ceiling`) — она честно велика, и прятать её нельзя.
4. `containment = |достижимые ∩ термы окна| / |достижимые|`. Вопрос считается
   «ответ доехал» при `containment >= --threshold` (0.8). Отчёт печатает
   чувствительность к порогу, чтобы вывод не держался на одном числе.

ЛОКУС ОТВЕТА
------------
Мера выше — мешок термов: она не отличает «фраза с ответом внутри окна» от
«термы рассыпаны по окну поодиночке». Поэтому считается ещё и ЛОКУС: минимальный
непрерывный диапазон СТРОК раздела, покрывающий `--locus-coverage` (0.8)
достижимых термов. Локус — это место, где ответ действительно написан. По нему
меряется то, чего мешок термов не видит: попал ли локус в окно целиком и на каком
расстоянии он от чанка, на котором окно центрировано. Именно это отвечает на
вопрос «не промахнулось ли центрирование».

ЧЕГО МЕРА НЕ МЕРЯЕТ (и не притворяется)
---------------------------------------
* **Мешок термов**: покрытие термов ≠ ответ читаем. Рассыпанные по окну термы
  засчитываются; локус — частичная, но не полная защита от этого.
* **Мера МОНОТОННА по размеру окна**: большее окно не может набрать меньше, а на
  `unlimited` покрытие равно 1.0 ПО ПОСТРОЕНИЮ. Поэтому сама по себе она никогда
  не может доказать, что больший лимит лучше, — её обязательно читают вместе с
  ценой (символы на вопрос при потолке в 5 блоков контекста). Прокси, который
  молча награждает многословие, хуже отсутствия прокси; здесь цена печатается
  рядом с каждым числом.
* **Знаменатель условен на разделе** — см. п. 3 выше и `ceiling`.
* **Стемминг склеивает разные слова** и выбрасывает частотные. Смещение
  одинаково для всех сравниваемых конфигураций, поэтому сравнения оно не портит.
* **Качество ответа модели** — генерации здесь нет, как и в стыке 3.

ПОДМЕНА МОДЕЛИ — та же, что в стыке 3: плотные вектора считает
`multilingual-e5-base`, в проде — GigaChat EmbeddingsGigaR. Здесь модель влияет
только на ВЫБОР ЯКОРНОГО ЧАНКА (какой из правильных чанков окажется первым), а не
на саму нарезку окна; но раз якорь другой — абсолютные числа в прод не переносятся,
переносятся сравнения при прочих равных.
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from audit_retrieval import (  # noqa: E402
    CAVEAT,
    DEFAULT_LIMIT,
    DEFAULT_MODEL,
    PASSAGE_PREFIX,
    Chunk,
    Corpus,
    DenseEmbedder,
    Query,
    SparseIndex,
    SparseMemo,
    default_post_pipeline,
    load_chunks,
    load_golden_files,
    parse_variant,
    run_branches,
    to_queries,
    variant_doc_texts,
    variant_query_texts,
)

#: Лимиты `section_max_chars`, по которым идёт свип. 0 — без ограничения.
DEFAULT_CAPS = (2000, 4000, 8000, 16000, 0)

#: Продовый `DEFAULT_SECTION_MAX_CHARS` из `src/features/search/service.ts`.
PROD_CAP = 4000

#: `_MAX_CONTEXT_BLOCKS` из `cognivault-ui/app/rag.py` — потолок блоков контекста.
MAX_CONTEXT_BLOCKS = 5

#: Доля достижимых термов в окне, начиная с которой ответ считается доехавшим.
DEFAULT_THRESHOLD = 0.8

#: Доля достижимых термов, которую обязан покрыть локус ответа.
DEFAULT_LOCUS_COVERAGE = 0.8

#: Пороги, по которым печатается чувствительность основной меры.
THRESHOLD_GRID = (0.5, 0.6, 0.7, 0.8, 0.9, 1.0)

#: Меньше этого числа достижимых термов — судить не о чем: у эталона из трёх
#: содержательных слов любое покрытие скачет на треть за терм. Такие вопросы
#: считаются отдельно и в долю не входят.
MIN_ATTAINABLE_TERMS = 3

#: Ветка, которую зовёт чат-конвейер (`POST /api/vault/search/hybrid`).
BRANCH = "hybrid"


# --------------------------------------------------------------------------- #
# Мост к настоящим `sectionWindow` / `tokenize`
# --------------------------------------------------------------------------- #


def _bridge(command: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Один вызов `section_windows.ts`. Батч на всё — запуск tsx стоит секунды."""
    script = REPO_ROOT / "tools" / "rag_audit" / "section_windows.ts"
    with tempfile.TemporaryDirectory(prefix="rag-audit-window-") as tmp:
        in_path = Path(tmp) / "in.json"
        out_path = Path(tmp) / "out.json"
        in_path.write_text(json.dumps(payload), encoding="utf-8")
        result = subprocess.run(
            ["npx", "tsx", str(script), command, str(in_path), str(out_path)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise SystemExit(
                f"section_windows.ts {command} упал ({result.returncode}): {result.stderr[-2000:]}"
            )
        return json.loads(out_path.read_text(encoding="utf-8"))


class Tokenizer:
    """Кэш `tokenize` из `src/lib/bm25.ts`, живущий один прогон.

    Недостающие тексты собираются в ОДИН вызов моста: тысячи окон и строк раздела
    по вызову на текст стоили бы дороже всего остального замера вместе взятого.
    """

    def __init__(self) -> None:
        self._cache: dict[str, tuple[str, ...]] = {}
        self.computed = 0

    def warm(self, texts: Iterable[str]) -> None:
        missing = [t for t in dict.fromkeys(texts) if t not in self._cache]
        if not missing:
            return
        payload = _bridge("tokens", {"texts": missing})
        rows = payload["tokens"]
        if len(rows) != len(missing):
            raise SystemExit(f"tokens: вернулось {len(rows)} на {len(missing)} текстов")
        for text, tokens in zip(missing, rows):
            self._cache[text] = tuple(str(t) for t in tokens)
        self.computed += len(missing)

    def terms(self, text: str) -> set[str]:
        if text not in self._cache:
            self.warm([text])
        return set(self._cache[text])


def build_windows(
    sections: dict[str, str], requests: Sequence[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Окна батчем через настоящий `sectionWindow` (или префикс — тоже в TS)."""
    if not requests:
        return []
    payload = _bridge("windows", {"sections": sections, "requests": list(requests)})
    results = payload["results"]
    if len(results) != len(requests):
        raise SystemExit(f"windows: вернулось {len(results)} на {len(requests)} запросов")
    return list(results)


# --------------------------------------------------------------------------- #
# Разделы
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Section:
    """Строка выгрузки `section_windows.ts sections` = строка таблицы `sections`."""

    path: str
    parent_id: str
    section_path: str
    text: str

    @property
    def key(self) -> tuple[str, str]:
        return (self.path, self.parent_id)


def load_sections(path: Path) -> dict[tuple[str, str], Section]:
    """JSONL разделов → индекс по составному ключу `(path, parent_id)`.

    Ключ составной по той же причине, по которой он такой в проде: `parent_id`
    выводится из порядкового номера и пути заголовков и уникален только ВНУТРИ
    файла (`sectionKey` в `service.ts`, составной первичный ключ в `db/schema.ts`).
    """
    out: dict[tuple[str, str], Section] = {}
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{lineno}: не JSON ({exc})") from exc
            section = Section(
                path=str(row["path"]),
                parent_id=str(row["parent_id"]),
                section_path=str(row.get("section_path", "")),
                text=str(row.get("text", "")),
            )
            out[section.key] = section
    if not out:
        raise SystemExit(f"{path}: пусто")
    return out


# --------------------------------------------------------------------------- #
# Мера
# --------------------------------------------------------------------------- #


def answer_terms(gt_terms: set[str], question_terms: set[str]) -> set[str]:
    """Термы, которые ОТВЕТ добавляет к вопросу.

    Терм, уже прозвучавший в вопросе, попадает в окно почти по построению — по
    нему чанк и нашёлся, — и завышал бы любую конфигурацию одинаково. Разность
    оставляет то, ради чего вопрос задавали.
    """
    return gt_terms - question_terms


def attainable_terms(terms: set[str], section_terms: set[str]) -> set[str]:
    """Термы ответа, которые ВООБЩЕ есть в разделе, — потолок любого окна.

    Терм, которого в разделе нет, не доедет ни при каком `section_max_chars`:
    держать его в знаменателе значило бы записать разрыв пересказа в потери
    обрезки.
    """
    return terms & section_terms


def containment(attainable: set[str], window_terms: set[str]) -> float:
    """Доля достижимых термов, оказавшихся в окне. Пустой знаменатель → 1.0
    («терять нечего»); такие вопросы всё равно отсеиваются `MIN_ATTAINABLE_TERMS`."""
    if not attainable:
        return 1.0
    return len(attainable & window_terms) / len(attainable)


def answer_locus(
    line_terms: Sequence[set[str]], attainable: set[str], coverage: float
) -> tuple[int, int] | None:
    """Минимальный непрерывный диапазон строк, покрывающий `coverage` достижимых
    термов, — место, где ответ написан.

    Возвращает `(первая строка, последняя строка включительно)` либо `None`, если
    покрыть требуемую долю не удаётся даже всем разделом (термы есть, но не в
    строках — так не бывает, кроме вырожденных случаев).

    Два указателя по строкам: окно расширяется вправо, пока покрытие не набрано,
    затем сжимается слева, пока не потеряно. Гранулярность — строка, а не символ:
    смещения термов пришлось бы считать своей копией токенизатора, а окна тут
    измеряются тысячами символов, так что строка более чем достаточна.
    """
    if not attainable:
        return None
    need = coverage * len(attainable)
    counts: dict[str, int] = {}
    covered = 0
    best: tuple[int, int] | None = None
    best_len = -1
    left = 0
    for right, terms in enumerate(line_terms):
        for term in terms & attainable:
            if counts.get(term, 0) == 0:
                covered += 1
            counts[term] = counts.get(term, 0) + 1
        while covered >= need and left <= right:
            span = right - left
            if best is None or span < best_len:
                best, best_len = (left, right), span
            for term in line_terms[left] & attainable:
                counts[term] -= 1
                if counts[term] == 0:
                    covered -= 1
            left += 1
    return best


def line_offsets(text: str) -> list[tuple[int, int]]:
    """Смещения `[начало, конец)` каждой строки — для позиции локуса в разделе."""
    out: list[tuple[int, int]] = []
    start = 0
    for line in text.split("\n"):
        out.append((start, start + len(line)))
        start += len(line) + 1
    return out


# --------------------------------------------------------------------------- #
# Агрегаты
# --------------------------------------------------------------------------- #


def mean(values: Sequence[float]) -> float | None:
    return round(statistics.fmean(values), 4) if values else None


def median(values: Sequence[float]) -> float | None:
    return round(statistics.median(values), 1) if values else None


def rate(flags: Sequence[bool]) -> float | None:
    return round(sum(1 for f in flags if f) / len(flags), 4) if flags else None


def summarize(rows: Sequence[dict[str, Any]], threshold: float) -> dict[str, Any]:
    """Свод по набору измеренных вопросов: доля доехавших, покрытие, цена."""
    judged = [r for r in rows if r["judgeable"]]
    return {
        "questions": len(rows),
        "judged": len(judged),
        "too_few_terms": len(rows) - len(judged),
        "contained": rate([r["containment"] >= threshold for r in judged]),
        "containment_mean": mean([r["containment"] for r in judged]),
        "containment_median": median([r["containment"] for r in judged]),
        "chars_mean": mean([float(r["chars"]) for r in rows]),
        "chars_median": median([float(r["chars"]) for r in rows]),
        "chars_5_blocks": (
            round(statistics.fmean([float(r["chars"]) for r in rows]) * MAX_CONTEXT_BLOCKS)
            if rows
            else None
        ),
        "locus_inside": rate([r["locus_inside"] for r in judged if r["locus_inside"] is not None]),
    }


def split_by(rows: Sequence[dict[str, Any]], key: str, threshold: float) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(str(row[key]), []).append(row)
    return {name: summarize(group, threshold) for name, group in sorted(groups.items())}


def threshold_sensitivity(rows: Sequence[dict[str, Any]]) -> dict[str, Any]:
    judged = [r for r in rows if r["judgeable"]]
    return {
        f"{t:.1f}": rate([r["containment"] >= t for r in judged]) for t in THRESHOLD_GRID
    }


# --------------------------------------------------------------------------- #
# Прогон
# --------------------------------------------------------------------------- #


@dataclass
class Anchor:
    """Что поиск отдал по одному вопросу: первый правильный чанк и его раздел.

    `ground_truth` живёт здесь, а не в `Query`: `Query` — тип стыка 3, и поля
    эталонного ответа в нём нет, потому что там он не нужен. Дописывать поле
    чужому dataclass'у ради одного инструмента значило бы связать два стыка
    ничем не оправданной зависимостью.
    """

    query: Query
    ground_truth: str
    rank: int
    chunk: Chunk
    section: Section
    match_level: str  # "section" | "file"


def pick_anchors(
    corpus: Corpus,
    sections: dict[tuple[str, str], Section],
    queries: Sequence[Query],
    ground_truths: dict[str, str],
    ranked_by_query: dict[str, list[int]],
) -> tuple[list[Anchor], list[Query]]:
    """Первый ПРАВИЛЬНЫЙ чанк выдачи на каждый вопрос — то, что прод развернул бы
    в раздел.

    «Правильный» берётся по самой точной доступной метке: если у строки есть
    `section_path` и такой раздел в корпусе существует — по паре
    `(path, section_path)`, иначе по файлу (`source_path` ∪ `alt_source_paths`).
    Вопросы, у которых правильного чанка в выдаче нет вовсе, — промах РЕТРИВАЛА,
    а не окна: они считаются отдельно и в долю окна не входят, иначе замер
    смешивал бы две разные поломки.
    """
    anchors: list[Anchor] = []
    missed: list[Query] = []
    for query in queries:
        ranked = ranked_by_query[query.id]
        relevant: set[int] = set()
        level = "file"
        if query.section_path and (query.source_path, query.section_path) in corpus.by_section:
            relevant = corpus.by_section[(query.source_path, query.section_path)]
            level = "section"
        else:
            for path in (query.source_path, *query.alt_source_paths):
                if path:
                    relevant |= corpus.by_path.get(path, set())
        hit = next(
            ((position, doc) for position, doc in enumerate(ranked, 1) if doc in relevant), None
        )
        if hit is None:
            missed.append(query)
            continue
        position, doc = hit
        chunk = corpus.chunks[doc]
        section = sections.get((chunk.path, chunk.parent_id))
        if section is None:
            raise SystemExit(
                f"у чанка {chunk.path}#{chunk.chunk_index} нет строки раздела "
                f"{chunk.parent_id!r} — выгрузки чанков и разделов сделаны по разным вольтам"
            )
        anchors.append(
            Anchor(
                query=query,
                ground_truth=ground_truths.get(query.id, ""),
                rank=position,
                chunk=chunk,
                section=section,
                match_level=level,
            )
        )
    return anchors, missed


def retrieve(
    corpus: Corpus,
    queries: Sequence[Query],
    dense_queries: np.ndarray,
    sparse_queries: Sequence[dict[str, list[float]]],
    variant: Any,
    stages: Sequence[tuple[str, dict[str, Any]]],
    limit: int,
) -> dict[str, list[int]]:
    """Продовая выдача ветки `hybrid` на каждый вопрос."""
    out: dict[str, list[int]] = {}
    for position, query in enumerate(queries):
        runs = run_branches(
            corpus,
            dense_queries[position],
            sparse_queries[position],
            variant,
            stages,
            limit,
            query_text=query.question,
        )
        out[query.id] = runs[BRANCH].ranked
    return out


#: Конфигурации доставки, которые сравниваются. `mode` уходит в мост как есть.
DELIVERY_MODES = ("centred", "prefix")


def measure(
    anchors: Sequence[Anchor],
    tokenizer: Tokenizer,
    caps: Sequence[int],
    threshold: float,
    locus_coverage: float,
) -> dict[str, Any]:
    """Все конфигурации доставки на всех якорях. Возвращает сырые строки замера."""
    # --- термы эталона, вопроса и раздела ---
    texts: list[str] = []
    for anchor in anchors:
        texts.append(anchor.query.question)
        texts.append(anchor.section.text)
    texts.extend(a.ground_truth for a in anchors)
    for anchor in anchors:
        texts.extend(anchor.section.text.split("\n"))
    tokenizer.warm(texts)

    # --- окна: один батч на все конфигурации ---
    section_texts = {f"{a.query.id}": a.section.text for a in anchors}
    requests: list[dict[str, Any]] = []
    request_keys: list[tuple[str, int, str]] = []
    for anchor in anchors:
        for cap in caps:
            if cap == 0:
                continue  # unlimited — это сам раздел, мост не нужен
            for mode in DELIVERY_MODES:
                requests.append(
                    {
                        "section": anchor.query.id,
                        "chunk_text": anchor.chunk.text,
                        "section_path": anchor.chunk.section_path,
                        "limit": cap,
                        "mode": mode,
                    }
                )
                request_keys.append((anchor.query.id, cap, mode))
    results = build_windows(section_texts, requests)
    windows: dict[tuple[str, int, str], dict[str, Any]] = dict(zip(request_keys, results))
    tokenizer.warm(r["window"] for r in results)

    rows: dict[tuple[int, str], list[dict[str, Any]]] = {}
    chunk_rows: list[dict[str, Any]] = []
    ceiling: list[dict[str, Any]] = []
    per_query: list[dict[str, Any]] = []

    for anchor in anchors:
        query = anchor.query
        section_text = anchor.section.text
        gt_terms = tokenizer.terms(anchor.ground_truth)
        q_terms = tokenizer.terms(query.question)
        section_terms = tokenizer.terms(section_text)
        ans = answer_terms(gt_terms, q_terms)
        attainable = attainable_terms(ans, section_terms)
        judgeable = len(attainable) >= MIN_ATTAINABLE_TERMS

        ceiling.append(
            {
                "id": query.id,
                "gt_terms": len(gt_terms),
                "answer_terms": len(ans),
                "attainable": len(attainable),
                "attainable_share": (round(len(attainable) / len(ans), 4) if ans else None),
            }
        )

        # --- локус ответа в разделе ---
        lines = section_text.split("\n")
        line_terms = [tokenizer.terms(line) for line in lines]
        offsets = line_offsets(section_text)
        locus = answer_locus(line_terms, attainable, locus_coverage)
        locus_span: tuple[int, int] | None = None
        locus_text = ""
        if locus is not None:
            locus_span = (offsets[locus[0]][0], offsets[locus[1]][1])
            locus_text = section_text[locus_span[0] : locus_span[1]]

        # --- где стоит якорь ---
        anchor_key = (query.id, PROD_CAP, "centred")
        probe = windows.get(anchor_key)
        anchor_at = (
            section_text.find(probe["anchor_text"])
            if probe is not None and probe["anchor_text"]
            else -1
        )

        base = {
            "id": query.id,
            "origin": query.origin,
            "category": query.category,
            "judgeable": judgeable,
            "section_chars": len(section_text),
        }

        def row_for(text: str, cap: int, mode: str) -> dict[str, Any]:
            window_terms = tokenizer.terms(text)
            value = containment(attainable, window_terms)
            inside: bool | None = None
            if locus_text:
                inside = locus_text in text
            return {
                **base,
                "cap": cap,
                "mode": mode,
                "containment": value,
                "chars": len(text),
                "locus_inside": inside,
                "truncated": len(text) < len(section_text),
            }

        for cap in caps:
            for mode in DELIVERY_MODES:
                if cap == 0:
                    if mode != DELIVERY_MODES[0]:
                        continue  # без лимита оба режима — это весь раздел
                    text = section_text
                else:
                    text = windows[(query.id, cap, mode)]["window"]
                rows.setdefault((cap, mode), []).append(row_for(text, cap, mode))

        chunk_row = row_for(anchor.chunk.text, -1, "chunk_only")
        chunk_rows.append(chunk_row)

        prod_row = rows[(PROD_CAP, "centred")][-1]
        prefix_row = rows[(PROD_CAP, "prefix")][-1]
        per_query.append(
            {
                "id": query.id,
                "origin": query.origin,
                "category": query.category,
                "rank": anchor.rank,
                "match_level": anchor.match_level,
                "path": anchor.chunk.path,
                "chunk_index": anchor.chunk.chunk_index,
                "content_kind": anchor.chunk.content_kind,
                "section_path": anchor.chunk.section_path,
                "section_chars": len(section_text),
                "oversized": len(section_text) > PROD_CAP,
                "attainable_terms": len(attainable),
                "judgeable": judgeable,
                "anchor_at": anchor_at,
                "anchor_located": bool(probe["located"]) if probe is not None else None,
                "locus_span": list(locus_span) if locus_span else None,
                "locus_lines": (locus[1] - locus[0] + 1) if locus is not None else None,
                "anchor_to_locus_chars": (
                    abs(anchor_at - locus_span[0])
                    if locus_span is not None and anchor_at >= 0
                    else None
                ),
                "containment_prod": round(prod_row["containment"], 4),
                "containment_prefix": round(prefix_row["containment"], 4),
                "containment_chunk_only": round(chunk_row["containment"], 4),
                "containment_full_section": round(
                    rows[(0, DELIVERY_MODES[0])][-1]["containment"], 4
                )
                if (0, DELIVERY_MODES[0]) in rows
                else None,
                "locus_inside_prod": prod_row["locus_inside"],
                "locus_inside_prefix": prefix_row["locus_inside"],
                "chars_prod": prod_row["chars"],
                "chars_chunk_only": chunk_row["chars"],
            }
        )

    return {
        "rows": rows,
        "chunk_rows": chunk_rows,
        "ceiling": ceiling,
        "per_query": sorted(per_query, key=lambda r: r["id"]),
    }


def anchor_failures(per_query: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Якоря, которые `locateChunk` не нашёл в собственном разделе.

    Это тихая деградация: `sectionWindow` в таком случае молча возвращает
    `slice(0, limit)` — ровно то поведение, которое центрирование заменяло. На
    коротком разделе последствий нет (окно и так весь раздел), на переразмерном
    вопрос получает префиксное окно, не зная об этом. Разрез по `content_kind`
    отвечает на вопрос «какие чанки не находятся» — по нему и чинится.
    """
    failed = [r for r in per_query if r["anchor_located"] is False]
    kinds: dict[str, int] = {}
    for row in failed:
        kinds[str(row["content_kind"])] = kinds.get(str(row["content_kind"]), 0) + 1
    return {
        "note": (
            "locateChunk вернул -1 → sectionWindow молча падает в slice(0, limit), "
            "то есть в поведение до центрирования"
        ),
        "total": len(failed),
        "of_measured": len(per_query),
        "oversized": sum(1 for r in failed if r["oversized"]),
        "oversized_of": sum(1 for r in per_query if r["oversized"]),
        "by_content_kind": dict(sorted(kinds.items())),
        "examples": [
            {
                "id": r["id"],
                "content_kind": r["content_kind"],
                "path": r["path"],
                "section_path": r["section_path"],
            }
            for r in sorted(failed, key=lambda r: r["id"])[:10]
        ],
    }


def centring_analysis(
    per_query: Sequence[dict[str, Any]], rows_prod: Sequence[dict[str, Any]], threshold: float
) -> dict[str, Any]:
    """Работает ли центрирование: где локус относительно окна и относительно якоря.

    Считается ТОЛЬКО на переразмерных разделах — там, где обрезка вообще есть; на
    коротких разделах оба режима отдают одно и то же, и общая доля просто разбавила
    бы эффект долей неурезанных вопросов.
    """
    by_id = {r["id"]: r for r in rows_prod}
    oversized = [r for r in per_query if r["oversized"] and r["judgeable"]]
    prod_hits = [by_id[r["id"]]["containment"] >= threshold for r in oversized if r["id"] in by_id]
    outside = [r for r in oversized if r["locus_inside_prod"] is False]
    distances = [
        float(r["anchor_to_locus_chars"])
        for r in oversized
        if r["anchor_to_locus_chars"] is not None
    ]
    distances_outside = [
        float(r["anchor_to_locus_chars"])
        for r in outside
        if r["anchor_to_locus_chars"] is not None
    ]
    return {
        "oversized_judged": len(oversized),
        "contained_centred": rate(prod_hits),
        "locus_inside_centred": rate(
            [r["locus_inside_prod"] for r in oversized if r["locus_inside_prod"] is not None]
        ),
        "locus_inside_prefix": rate(
            [r["locus_inside_prefix"] for r in oversized if r["locus_inside_prefix"] is not None]
        ),
        "locus_outside_centred": len(outside),
        "anchor_located": rate(
            [bool(r["anchor_located"]) for r in oversized if r["anchor_located"] is not None]
        ),
        "anchor_to_locus_chars_median": median(distances),
        "anchor_to_locus_chars_median_when_outside": median(distances_outside),
        "better_centred": sum(
            1 for r in oversized if r["containment_prod"] > r["containment_prefix"] + 1e-9
        ),
        "better_prefix": sum(
            1 for r in oversized if r["containment_prefix"] > r["containment_prod"] + 1e-9
        ),
        "equal": sum(
            1 for r in oversized if abs(r["containment_prod"] - r["containment_prefix"]) <= 1e-9
        ),
    }


def build_report(args: argparse.Namespace, state: dict[str, Any]) -> dict[str, Any]:
    threshold = args.threshold
    rows = state["measure"]["rows"]
    chunk_rows = state["measure"]["chunk_rows"]
    per_query = state["measure"]["per_query"]
    prod_rows = rows[(PROD_CAP, "centred")]
    oversized_rows = [r for r in prod_rows if r["section_chars"] > PROD_CAP]

    sweep = []
    for cap in args.caps:
        for mode in DELIVERY_MODES:
            key = (cap, mode)
            if key not in rows:
                continue
            entry = summarize(rows[key], threshold)
            entry["cap"] = cap if cap else None
            entry["mode"] = mode if cap else "unlimited"
            entry["oversized_only"] = summarize(
                [r for r in rows[key] if r["section_chars"] > PROD_CAP], threshold
            )
            sweep.append(entry)

    ceiling = state["measure"]["ceiling"]
    shares = [c["attainable_share"] for c in ceiling if c["attainable_share"] is not None]

    return {
        "tool": "cognivault-rag-audit/audit_window",
        "format_version": 1,
        "caveat": CAVEAT,
        "not_measured": [
            "качество ответа модели (генерации здесь нет)",
            "грейдер/реранкер из UI — он может выбросить блок, который сюда попал",
            "читаемость окна: мера — мешок термов, локус лишь частично её страхует",
            "мера монотонна по размеру окна; цену больших лимитов несёт колонка chars",
        ],
        "measure": {
            "tokenizer": "src/lib/bm25.ts::tokenize (через section_windows.ts tokens)",
            "terms": "термы ground_truth минус термы вопроса",
            "denominator": "достижимые: те, что есть в ПОЛНОМ тексте раздела",
            "threshold": threshold,
            "min_attainable_terms": MIN_ATTAINABLE_TERMS,
            "locus_coverage": args.locus_coverage,
            "window_implementation": (
                "src/features/search/service.ts::sectionWindow через npx tsx "
                "(section_windows.ts) — сама функция, не копия"
            ),
        },
        "corpus": {
            "label": args.label or str(args.chunks),
            "chunks": str(args.chunks),
            "sections": str(args.sections),
            "chunk_count": state["chunk_count"],
            "section_count": state["section_count"],
            "sections_over_prod_cap": state["sections_over_cap"],
            "chunks_in_oversized_sections": state["chunks_in_oversized"],
            "prod_cap": PROD_CAP,
        },
        "retrieval": {
            "branch": BRANCH,
            "limit": args.limit,
            "group_by_section": True,
            "variant": "prod",
            "source_of_truth": "src/features/search/service.ts",
        },
        "golden": {
            "files": [str(p) for p in args.golden],
            "rows": state["rows_total"],
            "answerable": state["answerable"],
            "with_ground_truth": state["with_gt"],
            "retrieval_miss": state["retrieval_miss"],
            "measured": len(prod_rows),
            "match_level": {
                "section": sum(1 for r in per_query if r["match_level"] == "section"),
                "file": sum(1 for r in per_query if r["match_level"] == "file"),
            },
            "oversized_section": len(oversized_rows),
        },
        "ceiling": {
            "note": (
                "доля термов ответа, которые ВООБЩЕ есть в разделе; всё остальное "
                "недостижимо ни при каком лимите и в знаменатель меры не входит"
            ),
            "attainable_share_mean": mean(shares),
            "attainable_share_median": median(shares),
            "questions_below_min_terms": sum(1 for r in prod_rows if not r["judgeable"]),
        },
        "prod": {
            "all": summarize(prod_rows, threshold),
            "oversized_only": summarize(oversized_rows, threshold),
            "by_origin": split_by(prod_rows, "origin", threshold),
            "by_category": split_by(prod_rows, "category", threshold),
            "by_origin_oversized": split_by(oversized_rows, "origin", threshold),
            "threshold_sensitivity": threshold_sensitivity(prod_rows),
            "threshold_sensitivity_oversized": threshold_sensitivity(oversized_rows),
        },
        "sweep": sweep,
        "centring": centring_analysis(per_query, prod_rows, threshold),
        "anchor_failures": anchor_failures(per_query),
        "chunk_only": {
            "note": (
                "group_by_section: false — до модели едет только текст чанка. "
                "Честный контроль того, окупает ли раскрытие раздела свою сложность"
            ),
            "all": summarize(chunk_rows, threshold),
            "oversized_only": summarize(
                [r for r in chunk_rows if r["section_chars"] > PROD_CAP], threshold
            ),
            "by_origin": split_by(chunk_rows, "origin", threshold),
            "threshold_sensitivity": threshold_sensitivity(chunk_rows),
        },
        "per_query": per_query,
        "timing": state["timing"],
    }


# --------------------------------------------------------------------------- #
# Человеческая сводка
# --------------------------------------------------------------------------- #


def _pct(value: float | None) -> str:
    return "  —  " if value is None else f"{value * 100:5.1f}%"


def _num(value: float | None) -> str:
    return "—" if value is None else f"{value:,.0f}".replace(",", " ")


def print_summary(report: dict[str, Any], out: Any = print) -> None:
    out("")
    out("=" * 78)
    out("СТЫК 4: выдача → окно раздела. Доезжает ли ответ до модели после обрезки")
    out("=" * 78)
    out(report["caveat"])
    out("")
    corpus = report["corpus"]
    out(f"корпус: {corpus['label']}")
    out(
        f"  чанков {corpus['chunk_count']}, разделов {corpus['section_count']}, "
        f"разделов длиннее {corpus['prod_cap']}: {corpus['sections_over_prod_cap']}, "
        f"чанков в них: {corpus['chunks_in_oversized_sections']}"
    )
    golden = report["golden"]
    out(
        f"вопросов: {golden['rows']}, отвечаемых с эталоном: {golden['with_ground_truth']}, "
        f"промах ретривала: {golden['retrieval_miss']}, измерено: {golden['measured']} "
        f"(из них раздел переразмерный: {golden['oversized_section']})"
    )
    measure = report["measure"]
    out(
        f"мера: {measure['terms']}; знаменатель — {measure['denominator']}; "
        f"порог {measure['threshold']}"
    )
    ceiling = report["ceiling"]
    out(
        f"потолок пересказа: в разделе есть "
        f"{_pct(ceiling['attainable_share_mean'])} термов ответа (среднее) — "
        f"остальное недостижимо ни при каком лимите"
    )

    out("")
    out("--- 1. Продовая конфигурация (окно 4000, центрированное) ---")
    out(f"{'срез':<28} {'n':>4} {'ответ доехал':>13} {'покрытие':>9} {'символов':>9}")
    prod = report["prod"]

    def row(name: str, stats: dict[str, Any]) -> None:
        out(
            f"{name:<28} {stats['judged']:>4} {_pct(stats['contained']):>13} "
            f"{_pct(stats['containment_mean']):>9} {_num(stats['chars_mean']):>9}"
        )

    row("всего", prod["all"])
    row("  раздел > 4000", prod["oversized_only"])
    for name, stats in prod["by_origin"].items():
        row(f"origin: {name}", stats)
    for name, stats in prod["by_origin_oversized"].items():
        row(f"origin: {name} (>4000)", stats)
    out("")
    for name, stats in prod["by_category"].items():
        row(f"category: {name}", stats)
    out("")
    out("чувствительность к порогу (всего / только переразмерные):")
    grid = prod["threshold_sensitivity"]
    grid_over = prod["threshold_sensitivity_oversized"]
    out("  " + "  ".join(f"{t}:{_pct(grid[t]).strip()}" for t in sorted(grid)))
    out("  " + "  ".join(f"{t}:{_pct(grid_over[t]).strip()}" for t in sorted(grid_over)))

    out("")
    out("--- 2. Свип по section_max_chars (цена — символы на вопрос) ---")
    out(
        f"{'лимит':>9} {'режим':<9} {'ответ доехал':>13} {'то же, >4000':>13} "
        f"{'символов':>9} {'5 блоков':>9}"
    )
    for entry in report["sweep"]:
        cap = "∞" if entry["cap"] is None else str(entry["cap"])
        out(
            f"{cap:>9} {entry['mode']:<9} {_pct(entry['contained']):>13} "
            f"{_pct(entry['oversized_only']['contained']):>13} "
            f"{_num(entry['chars_mean']):>9} {_num(entry['chars_5_blocks']):>9}"
        )

    out("")
    out("--- 3. Работает ли центрирование (только переразмерные разделы) ---")
    c = report["centring"]
    out(f"вопросов в срезе: {c['oversized_judged']}")
    out(f"якорь найден в разделе:            {_pct(c['anchor_located'])}")
    out(f"локус целиком в окне, центр:       {_pct(c['locus_inside_centred'])}")
    out(f"локус целиком в окне, префикс:     {_pct(c['locus_inside_prefix'])}")
    out(
        f"локус ВНЕ окна при центрировании:  {c['locus_outside_centred']} "
        f"(медиана |якорь − локус| = {_num(c['anchor_to_locus_chars_median_when_outside'])} симв.)"
    )
    out(f"медиана |якорь − локус| вообще:    {_num(c['anchor_to_locus_chars_median'])} симв.")
    out(
        f"центр лучше префикса: {c['better_centred']}, "
        f"префикс лучше центра: {c['better_prefix']}, "
        f"поровну: {c['equal']}"
    )
    af = report["anchor_failures"]
    out("")
    out(
        f"якорь НЕ найден: {af['total']} из {af['of_measured']} "
        f"(на переразмерных {af['oversized']} из {af['oversized_of']}) — "
        f"окно молча падает в префикс"
    )
    out(f"  по content_kind: {af['by_content_kind']}")

    out("")
    out("--- 4. Контроль: group_by_section: false (только текст чанка) ---")
    chunk = report["chunk_only"]
    row("чанк, всего", chunk["all"])
    row("чанк, раздел > 4000", chunk["oversized_only"])
    row("раздел 4000, всего", prod["all"])
    row("раздел 4000, >4000", prod["oversized_only"])
    out("")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Стык 4: доезжает ли ответ до модели после обрезки раздела до "
            "section_max_chars. " + CAVEAT
        )
    )
    parser.add_argument(
        "--chunks", required=True, type=Path, help="JSONL от `audit_chunk.ts --chunks`"
    )
    parser.add_argument(
        "--sections",
        required=True,
        type=Path,
        help="JSONL от `section_windows.ts sections <vault>`",
    )
    parser.add_argument(
        "--golden",
        action="append",
        type=Path,
        default=None,
        metavar="FILE.jsonl",
        help="золотой набор; повторяемый. По умолчанию golden.jsonl + golden.corpus.jsonl",
    )
    parser.add_argument("--out", required=True, type=Path, help="куда писать window-report.json")
    parser.add_argument(
        "--caps",
        type=str,
        default=",".join(str(c) for c in DEFAULT_CAPS),
        help="список section_max_chars через запятую; 0 = без ограничения",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=DEFAULT_THRESHOLD,
        help="доля достижимых термов, начиная с которой ответ считается доехавшим",
    )
    parser.add_argument(
        "--locus-coverage",
        type=float,
        default=DEFAULT_LOCUS_COVERAGE,
        help="доля достижимых термов, которую обязан покрыть локус ответа",
    )
    parser.add_argument(
        "--cache", type=Path, default=Path("/tmp/audit/embeddings.npz"), help="кэш эмбеддингов"
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help="имя модели HuggingFace")
    parser.add_argument("--device", default=None, help="mps/cpu/cuda (по умолчанию — авто)")
    parser.add_argument(
        "--limit", type=int, default=DEFAULT_LIMIT, help="внешний лимит поиска (прод: 40)"
    )
    parser.add_argument("--label", default=None, help="имя корпуса в отчёте")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    started = time.monotonic()
    args.caps = tuple(dict.fromkeys(int(c) for c in str(args.caps).split(",") if c.strip() != ""))
    if PROD_CAP not in args.caps:
        raise SystemExit(f"--caps обязан содержать продовый {PROD_CAP}: он база всех срезов")
    if args.golden is None:
        args.golden = [
            REPO_ROOT / "tools" / "eval" / "golden.jsonl",
            REPO_ROOT / "tools" / "eval" / "golden.corpus.jsonl",
        ]

    chunks = load_chunks(args.chunks)
    sections = load_sections(args.sections)
    raw_rows = load_golden_files(args.golden)
    ground_truths = {str(r.get("id", "")): str(r.get("ground_truth") or "") for r in raw_rows}
    queries = to_queries(raw_rows)
    answerable = [q for q in queries if not q.expected_refusal and q.source_path]
    with_gt = [q for q in answerable if ground_truths.get(q.id, "").strip()]

    variant = parse_variant({"name": "prod"})
    stages = default_post_pipeline(True)
    doc_dense_texts, doc_sparse_texts = variant_doc_texts(variant, chunks)
    query_dense_texts, query_sparse_texts = variant_query_texts(variant, with_gt)

    memo = SparseMemo()
    doc_sparse = memo.vectors(doc_sparse_texts, "document")
    query_sparse = memo.vectors(query_sparse_texts, "query")

    embedder = DenseEmbedder(args.model, args.cache, args.device)
    doc_dense = embedder.embed([PASSAGE_PREFIX + t for t in doc_dense_texts])
    query_dense = embedder.embed(query_dense_texts)
    embedder.flush()

    corpus = Corpus(chunks=chunks, dense=doc_dense, sparse=SparseIndex(doc_sparse))
    ranked = retrieve(corpus, with_gt, query_dense, query_sparse, variant, stages, args.limit)
    anchors, missed = pick_anchors(corpus, sections, with_gt, ground_truths, ranked)

    tokenizer = Tokenizer()
    result = measure(anchors, tokenizer, args.caps, args.threshold, args.locus_coverage)

    section_chars = {key: len(section.text) for key, section in sections.items()}
    state = {
        "chunk_count": len(chunks),
        "section_count": len(sections),
        "sections_over_cap": sum(1 for n in section_chars.values() if n > PROD_CAP),
        "chunks_in_oversized": sum(
            1 for c in chunks if section_chars.get((c.path, c.parent_id), 0) > PROD_CAP
        ),
        "rows_total": len(queries),
        "answerable": len(answerable),
        "with_gt": len(with_gt),
        "retrieval_miss": len(missed),
        "measure": result,
        "timing": {
            "total_s": round(time.monotonic() - started, 2),
            "tokenized_texts": tokenizer.computed,
        },
    }
    report = build_report(args, state)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )
    print_summary(report)
    print(f"отчёт: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
