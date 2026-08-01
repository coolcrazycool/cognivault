"""Регенерация golden-набора обязана переносить дорогую ручную разметку.

`ground_truth`/`source_path`/`section_path` и теперь `alt_source_paths`
добываются разбором корпуса; в xlsx их нет, значит `build_rows` должен брать
их из существующего набора — иначе повторный запуск конвертера молча стирает
разметку.
"""

from __future__ import annotations

from xlsx_to_golden import REFUSAL_GROUND_TRUTH, build_rows

SHEET = [
    ["№ вопроса", "Вопрос", "Ответ"],
    ["1", "Что такое X?", ""],
    ["2", "Сколько стоит лицензия?", ""],
]

CATEGORIES = {
    "что такое x": {"question": "Что такое X?", "category": "definition", "expected_refusal": False},
    "сколько стоит лицензия": {
        "question": "Сколько стоит лицензия?",
        "category": "refusal_trap",
        "expected_refusal": True,
    },
}


def test_alt_source_paths_survive_regeneration_like_source_path():
    existing = {
        "что такое x": {
            "question": "Что такое X?",
            "ground_truth": "X — это инструмент.",
            "source_path": "Confluence/S/X.md",
            "alt_source_paths": ["Confluence/S/Пользовательская инструкция. X.md"],
            "section_path": "X > Описание",
            "source_chunk_index": None,
            "accepted": True,
        }
    }
    rows, _warnings = build_rows(SHEET, CATEGORIES, existing)
    row = next(r for r in rows if r["question"] == "Что такое X?")
    assert row["source_path"] == "Confluence/S/X.md"
    assert row["alt_source_paths"] == ["Confluence/S/Пользовательская инструкция. X.md"]
    assert row["section_path"] == "X > Описание"
    assert row["ground_truth"] == "X — это инструмент."


def test_alt_source_paths_default_to_empty_list_and_reset_on_refusal():
    # без прежней разметки — пустой список, а не отсутствие ключа:
    # у всех строк набора обязан быть одинаковый набор ключей.
    rows, _warnings = build_rows(SHEET, CATEGORIES, {})
    for row in rows:
        assert row["alt_source_paths"] == []
        assert list(row.keys()).index("alt_source_paths") == list(row.keys()).index("source_path") + 1

    # у ловушки прежние альтернативы относятся к другому вердикту и должны уйти
    existing = {
        "сколько стоит лицензия": {
            "question": "Сколько стоит лицензия?",
            "ground_truth": "старый ответ",
            "source_path": "Confluence/S/Лицензии.md",
            "alt_source_paths": ["Confluence/S/Прайс.md"],
        }
    }
    rows, _warnings = build_rows(SHEET, CATEGORIES, existing)
    trap = next(r for r in rows if r["expected_refusal"])
    assert trap["ground_truth"] == REFUSAL_GROUND_TRUTH
    assert trap["source_path"] is None
    assert trap["alt_source_paths"] == []
