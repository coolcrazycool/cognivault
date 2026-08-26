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
import posixpath
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

# Table sizing heuristics.
#
# Token counting here is the same deliberately-conservative heuristic the rest
# of the UI uses (see ``app/tokens.py``): **3 characters per token**.  There is
# no tiktoken in the UI, and for Cyrillic ``cl100k`` counts ~20% fewer tokens
# than GigaChat actually spends, so 3 chars/token over-estimates on purpose.
#
# ``_MAX_TABLE_TOKENS`` is aligned with the backend chunker's table budget
# (~1200 cl100k tokens per row-group).  Previously it was 350, which meant a
# large table was cut twice -- once here, once again by the chunker -- and both
# halves lost their meaning.  The point of sharing the budget is a single seam,
# so the split has to be measured in the CHUNKER's unit, and 3 chars/token is
# the wrong conversion for it: cl100k spends ~2.0-2.4 characters per token on
# Cyrillic table rows (measured), not 3, so a part that "fits" 1200 UI tokens
# was really ~1550 cl100k tokens and the chunker cut it again.  The split budget
# therefore converts at 2 chars/token and reserves headroom for the context
# prefix + header + delimiter the chunker prepends to every row group.
_CHARS_PER_TOKEN = 3
_MAX_TABLE_TOKENS = 1200
_TABLE_CHARS_PER_TOKEN = 2
_TABLE_CHUNKER_OVERHEAD_TOKENS = 200
_MAX_TABLE_CHARS = (_MAX_TABLE_TOKENS - _TABLE_CHUNKER_OVERHEAD_TOKENS) * _TABLE_CHARS_PER_TOKEN
# Hard cap on ONE fully expanded table (rowspan/colspan duplication can blow a
# modest Confluence grid up into megabytes of Markdown -- the root cause of the
# past 413s on indexing).  Beyond this the table is truncated with an explicit
# in-text notice.
#
# Потолка ДВА, потому что у веток разная цена строки.  GFM-сетка платит за
# каждую строку полной шириной таблицы: широкая объединённая сетка на сотню
# строк нечитаема и бесполезна, её действительно надо ограничивать жёстко.
# Линеаризация же — обычная проза по строке на запись, её размер идёт за
# реальным содержимым, и выброшенная строка там — чистая потеря смысла без
# всякой выгоды для рендера.  Поэтому решение «сетка или линеаризация»
# принимается ДО обрезки (см. `_emit_table`), а для линеаризации потолок
# заметно выше: он остаётся страховкой от катастрофического размножения
# (rowspan на сотни строк), а не рабочим ограничением.
_MAX_EXPANDED_TABLE_TOKENS = 20_000
_MAX_EXPANDED_TABLE_CHARS = _MAX_EXPANDED_TABLE_TOKENS * _CHARS_PER_TOKEN
_MAX_LINEARIZED_TABLE_TOKENS = 100_000
_MAX_LINEARIZED_TABLE_CHARS = _MAX_LINEARIZED_TABLE_TOKENS * _CHARS_PER_TOKEN
_WIDE_TABLE_COLS = 8
_WIDE_CELL_CHARS = 200

# Отступ для схлопнутой иерархической колонки (см. `_collapse_span_columns`):
# colspan по одинаковым заголовкам кодировал уровень вложенности, и без метки
# уровень терялся бы вместе с дублирующими колонками.
_HIERARCHY_INDENT = "— "

# Эмотикон, оставшийся единственным содержимым ячейки, несёт ЗНАЧЕНИЕ строки
# («да»/«нет»), поэтому у него должен быть текстовый эквивалент.
_EMOTICON_WORDS = {
    "plus": "да",
    "tick": "да",
    "check": "да",
    "thumbs-up": "да",
    "cross": "нет",
    "minus": "нет",
    "thumbs-down": "нет",
}

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

# Macro names dropped entirely: navigation / dynamic content, plus macros that
# render nothing at all in Confluence.  ``anchor`` is the latter -- an empty
# `<span>` target for in-page links; его имя ("а", "b", "перечень") — не текст
# страницы, а идентификатор якоря, и в индексе это чистый мусорный токен.
_DROP_MACROS = {
    "toc",
    "pagetree",
    "children",
    "contentbylabel",
    "recently-updated",
    "anchor",
}

# Макросы, чей `<ac:plain-text-body>` Confluence РЕНДЕРИТ как разметку, а не
# показывает дословно.  Различие принципиальное: payload `markdown`/`html` —
# это HTML-документ (ссылки, картинки, таблицы), и разобрать его надо как
# разметку; payload `code`/`noformat` и любого незнакомого макроса — дословный
# текст, и разбор его как разметки молча съел бы всё, что похоже на тег.
# Поэтому список белый: незнакомое считается дословным (см. `_emit_plain_body`).
_RENDERED_PLAIN_BODY_MACROS = {"markdown", "html", "html-include"}

# Вложения лежат в вольте по ОДНОМУ адресу, и знают его двое: `sync.py`, который
# кладёт туда файл, и конвертер, который на него ссылается.  Раньше адрес был
# записан в обоих местах руками и разошёлся — ссылки не разрешались ни одна.
_ATTACHMENTS_ROOT = "Confluence/attachments"


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


def attachment_vault_path(page_id: str, filename: str) -> str:
    """Абсолютный (от корня вольта) путь вложения: ``Confluence/attachments/<id>/<file>``.

    Единственное определение этого адреса.  Им пользуется и `sync.py` при
    записи файла, и конвертер при построении ссылки на него, — чтобы «куда
    положили» и «куда сослались» не могли разъехаться.
    """
    return f"{_ATTACHMENTS_ROOT}/{page_id}/{filename}"


def attachment_href(note_path: str, page_id: str, filename: str) -> str:
    """Ссылка на вложение ОТНОСИТЕЛЬНО заметки ``note_path``.

    Вложения лежат в общей папке в корне вольта, а заметка — на глубине
    ``Confluence/<пространство>/<предки…>``, поэтому путь всегда идёт вверх
    (``../../attachments/…``).  Раньше писалось ``attachments/<id>/<file>``
    относительно заметки — это разрешалось бы только для заметки, лежащей
    прямо в ``Confluence/``, а сегмент пространства есть всегда.
    """
    target = attachment_vault_path(page_id, _quote_href(filename))
    note_dir = note_path.rsplit("/", 1)[0] if "/" in note_path else ""
    if not note_dir:
        return target
    return posixpath.relpath(target, note_dir)


def _quote_href(name: str) -> str:
    """Экранирует в имени файла то, что ломает синтаксис ссылки Markdown.

    Кириллица и прочее НЕ трогается: `%`-кодировать всё подряд — значит сделать
    путь нечитаемым ради символов, которые разметке не мешают.  Пробел мешает:
    вложения тут зовутся «Проблемы SAFP на 20250526.eml», и без экранирования
    ссылка обрывается на первом же пробеле.
    """
    return _HREF_UNSAFE_RE.sub(lambda m: f"%{ord(m.group(0)):02X}", name)


_HREF_UNSAFE_RE = re.compile(r"[ ()<>\"'%]")


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
        # Ссылка на вложение относительна ЗАМЕТКЕ, поэтому конвертеру нужен её
        # собственный путь.  Он выводится здесь, а не приходит из `sync.py`:
        # разрешение коллизий там меняет только имя файла, каталог остаётся тем
        # же, а именно каталог и определяет ссылку.
        note_path=build_vault_path(page),
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
        note_path: str = "",
    ) -> None:
        self.page_id = page_id
        self.space = space
        self.crawl_titles = crawl_titles
        self.attachment_names = attachment_names
        self.note_path = note_path
        self.placeholders: dict[str, tuple[str, Any]] = {}
        self.refs: list[str] = []
        self._seen_refs: set[str] = set()
        self.coverage: list[str] = []
        self.unresolved_users: list[str] = []
        self._counter = 0

    def add_placeholder(self, kind: str, payload: Any) -> str:
        key = f"{_PH_OPEN}PH{self._counter}{_PH_CLOSE}"
        self._counter += 1
        self.placeholders[key] = (kind, payload)
        return key

    def attachment_href(self, filename: str) -> str:
        return attachment_href(self.note_path, self.page_id, filename)

    def record_ref(self, filename: str) -> None:
        if filename and filename not in self._seen_refs:
            self._seen_refs.add(filename)
            self.refs.append(filename)

    def record_unresolved_user(self, key: str) -> None:
        """Note a person mention we could not turn into a name.

        Storage XHTML has only ``ri:userkey``; the display name needs a separate
        ``/rest/api/user?key=`` call. Until that exists, the count at least makes
        the gap countable instead of silent — a page whose whole content is a
        team roster otherwise converts to an empty document and looks fine.
        """
        self.unresolved_users.append(key or "?")


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
            _handle_status(macro, ctx)
        elif name in ("include", "excerpt-include"):
            _handle_include(macro, ctx)
        elif name == "jira":
            _handle_jira(macro, ctx)
        elif name in ("drawio", "drawio-sketch", "gliffy", "chart"):
            _handle_diagram(macro, ctx)
        elif name == "view-file":
            _handle_view_file(macro, ctx)
        elif name == "open-api":
            _handle_open_api(macro, ctx)
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
    """Заголовок `expand` — жирный абзац, НЕ markdown-заголовок.

    Исторически title становился `<h3>`, но заголовок для чанкера — граница
    РАЗДЕЛА: раздел владеет всем до следующего заголовка того же уровня. А
    title у expand подписывает сворачиваемый блок, и после блока в том же
    родителе часто идёт текст, который к блоку не относится. Замер по дампу
    (127 страниц): у 77 из 158 titled expand-семейства за макросом следует
    именно такой «хвост» — с заголовком он приписывался к разделу expand'а,
    и поиск возвращал чужой breadcrumb и чужой section_text. Жирный абзац
    оставляет title в тексте чанка (индексируется и плотно, и лексически),
    но не рвёт дерево разделов.
    """
    title = (_param(macro, "title") or "").strip() or "Подробнее"
    _insert_bold_title(macro, title)
    body = macro.find("ac:rich-text-body")
    if body is not None:
        for child in list(body.children):
            macro.insert_before(child.extract())
    macro.decompose()


def _insert_bold_title(macro: Tag, title: str) -> None:
    """`<p><strong>title</strong></p>` перед макросом — как подпись у кода."""
    cap = _new_tag(macro, "p")
    strong = _new_tag(macro, "strong")
    strong.string = title
    cap.append(strong)
    macro.insert_before(cap)


def _handle_status(macro: Tag, ctx: _Context) -> None:
    title = (_param(macro, "title") or "").strip()
    strong = _new_tag(macro, "strong")
    # The bracketed label goes through the placeholder map so markdownify never
    # sees it and cannot escape it into `\[ГОТОВО]` / `PROJ\-42`.  Escaping is
    # suppressed *only* for these generated macro labels -- ordinary body text
    # with brackets still travels the normal markdownify path and stays escaped.
    strong.string = ctx.add_placeholder("literal", f"[{title}]")
    macro.replace_with(strong)


def _placeholder_line(macro: Tag, ctx: _Context, text: str) -> None:
    p = _new_tag(macro, "p")
    em = _new_tag(macro, "em")
    em.string = ctx.add_placeholder("literal", text)
    p.append(em)
    macro.replace_with(p)


def _handle_include(macro: Tag, ctx: _Context) -> None:
    page_ref = macro.find("ri:page")
    name = ""
    if page_ref is not None:
        name = (page_ref.get("ri:content-title") or "").strip()
    _placeholder_line(macro, ctx, f"[Включение: {name or 'страница'}]")


def _handle_jira(macro: Tag, ctx: _Context) -> None:
    key = (_param(macro, "key") or _param(macro, "jqlQuery") or "").strip()
    _placeholder_line(macro, ctx, f"[JIRA: {key or '—'}]")


def _handle_diagram(macro: Tag, ctx: _Context) -> None:
    name = (
        _param(macro, "diagramName")
        or _param(macro, "name")
        or _param(macro, "title")
        or ""
    ).strip()
    label = f"[Диаграмма: {name}]" if name else "[Диаграмма]"
    _placeholder_line(macro, ctx, label)


def _handle_view_file(macro: Tag, ctx: _Context) -> None:
    """`view-file` — предпросмотр вложения; имя файла и есть всё его содержимое.

    Имя лежит НЕ текстом параметра, а вложенным `<ri:attachment ri:filename>`,
    поэтому обычный разбор параметров его не видел, и макрос уходил в выход
    пустым — вместе с единственной ссылкой на приложенный документ.
    """
    att = macro.find("ri:attachment")
    filename = (att.get("ri:filename") or "").strip() if att is not None else ""
    if not filename:
        macro.decompose()
        return
    ctx.record_ref(filename)
    p = _new_tag(macro, "p")
    a = _new_tag(macro, "a")
    a["href"] = ctx.attachment_href(filename)
    # Текст ссылки — через плейсхолдер: имена файлов полны `_` и `.`, которые
    # markdownify экранирует, а именно они и ищутся лексически.
    a.string = ctx.add_placeholder("literal", f"Файл: {filename}")
    p.append(a)
    macro.replace_with(p)


def _handle_open_api(macro: Tag, ctx: _Context) -> None:
    """`open-api` — спецификация подгружается JavaScript'ом при рендере.

    Ни в storage, ни в отрендеренной странице тела спецификации нет: адрес —
    единственное, что вообще доступно, и без него страница пустая.
    """
    url = (_param(macro, "url") or "").strip()
    label = f"[Спецификация OpenAPI: {url}]" if url else "[Спецификация OpenAPI]"
    _placeholder_line(macro, ctx, label)


def _handle_unknown_macro(macro: Tag, ctx: _Context) -> None:
    name = (macro.get("ac:name") or "unknown").lower()
    ctx.coverage.append(name)

    # Заголовок макроса — не украшение, а якорь поиска («Логика окрашивания
    # вершин потоков»).  У `ui-expand` их 98 против 68 у обработанного `expand`,
    # и раньше все они пропадали: у неизвестного макроса брали только тело.
    # Именно жирный абзац, а не `<h3>`: markdown-заголовок для чанкера — граница
    # раздела, а `ui-expand`/`ui-tab` подписывают сворачиваемый блок, за которым
    # в том же родителе часто идёт чужой текст (48% ui-expand в дампе) — см.
    # объяснение замера в `_handle_expand`.
    title = (_param(macro, "title") or "").strip()
    if title:
        _insert_bold_title(macro, title)

    body = macro.find("ac:rich-text-body")
    if body is not None:
        for child in list(body.children):
            macro.insert_before(child.extract())
        macro.decompose()
        return

    plain = macro.find("ac:plain-text-body")
    if plain is not None:
        _emit_plain_body(macro, ctx, name, _cdata_text(plain))
        return

    macro.decompose()


def _emit_plain_body(macro: Tag, ctx: _Context, name: str, payload: str) -> None:
    """Тело `<ac:plain-text-body>` незнакомого макроса — сохранить, не разобрав.

    Раньше искали только `<ac:rich-text-body>`, и страница-навигатор целиком
    состоящая из макроса `markdown` схлопывалась в одну строку заголовка.

    Правило простое и намеренно осторожное: payload разбирается как разметка
    ТОЛЬКО для макросов из `_RENDERED_PLAIN_BODY_MACROS` — тех, что Confluence
    и сам рендерит.  Всё остальное укладывается в забор кода дословно: для
    `noformat`-подобного макроса payload — литеральный текст, и разбор его как
    HTML съел бы всё, что похоже на тег, молча и без следа.

    `<style>`/`<script>` из разбираемого payload'а выбрасываются: CSS — не текст
    страницы, а несколько сотен токенов шума на каждую страницу-навигатор.
    """
    if not payload.strip():
        macro.decompose()
        return

    if name in _RENDERED_PLAIN_BODY_MACROS:
        fragment = BeautifulSoup(payload, "html.parser")
        for junk in fragment.find_all(["style", "script"]):
            junk.decompose()
        for child in list(fragment.contents):
            macro.insert_before(child.extract())
        macro.decompose()
        return

    key = ctx.add_placeholder("code", ("", payload))
    ph = _new_tag(macro, "p")
    ph.string = key
    macro.replace_with(ph)


def _transform_images(soup: BeautifulSoup, ctx: _Context) -> None:
    # Эмотикон обычно декоративен и удаляется.  Но если он ЕДИНСТВЕННОЕ
    # содержимое ячейки таблицы, он и есть значение строки: «плюс» в колонке
    # признака читается как «да».  Пустая ячейка после удаления переворачивает
    # смысл строки на противоположный, поэтому такой эмотикон заменяется
    # словом.  Ячейку видно только здесь: к моменту разбора таблиц эмотиконов
    # в супе уже нет.
    for emo in soup.find_all("ac:emoticon"):
        cell = emo.find_parent(["td", "th"])
        sole = (
            cell is not None
            and not cell.get_text(strip=True)
            and cell.find(["ac:image", "img"]) is None
        )
        if sole:
            emo.replace_with(NavigableString(_emoticon_text(emo)))
        else:
            emo.decompose()
    for image in soup.find_all("ac:image"):
        alt = image.get("ac:alt") or image.get("ac:title") or ""
        # <ac:caption> is a CHILD of <ac:image>, so `image.replace_with(img)`
        # dropped the caption together with the image — and Confluence rarely
        # sets ac:alt, which left 198 images in the corpus contributing exactly
        # zero indexable words. The caption is usually the only prose naming
        # what a diagram shows.
        caption_el = image.find("ac:caption")
        caption = caption_el.get_text(" ", strip=True) if caption_el is not None else ""
        if caption and not alt:
            alt = caption
        att = image.find("ri:attachment")
        url = image.find("ri:url")
        if att is not None:
            filename = att.get("ri:filename") or ""
            if not filename:
                image.decompose()
                continue
            ctx.record_ref(filename)
            img = _new_tag(image, "img")
            img["src"] = ctx.attachment_href(filename)
            img["alt"] = alt
            _replace_image(image, img, caption)
        elif url is not None:
            img = _new_tag(image, "img")
            img["src"] = url.get("ri:value") or ""
            img["alt"] = alt
            _replace_image(image, img, caption)
        else:
            image.decompose()


def _replace_image(image: Tag, img: Tag, caption: str) -> None:
    """Swap ``<ac:image>`` for the ``<img>``, keeping the caption as real text.

    The caption goes AFTER the image as its own paragraph rather than only into
    ``alt``: markdown conversion keeps paragraph text verbatim, whereas alt text
    survives only as far as the chunker chooses to read it. Belt and braces — the
    words are what matter, not where they sit.
    """
    image.replace_with(img)
    if not caption:
        return
    para = _new_tag(img, "p")
    para.string = caption
    img.insert_after(para)


def _emoticon_text(emo: Tag) -> str:
    """Словесный эквивалент эмотикона: «да» / «нет», иначе — его имя."""
    name = (emo.get("ac:name") or "").strip().lower()
    return _EMOTICON_WORDS.get(name, name)


def _transform_links(soup: BeautifulSoup, ctx: _Context) -> None:
    for link in soup.find_all("ac:link"):
        body_el = link.find("ac:link-body") or link.find("ac:plain-text-link-body")
        anchor_text = body_el.get_text().strip() if body_el is not None else ""

        page_ref = link.find("ri:page")
        att_ref = link.find("ri:attachment")
        user_ref = link.find("ri:user")
        same_anchor = link.get("ac:anchor")

        if user_ref is not None:
            # No branch used to match this, so a person mention fell through to
            # the final `else` and became an EMPTY string: "кто входит в состав
            # команды" had nothing to answer from, and the loss was invisible —
            # it looked like an honest "не нашлось".
            #
            # Storage XHTML carries only an opaque key, never the name, so the
            # best we can do without a second API round-trip is preserve the
            # anchor text when the author typed one and otherwise leave a marker
            # that says a person is referenced here.
            key = (user_ref.get("ri:userkey") or user_ref.get("ri:account-id") or "").strip()
            text = anchor_text or (f"@user:{key}" if key else "@пользователь")
            ctx.record_unresolved_user(key)
            link.replace_with(NavigableString(text))
        elif page_ref is not None:
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
                a["href"] = ctx.attachment_href(filename)
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
    header, body_rows = _collapse_span_columns(header, body_rows)
    cells: list[str] = []
    for row in [header, *body_rows]:
        cells.extend(c for c in row if c)
    text = "«" + "; ".join(cells) + "»"
    table.replace_with(NavigableString(text))


def _emit_table(table: Tag, ctx: _Context) -> None:
    header, body_rows, caption, origins = _grid_to_rows_ex(table, ctx)
    before_promote = len(body_rows)
    header, body_rows, caption = _promote_caption_row(header, body_rows, caption)
    if len(body_rows) != before_promote:  # первая строка ушла в шапку/подпись
        origins = origins[1:]
    collapsed_header, collapsed_body = _collapse_span_columns(header, body_rows)
    if collapsed_body is not body_rows or collapsed_header is not header:
        # Колонки перекроили (иерархический заголовок) — соответствие сетки
        # происхождения потеряно.  Честный откат: без него группировка строк
        # ниже опиралась бы на сдвинутые колонки.  Такие таблицы — узкие
        # «Атрибут/Значение», в линеаризацию они не попадают.
        origins = []
    header, body_rows = collapsed_header, collapsed_body
    body_rows, origins = _drop_blank_rows(body_rows, origins)

    # Ветка рендера выбирается ДО обрезки.  Обратный порядок отрезал строки у
    # таблицы, которую всё равно предстояло линеаризовать: обрезка могла унести
    # как раз ту длинную ячейку, из-за которой таблица считалась широкой, и
    # строки терялись без всякой пользы для результата.
    wide = _is_wide(header, body_rows)
    budget = _MAX_LINEARIZED_TABLE_CHARS if wide else _MAX_EXPANDED_TABLE_CHARS
    body_rows, dropped = _cap_expanded_rows(header, body_rows, budget)
    origins = origins[: len(body_rows)]
    if dropped:
        logger.warning(
            "confluence page %s: table truncated -- expanded size over %d tokens, "
            "kept %d of %d body rows",
            ctx.page_id,
            budget // _CHARS_PER_TOKEN,
            len(body_rows),
            len(body_rows) + dropped,
        )
    md = _render_table(
        header,
        body_rows,
        caption,
        dropped,
        ctx.placeholders,
        wide=wide,
        budget=budget,
        origins=origins,
    )
    key = ctx.add_placeholder("table", md)
    ph = _new_tag(table, "p")
    ph.string = key
    table.replace_with(ph)


def _grid_to_rows(
    table: Tag, ctx: _Context
) -> tuple[list[str], list[list[str]], str]:
    """Expand rowspan/colspan into a full grid and return (header, body, caption)."""
    header, body, caption, _origins = _grid_to_rows_ex(table, ctx)
    return header, body, caption


def _grid_to_rows_ex(
    table: Tag, ctx: _Context
) -> tuple[list[str], list[list[str]], str, list[list[int]]]:
    """`_grid_to_rows` + сетка происхождения ячеек ТЕЛА (см. `_expand_spans`).

    Отдельная функция, а не четвёртый элемент в `_grid_to_rows`: ту импортирует
    аудит (`tools/rag_audit/audit_convert.py`) и сверяет её выход попозиционно
    с независимым эталоном — контракт «ровно три значения, сетка дословная»
    менять нельзя.
    """
    caption_el = table.find("caption", recursive=False)
    caption = _cell_text(caption_el, ctx) if caption_el is not None else ""

    trs = _direct_rows(table)

    # Parse each source row into (content_cell, colspan, rowspan).
    parsed: list[list[tuple[Tag, int, int]]] = []
    for tr in trs:
        cells = [c for c in tr.find_all(["td", "th"], recursive=False)]
        if not cells:
            continue
        parsed.append(
            [
                (cell, _int_attr(cell, "colspan", 1), _int_attr(cell, "rowspan", 1))
                for cell in cells
            ]
        )

    if not parsed:
        return [], [], caption, []

    grid, grid_origins = _expand_spans(parsed, ctx)

    # Шапка — ВСЕГДА первая строка сетки.  Раньше шапкой объявлялась первая
    # строка целиком из `<th>`, где бы она ни стояла, и её поднимали наверх —
    # это переставляло строки местами.  На реальных страницах над `<th>` часто
    # стоит строка-название таблицы (`<td colspan=N>`), и она уезжала в тело,
    # где colspan размножал её по всем колонкам.  Порядок строк не меняется;
    # строка-название разбирается отдельно, как подпись (`_promote_caption_row`).
    header = grid[0]
    body = grid[1:]
    body_origins = grid_origins[1:]

    # Normalize width across the whole grid.  Дополнение до ширины получает
    # уникальные «происхождения»-заглушки: пустая добивка ничьей копией не
    # является и склеивать строки не должна.
    width = max((len(r) for r in grid), default=0)
    header = header + [""] * (width - len(header))
    body = [r + [""] * (width - len(r)) for r in body]
    filler = -1
    padded_origins: list[list[int]] = []
    for row in body_origins:
        pad: list[int] = []
        for _ in range(width - len(row)):
            pad.append(filler)
            filler -= 1
        padded_origins.append(row + pad)
    return header, body, caption, padded_origins


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
    parsed: list[list[tuple[Tag, int, int]]], ctx: _Context
) -> tuple[list[list[str]], list[list[int]]]:
    """Duplicate rowspan/colspan values so every emitted row is self-contained.

    ``pending`` maps a column index to ``(text, remaining_rows, origin)`` for an
    active rowspan carried down from an earlier row.  Ragged spans (exceeding
    the remaining columns/rows) are simply clamped by construction -- never
    crash.

    Возвращает и сетку текстов, и сетку ПРОИСХОЖДЕНИЯ: id исходной ячейки для
    каждой позиции (копии одного span'а делят id).  По тексту «размножено
    span'ом» неотличимо от «одно и то же значение написано в каждой строке»
    («int» в колонке типа) — а различать их обязан `_linearize_table`: первое —
    изготовленный раскрытием повтор, второе — настоящие вхождения исходника,
    и их схлопывание роняло пословный recall корпуса 0.9993 → 0.9977.
    """
    grid: list[list[str]] = []
    origins: list[list[int]] = []
    pending: dict[int, tuple[str, int, int]] = {}
    next_origin = 0

    for row_cells in parsed:
        out: list[str] = []
        out_origins: list[int] = []
        col = 0
        ci = 0
        while ci < len(row_cells) or pending:
            if col in pending:
                text, rem, origin = pending[col]
                out.append(text)
                out_origins.append(origin)
                if rem - 1 > 0:
                    pending[col] = (text, rem - 1, origin)
                else:
                    del pending[col]
                col += 1
                continue
            if ci < len(row_cells):
                cell, colspan, rowspan = row_cells[ci]
                ci += 1
                text = _cell_text(cell, ctx)
                origin = next_origin
                next_origin += 1
                for _ in range(colspan):
                    out.append(text)
                    out_origins.append(origin)
                    if rowspan > 1:
                        pending[col] = (text, rowspan - 1, origin)
                    col += 1
                continue
            # No source cell here, but a rowspan may resume at a later column.
            future = [c for c in pending if c >= col]
            if future:
                nxt = min(future)
                while col < nxt:
                    out.append("")
                    out_origins.append(next_origin)  # заглушка — всегда уникальна
                    next_origin += 1
                    col += 1
                continue
            break
        grid.append(out)
        origins.append(out_origins)

    return grid, origins


# ---- grid post-processing (representation, not content) ---------------------
#
# Обе функции ниже правят ПРЕДСТАВЛЕНИЕ сетки перед рендером и намеренно НЕ
# живут в `_grid_to_rows`: раскрытие span'ов должно оставаться дословным
# (позиция в позицию с исходной таблицей), иначе его нечем проверять.


def _uniform_row_value(row: list[str]) -> str | None:
    """Общее значение полноширинной строки: все ячейки одинаковы и непусты.

    Это признак ячейки `<td colspan=N>` на всю ширину — раскрытие размножило
    одно значение по каждой колонке.  Такая строка не данные, а подпись:
    единый детектор для подписи НАД шапкой (`_promote_caption_row`) и для
    подписи группы в СЕРЕДИНЕ таблицы (`_linearize_table`).
    """
    if not row:
        return None
    value = row[0]
    if not value.strip() or any(cell != value for cell in row):
        return None
    return value


def _drop_blank_rows(
    body: list[list[str]], origins: list[list[int]]
) -> tuple[list[list[str]], list[list[int]]]:
    """Строка без единого значения не выводится вовсе.

    Пустой `<th colspan=7>` (строка-прокладка в реестре потоков) раскрывался в
    полную строку пустых ячеек и линеаризовался в «запись», где каждое поле —
    пустота: шум и в тексте, и в индексе.  Терять нечего — в строке нет ни
    одного значения по определению.  Сетка происхождения прореживается синхронно;
    id ячеек при этом не меняются, так что rowspan, накрывающий выброшенную
    строку, остаётся сцепленным.
    """
    if not origins:
        return [row for row in body if any(cell.strip() for cell in row)], []
    kept = [
        (row, org)
        for row, org in zip(body, origins)
        if any(cell.strip() for cell in row)
    ]
    return [row for row, _org in kept], [org for _row, org in kept]


def _carried_grid(
    body: list[list[str]], origins: list[list[int]]
) -> list[list[bool]]:
    """`carried[r][c]` — ячейка скопирована rowspan'ом из строки выше.

    Считается по id происхождения соседних ОСТАВШИХСЯ строк: совпадение id —
    это одна исходная ячейка, размноженная span'ом, а не совпадение текста.
    Без сетки происхождения (колонки перекроены `_collapse_span_columns`)
    возвращается «ничего не скопировано» — группировка тогда выключена.
    """
    if not origins or len(origins) != len(body):
        return [[False] * len(row) for row in body]
    carried: list[list[bool]] = [[False] * len(body[0])] if body else []
    for r in range(1, len(body)):
        prev, cur = origins[r - 1], origins[r]
        carried.append(
            [c < len(prev) and c < len(cur) and prev[c] == cur[c] for c in range(len(body[r]))]
        )
    return carried


def _promote_caption_row(
    header: list[str], body: list[list[str]], caption: str
) -> tuple[list[str], list[list[str]], str]:
    """Полноширинная строка с одним значением над шапкой — это подпись таблицы.

    Такая строка (`<td colspan=N>` с названием витрины) не данные: в сетке
    colspan размножает её по всем колонкам, и вместо названия получается
    `| имя | имя | имя |`.  Название уходит в подпись `**Таблица: …**`,
    а шапкой становится следующая строка — порядок строк при этом не меняется.
    """
    if len(header) < 2 or not body:
        return header, body, caption
    value = _uniform_row_value(header)
    if value is None:
        return header, body, caption
    # Если следующая строка такая же полноширинная, это не «подпись + шапка»,
    # а таблица из объединённых строк — трогать её нечего.
    if len(set(body[0])) <= 1:
        return header, body, caption
    return body[0], body[1:], caption or value


def _collapse_span_columns(
    header: list[str], body: list[list[str]]
) -> tuple[list[str], list[list[str]]]:
    """Убирает колонки-двойники, порождённые colspan внутри ОДНОГО заголовка.

    Конфлюэнсовский приём: колонки «Атрибут / Атрибут / Атрибут» — это один
    столбец с уровнями вложенности, а уровень закодирован тем, с какой колонки
    начинается значение.  Дословное раскрытие арифметически верно и
    семантически разрушительно: уровень пропадает, а термины утраиваются и
    втрое перевешивают BM25.

    Два случая, и различать их обязательно:

    * колонки диапазона нигде не несут разных значений — значит они и не
      колонки: диапазон схлопывается в одну колонку, уровень вложенности
      сохраняется меткой `_HIERARCHY_INDENT`;
    * колонки настоящие (в разных строках стоят разные значения — `config`,
      `rules`, `struct`), но отдельные строки размазаны по ним через colspan.
      Тогда колонки остаются, а размноженное значение гасится во всех
      позициях диапазона кроме первой.

    Сетка в обоих случаях остаётся прямоугольной: колонки убираются из всех
    строк разом.
    """
    width = len(header)
    if width < 2:
        return header, body

    segments: list[tuple[int, int]] = []
    dedupe: list[tuple[int, int]] = []
    start = 0
    while start < width:
        end = start
        while end + 1 < width and header[end + 1] == header[start]:
            end += 1
        if end > start and header[start].strip():
            if _run_is_duplicated(body, start, end):
                segments.append((start, end))
                start = end + 1
                continue
            dedupe.append((start, end))
        segments.extend((c, c) for c in range(start, end + 1))
        start = end + 1

    body = [_dedupe_runs(row, dedupe) for row in body] if dedupe else body
    if all(a == b for a, b in segments):
        return header, body

    new_header = [header[a] for a, _b in segments]
    new_body = [[_collapse_run(row, a, b) for a, b in segments] for row in body]
    return new_header, new_body


def _run_is_duplicated(body: list[list[str]], start: int, end: int) -> bool:
    for row in body:
        values = {row[c] for c in range(start, end + 1) if c < len(row) and row[c]}
        if len(values) > 1:
            return False
    return True


def _dedupe_runs(row: list[str], runs: list[tuple[int, int]]) -> list[str]:
    """Гасит повторы значения внутри диапазона, оставляя первое вхождение."""
    out = list(row)
    for start, end in runs:
        values = {out[c] for c in range(start, end + 1) if c < len(out) and out[c]}
        if len(values) != 1:
            continue
        seen = False
        for col in range(start, min(end + 1, len(out))):
            if not out[col]:
                continue
            if seen:
                out[col] = ""
            seen = True
    return out


def _collapse_run(row: list[str], start: int, end: int) -> str:
    """Единственное значение диапазона с меткой уровня вложенности."""
    if start == end:
        return row[start] if start < len(row) else ""
    for depth, col in enumerate(range(start, end + 1)):
        value = row[col] if col < len(row) else ""
        if value:
            return _HIERARCHY_INDENT * depth + value
    return ""


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
        elif name in ("p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6"):
            # Блок внутри ячейки: без разделителя его текст слипался со
            # следующим ("…реквизитовCN=CI06…"), и склеенное слово переставало
            # находиться лексическим поиском.  Так в ячейку попадает и подпись
            # `expand`-макроса — теперь это `<p><strong>` (см. `_handle_expand`),
            # h1–h6 оставлены на случай заголовков прямо в storage-ячейке.
            inner = _inline_render(child, ctx).strip()
            if inner:
                out.append(inner + "<br>")
        elif name in ("ul", "ol"):
            out.append(_inline_render(child, ctx))
        else:
            out.append(_inline_render(child, ctx))
    return "".join(out)


def _restore_inline_placeholders(text: str, placeholders: dict) -> str:
    """Inline-restore code/literal placeholders that landed inside a table cell.

    Многострочный код НЕ восстанавливается здесь: раньше он схлопывался в одну
    строку внутри бэктиков, и содержимое молча портилось (переносы — часть
    смысла у json/scala/sql).  Плейсхолдер остаётся в тексте ячейки, делает
    таблицу «широкой» (`_is_wide`) и потому линеаризуемой, а линеаризованная
    строка — обычный абзац, куда забор укладывается дословно.  Однострочный код
    ложится в бэктики как раньше: терять там нечего, а тащить из-за него
    таблицу в линеаризацию незачем.
    """

    def repl(match: re.Match) -> str:
        entry = placeholders.get(match.group(0))
        if not entry:
            return ""
        kind, payload = entry
        if kind == "code":
            _lang, code = payload
            if "\n" in code.strip():
                return match.group(0)
            return "`" + re.sub(r"\s+", " ", code).strip() + "`"
        if kind == "literal":
            return str(payload)
        if kind == "table":
            return str(payload)
        return ""

    return _PH_RE.sub(repl, text)


def _inline_code_cell(text: str, placeholders: dict) -> str:
    """Аварийная посадка блочного кода в одну строку (GFM-ячейка забора не держит).

    Работает страховкой: по `_is_wide` таблица с блочным кодом уходит в
    линеаризацию, но ни один плейсхолдер не имеет права дожить до вывода —
    восстановление таблиц однопроходное и вложенный ключ остался бы в тексте.
    """

    def repl(match: re.Match) -> str:
        entry = placeholders.get(match.group(0))
        if not entry:
            return ""
        kind, payload = entry
        if kind == "code":
            _lang, code = payload
            return ("`" + re.sub(r"\s+", " ", code).strip() + "`").replace("|", r"\|")
        return str(payload) if kind in ("literal", "table") else ""

    return _PH_RE.sub(repl, text)


def _split_code_blocks(
    text: str, placeholders: dict, seen: set[str] | None = None
) -> tuple[str, list[str]]:
    """Вынимает из текста ячейки блочный код, возвращая (текст, готовые заборы).

    ``seen`` — уже выведенные в этой таблице ключи.  Ячейка с ``rowspan`` на всю
    таблицу размножается по каждой строке, и без этого один и тот же пример
    JSON выводился бы полтора десятка раз подряд: в индексе это не смысл, а
    вес.  Повтор заменяется короткой отсылкой, дословный текст остаётся выше.
    """
    blocks: list[str] = []

    def repl(match: re.Match) -> str:
        key = match.group(0)
        entry = placeholders.get(key)
        if not entry or entry[0] != "code":
            return _inline_code_cell(key, placeholders)
        if seen is not None and key in seen:
            return " (см. выше) "
        if seen is not None:
            seen.add(key)
        lang, code = entry[1]
        fence = "```" + lang if lang else "```"
        blocks.append(f"{fence}\n{code}\n```")
        return " "

    stripped = _PH_RE.sub(repl, text)
    return re.sub(r"\s{2,}", " ", stripped).strip(), blocks


# ---- table Markdown emission ----------------------------------------------


def _cap_expanded_rows(
    header: list[str], body: list[list[str]], budget_chars: int
) -> tuple[list[list[str]], int]:
    """Cap one fully expanded table at ``budget_chars``.

    ``rowspan``/``colspan`` expansion duplicates cell text, so a merged-cell
    grid can explode into megabytes of Markdown -- exactly what produced the
    413s during indexing.  Rows are kept until the running size would exceed
    the cap; the first row is always kept so a single huge row still yields a
    table.  Returns ``(kept_rows, dropped_row_count)``.

    Бюджет приходит снаружи и зависит от выбранной ветки рендера (см.
    `_emit_table`): это последний рубеж, а не рабочее ограничение.
    """
    budget = budget_chars - sum(len(c) + 3 for c in header)
    kept: list[list[str]] = []
    used = 0
    for i, row in enumerate(body):
        cost = sum(len(c) + 3 for c in row) + 2
        if kept and used + cost > budget:
            return kept, len(body) - i
        used += cost
        kept.append(row)
    return kept, 0


def _truncation_notice(dropped: int, budget_chars: int) -> str:
    return (
        f"*[Таблица обрезана: пропущено строк — {dropped}. "
        f"Развёрнутый размер превысил лимит "
        f"{budget_chars // _CHARS_PER_TOKEN} токенов.]*"
    )


def _render_table(
    header: list[str],
    body: list[list[str]],
    caption: str,
    dropped: int,
    placeholders: dict,
    wide: bool,
    budget: int,
    origins: list[list[int]] | None = None,
) -> str:
    rendered = _render_table_body(header, body, caption, placeholders, wide, origins)
    rendered = _with_notice(rendered, dropped, budget)
    # Ни один плейсхолдер не должен пережить рендер таблицы: сама таблица тоже
    # плейсхолдер, а восстановление в Stage C однопроходное и вложенный ключ
    # утёк бы в вывод сырым.
    return _inline_code_cell(rendered, placeholders)


def _render_table_body(
    header: list[str],
    body: list[list[str]],
    caption: str,
    placeholders: dict,
    wide: bool,
    origins: list[list[int]] | None = None,
) -> str:
    if not header and not body:
        return ""

    # Таблица из одной строки — это ДАННЫЕ, а не шапка.  Раньше единственная
    # строка объявлялась шапкой с пустым телом: в лучшем случае получался
    # обглодок «шапка + разделитель», в худшем (широкая ячейка) линеаризация
    # обходила пустое тело и таблица исчезала целиком.
    if not body:
        return _render_single_row(header, caption, placeholders)

    if wide:
        return _linearize_table(header, body, caption, placeholders, origins)

    header = [_inline_code_cell(c, placeholders) for c in header]
    body = [[_inline_code_cell(c, placeholders) for c in row] for row in body]

    full = _gfm_table(header, body)
    if len(full) <= _MAX_TABLE_CHARS:
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


def _render_single_row(cells: list[str], caption: str, placeholders: dict) -> str:
    """Однострочная таблица -> строка текста (+ заборы кода, если он там был)."""
    parts: list[str] = []
    blocks: list[str] = []
    for cell in cells:
        text, extracted = _split_code_blocks(cell, placeholders)
        blocks.extend(extracted)
        if text:
            parts.append(text)
    paras: list[str] = []
    if caption:
        paras.append(f"**Таблица: {caption}**")
    if parts:
        paras.append(" — ".join(parts))
    paras.extend(blocks)
    return "\n\n".join(paras)


def _with_notice(rendered: str, dropped: int, budget: int) -> str:
    if not dropped:
        return rendered
    notice = _truncation_notice(dropped, budget)
    return f"{rendered}\n\n{notice}" if rendered else notice


def _is_wide(header: list[str], body: list[list[str]]) -> bool:
    if len(header) > _WIDE_TABLE_COLS:
        return True
    for row in [header, *body]:
        for cell in row:
            if len(cell) > _WIDE_CELL_CHARS:
                return True
            # Уцелевший плейсхолдер в ячейке бывает только блочным кодом (всё
            # остальное `_cell_text` уже восстановил).  Забор в GFM-ячейку не
            # помещается, значит таблицу надо линеаризовать.
            if _PH_RE.search(cell):
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


def _split_body(header: list[str], body: list[list[str]]) -> list[list[list[str]]]:
    chunks: list[list[list[str]]] = []
    current: list[list[str]] = []
    for row in body:
        trial = current + [row]
        if current and len(_gfm_table(header, trial)) > _MAX_TABLE_CHARS:
            chunks.append(current)
            current = [row]
        else:
            current = trial
    if current:
        chunks.append(current)
    return chunks or [[]]


def _linearize_table(
    header: list[str],
    body: list[list[str]],
    caption: str,
    placeholders: dict,
    origins: list[list[int]] | None = None,
) -> str:
    """Широкая таблица — по записи на строку, но БЕЗ дословного повтора rowspan.

    Дословная линеаризация раскрытой сетки повторяла запись целиком на каждую
    строку исходника: на «Стриминговых потоках» реестр из ~50 потоков давал
    262 записи (поток с 26 таблицами-источниками — 26 почти одинаковых записей
    с полным текстом назначения и всеми ссылками), страница — 277 КБ markdown
    и 262 чанка в одном разделе, а по корпусу — 32 кросс-файловых кластера
    почти-дубликатов (6.8% чанков).  Для BM25 термины назначения такого потока
    получали 26-кратную частоту.  Поэтому подряд идущие строки, чьи общие
    колонки — КОПИИ одной объединённой ячейки (по сетке происхождения, не по
    совпадению текста), сворачиваются: общая часть выводится один раз,
    различающиеся значения — списком рядом, в исходном порядке строк.
    Результат замера на том же дампе: 262 записи → 80, страница 277 → 107 тыс.
    знаков, 103 чанка вместо 267; пословный recall корпуса не изменился (0.9993).
    """
    paras: list[str] = []
    if caption:
        paras.append(f"**Таблица: {caption}**")
    heads = [_inline_code_cell(h, placeholders) for h in header]
    width = len(heads)
    carried = _carried_grid(body, origins or [])
    seen: set[str] = set()
    idx = 0
    while idx < len(body):
        row = body[idx]
        # Полноширинная строка в СЕРЕДИНЕ таблицы — подпись группы («FinEffect»,
        # «BMPF»), тот же приём, что у `_promote_caption_row` над шапкой.
        # Дословное раскрытие давало запись, где КАЖДОЕ поле — слово-подпись.
        # При наличии сетки происхождения дополнительно требуется, чтобы вся
        # строка была ОДНОЙ ячейкой (colspan): строка данных, где одно значение
        # честно написано в каждой колонке, подписью не считается.
        value = _uniform_row_value(row)
        one_cell = not origins or idx >= len(origins) or len(set(origins[idx])) == 1
        if value is not None and width >= 2 and one_cell:
            text, blocks = _split_code_blocks(value, placeholders, seen)
            if text:
                paras.append(f"**{text}**")
            paras.extend(blocks)
            idx += 1
            continue
        group_len, varying = _take_rowspan_group(body, carried, idx, width)
        _emit_linearized_group(
            paras,
            heads,
            body[idx : idx + group_len],
            carried[idx : idx + group_len],
            varying,
            placeholders,
            seen,
        )
        idx += group_len
    return "\n\n".join(paras)


def _take_rowspan_group(
    body: list[list[str]],
    carried: list[list[bool]],
    start: int,
    width: int,
) -> tuple[int, list[int]]:
    """Длина ряда строк, сворачиваемых в одну запись, и их СВОИ колонки.

    Строка присоединяется к группе, только если БОЛЬШИНСТВО её колонок —
    rowspan-копии строки выше (`carried`), т.е. повтор изготовлен раскрытием,
    а не написан в исходнике.  Собственная ПУСТАЯ ячейка (`<td><br/></td>` —
    визуальная прокладка под записью с rowspan) строку от группы не отрывает и
    в ``varying`` не попадает: на реальном реестре именно такие прокладки
    оставляли запись продублированной целиком.  Собственные НЕпустые колонки
    накапливаются в ``varying`` по всей группе; их должно оставаться строгое
    меньшинство ширины — иначе запись почти целиком своя и выгоды нет.  Замер
    реестра «Стриминговые потоки» (12 колонок, 262 строки): внутри потока
    у строки 1–3 своих непустых колонки, на границе потоков — 6–12; пороги
    их разделяют.
    """
    varying: set[int] = set()
    length = 1
    for r in range(start + 1, len(body)):
        row = body[r]
        row_carried = carried[r]
        carried_cols = {c for c in range(width) if c < len(row_carried) and row_carried[c]}
        if 2 * len(carried_cols) <= width:
            break  # строка в основном своя — это следующая запись
        own_nonempty = {
            c
            for c in range(width)
            if c not in carried_cols and (row[c] if c < len(row) else "").strip()
        }
        cand = varying | own_nonempty
        if 2 * len(cand) >= width:
            break
        base = body[start]
        shared = (i for i in range(width) if i not in cand)
        if not any((base[i] if i < len(base) else "").strip() for i in shared):
            break  # общего содержимого нет — сворачивать не вокруг чего
        varying = cand
        length += 1
    return length, sorted(varying)


def _emit_linearized_group(
    paras: list[str],
    heads: list[str],
    group: list[list[str]],
    group_carried: list[list[bool]],
    varying: list[int],
    placeholders: dict,
    seen: set[str],
) -> None:
    """Одна запись на группу: общие поля один раз, различия — вместе, по порядку.

    Значения различающихся колонок не выбрасываются, даже повторы: повтор в
    СВОЕЙ ячейке — это разные строки исходника с одинаковым значением («int» в
    колонке типа), их дедуп ронял пословный recall корпуса 0.9993 → 0.9977.
    Пропускается только значение, скопированное rowspan'ом из строки выше
    (`carried`), — его изготовило раскрытие, в исходнике оно один раз.  Для
    одной различающейся колонки значения перечисляются через `;` в порядке
    строк, для нескольких — пунктами списка по строке на исходную строку,
    чтобы соответствие значений внутри строки (источник ↔ путь) не рвалось.
    """
    base = group[0]
    varying_set = set(varying)
    parts: list[str] = []
    blocks: list[str] = []
    for i, head in enumerate(heads):
        if i in varying_set:
            continue
        value = base[i] if i < len(base) else ""
        value, extracted = _split_code_blocks(value, placeholders, seen)
        blocks.extend(extracted)
        parts.append(f"**{head}:** {value}")
    if parts:
        paras.append(". ".join(parts) + ".")
    # Забор идёт отдельным абзацем сразу за своей строкой: внутри
    # предложения он бы сломал и разметку, и дословность кода.
    paras.extend(blocks)
    if not varying:
        return  # единственная строка группы уже выведена целиком

    if len(varying) == 1:
        col = varying[0]
        values: list[str] = []
        tail_blocks: list[str] = []
        for r, row in enumerate(group):
            if r > 0 and col < len(group_carried[r]) and group_carried[r][col]:
                continue  # копия из rowspan — в исходнике значения нет
            value = row[col] if col < len(row) else ""
            value, extracted = _split_code_blocks(value, placeholders, seen)
            tail_blocks.extend(extracted)
            if value:
                values.append(value)
        paras.append(f"**{heads[col]}:** " + "; ".join(values) + ".")
        paras.extend(tail_blocks)
        return

    items: list[str] = []
    tail_blocks = []
    for r, row in enumerate(group):
        own = [
            col
            for col in varying
            if not (r > 0 and col < len(group_carried[r]) and group_carried[r][col])
            and (row[col] if col < len(row) else "").strip()
        ]
        if r > 0 and not own:
            continue  # копии и пустые прокладки; собственных значений нет
        rendered: list[tuple[int, str]] = []
        for col in varying:
            value = row[col] if col < len(row) else ""
            value, extracted = _split_code_blocks(value, placeholders, seen)
            tail_blocks.extend(extracted)
            rendered.append((col, value))
        items.append("- " + ". ".join(f"**{heads[c]}:** {v}" for c, v in rendered) + ".")
    paras.append("\n".join(items))
    paras.extend(tail_blocks)


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
# Префикс цитаты, который markdownify ставит перед строкой внутри `<blockquote>`
# (вложенные панели дают `> > `).
_QUOTE_PREFIX_RE = re.compile(r"^[ \t]*(?:>[ \t]*)+")


def _postprocess(md: str, title: str, placeholders: dict) -> str:
    md = _demote_and_prepend_title(md, title)
    md = _normalize_text(md)
    # Схлопывание пустых строк — ДО восстановления плейсхолдеров.  После него
    # оно резало пустые строки ВНУТРИ забора кода: код обязан дойти дословно, а
    # пустая строка там — часть текста (разделитель примеров, отступ в JSON).
    # Пока код и таблицы — плейсхолдеры, они от любой правки текста защищены по
    # построению, чем весь Stage C и пользуется.
    md = re.sub(r"\n{3,}", "\n\n", md)
    md = _restore_block_placeholders(md, placeholders)
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
    """Подставляет обратно код и таблицы, вынимая блочные из цитат.

    Панель (`_handle_panel`) — это `<blockquote>`, и markdownify ставит `> `
    только на строку с плейсхолдером.  Многострочная подстановка на месте давала
    `> ```python`, а сами строки кода оставались без префикса: забор не
    закрывался внутри цитаты, и блок переставал быть блоком — ни для markdown,
    ни для чанкера бэкенда, который разбирает документ в mdast и видит там не
    `code`, а испорченную цитату.  Префикс можно было бы дописать всем строкам,
    но забор внутри цитаты чанкер всё равно не считает кодом, поэтому блок
    выносится из цитаты наружу: дословность и разбираемость важнее рамки.
    """

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

    out: list[str] = []
    for line in md.split("\n"):
        if not _PH_RE.search(line):
            out.append(line)
            continue
        quote = _QUOTE_PREFIX_RE.match(line)
        rest = line[quote.end() :] if quote else line
        restored = _PH_RE.sub(repl, rest if quote else line)
        # Из цитаты выносится только блок, занимающий строку целиком: инлайновый
        # плейсхолдер (метка `status`, однострочный код) — часть предложения, и
        # без префикса он выпал бы из цитаты вместе с ним.
        if quote and _PH_RE.fullmatch(rest.strip()) and "\n" in restored:
            out.append(restored)
            continue
        out.append(line[: quote.end()] + restored if quote else restored)
    return "\n".join(out)


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
