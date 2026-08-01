"""Golden-style tests for the Confluence storage -> Markdown pipeline.

Pure/offline. Run with: ``pytest tests/test_confluence_convert.py``
"""

from __future__ import annotations

import logging
import os
import posixpath
import re
import sys
import urllib.parse

import yaml

# Make ``app`` importable regardless of pytest's invocation directory.
_UI_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _UI_ROOT not in sys.path:
    sys.path.insert(0, _UI_ROOT)

from app.confluence import convert  # noqa: E402


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _page(body: str, **overrides) -> dict:
    page = {
        "id": "100",
        "title": "Тестовая страница",
        "space": "DEV",
        "version": 1,
        "last_updated": "2026-01-01T00:00:00Z",
        "ancestors": [],
        "labels": [],
        "source_url": "https://wiki.example.ru/pages/100",
        "body_storage": body,
    }
    page.update(overrides)
    return page


def _md(body: str, **kw) -> str:
    return convert.storage_to_markdown(_page(body), **kw)[0]


def _md_refs(body: str, **kw) -> tuple[str, list[str]]:
    return convert.storage_to_markdown(_page(body), **kw)


CODE_MACRO = (
    '<ac:structured-macro ac:name="code">'
    '<ac:parameter ac:name="language">js</ac:parameter>'
    '<ac:plain-text-body>'
    '<![CDATA[if (a < b && c > d) { return "<tag>"; }]]>'
    "</ac:plain-text-body></ac:structured-macro>"
)


# ---------------------------------------------------------------------------
# code / noformat
# ---------------------------------------------------------------------------


def test_code_cdata_verbatim_and_language_fence():
    md = _md(CODE_MACRO)
    # The exact code, with literal <, &, > -- NOT entity-encoded.
    assert 'if (a < b && c > d) { return "<tag>"; }' in md
    assert "&lt;" not in md
    assert "&amp;" not in md
    assert "&gt;" not in md
    # Fenced with the mapped language.
    assert "```javascript\n" in md
    lines = md.splitlines()
    open_idx = lines.index("```javascript")
    assert lines[open_idx + 1] == 'if (a < b && c > d) { return "<tag>"; }'
    assert lines[open_idx + 2] == "```"


def test_noformat_has_bare_fence():
    md = _md(
        '<ac:structured-macro ac:name="noformat">'
        "<ac:plain-text-body><![CDATA[plain <x> & y]]></ac:plain-text-body>"
        "</ac:structured-macro>"
    )
    assert "```\nplain <x> & y\n```" in md


def test_code_title_becomes_bold_caption_above():
    md = _md(
        '<ac:structured-macro ac:name="code">'
        '<ac:parameter ac:name="language">py</ac:parameter>'
        '<ac:parameter ac:name="title">Пример</ac:parameter>'
        "<ac:plain-text-body><![CDATA[print(1)]]></ac:plain-text-body>"
        "</ac:structured-macro>"
    )
    assert "**Пример**" in md
    assert md.index("**Пример**") < md.index("```python")


def test_blank_lines_inside_code_survive_postprocess():
    """Схлопывание пустых строк не имеет права трогать дословный код."""
    code = 'resp = client.get(url)\n\n\n# Пример ответа:\n{"status": "ok"}'
    md = _md(
        '<ac:structured-macro ac:name="code">'
        '<ac:parameter ac:name="language">python</ac:parameter>'
        f"<ac:plain-text-body><![CDATA[{code}]]></ac:plain-text-body>"
        "</ac:structured-macro>"
    )
    assert f"```python\n{code}\n```" in md


def test_code_inside_panel_is_a_closed_top_level_fence():
    """Забор внутри цитаты не закрывается: markdownify префиксует только первую строку."""
    code = 'SELECT 1\n\nFROM dual'
    md = _md(
        '<ac:structured-macro ac:name="panel">'
        '<ac:parameter ac:name="title">Инструкция для первого пользователя</ac:parameter>'
        "<ac:rich-text-body><p>Подготовить файлы:</p>"
        '<ac:structured-macro ac:name="code">'
        '<ac:parameter ac:name="language">sql</ac:parameter>'
        f"<ac:plain-text-body><![CDATA[{code}]]></ac:plain-text-body>"
        "</ac:structured-macro>"
        "</ac:rich-text-body></ac:structured-macro>"
    )
    assert "Инструкция для первого пользователя" in md
    assert f"```sql\n{code}\n```" in md
    # Ни одна строка забора не унесена в цитату — иначе он не закроется.
    assert not re.search(r"^\s*>.*```", md, re.MULTILINE)


# ---------------------------------------------------------------------------
# panels
# ---------------------------------------------------------------------------


def test_panels_render_russian_labelled_blockquotes():
    cases = {
        "info": "Информация",
        "note": "Примечание",
        "tip": "Совет",
        "warning": "Внимание",
    }
    for name, label in cases.items():
        md = _md(
            f'<ac:structured-macro ac:name="{name}">'
            "<ac:rich-text-body><p>содержимое</p></ac:rich-text-body>"
            "</ac:structured-macro>"
        )
        assert f"> **{label}:** содержимое" in md


def test_panel_macro_uses_title_or_default():
    md = _md(
        '<ac:structured-macro ac:name="panel">'
        '<ac:parameter ac:name="title">Заметка</ac:parameter>'
        "<ac:rich-text-body><p>тело</p></ac:rich-text-body>"
        "</ac:structured-macro>"
    )
    assert "> **Заметка:** тело" in md


# ---------------------------------------------------------------------------
# expand / status
# ---------------------------------------------------------------------------


def test_expand_becomes_bold_title_plus_body():
    """Title expand'а — жирный абзац, НЕ заголовок: заголовок рвёт разделы.

    Замер по дампу (127 страниц): у 77 из 158 titled expand-семейства за
    макросом идёт текст, который к блоку не относится, — заголовок приписывал
    его к разделу expand'а (см. `_handle_expand`).
    """
    md = _md(
        '<ac:structured-macro ac:name="expand">'
        '<ac:parameter ac:name="title">Детали</ac:parameter>'
        "<ac:rich-text-body><p>скрытый текст</p></ac:rich-text-body>"
        "</ac:structured-macro>"
    )
    assert "**Детали**" in md
    assert not re.search(r"^#+\s+Детали$", md, re.MULTILINE)
    assert "скрытый текст" in md
    assert "<details>" not in md


def test_expand_title_does_not_capture_trailing_siblings():
    """Текст ПОСЛЕ expand'а не должен уходить в «раздел» его title'а.

    Реальный паттерн из «Пользовательская инструкция. АРМ DS»: expand с
    примером стоит посреди нумерованной инструкции, и шаги после него
    принадлежат внешнему разделу, а не сворачиваемому блоку.  Заголовков,
    кроме H1 страницы и настоящего заголовка раздела, в выходе быть не должно
    — иначе чанкер отнесёт хвост к разделу expand'а.
    """
    md = _md(
        "<h2>Вкладка модели</h2>"
        "<p>5.1. Открыть карточку.</p>"
        '<ac:structured-macro ac:name="expand">'
        '<ac:parameter ac:name="title">Пример разметки</ac:parameter>'
        "<ac:rich-text-body><p>SELECT 1</p></ac:rich-text-body>"
        "</ac:structured-macro>"
        "<p>5.2. Заполнить примечания.</p>"
    )
    headings = re.findall(r"^(#+)\s", md, re.MULTILINE)
    # Только H1 страницы и H2→H3 раздела (demote): title заголовком не стал.
    assert sorted(len(h) for h in headings) == [1, 3]
    assert "**Пример разметки**" in md
    # Тело и хвост оба на месте, порядок сохранён.
    assert md.index("SELECT 1") < md.index("5\\.2\\.")


def test_status_becomes_inline_strong():
    md = _md(
        "<p>состояние "
        '<ac:structured-macro ac:name="status">'
        '<ac:parameter ac:name="title">ГОТОВО</ac:parameter>'
        "</ac:structured-macro></p>"
    )
    assert "**[ГОТОВО]**" in md


# ---------------------------------------------------------------------------
# tables
# ---------------------------------------------------------------------------


def test_table_rowspan_and_colspan_duplication():
    md = _md(
        "<table><tbody>"
        "<tr><th>A</th><th>B</th><th>C</th></tr>"
        '<tr><td rowspan="2">R</td><td colspan="2">CD</td></tr>'
        "<tr><td>x</td><td>y</td></tr>"
        "</tbody></table>"
    )
    assert "| A | B | C |" in md
    # colspan=2 duplicated across B and C.
    assert "| R | CD | CD |" in md
    # rowspan=2 copies R into the next row's first column.
    assert "| R | x | y |" in md


def _two_col_rows(count: int) -> str:
    return "".join(
        f"<tr><td>значение ячейки номер {i} с длинным текстом</td>"
        f"<td>второй столбец данных номер {i}</td></tr>"
        for i in range(count)
    )


def test_table_split_repeats_header_each_part():
    md = _md(
        "<table><tbody>"
        "<tr><th>Колонка А</th><th>Колонка Б</th></tr>"
        f"{_two_col_rows(150)}</tbody></table>"
    )
    # More than one part, each labelled and each repeating the header row.
    assert md.count("| Колонка А | Колонка Б |") >= 2
    assert "часть 1 из" in md
    assert "часть 2 из" in md
    # Every part is a complete GFM table (header + separator).
    assert md.count("| --- | --- |") == md.count("| Колонка А | Колонка Б |")


def test_table_split_threshold_matches_chunker_budget():
    """~1200 chunker tokens, not ~350: one seam with the chunker, not two."""
    assert convert._MAX_TABLE_TOKENS == 1200
    # The budget is spent in the CHUNKER's unit. cl100k spends ~2.0-2.4 chars
    # per token on Cyrillic table rows, so converting at 3 chars/token would
    # emit ~1550-token parts and the chunker would cut every one of them again.
    assert convert._TABLE_CHARS_PER_TOKEN == 2
    assert convert._MAX_TABLE_CHARS <= convert._MAX_TABLE_TOKENS * 2

    # A table that the OLD 350-token threshold would have split, but that now
    # fits a single chunker-sized group -> emitted whole, no "часть N из M".
    md = _md(
        "<table><tbody>"
        "<tr><th>Колонка А</th><th>Колонка Б</th></tr>"
        f"{_two_col_rows(20)}</tbody></table>"
    )
    assert len(md) > 350 * 3
    assert "часть" not in md
    assert md.count("| Колонка А | Колонка Б |") == 1
    assert md.count("| --- | --- |") == 1

    # And when a table does exceed the new budget, every emitted part stays
    # within it -- so the chunker never has to cut a second time.
    big = _md(
        "<table><tbody>"
        "<tr><th>Колонка А</th><th>Колонка Б</th></tr>"
        f"{_two_col_rows(150)}</tbody></table>"
    )
    parts = re.split(r"\*\*Таблица \(часть \d+ из \d+\)\*\*", big)[1:]
    assert len(parts) >= 2
    for part in parts:
        assert len(part.strip()) <= convert._MAX_TABLE_CHARS


def test_expanded_merged_cell_table_is_capped_and_marked(caplog):
    """A rowspan blow-up is truncated with an in-text notice + a warn log."""
    # Cells stay under the "wide cell" limit so this exercises the GFM path.
    cell = "объединённая ячейка " * 4
    rows = "".join(
        f'<tr><td rowspan="2">{cell}{i}</td><td>{cell}{i}</td></tr>'
        for i in range(800)
    )
    with caplog.at_level(logging.WARNING, logger="cognivault.confluence.convert"):
        md = _md(
            "<table><tbody>"
            "<tr><th>Ключ</th><th>Значение</th></tr>"
            f"{rows}</tbody></table>"
        )

    assert "Таблица обрезана" in md
    assert "пропущено строк" in md
    assert "truncated" in caplog.text
    # Truncated well below the raw expanded size.
    cap_chars = convert._MAX_EXPANDED_TABLE_CHARS
    assert len(md) < cap_chars * 1.5
    # Late rows are gone, early rows survive.
    assert f"{cell}799" not in md
    assert f"{cell}0" in md
    assert md.count("| Ключ | Значение |") >= 1


def test_square_brackets_in_plain_text_still_escaped():
    """Escaping is lifted for macro labels only, not for ordinary body text."""
    md = _md("<p>обычный текст [в скобках] и ещё [АБВ-42]</p>")
    assert r"\[в скобках]" in md
    assert r"\[АБВ" in md


def test_wide_table_is_linearized():
    cols = "".join(f"<th>Поле{i}</th>" for i in range(10))
    vals = "".join(f"<td>знач{i}</td>" for i in range(10))
    md = _md(f"<table><tbody><tr>{cols}</tr><tr>{vals}</tr></tbody></table>")
    # No GFM grid; each row linearized as "**Поле:** знач".
    assert "**Поле0:** знач0" in md
    assert "**Поле9:** знач9" in md
    assert "| --- |" not in md


def test_ragged_span_does_not_crash_and_clamps():
    md = _md(
        "<table><tbody>"
        "<tr><th>A</th><th>B</th></tr>"
        '<tr><td colspan="5">wide</td></tr>'
        "</tbody></table>"
    )
    # colspan exceeding columns is expanded by duplication, never crashes.
    assert "wide" in md
    assert md.count("wide") == 5


def test_table_header_heuristic_when_no_th():
    md = _md(
        "<table><tbody>"
        "<tr><td>заг1</td><td>заг2</td></tr>"
        "<tr><td>a</td><td>b</td></tr>"
        "</tbody></table>"
    )
    lines = [l for l in md.splitlines() if l.startswith("|")]
    # First row promoted to header, followed by the separator.
    assert lines[0] == "| заг1 | заг2 |"
    assert lines[1] == "| --- | --- |"
    assert lines[2] == "| a | b |"


def test_nested_table_is_flattened():
    md = _md(
        "<table><tbody>"
        "<tr><th>H</th></tr>"
        "<tr><td>внешняя "
        "<table><tbody><tr><td>вн1</td><td>вн2</td></tr></tbody></table>"
        "</td></tr>"
        "</tbody></table>"
    )
    assert "«вн1; вн2»" in md
    # Only the outer table becomes a GFM grid.
    assert md.count("| --- |") == 1


def test_table_cell_pipe_escaped():
    md = _md(
        "<table><tbody>"
        "<tr><th>K</th></tr>"
        "<tr><td>a | b</td></tr>"
        "</tbody></table>"
    )
    assert r"a \| b" in md


# ---------------------------------------------------------------------------
# tables: regressions found by measuring the converter on a real corpus
# ---------------------------------------------------------------------------


def test_wide_table_is_linearized_whole_not_truncated_first():
    """Обрезка не должна опережать решение о линеаризации.

    Широкая таблица (>8 колонок) с тяжёлым rowspan раскрывалась в сетку,
    которую обрезали по лимиту GFM, и линеаризация получала уже обрубок:
    на реальной странице так терялось 178 из 262 строк.
    """
    head = "".join(f"<th>Поле{i}</th>" for i in range(12))
    rows = "".join(
        '<tr><td rowspan="2">повторяющееся значение ячейки очень длинное {0}</td>'.format(i)
        + "".join(
            f"<td>значение {i} колонки {j} с достаточно длинным текстом</td>"
            for j in range(11)
        )
        + "</tr>"
        for i in range(300)
    )
    md = _md(f"<table><tbody><tr>{head}</tr>{rows}</tbody></table>")

    assert "Таблица обрезана" not in md
    # И первая, и последняя строка на месте.
    assert "**Поле0:** повторяющееся значение ячейки очень длинное 0" in md
    assert "значение 299 колонки 10 с достаточно длинным текстом" in md


def test_linearized_table_still_has_a_last_resort_cap(caplog):
    """Потолок линеаризации остался страховкой от катастрофического rowspan."""
    huge = "объединённая ячейка " * 200
    rows = f'<tr><td rowspan="400">{huge}</td><td>строка номер 0</td></tr>' + "".join(
        f"<tr><td>строка номер {i}</td></tr>" for i in range(1, 400)
    )
    with caplog.at_level(logging.WARNING, logger="cognivault.confluence.convert"):
        md = _md(f"<table><tbody><tr><th>A</th><th>B</th></tr>{rows}</tbody></table>")

    assert "Таблица обрезана" in md
    assert "пропущено строк" in md
    assert "truncated" in caplog.text
    assert len(md) < convert._MAX_LINEARIZED_TABLE_CHARS * 1.5


def test_single_row_table_is_rendered_as_data_not_header():
    """Однострочная таблица — данные, а не шапка (иначе исчезает целиком)."""
    schema = (
        "root<br />|-- source: string (nullable = true) (имя канала cards/uko/afcc)"
        "<br />|-- client_transaction_id: string (nullable = true)"
        "<br />|-- event_dt: integer (nullable = true) (формат yyyyMMdd)"
        "<br />|-- processed_time: long (nullable = true) (техническое поле загрузки)"
    )
    md = _md(f"<table><tbody><tr><td><p>{schema}</p></td></tr></tbody></table>")
    assert "nullable" in md
    assert "client_transaction_id" in md

    # Короткая пара «ключ — значение» тоже выходит содержимым, а не обглодком.
    md2 = _md(
        "<table><tbody><tr>"
        "<th>Статус страницы</th><th>Актуально</th>"
        "</tr></tbody></table>"
    )
    assert "Статус страницы — Актуально" in md2
    assert "| --- |" not in md2


def test_full_width_row_above_header_becomes_caption():
    """Строка-название над шапкой — подпись; строки не переставляются."""
    md = _md(
        "<table><tbody>"
        '<tr><td colspan="3">models_monitoring_distr.simple_metrics</td></tr>'
        "<tr><th>Атрибут</th><th>Тип</th><th>Значение</th></tr>"
        "<tr><td>depth</td><td>bigint</td><td>Глубина расчёта метрик</td></tr>"
        "</tbody></table>"
    )
    assert "**Таблица: models_monitoring_distr.simple_metrics**" in md
    # Название не размножено colspan'ом по колонкам тела.
    assert (
        "| models_monitoring_distr.simple_metrics "
        "| models_monitoring_distr.simple_metrics |"
    ) not in md
    lines = [line for line in md.splitlines() if line.startswith("|")]
    assert lines[0] == "| Атрибут | Тип | Значение |"
    assert lines[2] == "| depth | bigint | Глубина расчёта метрик |"


def test_colspan_over_one_header_collapses_to_single_column():
    """colspan по колонкам ОДНОГО заголовка — уровень вложенности, не данные."""
    md = _md(
        "<table><tbody>"
        '<tr><th colspan="2">Атрибут</th><th>Значение</th></tr>'
        '<tr><td colspan="2">core</td><td>Данные для обогащения</td></tr>'
        '<tr><td rowspan="2"><br /></td><td>partitionColumn</td>'
        "<td>Колонка партиционирования</td></tr>"
        "<tr><td>alias</td><td>Наименование таблицы</td></tr>"
        "</tbody></table>"
    )
    assert "| Атрибут | Значение |" in md
    assert "| Атрибут | Атрибут |" not in md
    assert "| core | Данные для обогащения |" in md
    # Вложенность сохранена меткой уровня.
    assert "| — partitionColumn | Колонка партиционирования |" in md
    assert md.count("partitionColumn") == 1
    # Сетка осталась прямоугольной.
    widths = {line.count("|") for line in md.splitlines() if line.startswith("|")}
    assert widths == {3}


def test_colspan_duplicate_kept_once_when_columns_are_real():
    """Если колонки диапазона несут разные значения, они остаются."""
    md = _md(
        "<table><tbody>"
        '<tr><th colspan="2">Атрибут</th><th>Тип</th></tr>'
        '<tr><td colspan="2">config_id</td><td>String</td></tr>'
        "<tr><td>config</td><td>rules</td><td>Array</td></tr>"
        "</tbody></table>"
    )
    assert "| Атрибут | Атрибут | Тип |" in md
    # Колонки на месте, но размноженное colspan'ом значение не повторяется.
    assert "| config_id |  | String |" in md
    assert "| config | rules | Array |" in md


def test_heading_inside_cell_does_not_weld_words():
    """Подпись `expand` внутри ячейки — блок: без разделителя слова слипались."""
    md = _md(
        "<table><tbody>"
        "<tr><th>Шаг</th><th>Описание</th></tr>"
        "<tr><td>1</td><td>Нужно отправить его реквизиты"
        '<ac:structured-macro ac:name="expand">'
        '<ac:parameter ac:name="title">Пример реквизитов</ac:parameter>'
        "<ac:rich-text-body><p>CN=CI06076835-IFT-armds, OU=00</p>"
        "</ac:rich-text-body></ac:structured-macro>"
        "</td></tr>"
        "</tbody></table>"
    )
    assert "реквизитовCN" not in md
    assert "**Пример реквизитов**<br>CN=CI06076835-IFT-armds" in md


def test_emoticon_alone_in_cell_becomes_word():
    """Эмотикон — единственное содержимое ячейки: это значение строки."""
    md = _md(
        "<table><tbody>"
        "<tr><th>Поле</th><th>Обязательное</th><th>Комментарий</th></tr>"
        '<tr><td>Название</td><td><ac:emoticon ac:name="plus" /></td>'
        "<td>Указать название потока</td></tr>"
        '<tr><td>Описание</td><td><ac:emoticon ac:name="cross" /></td>'
        "<td>Необязательно</td></tr>"
        "</tbody></table>"
    )
    assert "| Название | да | Указать название потока |" in md
    assert "| Описание | нет | Необязательно |" in md


def test_decorative_emoticon_next_to_text_still_dropped():
    md = _md('<p>Готово <ac:emoticon ac:name="plus" /> к работе</p>')
    assert "да" not in md
    assert "Готово" in md


def test_code_macro_in_cell_keeps_its_fence():
    """Забор в GFM-ячейку не влезает, поэтому таблица с кодом линеаризуется."""
    code = '{\n\t"config_id": "12345",\n\t"rules": []\n}'
    md = _md(
        "<table><tbody>"
        "<tr><th>Атрибут</th><th>Пример ответа</th></tr>"
        "<tr><td>config</td><td>"
        '<ac:structured-macro ac:name="code">'
        '<ac:parameter ac:name="language">json</ac:parameter>'
        f"<ac:plain-text-body><![CDATA[{code}]]></ac:plain-text-body>"
        "</ac:structured-macro></td></tr>"
        "</tbody></table>"
    )
    assert "```json\n" + code + "\n```" in md
    assert "| --- |" not in md
    assert "**Атрибут:** config" in md


def test_code_repeated_by_rowspan_is_fenced_once():
    """rowspan размножает ячейку с кодом — забор выводится один раз."""
    code = '{\n\t"rules": [\n\t\t{"id": "010d87fc"}\n\t]\n}'
    rows = "".join(
        f"<tr><td>атрибут{i}</td><td>Описание атрибута номер {i}</td></tr>"
        for i in range(1, 4)
    )
    md = _md(
        "<table><tbody>"
        "<tr><th>Атрибут</th><th>Значение</th><th>Пример ответа</th></tr>"
        '<tr><td>атрибут0</td><td>Описание нулевого атрибута</td><td rowspan="4">'
        '<ac:structured-macro ac:name="code">'
        '<ac:parameter ac:name="language">json</ac:parameter>'
        f"<ac:plain-text-body><![CDATA[{code}]]></ac:plain-text-body>"
        "</ac:structured-macro></td></tr>"
        f"{rows}</tbody></table>"
    )
    assert md.count("```json") == 1
    assert '"010d87fc"' in md
    assert md.count("(см. выше)") == 3
    # Ни один сентинел плейсхолдера не дожил до вывода.
    assert convert._PH_OPEN not in md and convert._PH_CLOSE not in md


def test_short_code_in_cell_stays_inline_and_keeps_gfm():
    md = _md(
        "<table><tbody>"
        "<tr><th>Команда</th><th>Что делает</th></tr>"
        "<tr><td>"
        '<ac:structured-macro ac:name="code">'
        '<ac:parameter ac:name="language">bash</ac:parameter>'
        "<ac:plain-text-body><![CDATA[kinit -kt ./t.keytab]]></ac:plain-text-body>"
        "</ac:structured-macro></td><td>Получает билет</td></tr>"
        "</tbody></table>"
    )
    assert "| `kinit -kt ./t.keytab` | Получает билет |" in md
    assert "```" not in md


# ---------------------------------------------------------------------------
# headings
# ---------------------------------------------------------------------------


def test_heading_demotion_and_single_title_h1():
    md = _md("<h1>Раздел</h1><p>текст</p>")
    # Exactly one level-1 heading (the prepended title).
    h1s = re.findall(r"^# (?!#)(.+)$", md, re.MULTILINE)
    assert h1s == ["Тестовая страница"]
    # The body h1 became an h2.
    assert re.search(r"^## Раздел$", md, re.MULTILINE)
    # Title is the first body line.
    assert md.splitlines()[0] == "# Тестовая страница"


# ---------------------------------------------------------------------------
# images / links
# ---------------------------------------------------------------------------


def test_attachment_image_and_refs():
    md, refs = _md_refs(
        '<p><ac:image ac:alt="карта">'
        '<ri:attachment ri:filename="map.png"/></ac:image></p>'
    )
    # Заметка лежит в `Confluence/DEV/`, вложения — в `Confluence/attachments/`.
    assert "![карта](../attachments/100/map.png)" in md
    assert refs == ["map.png"]


def test_external_image_url():
    md, refs = _md_refs(
        '<ac:image><ri:url ri:value="https://ex.ru/a.png"/></ac:image>'
    )
    assert "https://ex.ru/a.png" in md
    assert refs == []


def test_ri_page_link_resolved_when_in_crawl_set():
    md = _md(
        "<p>см "
        "<ac:link><ri:page ri:content-title=\"Целевая\" ri:space-key=\"DEV\"/>"
        "<ac:link-body>ссылка</ac:link-body></ac:link></p>",
        crawl_titles={"DEV::Целевая": "Confluence/DEV/Целевая.md"},
    )
    assert "[ссылка](Confluence/DEV/Целевая.md)" in md


def test_ri_page_link_plain_text_when_absent():
    md = _md(
        "<p>см "
        "<ac:link><ri:page ri:content-title=\"Нет\" ri:space-key=\"DEV\"/>"
        "<ac:link-body>ссылка</ac:link-body></ac:link></p>"
    )
    assert "ссылка" in md
    assert "](" not in md  # no link syntax emitted


def test_ri_attachment_link_and_ref():
    md, refs = _md_refs(
        "<p><ac:link>"
        '<ri:attachment ri:filename="doc.pdf"/>'
        "<ac:plain-text-link-body>Документ</ac:plain-text-link-body>"
        "</ac:link></p>"
    )
    assert "[Документ](../attachments/100/doc.pdf)" in md
    assert refs == ["doc.pdf"]


def test_attachment_href_is_relative_to_the_note_and_resolves_to_storage():
    """Путь вложения обязан разрешаться ИЗ каталога заметки в место, куда его кладёт sync."""
    page = _page(
        '<p><ac:image ac:alt="схема">'
        '<ri:attachment ri:filename="Схема потоков.png"/></ac:image></p>',
        ancestors=["OASIS External Home", "Продукты"],
        space="OASISEXT",
    )
    md, _refs = convert.storage_to_markdown(page)
    href = re.search(r"!\[схема\]\(([^)]+)\)", md).group(1)
    # Пробел в имени рвёт ссылку Markdown — он экранирован.
    assert " " not in href
    note_dir = convert.build_vault_path(page).rsplit("/", 1)[0]
    resolved = posixpath.normpath(f"{note_dir}/{urllib.parse.unquote(href)}")
    assert resolved == convert.attachment_vault_path("100", "Схема потоков.png")
    assert resolved == "Confluence/attachments/100/Схема потоков.png"


def test_sync_stores_attachments_where_the_converter_points():
    """У «куда положили» и «куда сослались» одно определение, а не две строки."""
    from app.confluence import sync

    assert sync.attachment_vault_path is convert.attachment_vault_path


# ---------------------------------------------------------------------------
# includes / jira / drop / unknown
# ---------------------------------------------------------------------------


def test_include_and_jira_placeholders():
    md = _md(
        '<ac:structured-macro ac:name="include">'
        '<ac:parameter ac:name="page"><ri:page ri:content-title="Общий"/></ac:parameter>'
        "</ac:structured-macro>"
    )
    assert "Включение:" in md and "Общий" in md

    md2 = _md(
        '<ac:structured-macro ac:name="jira">'
        '<ac:parameter ac:name="key">PROJ-42</ac:parameter>'
        "</ac:structured-macro>"
    )
    assert "JIRA: PROJ-42" in md2


def test_toc_and_pagetree_dropped():
    md = _md('<ac:structured-macro ac:name="toc"/><p>после</p>')
    assert "после" in md
    assert "toc" not in md.lower()

    md2 = _md('<ac:structured-macro ac:name="children"/><p>ниже</p>')
    assert md2.strip().endswith("ниже")


def test_unknown_macro_unwraps_body_and_logs_coverage(caplog):
    with caplog.at_level(logging.INFO, logger="cognivault.confluence.convert"):
        md = _md(
            '<ac:structured-macro ac:name="mystery">'
            "<ac:rich-text-body><p>сохранить это</p></ac:rich-text-body>"
            "</ac:structured-macro>"
        )
    assert "сохранить это" in md
    assert "mystery" in caplog.text


def test_unknown_macro_without_body_dropped():
    md = _md('<ac:structured-macro ac:name="widget"/><p>рядом</p>')
    assert "рядом" in md
    assert "widget" not in md


def test_markdown_macro_plain_body_survives_as_markup():
    """`markdown` кладёт HTML в plain-text-body — раньше страница-навигатор исчезала."""
    md = _md(
        '<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell>'
        '<ac:structured-macro ac:name="markdown" ac:schema-version="1">'
        "<ac:plain-text-body><![CDATA["
        '<div class="main"><img class="img-large" src="https://wiki.ru/шапка.png">'
        "<h2>Продуктовая витрина</h2>"
        '<div class="custom-block">'
        '<a href="https://wiki.ru/display/OASISEXT/Fincert-enricher">'
        "<div>Fincert-enricher</div></a></div>"
        '<div class="custom-block">'
        '<a href="https://wiki.ru/pages/viewpage.action?pageId=181">'
        "<div>Fincert. Сервис получения ФИДов</div></a></div>"
        "</div>]]></ac:plain-text-body></ac:structured-macro>"
        "</ac:layout-cell></ac:layout-section></ac:layout>"
    )
    assert "Продуктовая витрина" in md
    assert "Сервис получения ФИДов" in md
    # Разметка разобрана, а не выведена дословно: ссылки стали ссылками.
    assert "](https://wiki.ru/display/OASISEXT/Fincert-enricher)" in md
    assert "<div" not in md


def test_markdown_macro_css_payload_is_not_indexed():
    """Соседний макрос `markdown` часто несёт только `<style>` — это не текст страницы."""
    md = _md(
        '<ac:structured-macro ac:name="markdown">'
        "<ac:plain-text-body><![CDATA["
        "<style>.custom-block { box-shadow: 0 4px 10px rgba(0,0,0,0.3); }</style>"
        "<p>Видимый текст</p>]]></ac:plain-text-body></ac:structured-macro>"
    )
    assert "Видимый текст" in md
    assert "box-shadow" not in md and "custom-block" not in md


def test_unknown_macro_plain_body_kept_verbatim_not_parsed():
    """У НЕизвестного макроса plain-text-body — литеральный текст, а не разметка."""
    md = _md(
        '<ac:structured-macro ac:name="mystery-format">'
        "<ac:plain-text-body><![CDATA[если a < b и c > d, то <тег> не тег]]>"
        "</ac:plain-text-body></ac:structured-macro>"
    )
    assert "если a < b и c > d, то <тег> не тег" in md
    assert "```" in md


def test_ui_expand_title_becomes_bold_text():
    """Заголовок `ui-*` — якорь поиска; терять нельзя, но и НЕ заголовок.

    Жирный абзац остаётся в тексте чанка (плотный и лексический индекс видят
    его оба), а markdown-заголовок ломал бы дерево разделов — за `ui-expand`
    в 48% случаев по дампу идёт текст чужого раздела.
    """
    md = _md(
        '<ac:structured-macro ac:name="ui-expand">'
        '<ac:parameter ac:name="title">Логика окрашивания вершин потоков</ac:parameter>'
        "<ac:rich-text-body><p>Синий — поток работает стабильно</p>"
        "</ac:rich-text-body></ac:structured-macro>"
    )
    assert "**Логика окрашивания вершин потоков**" in md
    assert not re.search(
        r"^#{2,6} Логика окрашивания вершин потоков$", md, re.MULTILINE
    )
    assert "Синий — поток работает стабильно" in md


def test_view_file_emits_filename_and_records_ref():
    md, refs = _md_refs(
        '<ac:structured-macro ac:name="view-file">'
        '<ac:parameter ac:name="name">'
        '<ri:attachment ri:filename="Проблемы SAFP на 20250526.eml"/>'
        "</ac:parameter>"
        '<ac:parameter ac:name="height">250</ac:parameter>'
        "</ac:structured-macro>"
    )
    assert "Проблемы SAFP на 20250526.eml" in md
    assert refs == ["Проблемы SAFP на 20250526.eml"]


def test_drawio_sketch_named_like_plain_drawio():
    md = _md(
        '<ac:structured-macro ac:name="drawio-sketch">'
        '<ac:parameter ac:name="diagramName">ЖЦ модели</ac:parameter>'
        '<ac:parameter ac:name="revision">1</ac:parameter>'
        "</ac:structured-macro>"
    )
    assert "[Диаграмма: ЖЦ модели]" in md


def test_open_api_keeps_the_spec_url():
    """Спецификацию грузит JavaScript — адрес единственное, что есть в storage."""
    url = "https://apistudio.sigma.sbrf.ru/public/body/yml/a7118300-2057"
    md = _md(
        '<ac:structured-macro ac:name="open-api">'
        f'<ac:parameter ac:name="url">{url}</ac:parameter>'
        "</ac:structured-macro>"
    )
    assert url in md


def test_anchor_macro_leaves_no_text():
    """`anchor` в Confluence не рендерит ничего — его имя в индексе просто мусор."""
    md = _md(
        "<p>до</p>"
        '<ac:structured-macro ac:name="anchor">'
        '<ac:parameter ac:name="">перечень-правил</ac:parameter>'
        "</ac:structured-macro>"
        "<p>после</p>"
    )
    assert "до" in md and "после" in md
    assert "перечень-правил" not in md


# ---------------------------------------------------------------------------
# frontmatter / render_document round-trip
# ---------------------------------------------------------------------------


def test_frontmatter_keys_and_order():
    page = _page("<p>x</p>", ancestors=["A", "B"], labels=["l1"], version=7)
    fm = convert.build_frontmatter(page, "hash123")
    assert list(fm.keys()) == [
        "title",
        "source",
        "confluence_id",
        "space",
        "source_url",
        "version",
        "last_updated",
        "ancestors",
        "labels",
        "content_hash",
    ]
    assert fm["source"] == "confluence"
    assert fm["content_hash"] == "hash123"


def test_render_document_roundtrips_through_yaml():
    page = _page("<p>x</p>", ancestors=["Корень"], labels=["метка"], version=3)
    fm = convert.build_frontmatter(page, "abc123")
    doc = convert.render_document(fm, "# Тело\n\ntext\n")
    assert doc.startswith("---\n")
    _, block, rest = doc.split("---\n", 2)
    loaded = yaml.safe_load(block)
    assert loaded == fm
    assert rest.lstrip("\n").startswith("# Тело")


# ---------------------------------------------------------------------------
# safe_filename / collision_suffix / build_vault_path
# ---------------------------------------------------------------------------


def test_safe_filename_keeps_cyrillic():
    assert convert.safe_filename("Архитектура сервиса", "1") == "Архитектура сервиса"


def test_safe_filename_strips_leading_dots_and_forbidden():
    assert convert.safe_filename("...секрет", "1") == "секрет"
    assert convert.safe_filename('a/b:c*?"<>|#[]d', "1") == "abcd"


def test_safe_filename_truncates_over_100():
    out = convert.safe_filename("Я" * 150, "1")
    assert len(out) == 100
    assert set(out) == {"Я"}


def test_safe_filename_empty_falls_back_to_page_id():
    assert convert.safe_filename("   ", "555") == "page-555"
    assert convert.safe_filename("///", "555") == "page-555"


def test_collision_suffix_shape():
    out = convert.collision_suffix("Файл", "42")
    assert out == "Файл (id-42)"


def test_build_vault_path_with_ancestors():
    page = _page("<p>x</p>", space="DEV", ancestors=["Родитель", "Ребёнок"], title="Стр")
    assert convert.build_vault_path(page) == "Confluence/DEV/Родитель/Ребёнок/Стр.md"


def test_build_vault_path_empty_ancestors_collapses():
    page = _page("<p>x</p>", space="OPS", ancestors=[], title="Одна")
    assert convert.build_vault_path(page) == "Confluence/OPS/Одна.md"


def test_build_vault_path_sanitizes_segments():
    page = _page("<p>x</p>", space="A/B", ancestors=[".hidden"], title="T:t")
    assert convert.build_vault_path(page) == "Confluence/AB/hidden/Tt.md"


# ---------------------------------------------------------------------------
# whole-document smoke: everything composes
# ---------------------------------------------------------------------------


def test_full_document_composes_cleanly():
    body = (
        "<h1>Обзор</h1><p>Вводный текст.</p>"
        + CODE_MACRO
        + '<ac:structured-macro ac:name="warning">'
        "<ac:rich-text-body><p>Осторожно</p></ac:rich-text-body></ac:structured-macro>"
        "<table><tbody><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>b</td></tr></tbody></table>"
    )
    page = _page(body, title="Документ")
    md, refs = convert.storage_to_markdown(page)
    doc = convert.render_document(convert.build_frontmatter(page, "h"), md)
    # Front-matter parses, body present, no runaway blank lines.
    _, block, _rest = doc.split("---\n", 2)
    assert yaml.safe_load(block)["title"] == "Документ"
    assert md.splitlines()[0] == "# Документ"
    assert "```javascript" in md
    assert "> **Внимание:** Осторожно" in md
    assert "| K | V |" in md
    assert "\n\n\n" not in md
