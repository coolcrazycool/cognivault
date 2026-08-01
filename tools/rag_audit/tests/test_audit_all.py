"""Провенанс прогона: список грязных файлов обязан быть списком ФАЙЛОВ.

Прежний разбор звал `_git(...)`, который делал `.stdout.strip()`, и терял первый
символ первой строки `git status --porcelain` — потому что там код состояния
`' M'` начинается с пробела. В `baseline.json` от этого лежало
`"ools/eval/README.md"`. Портилась ровно ПЕРВАЯ запись, и предупреждение «дерево
грязное» продолжало печататься правдоподобно — поэтому ошибка и прожила несколько
перезаписей базы.
"""

from __future__ import annotations

import audit_all


def test_first_line_keeps_its_first_character():
    """Модифицированный, но не добавленный в индекс файл — код ' M', ведущий пробел."""
    porcelain = " M tools/eval/README.md\n M tools/eval/run.py\n"
    assert audit_all.parse_porcelain(porcelain) == [
        "tools/eval/README.md",
        "tools/eval/run.py",
    ]


def test_every_status_code_shape_yields_the_same_path():
    porcelain = "M  a.py\n M b.py\nMM c.py\nA  d.py\n?? e.py\n"
    assert audit_all.parse_porcelain(porcelain) == ["a.py", "b.py", "c.py", "d.py", "e.py"]


def test_rename_records_the_destination():
    """Прогон сделан тем деревом, где файл лежит по НОВОМУ пути."""
    porcelain = "R  tools/old.py -> tools/new.py\n"
    assert audit_all.parse_porcelain(porcelain) == ["tools/new.py"]


def test_clean_tree_is_an_empty_list_not_a_phantom_entry():
    assert audit_all.parse_porcelain("") == []
    assert audit_all.parse_porcelain("\n") == []


def test_paths_are_sorted():
    porcelain = " M z.py\n M a.py\n"
    assert audit_all.parse_porcelain(porcelain) == ["a.py", "z.py"]
