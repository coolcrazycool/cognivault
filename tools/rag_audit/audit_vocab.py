#!/usr/bin/env python3
"""Словарный разрыв: сбивает ли формулировка вопроса «языком пользователя» нужный
документ из набора кандидатов.

Инструмент отвечает на ОДИН вопрос и не притворяется, что отвечает на другие. Набор
(`tools/eval/golden.vocab.jsonl`) устроен ПАРАМИ: одна и та же потребность задана
дважды — словами пользователя (`variant: "mismatch"`) и словами корпуса
(`variant: "matched"`), — и обе строки указывают на ОДИН И ТОТ ЖЕ документ
(`gold_paths`). Тогда разница между арками пары не смешана ни с чем: корпус тот же,
модель та же, слияние то же, документ тот же. Меняется только формулировка.

    python3 tools/rag_audit/audit_vocab.py \\
        --chunks /tmp/audit/chunks.jsonl \\
        --set tools/eval/golden.vocab.jsonl \\
        --out /tmp/audit/vocab-report.json

Замер целиком переиспользует стык 3 (`audit_retrieval.py`): те же чанки, тот же
продовый вариант (RRF, глубины из `service.ts`, продовый хвост пост-обработки),
те же построители разреженных векторов. Здесь нет второй копии поиска — есть другой
СПОСОБ ЧИТАТЬ его выдачу.

╔══════════════════════════════════════════════════════════════════════════════╗
║ ТРИ ВЕТКИ НЕЛЬЗЯ СКЛАДЫВАТЬ В ОДНО ЧИСЛО.                                    ║
║ `bm25` — разреженная сторона считается ПРОДОВЫМ `src/lib/bm25.ts`, и именно   ║
║ по точному совпадению термов словарный разрыв бьёт в первую очередь: это      ║
║ несущее число отчёта, и оно переносится в прод.                              ║
║ `dense` — плотные вектора даёт ПОДМЕНА `multilingual-e5-base`; способность    ║
║ модели перекинуть мост между «переводом» и «трансфером» — свойство ИМЕННО     ║
║ ЭТОГО эмбеддера, и про EmbeddingsGigaR оно не говорит ничего.                 ║
║ `hybrid` — слияние продовое, но одна из двух его веток подменная, поэтому его ║
║ абсолют тоже не переносится.                                                 ║
║ Сводной цифры «по всем веткам» отчёт не печатает: она была бы средним между   ║
║ измеренным и предположенным.                                                 ║
╚══════════════════════════════════════════════════════════════════════════════╝

Что меряется
------------
* **recall@k, k ∈ {5, 10, 20, 40}, отдельно по `variant`** — маргинальные доли, они же
  контекст. 40 — не круглое число: столько кандидатов просит чат-конвейер UI
  (`rag.rerank_candidates`), и всё, что не попало в 40, до грейдера не доезжает вовсе.
* **ПАРНАЯ дельта** — главное. Для каждой пары: достал ли `matched` золотой документ на
  отсечке k, когда `mismatch` не достал. Считаются все четыре клетки (оба / только
  matched / только mismatch / ни один), потому что «только mismatch» — это индикатор
  шума, без которого «только matched» нечем интерпретировать.
* **Разрез по `mechanism`** — лечение у механизмов разное: алиас-мапа стоит день,
  дыра на чистом перефразе не лечится словарём вовсе.
* **Диагноз каждого промаха** — ранг золотого (или «его нет»), кто занял топ-5,
  пересечение стеммов вопроса и документа по продовому `tokenize`.
* **Почти-двойники.** Если у золотого объявлены `near_duplicates` и на отсечке в
  выдаче стоит двойник, а золотого нет — это НЕ словарный разрыв, а вытеснение
  сестринской страницей, и лечится оно не переписыванием запроса. Такие пары
  считаются отдельной строкой и из счёта разрыва вычитаются.

Статистическая честность
------------------------
25–40 пар — маленькая выборка, и отчёт устроен так, чтобы это нельзя было забыть:
* у каждой доли печатается интервал Уилсона 95% (stdlib, без новых зависимостей);
* парная асимметрия проверяется ТОЧНЫМ тестом Макнемара (биномиальный знаковый тест
  на дискордантных парах) — правильный тест именно для парных бинарных данных;
* печатается **разрешающая способность прибора**: при нулевой обратной дискордантности
  нужно не меньше `MIN_DISCORDANT` пар с разрывом, чтобы p ≤ 0.05. Меньше — набор не
  отличает разрыв от монетки, СКОЛЬКО БЫ пар в нём ни было;
* печатается **квант шума** 1/n пар — та же дисциплина, что в `scorecard.py`: разница,
  не превышающая кванта, выводом не является и так и написана;
* критерии «что убьёт идею переписывания запроса» и «что её поддержит» ЗАФИКСИРОВАНЫ
  в коде (`PREREGISTERED`) и печатаются ДО чисел. Ноль парных промахов — это «headroom
  нет, идея мертва», законный результат замера, а не его провал.

Чего инструмент НЕ меряет
-------------------------
* качество ответа модели — генерации здесь нет;
* грейдер/реранкер UI — офлайн его нет;
* поведение продового эмбеддера — см. рамку выше;
* «правильно ли размечен набор» — если золотого пути нет в корпусе, пара исключается и
  перечисляется в отчёте, но проверить осмысленность формулировок инструмент не может.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parents[1]
sys.path.insert(0, str(TOOLS_DIR))

# Весь поиск — из стыка 3, импортом, а не копией: продовые константы, глубины веток,
# построители разреженных векторов, продовый хвост пост-обработки и мост к
# `collapseCrossFileDuplicates` там уже есть и уже проверены тестами. Вторая копия
# разъехалась бы, и два отчёта по одному корпусу считали бы разный поиск.
import audit_retrieval as ar  # noqa: E402

BRANCHES = ar.BRANCHES  # ("dense", "bm25", "hybrid")

#: Ветка, на которой стоит вывод. Разреженная сторона считается продовым кодом
#: (`src/lib/bm25.ts` через мост), и словарное несовпадение бьёт именно по точному
#: совпадению термов — значит, здесь эффект обязан быть виден, и здесь он переносится.
LOAD_BEARING_BRANCH = "bm25"

#: Порядок веток в табло: несущая первой. Читать отчёт сверху вниз и наткнуться
#: сперва на подменную модель — верный способ запомнить не то число.
PRINT_ORDER = ("bm25", "dense", "hybrid")

#: Насколько ветка переносится в прод. Печатается у каждой таблицы — читать три
#: числа как одно семейство нельзя.
BRANCH_TRANSFER: dict[str, str] = {
    "bm25": (
        "ПРОДОВАЯ: вектора считает src/lib/bm25.ts (обе стороны, разными "
        "построителями) — вывод переносится в прод"
    ),
    "dense": (
        "ПОДМЕНА: multilingual-e5-base вместо GigaChat EmbeddingsGigaR — вывод "
        "описывает эту модель, а не прод"
    ),
    "hybrid": (
        "СМЕСЬ: слияние и глубины продовые, но плотная ветка подменная — абсолют "
        "не переносится"
    ),
}

#: Отсечки. 40 — размер набора кандидатов, который реально потребляет чат-конвейер.
KS: tuple[int, ...] = (5, 10, 20, 40)
#: Главная отсечка: документ, не попавший в 40, до грейдера не доезжает вовсе —
#: это и есть «выбит из набора кандидатов».
PRIMARY_K = 40
#: Вторая отсечка: разрыв, который живёт на 10, но исчезает на 40, — это проблема
#: ПОРЯДКА, а не полноты, и лечится реранкером, а не переписыванием запроса.
SECONDARY_K = 10

#: Две арки пары.
ARM_MISMATCH = "mismatch"
ARM_MATCHED = "matched"
ARMS = (ARM_MISMATCH, ARM_MATCHED)

#: Механизмы расхождения словаря. Список закрытый: незнакомое значение — громкая
#: ошибка, потому что разрез по механизму и есть ответ на вопрос «чем лечить».
MECHANISMS = ("synonym", "ru_en", "abbreviation", "paraphrase", "alias", "colloquial")

#: Механизмы, которые лечатся дешёвой мапой (алиасы/аббревиатуры/транслит/синонимы),
#: в отличие от перефраза и разговорной речи, где словаря не хватит.
CHEAP_MECHANISMS = ("alias", "abbreviation", "ru_en", "synonym")

#: Какую долю разрыва набор обязан уметь ИСКЛЮЧИТЬ, чтобы «разрыва нет» вообще имело
#: смысл. Ноль промахов на трёх парах — не «headroom нет», а «мы не смотрели»:
#: верхняя граница Уилсона там 0.56, то есть каждый второй вопрос всё ещё мог бы
#: терять документ. Приговор идее выносится, только если верхняя граница доли разрыва
#: ≤ этого числа — на нуле промахов это требует ≥ 16 пар, на одном ≥ 27.
KILL_MAX_GAP_RATE = 0.20

#: Обязательные поля строки набора сверх того, что требует харнесс.
REQUIRED_FIELDS = ("id", "question", "pair_id", "variant", "mechanism")

CAVEAT = (
    "ТРИ ВЕТКИ — ТРИ РАЗНЫХ СТАТУСА: bm25 продовый (вывод переносится), dense — "
    "подменный эмбеддер multilingual-e5-base (про EmbeddingsGigaR не говорит ничего), "
    "hybrid — смесь. Сводного числа по веткам нет намеренно."
)


# --------------------------------------------------------------------------- #
# Статистика (stdlib; новых зависимостей не добавляется намеренно)
# --------------------------------------------------------------------------- #


def wilson_interval(hits: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Интервал Уилсона 95% для доли.

    Не нормальное приближение: на n = 30 и доле у края (0 или 1) оно даёт интервал
    нулевой ширины, то есть врёт ровно там, где неопределённость максимальна.
    Уилсон при hits = 0 честно отдаёт верхнюю границу заметно выше нуля.
    """
    if n <= 0:
        return (0.0, 1.0)
    p = hits / n
    denom = 1.0 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1.0 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def mcnemar_exact(b: int, c: int) -> float:
    """Точный двусторонний тест Макнемара на парных бинарных данных.

    `b` — пар, где `matched` нашёл, а `mismatch` нет; `c` — наоборот. Согласные пары
    (оба нашли / оба нет) в тест не входят по построению: они не несут информации о
    НАПРАВЛЕНИИ. При нулевой гипотезе «формулировка ни при чём» каждая дискордантная
    пара — честная монетка, поэтому p = 2·P(X ≤ min(b,c)), X ~ Bin(b+c, 1/2).

    Точный, а не χ² с поправкой: на десятке дискордантных пар асимптотика не работает,
    а `math.comb` считает это без единой зависимости.
    """
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / (2.0**n)
    return min(1.0, 2.0 * tail)


def min_detectable_discordant(alpha: float = 0.05) -> int:
    """Сколько пар с разрывом нужно, чтобы тест вообще мог сказать «не монетка».

    Считается по самой `mcnemar_exact`, а не вписано числом: если тест когда-нибудь
    поменяют, разрешающая способность в отчёте поменяется вместе с ним, а не соврёт.
    Ответ не зависит от n набора — только от того, сколько пар легло в одну сторону.
    """
    b = 1
    while mcnemar_exact(b, 0) > alpha and b < 64:
        b += 1
    return b


#: Разрешающая способность парного теста при нулевой обратной дискордантности.
MIN_DISCORDANT = min_detectable_discordant()


# --------------------------------------------------------------------------- #
# Предзаявленные критерии — ДО чисел, а не после
# --------------------------------------------------------------------------- #

PREREGISTERED: tuple[str, ...] = (
    f"Всё ниже зафиксировано в коде ДО прогона (`PREREGISTERED`), решает ветка "
    f"{LOAD_BEARING_BRANCH} (единственная продовая), отсечка k={PRIMARY_K} "
    f"(столько кандидатов потребляет чат-конвейер).",
    "",
    "ИДЕЮ ПЕРЕПИСЫВАНИЯ ЗАПРОСА УБИВАЕТ:",
    f"  • разрыв ≤ 1 пары одновременно на k={PRIMARY_K} и k={SECONDARY_K}, ПРИ ТОМ ЧТО "
    f"верхняя граница 95% для доли разрыва ≤ {KILL_MAX_GAP_RATE:.2f} — headroom нет: "
    "словами корпуса находится ровно то же, что словами пользователя, и переписывать "
    "нечего. Это ЗАКОННЫЙ исход замера, а не его провал. Оговорка про границу не "
    "формальность: ноль промахов на трёх парах — это «мы не смотрели», а не «нет»;",
    "  • «только mismatch» ≥ «только matched» — направление отсутствует, набор мерит "
    "не то, что заявлено (или арки перепутаны местами);",
    "  • разрыв есть, но больше половины его пар — вытеснение почти-двойником: дефект "
    "другой (сестринские страницы), и переписывание запроса его не лечит.",
    "",
    "ИДЕЮ ПОДДЕРЖИВАЕТ:",
    f"  • разрыв ≥ {MIN_DISCORDANT} пар на k={PRIMARY_K} при p(Макнемар) ≤ 0.05, и это "
    "НЕ вытеснение двойником: золотой документ действительно теряется, а словами "
    "корпуса находится;",
    "  • разрыв сосредоточен в механизмах "
    + "/".join(CHEAP_MECHANISMS)
    + " — их лечит мапа, а не модель.",
    "",
    "ЧАСТИЧНЫЙ ИСХОД (лечится НЕ переписыванием):",
    f"  • на k={PRIMARY_K} разрыва нет, а на k={SECONDARY_K} есть — документ из "
    "кандидатов не выбит, он стоит ниже. Это задача реранкера/глубины, не словаря.",
    "",
    f"РАЗРЕШАЮЩАЯ СПОСОБНОСТЬ: при нулевой обратной дискордантности нужно ≥ "
    f"{MIN_DISCORDANT} пар в одну сторону, иначе p > 0.05 — сколько бы пар ни было в "
    "наборе. Разрыв в 2–5 пар этот прибор от монетки не отличает и не будет объявлен "
    "находкой.",
)


# --------------------------------------------------------------------------- #
# Набор: чтение и валидация
# --------------------------------------------------------------------------- #


class SetError(SystemExit):
    """Ошибка набора: печатается списком, а не трейсбеком.

    Набор пишется параллельно с этим инструментом, поэтому «файла ещё нет» и «в
    строке 12 нет mechanism» — штатные состояния, и они обязаны читаться с первого
    взгляда, а не через стек вызовов.
    """

    def __init__(self, problems: Sequence[str], header: str) -> None:
        shown = list(problems[:25])
        more = len(problems) - len(shown)
        text = header + "\n" + "\n".join(f"  • {p}" for p in shown)
        if more > 0:
            text += f"\n  … и ещё {more}"
        super().__init__(text)


@dataclass(frozen=True)
class Arm:
    """Одна арка пары — то есть одна строка набора."""

    id: str
    pair_id: str
    variant: str
    mechanism: str
    question: str
    gold_paths: tuple[str, ...]
    near_duplicates: tuple[str, ...] = ()
    category: str = "unclassified"


@dataclass(frozen=True)
class Pair:
    """Пара арок: та же потребность, тот же документ, разная формулировка."""

    pair_id: str
    mechanism: str
    mismatch: Arm
    matched: Arm

    @property
    def gold_paths(self) -> tuple[str, ...]:
        return self.mismatch.gold_paths

    @property
    def near_duplicates(self) -> tuple[str, ...]:
        merged = dict.fromkeys((*self.mismatch.near_duplicates, *self.matched.near_duplicates))
        return tuple(merged)

    def arms(self) -> tuple[Arm, Arm]:
        return (self.mismatch, self.matched)


def _gold_paths_of(row: Mapping[str, Any]) -> tuple[str, ...]:
    """`gold_paths` из контракта; для строки, написанной по старой схеме золотого
    набора, собирается из `source_path` + `alt_source_paths` — чтобы файл оставался
    пригодным и для харнесса `tools/eval/run.py`, который знает только их."""
    raw = row.get("gold_paths")
    if raw:
        return tuple(str(p) for p in raw if p)
    fallback = [row.get("source_path"), *(row.get("alt_source_paths") or [])]
    return tuple(str(p) for p in fallback if p)


def parse_rows(rows: Sequence[Mapping[str, Any]], source: str) -> list[Arm]:
    """Строки набора → арки. Проблемы КОПЯТСЯ и печатаются списком.

    Падать на первой ошибке было бы неудобно ровно тогда, когда инструмент нужнее
    всего: набор пишется вручную, и ошибок в нём обычно не одна.
    """
    problems: list[str] = []
    arms: list[Arm] = []
    seen_ids: set[str] = set()
    for position, row in enumerate(rows, start=1):
        where = f"строка {position}"
        row_id = str(row.get("id") or "")
        if row_id:
            where = f"{where} (id {row_id})"
        missing = [f for f in REQUIRED_FIELDS if not str(row.get(f) or "").strip()]
        if missing:
            problems.append(f"{where}: нет обязательных полей {missing}")
            continue
        if row_id in seen_ids:
            problems.append(f"{where}: id повторяется")
            continue
        seen_ids.add(row_id)
        variant = str(row["variant"]).strip()
        if variant not in ARMS:
            problems.append(f"{where}: variant={variant!r}, а должен быть один из {list(ARMS)}")
            continue
        mechanism = str(row["mechanism"]).strip()
        if mechanism not in MECHANISMS:
            problems.append(
                f"{where}: mechanism={mechanism!r} не из {list(MECHANISMS)} — "
                "разрез по механизму отвечает на вопрос «чем лечить», и незнакомое "
                "значение в нём молча потерялось бы"
            )
            continue
        if row.get("expected_refusal"):
            problems.append(
                f"{where}: expected_refusal=true — ловушке нечего искать, парный "
                "контраст на ней не определён"
            )
            continue
        gold = _gold_paths_of(row)
        if not gold:
            problems.append(
                f"{where}: нет gold_paths (и нечем заменить: source_path/alt_source_paths пусты)"
            )
            continue
        arms.append(
            Arm(
                id=row_id,
                pair_id=str(row["pair_id"]).strip(),
                variant=variant,
                mechanism=mechanism,
                question=str(row["question"]).strip(),
                gold_paths=gold,
                near_duplicates=tuple(str(p) for p in (row.get("near_duplicates") or []) if p),
                category=str(row.get("category") or "").strip() or "unclassified",
            )
        )
    if problems:
        raise SetError(problems, f"{source}: строки не проходят контракт парного набора:")
    return arms


def build_pairs(arms: Sequence[Arm], source: str) -> list[Pair]:
    """Арки → пары. Всё, что не сложилось в пару, — громкая ошибка.

    Осиротевшая арка не «просто не считается»: она молча уменьшила бы знаменатель
    парного контраста, и разрыв «7 из 30» оказался бы «7 из 26» без единого следа
    в отчёте.
    """
    problems: list[str] = []
    buckets: dict[str, dict[str, list[Arm]]] = {}
    for arm in arms:
        buckets.setdefault(arm.pair_id, {}).setdefault(arm.variant, []).append(arm)

    pairs: list[Pair] = []
    for pair_id, by_variant in buckets.items():
        for variant in ARMS:
            if len(by_variant.get(variant, [])) > 1:
                ids = [a.id for a in by_variant[variant]]
                problems.append(f"пара {pair_id}: арок {variant} больше одной ({ids})")
        missing = [v for v in ARMS if not by_variant.get(v)]
        if missing:
            present = [a.id for group in by_variant.values() for a in group]
            problems.append(
                f"пара {pair_id}: нет арок {missing} (есть только {present}) — "
                "парный контраст без обеих арок не определён"
            )
            continue
        if any(len(by_variant.get(v, [])) > 1 for v in ARMS):
            continue
        mismatch, matched = by_variant[ARM_MISMATCH][0], by_variant[ARM_MATCHED][0]
        if set(mismatch.gold_paths) != set(matched.gold_paths):
            problems.append(
                f"пара {pair_id}: gold_paths арок различаются "
                f"({sorted(mismatch.gold_paths)} vs {sorted(matched.gold_paths)}) — "
                "тогда арки ищут разное, и разница между ними больше не про формулировку"
            )
            continue
        if mismatch.mechanism != matched.mechanism:
            problems.append(
                f"пара {pair_id}: mechanism арок различается "
                f"({mismatch.mechanism} vs {matched.mechanism})"
            )
            continue
        if mismatch.question == matched.question:
            problems.append(f"пара {pair_id}: обе арки — один и тот же текст вопроса")
            continue
        pairs.append(
            Pair(
                pair_id=pair_id,
                mechanism=mismatch.mechanism,
                mismatch=mismatch,
                matched=matched,
            )
        )
    if problems:
        raise SetError(problems, f"{source}: набор не складывается в пары:")
    return sorted(pairs, key=lambda p: p.pair_id)


def load_pairs(path: Path) -> list[Pair]:
    """Файл набора → пары. Правила чтения самих строк — от харнесса.

    `load_golden` берётся из `tools/eval/run.py` (импортирован в `audit_retrieval`),
    чтобы `accepted: false` выбрасывалось здесь ровно так же, как в харнессе: две
    копии этого правила однажды разъехались бы, и два отчёта по одному файлу считали
    бы разные наборы.
    """
    if not path.exists():
        raise SystemExit(
            f"парного набора нет: {path}\n"
            "  Файл пишется отдельно (tools/eval/golden.vocab.jsonl). Инструмент "
            "готов, набора ещё нет — это не ошибка инструмента.\n"
            "  Ожидаемая строка: id, question, pair_id, variant (mismatch|matched), "
            f"mechanism ({'|'.join(MECHANISMS)}), gold_paths[], "
            "near_duplicates[] (необязательно)."
        )
    try:
        rows = ar.load_golden(str(path))
    except ValueError as exc:
        raise SystemExit(f"{path}: файл не читается как JSONL — {exc}") from exc
    if not rows:
        raise SystemExit(f"{path}: пусто (все строки отброшены или файл пуст)")
    return build_pairs(parse_rows(rows, str(path)), str(path))


# --------------------------------------------------------------------------- #
# Выдача по арке
# --------------------------------------------------------------------------- #


@dataclass
class ArmOutcome:
    """Что поиск сделал с одной аркой — по каждой ветке."""

    arm: Arm
    #: Место первого золотого чанка в ПРОДОВОЙ выдаче ветки (с единицы), либо None.
    ranks: dict[str, int | None] = field(default_factory=dict)
    #: Место первого почти-двойника там же — им отличается «вытеснение» от «потери».
    twin_ranks: dict[str, int | None] = field(default_factory=dict)
    #: Первые пять РАЗНЫХ путей выдачи ветки — «а кто вместо него».
    top_paths: dict[str, list[str]] = field(default_factory=dict)
    #: Место золотого в ПОЛНОМ порядке ветки, без среза и пост-фильтров: отличает
    #: «чуть-чуть не дотянул» от «документ не разделил с вопросом ни одного терма».
    #: Для hybrid не определено — слияние считается только по кандидатам веток.
    deep_ranks: dict[str, int | None] = field(default_factory=dict)
    #: Стеммы вопроса (продовый tokenize) и их пересечение с золотым документом.
    query_stems: tuple[str, ...] = ()
    shared_stems: tuple[str, ...] = ()
    missing_stems: tuple[str, ...] = ()


@dataclass
class PairOutcome:
    pair: Pair
    mismatch: ArmOutcome
    matched: ArmOutcome

    @property
    def pair_id(self) -> str:
        return self.pair.pair_id

    @property
    def mechanism(self) -> str:
        return self.pair.mechanism


def tokenize_texts(texts: Sequence[str]) -> list[list[str]]:
    """Стеммы продовым `tokenize` через мост `vocab_terms.ts`.

    Питоновской копии токенизатора здесь нет по той же причине, по которой её нет в
    `audit_retrieval`: стеммер, стоп-слова и свёртка «ё» разошлись бы незаметно, и
    диагноз «этого слова нет в документе» оказался бы про несуществующую систему.
    """
    if not texts:
        return []
    import subprocess
    import tempfile

    script = TOOLS_DIR / "vocab_terms.ts"
    with tempfile.TemporaryDirectory(prefix="rag-audit-vocab-") as tmp:
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
            raise SystemExit(f"vocab_terms.ts упал ({result.returncode}): {result.stderr[-2000:]}")
        payload = json.loads(out_path.read_text(encoding="utf-8"))
    tokens = payload["tokens"]
    if len(tokens) != len(texts):
        raise SystemExit(f"vocab_terms.ts вернул {len(tokens)} наборов на {len(texts)} текстов")
    return [[str(t) for t in row] for row in tokens]


def first_rank_of_paths(ranked: Sequence[int], chunks: Sequence[Any], paths: set[str]) -> int | None:
    """Место (с единицы) первого чанка из указанных файлов в выдаче."""
    for position, doc in enumerate(ranked, start=1):
        if chunks[doc].path in paths:
            return position
    return None


def distinct_top_paths(ranked: Sequence[int], chunks: Sequence[Any], n: int = 5) -> list[str]:
    """Первые `n` РАЗНЫХ путей выдачи. Разных — потому что несколько чанков одного
    файла в выдаче штатны (`README`: дедуп по пути запрещён), и топ-5 чанков одной
    страницы не отвечает на вопрос «кто вместо золотого»."""
    seen: list[str] = []
    for doc in ranked:
        path = chunks[doc].path
        if path not in seen:
            seen.append(path)
        if len(seen) >= n:
            break
    return seen


def run_arms(
    pairs: Sequence[Pair],
    chunks: Sequence[Any],
    args: argparse.Namespace,
) -> tuple[list[PairOutcome], dict[str, Any]]:
    """Прогон всех арок продовой конфигурацией стыка 3.

    Вариант — `prod` из реестра `audit_retrieval`: RRF без параметров, глубины по
    формулам `service.ts`, хвост `dedupeChunks → dedupeSections →
    collapseCrossFileDuplicates`. Никаких вариантных ручек здесь нет намеренно: замер
    отвечает на вопрос про ФОРМУЛИРОВКУ, и любая вторая изменяемая величина сделала бы
    ответ неатрибутируемым.
    """
    variant = ar.parse_variant(ar.VARIANTS["prod"])
    stages = ar.default_post_pipeline(True)
    arms: list[Arm] = [arm for pair in pairs for arm in pair.arms()]

    # Вопросы в форме, которую понимает стык 3: строки нужны только ради текста
    # запроса, метрики считает этот модуль.
    queries = [
        ar.Query(
            id=arm.id,
            question=arm.question,
            category=arm.category,
            source_path=arm.gold_paths[0],
            section_path=None,
            expected_refusal=False,
            alt_source_paths=tuple(arm.gold_paths[1:]),
            origin="vocab",
        )
        for arm in arms
    ]

    doc_dense_texts, doc_sparse_texts = ar.variant_doc_texts(variant, chunks)
    query_dense_texts, query_sparse_texts = ar.variant_query_texts(variant, queries)

    memo = ar.SparseMemo()
    t0 = time.monotonic()
    doc_sparse = memo.vectors(doc_sparse_texts, "document")
    query_sparse = memo.vectors(query_sparse_texts, "query")
    sparse_s = time.monotonic() - t0

    embedder = ar.DenseEmbedder(args.model, args.cache, args.device)
    t0 = time.monotonic()
    doc_dense = embedder.embed([ar.PASSAGE_PREFIX + text for text in doc_dense_texts])
    query_dense = embedder.embed(query_dense_texts)
    embedder.flush()
    dense_s = time.monotonic() - t0

    corpus = ar.Corpus(chunks=list(chunks), dense=doc_dense, sparse=ar.SparseIndex(doc_sparse))

    # Стеммы: вопросы и полный текст каждого золотого файла, одним вызовом моста.
    gold_files = sorted({path for pair in pairs for path in pair.gold_paths})
    gold_text = {
        path: "\n".join(chunks[doc].text for doc in sorted(corpus.by_path.get(path, ())))
        for path in gold_files
    }
    token_texts = [arm.question for arm in arms] + [gold_text[p] for p in gold_files]
    tokenized = tokenize_texts(token_texts)
    question_stems = {arm.id: tokenized[i] for i, arm in enumerate(arms)}
    gold_stems = {
        path: set(tokenized[len(arms) + i]) for i, path in enumerate(gold_files)
    }

    t0 = time.monotonic()
    outcomes: dict[str, ArmOutcome] = {}
    for position, arm in enumerate(arms):
        runs = ar.run_branches(
            corpus,
            query_dense[position],
            query_sparse[position],
            variant,
            stages,
            args.limit,
            query_text=arm.question,
        )
        gold_set = set(arm.gold_paths)
        twin_set = set(arm.near_duplicates)
        outcome = ArmOutcome(arm=arm)
        for branch in BRANCHES:
            ranked = runs[branch].ranked
            outcome.ranks[branch] = first_rank_of_paths(ranked, chunks, gold_set)
            outcome.twin_ranks[branch] = (
                first_rank_of_paths(ranked, chunks, twin_set) if twin_set else None
            )
            outcome.top_paths[branch] = distinct_top_paths(ranked, chunks)

        # Глубокий ранг: тот же счёт ветки, но по ВСЕМУ корпусу и без пост-фильтров.
        # Считается здесь, а не в `run_branches`, потому что продовому поиску он не
        # нужен: это диагностическая величина, отличающая «стоял 41-м» от
        # «не разделил с вопросом ни одного терма».
        dense_scores = corpus.dense @ query_dense[position]
        sparse_scores = corpus.sparse.scores(query_sparse[position])
        outcome.deep_ranks["dense"] = first_rank_of_paths(
            ar.top_indices(dense_scores, len(chunks)), chunks, gold_set
        )
        outcome.deep_ranks["bm25"] = (
            first_rank_of_paths(
                ar.top_indices(sparse_scores, len(chunks), positive_only=True), chunks, gold_set
            )
            if query_sparse[position]["indices"]
            else None
        )
        outcome.deep_ranks["hybrid"] = None

        stems = question_stems[arm.id]
        gold_terms: set[str] = set()
        for path in arm.gold_paths:
            gold_terms |= gold_stems.get(path, set())
        unique_stems = tuple(dict.fromkeys(stems))
        outcome.query_stems = unique_stems
        outcome.shared_stems = tuple(s for s in unique_stems if s in gold_terms)
        outcome.missing_stems = tuple(s for s in unique_stems if s not in gold_terms)
        outcomes[arm.id] = outcome
    search_s = time.monotonic() - t0

    paired = [
        PairOutcome(pair=pair, mismatch=outcomes[pair.mismatch.id], matched=outcomes[pair.matched.id])
        for pair in pairs
    ]
    timing = {
        "sparse_s": round(sparse_s, 2),
        "dense_s": round(dense_s, 2),
        "search_s": round(search_s, 2),
        "embeddings_computed": embedder.computed,
        "sparse_vectors_computed": memo.computed,
    }
    return paired, timing


# --------------------------------------------------------------------------- #
# Арифметика: маргиналы, парный контраст, механизмы
# --------------------------------------------------------------------------- #


def hit(rank: int | None, k: int) -> bool:
    return rank is not None and rank <= k


def marginal(outcomes: Sequence[ArmOutcome], branch: str, k: int) -> dict[str, Any]:
    """recall@k одной арки со своим интервалом. Контекст, не вывод: маргинал не
    отличает «нашлось у обоих» от «нашлось у разных»."""
    n = len(outcomes)
    hits = sum(1 for o in outcomes if hit(o.ranks.get(branch), k))
    lo, hi = wilson_interval(hits, n)
    return {
        "n": n,
        "hits": hits,
        "recall": round(hits / n, 4) if n else 0.0,
        "ci95": [round(lo, 4), round(hi, 4)],
    }


def paired_counts(outcomes: Sequence[PairOutcome], branch: str, k: int) -> dict[str, Any]:
    """Четыре клетки парной таблицы плюс разбор разрыва.

    `gap` = «matched достал, mismatch нет». Из него ВЫЧИТАЕТСЯ `gap_near_twin` — пары,
    где в выдаче `mismatch` на отсечке стоит объявленный почти-двойник золотого:
    документ не потерян из-за словаря, его вытеснила сестринская страница, и лечение
    у этого другое. Остаток — `gap_vocab`, единственное число, про которое отчёт
    говорит «словарный разрыв».
    """
    both = only_matched = only_mismatch = neither = 0
    gap_vocab: list[str] = []
    gap_near_twin: list[str] = []
    reverse: list[str] = []
    for outcome in outcomes:
        m = hit(outcome.matched.ranks.get(branch), k)
        x = hit(outcome.mismatch.ranks.get(branch), k)
        if m and x:
            both += 1
        elif m and not x:
            only_matched += 1
            if hit(outcome.mismatch.twin_ranks.get(branch), k):
                gap_near_twin.append(outcome.pair_id)
            else:
                gap_vocab.append(outcome.pair_id)
        elif x and not m:
            only_mismatch += 1
            reverse.append(outcome.pair_id)
        else:
            neither += 1
    n = len(outcomes)
    lo, hi = wilson_interval(len(gap_vocab), n)
    return {
        "n_pairs": n,
        "both": both,
        "only_matched": only_matched,
        "only_mismatch": only_mismatch,
        "neither": neither,
        "gap": only_matched,
        "gap_vocab": len(gap_vocab),
        "gap_near_twin": len(gap_near_twin),
        "gap_vocab_rate": round(len(gap_vocab) / n, 4) if n else 0.0,
        "gap_vocab_ci95": [round(lo, 4), round(hi, 4)],
        "net": round((only_matched - only_mismatch) / n, 4) if n else 0.0,
        "mcnemar_p": round(mcnemar_exact(only_matched, only_mismatch), 4),
        "gap_vocab_pairs": gap_vocab,
        "gap_near_twin_pairs": gap_near_twin,
        "reverse_pairs": reverse,
        "within_noise": len(gap_vocab) <= 1,
        "resolvable": len(gap_vocab) >= MIN_DISCORDANT,
    }


def by_mechanism(outcomes: Sequence[PairOutcome], branch: str, k: int) -> dict[str, Any]:
    """Тот же разбор по механизмам. Здесь печатаются СЧЁТА, а не доли: на 25–40 парах
    механизму достаётся 4–7 пар, и «доля 0.6» на пяти парах — способ соврать точностью,
    которой нет."""
    groups: dict[str, list[PairOutcome]] = {}
    for outcome in outcomes:
        groups.setdefault(outcome.mechanism, []).append(outcome)
    return {
        mechanism: paired_counts(group, branch, k) for mechanism, group in sorted(groups.items())
    }


def diagnose(outcome: PairOutcome, branch: str, k: int) -> dict[str, Any]:
    """Всё, что нужно, чтобы понять КОНКРЕТНЫЙ промах, а не только сосчитать его."""
    mis, mat = outcome.mismatch, outcome.matched
    shared = set(mis.shared_stems)
    return {
        "pair_id": outcome.pair_id,
        "mechanism": outcome.mechanism,
        "gold_paths": list(outcome.pair.gold_paths),
        "mismatch": {
            "id": mis.arm.id,
            "question": mis.arm.question,
            "rank": mis.ranks.get(branch),
            "deep_rank": mis.deep_ranks.get(branch),
            "top_paths": mis.top_paths.get(branch, []),
            "near_twin_rank": mis.twin_ranks.get(branch),
            "stems": len(mis.query_stems),
            "stems_shared": len(mis.shared_stems),
            "stems_missing": list(mis.missing_stems),
        },
        "matched": {
            "id": mat.arm.id,
            "question": mat.arm.question,
            "rank": mat.ranks.get(branch),
            "deep_rank": mat.deep_ranks.get(branch),
            "stems": len(mat.query_stems),
            "stems_shared": len(mat.shared_stems),
            # Стеммы, которые есть у формулировки корпуса и которых нет у формулировки
            # пользователя, — это и есть «что именно надо было бы дописать».
            "stems_gained": [s for s in mat.shared_stems if s not in shared],
        },
        "verdict": (
            "вытеснение почти-двойником"
            if hit(mis.twin_ranks.get(branch), k)
            else "золотого нет в наборе кандидатов"
        ),
    }


def fmt_p(value: float) -> str:
    """p, округлённое до нуля, печатается как «< 0.0001»: «p=0.0» читается как
    «вероятность ноль», чего точный тест никогда не утверждает."""
    return "< 0.0001" if value < 0.0001 else f"= {value:.4f}"


def verdict(report: dict[str, Any]) -> dict[str, Any]:
    """Сверка чисел с ПРЕДЗАЯВЛЕННЫМИ критериями. Логика не подстраивается под
    результат — она записана выше по файлу и печатается до чисел."""
    branch = report["branches"][LOAD_BEARING_BRANCH]
    primary = branch["paired"][str(PRIMARY_K)]
    secondary = branch["paired"][str(SECONDARY_K)]
    lines: list[str] = []
    # Заявлять ОТСУТСТВИЕ разрыва можно, только если набор достаточно велик, чтобы
    # заметный разрыв в нём проявился бы. Формально: верхняя граница 95% для доли
    # разрыва должна быть не выше `KILL_MAX_GAP_RATE`.
    gap_upper = primary["gap_vocab_ci95"][1]
    can_deny = gap_upper <= KILL_MAX_GAP_RATE

    if primary["only_mismatch"] >= primary["only_matched"] and primary["only_matched"] > 0:
        outcome = "НАБОР НЕ ИЗМЕРЯЕТ ЗАЯВЛЕННОЕ"
        lines.append(
            f"на k={PRIMARY_K} «только mismatch» ({primary['only_mismatch']}) ≥ «только "
            f"matched» ({primary['only_matched']}): направления нет"
        )
    elif primary["gap"] > 0 and primary["gap_near_twin"] > primary["gap_vocab"]:
        outcome = "ДЕФЕКТ ДРУГОЙ: ВЫТЕСНЕНИЕ ПОЧТИ-ДВОЙНИКОМ"
        lines.append(
            f"из {primary['gap']} пар с разрывом {primary['gap_near_twin']} — это "
            "сестринская страница на месте золотого; переписывание запроса это не лечит"
        )
    elif primary["gap_vocab"] <= 1 and secondary["gap_vocab"] <= 1 and can_deny:
        outcome = "ИДЕЯ ПЕРЕПИСЫВАНИЯ ЗАПРОСА МЕРТВА (headroom нет)"
        lines.append(
            f"на k={PRIMARY_K} разрыв {primary['gap_vocab']} пар, на k={SECONDARY_K} — "
            f"{secondary['gap_vocab']}; квант шума — 1 пара, так что это ноль"
        )
        lines.append(
            f"набор достаточно велик, чтобы это значило «нет»: верхняя граница 95% для "
            f"доли разрыва {gap_upper:.3f} ≤ {KILL_MAX_GAP_RATE:.2f}"
        )
        lines.append("это законный исход замера: словами корпуса находится то же самое")
    elif primary["gap_vocab"] <= 1 and secondary["gap_vocab"] >= MIN_DISCORDANT:
        outcome = "ЭТО ЗАДАЧА ПОРЯДКА, А НЕ СЛОВАРЯ"
        lines.append(
            f"на k={PRIMARY_K} документ из кандидатов не выбит (разрыв "
            f"{primary['gap_vocab']}), а на k={SECONDARY_K} стоит ниже (разрыв "
            f"{secondary['gap_vocab']}) — лечится реранкером/глубиной"
        )
        if not can_deny:
            lines.append(
                f"ОГОВОРКА: половина вывода — «на k={PRIMARY_K} разрыва нет» — на этом "
                f"наборе не доказана: верхняя граница его доли {gap_upper:.3f} > "
                f"{KILL_MAX_GAP_RATE:.2f}"
            )
    elif primary["gap_vocab"] >= MIN_DISCORDANT and primary["mcnemar_p"] <= 0.05:
        outcome = "ЕСТЬ HEADROOM ДЛЯ ПЕРЕПИСЫВАНИЯ ЗАПРОСА"
        lines.append(
            f"на k={PRIMARY_K} разрыв {primary['gap_vocab']} пар из {primary['n_pairs']} "
            f"(p {fmt_p(primary['mcnemar_p'])}), обратных {primary['only_mismatch']}"
        )
        cheap = sum(
            item["gap_vocab"]
            for mechanism, item in branch["by_mechanism"][str(PRIMARY_K)].items()
            if mechanism in CHEAP_MECHANISMS
        )
        lines.append(
            f"из них {cheap} приходится на механизмы, которые лечит мапа "
            f"({'/'.join(CHEAP_MECHANISMS)})"
        )
    else:
        outcome = "НЕОПРЕДЕЛЁННО (эффект меньше разрешающей способности набора)"
        lines.append(
            f"на k={PRIMARY_K} разрыв {primary['gap_vocab']} пар при p "
            f"{fmt_p(primary['mcnemar_p'])}: чтобы отличить от монетки, нужно ≥ "
            f"{MIN_DISCORDANT} пар в одну сторону"
        )
        if primary["gap_vocab"] <= 1 and not can_deny:
            lines.append(
                f"и ЗАЯВИТЬ ОТСУТСТВИЕ разрыва тоже нельзя: верхняя граница 95% для его "
                f"доли — {gap_upper:.3f} (> {KILL_MAX_GAP_RATE:.2f}), то есть на "
                f"{primary['n_pairs']} парах ноль промахов совместим с тем, что теряет "
                "документ каждый пятый вопрос"
            )
        lines.append("вывод — «набор мал», а не «эффекта нет» и не «эффект есть»")

    return {
        "branch": LOAD_BEARING_BRANCH,
        "primary_k": PRIMARY_K,
        "outcome": outcome,
        "gap_vocab": primary["gap_vocab"],
        "gap_vocab_ci95": primary["gap_vocab_ci95"],
        "mcnemar_p": primary["mcnemar_p"],
        "can_deny_gap": can_deny,
        "reasons": lines,
    }


def analyse(outcomes: Sequence[PairOutcome], ks: Sequence[int] = KS) -> dict[str, Any]:
    """Полная арифметика отчёта — чистая функция от выдачи. Ровно она проверяется на
    синтетике: «стало лучше» не должно быть неотличимо от «поехала линейка»."""
    mismatch_arms = [o.mismatch for o in outcomes]
    matched_arms = [o.matched for o in outcomes]
    n = len(outcomes)
    branches: dict[str, Any] = {}
    for branch in BRANCHES:
        branches[branch] = {
            "transfer": BRANCH_TRANSFER[branch],
            "marginal": {
                str(k): {
                    ARM_MISMATCH: marginal(mismatch_arms, branch, k),
                    ARM_MATCHED: marginal(matched_arms, branch, k),
                }
                for k in ks
            },
            "paired": {str(k): paired_counts(outcomes, branch, k) for k in ks},
            "by_mechanism": {str(k): by_mechanism(outcomes, branch, k) for k in ks},
        }
    misses = [
        diagnose(outcome, LOAD_BEARING_BRANCH, PRIMARY_K)
        for outcome in outcomes
        if not hit(outcome.mismatch.ranks.get(LOAD_BEARING_BRANCH), PRIMARY_K)
    ]
    mechanisms = sorted({o.mechanism for o in outcomes})
    report = {
        "set": {
            "pairs": n,
            "arms": 2 * n,
            "mechanisms": {m: sum(1 for o in outcomes if o.mechanism == m) for m in mechanisms},
            "pairs_with_near_duplicates": sum(1 for o in outcomes if o.pair.near_duplicates),
        },
        "noise": {
            "one_pair": round(1.0 / n, 4) if n else 0.0,
            "min_discordant": MIN_DISCORDANT,
            "explanation": (
                f"квант — одна пара из {n}: доля, сдвинувшаяся не больше чем на неё, "
                "выводом не является. Парный тест при нулевой обратной дискордантности "
                f"требует ≥ {MIN_DISCORDANT} пар в одну сторону для p ≤ 0.05 — это "
                "разрешающая способность прибора, а не порог вкуса"
            ),
        },
        "branches": branches,
        "load_bearing_branch": LOAD_BEARING_BRANCH,
        "misses": misses,
    }
    report["verdict"] = verdict(report)
    return report


# --------------------------------------------------------------------------- #
# Печать
# --------------------------------------------------------------------------- #


def _fmt_ci(item: Mapping[str, Any]) -> str:
    lo, hi = item["ci95"]
    return f"{item['recall']:.2f} [{lo:.2f}–{hi:.2f}]"


def render(report: Mapping[str, Any]) -> str:
    """Табло. Предзаявленные критерии печатаются ДО чисел — иначе «мы так и думали»
    неотличимо от «мы так решили, посмотрев»."""
    out: list[str] = []
    w = out.append
    w("=" * 78)
    w("СЛОВАРНЫЙ РАЗРЫВ: парный набор (mismatch = слова пользователя, matched = слова корпуса)")
    w("=" * 78)
    w(CAVEAT)
    w("")

    meta = report["set"]
    noise = report["noise"]
    w(
        f"набор: {meta['pairs']} пар ({meta['arms']} строк), с почти-двойниками "
        f"{meta['pairs_with_near_duplicates']}"
    )
    w("механизмы: " + ", ".join(f"{m} {n}" for m, n in sorted(meta["mechanisms"].items())))
    w(f"квант шума: 1 пара = ±{noise['one_pair']:.4f}; {noise['explanation']}")
    if report.get("corpus"):
        corpus = report["corpus"]
        w(
            f"корпус: {corpus['label']} — {corpus['chunks']} чанков, {corpus['files']} файлов"
        )
        if corpus.get("smaller_than_cutoff"):
            w(
                f"  ВНИМАНИЕ: в корпусе {corpus['chunks']} чанков при отсечке k={max(KS)} — "
                "на такой выборке recall@k не измеряет ничего (в выдачу помещается "
                "почти весь корпус). Годится только для проверки формы отчёта."
            )
        if corpus.get("gold_paths_missing"):
            dropped = corpus.get("pairs_dropped") or []
            w(
                "ЗОЛОТЫЕ ПУТИ, КОТОРЫХ НЕТ В КОРПУСЕ: "
                + ", ".join(corpus["gold_paths_missing"])
                + (
                    f" — исключены пары {', '.join(dropped)}"
                    if dropped
                    else " (пары уцелели: у них есть и другой золотой путь)"
                )
            )
    w("")

    w("--- ЧТО РЕШЕНО ДО ПРОГОНА -------------------------------------------------")
    for line in PREREGISTERED:
        w(line)
    w("")

    for branch in PRINT_ORDER:
        data = report["branches"][branch]
        mark = " ← НЕСУЩАЯ" if branch == report["load_bearing_branch"] else ""
        w(f"=== ВЕТКА {branch}{mark} ===")
        w(f"    {data['transfer']}")
        w("")
        w("  recall@k по вариантам (маргиналы; интервал Уилсона 95%)")
        header = f"  {'вариант':<10}" + "".join(f"{'k=' + str(k):>18}" for k in KS)
        w(header)
        for arm in ARMS:
            cells = "".join(f"{_fmt_ci(data['marginal'][str(k)][arm]):>18}" for k in KS)
            w(f"  {arm:<10}{cells}")
        w("")
        w("  ПАРНЫЙ КОНТРАСТ — то, ради чего набор устроен парами")
        w(
            f"  {'k':>3}  {'оба':>4}{'только matched':>16}{'только mismatch':>17}"
            f"{'ни один':>9}{'разрыв(слов/двойн)':>20}{'p(Макнемар)':>13}"
        )
        for k in KS:
            item = data["paired"][str(k)]
            gap = f"{item['gap']} ({item['gap_vocab']}/{item['gap_near_twin']})"
            w(
                f"  {k:>3}  {item['both']:>4}{item['only_matched']:>16}"
                f"{item['only_mismatch']:>17}{item['neither']:>9}{gap:>20}"
                f"{item['mcnemar_p']:>13.4f}"
            )
        primary = data["paired"][str(PRIMARY_K)]
        lo, hi = primary["gap_vocab_ci95"]
        w(
            f"  k={PRIMARY_K}: словарный разрыв {primary['gap_vocab']}/{primary['n_pairs']} = "
            f"{primary['gap_vocab_rate']:.3f} [{lo:.3f}–{hi:.3f}], "
            f"нетто {primary['net']:+.3f}"
        )
        if primary["within_noise"]:
            w("  ↳ это ≤ 1 пары, то есть внутри кванта шума — находкой не является")
        elif not primary["resolvable"]:
            w(
                f"  ↳ меньше {MIN_DISCORDANT} пар: прибор не отличает это от монетки "
                "(см. разрешающую способность)"
            )
        if primary["gap_vocab_pairs"]:
            w("  ↳ пары с разрывом: " + ", ".join(primary["gap_vocab_pairs"]))
        if primary["reverse_pairs"]:
            w("  ↳ ОБРАТНЫЕ пары (нашёл mismatch, не нашёл matched): " + ", ".join(primary["reverse_pairs"]))
        w("")
        w(f"  по механизмам (k={PRIMARY_K}; СЧЁТА пар, не доли — n механизма мал)")
        for mechanism, item in data["by_mechanism"][str(PRIMARY_K)].items():
            w(
                f"    {mechanism:<14} пар {item['n_pairs']:>3}  разрыв {item['gap']:>2} "
                f"(словарь {item['gap_vocab']}, двойник {item['gap_near_twin']}), "
                f"обратных {item['only_mismatch']}"
            )
        w("")

    misses = report["misses"]
    w("=== ДИАГНОЗ ПРОМАХОВ ===")
    w(
        f"пары, где на ветке {report['load_bearing_branch']} формулировка пользователя не "
        f"достала золотой документ в k={PRIMARY_K}: {len(misses)}"
    )
    if not misses:
        w("их нет — на этом наборе выбить документ из набора кандидатов формулировкой не удалось")
    for miss in misses:
        mis, mat = miss["mismatch"], miss["matched"]
        w("")
        w(f"  [{miss['pair_id']}] {miss['mechanism']} — {miss['verdict']}")
        w(f"    mismatch: {mis['question']}")
        w(f"    matched : {mat['question']}")
        w(f"    золотой : {', '.join(miss['gold_paths'])}")
        deep = mis["deep_rank"]
        deep_text = (
            "не разделил с вопросом ни одного терма"
            if deep is None
            else f"{deep}-й в полном порядке ветки, без среза и пост-фильтров"
        )
        where = (
            f"отсутствует ({deep_text})"
            if mis["rank"] is None
            else f"{mis['rank']} — ниже отсечки k={PRIMARY_K}"
        )
        w(f"    ранг золотого: mismatch — {where}; matched — {mat['rank']}")
        if mis["near_twin_rank"] is not None:
            w(f"    почти-двойник золотого стоит на месте {mis['near_twin_rank']} — это не словарь")
        if mis["top_paths"]:
            w("    топ-5 у mismatch:")
            for position, path in enumerate(mis["top_paths"], start=1):
                w(f"      {position}. {path}")
        else:
            w("    топ-5 у mismatch: выдача ПУСТА — ни один документ не разделил с вопросом терма")
        w(
            f"    стеммы вопроса ∩ документ: mismatch {mis['stems_shared']}/{mis['stems']}, "
            f"matched {mat['stems_shared']}/{mat['stems']}"
        )
        if mis["stems_missing"]:
            w("    нет в документе (слова пользователя без якоря): " + ", ".join(mis["stems_missing"]))
        if mat["stems_gained"]:
            w("    добавляет формулировка корпуса: " + ", ".join(mat["stems_gained"]))
    w("")

    v = report["verdict"]
    w("=== ВЕРДИКТ ПО ПРЕДЗАЯВЛЕННЫМ КРИТЕРИЯМ ===")
    w(f"ветка {v['branch']}, k={v['primary_k']}: {v['outcome']}")
    for line in v["reasons"]:
        w(f"  • {line}")
    w("")
    w(
        "ЧТО ЭТОТ ОТЧЁТ НЕ ГОВОРИТ: числа веток dense и hybrid получены на подменном "
        "эмбеддере; способность продового EmbeddingsGigaR перекрывать словарный разрыв "
        "здесь НЕ измерена и по этим числам не предсказывается."
    )
    timing = report.get("timing")
    if timing:
        w(
            f"время: разреженные {timing['sparse_s']:.1f}s, плотные {timing['dense_s']:.1f}s, "
            f"поиск {timing['search_s']:.1f}s"
        )
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Парный замер словарного разрыва: сбивает ли формулировка «словами "
            "пользователя» нужный документ из набора кандидатов. " + CAVEAT
        )
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--chunks", type=Path, default=None, help="JSONL от `audit_chunk.ts --chunks`"
    )
    source.add_argument(
        "--dump",
        type=Path,
        default=None,
        help="zip от confluence_dump.py — стыки 1–2 прогоняются сами, в --work-dir",
    )
    parser.add_argument(
        "--set",
        dest="pairs_path",
        type=Path,
        default=REPO_ROOT / "tools" / "eval" / "golden.vocab.jsonl",
        help="парный набор (по умолчанию tools/eval/golden.vocab.jsonl)",
    )
    parser.add_argument("--out", required=True, type=Path, help="куда писать vocab-report.json")
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=REPO_ROOT / ".rag-audit" / "vocab",
        help="рабочий каталог для --dump (вольт, чанки, логи стыков)",
    )
    parser.add_argument(
        "--cache",
        type=Path,
        default=Path("/tmp/audit/embeddings.npz"),
        help="кэш эмбеддингов (общий со стыками 3–4)",
    )
    parser.add_argument("--model", default=ar.DEFAULT_MODEL, help="имя модели HuggingFace")
    parser.add_argument("--device", default=None, help="mps/cpu/cuda (по умолчанию — авто)")
    parser.add_argument(
        "--limit",
        type=int,
        default=ar.DEFAULT_LIMIT,
        help=f"внешний лимит поиска (прод: {ar.DEFAULT_LIMIT}); не меньше max(k)",
    )
    parser.add_argument("--quiet", action="store_true", help="не печатать ход стыков в stderr")
    return parser


def prepare_chunks(args: argparse.Namespace) -> Path:
    """Путь к выгрузке чанков: либо готовый `--chunks`, либо стыки 1–2 из `--dump`.

    Стыки зовутся ТЕМ ЖЕ способом, что в сводном прогоне (`audit_all.run_stage`), а не
    копией команд: расхождение в ключах давало бы другой корпус и незаметно другой замер.
    """
    if args.chunks is not None:
        if not args.chunks.exists():
            raise SystemExit(f"выгрузки чанков нет: {args.chunks}")
        return args.chunks
    if not args.dump.exists():
        raise SystemExit(f"дампа нет: {args.dump}")

    import audit_all  # локальный импорт: без --dump он не нужен

    work = args.work_dir
    work.mkdir(parents=True, exist_ok=True)
    logs = work / "logs"
    chunks = work / "chunks.jsonl"
    audit_all.run_stage(
        "convert",
        [
            sys.executable,
            str(TOOLS_DIR / "audit_convert.py"),
            "--dump",
            str(args.dump),
            "--out-dir",
            str(work),
        ],
        logs,
        args.quiet,
    )
    audit_all.run_stage(
        "chunk",
        [
            "npx",
            "tsx",
            str(TOOLS_DIR / "audit_chunk.ts"),
            "--vault",
            str(work / "vault"),
            "--out",
            str(work / "chunk-report.json"),
            "--chunks",
            str(chunks),
        ],
        logs,
        args.quiet,
    )
    return chunks


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.limit < max(KS):
        raise SystemExit(
            f"--limit {args.limit} меньше максимальной отсечки {max(KS)}: recall@{max(KS)} "
            "тогда мерить не на чем"
        )

    pairs = load_pairs(args.pairs_path)
    chunks_path = prepare_chunks(args)
    chunks = ar.load_chunks(chunks_path)

    # Пара, чей золотой документ отсутствует в корпусе, никогда не найдётся ни одной
    # аркой и молча утяжеляла бы клетку «ни один». Такие исключаются и перечисляются —
    # та же дисциплина, что у меток раздела в стыке 3.
    known = {chunk.path for chunk in chunks}
    missing = sorted({p for pair in pairs for p in pair.gold_paths if p not in known})
    usable = [pair for pair in pairs if any(p in known for p in pair.gold_paths)]
    if not usable:
        raise SystemExit(
            f"ни один золотой путь набора не найден в корпусе ({chunks_path}). "
            "Похоже, набор размечен по другой выгрузке."
        )

    outcomes, timing = run_arms(usable, chunks, args)
    report: dict[str, Any] = {
        "tool": "cognivault-rag-audit/audit_vocab",
        "format_version": 1,
        "caveat": CAVEAT,
        "preregistered": list(PREREGISTERED),
        "not_measured": [
            "поведение продового эмбеддера (dense/hybrid считает multilingual-e5-base)",
            "качество ответа модели (генерации здесь нет)",
            "грейдер/реранкер UI (офлайн недоступен)",
        ],
        "sources": {
            "set": str(args.pairs_path),
            "chunks": str(chunks_path),
            "variant": "prod (audit_retrieval.VARIANTS['prod'])",
            "limit": args.limit,
        },
        **analyse(outcomes),
    }
    report["corpus"] = {
        "label": str(chunks_path),
        "chunks": len(chunks),
        "files": len(known),
        "gold_paths_missing": missing,
        "pairs_dropped": [p.pair_id for p in pairs if p not in usable],
        # Корпус, помещающийся в отсечку целиком, делает recall@k тождественно
        # единицей у любой ветки, которая вообще что-то вернула. Такое табло
        # выглядит убедительно и не значит ничего — поэтому говорится вслух.
        "smaller_than_cutoff": len(chunks) <= 2 * max(KS),
    }
    report["model"] = {
        "name": args.model,
        "is_production_embedder": False,
        "production_embedder": "GigaChat EmbeddingsGigaR",
        "sparse_is_production": True,
    }
    report["timing"] = timing

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    sys.stdout.write(render(report))
    sys.stdout.write(f"\nотчёт: {args.out}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
