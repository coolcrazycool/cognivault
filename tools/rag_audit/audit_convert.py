#!/usr/bin/env python3
"""Аудит стыка storage → markdown: что теряет `convert.py` на реальном корпусе.

Инструмент прогоняет НАСТОЯЩИЙ конвертер (`cognivault-ui/app/confluence/convert.py`)
по каждой странице дампа (`tools/rag_audit/confluence_dump.py`) и меряет потери.
Ничего не чинит и не форкает: конвертер импортируется как есть — иначе замер
описывал бы копию, а не то, что реально крутится в проде.

ЗАЧЕМ отдельный инструмент, а не глазами
----------------------------------------
Потери конвертера невидимы: пропавший `<ac:plain-text-body>` или схлопнутая
двухколоночная раскладка выглядят в markdown как «так и было». Единственный
способ их поймать — сравнить вход с выходом поэлементно и получить число,
которое можно сравнить с числом после правки. Поэтому прогон детерминированный
(порядок страниц из manifest, никакой сети, никакого GigaChat) и печатает
машиночитаемый JSON рядом с человеческой сводкой.

Что меряется
------------
1. retention   -- доля слов исходного текста, дошедших до markdown;
2. macros      -- каждый `ac:name`: как обработан и выжило ли тело макроса;
3. tables      -- таблицы на входе/выходе, раскрытие colspan/rowspan по ячейкам;
4. code        -- CDATA код-макроса против блока в ```-заборе, байт в байт;
5. lists       -- `<li>` на входе против строк списка на выходе, глубина;
6. layouts     -- многоколоночные раскладки и во что схлопывается флэттенинг;
7. images      -- разрешаются ли пути вложений внутри вольта;
8. outliers    -- распределение размеров и разбор страниц-выбросов.

    python3 tools/rag_audit/audit_convert.py \\
        --dump ~/Downloads/confluence-dump.zip --out-dir /tmp/audit

Конвертированный markdown ложится в `<out-dir>/vault/` ровно по
`build_vault_path` (`Confluence/<space>/<предки…>/<Заголовок>.md`), чтобы
следующий этап аудита (чанкер) читал ту же раскладку, что и прод.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import statistics
import sys
import unicodedata
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any

# Конвертер живёт в отдельном приложении без установки пакета — путь добавляем
# до импорта `app.*`, иначе инструмент запускается только из cognivault-ui/.
_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT / "cognivault-ui"))

from urllib.parse import unquote  # noqa: E402

from bs4 import BeautifulSoup, Comment, NavigableString, Tag  # noqa: E402

from app.confluence.convert import (  # noqa: E402
    _DROP_MACROS,
    _RENDERED_PLAIN_BODY_MACROS as _CONVERTER_RENDERED_PLAIN_BODY,
    _LANG_MAP,
    _PANEL_LABELS,
    _PH_CLOSE,
    _PH_OPEN,
    _Context,
    _cdata_text,
    _grid_to_rows,
    _is_wide,
    _transform_images,
    _transform_links,
    _transform_macros,
    _unwrap_layouts,
    build_frontmatter,
    build_vault_path,
    render_document,
    storage_to_markdown,
)

# Макросы с именованным обработчиком в `_transform_macros`. Держится списком, а
# не интроспекцией: диспетчер конвертера — цепочка if/elif, разобрать её кодом
# нельзя, а разойтись список может только вместе с правкой конвертера, которую
# всё равно нужно отразить в аудите.
_NAMED_HANDLERS = {
    "code",
    "noformat",
    "expand",
    "status",
    "include",
    "excerpt-include",
    "jira",
    "drawio",
    "gliffy",
    "chart",
} | set(_PANEL_LABELS)

# Параметры макроса — конфиг, а не текст: язык кода, ширина колонки, id. Кроме
# `title`: он рендерится в выход (заголовок панели, подпись кода, метка status),
# так что для замера потерь считается содержимым.
_CONTENT_PARAMS = {"title"}

# Макросы, чей `ac:plain-text-body` Confluence РЕНДЕРИТ, а не показывает как есть.
# Для них эталон — видимый текст payload'а, а не его разметка: иначе `<div
# style="padding:0 10px">` попадает в «потерянное содержимое» и топит метрику
# шумом из атрибутов. Для `code`/`noformat` наоборот — там payload и есть текст.
_RENDERED_PLAIN_BODY_MACROS = _CONVERTER_RENDERED_PLAIN_BODY

_WORD_RE = re.compile(r"\w+", re.UNICODE)
_LIST_LINE_RE = re.compile(r"^(\s*)(?:[-*+]|\d+[.)])\s+\S")
_MD_TABLE_DELIM_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")
_SPLIT_NOTICE_RE = re.compile(r"\*\*Таблица(?:: .*?)? \(часть (\d+) из (\d+)\)\*\*")
_TRUNC_NOTICE_RE = re.compile(r"\[Таблица обрезана")
_LINEARIZED_LINE_RE = re.compile(r"^\*\*[^*\n]*:\*\* ")
_FENCE_RE = re.compile(r"^```(\S*)\s*$")
# Сентинел плейсхолдера конвертера (`_PH_OPEN`/`_PH_CLOSE` из convert.py) — в
# эталонном тексте это не содержимое, а метка «сюда конвертер подставит своё».
_PH_SENTINEL_RE = re.compile(_PH_OPEN + r"PH\d+" + _PH_CLOSE)


# ===========================================================================
# Извлечение видимого текста
# ===========================================================================


def storage_visible_text(storage: str) -> str:
    """Видимый текст storage-XHTML — эталон, с которым сверяется markdown.

    Из подсчёта выкидывается ровно то, чего в markdown быть и не должно:
    навигационные макросы из `_DROP_MACROS` (их выпил — осознанное решение
    конвертера, а не потеря) и служебные `<ac:parameter>`. Всё остальное,
    включая `<ac:plain-text-body>`, считается контентом — но у макросов из
    `_RENDERED_PLAIN_BODY_MACROS` payload сначала разбирается как HTML, см.
    комментарий к этой константе.
    """
    soup = BeautifulSoup(storage or "", "html.parser")
    for macro in soup.find_all("ac:structured-macro"):
        if (macro.get("ac:name") or "").lower() in _DROP_MACROS:
            macro.decompose()
    for param in soup.find_all("ac:parameter"):
        if (param.get("ac:name") or "").lower() not in _CONTENT_PARAMS:
            param.decompose()
    for body in soup.find_all("ac:plain-text-body"):
        macro = body.find_parent("ac:structured-macro")
        name = (macro.get("ac:name") or "").lower() if macro is not None else ""
        if name in _RENDERED_PLAIN_BODY_MACROS:
            body.string = _rendered_payload_text(_cdata_text(body))
    return block_aware_text(soup)


def _rendered_payload_text(payload: str) -> str:
    """Видимый текст payload'а, который Confluence рендерит как HTML/markdown."""
    return block_aware_text(BeautifulSoup(payload, "html.parser"))


def markdown_visible_text(md: str) -> str:
    """Видимый текст markdown: разметка снята, содержимое ячеек и кода на месте.

    Подчёркивание НЕ считается разметкой и не вырезается: markdownify выделяет
    звёздочками (`strong_em_symbol="*"`), а `_` в этом корпусе — часть имён
    вроде `afpc_sss_inc_safp_rsa_mapping`. Резать его — значит объявить
    потерянным то, что дошло целым, и завысить потери ровно на самых
    поисково-значимых токенах. Обратные слэши markdownify (``\\_``, ``\\[``)
    наоборот снимаются: это экранирование, а не текст.
    """
    text = md
    text = re.sub(r"^```.*$", " ", text, flags=re.MULTILINE)  # линии забора
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\|?\s*:?-{3,}:?.*$", " ", text, flags=re.MULTILINE)
    text = text.replace("|", " ").replace("<br>", " ")
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)  # ссылки/картинки
    text = re.sub(r"\\(.)", r"\1", text)  # снять экранирование markdownify
    text = re.sub(r"[*`]+", " ", text)
    text = re.sub(r"^\s*[->+]\s*", " ", text, flags=re.MULTILINE)
    return _normalize_space(text)


def _normalize_space(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


_BLOCK_TAGS = {
    "p", "div", "li", "br", "tr", "td", "th", "table", "ul", "ol",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre",
}

# Ни Confluence, ни markdownify не выводят это как текст. Восемь из 32 макросов
# `markdown` в корпусе — чистый CSS: считать его содержимым значит объявить
# потерянным то, чего в выходе быть не должно, и утопить метрику страницы.
_NON_TEXT_TAGS = {"style", "script"}


def block_aware_text(node: Tag) -> str:
    """Текст узла по тем же правилам склейки, что у конвертера.

    `get_text(" ")` не годится и здесь, и для страницы целиком: Confluence
    режет одно имя таблицы на несколько `<span>` со стилями, и разделитель
    превращает `afpc_sss_inc_safp_rsa_mapping` в два «слова». Конвертер их
    склеивает — сверка ловила бы не потерю, а разницу в токенизации. Пробел
    ставится только на границе блочных элементов, где конвертер и сам делает
    перевод строки или `<br>`. Сентинелы плейсхолдеров вырезаются: их
    содержимое конвертер подставит обратно, эталону оно неизвестно.
    """
    parts: list[str] = []

    def walk(current: Tag) -> None:
        for child in current.children:
            # Comment — подкласс NavigableString, поэтому проверяется первым:
            # иначе комментарий разметки попадёт в эталон как «видимый текст».
            if isinstance(child, Comment):
                continue
            if isinstance(child, NavigableString):
                parts.append(str(child))
            elif isinstance(child, Tag):
                if child.name in _NON_TEXT_TAGS:
                    continue
                if child.name in _BLOCK_TAGS:
                    parts.append(" ")
                walk(child)
                if child.name in _BLOCK_TAGS:
                    parts.append(" ")

    walk(node)
    return _normalize_space(_PH_SENTINEL_RE.sub(" ", "".join(parts)))


def words(text: str) -> Counter:
    return Counter(w.lower() for w in _WORD_RE.findall(text))


def recall(source: Counter, produced: Counter) -> float:
    """Доля слов источника, дошедших до результата (мультимножественно).

    Мера намеренно НЕ симметрична и НЕ про длину: конвертер размножает ячейки
    при раскрытии rowspan и дописывает заголовок — от этого доля не должна
    расти. Считается пересечение мультимножеств: лишнее в выходе не помогает,
    пропавшее во входе честно видно.
    """
    total = sum(source.values())
    if not total:
        return 1.0
    return sum((source & produced).values()) / total


# ===========================================================================
# Макросы
# ===========================================================================


def classify_macro(name: str) -> str:
    """`handled` / `dropped` / `unknown` — как с макросом поступит конвертер."""
    name = (name or "").lower()
    if name in _NAMED_HANDLERS:
        return "handled"
    if name in _DROP_MACROS:
        return "dropped"
    return "unknown"


def macro_observations(storage: str, md_words: Counter) -> list[dict[str, Any]]:
    """Наблюдения по каждому экземпляру макроса: тип тела и выживаемость текста."""
    soup = BeautifulSoup(storage or "", "html.parser")
    out: list[dict[str, Any]] = []
    for macro in soup.find_all("ac:structured-macro"):
        name = (macro.get("ac:name") or "").lower()
        plain = macro.find("ac:plain-text-body")
        rich = macro.find("ac:rich-text-body")
        # Тело берётся у САМОГО макроса: вложенный макрос считается отдельно,
        # иначе выживание родителя приписало бы себе текст ребёнка.
        body_kind = ""
        body_text = ""
        if plain is not None and plain.find_parent("ac:structured-macro") is macro:
            body_kind = "plain-text-body"
            body_text = _cdata_text(plain)
            if name in _RENDERED_PLAIN_BODY_MACROS:
                body_text = _rendered_payload_text(body_text)
        elif rich is not None and rich.find_parent("ac:structured-macro") is macro:
            body_kind = "rich-text-body"
            body_text = _normalize_space(rich.get_text(" "))
        body_words = words(body_text)
        out.append(
            {
                "name": name,
                "kind": classify_macro(name),
                "body_kind": body_kind,
                "body_chars": len(body_text),
                "body_words": sum(body_words.values()),
                "survival": recall(body_words, md_words) if body_words else None,
            }
        )
    return out


def inline_element_observations(storage: str, md_words: Counter) -> dict[str, Any]:
    """Инлайновые `ac:*`, которые макросами не являются, но текст несут."""
    soup = BeautifulSoup(storage or "", "html.parser")
    markers = soup.find_all("ac:inline-comment-marker")
    marker_words: Counter = Counter()
    for marker in markers:
        marker_words += words(marker.get_text(" "))
    emoticons = soup.find_all("ac:emoticon")
    emoticon_names = Counter(
        (e.get("ac:name") or e.get("ac:emoji-shortname") or "?") for e in emoticons
    )
    in_table = 0
    sole_in_cell = 0
    for emo in emoticons:
        cell = emo.find_parent(["td", "th"])
        if cell is None:
            continue
        in_table += 1
        # Галочка/крестик как ЕДИНСТВЕННОЕ содержимое ячейки — это «да»/«нет»
        # таблицы. Удалив её, конвертер оставляет пустую ячейку, и смысл строки
        # переворачивается на противоположный молча.
        if not cell.get_text(strip=True):
            sole_in_cell += 1
    return {
        "inline_comment_markers": len(markers),
        "inline_comment_marker_words": sum(marker_words.values()),
        "inline_comment_marker_survival": (
            recall(marker_words, md_words) if marker_words else None
        ),
        "emoticons": len(emoticons),
        "emoticons_in_tables": in_table,
        "emoticons_sole_in_cell": sole_in_cell,
        "emoticon_names": dict(emoticon_names),
    }


# ===========================================================================
# Таблицы
# ===========================================================================


def reference_grid(table: Tag) -> list[list[str]]:
    """Независимое раскрытие colspan/rowspan — эталон для сверки с конвертером.

    Своя реализация здесь нужна ИМЕННО потому, что проверяется чужая: сверять
    `_grid_to_rows` с самим собой бессмысленно. Логика минимальная и наивная —
    ячейка копируется во все покрытые ею позиции.
    """
    rows: list[Tag] = []
    for child in table.children:
        if not isinstance(child, Tag):
            continue
        if child.name == "tr":
            rows.append(child)
        elif child.name in ("thead", "tbody", "tfoot"):
            rows.extend(
                tr for tr in child.children if isinstance(tr, Tag) and tr.name == "tr"
            )

    grid: list[dict[int, str]] = [{} for _ in rows]
    for r, tr in enumerate(rows):
        col = 0
        for cell in tr.find_all(["td", "th"], recursive=False):
            while col in grid[r]:
                col += 1
            colspan = _span(cell, "colspan")
            rowspan = _span(cell, "rowspan")
            text = reference_cell_text(cell)
            for dr in range(rowspan):
                for dc in range(colspan):
                    if r + dr < len(grid):
                        grid[r + dr][col + dc] = text
            col += colspan

    width = max((max(row) + 1 if row else 0) for row in grid) if grid else 0
    return [[row.get(c, "") for c in range(width)] for row in grid]


def reference_cell_text(cell: Tag) -> str:
    """Текст ячейки-эталона (см. :func:`block_aware_text`)."""
    return block_aware_text(cell)


def _span(cell: Tag, name: str) -> int:
    try:
        value = int(str(cell.get(name, 1)).strip())
    except (TypeError, ValueError):
        return 1
    return value if value >= 1 else 1


def _stage_a_soup(storage: str, page_id: str) -> tuple[BeautifulSoup, _Context]:
    """Суп после Stage A конвертера — ровно то, что видит его табличный движок.

    Замерять раскрытие ячеек на СЫРОМ storage нельзя: до таблиц конвертер уже
    переписал макросы, картинки и ссылки, и сверка ловила бы не расхождение
    сеток, а разницу между `ac:image` и `<img>`. Здесь вызываются собственные
    шаги конвертера в его же порядке (см. `storage_to_markdown`), не копии.
    """
    soup = BeautifulSoup(storage or "", "html.parser")
    ctx = _Context(page_id=page_id, space="", crawl_titles={}, attachment_names=set())
    _transform_macros(soup, ctx)
    _transform_images(soup, ctx)
    _transform_links(soup, ctx)
    _unwrap_layouts(soup)
    return soup, ctx


def _cell_lost_words(ref_text: str, got_text: str) -> Counter:
    """Слова ячейки-эталона, не дошедшие до ячейки конвертера.

    Сравнение односторонним включением, а не равенством: конвертер ДОБАВЛЯЕТ
    в ячейку разметку (`![alt](src)`, восстановленный код в бэктиках), и
    равенство ругалось бы на обогащение, а искать надо потери.
    """
    return words(ref_text) - words(got_text)


def table_stats(storage: str, md: str, page_id: str) -> dict[str, Any]:
    """Таблицы: вход против выхода, раскрытие объединённых ячеек, нотисы."""
    soup, ctx = _stage_a_soup(storage, page_id)
    tables = soup.find_all("table")
    top_level = [t for t in tables if t.find_parent(["td", "th"]) is None]
    nested = len(tables) - len(top_level)

    details: list[dict[str, Any]] = []
    linearized_tables = 0
    for idx, table in enumerate(top_level):
        ref = reference_grid(table)
        ref_cells = sum(len(r) for r in ref)
        merged = bool(
            table.find(lambda t: t.name in ("td", "th") and (t.get("colspan") or t.get("rowspan")))
        )
        try:
            header, body, _caption = _grid_to_rows(table, ctx)
        except Exception as exc:  # конвертер не должен падать — если упал, это находка
            details.append(
                {"index": idx, "error": f"{type(exc).__name__}: {exc}", "merged": merged}
            )
            continue
        got = [header, *body]
        got_cells = sum(len(r) for r in got)
        wide = _is_wide(header, body)
        linearized_tables += int(wide)

        # Сверка «значение легло куда ожидалось»: попозиционно, по словам.
        matched = 0
        compared = 0
        lost_words = 0
        for r, ref_row in enumerate(ref):
            for c, ref_text in enumerate(ref_row):
                compared += 1
                got_text = got[r][c] if r < len(got) and c < len(got[r]) else ""
                lost = _cell_lost_words(ref_text, got_text)
                if lost:
                    lost_words += sum(lost.values())
                else:
                    matched += 1
        details.append(
            {
                "index": idx,
                "merged": merged,
                "linearized": wide,
                "rows_in": len(ref),
                "cols_in": len(ref[0]) if ref else 0,
                "cells_in": ref_cells,
                "rows_out": len(got),
                "cells_out": got_cells,
                "rectangular_out": len({len(r) for r in got}) <= 1,
                "cells_compared": compared,
                "cells_matched": matched,
                "cell_words_lost": lost_words,
                "chars_in": sum(len(c) for row in ref for c in row),
            }
        )

    gfm, linearized = _md_table_shapes(md)
    splits = _SPLIT_NOTICE_RE.findall(md)
    return {
        "tables_in": len(top_level),
        "tables_nested_in": nested,
        "tables_merged_in": sum(1 for d in details if d.get("merged")),
        "tables_linearized": linearized_tables,
        "gfm_tables_out": gfm["count"],
        "gfm_rows_out": gfm["rows"],
        "gfm_cells_out": gfm["cells"],
        "gfm_ragged_out": gfm["ragged"],
        "linearized_blocks_out": linearized,
        "split_notices": len(splits),
        "split_groups": len({int(t) for _k, t in splits}) if splits else 0,
        "truncation_notices": len(_TRUNC_NOTICE_RE.findall(md)),
        "details": details,
    }


def _md_table_shapes(md: str) -> tuple[dict[str, int], int]:
    """Считает GFM-таблицы (по строке-разделителю) и линеаризованные блоки."""
    lines = md.split("\n")
    count = rows = cells = ragged = 0
    idx = 0
    while idx < len(lines):
        if _MD_TABLE_DELIM_RE.match(lines[idx]) and idx > 0 and "|" in lines[idx - 1]:
            count += 1
            widths: set[int] = set()
            start = idx - 1
            end = idx + 1
            while end < len(lines) and lines[end].strip().startswith("|"):
                end += 1
            for line in [lines[start], *lines[idx + 1 : end]]:
                n = len(_split_md_row(line))
                widths.add(n)
                cells += n
                rows += 1
            if len(widths) > 1:
                ragged += 1
            idx = end
            continue
        idx += 1
    linearized = sum(1 for line in lines if _LINEARIZED_LINE_RE.match(line))
    return {"count": count, "rows": rows, "cells": cells, "ragged": ragged}, linearized


def _split_md_row(line: str) -> list[str]:
    stripped = line.strip()
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|"):
        stripped = stripped[:-1]
    # `\|` — экранированная труба внутри ячейки, разделителем не является.
    return re.split(r"(?<!\\)\|", stripped)


# ===========================================================================
# Код
# ===========================================================================


def code_stats(storage: str, md: str) -> dict[str, Any]:
    """Сверка CDATA код-макросов с ```-заборами: байт в байт, плюс языки."""
    soup = BeautifulSoup(storage or "", "html.parser")
    expected: list[dict[str, Any]] = []
    for macro in soup.find_all("ac:structured-macro"):
        name = (macro.get("ac:name") or "").lower()
        if name not in ("code", "noformat"):
            continue
        body = macro.find("ac:plain-text-body")
        payload = _cdata_text(body) if body is not None else ""
        raw_lang = ""
        for param in macro.find_all("ac:parameter"):
            if (param.get("ac:name") or "") == "language" and (
                param.find_parent("ac:structured-macro") is macro
            ):
                raw_lang = param.get_text().strip().lower()
        expected.append(
            {
                "macro": name,
                "raw_lang": raw_lang,
                "want_lang": "" if name == "noformat" else _LANG_MAP.get(raw_lang, raw_lang),
                "payload": payload,
                "in_table": macro.find_parent(["td", "th"]) is not None,
            }
        )

    produced = extract_fences(md)
    available = Counter(p["payload"] for p in produced)
    lang_by_payload: dict[str, list[str]] = {}
    for block in produced:
        lang_by_payload.setdefault(block["payload"], []).append(block["lang"])

    results: list[dict[str, Any]] = []
    for item in expected:
        payload = item["payload"]
        status = "missing"
        got_lang = None
        if available.get(payload, 0) > 0:
            available[payload] -= 1
            status = "exact"
            got_lang = lang_by_payload[payload].pop(0) if lang_by_payload.get(payload) else ""
        elif item["in_table"] and _collapsed_in(payload, md):
            status = "inlined"
        elif payload.strip() and payload.strip() in md:
            status = "reflowed"
        results.append(
            {
                "macro": item["macro"],
                "status": status,
                "want_lang": item["want_lang"],
                "got_lang": got_lang,
                "lang_ok": (got_lang == item["want_lang"]) if status == "exact" else None,
                "chars": len(payload),
                "in_table": item["in_table"],
            }
        )
    return {
        "code_macros": len(expected),
        "fences_out": len(produced),
        "results": results,
        "langs_in": Counter(i["raw_lang"] for i in expected if i["raw_lang"]),
        "langs_out": Counter(b["lang"] for b in produced if b["lang"]),
    }


def extract_fences(md: str) -> list[dict[str, str]]:
    """Все ```-блоки как (язык, содержимое) — сканером строк, не regexp'ом.

    Regexp по всему тексту спотыкается о ``` внутри полезной нагрузки; сканер
    повторяет поведение читателя markdown: забор открывается и закрывается.
    """
    blocks: list[dict[str, str]] = []
    lines = md.split("\n")
    idx = 0
    while idx < len(lines):
        opening = _FENCE_RE.match(lines[idx])
        if not opening:
            idx += 1
            continue
        lang = opening.group(1)
        idx += 1
        payload: list[str] = []
        while idx < len(lines) and lines[idx].rstrip() != "```":
            payload.append(lines[idx])
            idx += 1
        idx += 1
        blocks.append({"lang": lang, "payload": "\n".join(payload)})
    return blocks


def _collapsed_in(payload: str, md: str) -> bool:
    """Код из ячейки таблицы конвертер схлопывает в `один пробел` внутри бэктиков."""
    collapsed = re.sub(r"\s+", " ", payload).strip()
    return bool(collapsed) and f"`{collapsed}`" in md


# ===========================================================================
# Списки
# ===========================================================================


def list_stats(storage: str, md: str) -> dict[str, Any]:
    """`<li>` на входе против строк списка на выходе + глубина вложенности."""
    soup = BeautifulSoup(storage or "", "html.parser")
    for macro in soup.find_all("ac:structured-macro"):
        if (macro.get("ac:name") or "").lower() in _DROP_MACROS:
            macro.decompose()
    items = soup.find_all("li")
    in_table = [li for li in items if li.find_parent(["td", "th"]) is not None]
    depth_in = 0
    for li in items:
        depth = sum(1 for p in li.parents if getattr(p, "name", "") in ("ul", "ol"))
        depth_in = max(depth_in, depth)

    lines = [m for m in (_LIST_LINE_RE.match(l) for l in md.split("\n")) if m]
    indents = sorted({len(m.group(1)) for m in lines})
    return {
        "li_in": len(items),
        "li_in_tables": len(in_table),
        "li_outside_tables": len(items) - len(in_table),
        "list_lines_out": len(lines),
        "depth_in": depth_in,
        "depth_out": len(indents),
        "indent_levels": indents,
    }


# ===========================================================================
# Раскладки
# ===========================================================================


def layout_stats(storage: str) -> dict[str, Any]:
    """Многоколоночные секции: сколько их и какой текст в колонках."""
    soup = BeautifulSoup(storage or "", "html.parser")
    sections = soup.find_all("ac:layout-section")
    multi: list[dict[str, Any]] = []
    for section in sections:
        cells = [
            c
            for c in section.find_all("ac:layout-cell")
            if c.find_parent("ac:layout-section") is section
        ]
        if len(cells) > 1:
            multi.append(
                {
                    "type": section.get("ac:type") or "",
                    "cells": len(cells),
                    "cell_texts": [_normalize_space(c.get_text(" "))[:400] for c in cells],
                }
            )
    return {
        "layouts": len(soup.find_all("ac:layout")),
        "sections": len(sections),
        "cells": len(soup.find_all("ac:layout-cell")),
        "multicol_sections": len(multi),
        "multicol": multi,
    }


# ===========================================================================
# Картинки и вложения
# ===========================================================================


_MD_LINK_RE = re.compile(r"!?\[[^\]]*\]\(\s*<?([^)>\s]+)>?[^)]*\)")
_ATTACHMENT_ROOT = "Confluence/attachments/"


def image_stats(storage: str, vault_path: str, page_id: str, md: str) -> dict[str, Any]:
    """Разрешаются ли ссылки на вложения ОТНОСИТЕЛЬНО заметки, где они стоят.

    Судим по тому, что реально вышло в markdown, а не по тому, что конвертер
    «должен был» написать: линейка, воспроизводящая ожидаемый путь у себя,
    меряет собственную копию правила и не заметит ни его починки, ни его
    поломки. Считается разрешимой ссылка, которая после склейки с каталогом
    заметки указывает в `Confluence/attachments/` — туда, куда sync кладёт файл.
    """
    soup = BeautifulSoup(storage or "", "html.parser")
    external = 0
    dropped = 0

    images = soup.find_all("ac:image")
    for image in images:
        att = image.find("ri:attachment")
        url = image.find("ri:url")
        if att is not None and (att.get("ri:filename") or ""):
            continue
        if url is not None:
            external += 1
        else:
            dropped += 1

    att_links = sum(
        1
        for link in soup.find_all("ac:link")
        if (link.find("ri:attachment") or {}) and (link.find("ri:attachment").get("ri:filename") or "")
    )

    note_dir = posixpath.dirname(vault_path)
    resolved_ok = 0
    broken = 0
    examples: list[str] = []
    for href in _MD_LINK_RE.findall(md):
        if "://" in href or href.startswith("#"):
            continue
        target = unquote(href)
        if "attachments/" not in target:
            continue  # ссылка на другую заметку, а не на вложение
        resolved = posixpath.normpath(posixpath.join(note_dir, target))
        if resolved.startswith(_ATTACHMENT_ROOT):
            resolved_ok += 1
        else:
            broken += 1
            if len(examples) < 2:
                examples.append(f"{href}  ->  {resolved}  (ожидался {_ATTACHMENT_ROOT}…)")

    return {
        "images_in": len(images),
        "images_external": external,
        "images_dropped_no_filename": dropped,
        "attachment_links_in": att_links,
        "links_resolvable": resolved_ok,
        "links_broken": broken,
        "md_image_refs": len(re.findall(r"!\[[^\]]*\]\(", md)),
        "examples": examples,
    }


# ===========================================================================
# Прогон
# ===========================================================================


def load_dump(zip_path: Path, limit: int | None = None) -> tuple[dict, dict, list[dict]]:
    """Читает архив дампа: manifest, census, страницы В ПОРЯДКЕ manifest'а.

    Порядок из manifest, а не из `namelist()`, — иначе отчёты двух прогонов
    различались бы порядком записей и diff'ались бы вхолостую.
    """
    with zipfile.ZipFile(zip_path) as zf:
        manifest = json.loads(zf.read("manifest.json"))
        census = json.loads(zf.read("census.json")) if "census.json" in zf.namelist() else {}
        pages: list[dict] = []
        for entry in manifest.get("pages", [])[: limit or None]:
            name = f"pages/{entry['id']}.json"
            if name not in zf.namelist():
                continue
            pages.append(json.loads(zf.read(name)))
    return manifest, census, pages


def to_page_dict(raw: dict) -> dict:
    """Страница дампа → входной контракт конвертера (`body_storage`)."""
    page = dict(raw)
    page["body_storage"] = raw.get("storage") or ""
    return page


def build_crawl_titles(pages: list[dict]) -> dict[str, str]:
    """Карта «<space>::<title>» → путь, как её строит sync.py перед конвертацией."""
    titles: dict[str, str] = {}
    for raw in pages:
        key = f"{raw.get('space', '')}::{raw.get('title', '')}"
        titles[key] = build_vault_path(
            {
                "space": raw.get("space", ""),
                "title": raw.get("title", ""),
                "id": raw.get("id", ""),
                "ancestors": [],
            }
        )
    return titles


def audit_page(raw: dict, crawl_titles: dict[str, str]) -> tuple[dict[str, Any], str, str]:
    """Один прогон конвертера + все замеры. Возвращает (метрики, путь, документ)."""
    page = to_page_dict(raw)
    storage = page["body_storage"]
    page_id = str(page.get("id", ""))

    md, refs = storage_to_markdown(page, crawl_titles, set())
    vault_path = build_vault_path(page)
    # Хэш считается так же, как в sync.py, чтобы файл в `<out>/vault/` был
    # побайтово тем же, что уедет в настоящий вольт: следующий этап аудита
    # (чанкер) должен читать прод-документ, а не его облегчённую версию.
    content_hash = hashlib.sha256(md.encode("utf-8")).hexdigest()
    document = render_document(build_frontmatter(page, content_hash), md)

    src_text = storage_visible_text(storage)
    out_text = markdown_visible_text(md)
    src_words = words(src_text)
    out_words = words(out_text)
    lost = src_words - out_words

    metrics: dict[str, Any] = {
        "id": page_id,
        "title": page.get("title", ""),
        "path": vault_path,
        "storage_chars": len(storage),
        "md_chars": len(md),
        "text_chars_in": len(src_text),
        "text_chars_out": len(out_text),
        "words_in": sum(src_words.values()),
        "words_out": sum(out_words.values()),
        "words_lost": sum(lost.values()),
        "recall": round(recall(src_words, out_words), 4),
        "char_ratio": round(len(out_text) / len(src_text), 4) if src_text else 1.0,
        "top_lost_words": [w for w, _n in lost.most_common(10)],
        "macros": macro_observations(storage, out_words),
        "inline": inline_element_observations(storage, out_words),
        "tables": table_stats(storage, md, page_id),
        "code": code_stats(storage, md),
        "lists": list_stats(storage, md),
        "layouts": layout_stats(storage),
        "images": image_stats(storage, vault_path, page_id, md),
        "attachment_refs": len(refs),
    }
    return metrics, vault_path, document


def aggregate(pages: list[dict[str, Any]]) -> dict[str, Any]:
    """Свод по корпусу: только то, что складывается, — без средних от средних."""
    words_in = sum(p["words_in"] for p in pages)
    words_out_kept = sum(int(p["words_in"] * p["recall"]) for p in pages)

    macro_agg: dict[str, dict[str, Any]] = {}
    for page in pages:
        for obs in page["macros"]:
            entry = macro_agg.setdefault(
                obs["name"],
                {
                    "count": 0,
                    "kind": obs["kind"],
                    "body_kinds": Counter(),
                    "with_body": 0,
                    "body_words": 0,
                    "body_words_survived": 0,
                    "zero_survival": 0,
                },
            )
            entry["count"] += 1
            if obs["body_kind"]:
                entry["body_kinds"][obs["body_kind"]] += 1
            if obs["survival"] is not None:
                entry["with_body"] += 1
                entry["body_words"] += obs["body_words"]
                entry["body_words_survived"] += int(round(obs["body_words"] * obs["survival"]))
                if obs["survival"] < 0.05:
                    entry["zero_survival"] += 1
    for entry in macro_agg.values():
        entry["body_kinds"] = dict(entry["body_kinds"])
        entry["survival"] = (
            round(entry["body_words_survived"] / entry["body_words"], 4)
            if entry["body_words"]
            else None
        )

    code_results = [r for p in pages for r in p["code"]["results"]]
    code_status = Counter(r["status"] for r in code_results)
    lang_ok = sum(1 for r in code_results if r["lang_ok"])
    lang_checked = sum(1 for r in code_results if r["lang_ok"] is not None)

    table_details = [d for p in pages for d in p["tables"]["details"] if "error" not in d]
    cells_in = sum(d["cells_in"] for d in table_details)
    cells_out = sum(d["cells_out"] for d in table_details)
    cells_matched = sum(d["cells_matched"] for d in table_details)
    cells_compared = sum(d["cells_compared"] for d in table_details)

    sizes = sorted(p["md_chars"] for p in pages)
    marker_words = sum(p["inline"]["inline_comment_marker_words"] for p in pages)
    marker_survived = sum(
        int(round(p["inline"]["inline_comment_marker_words"] * (p["inline"]["inline_comment_marker_survival"] or 0)))
        for p in pages
    )

    return {
        "pages": len(pages),
        "retention": {
            "words_in": words_in,
            "words_kept": words_out_kept,
            "corpus_recall": round(words_out_kept / words_in, 4) if words_in else 1.0,
            "storage_chars": sum(p["storage_chars"] for p in pages),
            "md_chars": sum(p["md_chars"] for p in pages),
            "text_chars_in": sum(p["text_chars_in"] for p in pages),
            "text_chars_out": sum(p["text_chars_out"] for p in pages),
            "pages_below_50pct": sum(1 for p in pages if p["recall"] < 0.5),
            "pages_below_90pct": sum(1 for p in pages if p["recall"] < 0.9),
        },
        "macros": macro_agg,
        "inline": {
            "inline_comment_markers": sum(p["inline"]["inline_comment_markers"] for p in pages),
            "inline_comment_marker_words": marker_words,
            "inline_comment_marker_survival": (
                round(marker_survived / marker_words, 4) if marker_words else None
            ),
            "emoticons": sum(p["inline"]["emoticons"] for p in pages),
            "emoticons_in_tables": sum(p["inline"]["emoticons_in_tables"] for p in pages),
            "emoticons_sole_in_cell": sum(
                p["inline"]["emoticons_sole_in_cell"] for p in pages
            ),
            "emoticon_names": dict(
                sum((Counter(p["inline"]["emoticon_names"]) for p in pages), Counter())
            ),
        },
        "tables": {
            "tables_in": sum(p["tables"]["tables_in"] for p in pages),
            "tables_nested_in": sum(p["tables"]["tables_nested_in"] for p in pages),
            "tables_merged_in": sum(p["tables"]["tables_merged_in"] for p in pages),
            "tables_linearized": sum(p["tables"]["tables_linearized"] for p in pages),
            "gfm_tables_out": sum(p["tables"]["gfm_tables_out"] for p in pages),
            "gfm_cells_out": sum(p["tables"]["gfm_cells_out"] for p in pages),
            "gfm_ragged_out": sum(p["tables"]["gfm_ragged_out"] for p in pages),
            "linearized_blocks_out": sum(p["tables"]["linearized_blocks_out"] for p in pages),
            "split_notices": sum(p["tables"]["split_notices"] for p in pages),
            "truncation_notices": sum(p["tables"]["truncation_notices"] for p in pages),
            "cells_in": cells_in,
            "cells_out": cells_out,
            "cells_matched": cells_matched,
            "cells_compared": cells_compared,
            "cell_words_lost": sum(d["cell_words_lost"] for d in table_details),
            "cell_placement_accuracy": (
                round(cells_matched / cells_compared, 4) if cells_compared else 1.0
            ),
            "tables_with_cell_mismatch": sum(
                1 for d in table_details if d["cells_in"] != d["cells_out"]
            ),
            "tables_nonrectangular_out": sum(
                1 for d in table_details if not d["rectangular_out"]
            ),
            "converter_errors": sum(
                1 for p in pages for d in p["tables"]["details"] if "error" in d
            ),
        },
        "code": {
            "code_macros": sum(p["code"]["code_macros"] for p in pages),
            "fences_out": sum(p["code"]["fences_out"] for p in pages),
            "status": dict(code_status),
            "exact_rate": (
                round(code_status["exact"] / len(code_results), 4) if code_results else 1.0
            ),
            "lang_correct": lang_ok,
            "lang_checked": lang_checked,
            "langs_in": dict(sum((p["code"]["langs_in"] for p in pages), Counter())),
            "langs_out": dict(sum((p["code"]["langs_out"] for p in pages), Counter())),
        },
        "lists": {
            "li_in": sum(p["lists"]["li_in"] for p in pages),
            "li_in_tables": sum(p["lists"]["li_in_tables"] for p in pages),
            "li_outside_tables": sum(p["lists"]["li_outside_tables"] for p in pages),
            "list_lines_out": sum(p["lists"]["list_lines_out"] for p in pages),
            "pages_with_lost_items": sum(
                1
                for p in pages
                if p["lists"]["list_lines_out"] < p["lists"]["li_outside_tables"]
            ),
            "pages_flattened": sum(
                1 for p in pages if p["lists"]["depth_in"] > 1 and p["lists"]["depth_out"] <= 1
            ),
        },
        "layouts": {
            "layouts": sum(p["layouts"]["layouts"] for p in pages),
            "cells": sum(p["layouts"]["cells"] for p in pages),
            "sections": sum(p["layouts"]["sections"] for p in pages),
            "multicol_sections": sum(p["layouts"]["multicol_sections"] for p in pages),
            "pages_with_multicol": sum(1 for p in pages if p["layouts"]["multicol_sections"]),
        },
        "images": {
            "images_in": sum(p["images"]["images_in"] for p in pages),
            "images_external": sum(p["images"]["images_external"] for p in pages),
            "images_dropped_no_filename": sum(
                p["images"]["images_dropped_no_filename"] for p in pages
            ),
            "attachment_links_in": sum(p["images"]["attachment_links_in"] for p in pages),
            "links_resolvable": sum(p["images"]["links_resolvable"] for p in pages),
            "links_broken": sum(p["images"]["links_broken"] for p in pages),
            "md_image_refs": sum(p["images"]["md_image_refs"] for p in pages),
        },
        "sizes": {
            "min": sizes[0] if sizes else 0,
            "median": int(statistics.median(sizes)) if sizes else 0,
            "p90": sizes[int(len(sizes) * 0.9)] if sizes else 0,
            "max": sizes[-1] if sizes else 0,
            "total": sum(sizes),
            "empty_pages": sum(1 for p in pages if p["md_chars"] < 200),
        },
    }


def outliers(pages: list[dict[str, Any]]) -> dict[str, Any]:
    """Выбросы: чем корпус аномален по размеру и какие страницы пусты на выходе.

    Пустая страница на выходе — не «короткая страница», а сигнал: markdown
    меньше 200 символов при непустом storage означает, что весь контент
    провалился на каком-то шаге.
    """

    def _card(page: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": page["id"],
            "title": page["title"],
            "storage_chars": page["storage_chars"],
            "md_chars": page["md_chars"],
            "recall": page["recall"],
            "tables_in": page["tables"]["tables_in"],
            "table_rows_in": sum(d.get("rows_in", 0) for d in page["tables"]["details"]),
            "table_cells_in": sum(d.get("cells_in", 0) for d in page["tables"]["details"]),
            "gfm_tables_out": page["tables"]["gfm_tables_out"],
            "split_notices": page["tables"]["split_notices"],
            "truncation_notices": page["tables"]["truncation_notices"],
            "linearized_rows_out": page["tables"]["linearized_blocks_out"],
            "macros": dict(Counter(m["name"] for m in page["macros"])),
        }

    empty = [
        p
        for p in pages
        if p["md_chars"] < 200 and p["storage_chars"] >= 200
    ]
    return {
        "largest_storage": [_card(p) for p in sorted(pages, key=lambda p: -p["storage_chars"])[:5]],
        "largest_markdown": [_card(p) for p in sorted(pages, key=lambda p: -p["md_chars"])[:5]],
        "empty_output": [
            {
                "id": p["id"],
                "title": p["title"],
                "storage_chars": p["storage_chars"],
                "md_chars": p["md_chars"],
                "macros": dict(Counter(m["name"] for m in p["macros"])),
            }
            for p in sorted(empty, key=lambda p: -p["storage_chars"])
        ],
    }


def write_vault(out_dir: Path, path: str, document: str) -> None:
    target = out_dir / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(document, encoding="utf-8")


# ===========================================================================
# Человеческая сводка
# ===========================================================================


def print_summary(report: dict[str, Any], top: int) -> None:
    corpus = report["corpus"]
    out = sys.stdout.write

    ret = corpus["retention"]
    out("\n=== УДЕРЖАНИЕ ТЕКСТА ===\n")
    out(
        f"страниц: {corpus['pages']}   слов на входе: {ret['words_in']}   "
        f"дошло: {ret['words_kept']}   recall: {ret['corpus_recall']:.3f}\n"
    )
    out(
        f"символов storage: {ret['storage_chars']}  markdown: {ret['md_chars']}  "
        f"текста: {ret['text_chars_in']} -> {ret['text_chars_out']}\n"
    )
    out(
        f"страниц с recall < 0.9: {ret['pages_below_90pct']}   "
        f"< 0.5: {ret['pages_below_50pct']}\n"
    )

    out(f"\n=== ХУДШИЕ {top} СТРАНИЦ (по потерянным словам) ===\n")
    for page in report["worst_by_loss"][:top]:
        out(
            f"  {page['recall']:.2f}  -{page['words_lost']:>6} слов  "
            f"{page['storage_chars']:>7}ch  {page['title'][:70]}\n"
        )

    out("\n=== МАКРОСЫ ===\n")
    out(f"{'макрос':<22}{'n':>5} {'обработка':<10}{'тело':<18}{'выживание':>10}\n")
    for name, entry in sorted(corpus["macros"].items(), key=lambda kv: -kv[1]["count"]):
        survival = "—" if entry["survival"] is None else f"{entry['survival']:.2f}"
        bodies = ",".join(f"{k}:{v}" for k, v in entry["body_kinds"].items()) or "—"
        out(f"{name:<22}{entry['count']:>5} {entry['kind']:<10}{bodies:<18}{survival:>10}\n")
    inline = corpus["inline"]
    out(
        f"ac:inline-comment-marker: {inline['inline_comment_markers']}, "
        f"выживание текста {inline['inline_comment_marker_survival']}\n"
    )
    out(
        f"ac:emoticon: {inline['emoticons']} (в таблицах {inline['emoticons_in_tables']}, "
        f"из них единственное содержимое ячейки {inline['emoticons_sole_in_cell']}) "
        f"— удаляются безусловно\n"
    )

    tab = corpus["tables"]
    out("\n=== ТАБЛИЦЫ ===\n")
    out(
        f"на входе: {tab['tables_in']} (вложенных {tab['tables_nested_in']}, "
        f"с объединёнными ячейками {tab['tables_merged_in']})\n"
    )
    out(
        f"на выходе: GFM {tab['gfm_tables_out']} (ячеек {tab['gfm_cells_out']}, "
        f"неровных {tab['gfm_ragged_out']}), линеаризовано таблиц "
        f"{tab['tables_linearized']} ({tab['linearized_blocks_out']} строк)\n"
    )
    out(
        f"нотисов: обрезано {tab['truncation_notices']}, частей "
        f"{tab['split_notices']}\n"
    )
    out(
        f"ячеек эталон/конвертер: {tab['cells_in']}/{tab['cells_out']}, "
        f"совпало по позиции {tab['cell_placement_accuracy']:.4f} "
        f"({tab['cells_matched']}/{tab['cells_compared']}), потеряно слов в "
        f"ячейках {tab['cell_words_lost']}\n"
    )
    out(
        f"таблиц с расхождением по числу ячеек: {tab['tables_with_cell_mismatch']}, "
        f"неровных на выходе: {tab['tables_nonrectangular_out']}, "
        f"падений конвертера: {tab['converter_errors']}\n"
    )

    code = corpus["code"]
    out("\n=== КОД ===\n")
    out(
        f"макросов: {code['code_macros']}, заборов на выходе: {code['fences_out']}, "
        f"точных совпадений: {code['exact_rate']:.4f} {code['status']}\n"
    )
    out(
        f"язык забора верен: {code['lang_correct']}/{code['lang_checked']}; "
        f"вход {code['langs_in']} выход {code['langs_out']}\n"
    )

    lists = corpus["lists"]
    out("\n=== СПИСКИ ===\n")
    out(
        f"<li> {lists['li_in']} (в таблицах {lists['li_in_tables']}), строк списка "
        f"на выходе {lists['list_lines_out']}\n"
    )
    out(
        f"страниц с потерей пунктов: {lists['pages_with_lost_items']}, "
        f"со схлопнутой вложенностью: {lists['pages_flattened']}\n"
    )

    lay = corpus["layouts"]
    out("\n=== РАСКЛАДКИ ===\n")
    out(
        f"ac:layout {lay['layouts']}, секций {lay['sections']}, ячеек {lay['cells']}; "
        f"многоколоночных секций {lay['multicol_sections']} на "
        f"{lay['pages_with_multicol']} страницах\n"
    )

    img = corpus["images"]
    out("\n=== КАРТИНКИ И ВЛОЖЕНИЯ ===\n")
    out(
        f"ac:image {img['images_in']} (внешних {img['images_external']}, без имени "
        f"{img['images_dropped_no_filename']}), ссылок на вложения "
        f"{img['attachment_links_in']}\n"
    )
    out(
        f"путей разрешается: {img['links_resolvable']}, битых: {img['links_broken']}; "
        f"![]() в markdown: {img['md_image_refs']}\n"
    )

    sizes = corpus["sizes"]
    out("\n=== РАЗМЕРЫ MARKDOWN ===\n")
    out(
        f"min {sizes['min']}  median {sizes['median']}  p90 {sizes['p90']}  "
        f"max {sizes['max']}  сумма {sizes['total']}  пустых (<200ch) "
        f"{sizes['empty_pages']}\n"
    )
    empty = report["outliers"]["empty_output"]
    out(f"\n=== ПУСТОЙ ВЫХОД ПРИ НЕПУСТОМ ВХОДЕ ({len(empty)}) ===\n")
    for page in empty[:top]:
        macros = ",".join(f"{k}×{v}" for k, v in sorted(page["macros"].items()))
        out(
            f"  {page['storage_chars']:>7}ch -> {page['md_chars']:>4}ch  "
            f"{page['title'][:52]:<52} [{macros}]\n"
        )
    out("\n=== КРУПНЕЙШИЕ СТРАНИЦЫ ===\n")
    for page in report["outliers"]["largest_storage"]:
        out(
            f"  {page['storage_chars']:>8}ch -> {page['md_chars']:>7}ch  "
            f"recall {page['recall']:.2f}  таблиц {page['tables_in']} "
            f"(строк {page['table_rows_in']}, ячеек {page['table_cells_in']}) "
            f"частей {page['split_notices']} обрезок {page['truncation_notices']}  "
            f"{page['title'][:44]}\n"
        )


# ===========================================================================
# CLI
# ===========================================================================


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Аудит конвертера Confluence storage → Markdown по дампу корпуса.",
    )
    parser.add_argument("--dump", required=True, type=Path, help="zip от confluence_dump.py")
    parser.add_argument(
        "--out-dir",
        required=True,
        type=Path,
        help="каталог результата: <out>/vault/… и <out>/convert-report.json",
    )
    parser.add_argument("--limit", type=int, default=None, help="только первые N страниц")
    parser.add_argument("--top", type=int, default=20, help="длина списков-топов")
    parser.add_argument("--no-vault", action="store_true", help="не писать markdown на диск")
    args = parser.parse_args(argv)

    manifest, census, raw_pages = load_dump(args.dump, args.limit)
    crawl_titles = build_crawl_titles(raw_pages)

    out_dir: Path = args.out_dir
    vault_dir = out_dir / "vault"
    out_dir.mkdir(parents=True, exist_ok=True)

    page_metrics: list[dict[str, Any]] = []
    for raw in raw_pages:
        metrics, path, document = audit_page(raw, crawl_titles)
        if not args.no_vault:
            write_vault(vault_dir, path, document)
        page_metrics.append(metrics)

    corpus = aggregate(page_metrics)
    worst_by_loss = sorted(page_metrics, key=lambda p: -p["words_lost"])
    worst_by_recall = sorted(
        (p for p in page_metrics if p["words_in"] >= 50), key=lambda p: p["recall"]
    )

    def _slim(page: dict[str, Any]) -> dict[str, Any]:
        return {
            k: page[k]
            for k in (
                "id",
                "title",
                "path",
                "recall",
                "words_in",
                "words_lost",
                "storage_chars",
                "md_chars",
                "top_lost_words",
            )
        }

    report = {
        "tool": "cognivault-rag-audit/audit_convert",
        "format_version": 1,
        "dump": {
            "page_count": manifest.get("page_count"),
            "base_url": manifest.get("base_url"),
            "root": manifest.get("root"),
            "audited": len(page_metrics),
        },
        "census": census.get("totals", {}),
        "corpus": corpus,
        "worst_by_loss": [_slim(p) for p in worst_by_loss[: args.top]],
        "worst_by_recall": [_slim(p) for p in worst_by_recall[: args.top]],
        "outliers": outliers(page_metrics),
        "pages": page_metrics,
    }
    report_path = out_dir / "convert-report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=False, default=str),
        encoding="utf-8",
    )

    print_summary(report, args.top)
    sys.stdout.write(f"\notчёт: {report_path}\nvault: {vault_dir}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
