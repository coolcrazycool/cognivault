#!/usr/bin/env python3
"""Дамп страниц Confluence в zip — сырьё для аудита RAG-конвейера.

Что выгружается и ЗАЧЕМ ИМЕННО ТАК
----------------------------------
Скрипт кладёт в архив **исходный storage-format** (XHTML с тегами ac:*/ri:*),
а НЕ готовый markdown. Причина: markdown уже прошёл через конвертер
`cognivault-ui/app/confluence/convert.py`, и по нему невозможно понять, что
конвертер потерял — составные ячейки, макросы, вложенные списки. Имея сырьё,
аудит гоняет конвертер сам и сравнивает вход с выходом.

Зависимостей нет — только стандартная библиотека Python 3.9+. Это осознанно:
скрипт запускается в закрытом контуре, где pip может быть недоступен.

Структура архива
----------------
    manifest.json          параметры запуска, индекс страниц, счётчики
    census.json            перепись элементов по корпусу (макросы, таблицы, …)
    pages/<id>.json        одна страница: метаданные + storage-XHTML
    export_view/<id>.html  только с --export-view: HTML как его рендерит сам
                           Confluence (там раскрыты include/jira/toc)

Примеры
-------
    # вся ветка под страницей, аутентификация по токену
    export CONFLUENCE_PAT=…
    python3 confluence_dump.py --root-url 'https://confluence…/pages/viewpage.action?pageId=123'

    # логин/пароль, свой УЦ, первые 50 страниц пространства
    python3 confluence_dump.py --base-url https://confluence… --space ENG \\
        --auth basic --login ivanov --ca /etc/ssl/certs/ca.pem --limit 50

    # добавить рендер Confluence — нужен, чтобы оценить потери на макросах
    python3 confluence_dump.py --root-url … --export-view

ВНИМАНИЕ: архив содержит текст страниц как есть. Просмотрите census.json и
список заголовков в выводе перед тем, как куда-либо его отправлять.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter
from typing import Any

# Порядок expand повторяет cognivault-ui/app/confluence/client.py:500 — дамп
# должен содержать ровно те поля, которые видит рабочий конвейер, иначе аудит
# будет мерить не то, что реально индексируется.
PAGE_EXPAND = "body.storage,version,ancestors,metadata.labels,space"

# Отрезаем путь на первом «служебном» сегменте: всё до него — префикс
# инсталляции (Confluence часто живёт не в корне домена).
_BASE_CUT_RE = re.compile(r"/(?:pages|display|spaces|rest)(?:/|$)")
_SPACES_PAGE_RE = re.compile(r"/spaces/[^/]+/pages/(\d+)")


class ConfluenceError(RuntimeError):
    pass


# ─────────────────────────── разбор ссылок ────────────────────────────


def parse_base_url(url: str) -> str | None:
    """Ссылка на страницу → базовый URL инсталляции."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    path = parts.path or ""
    m = _BASE_CUT_RE.search(path)
    prefix = path[: m.start()] if m else ""
    return f"{parts.scheme}://{parts.netloc}{prefix}".rstrip("/")


def parse_page_url(url: str) -> str | None:
    """Ссылка на страницу → pageId, если он в ней есть."""
    parts = urllib.parse.urlsplit(url)
    for key, value in urllib.parse.parse_qsl(parts.query):
        if key.lower() == "pageid" and value.isdigit():
            return value
    m = _SPACES_PAGE_RE.search(parts.path or "")
    return m.group(1) if m else None


# ──────────────────────────── HTTP-клиент ─────────────────────────────


class Client:
    """Минимальный клиент Confluence REST на urllib.

    Повторяет поведение рабочего клиента в части, которая влияет на состав
    выгрузки: пагинация по _links.next, ретраи на 429/5xx, распознавание
    SSO-редиректа (иначе basic-аутентификация молча отдаёт HTML формы логина
    со статусом 200, и дамп получается из пустых страниц).
    """

    def __init__(
        self,
        base: str,
        *,
        auth: str,
        login: str = "",
        password: str = "",
        pat: str = "",
        ca_path: str = "",
        insecure: bool = False,
        timeout: int = 60,
    ) -> None:
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.headers: dict[str, str] = {
            "Accept": "application/json",
            "User-Agent": "cognivault-rag-audit/1.0",
        }
        if auth == "pat":
            if not pat:
                raise ConfluenceError("нужен --pat или переменная CONFLUENCE_PAT")
            self.headers["Authorization"] = f"Bearer {pat}"
        elif auth == "basic":
            if not login:
                raise ConfluenceError("нужен --login")
            raw = f"{login}:{password}".encode()
            self.headers["Authorization"] = "Basic " + base64.b64encode(raw).decode()

        if insecure:
            ctx = ssl._create_unverified_context()  # noqa: SLF001
        elif ca_path:
            ctx = ssl.create_default_context(cafile=ca_path)
        else:
            ctx = ssl.create_default_context()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=ctx),
            _NoRedirect(),
        )

    def get(self, url: str, params: dict[str, Any] | None = None) -> tuple[int, bytes, dict[str, str]]:
        if not url.startswith("http"):
            url = self.base + ("" if url.startswith("/") else "/") + url
        if params:
            url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers=self.headers, method="GET")

        last_err: Exception | None = None
        for attempt in range(4):
            try:
                with self.opener.open(req, timeout=self.timeout) as resp:
                    return resp.status, resp.read(), dict(resp.headers)
            except urllib.error.HTTPError as err:
                body = err.read()
                headers = dict(err.headers or {})
                if err.code == 429 and attempt < 3:
                    delay = _retry_after(headers, attempt)
                    print(f"  429, пауза {delay:.1f}s", file=sys.stderr)
                    time.sleep(delay)
                    continue
                if 500 <= err.code < 600 and attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                return err.code, body, headers
            except (urllib.error.URLError, TimeoutError) as err:  # сеть/TLS
                last_err = err
                if attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise ConfluenceError(f"сетевая ошибка на {url}: {err}") from err
        raise ConfluenceError(f"не удалось получить {url}: {last_err}")

    def get_json(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        status, body, headers = self.get(url, params)
        location = headers.get("Location") or headers.get("location") or ""
        if status in (301, 302, 303, 307, 308) and "login" in location.lower():
            raise ConfluenceError(
                "сервер редиректит на форму входа — включён SSO. "
                "Basic-аутентификация здесь не работает: используйте --auth pat "
                "с персональным токеном (Confluence → Настройки → Personal Access Tokens)."
            )
        if status == 401:
            raise ConfluenceError("401 Unauthorized — неверные учётные данные или нужен PAT вместо пароля")
        if status == 403:
            raise ConfluenceError("403 Forbidden — нет прав на этот контент")
        if status >= 400:
            raise ConfluenceError(f"HTTP {status} на {url}: {body[:400].decode('utf-8', 'replace')}")

        text = body.decode("utf-8", "replace")
        stripped = text.lstrip()
        if stripped[:1] not in ("{", "["):
            if any(marker in text.lower() for marker in ("j_username", "j_password", "login-form", "os_username")):
                raise ConfluenceError(
                    "вместо JSON пришла HTML-форма входа — включён SSO, нужен --auth pat"
                )
            raise ConfluenceError(f"ожидался JSON, пришло: {text[:200]}")
        return json.loads(text)

    def paginate(self, url: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        """Собрать все страницы выдачи, следуя _links.next."""
        out: list[dict[str, Any]] = []
        use_params: dict[str, Any] | None = dict(params)
        while True:
            data = self.get_json(url, use_params)
            out.extend(data.get("results") or [])
            nxt = (data.get("_links") or {}).get("next")
            if not nxt:
                return out
            url = urllib.parse.urljoin(self.base + "/", nxt.lstrip("/"))
            use_params = None  # параметры уже вшиты в next


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Не ходить за редиректами: 302 на /login — это диагностика, а не помеха."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D102
        return None


def _retry_after(headers: dict[str, str], attempt: int) -> float:
    raw = headers.get("Retry-After") or headers.get("retry-after")
    try:
        return min(float(raw), 60.0)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 2.0 * (attempt + 1)


# ────────────────────────── обход дерева страниц ──────────────────────


def resolve_root(client: Client, args: argparse.Namespace) -> str:
    if args.page_id:
        return args.page_id
    if args.root_url:
        pid = parse_page_url(args.root_url)
        if pid:
            return pid
        # Ссылка вида /display/SPACE/Title — ищем по пространству и заголовку.
        parts = urllib.parse.urlsplit(args.root_url)
        m = re.search(r"/display/([^/]+)/(.+)$", parts.path or "")
        if m:
            space = urllib.parse.unquote(m.group(1))
            title = urllib.parse.unquote(m.group(2)).replace("+", " ").rstrip("/")
            data = client.get_json(
                "/rest/api/content",
                {"spaceKey": space, "title": title, "expand": "version", "limit": 1},
            )
            results = data.get("results") or []
            if results:
                return str(results[0]["id"])
        raise ConfluenceError(f"не удалось определить pageId из {args.root_url}")
    raise ConfluenceError("укажите --root-url, --page-id или --space")


def collect_ids(client: Client, args: argparse.Namespace) -> list[str]:
    """Список id страниц к выгрузке."""
    if args.space and not (args.root_url or args.page_id):
        print(f"Пространство {args.space}: собираю список страниц…", file=sys.stderr)
        rows = client.paginate(
            "/rest/api/content",
            {"spaceKey": args.space, "type": "page", "limit": 100, "expand": "version"},
        )
        return [str(r["id"]) for r in rows]

    root = resolve_root(client, args)
    print(f"Корневая страница: {root}", file=sys.stderr)
    ids = [root]

    # Основной путь — CQL по всему поддереву одним запросом.
    try:
        rows = client.paginate(
            "/rest/api/content/search",
            {"cql": f"ancestor={root} and type=page", "limit": 100, "expand": "version"},
        )
        ids.extend(str(r["id"]) for r in rows)
    except ConfluenceError as err:
        # На части инсталляций CQL закрыт правами — обходим дерево вширь.
        print(f"  CQL недоступен ({err}), обхожу дерево вручную", file=sys.stderr)
        queue = [root]
        seen = {root}
        while queue:
            parent = queue.pop(0)
            rows = client.paginate(
                f"/rest/api/content/{parent}/child/page",
                {"limit": 100, "expand": "version"},
            )
            for row in rows:
                pid = str(row["id"])
                if pid not in seen:
                    seen.add(pid)
                    ids.append(pid)
                    queue.append(pid)

    # dict.fromkeys — дедупликация с сохранением порядка обхода.
    return list(dict.fromkeys(ids))


def fetch_page(client: Client, page_id: str, *, with_attachments: bool) -> dict[str, Any]:
    raw = client.get_json(f"/rest/api/content/{page_id}", {"expand": PAGE_EXPAND})
    labels = [
        item.get("name", "")
        for item in (((raw.get("metadata") or {}).get("labels") or {}).get("results") or [])
    ]
    page = {
        "id": str(raw.get("id", page_id)),
        "title": raw.get("title", ""),
        "space": ((raw.get("space") or {}).get("key")) or "",
        "ancestors": [a.get("title", "") for a in (raw.get("ancestors") or [])],
        "ancestor_ids": [str(a.get("id", "")) for a in (raw.get("ancestors") or [])],
        "labels": labels,
        "version": ((raw.get("version") or {}).get("number")) or 0,
        "last_updated": ((raw.get("version") or {}).get("when")) or "",
        "source_url": f"{client.base}/pages/viewpage.action?pageId={raw.get('id', page_id)}",
        "storage": (((raw.get("body") or {}).get("storage") or {}).get("value")) or "",
        "attachments": [],
    }
    if with_attachments:
        rows = client.paginate(f"/rest/api/content/{page_id}/child/attachment", {"limit": 50})
        page["attachments"] = [
            {
                "filename": r.get("title", ""),
                "media_type": ((r.get("metadata") or {}).get("mediaType")) or "",
                "size": ((r.get("extensions") or {}).get("fileSize")) or 0,
            }
            for r in rows
        ]
    return page


def fetch_export_view(client: Client, page_id: str) -> str:
    data = client.get_json(f"/rest/api/content/{page_id}", {"expand": "body.export_view"})
    return (((data.get("body") or {}).get("export_view") or {}).get("value")) or ""


# ───────────────────────────── перепись ───────────────────────────────

_MACRO_RE = re.compile(r'<ac:structured-macro[^>]*\bac:name="([^"]+)"', re.I)
_CODE_LANG_RE = re.compile(
    r'<ac:parameter[^>]*\bac:name="language"[^>]*>([^<]*)</ac:parameter>', re.I
)


def census_page(storage: str) -> Counter:
    """Пересчитать конструкции, которые труднее всего переживают конвертацию.

    Регулярками, а не парсером: скрипт должен работать без bs4. Точность
    здесь и не нужна — это предпросмотр состава корпуса, детальный разбор
    делает аудит уже на дампе.
    """
    c: Counter = Counter()
    c["tables"] = len(re.findall(r"<table[\s>]", storage, re.I))
    c["table_colspan"] = len(re.findall(r"\bcolspan=", storage, re.I))
    c["table_rowspan"] = len(re.findall(r"\browspan=", storage, re.I))
    c["table_header_cells"] = len(re.findall(r"<th[\s>]", storage, re.I))
    c["lists_ul"] = len(re.findall(r"<ul[\s>]", storage, re.I))
    c["lists_ol"] = len(re.findall(r"<ol[\s>]", storage, re.I))
    c["list_items"] = len(re.findall(r"<li[\s>]", storage, re.I))
    c["task_lists"] = len(re.findall(r"<ac:task-list[\s>]", storage, re.I))
    c["tasks"] = len(re.findall(r"<ac:task[\s>]", storage, re.I))
    c["layouts"] = len(re.findall(r"<ac:layout[\s>]", storage, re.I))
    c["layout_cells"] = len(re.findall(r"<ac:layout-cell[\s>]", storage, re.I))
    c["images"] = len(re.findall(r"<ac:image[\s>]", storage, re.I))
    c["attachment_refs"] = len(re.findall(r"<ri:attachment[\s>]", storage, re.I))
    c["page_links"] = len(re.findall(r"<ri:page[\s>]", storage, re.I))
    c["emoticons"] = len(re.findall(r"<ac:emoticon[\s>]", storage, re.I))
    c["inline_comments"] = len(re.findall(r"<ac:inline-comment-marker[\s>]", storage, re.I))
    c["headings"] = len(re.findall(r"<h[1-6][\s>]", storage, re.I))
    c["plain_text_bodies"] = len(re.findall(r"<ac:plain-text-body[\s>]", storage, re.I))
    c["chars"] = len(storage)
    for name in _MACRO_RE.findall(storage):
        c[f"macro:{name.lower()}"] += 1
    for lang in _CODE_LANG_RE.findall(storage):
        c[f"code_lang:{(lang.strip() or 'none').lower()}"] += 1
    # Вложенная таблица: <table> внутри <td>. Грубая, но полезная эвристика.
    for cell in re.findall(r"<td\b.*?</td>", storage, re.I | re.S):
        if "<table" in cell.lower():
            c["nested_tables"] += 1
    return c


# ──────────────────────────────── main ────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Выгрузка страниц Confluence в zip для аудита RAG",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    src = ap.add_argument_group("что выгружать")
    src.add_argument("--root-url", default="", help="ссылка на корневую страницу (вся ветка под ней)")
    src.add_argument("--page-id", default="", help="id корневой страницы вместо ссылки")
    src.add_argument("--space", default="", help="ключ пространства (без --root-url — всё пространство)")
    src.add_argument("--base-url", default="", help="базовый URL; по умолчанию выводится из --root-url")
    src.add_argument("--limit", type=int, default=0, help="взять не больше N страниц (0 — все)")
    src.add_argument("--min-chars", type=int, default=0, help="пропускать страницы короче N символов")

    au = ap.add_argument_group("доступ")
    au.add_argument("--auth", choices=("pat", "basic", "none"), default="pat")
    au.add_argument("--login", default=os.environ.get("CONFLUENCE_LOGIN", ""))
    au.add_argument("--password", default=os.environ.get("CONFLUENCE_PASSWORD", ""))
    au.add_argument("--pat", default=os.environ.get("CONFLUENCE_PAT", ""))
    au.add_argument("--ca", default=os.environ.get("CONFLUENCE_CA_PATH", ""), help="путь к CA-бандлу")
    au.add_argument("--insecure", action="store_true", help="не проверять TLS-сертификат")
    au.add_argument("--timeout", type=int, default=60)

    out = ap.add_argument_group("вывод")
    out.add_argument("--out", default="confluence-dump.zip")
    out.add_argument("--export-view", action="store_true",
                     help="добавить HTML-рендер Confluence (вдвое больше запросов, но видно раскрытые макросы)")
    out.add_argument("--no-attachments", action="store_true", help="не запрашивать список вложений")

    args = ap.parse_args()

    base = args.base_url or parse_base_url(args.root_url) if (args.base_url or args.root_url) else ""
    if not base:
        print("Нужен --base-url или --root-url, из которого его можно вывести.", file=sys.stderr)
        return 2

    password = args.password
    if args.auth == "basic" and not password:
        password = getpass.getpass(f"Пароль для {args.login}: ")

    try:
        client = Client(
            base,
            auth=args.auth,
            login=args.login,
            password=password,
            pat=args.pat,
            ca_path=args.ca,
            insecure=args.insecure,
            timeout=args.timeout,
        )
        ids = collect_ids(client, args)
    except ConfluenceError as err:
        print(f"ОШИБКА: {err}", file=sys.stderr)
        return 1

    if args.limit:
        ids = ids[: args.limit]
    print(f"К выгрузке: {len(ids)} страниц", file=sys.stderr)

    pages: list[dict[str, Any]] = []
    export_views: dict[str, str] = {}
    total: Counter = Counter()
    failures: list[dict[str, str]] = []

    for n, pid in enumerate(ids, 1):
        try:
            page = fetch_page(client, pid, with_attachments=not args.no_attachments)
        except ConfluenceError as err:
            print(f"[{n}/{len(ids)}] {pid}: пропуск — {err}", file=sys.stderr)
            failures.append({"id": pid, "error": str(err)})
            continue

        if len(page["storage"]) < args.min_chars:
            continue

        stats = census_page(page["storage"])
        total.update(stats)
        page["census"] = dict(stats)
        pages.append(page)
        print(
            f"[{n}/{len(ids)}] {page['title'][:60]} — {len(page['storage'])} симв., "
            f"таблиц {stats['tables']}, макросов {sum(v for k, v in stats.items() if k.startswith('macro:'))}",
            file=sys.stderr,
        )

        if args.export_view:
            try:
                export_views[page["id"]] = fetch_export_view(client, pid)
            except ConfluenceError as err:
                print(f"    export_view недоступен: {err}", file=sys.stderr)

    if not pages:
        print("Не выгружено ни одной страницы.", file=sys.stderr)
        return 1

    manifest = {
        "tool": "cognivault-rag-audit/confluence_dump",
        "format_version": 1,
        "base_url": base,
        "space": args.space,
        "root": args.page_id or args.root_url,
        "page_count": len(pages),
        "failures": failures,
        "with_export_view": bool(export_views),
        "pages": [
            {
                "id": p["id"],
                "title": p["title"],
                "space": p["space"],
                "ancestors": p["ancestors"],
                "labels": p["labels"],
                "chars": len(p["storage"]),
                "attachments": len(p["attachments"]),
            }
            for p in pages
        ],
    }
    census = {
        "totals": dict(sorted(total.items())),
        "pages_with_tables": sum(1 for p in pages if p["census"]["tables"]),
        "pages_with_merged_cells": sum(
            1 for p in pages if p["census"]["table_colspan"] or p["census"]["table_rowspan"]
        ),
        "pages_with_code": sum(1 for p in pages if p["census"].get("macro:code")),
        "pages_with_tasks": sum(1 for p in pages if p["census"]["task_lists"]),
        "macros": {k[6:]: v for k, v in sorted(total.items()) if k.startswith("macro:")},
        "code_languages": {k[10:]: v for k, v in sorted(total.items()) if k.startswith("code_lang:")},
    }

    with zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        zf.writestr("census.json", json.dumps(census, ensure_ascii=False, indent=2))
        for page in pages:
            zf.writestr(f"pages/{page['id']}.json", json.dumps(page, ensure_ascii=False, indent=2))
        for pid, html in export_views.items():
            zf.writestr(f"export_view/{pid}.html", html)

    size_mb = os.path.getsize(args.out) / 1024 / 1024
    print(f"\nГотово: {args.out} ({size_mb:.1f} МБ, {len(pages)} страниц)", file=sys.stderr)
    print("\nСостав корпуса:", file=sys.stderr)
    print(f"  таблиц {total['tables']} (составные ячейки на {census['pages_with_merged_cells']} страницах, "
          f"colspan {total['table_colspan']}, rowspan {total['table_rowspan']}, вложенных {total['nested_tables']})",
          file=sys.stderr)
    print(f"  списков {total['lists_ul'] + total['lists_ol']} ({total['list_items']} пунктов), "
          f"чек-листов {total['task_lists']} ({total['tasks']} задач)", file=sys.stderr)
    print(f"  блоков кода {total.get('macro:code', 0)}, языки: "
          f"{', '.join(f'{k}×{v}' for k, v in list(census['code_languages'].items())[:12]) or '—'}",
          file=sys.stderr)
    print(f"  макросов всего {sum(census['macros'].values())}, различных {len(census['macros'])}:",
          file=sys.stderr)
    for name, count in sorted(census["macros"].items(), key=lambda kv: -kv[1])[:25]:
        print(f"    {name:<28} {count}", file=sys.stderr)
    if failures:
        print(f"  не удалось выгрузить: {len(failures)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
