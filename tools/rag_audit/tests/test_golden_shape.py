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
CONTROL = REPO_ROOT / "tools" / "eval" / "golden.control.json"

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


@pytest.mark.parametrize(("path", "expected"), [(CUSTOMER, 39), (CORPUS, 212)])
def test_row_count_and_identical_key_order(path: Path, expected: int) -> None:
    data = rows(path)
    assert len(data) == expected
    orders = {tuple(r.keys()) for r in data}
    assert len(orders) == 1, f"разные наборы ключей: {orders}"
    keys = list(next(iter(orders)))
    assert keys.index("ground_truth_note") == keys.index("ground_truth") + 1
    assert keys.index("expected_outcome") == keys.index("expected_refusal") + 1


@pytest.mark.parametrize("path", [CUSTOMER, CORPUS])
def test_written_without_ascii_escapes(path: Path) -> None:
    """`ensure_ascii=False`: кириллица в файле кириллицей, иначе diff нечитаем."""
    assert "\\u04" not in path.read_text(encoding="utf-8")


@pytest.mark.parametrize("path", [CUSTOMER, CORPUS])
def test_every_answerable_row_has_a_source(path: Path) -> None:
    """Строка без пути и без вердикта не попадает НИ В ОДИН знаменатель аудита и
    при этом разбавляет отвечаемых в `tools/eval/run.py`.

    Вердиктов с 2026-08-01 три, и «пути нет» законно ровно у двух из них:
    `refusal` (ловушка) и `meta` (вопрос про саму базу или про ассистента —
    документа-цели не существует, но отвечать надо). У `answer` путь обязателен.
    """
    orphans = [
        r["id"]
        for r in rows(path)
        if r["expected_outcome"] == "answer" and not r["source_path"]
    ]
    assert orphans == []


@pytest.mark.parametrize("path", [CUSTOMER, CORPUS])
def test_outcome_agrees_with_the_binary_flag(path: Path) -> None:
    """`expected_outcome` ДОБАВЛЕН к `expected_refusal`, а не заменил его.

    Флаг ловушки читают четыре инструмента аудита; вердикт — живой харнесс.
    Разъехавшись, они дали бы двум наборам метрик разный состав корзин, и ни
    один тест этого бы не заметил.
    """
    guilty = [
        (r["id"], r["expected_refusal"], r["expected_outcome"])
        for r in rows(path)
        if r["expected_outcome"] not in ("answer", "refusal", "meta")
        or r["expected_refusal"] != (r["expected_outcome"] == "refusal")
    ]
    assert guilty == []


@pytest.mark.parametrize("path", [CUSTOMER, CORPUS])
def test_meta_rows_carry_no_target_but_do_carry_a_reference_answer(path: Path) -> None:
    """Метапара похожа на ловушку формой и противоположна ей по требованию.

    Цели в корпусе нет (иначе `retrieval_hit` мерил бы несуществующий документ),
    но эталон ответа обязателен: правильное поведение — ОТВЕТИТЬ, и без эталона
    судить этот ответ нечем.
    """
    for row in rows(path):
        if row["expected_outcome"] != "meta":
            continue
        assert row["source_path"] is None, row["id"]
        assert row["alt_source_paths"] == [], row["id"]
        assert row["section_path"] is None, row["id"]
        assert row["kind"] == "meta", row["id"]
        assert row["ground_truth"].strip(), row["id"]


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


# --------------------------------------------------------------------------- #
# Отрицательный контроль: golden.control.json
# --------------------------------------------------------------------------- #


def test_control_group_points_at_real_answerable_rows() -> None:
    """56 документных перечислений — знаменатель ложных оговорок для шагов 1–3.

    Список ЗАМОРОЖЕН намеренно (правило, перевычисляемое каждый раз, тихо меняло
    бы состав контроля), поэтому его связь с золотыми наборами надо сторожить:
    id обязан существовать, быть отвечаемым и нести ровно тот текст вопроса, по
    которому группу собирали.
    """
    control = json.loads(CONTROL.read_text(encoding="utf-8"))
    by_id = {r["id"]: r for r in rows(CUSTOMER) + rows(CORPUS)}

    ids = [q["id"] for q in control["questions"]]
    assert len(ids) == len(set(ids)), "повтор id в контрольной группе"
    assert control["measured"]["n"] == len(ids)

    for entry in control["questions"]:
        row = by_id.get(entry["id"])
        assert row is not None, f"{entry['id']} нет ни в одном золотом наборе"
        assert row["expected_outcome"] == "answer", entry["id"]
        assert row["source_path"] == entry["source_path"], entry["id"]
        # Сторож дрейфа: переформулировали вопрос — пересоберите группу.
        assert row["question"] == entry["question"], entry["id"]


def test_control_group_excludes_the_class_it_controls_for() -> None:
    """Контроль и измеряемый класс не должны пересекаться."""
    control = json.loads(CONTROL.read_text(encoding="utf-8"))
    by_id = {r["id"]: r for r in rows(CUSTOMER) + rows(CORPUS)}
    scoped = [q["id"] for q in control["questions"] if by_id[q["id"]]["category"] == "corpus_scope"]
    assert scoped == []
