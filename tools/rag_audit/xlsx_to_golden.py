#!/usr/bin/env python3
"""Конвертация вопросов заказчика из xlsx в золотой набор `tools/eval/golden.jsonl`.

Ожидаемый лист: колонки «№ вопроса | Вопрос | Ответ». Колонка «Ответ» может быть
пустой — тогда `ground_truth` останется пустым, и это осознанно допустимо: три
судейские метрики из четырёх (faithfulness, answer_relevancy, context_precision)
считаются без эталонного ответа. Без `ground_truth` отваливается только
`context_recall`, без `source_path` — `retrieval_hit`. Так что первый прогон можно
снять сразу, а эталоны и пути дописать после разбора корпуса.

Категории и вердикт («ответ», «отказ», «метавопрос») берутся из
`tools/eval/golden.categories.json` и сопоставляются по НОРМАЛИЗОВАННОМУ тексту
вопроса, а не по номеру строки: переставили строки в Excel — ничего не сломалось,
переформулировали вопрос — конвертер об этом честно скажет и не подставит чужую
категорию молча.

xlsx разбирается стандартной библиотекой (zip + XML), без openpyxl.

    python3 tools/rag_audit/xlsx_to_golden.py ~/Downloads/'Ответы агента.xlsx'
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import zipfile
from typing import Any
from xml.etree import ElementTree as ET

_NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

# Дословно как в tools/eval/gen_golden.py: эталон для вопросов, где правильный
# ответ — отказ. Расхождение текста ломало бы context_recall на ловушках.
REFUSAL_GROUND_TRUTH = "В доступных мне документах ответа на этот вопрос не нашлось."

# kind — легаси-поле харнесса (factual/practical/unanswerable/meta). Держим его
# согласованным с категорией, чтобы старые отчёты и README не разъезжались.
_KIND_BY_CATEGORY = {
    "refusal_trap": "unanswerable",
    "procedure": "practical",
    "code": "practical",
    "table": "practical",
    "precision": "practical",
}

# Трёхзначный вердикт `expected_outcome` (tools/eval/run.py). Живёт здесь же, где
# category и expected_refusal, — в golden.categories.json, потому что это
# КЛАССИФИКАЦИЯ вопроса, а не добытая разбором корпуса разметка.
OUTCOME_ANSWER = "answer"
OUTCOME_REFUSAL = "refusal"
OUTCOME_META = "meta"
_OUTCOMES = (OUTCOME_ANSWER, OUTCOME_REFUSAL, OUTCOME_META)
# Вид строки следует ВЕРДИКТУ, а не теме (x23-meta — метапара категории meta).
_KIND_BY_OUTCOME = {OUTCOME_REFUSAL: "unanswerable", OUTCOME_META: "meta"}


def outcome_of(meta: dict[str, Any]) -> str:
    """Вердикт из классификации; при отсутствии выводится из expected_refusal.

    Явное поле важнее вывода: метапара («ответ есть, но документа-цели нет»)
    неотличима от ловушки по одному лишь expected_refusal — обе без source_path,
    а требуют ПРОТИВОПОЛОЖНОГО поведения.
    """
    raw = str(meta.get("expected_outcome", "") or "").strip()
    if raw in _OUTCOMES:
        return raw
    return OUTCOME_REFUSAL if meta.get("expected_refusal") else OUTCOME_ANSWER


def normalize_question(text: str) -> str:
    """Ключ сопоставления: пробелы схлопнуты, хвостовая пунктуация снята."""
    collapsed = re.sub(r"\s+", " ", text or "").strip()
    return collapsed.rstrip("?!.").strip().lower()


# ─────────────────────────── чтение xlsx ──────────────────────────────


def _cell_text(node: ET.Element, shared: list[str]) -> str:
    kind = node.get("t")
    if kind == "s":  # ссылка в таблицу общих строк
        value = node.find("m:v", _NS)
        if value is None or not (value.text or "").isdigit():
            return ""
        idx = int(value.text)
        return shared[idx] if 0 <= idx < len(shared) else ""
    if kind == "inlineStr":
        node_is = node.find("m:is", _NS)
        return "".join(t.text or "" for t in node_is.iter(f"{{{_NS['m']}}}t")) if node_is is not None else ""
    value = node.find("m:v", _NS)
    return (value.text or "") if value is not None else ""


def read_sheet(path: str) -> list[list[str]]:
    """Первый лист книги как список строк со значениями ячеек."""
    with zipfile.ZipFile(path) as zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", _NS):
                # Строка может быть разбита на несколько <t> внутри <r> (rich text).
                shared.append("".join(t.text or "" for t in si.iter(f"{{{_NS['m']}}}t")))

        sheets = sorted(n for n in zf.namelist() if n.startswith("xl/worksheets/sheet"))
        if not sheets:
            raise ValueError("в книге нет ни одного листа")
        root = ET.fromstring(zf.read(sheets[0]))

    rows: list[list[str]] = []
    for row in root.iter(f"{{{_NS['m']}}}row"):
        cells: list[str] = []
        for cell in row.findall("m:c", _NS):
            # Пропущенные ячейки в xlsx просто отсутствуют — восстанавливаем
            # позицию по буквенной части ссылки (A1, B1, …), иначе колонки съедут.
            ref = cell.get("r") or ""
            letters = "".join(ch for ch in ref if ch.isalpha())
            col = 0
            for ch in letters:
                col = col * 26 + (ord(ch.upper()) - 64)
            while len(cells) < max(col - 1, 0):
                cells.append("")
            cells.append(_cell_text(cell, shared))
        rows.append(cells)
    return rows


# ────────────────────────────── сборка ────────────────────────────────


def load_categories(path: str) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    entries = data.get("questions") or []
    return {normalize_question(e["question"]): e for e in entries}, entries


def load_existing(path: str) -> dict[str, dict[str, Any]]:
    """Ранее размеченные строки по нормализованному вопросу.

    Эталонные ответы и пути к источникам добываются разбором корпуса и стоят
    дорого, а в xlsx их нет. Поэтому регенерация обязана их сохранять: иначе
    один повторный запуск молча стирает всю разметку.
    """
    if not os.path.exists(path):
        return {}
    out: dict[str, dict[str, Any]] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            out[normalize_question(row.get("question", ""))] = row
    return out


def build_rows(
    sheet: list[list[str]],
    by_question: dict[str, dict[str, Any]],
    existing: dict[str, dict[str, Any]] | None = None,
) -> tuple[list[dict], list[str]]:
    rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    seen: set[str] = set()
    existing = existing or {}
    kept = 0

    for raw in sheet:
        if len(raw) < 2:
            continue
        num_cell = (raw[0] or "").strip()
        question = re.sub(r"\s+", " ", (raw[1] or "")).strip()
        answer = (raw[2] or "").strip() if len(raw) > 2 else ""
        if not question or not num_cell.isdigit():
            continue  # шапка и пустые строки

        key = normalize_question(question)
        meta = by_question.get(key)
        if meta is None:
            warnings.append(f"№{num_cell}: нет классификации для «{question[:70]}» → unclassified")
            meta = {"category": "unclassified", "expected_refusal": False}
        seen.add(key)

        category = meta.get("category") or "unclassified"
        outcome = outcome_of(meta)
        expected_refusal = outcome == OUTCOME_REFUSAL
        prev = existing.get(key, {})
        if prev:
            kept += 1
        # Ловушка не имеет источника по определению: если вопрос переехал в
        # refusal_trap, прежние путь и эталон относятся к другому вердикту и
        # должны уйти, иначе retrieval_hit начнёт мерить несуществующую цель.
        if expected_refusal:
            ground_truth = REFUSAL_GROUND_TRUTH
            source_path = section_path = chunk_index = None
            alt_source_paths: list[str] = []
        elif outcome == OUTCOME_META:
            # Метапара: документа-цели не существует, но эталон ответа — есть, и
            # он размечен вручную (в xlsx колонка ответа пуста). Пути обнуляются
            # как у ловушки, эталон переносится как у отвечаемой строки.
            ground_truth = answer or prev.get("ground_truth") or ""
            source_path = section_path = chunk_index = None
            alt_source_paths = []
        else:
            ground_truth = answer or prev.get("ground_truth") or ""
            source_path = prev.get("source_path")
            section_path = prev.get("section_path")
            chunk_index = prev.get("source_chunk_index")
            # Альтернативные источники размечаются так же дорого, как source_path
            # (разбором корпуса), и обязаны переживать регенерацию тем же путём.
            # Пустой список — осознанное «альтернатив нет», а не отсутствие поля.
            alt = prev.get("alt_source_paths")
            alt_source_paths = list(alt) if isinstance(alt, list) else []

        rows.append(
            {
                "id": f"x{int(num_cell):02d}-{category}",
                "question": question,
                "ground_truth": ground_truth,
                # Комментарий о КОРПУСЕ («в корпусе нет», «собирается из двух
                # страниц», «эта страница-двойник намеренно не в alt_source_paths»)
                # размечается разбором корпуса ровно так же дорого, как пути, и
                # переживает регенерацию тем же путём. В ground_truth ему нельзя:
                # это эталон ЗАМЕРА, а слов про устройство корпуса не содержит ни
                # одна страница — они только опускали бы потолок меры содержания.
                # Ловушку комментарий переживает: он объясняет ВЕРДИКТ, а не ответ.
                "ground_truth_note": str(prev.get("ground_truth_note") or ""),
                # Вид строки следует ВЕРДИКТУ, а не теме: ловушка «неотвечаема»,
                # метапара — «meta», какой бы категории ни был вопрос. Иначе
                # регенерация возвращала бы x23 kind: factual.
                "kind": _KIND_BY_OUTCOME.get(
                    outcome, _KIND_BY_CATEGORY.get(category, "factual")
                ),
                "category": category,
                "source_path": source_path,
                "alt_source_paths": alt_source_paths,
                "section_path": section_path,
                "source_chunk_index": chunk_index,
                "expected_refusal": expected_refusal,
                "expected_outcome": outcome,
                "accepted": prev.get("accepted"),
            }
        )

    for key, meta in by_question.items():
        if key not in seen:
            warnings.append(f"классификация есть, а вопроса в xlsx нет: «{meta['question'][:70]}»")
    if existing:
        warnings.append(f"перенесена разметка из существующего набора: {kept} из {len(rows)} строк")
    return rows, warnings


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    default_cats = os.path.join(here, "..", "eval", "golden.categories.json")
    default_out = os.path.join(here, "..", "eval", "golden.jsonl")

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx", help="файл с вопросами заказчика")
    ap.add_argument("--categories", default=os.path.normpath(default_cats))
    ap.add_argument("--out", default=os.path.normpath(default_out))
    ap.add_argument("--reset", action="store_true",
                    help="НЕ переносить разметку из существующего набора (эталоны и пути будут потеряны)")
    args = ap.parse_args()

    # По умолчанию перезапись безопасна: разметка переносится из текущего
    # набора по тексту вопроса. Стереть её можно только явным --reset.
    existing = {} if args.reset else load_existing(args.out)

    by_question, _ = load_categories(args.categories)
    rows, warnings = build_rows(read_sheet(args.xlsx), by_question, existing)
    if not rows:
        print("не нашлось ни одного вопроса — проверьте, что колонки идут как «№ | Вопрос | Ответ»", file=sys.stderr)
        return 1

    with open(args.out, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    counts: dict[str, int] = {}
    for row in rows:
        counts[row["category"]] = counts.get(row["category"], 0) + 1
    refusals = sum(1 for r in rows if r["expected_refusal"])
    with_gt = sum(1 for r in rows if r["ground_truth"])

    print(f"{args.out}: {len(rows)} вопросов", file=sys.stderr)
    print("\nПо категориям:", file=sys.stderr)
    for name, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {name:<14} {count}", file=sys.stderr)
    metas = sum(1 for r in rows if r["expected_outcome"] == OUTCOME_META)
    if metas:
        print(f"Метапар (expected_outcome: meta): {metas}", file=sys.stderr)
    answerable = [r for r in rows if r["expected_outcome"] == OUTCOME_ANSWER]
    with_path = sum(1 for r in answerable if r["source_path"])
    print(f"\nОжидается отказ: {refusals} | отвечаемых: {len(answerable)}", file=sys.stderr)
    print(f"С эталонным ответом: {with_gt} из {len(rows)}", file=sys.stderr)
    if with_gt < len(rows):
        print("  → context_recall посчитается только по строкам с эталоном", file=sys.stderr)
    # Путь нужен только отвечаемым: у ловушки источника нет по определению,
    # и retrieval_hit её осознанно не измеряет.
    print(f"С путём к источнику: {with_path} из {len(answerable)} отвечаемых", file=sys.stderr)
    if with_path < len(answerable):
        print("  → retrieval_hit посчитается только по строкам с путём", file=sys.stderr)
    for line in warnings:
        print(f"ВНИМАНИЕ: {line}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
