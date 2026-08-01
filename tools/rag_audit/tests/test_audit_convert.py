"""Тесты измерительных функций `audit_convert`.

Проверяется именно ЛИНЕЙКА, а не конвертер: на синтетических кусочках
storage-формата, где ответ известен заранее, метрика обязана дать точное число.
Иначе аудит превращается в генератор правдоподобных цифр, и «стало лучше»
нечем отличить от «сломалась метрика».
"""

from __future__ import annotations

from bs4 import BeautifulSoup

from audit_convert import (
    audit_page,
    classify_macro,
    code_stats,
    extract_fences,
    image_stats,
    list_stats,
    macro_observations,
    markdown_visible_text,
    recall,
    reference_grid,
    storage_visible_text,
    table_stats,
    words,
)

# --- образцы storage-формата ------------------------------------------------

MERGED_TABLE = """
<table><tbody>
  <tr><th>Стенд</th><th colspan="2">Доступ</th></tr>
  <tr><td rowspan="2">ПСИ</td><td>логин</td><td>ivanov</td></tr>
  <tr><td>пароль</td><td>secret</td></tr>
</tbody></table>
"""

CODE_MACRO = """
<ac:structured-macro ac:name="code">
  <ac:parameter ac:name="language">py</ac:parameter>
  <ac:plain-text-body><![CDATA[def run(x):
    return x + 1]]></ac:plain-text-body>
</ac:structured-macro>
"""

PLAIN_BODY_UNKNOWN = """
<ac:structured-macro ac:name="markdown">
  <ac:plain-text-body><![CDATA[Реестр витрин обновляется еженедельно]]></ac:plain-text-body>
</ac:structured-macro>
"""

NESTED_LIST = """
<ul>
  <li>Первый
    <ul><li>Вложенный А</li><li>Вложенный Б</li></ul>
  </li>
  <li>Второй</li>
</ul>
"""


def _page(storage: str, **over) -> dict:
    page = {
        "id": "1",
        "title": "Проверка",
        "space": "ENG",
        "ancestors": [],
        "labels": [],
        "version": 1,
        "last_updated": "",
        "source_url": "",
        "storage": storage,
    }
    page.update(over)
    return page


def _convert(storage: str, **over) -> tuple[dict, str]:
    metrics, _path, document = audit_page(_page(storage, **over), {})
    body = document.split("---\n", 2)[-1]
    return metrics, body


# --- видимый текст и удержание ---------------------------------------------


def test_storage_text_keeps_plain_body_and_drops_macro_config():
    text = storage_visible_text(
        "<p>Видно</p>"
        '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter>'
        "</ac:structured-macro>"
        '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">sql</ac:parameter>'
        "<ac:plain-text-body><![CDATA[SELECT 1]]></ac:plain-text-body></ac:structured-macro>"
    )
    assert "Видно" in text
    assert "SELECT 1" in text
    assert "toc" not in text and "3" not in text  # навигация и конфиг не контент
    assert "sql" not in text


def test_rendered_plain_body_is_measured_as_text_not_as_html():
    # Payload макроса `markdown` Confluence рендерит — атрибуты стилей не контент.
    text = storage_visible_text(
        '<ac:structured-macro ac:name="markdown"><ac:plain-text-body>'
        '<![CDATA[<div style="padding: 0 10px"><b>Реестр витрин</b></div>]]>'
        "</ac:plain-text-body></ac:structured-macro>"
    )
    assert "Реестр витрин" in text
    assert "padding" not in text and "div" not in text


def test_storage_text_keeps_title_parameter():
    # `title` рендерится в выход (подпись панели/кода), значит это контент.
    text = storage_visible_text(
        '<ac:structured-macro ac:name="expand">'
        '<ac:parameter ac:name="title">Пример реквизитов</ac:parameter>'
        "<ac:rich-text-body><p>тело</p></ac:rich-text-body></ac:structured-macro>"
    )
    assert "Пример реквизитов" in text


def test_markdown_text_strips_markup_but_keeps_cells():
    text = markdown_visible_text("| Стенд | Хост |\n| --- | --- |\n| ПСИ | host1 |\n\n- **пункт**\n")
    assert "Стенд" in text and "ПСИ" in text and "пункт" in text
    assert "|" not in text and "--" not in text and "*" not in text


def test_markdown_text_keeps_snake_case_and_unescapes():
    # `_` — часть имени таблицы, а не разметка; `\_` — экранирование markdownify.
    text = markdown_visible_text("Таблица afpc\\_sss\\_inc.cards\\_event и *акцент*\n")
    assert "afpc_sss_inc.cards_event" in text
    assert "акцент" in text and "*" not in text


def test_recall_is_multiset_and_ignores_added_text():
    src = words("альфа бета бета")
    assert recall(src, words("альфа бета бета гамма гамма")) == 1.0
    assert recall(src, words("альфа бета")) == 2 / 3
    assert recall(src, words("")) == 0.0
    # Дублирование (раскрытие rowspan) не поднимает долю выше единицы.
    assert recall(words("альфа"), words("альфа альфа альфа")) == 1.0


# --- макросы ----------------------------------------------------------------


def test_classify_macro():
    assert classify_macro("code") == "handled"
    assert classify_macro("warning") == "handled"  # из _PANEL_LABELS
    assert classify_macro("toc") == "dropped"
    assert classify_macro("markdown") == "unknown"


def test_unknown_macro_with_plain_text_body_is_measured_as_content():
    """`plain-text-body` незнакомого макроса аудит считает содержимым и видит его в выходе.

    Тест раньше фиксировал потерю (`survival == 0`): `_handle_unknown_macro`
    искал только `rich-text-body`, и страница из одного макроса `markdown`
    схлопывалась в заголовок. Конвертер это чинит, и мерить теперь надо, что
    текст ДОШЁЛ, — сама метрика (эталон = видимый текст payload'а) не менялась.
    """
    metrics, body = _convert(PLAIN_BODY_UNKNOWN)
    observed = metrics["macros"][0]
    assert observed["kind"] == "unknown"
    assert observed["body_kind"] == "plain-text-body"
    assert observed["survival"] == 1.0
    assert "Реестр витрин" in body
    assert metrics["recall"] == 1.0


def test_unknown_macro_with_rich_text_body_survives():
    storage = (
        '<ac:structured-macro ac:name="ui-expand">'
        '<ac:parameter ac:name="title">Заголовок секции</ac:parameter>'
        "<ac:rich-text-body><p>Содержимое секции</p></ac:rich-text-body>"
        "</ac:structured-macro>"
    )
    metrics, body = _convert(storage)
    observed = metrics["macros"][0]
    assert observed["kind"] == "unknown"
    assert observed["survival"] == 1.0
    assert "Содержимое секции" in body
    # Заголовок макроса аудит считает содержимым (`_CONTENT_PARAMS`), и он тоже
    # доходит: раньше здесь фиксировалась его потеря у всех `ui-*` макросов.
    assert "Заголовок секции" in body


def test_macro_observations_attribute_body_to_the_owning_macro():
    storage = (
        '<ac:structured-macro ac:name="ui-expand"><ac:rich-text-body>'
        '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>внутри</p>'
        "</ac:rich-text-body></ac:structured-macro>"
        "</ac:rich-text-body></ac:structured-macro>"
    )
    observed = {o["name"]: o for o in macro_observations(storage, words("внутри"))}
    assert observed["info"]["body_words"] == 1
    assert observed["ui-expand"]["body_words"] == 1  # текст ребёнка виден и снаружи
    assert len(macro_observations(storage, words(""))) == 2


# --- таблицы ----------------------------------------------------------------


def test_reference_grid_expands_colspan_and_rowspan():
    table = BeautifulSoup(MERGED_TABLE, "html.parser").find("table")
    assert reference_grid(table) == [
        ["Стенд", "Доступ", "Доступ"],
        ["ПСИ", "логин", "ivanov"],
        ["ПСИ", "пароль", "secret"],
    ]


def test_merged_cells_land_where_expected():
    stats = table_stats(MERGED_TABLE, "", "1")
    assert stats["tables_in"] == 1
    assert stats["tables_merged_in"] == 1
    detail = stats["details"][0]
    assert detail["cells_in"] == detail["cells_out"] == 9
    assert detail["cells_matched"] == detail["cells_compared"] == 9
    assert detail["rectangular_out"] is True


def test_merged_table_reaches_markdown_as_gfm():
    _metrics, body = _convert(MERGED_TABLE)
    assert "| Стенд | Доступ | Доступ |" in body
    assert "| ПСИ | логин | ivanov |" in body
    assert "| ПСИ | пароль | secret |" in body


def test_table_notices_are_counted():
    md = (
        "**Таблица (часть 1 из 2)**\n\n| a |\n| --- |\n| 1 |\n\n"
        "**Таблица (часть 2 из 2)**\n\n| a |\n| --- |\n| 2 |\n\n"
        "*[Таблица обрезана: пропущено строк — 7.]*\n"
    )
    stats = table_stats("", md, "1")
    assert stats["split_notices"] == 2
    assert stats["truncation_notices"] == 1
    assert stats["gfm_tables_out"] == 2


def test_escaped_pipe_is_not_a_column_separator():
    stats = table_stats("", "| a | b |\n| --- | --- |\n| x \\| y | z |\n", "1")
    assert stats["gfm_cells_out"] == 4  # две строки по две ячейки


# --- код --------------------------------------------------------------------


def test_code_macro_round_trips_byte_for_byte_with_mapped_language():
    metrics, body = _convert(CODE_MACRO)
    assert "```python\ndef run(x):\n    return x + 1\n```" in body
    result = metrics["code"]["results"][0]
    assert result["status"] == "exact"
    assert result["want_lang"] == "python" and result["got_lang"] == "python"
    assert result["lang_ok"] is True


def test_code_stats_flags_a_lost_block():
    stats = code_stats(CODE_MACRO, "# Заголовок\n\nникакого кода тут нет\n")
    assert stats["results"][0]["status"] == "missing"


def test_extract_fences_handles_backticks_inside_payload():
    blocks = extract_fences("```sql\nSELECT `col`\n```\n\ntext\n\n```\nplain\n```\n")
    assert [b["lang"] for b in blocks] == ["sql", ""]
    assert blocks[0]["payload"] == "SELECT `col`"


def test_code_in_table_cell_survives_byte_exact():
    # Раньше код внутри ячейки втягивался в неё простым текстом (status
    # "inlined") и терял ограждение вместе с языком — на корпусе так пропадала
    # половина JSON-блоков. Теперь таблица с блочным кодом раскладывается
    # построчно, а код выводится настоящим огороженным блоком.
    storage = f"<table><tbody><tr><td>Запрос</td><td>{CODE_MACRO}</td></tr></tbody></table>"
    metrics, _body = _convert(storage)
    assert metrics["code"]["results"][0]["status"] == "exact"


# --- списки -----------------------------------------------------------------


def test_nested_list_keeps_items_and_depth():
    metrics, body = _convert(NESTED_LIST)
    lists = metrics["lists"]
    assert lists["li_in"] == 4
    assert lists["depth_in"] == 2
    assert lists["list_lines_out"] == 4
    assert lists["depth_out"] == 2  # два разных уровня отступа
    assert "Вложенный А" in body


def test_list_items_inside_tables_are_counted_apart():
    storage = f"<table><tbody><tr><td>{NESTED_LIST}</td></tr></tbody></table>"
    stats = list_stats(storage, "")
    assert stats["li_in"] == 4
    assert stats["li_in_tables"] == 4
    assert stats["li_outside_tables"] == 0


def test_dropped_macro_items_do_not_count_as_lost():
    storage = f'<ac:structured-macro ac:name="pagetree">{NESTED_LIST}</ac:structured-macro>'
    assert list_stats(storage, "")["li_in"] == 0


# --- вложения ---------------------------------------------------------------


def test_attachment_links_do_not_resolve_from_a_nested_note():
    stats = image_stats(
        '<ac:image><ri:attachment ri:filename="schema.png"></ri:attachment></ac:image>',
        "Confluence/ENG/Раздел/Заметка.md",
        "42",
        "![](attachments/42/schema.png)",
    )
    assert stats["images_in"] == 1
    assert stats["links_broken"] == 1
    assert stats["links_resolvable"] == 0
    assert stats["md_image_refs"] == 1


def test_external_image_is_not_counted_as_broken():
    stats = image_stats(
        '<ac:image><ri:url ri:value="https://example/x.png"></ri:url></ac:image>',
        "Confluence/ENG/Заметка.md",
        "42",
        "",
    )
    assert stats["images_external"] == 1
    assert stats["links_broken"] == 0
