"""Инварианты золотых наборов, которые ломаются молча.

Оба файла читают четыре инструмента аудита и живой харнесс `tools/eval/run.py`.
Строка с непарным набором ключей, «отвечаемая» строка без пути или комментарий о
корпусе, забытый внутри `ground_truth`, не роняют ничего — они просто делают
числа неправильными. Поэтому проверяется форма, а не содержание.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
CUSTOMER = REPO_ROOT / "tools" / "eval" / "golden.jsonl"
CORPUS = REPO_ROOT / "tools" / "eval" / "golden.corpus.jsonl"

#: Обороты, которых в ЭТАЛОНЕ быть не может: ни одна страница корпуса их не
#: содержит, а мера содержания стыка 4 считает по `ground_truth` термы, которые
#: обязаны найтись в разделе. Место таким фразам — в `ground_truth_note`.
META_PROSE_MARKERS = (
    "в корпусе нет",
    "корпус не",
    "корпус, таким образом",
    "собирается из дв",
    "собирается из стр",
    "прямого сопоставления",
    "прямого утверждения",
    "на этой странице нет",
    "в одном документе нет",
)


def rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


@pytest.mark.parametrize(("path", "expected"), [(CUSTOMER, 39), (CORPUS, 191)])
def test_row_count_and_identical_key_order(path: Path, expected: int) -> None:
    data = rows(path)
    assert len(data) == expected
    orders = {tuple(r.keys()) for r in data}
    assert len(orders) == 1, f"разные наборы ключей: {orders}"
    keys = list(next(iter(orders)))
    assert keys.index("ground_truth_note") == keys.index("ground_truth") + 1


@pytest.mark.parametrize("path", [CUSTOMER, CORPUS])
def test_written_without_ascii_escapes(path: Path) -> None:
    """`ensure_ascii=False`: кириллица в файле кириллицей, иначе diff нечитаем."""
    assert "\\u04" not in path.read_text(encoding="utf-8")


@pytest.mark.parametrize("path", [CUSTOMER, CORPUS])
def test_every_answerable_row_has_a_source(path: Path) -> None:
    """Строка без пути и без `expected_refusal` не попадает НИ В ОДИН знаменатель
    аудита и при этом разбавляет отвечаемых в `tools/eval/run.py`. Такой формы в
    наборе быть не должно (см. `x23-meta`, переведённый в ловушку 2026-08-01)."""
    orphans = [r["id"] for r in rows(path) if not r["expected_refusal"] and not r["source_path"]]
    assert orphans == []


@pytest.mark.parametrize("path", [CUSTOMER, CORPUS])
def test_traps_carry_no_target(path: Path) -> None:
    for row in rows(path):
        if row["expected_refusal"]:
            assert row["source_path"] is None, row["id"]
            assert row["alt_source_paths"] == [], row["id"]
            assert row["kind"] == "unanswerable", row["id"]


@pytest.mark.parametrize("path", [CUSTOMER, CORPUS])
def test_ground_truth_carries_no_prose_about_the_corpus(path: Path) -> None:
    guilty = [
        (r["id"], marker)
        for r in rows(path)
        for marker in META_PROSE_MARKERS
        if marker in r["ground_truth"].lower()
    ]
    assert guilty == [], (
        "редакторский комментарий о корпусе внутри эталона занижает потолок меры "
        f"содержания — перенесите его в ground_truth_note: {guilty}"
    )
