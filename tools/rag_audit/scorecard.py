"""Линейка сводного прогона: заголовочные метрики, пороги, шум, сравнимость.

Модуль НИЧЕГО не запускает и ничего не читает с диска — он получает уже
разобранные отчёты четырёх стыков и отдаёт структуру, из которой печатается
табло и выводится код выхода. Ровно поэтому его можно проверить на синтетике,
где ответ посчитан руками: «стало лучше» не должно быть неотличимо от
«сломалась сама линейка».

Три решения, на которых держится всё остальное.

1. **Заголовочных метрик шестнадцать, а не сорок.** Из каждого стыка берётся то,
   что описывает СВОЙ способ потерять ответ, и ничего сверх: остальное лежит в
   отчётах стыков и читается, когда табло уже показало, куда смотреть.
2. **Метрики делятся на ДЕТЕРМИНИРОВАННЫЕ и ВЫБОРОЧНЫЕ.** Стыки 1–2 считаются по
   фиксированному дампу: тот же дамп + тот же код = тот же результат побайтово,
   поэтому у них нет шума и ЛЮБАЯ дельта реальна. Стыки 3–4 считаются на золотом
   наборе, и там один вопрос стоит 1/n СВОЕГО origin: на 28 приёмочных вопросах
   это ±0.036, на 160 сгенерированных — ±0.006, на 6 авторских — ±0.167. Мерить
   их одной линейкой значит либо утопить приёмочную регрессию в «шуме», либо
   объявить изменением дрожание одного вопроса. Грубость авторского среза не
   повод его не мерить: неизмеряемый класс вопросов ломается молча, а измеряемый
   с честным квантом ломается заметно — просто порог у него грубый.
3. **Дельта без сравнимости не считается вовсе.** Сменился дамп или золотой
   набор — сравнение не «приблизительное», а недействительное: метрика двигалась
   бы вместе с разметкой. Такие случаи ОТКАЗЫВАЮТСЯ сравниваться и говорят это
   словами.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

#: Насколько сравниваются доли. Все значения округляются до 4 знаков ещё при
#: извлечении, так что epsilon нужен только против представления float.
EPS = 1e-9

#: Порядок и имена стыков в табло.
STAGES: dict[int, str] = {
    1: "конвертация storage → markdown",
    2: "markdown → чанки",
    3: "чанки → выдача (hybrid, попадание по файлу)",
    4: "выдача → окно раздела (cap 4000, центрирование)",
}

#: Какие стыки честно переносятся в прод, а какие меряют подменную модель.
STAGE_TRANSFER: dict[int, str] = {
    1: "прод-код (cognivault-ui/app/confluence/convert.py) — числа переносятся",
    2: "прод-код (src/lib/chunker.ts + bm25.ts) — числа переносятся",
    3: "плотная сторона — multilingual-e5-base, НЕ GigaChat: абсолют индикативен, переносятся СРАВНЕНИЯ",
    4: "нарезка окна — прод-код; выбор якоря — e5: абсолют индикативен, переносятся СРАВНЕНИЯ",
}

DETERMINISTIC = "deterministic"
SAMPLED = "sampled"

UP = "up"
DOWN = "down"


@dataclass(frozen=True)
class Metric:
    """Одна заголовочная метрика табло."""

    key: str
    stage: int
    label: str
    #: UP — больше лучше, DOWN — меньше лучше.
    direction: str
    #: DETERMINISTIC — шума нет, любая дельта реальна; SAMPLED — квант 1/n.
    kind: str
    #: Зачем она в табло, а не в отчёте стыка.
    rationale: str
    #: Разрез золотого набора, если метрика выборочная.
    origin: str | None = None


@dataclass(frozen=True)
class Tripwire:
    """Счётчик с нулевым допуском: не число для чтения, а сигнализация."""

    key: str
    stage: int
    label: str


@dataclass(frozen=True)
class Measurement:
    """Значение метрики и размер выборки, на которой оно посчитано."""

    value: float
    #: Знаменатель: сколько вопросов реально судилось. None — метрика корпусная.
    n: int | None = None


#: ------------------------------------------------------------------------- #
#: Заголовочные метрики. Выбор каждой обоснован в `rationale` — табло печатает
#: обоснования по `--explain`, чтобы «почему именно эти тринадцать» не жило
#: только в голове автора.
#: ------------------------------------------------------------------------- #
METRICS: tuple[Metric, ...] = (
    Metric(
        "convert.word_recall",
        1,
        "слов исходника дошло до markdown",
        UP,
        DETERMINISTIC,
        "слова, не доехавшего до markdown, не найдёт ни один ретривал — это "
        "единственная потеря на стыке, которую нельзя компенсировать ниже",
    ),
    Metric(
        "convert.cell_placement",
        1,
        "ячейки составных таблиц на своих местах",
        UP,
        DETERMINISTIC,
        "555 colspan и 617 rowspan: текст может дойти весь (recall 1.0) и "
        "приехать в чужую строку — это ответ, который выглядит правильным",
    ),
    Metric(
        "convert.code_exact",
        1,
        "код-макросов побайтово равны своему забору",
        UP,
        DETERMINISTIC,
        "третий способ потерять ответ при целом recall: код доехал, но искажён; "
        "и это единственное число стыка 1 ниже 0.99 — ему есть куда падать",
    ),
    Metric(
        "chunk.torn_code_share",
        2,
        "заборов кода разъехалось по чанкам",
        DOWN,
        DETERMINISTIC,
        "SQL, разрезанный пополам, индексируется молча и всплывает как "
        "«ассистент ответил мимо»; доля, а не счёт — счёт двигался бы с корпусом",
    ),
    Metric(
        "chunk.torn_row_share",
        2,
        "строк линеаризованных таблиц разорвано",
        DOWN,
        DETERMINISTIC,
        "корпус табличный (740 линеаризованных строк): разорванная строка теряет "
        "привязку значения к своему полю — худший вид тихой порчи здесь",
    ),
    Metric(
        "chunk.duplicate_share",
        2,
        "чанков в кластерах почти-дубликатов",
        DOWN,
        DETERMINISTIC,
        "дубликаты между файлами конкурируют в лексической ветке и вытесняют из "
        "топа то, чего в топе больше нет ни в одном экземпляре",
    ),
    Metric(
        "retrieval.hit1.customer",
        3,
        "hit@1, приёмочный набор",
        UP,
        SAMPLED,
        "число, которое смотрит заказчик; n=28, поэтому у него свой квант шума",
        origin="customer",
    ),
    Metric(
        "retrieval.hit1.generated",
        3,
        "hit@1, сгенерированный набор",
        UP,
        SAMPLED,
        "тот же вопрос на n=160: в шесть раз мельче квант, поэтому именно здесь "
        "видно изменение, которое на приёмочном наборе неотличимо от шума",
        origin="generated",
    ),
    Metric(
        "retrieval.mrr.customer",
        3,
        "MRR, приёмочный набор",
        UP,
        SAMPLED,
        "hit@1 — ступенька: правка, поднявшая ответ с 7-го места на 2-е, для неё "
        "не существует. MRR ловит порядок, который hit@1 округляет в ноль",
        origin="customer",
    ),
    Metric(
        "retrieval.mrr.generated",
        3,
        "MRR, сгенерированный набор",
        UP,
        SAMPLED,
        "то же на плотном наборе — самая чувствительная из четырёх метрик стыка",
        origin="generated",
    ),
    Metric(
        "retrieval.hit1.authored",
        3,
        "hit@1, авторский набор (охват корпуса)",
        UP,
        SAMPLED,
        "класс вопросов «что вообще есть в базе», которого в приёмочном и "
        "сгенерированном наборах не было ни одного: без своей строки он снова "
        "стал бы ломаться незаметно. n=6 — из 21 авторской строки офлайн судятся "
        "только отвечаемые (7 ловушек и 8 метавопросов не судятся ни здесь, ни в "
        "стыке 4), поэтому квант 1/6 = 0.1667: прибор ловит поломку класса, а не "
        "его тонкую настройку, и порог поставлен ровно под эту грубость",
        origin="authored",
    ),
    Metric(
        "retrieval.mrr.authored",
        3,
        "MRR, авторский набор (охват корпуса)",
        UP,
        SAMPLED,
        "на n=6 hit@1 — ступенька в одну шестую, и почти любая правка для неё "
        "либо невидима, либо катастрофа. MRR на том же наборе двигается плавнее и "
        "остаётся единственным, что здесь вообще различимо",
        origin="authored",
    ),
    Metric(
        "window.contained.customer",
        4,
        "ответ доехал до модели, приёмочный набор",
        UP,
        SAMPLED,
        "попадание чанка в топ ещё не ответ: раздел режется до 4000 символов "
        "окном вокруг чанка, и ответ уезжает вместе с обрезком",
        origin="customer",
    ),
    Metric(
        "window.contained.generated",
        4,
        "ответ доехал до модели, сгенерированный набор",
        UP,
        SAMPLED,
        "то же на n=156 судимых вопросах",
        origin="generated",
    ),
    Metric(
        "window.contained.authored",
        4,
        "ответ доехал до модели, авторский набор",
        UP,
        SAMPLED,
        "судимых пять из шести отвечаемых авторских строк (у одной достижимых "
        "термов меньше трёх), квант 1/5 = 0.2. Порог здесь охраняет не долю, а "
        "факт: авторские ответы короткие, и падение хотя бы одного ниже порога "
        "означало бы, что окно режет ровно то перечисление, ради которого класс и "
        "заведён",
        origin="authored",
    ),
    Metric(
        "window.contained.oversized",
        4,
        "ответ доехал, только переразмерные разделы",
        UP,
        SAMPLED,
        "единственный срез, который обрезка вообще может двигать: на разделах "
        "короче 4000 окно ничего не режет и разбавляет число до неподвижности",
        origin="oversized",
    ),
)

#: Счётчики с нулевым допуском. Их не читают как числа — их читают как «чисто»
#: или «сработало»: каждый означает конкретную поломку, а не степень качества.
TRIPWIRES: tuple[Tripwire, ...] = (
    Tripwire("convert.converter_errors", 1, "падений конвертера"),
    Tripwire("convert.links_broken", 1, "неразрешимых ссылок на вложения"),
    Tripwire("convert.tables_with_cell_mismatch", 1, "таблиц с расхождением ячеек"),
    Tripwire("convert.gfm_ragged_out", 1, "рваных GFM-таблиц"),
    Tripwire("convert.images_dropped_no_filename", 1, "картинок выброшено без имени"),
    Tripwire("convert.pages_below_50pct", 1, "страниц с recall ниже 50%"),
    Tripwire("chunk.over_budget", 2, "чанков сверх своего бюджета токенов"),
    Tripwire("chunk.tables_split", 2, "таблиц разорвано"),
    Tripwire("chunk.table_rows_lost", 2, "строк таблиц потеряно"),
    Tripwire("chunk.headerless_table_chunks", 2, "чанков таблицы без шапки"),
    Tripwire("chunk.code_blocks_lost", 2, "блоков кода потеряно"),
    Tripwire("chunk.unbalanced_fence_chunks", 2, "чанков с незакрытым забором"),
    Tripwire("chunk.parent_id_collisions", 2, "коллизий parent_id внутри файла"),
    Tripwire("retrieval.unretrieved.customer", 3, "приёмочных вопросов вне кандидатов"),
    Tripwire("retrieval.unretrieved.generated", 3, "сгенерированных вопросов вне кандидатов"),
    Tripwire("retrieval.unretrieved.authored", 3, "авторских вопросов вне кандидатов"),
    Tripwire("window.anchor_failures", 4, "якорей не найдено (окно падает в префикс)"),
)

#: Разрезы золотого набора, у которых есть своя строка в табло и свой квант шума.
#: Список ОДИН на извлечение и на сигнализацию: разрез, попавший в метрику, но не
#: в тревогу, означал бы класс вопросов, чьё качество измеряется, а полное выпадение
#: из кандидатов — нет.
ORIGINS: tuple[str, ...] = ("customer", "generated", "authored")

METRICS_BY_KEY: dict[str, Metric] = {m.key: m for m in METRICS}
TRIPWIRES_BY_KEY: dict[str, Tripwire] = {t.key: t for t in TRIPWIRES}


# --------------------------------------------------------------------------- #
# Извлечение
# --------------------------------------------------------------------------- #


def _dig(report: Mapping[str, Any], *path: str) -> Any:
    """Достаёт значение по пути и падает ГРОМКО, если ключа нет.

    Тихий `None` здесь означал бы метрику, которая молча исчезла из табло после
    правки стыка, — ровно тот класс ошибок, ради которого линейка и написана.
    """
    node: Any = report
    for key in path:
        if not isinstance(node, Mapping) or key not in node:
            raise KeyError(f"в отчёте нет пути {'.'.join(path)} (оборвался на {key!r})")
        node = node[key]
    return node


def _share(numerator: float, denominator: float) -> float:
    return 0.0 if denominator == 0 else round(numerator / denominator, 4)


def _origin_stats(branch: Mapping[str, Any], origin: str) -> Mapping[str, Any]:
    by_origin = branch.get("file_by_origin") or {}
    stats = by_origin.get(origin)
    if stats is None:
        raise KeyError(
            f"в отчёте стыка 3 нет разреза file_by_origin[{origin!r}] — "
            "прогон обязан получать оба золотых набора двумя --golden"
        )
    return stats


def headline(reports: Mapping[str, Mapping[str, Any]]) -> dict[str, Measurement]:
    """Тринадцать чисел табло из четырёх отчётов стыков."""
    convert = reports["convert"]
    chunk = reports["chunk"]
    retrieval = reports["retrieval"]
    window = reports["window"]

    hybrid = _dig(retrieval, "branches", "hybrid")
    win_prod = _dig(window, "prod")
    structure = _dig(chunk, "corpus", "structure")

    out: dict[str, Measurement] = {
        "convert.word_recall": Measurement(
            round(float(_dig(convert, "corpus", "retention", "corpus_recall")), 4)
        ),
        "convert.cell_placement": Measurement(
            round(float(_dig(convert, "corpus", "tables", "cell_placement_accuracy")), 4)
        ),
        "convert.code_exact": Measurement(
            round(float(_dig(convert, "corpus", "code", "exact_rate")), 4)
        ),
        "chunk.torn_code_share": Measurement(
            _share(structure["code_blocks_split"], structure["code_blocks"])
        ),
        "chunk.torn_row_share": Measurement(
            _share(structure["linearized_rows_split"], structure["linearized_rows"])
        ),
        "chunk.duplicate_share": Measurement(
            round(float(_dig(chunk, "duplicates", "share_of_corpus")), 4)
        ),
    }

    for origin in ORIGINS:
        stats = _origin_stats(hybrid, origin)
        n = int(stats["n"])
        out[f"retrieval.hit1.{origin}"] = Measurement(round(float(stats["hit_at"]["1"]), 4), n)
        out[f"retrieval.mrr.{origin}"] = Measurement(round(float(stats["mrr"]), 4), n)

    for origin in ORIGINS:
        stats = _dig(win_prod, "by_origin", origin)
        out[f"window.contained.{origin}"] = Measurement(
            round(float(stats["contained"]), 4), int(stats["judged"])
        )
    oversized = _dig(win_prod, "oversized_only")
    out["window.contained.oversized"] = Measurement(
        round(float(oversized["contained"]), 4), int(oversized["judged"])
    )
    return out


def tripwires(reports: Mapping[str, Mapping[str, Any]]) -> dict[str, int]:
    """Счётчики с нулевым допуском."""
    convert = reports["convert"]
    chunk = reports["chunk"]
    retrieval = reports["retrieval"]
    window = reports["window"]

    tables = _dig(convert, "corpus", "tables")
    images = _dig(convert, "corpus", "images")
    structure = _dig(chunk, "corpus", "structure")
    hybrid = _dig(retrieval, "branches", "hybrid")

    out = {
        "convert.converter_errors": int(tables["converter_errors"]),
        "convert.links_broken": int(images["links_broken"]),
        "convert.tables_with_cell_mismatch": int(tables["tables_with_cell_mismatch"]),
        "convert.gfm_ragged_out": int(tables["gfm_ragged_out"]),
        "convert.images_dropped_no_filename": int(images["images_dropped_no_filename"]),
        "convert.pages_below_50pct": int(_dig(convert, "corpus", "retention", "pages_below_50pct")),
        "chunk.over_budget": int(_dig(chunk, "corpus", "overBudget", "chunks")),
        "chunk.tables_split": int(structure["tables_split"]),
        "chunk.table_rows_lost": int(structure["table_rows_lost"]),
        "chunk.headerless_table_chunks": int(structure["headerless_table_chunks"]),
        "chunk.code_blocks_lost": int(structure["code_blocks_lost"]),
        "chunk.unbalanced_fence_chunks": int(structure["unbalanced_fence_chunks"]),
        "chunk.parent_id_collisions": int(_dig(chunk, "corpus", "parentIdCollisions")),
        "window.anchor_failures": int(_dig(window, "anchor_failures", "total")),
    }
    # «Вопрос вообще не попал в кандидатов» — потеря, которую реранкер не чинит:
    # в проде чат просит 40 кандидатов, и чего нет среди них, нет и у грейдера.
    for origin in ORIGINS:
        stats = _origin_stats(hybrid, origin)
        out[f"retrieval.unretrieved.{origin}"] = int(stats["n"]) - int(stats["found"])
    return out


def context(reports: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """Числа, которые НЕ калибруются порогом, но без которых табло врёт.

    Цена контекста стоит рядом с `window.contained.*` намеренно: мера содержания
    монотонна по размеру окна, и доля без цены — прокси, награждающий многословие.
    """
    convert = reports["convert"]
    chunk = reports["chunk"]
    window = reports["window"]
    prod_all = _dig(window, "prod", "all")
    return {
        "pages": int(_dig(convert, "corpus", "pages")),
        "chunks": int(_dig(chunk, "corpus", "chunks")),
        "sections": int(_dig(chunk, "corpus", "sections")),
        "sections_over_cap": int(_dig(chunk, "corpus", "sectionsOverCap")),
        "chunks_in_oversized_sections": int(_dig(chunk, "corpus", "chunksInOversizedSections")),
        "window_chars_mean": round(float(prod_all["chars_mean"]), 1),
        "window_chars_5_blocks": int(prod_all["chars_5_blocks"]),
        "window_ceiling": round(float(_dig(window, "ceiling", "attainable_share_mean")), 4),
    }


# --------------------------------------------------------------------------- #
# Сравнимость: когда сравнивать НЕЛЬЗЯ
# --------------------------------------------------------------------------- #

#: Что именно ломает сравнение какого стыка. Дамп ломает все четыре: по другому
#: корпусу считаются и потери конвертера, и чанки, и выдача. Золотой набор и
#: модель ломают только стыки 3–4 — стыки 1–2 их не видят.
_BLOCKS: tuple[tuple[str, tuple[int, ...]], ...] = (
    ("dump", (1, 2, 3, 4)),
    ("golden", (3, 4)),
    ("model", (3, 4)),
    ("retrieval_config", (3,)),
    ("window_config", (4,)),
)


def _golden_key(provenance: Mapping[str, Any]) -> list[tuple[str, str]]:
    return [(str(g["path"]), str(g["sha256"])) for g in provenance.get("golden", [])]


def comparability(now: Mapping[str, Any], base: Mapping[str, Any]) -> dict[str, Any]:
    """Можно ли вообще считать дельту — по стыкам, с причиной отказа словами.

    Отказ громкий и адресный: «корпус другой» гасит все четыре стыка, «золотой
    набор другой» — только те два, что его читают. Иначе починка разметки один
    раз уже прочиталась бы как изменение качества.
    """
    reasons: dict[str, str] = {}

    if str(now.get("dump", {}).get("sha256")) != str(base.get("dump", {}).get("sha256")):
        reasons["dump"] = (
            f"дамп корпуса другой: {str(base.get('dump', {}).get('sha256'))[:12]} → "
            f"{str(now.get('dump', {}).get('sha256'))[:12]}"
        )
    if _golden_key(now) != _golden_key(base):
        reasons["golden"] = (
            "золотой набор другой (состав файлов или их содержимое) — метрика "
            "двигалась бы вместе с разметкой, а не с качеством"
        )
    if str(now.get("model")) != str(base.get("model")):
        reasons["model"] = f"другая модель: {base.get('model')} → {now.get('model')}"
    for field_name in ("retrieval_config", "window_config"):
        diff = _config_diff(now.get(field_name) or {}, base.get(field_name) or {})
        if diff:
            reasons[field_name] = f"другая конфигурация: {', '.join(diff)}"

    blocked: dict[int, list[str]] = {stage: [] for stage in STAGES}
    for name, stages in _BLOCKS:
        if name in reasons:
            for stage in stages:
                blocked[stage].append(reasons[name])

    # Смена самого инструмента — не отказ, а ГРОМКОЕ предупреждение: сдвинулась
    # линейка, и «улучшение» может оказаться другим способом мерить.
    warnings: list[str] = []
    now_rulers = now.get("rulers") or {}
    base_rulers = base.get("rulers") or {}
    changed = sorted(
        name
        for name in set(now_rulers) | set(base_rulers)
        if now_rulers.get(name) != base_rulers.get(name)
    )
    if changed:
        warnings.append(
            "ЛИНЕЙКА СДВИНУЛАСЬ: с базового прогона изменились " + ", ".join(changed) +
            " — часть дельты может быть изменением ЗАМЕРА, а не качества"
        )
    if now.get("dirty"):
        files = ", ".join(now.get("dirty_files") or []) or "см. git status"
        warnings.append(f"рабочее дерево грязное — прогон не привязан к коммиту: {files}")

    return {
        "reasons": reasons,
        "blocked": {stage: notes for stage, notes in blocked.items() if notes},
        "warnings": warnings,
        "comparable": {stage: not blocked[stage] for stage in STAGES},
    }


def _config_diff(now: Mapping[str, Any], base: Mapping[str, Any]) -> list[str]:
    return [
        f"{key}: {base.get(key)!r} → {now.get(key)!r}"
        for key in sorted(set(now) | set(base))
        if now.get(key) != base.get(key)
    ]


# --------------------------------------------------------------------------- #
# Шум и вердикты
# --------------------------------------------------------------------------- #

SAME = "same"
NOISE = "noise"
BETTER = "better"
WORSE = "worse"


def quantum(metric: Metric, measurement: Measurement) -> float:
    """Цена одного вопроса в единицах метрики — разрешающая способность прибора.

    У детерминированной метрики её нет: тот же дамп и тот же код дают тот же
    результат, поэтому любое отличие реально. У выборочной это 1/n СВОЕГО
    origin, а не общего набора: 1/28 = 0.036 против 1/160 = 0.006.
    """
    if metric.kind == DETERMINISTIC:
        return 0.0
    if not measurement.n:
        return 0.0
    return round(1.0 / measurement.n, 4)


def classify(metric: Metric, now: Measurement, base: Measurement) -> dict[str, Any]:
    """Дельта и вердикт о ней: то же / шум / лучше / хуже."""
    delta = round(now.value - base.value, 4)
    quant = quantum(metric, now)
    if abs(delta) <= EPS:
        verdict = SAME
    elif abs(delta) <= quant + EPS:
        verdict = NOISE
    else:
        improved = delta > 0 if metric.direction == UP else delta < 0
        verdict = BETTER if improved else WORSE
    return {
        "delta": delta,
        "quantum": quant,
        "verdict": verdict,
        "baseline": base.value,
        "value": now.value,
    }


def threshold_verdict(metric: Metric, measurement: Measurement, threshold: float) -> dict[str, Any]:
    """Держит ли метрика свой пол."""
    if metric.direction == UP:
        ok = measurement.value >= threshold - EPS
    else:
        ok = measurement.value <= threshold + EPS
    return {"ok": ok, "threshold": threshold, "value": measurement.value}


def rank_changes(
    now: Sequence[Mapping[str, Any]], base: Sequence[Mapping[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Сколько вопросов реально сменили ранг и в какую сторону, по origin.

    Аггрегат этого не показывает: hit@1, сдвинувшийся на 0.036, — это и «один
    вопрос дрогнул», и «пять поднялись, четыре упали». Второе — не шум, а
    неустойчивость, и лечится оно иначе. Ранг `None` = документ не найден вовсе
    и считается хуже любого числа.
    """
    base_by_id = {str(r["id"]): r for r in base}
    out: dict[str, dict[str, Any]] = {}
    for record in now:
        old = base_by_id.get(str(record["id"]))
        if old is None:
            continue
        new_rank = record.get("rank")
        old_rank = old.get("rank")
        if new_rank == old_rank:
            continue
        origin = str(record.get("origin") or "customer")
        bucket = out.setdefault(
            origin, {"changed": 0, "improved": 0, "regressed": 0, "examples": []}
        )
        better = old_rank is None or (new_rank is not None and new_rank < old_rank)
        bucket["changed"] += 1
        bucket["improved" if better else "regressed"] += 1
        bucket["examples"].append({"id": str(record["id"]), "was": old_rank, "now": new_rank})
    return out


def containment_changes(
    now: Sequence[Mapping[str, Any]], base: Sequence[Mapping[str, Any]]
) -> dict[str, dict[str, Any]]:
    """То же для стыка 4: сколько вопросов ПЕРЕСЕКЛИ порог «ответ доехал».

    Считается пересечение порога, а не дрожание доли: `contained` — это доля
    вопросов по обе стороны порога, и её движение обязано объясняться конкретными
    вопросами, сменившими сторону.
    """
    base_by_id = {str(r["id"]): r for r in base}
    out: dict[str, dict[str, Any]] = {}
    for record in now:
        old = base_by_id.get(str(record["id"]))
        if old is None:
            continue
        if not record.get("judgeable", True) or not old.get("judgeable", True):
            continue
        if bool(record.get("contained")) == bool(old.get("contained")):
            continue
        origin = str(record.get("origin") or "customer")
        bucket = out.setdefault(
            origin, {"changed": 0, "improved": 0, "regressed": 0, "examples": []}
        )
        better = bool(record.get("contained"))
        bucket["changed"] += 1
        bucket["improved" if better else "regressed"] += 1
        bucket["examples"].append(
            {
                "id": str(record["id"]),
                "was": round(float(old.get("containment") or 0.0), 3),
                "now": round(float(record.get("containment") or 0.0), 3),
            }
        )
    return out


# --------------------------------------------------------------------------- #
# Сборка табло
# --------------------------------------------------------------------------- #

#: Пороги провалены — то, ради чего команда возвращает ненулевой код.
EXIT_OK = 0
EXIT_GATE = 1
EXIT_INCOMPARABLE = 2


@dataclass
class Scorecard:
    provenance: dict[str, Any]
    measurements: dict[str, Measurement]
    tripwire_values: dict[str, int]
    context_values: dict[str, Any]
    thresholds: dict[str, float]
    comparison: dict[str, Any] = field(default_factory=dict)
    baseline_meta: dict[str, Any] | None = None
    changes: dict[str, Any] = field(default_factory=dict)
    failures: list[str] = field(default_factory=list)
    refusals: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    timing: dict[str, float] = field(default_factory=dict)

    @property
    def exit_code(self) -> int:
        """1 — качество провалено, 2 — сравнить нельзя, 0 — всё держится.

        Порядок намеренный: провал порога важнее отказа сравнивать. Отказ значит
        «не знаю», провал значит «стало хуже», и второе нельзя маскировать первым.
        """
        if self.failures:
            return EXIT_GATE
        if self.refusals:
            return EXIT_INCOMPARABLE
        return EXIT_OK


def build(
    provenance: Mapping[str, Any],
    reports: Mapping[str, Mapping[str, Any]],
    thresholds: Mapping[str, Any],
    baseline: Mapping[str, Any] | None = None,
    per_query: Mapping[str, Sequence[Mapping[str, Any]]] | None = None,
    timing: Mapping[str, float] | None = None,
) -> Scorecard:
    """Табло целиком: значения, вердикты порогов, дельта к базе, код выхода."""
    measurements = headline(reports)
    tripwire_values = tripwires(reports)
    metric_thresholds = {
        key: float(entry["threshold"])
        for key, entry in (thresholds.get("metrics") or {}).items()
    }

    card = Scorecard(
        provenance=dict(provenance),
        measurements=measurements,
        tripwire_values=tripwire_values,
        context_values=dict(context(reports)),
        thresholds=metric_thresholds,
        timing=dict(timing or {}),
    )

    for metric in METRICS:
        threshold = metric_thresholds.get(metric.key)
        if threshold is None:
            card.warnings.append(f"для {metric.key} не задан порог — метрика не калибрует гейт")
            continue
        verdict = threshold_verdict(metric, measurements[metric.key], threshold)
        if not verdict["ok"]:
            sign = "≥" if metric.direction == UP else "≤"
            card.failures.append(
                f"{metric.key}: {measurements[metric.key].value} нарушает порог "
                f"{sign} {threshold} ({STAGES[metric.stage]})"
            )

    for tripwire in TRIPWIRES:
        value = tripwire_values.get(tripwire.key, 0)
        if value:
            card.failures.append(
                f"{tripwire.key}: {value} — нулевой допуск ({tripwire.label})"
            )

    if baseline is None:
        card.warnings.append(
            "базового прогона нет — сравнивать не с чем; "
            "первый прогон записывается через --update-baseline"
        )
        return card

    card.baseline_meta = {
        "created_utc": baseline.get("created_utc"),
        "commit": baseline.get("provenance", {}).get("commit"),
        "label": baseline.get("label"),
    }
    cmp_result = comparability(provenance, baseline.get("provenance") or {})
    card.comparison = cmp_result
    card.warnings.extend(cmp_result["warnings"])
    for stage, notes in sorted(cmp_result["blocked"].items()):
        for note in notes:
            card.refusals.append(f"стык {stage} ({STAGES[stage]}): {note}")

    base_measurements = {
        key: Measurement(float(entry["value"]), entry.get("n"))
        for key, entry in (baseline.get("headline") or {}).items()
    }
    deltas: dict[str, Any] = {}
    for metric in METRICS:
        if not cmp_result["comparable"][metric.stage]:
            deltas[metric.key] = {"verdict": "incomparable"}
            continue
        base = base_measurements.get(metric.key)
        if base is None:
            deltas[metric.key] = {"verdict": "new"}
            continue
        entry = classify(metric, measurements[metric.key], base)
        deltas[metric.key] = entry
        if entry["verdict"] == WORSE:
            card.failures.append(
                f"{metric.key}: регрессия {entry['delta']:+.4f} сверх шума "
                f"±{entry['quantum']:.4f} ({STAGES[metric.stage]})"
            )
    card.changes["metrics"] = deltas

    pq = per_query or {}
    base_pq = baseline.get("per_query") or {}
    if cmp_result["comparable"][3]:
        card.changes["retrieval_ranks"] = rank_changes(
            pq.get("retrieval") or [], base_pq.get("retrieval") or []
        )
    if cmp_result["comparable"][4]:
        card.changes["window_containment"] = containment_changes(
            pq.get("window") or [], base_pq.get("window") or []
        )
    return card


# --------------------------------------------------------------------------- #
# Печать
# --------------------------------------------------------------------------- #

_DELTA_WORD = {
    SAME: "=",
    NOISE: "шум",
    BETTER: "лучше",
    WORSE: "ХУЖЕ",
    "incomparable": "н/д",
    "new": "новая",
}


def _fmt_delta(entry: Mapping[str, Any] | None) -> str:
    if entry is None:
        return ""
    verdict = str(entry.get("verdict"))
    if verdict in ("incomparable", "new"):
        return _DELTA_WORD[verdict]
    if verdict == SAME:
        return "="
    return f"{entry['delta']:+.4f} {_DELTA_WORD[verdict]}"


def render(card: Scorecard, explain: bool = False) -> str:
    """Табло, которое читается за десять секунд."""
    lines: list[str] = []
    prov = card.provenance
    rule = "=" * 78
    lines.append(rule)
    dirty = " + НЕЗАКОММИЧЕННЫЕ ПРАВКИ" if prov.get("dirty") else ""
    lines.append(f"RAG-АУДИТ · СВОДКА    коммит {prov.get('commit', '?')}{dirty}")
    dump = prov.get("dump") or {}
    lines.append(
        f"корпус: {dump.get('name', '?')}  sha {str(dump.get('sha256', ''))[:12]}  "
        f"страниц {card.context_values.get('pages')}  чанков {card.context_values.get('chunks')}"
    )
    golden = prov.get("golden") or []
    lines.append(
        "золото: "
        + ", ".join(f"{g['name']} ({g['rows']} строк, sha {g['sha256'][:8]})" for g in golden)
    )
    if card.baseline_meta:
        lines.append(
            f"база:   {card.baseline_meta.get('created_utc')} "
            f"коммит {card.baseline_meta.get('commit')}"
        )
    else:
        lines.append("база:   нет — первый прогон")
    lines.append(rule)

    for stage in sorted(STAGES):
        lines.append("")
        lines.append(f"стык {stage} · {STAGES[stage]}")
        lines.append(f"         {STAGE_TRANSFER[stage]}")
        stage_metrics = [m for m in METRICS if m.stage == stage]
        for metric in stage_metrics:
            measurement = card.measurements[metric.key]
            threshold = card.thresholds.get(metric.key)
            sign = "≥" if metric.direction == UP else "≤"
            ok = (
                threshold_verdict(metric, measurement, threshold)["ok"]
                if threshold is not None
                else True
            )
            n = f"n={measurement.n}" if measurement.n else ""
            delta = _fmt_delta((card.changes.get("metrics") or {}).get(metric.key))
            lines.append(
                f"  {metric.label:<46.46} {measurement.value:>7.4f}  "
                f"{sign}{(threshold if threshold is not None else float('nan')):>7.4f}  "
                f"{'OK ' if ok else 'ПРОВАЛ':<6} {n:<7} {delta}"
            )
            if explain:
                lines.append(f"      ↳ {metric.rationale}")
        stage_wires = [t for t in TRIPWIRES if t.stage == stage]
        if stage_wires:
            fired = [t for t in stage_wires if card.tripwire_values.get(t.key)]
            if fired:
                for tripwire in fired:
                    lines.append(
                        f"  ! ТРЕВОГА {tripwire.label}: {card.tripwire_values[tripwire.key]}"
                    )
            else:
                lines.append(f"  тревоги ({len(stage_wires)}, нулевой допуск): чисто")

    ranks = card.changes.get("retrieval_ranks")
    if ranks is not None:
        lines.append("")
        lines.append("сменили ранг (стык 3, hybrid, по файлу) — аггрегат без этого не читается:")
        if not ranks:
            lines.append("  выдача идентична базовой: любая дельта аггрегатов была бы артефактом")
        for origin, bucket in sorted(ranks.items()):
            example = ", ".join(
                f"{e['id']} {e['was']}→{e['now']}" for e in bucket["examples"][:4]
            )
            lines.append(
                f"  {origin:<10} {bucket['changed']} вопросов "
                f"(лучше {bucket['improved']}, хуже {bucket['regressed']}){'  ' + example if example else ''}"
            )

    contained = card.changes.get("window_containment")
    if contained is not None:
        lines.append("")
        lines.append("пересекли порог «ответ доехал» (стык 4):")
        if not contained:
            lines.append("  ни один вопрос не сменил сторону порога")
        for origin, bucket in sorted(contained.items()):
            lines.append(
                f"  {origin:<10} {bucket['changed']} вопросов "
                f"(доехал {bucket['improved']}, потерян {bucket['regressed']})"
            )

    lines.append("")
    lines.append("контекст (порогами не калибруется):")
    ctx = card.context_values
    lines.append(
        f"  разделов {ctx.get('sections')}, из них длиннее 4000: {ctx.get('sections_over_cap')} "
        f"(в них {ctx.get('chunks_in_oversized_sections')} чанков из {ctx.get('chunks')})"
    )
    lines.append(
        f"  цена окна: {ctx.get('window_chars_mean')} симв. на вопрос, "
        f"{ctx.get('window_chars_5_blocks')} на пять блоков контекста"
    )
    lines.append(
        f"  потолок меры содержания: {ctx.get('window_ceiling')} "
        "(доля термов ответа, вообще достижимых в разделе)"
    )
    if card.timing:
        total = card.timing.get("total_s", 0.0)
        parts = ", ".join(
            f"{name} {value:.0f}s" for name, value in card.timing.items() if name != "total_s"
        )
        lines.append(f"  время прогона: {total:.0f}s ({parts})")

    lines.append("")
    lines.append(rule)
    for warning in card.warnings:
        lines.append(f"ВНИМАНИЕ: {warning}")
    for refusal in card.refusals:
        lines.append(f"ОТКАЗ СРАВНИВАТЬ: {refusal}")
    for failure in card.failures:
        lines.append(f"ПРОВАЛ: {failure}")

    lines.append(_summary_line(card))
    lines.append(rule)
    lines.extend(_honesty_block())
    return "\n".join(lines) + "\n"


def _summary_line(card: Scorecard) -> str:
    total = len(METRICS) + len(TRIPWIRES)
    held = total - len(card.failures)
    deltas = card.changes.get("metrics") or {}
    counts = {verdict: 0 for verdict in (SAME, NOISE, BETTER, WORSE)}
    for entry in deltas.values():
        verdict = entry.get("verdict")
        if verdict in counts:
            counts[verdict] += 1
    if card.failures:
        overall = "ХУЖЕ — гейт не пройден"
    elif card.baseline_meta is None:
        overall = "БАЗЫ НЕТ — проверены только пороги"
    elif card.refusals:
        overall = "СРАВНЕНИЕ НЕДЕЙСТВИТЕЛЬНО — пороги держатся, дельты нет"
    elif counts[BETTER] and not counts[WORSE]:
        overall = "ЛУЧШЕ"
    elif counts[BETTER] or counts[NOISE]:
        overall = "БЕЗ ЗНАЧИМЫХ ИЗМЕНЕНИЙ"
    else:
        overall = "БЕЗ ИЗМЕНЕНИЙ"
    return (
        f"ИТОГ: {overall}. пороги {held}/{total}; к базе — лучше {counts[BETTER]}, "
        f"хуже {counts[WORSE]}, шум {counts[NOISE]}, без изменений {counts[SAME]}. "
        f"код выхода {card.exit_code}"
    )


def _honesty_block() -> list[str]:
    return [
        "ЧТО ЭТИ ЧИСЛА НЕ ЗНАЧАТ",
        "  · Это НЕ прод-baseline. Плотные вектора здесь считает multilingual-e5-base,",
        "    в проде — GigaChat EmbeddingsGigaR по mTLS. Абсолютные hit@1 и MRR в прод НЕ",
        "    переносятся; переносятся СРАВНЕНИЯ при прочих равных. Прод-замер с генерацией",
        "    и судьёй — tools/eval/ на живом стенде, а не эта команда.",
        "  · Стыки 1–2 меряют прод-код целиком (convert.py, chunker.ts, bm25.ts) —",
        "    их абсолютные числа переносятся.",
        "  · Мера стыка 4 МОНОТОННА по размеру окна: большее окно не может набрать меньше,",
        "    а без ограничения даёт 1.0 по построению. Сама по себе она не может доказать,",
        "    что больший section_max_chars лучше — поэтому цена окна напечатана рядом.",
        "  · Генерация ответа и работа грейдера/реранкера здесь не меряются вовсе.",
    ]
