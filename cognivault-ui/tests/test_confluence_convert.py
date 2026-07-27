"""Golden-style tests for the Confluence storage -> Markdown pipeline.

Pure/offline. Run with: ``pytest tests/test_confluence_convert.py``
"""

from __future__ import annotations

import logging
import os
import re
import sys

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


def test_expand_becomes_heading_plus_body():
    md = _md(
        '<ac:structured-macro ac:name="expand">'
        '<ac:parameter ac:name="title">Детали</ac:parameter>'
        "<ac:rich-text-body><p>скрытый текст</p></ac:rich-text-body>"
        "</ac:structured-macro>"
    )
    assert re.search(r"^#+\s+Детали$", md, re.MULTILINE)
    assert "скрытый текст" in md
    assert "<details>" not in md


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


def test_table_split_repeats_header_each_part():
    rows = "".join(
        f"<tr><td>значение ячейки номер {i} с длинным текстом</td>"
        f"<td>второй столбец данных номер {i}</td></tr>"
        for i in range(30)
    )
    md = _md(
        "<table><tbody>"
        "<tr><th>Колонка А</th><th>Колонка Б</th></tr>"
        f"{rows}</tbody></table>"
    )
    # More than one part, each labelled and each repeating the header row.
    assert md.count("| Колонка А | Колонка Б |") >= 2
    assert "часть 1 из" in md
    assert "часть 2 из" in md
    # Every part is a complete GFM table (header + separator).
    assert md.count("| --- | --- |") == md.count("| Колонка А | Колонка Б |")


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
    assert "![карта](attachments/100/map.png)" in md
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
    assert "[Документ](attachments/100/doc.pdf)" in md
    assert refs == ["doc.pdf"]


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
