"""Confluence Storage Format (XHTML) -> Markdown conversion pipeline.

Pure, fully offline functions. Given a *Page dict* fetched from Confluence
(see the input contract below) this module produces a Markdown document with
YAML front-matter that gray-matter / ``yaml.safe_load`` can parse back.

Input contract -- a Page dict::

    {
      "id": str, "title": str, "space": str,   # space = space key
      "version": int, "last_updated": str,      # ISO8601
      "ancestors": [str, ...],                   # ancestor TITLES root-first
      "labels": [str, ...],
      "body_storage": str,                       # raw Storage Format XHTML
      "source_url": str,
    }

Pipeline (two-stage + post):

* **Stage A** -- normalize the Storage-Format soup: code / panels / expand /
  status / includes / images / links / layouts / tables become plain HTML or
  opaque placeholders.  Verbatim code and fully-rendered tables are stashed in
  a placeholder map so they never pass through the HTML text pipeline (which
  would entity-encode ``<``, ``&``, ``>`` -- the classic bug).
* **Stage B** -- a :class:`markdownify.MarkdownConverter` turns the normalized
  soup into Markdown.
* **Stage C** -- restore placeholders, demote headings + prepend the title as
  the sole ``# H1``, and normalize characters (outside code / tables).
"""

from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any

import yaml
from bs4 import BeautifulSoup, CData, NavigableString, Tag
from markdownify import MarkdownConverter

logger = logging.getLogger("cognivault.confluence.convert")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Private-use sentinel delimiters -- never appear in real corporate documents,
# survive markdownify unescaped, and are left untouched by NFC / zero-width
# normalization (which only targets specific code points).
_PH_OPEN = "\ue000"
_PH_CLOSE = "\ue001"
_PH_RE = re.compile(_PH_OPEN + r"PH\d+" + _PH_CLOSE)

# Table sizing heuristics (Russian headroom: ~3 chars / token).
_CHARS_PER_TOKEN = 3
_MAX_TABLE_TOKENS = 350
_WIDE_TABLE_COLS = 8
_WIDE_CELL_CHARS = 200

_FILENAME_MAX = 100

# Forbidden characters for filenames / path segments.
_FORBIDDEN_RE = re.compile(r'[/\\:*?"<>|#\[\]]')

# Zero-width / BOM characters to strip during normalization.
_ZERO_WIDTH_RE = re.compile("[\u200b\u200c\u200d\ufeff\u2060]")

# Russian panel labels.
_PANEL_LABELS = {
    "warning": "Внимание",
    "note": "Примечание",
    "tip": "Совет",
    "info": "Информация",
    "panel": "Панель",
}

# Confluence code-macro "brush" language -> Markdown fence language.
_LANG_MAP = {
    "js": "javascript",
    "jscript": "javascript",
    "javascript": "javascript",
    "ts": "typescript",
    "typescript": "typescript",
    "py": "python",
    "python": "python",
    "sh": "bash",
    "shell": "bash",
    "bash": "bash",
    "zsh": "bash",
    "sql": "sql",
    "java": "java",
    "c": "c",
    "cpp": "cpp",
    "c++": "cpp",
    "cs": "csharp",
    "csharp": "csharp",
    "c#": "csharp",
    "go": "go",
    "golang": "go",
    "rb": "ruby",
    "ruby": "ruby",
    "php": "php",
    "xml": "xml",
    "html": "html",
    "xhtml": "html",
    "css": "css",
    "json": "json",
    "yaml": "yaml",
    "yml": "yaml",
    "kotlin": "kotlin",
    "kt": "kotlin",
    "scala": "scala",
    "rust": "rust",
    "rs": "rust",
    "powershell": "powershell",
    "ps": "powershell",
    "text": "",
    "none": "",
    "plain": "",
}

# Macro names dropped entirely (navigation / dynamic content).
_DROP_MACROS = {"toc", "pagetree", "children", "contentbylabel", "recently-updated"}


# ===========================================================================
# Public: filename / path helpers
# ===========================================================================


def safe_filename(title: str, page_id: str) -> str:
    """NFC-normalize a page title into a safe ``.md`` stem (no extension).

    Strips forbidden / control characters and leading dots (server dotfile
    guard), collapses whitespace, caps to ~100 characters (keeping Cyrillic),
    and falls back to ``page-{id}`` when nothing usable remains.
    """
    stem = _sanitize(title or "")
    if len(stem) > _FILENAME_MAX:
        stem = stem[:_FILENAME_MAX].rstrip()
        # A trailing dot after truncation would re-introduce a hidden segment.
        stem = stem.rstrip(".").rstrip()
    if not stem:
        return f"page-{page_id}"
    return stem


def collision_suffix(title: str, page_id: str) -> str:
    """Return the collision-disambiguated filename stem: ``<name> (id-<id>)``.

    Callers use this only when two pages would otherwise collide on
    :func:`safe_filename`.
    """
    return f"{safe_filename(title, page_id)} (id-{page_id})"


def build_vault_path(page: dict) -> str:
    """Build the relative vault path for a page.

    ``Confluence/<space>/<anc1>/<anc2>/<Title>.md`` -- every segment sanitized,
    an empty ancestor list collapses cleanly (no doubled slashes).
    """
    segments = ["Confluence", _safe_segment(page.get("space", ""))]
    for ancestor in page.get("ancestors") or []:
        seg = _safe_segment(ancestor)
        if seg:
            segments.append(seg)
    segments.append(safe_filename(page.get("title", ""), page.get("id", "")) + ".md")
    return "/".join(segments)


# ===========================================================================
# Public: front-matter / document rendering
# ===========================================================================


def build_frontmatter(page: dict, content_hash: str) -> dict:
    """Build the ordered front-matter mapping for a page.

    Key order is preserved for stable, diff-friendly output.
    """
    return {
        "title": page.get("title", ""),
        "source": "confluence",
        "confluence_id": page.get("id", ""),
        "space": page.get("space", ""),
        "source_url": page.get("source_url", ""),
        "version": page.get("version", 0),
        "last_updated": page.get("last_updated", ""),
        "ancestors": list(page.get("ancestors") or []),
        "labels": list(page.get("labels") or []),
        "content_hash": content_hash,
    }


def render_document(frontmatter: dict, body: str) -> str:
    """Render a full Markdown document: YAML front-matter block + body.

    The block round-trips through ``yaml.safe_load`` (gray-matter compatible).
    """
    dumped = yaml.safe_dump(frontmatter, allow_unicode=True, sort_keys=False)
    return "---\n" + dumped + "---\n\n" + body


# ===========================================================================
# Public: the conversion entry point
# ===========================================================================


def storage_to_markdown(
    page: dict,
    crawl_titles: dict[str, str] | None = None,
    attachment_names: set[str] | None = None,
) -> tuple[str, list[str]]:
    """Convert a page's Storage-Format body to a Markdown body.

    Returns ``(markdown_body, referenced_attachment_filenames)``.

    * ``crawl_titles`` maps ``"<SPACE>::<title>"`` -> relative vault path, used
      to resolve internal ``ri:page`` links; unknown targets become plain text.
    * ``attachment_names`` -- filenames known to exist on the page (currently
      advisory; all referenced attachments are still recorded).
    """
    crawl_titles = crawl_titles or {}
    attachment_names = attachment_names or set()

    page_id = str(page.get("id", ""))
    space = str(page.get("space", ""))
    title = str(page.get("title", ""))

    soup = BeautifulSoup(page.get("body_storage") or "", "html.parser")

    ctx = _Context(
        page_id=page_id,
        space=space,
        crawl_titles=crawl_titles,
        attachment_names=attachment_names,
    )

    # --- Stage A: normalize the storage soup -------------------------------
    _transform_macros(soup, ctx)
    _transform_images(soup, ctx)
    _transform_links(soup, ctx)
    _unwrap_layouts(soup)
    _transform_tables(soup, ctx)
    _cleanup(soup)

    # --- Stage B: soup -> Markdown -----------------------------------------
    converter = _StorageConverter(
        heading_style="ATX",
        bullets="-",
        strong_em_symbol="*",
    )
    body_md = converter.convert_soup(soup)

    # --- Stage C: post-process ---------------------------------------------
    body_md = _postprocess(body_md, title, ctx.placeholders)

    if ctx.coverage:
        logger.info(
            "confluence page %s: unhandled macros unwrapped/dropped: %s",
            page_id,
            ", ".join(ctx.coverage),
        )

    return body_md, ctx.refs


# ===========================================================================
# Internal state
# ===========================================================================


class _Context:
    """Mutable per-page conversion state threaded through Stage A."""

    def __init__(
        self,
        page_id: str,
        space: str,
        crawl_titles: dict[str, str],
        attachment_names: set[str],
    ) -> None:
        self.page_id = page_id
        self.space = space
        self.crawl_titles = crawl_titles
        self.attachment_names = attachment_names
        self.placeholders: dict[str, tuple[str, Any]] = {}
        self.refs: list[str] = []
        self._seen_refs: set[str] = set()
        self.coverage: list[str] = []
        self._counter = 0

    def add_placeholder(self, kind: str, payload: Any) -> str:
        key = f"{_PH_OPEN}PH{self._counter}{_PH_CLOSE}"
        self._counter += 1
        self.placeholders[key] = (kind, payload)
        return key

    def record_ref(self, filename: str) -> None:
        if filename and filename not in self._seen_refs:
            self._seen_refs.add(filename)
            self.refs.append(filename)


# ===========================================================================
# Stage A helpers
# ===========================================================================


def _param(macro: Tag, name: str) -> str | None:
    """Read an ``<ac:parameter ac:name="...">value</>`` from a macro."""
    for p in macro.find_all("ac:parameter", recursive=True):
        if p.get("ac:name") == name and p.find_parent("ac:structured-macro") is macro:
            return p.get_text()
    # Fallback: direct children only.
    for p in macro.find_all("ac:parameter", recursive=False):
        if p.get("ac:name") == name:
            return p.get_text()
    return None


def _new_tag(soup_or_tag: Tag, name: str) -> Tag:
    root = soup_or_tag
    while root.parent is not None:
        root = root.parent
    if isinstance(root, BeautifulSoup):
        return root.new_tag(name)
    # Fallback: build a fresh soup tag.
    return BeautifulSoup("", "html.parser").new_tag(name)


def _transform_macros(soup: BeautifulSoup, ctx: _Context) -> None:
    """Dispatch every ``<ac:structured-macro>`` by name, innermost-first."""
    macros = soup.find_all("ac:structured-macro")
    # Deepest first so a transformed child is never moved before it is handled.
    macros.sort(key=lambda m: len(list(m.parents)), reverse=True)
    for macro in macros:
        if macro.parent is None:  # already detached by an ancestor transform
            continue
        name = (macro.get("ac:name") or "").lower()
        if name in ("code", "noformat"):
            _handle_code(macro, ctx, no_lang=(name == "noformat"))
        elif name in _PANEL_LABELS:
            _handle_panel(macro, name)
        elif name == "expand":
            _handle_expand(macro)
        elif name == "status":
            _handle_status(macro)
        elif name in ("include", "excerpt-include"):
            _handle_include(macro)
        elif name == "jira":
            _handle_jira(macro)
        elif name in ("drawio", "gliffy", "chart"):
            _handle_diagram(macro)
        elif name in _DROP_MACROS:
            macro.decompose()
        else:
            _handle_unknown_macro(macro, ctx)


def _handle_code(macro: Tag, ctx: _Context, no_lang: bool) -> None:
    body = macro.find("ac:plain-text-body")
    code_text = _cdata_text(body) if body else ""
    lang = ""
    if not no_lang:
        raw = (_param(macro, "language") or "").strip().lower()
        lang = _LANG_MAP.get(raw, raw)
    key = ctx.add_placeholder("code", (lang, code_text))

    title = (_param(macro, "title") or "").strip()
    ph = _new_tag(macro, "p")
    ph.string = key
    if title:
        cap = _new_tag(macro, "p")
        strong = _new_tag(macro, "strong")
        strong.string = title
        cap.append(strong)
        macro.insert_before(cap)
    macro.replace_with(ph)


def _cdata_text(body: Tag) -> str:
    """Extract verbatim text from an ``<ac:plain-text-body>`` (CDATA-aware)."""
    parts: list[str] = []
    for child in body.contents:
        if isinstance(child, (CData, NavigableString)):
            parts.append(str(child))
        else:
            parts.append(child.get_text())
    return "".join(parts)


def _handle_panel(macro: Tag, name: str) -> None:
    if name == "panel":
        label = (_param(macro, "title") or "").strip() or _PANEL_LABELS["panel"]
    else:
        label = _PANEL_LABELS[name]

    bq = _new_tag(macro, "blockquote")
    bq["data-panel"] = name

    body = macro.find("ac:rich-text-body")
    strong = _new_tag(macro, "strong")
    strong.string = f"{label}:"

    if body is not None:
        first_p = body.find("p", recursive=False)
        if first_p is not None:
            first_p.insert(0, " ")
            first_p.insert(0, strong)
        else:
            lead = _new_tag(macro, "p")
            lead.append(strong)
            body.insert(0, lead)
        for child in list(body.children):
            bq.append(child.extract())
    else:
        lead = _new_tag(macro, "p")
        lead.append(strong)
        bq.append(lead)

    macro.replace_with(bq)


def _handle_expand(macro: Tag) -> None:
    title = (_param(macro, "title") or "").strip() or "Подробнее"
    heading = _new_tag(macro, "h3")
    heading.string = title
    macro.insert_before(heading)
    body = macro.find("ac:rich-text-body")
    if body is not None:
        for child in list(body.children):
            macro.insert_before(child.extract())
    macro.decompose()


def _handle_status(macro: Tag) -> None:
    title = (_param(macro, "title") or "").strip()
    strong = _new_tag(macro, "strong")
    strong.string = f"[{title}]"
    macro.replace_with(strong)


def _placeholder_line(macro: Tag, text: str) -> None:
    p = _new_tag(macro, "p")
    em = _new_tag(macro, "em")
    em.string = text
    p.append(em)
    macro.replace_with(p)


def _handle_include(macro: Tag) -> None:
    page_ref = macro.find("ri:page")
    name = ""
    if page_ref is not None:
        name = (page_ref.get("ri:content-title") or "").strip()
    _placeholder_line(macro, f"[Включение: {name or 'страница'}]")


def _handle_jira(macro: Tag) -> None:
    key = (_param(macro, "key") or _param(macro, "jqlQuery") or "").strip()
    _placeholder_line(macro, f"[JIRA: {key or '—'}]")


def _handle_diagram(macro: Tag) -> None:
    name = (
        _param(macro, "diagramName")
        or _param(macro, "name")
        or _param(macro, "title")
        or ""
    ).strip()
    label = f"[Диаграмма: {name}]" if name else "[Диаграмма]"
    _placeholder_line(macro, label)


def _handle_unknown_macro(macro: Tag, ctx: _Context) -> None:
    name = (macro.get("ac:name") or "unknown").lower()
    ctx.coverage.append(name)
    body = macro.find("ac:rich-text-body")
    if body is not None:
        for child in list(body.children):
            macro.insert_before(child.extract())
    macro.decompose()


def _transform_images(soup: BeautifulSoup, ctx: _Context) -> None:
    for emo in soup.find_all("ac:emoticon"):
        emo.decompose()
    for image in soup.find_all("ac:image"):
        alt = image.get("ac:alt") or image.get("ac:title") or ""
        att = image.find("ri:attachment")
        url = image.find("ri:url")
        if att is not None:
            filename = att.get("ri:filename") or ""
            if not filename:
                image.decompose()
                continue
            ctx.record_ref(filename)
            img = _new_tag(image, "img")
            img["src"] = f"attachments/{ctx.page_id}/{filename}"
            img["alt"] = alt
            image.replace_with(img)
        elif url is not None:
            img = _new_tag(image, "img")
            img["src"] = url.get("ri:value") or ""
            img["alt"] = alt
            image.replace_with(img)
        else:
            image.decompose()


def _transform_links(soup: BeautifulSoup, ctx: _Context) -> None:
    for link in soup.find_all("ac:link"):
        body_el = link.find("ac:link-body") or link.find("ac:plain-text-link-body")
        anchor_text = body_el.get_text().strip() if body_el is not None else ""

        page_ref = link.find("ri:page")
        att_ref = link.find("ri:attachment")
        same_anchor = link.get("ac:anchor")

        if page_ref is not None:
            title = (page_ref.get("ri:content-title") or "").strip()
            space = (page_ref.get("ri:space-key") or ctx.space).strip()
            text = anchor_text or title
            target = ctx.crawl_titles.get(f"{space}::{title}")
            if target:
                a = _new_tag(link, "a")
                a["href"] = target
                a.string = text
                link.replace_with(a)
            else:
                link.replace_with(NavigableString(text))
        elif att_ref is not None:
            filename = att_ref.get("ri:filename") or ""
            text = anchor_text or filename
            if filename:
                ctx.record_ref(filename)
                a = _new_tag(link, "a")
                a["href"] = f"attachments/{ctx.page_id}/{filename}"
                a.string = text
                link.replace_with(a)
            else:
                link.replace_with(NavigableString(text))
        elif same_anchor:
            link.replace_with(NavigableString(anchor_text or str(same_anchor)))
        else:
            link.replace_with(NavigableString(anchor_text))


def _unwrap_layouts(soup: BeautifulSoup) -> None:
    for name in ("ac:layout-cell", "ac:layout-section", "ac:layout"):
        for el in soup.find_all(name):
            el.unwrap()


def _cleanup(soup: BeautifulSoup) -> None:
    for p in soup.find_all("p"):
        if not p.get_text(strip=True) and not p.find(["img"]):
            p.decompose()


# ===========================================================================
# Stage A: table transformer
# ===========================================================================


def _transform_tables(soup: BeautifulSoup, ctx: _Context) -> None:
    """Replace every ``<table>`` with a rendered-Markdown placeholder.

    Processes leaf tables first so a nested table (inside a ``<td>``/``<th>``)
    is flattened to inline text before its parent table is emitted.
    """
    guard = 0
    while True:
        guard += 1
        if guard > 1000:  # pathological nesting guard
            break
        tables = soup.find_all("table")
        leaves = [t for t in tables if t.find("table") is None]
        if not leaves:
            break
        for table in leaves:
            if table.find_parent(["td", "th"]) is not None:
                _flatten_nested_table(table, ctx)
            else:
                _emit_table(table, ctx)


def _flatten_nested_table(table: Tag, ctx: _Context) -> None:
    header, body_rows, _caption = _grid_to_rows(table, ctx)
    cells: list[str] = []
    for row in [header, *body_rows]:
        cells.extend(c for c in row if c)
    text = "«" + "; ".join(cells) + "»"
    table.replace_with(NavigableString(text))


def _emit_table(table: Tag, ctx: _Context) -> None:
    header, body_rows, caption = _grid_to_rows(table, ctx)
    md = _render_table(header, body_rows, caption)
    key = ctx.add_placeholder("table", md)
    ph = _new_tag(table, "p")
    ph.string = key
    table.replace_with(ph)


def _grid_to_rows(
    table: Tag, ctx: _Context
) -> tuple[list[str], list[list[str]], str]:
    """Expand rowspan/colspan into a full grid and return (header, body, caption)."""
    caption_el = table.find("caption", recursive=False)
    caption = _cell_text(caption_el, ctx) if caption_el is not None else ""

    trs = _direct_rows(table)

    # Parse each source row into (content_cell, colspan, rowspan, is_header).
    parsed: list[list[tuple[Tag, int, int, bool]]] = []
    header_index = None
    for idx, tr in enumerate(trs):
        cells = [c for c in tr.find_all(["td", "th"], recursive=False)]
        if not cells:
            continue
        row = []
        all_th = True
        for cell in cells:
            colspan = _int_attr(cell, "colspan", 1)
            rowspan = _int_attr(cell, "rowspan", 1)
            is_th = cell.name == "th"
            all_th = all_th and is_th
            row.append((cell, colspan, rowspan, is_th))
        parsed.append(row)
        if all_th and header_index is None:
            header_index = len(parsed) - 1

    if not parsed:
        return [], [], caption

    grid = _expand_spans(parsed, ctx)

    if header_index is None:
        header_index = 0
    header = grid[header_index]
    body = [r for i, r in enumerate(grid) if i != header_index]

    # Normalize width across the whole grid.
    width = max((len(r) for r in grid), default=0)
    header = header + [""] * (width - len(header))
    body = [r + [""] * (width - len(r)) for r in body]
    return header, body, caption


def _direct_rows(table: Tag) -> list[Tag]:
    """Direct ``<tr>`` of a table (through an optional thead/tbody/tfoot)."""
    rows: list[Tag] = []
    for child in table.children:
        if not isinstance(child, Tag):
            continue
        if child.name == "tr":
            rows.append(child)
        elif child.name in ("thead", "tbody", "tfoot"):
            rows.extend(tr for tr in child.children if isinstance(tr, Tag) and tr.name == "tr")
    return rows


def _int_attr(cell: Tag, name: str, default: int) -> int:
    try:
        val = int(str(cell.get(name, default)).strip())
        return val if val >= 1 else default
    except (TypeError, ValueError):
        return default


def _expand_spans(
    parsed: list[list[tuple[Tag, int, int, bool]]], ctx: _Context
) -> list[list[str]]:
    """Duplicate rowspan/colspan values so every emitted row is self-contained.

    ``pending`` maps a column index to ``(text, remaining_rows)`` for an active
    rowspan carried down from an earlier row.  Ragged spans (exceeding the
    remaining columns/rows) are simply clamped by construction -- never crash.
    """
    grid: list[list[str]] = []
    pending: dict[int, tuple[str, int]] = {}

    for row_cells in parsed:
        out: list[str] = []
        col = 0
        ci = 0
        while ci < len(row_cells) or pending:
            if col in pending:
                text, rem = pending[col]
                out.append(text)
                if rem - 1 > 0:
                    pending[col] = (text, rem - 1)
                else:
                    del pending[col]
                col += 1
                continue
            if ci < len(row_cells):
                cell, colspan, rowspan, _is_th = row_cells[ci]
                ci += 1
                text = _cell_text(cell, ctx)
                for _ in range(colspan):
                    out.append(text)
                    if rowspan > 1:
                        pending[col] = (text, rowspan - 1)
                    col += 1
                continue
            # No source cell here, but a rowspan may resume at a later column.
            future = [c for c in pending if c >= col]
            if future:
                nxt = min(future)
                while col < nxt:
                    out.append("")
                    col += 1
                continue
            break
        grid.append(out)

    return grid


# ---- table cell rendering --------------------------------------------------


def _cell_text(cell: Tag | None, ctx: _Context) -> str:
    """Render a table cell's inline content to a single Markdown string."""
    if cell is None:
        return ""
    raw = _inline_render(cell, ctx)
    raw = _restore_inline_placeholders(raw, ctx.placeholders)
    # Collapse whitespace but preserve explicit <br> breaks.
    raw = raw.replace("\xa0", " ")
    raw = _ZERO_WIDTH_RE.sub("", raw)
    raw = re.sub(r"[ \t\r\n]+", " ", raw)
    raw = re.sub(r"(?:\s*<br>\s*)+", "<br>", raw)
    raw = raw.strip()
    raw = re.sub(r"^(?:<br>)+", "", raw)
    raw = re.sub(r"(?:<br>)+$", "", raw)
    raw = raw.replace("|", r"\|")
    return raw.strip()


def _inline_render(node: Tag, ctx: _Context) -> str:
    out: list[str] = []
    for child in node.children:
        if isinstance(child, NavigableString):
            out.append(str(child))
            continue
        name = child.name
        if name in ("strong", "b"):
            inner = _inline_render(child, ctx).strip()
            out.append(f"**{inner}**" if inner else "")
        elif name in ("em", "i"):
            inner = _inline_render(child, ctx).strip()
            out.append(f"*{inner}*" if inner else "")
        elif name == "code":
            out.append(f"`{child.get_text()}`")
        elif name == "a":
            inner = _inline_render(child, ctx).strip() or child.get_text().strip()
            href = child.get("href", "")
            out.append(f"[{inner}]({href})" if href else inner)
        elif name == "br":
            out.append("<br>")
        elif name == "img":
            out.append(f"![{child.get('alt', '')}]({child.get('src', '')})")
        elif name in ("p", "div", "li"):
            inner = _inline_render(child, ctx).strip()
            if inner:
                out.append(inner + "<br>")
        elif name in ("ul", "ol"):
            out.append(_inline_render(child, ctx))
        else:
            out.append(_inline_render(child, ctx))
    return "".join(out)


def _restore_inline_placeholders(text: str, placeholders: dict) -> str:
    """Inline-restore code/literal placeholders that landed inside a table cell."""

    def repl(match: re.Match) -> str:
        entry = placeholders.get(match.group(0))
        if not entry:
            return ""
        kind, payload = entry
        if kind == "code":
            _lang, code = payload
            return "`" + re.sub(r"\s+", " ", code).strip() + "`"
        if kind == "literal":
            return str(payload)
        if kind == "table":
            return str(payload)
        return ""

    return _PH_RE.sub(repl, text)


# ---- table Markdown emission ----------------------------------------------


def _render_table(header: list[str], body: list[list[str]], caption: str) -> str:
    if not header and not body:
        return ""
    ncol = len(header)

    if _is_wide(header, body):
        return _linearize_table(header, body, caption)

    full = _gfm_table(header, body)
    if _est_tokens(full) <= _MAX_TABLE_TOKENS:
        if caption:
            return f"**Таблица: {caption}**\n\n{full}"
        return full

    # Split into complete sub-tables, each repeating the header row.
    chunks = _split_body(header, body)
    total = len(chunks)
    parts: list[str] = []
    for k, chunk in enumerate(chunks, start=1):
        if caption:
            label = f"**Таблица: {caption} (часть {k} из {total})**"
        else:
            label = f"**Таблица (часть {k} из {total})**"
        parts.append(f"{label}\n\n{_gfm_table(header, chunk)}")
    return "\n\n".join(parts)


def _is_wide(header: list[str], body: list[list[str]]) -> bool:
    if len(header) > _WIDE_TABLE_COLS:
        return True
    for row in [header, *body]:
        for cell in row:
            if len(cell) > _WIDE_CELL_CHARS:
                return True
    return False


def _gfm_table(header: list[str], body: list[list[str]]) -> str:
    ncol = max(len(header), *(len(r) for r in body)) if body else len(header)
    ncol = max(ncol, 1)
    hdr = header + [""] * (ncol - len(header))
    lines = [
        "| " + " | ".join(hdr) + " |",
        "| " + " | ".join(["---"] * ncol) + " |",
    ]
    for row in body:
        cells = row + [""] * (ncol - len(row))
        lines.append("| " + " | ".join(cells[:ncol]) + " |")
    return "\n".join(lines)


def _est_tokens(text: str) -> float:
    return len(text) / _CHARS_PER_TOKEN


def _split_body(header: list[str], body: list[list[str]]) -> list[list[list[str]]]:
    chunks: list[list[list[str]]] = []
    current: list[list[str]] = []
    for row in body:
        trial = current + [row]
        if current and _est_tokens(_gfm_table(header, trial)) > _MAX_TABLE_TOKENS:
            chunks.append(current)
            current = [row]
        else:
            current = trial
    if current:
        chunks.append(current)
    return chunks or [[]]


def _linearize_table(header: list[str], body: list[list[str]], caption: str) -> str:
    paras: list[str] = []
    if caption:
        paras.append(f"**Таблица: {caption}**")
    rows = body if body else []
    for row in rows:
        parts = []
        for i, head in enumerate(header):
            value = row[i] if i < len(row) else ""
            parts.append(f"**{head}:** {value}")
        paras.append(". ".join(parts) + ".")
    return "\n\n".join(paras)


# ===========================================================================
# Stage B: markdownify subclass
# ===========================================================================


class _StorageConverter(MarkdownConverter):
    """Markdown converter for the normalized storage soup.

    Placeholder ``<p>`` nodes (code / table sentinels) pass straight through as
    plain text via the default paragraph handling; nothing special is required
    here beyond ATX headings.
    """


# ===========================================================================
# Stage C: post-processing
# ===========================================================================

_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.*)$")


def _postprocess(md: str, title: str, placeholders: dict) -> str:
    md = _demote_and_prepend_title(md, title)
    md = _normalize_text(md)
    md = _restore_block_placeholders(md, placeholders)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip() + "\n"


def _demote_and_prepend_title(md: str, title: str) -> str:
    """Shift body headings down one level, then prepend ``# {title}``."""
    out_lines: list[str] = []
    for line in md.split("\n"):
        m = _HEADING_RE.match(line)
        if m:
            level = len(m.group(1))
            new_level = min(level + 1, 6)
            out_lines.append("#" * new_level + " " + m.group(2))
        else:
            out_lines.append(line)
    body = "\n".join(out_lines)
    clean_title = unicodedata.normalize("NFC", title or "").strip() or "Без названия"
    body = body.lstrip("\n")
    if body:
        return f"# {clean_title}\n\n{body}"
    return f"# {clean_title}"


def _normalize_text(md: str) -> str:
    """NFC + zero-width / nbsp cleanup + trailing-whitespace strip.

    Runs while code / tables are still opaque placeholders, so their verbatim
    content is exempt by construction.
    """
    md = unicodedata.normalize("NFC", md)
    md = _ZERO_WIDTH_RE.sub("", md)
    md = md.replace("\xa0", " ")
    md = "\n".join(line.rstrip() for line in md.split("\n"))
    return md


def _restore_block_placeholders(md: str, placeholders: dict) -> str:
    def repl(match: re.Match) -> str:
        entry = placeholders.get(match.group(0))
        if not entry:
            return ""
        kind, payload = entry
        if kind == "code":
            lang, code = payload
            fence = "```" + lang if lang else "```"
            return f"{fence}\n{code}\n```"
        if kind == "table":
            return str(payload)
        if kind == "literal":
            return str(payload)
        return ""

    return _PH_RE.sub(repl, md)


# ===========================================================================
# Sanitization primitives
# ===========================================================================


def _sanitize(value: str) -> str:
    """Shared filename / segment sanitizer (no length cap, no fallback)."""
    text = unicodedata.normalize("NFC", value or "")
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C")
    text = _FORBIDDEN_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = text.lstrip(".").strip()
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _safe_segment(value: str) -> str:
    seg = _sanitize(value)
    if len(seg) > _FILENAME_MAX:
        seg = seg[:_FILENAME_MAX].rstrip().rstrip(".").rstrip()
    return seg or "_"
