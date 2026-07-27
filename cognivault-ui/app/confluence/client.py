"""Async Confluence REST client.

Talks to a Confluence Server/Data-Center ``/rest/api`` surface over ``httpx``.
The client is intentionally dependency-light (only ``httpx``) and fully
injectable for tests: pass an ``httpx.MockTransport`` and deterministic
``sleep``/``jitter`` callables.

Two auth modes are supported:

* ``basic`` — HTTP Basic (``login`` + ``password``). On a corporate SSO contour
  Basic is often disabled; the server then answers ``401`` or bounces to an
  HTML login page. We detect that and surface a single actionable error
  (:data:`SSO_MESSAGE`) telling the user to switch to a personal access token.
* ``pat`` — a personal access token sent as ``Authorization: Bearer <pat>``.

The public surface (consumed by the converter/sync phases) is:

* :func:`parse_page_url` / :func:`resolve_display_url` — URL → page id.
* :class:`ConfluenceClient` with :meth:`get_page`, :meth:`enumerate_subtree`,
  :meth:`get_export_view`, :meth:`list_attachments`, :meth:`download`.
* :class:`ConfluenceError` — typed, ``.code``/``.message``/``.detail``.
"""

from __future__ import annotations

import asyncio
import random
import re
import ssl
from collections import deque
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qs, unquote, urljoin, urlsplit

import httpx

SSO_MESSAGE = (
    "Basic-аутентификация отключена — используйте персональный токен (PAT)"
)

# --------------------------------------------------------------------------- #
# Typed error
# --------------------------------------------------------------------------- #


class ConfluenceError(Exception):
    """A typed Confluence failure.

    ``code`` is one of the stable machine codes (``AUTH_FAILED_BASIC_SSO``,
    ``TLS_ERROR``, ``PAGE_NOT_FOUND``, ``BAD_URL``, ``CONF_HTTP_<status>``,
    ``CONF_UNAVAILABLE``); ``message`` is human-readable; ``detail`` is an
    optional short technical excerpt (never contains secrets).
    """

    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


# --------------------------------------------------------------------------- #
# URL parsing
# --------------------------------------------------------------------------- #

# /spaces/<KEY>/pages/<N>/... — tolerant of an optional context path prefix.
_SPACES_PAGES_RE = re.compile(r"/spaces/[^/]+/pages/(\d+)")
# /display/<SPACE>/<Title...> — cannot be resolved to an id without an API call.
_DISPLAY_RE = re.compile(r"/display/([^/]+)/(.+?)/?$")


def parse_page_url(url: str) -> str | None:
    """Extract a Confluence page id from ``url``.

    Handled directly (no network):

    * any URL carrying a ``pageId=N`` query — including
      ``.../pages/viewpage.action?pageId=N`` (the primary form);
    * ``.../spaces/<KEY>/pages/<N>/...`` (Confluence Cloud/DC "pretty" URLs).

    A ``/display/<SPACE>/<Title>`` URL returns ``None`` because it needs a
    title→id lookup — the caller should fall back to :func:`resolve_display_url`.
    Any unparseable input returns ``None`` (caller raises ``BAD_URL``).

    A ``/confluence`` (or any) context path is tolerated — matching is done on
    path *segments*, never assuming the host root.
    """
    if not url or not isinstance(url, str):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None

    # pageId query param anywhere (primary form incl. viewpage.action).
    for key, values in parse_qs(parts.query).items():
        if key.lower() == "pageid" and values and values[0].isdigit():
            return values[0]

    # /spaces/<KEY>/pages/<N>/...
    m = _SPACES_PAGES_RE.search(parts.path)
    if m:
        return m.group(1)

    # display URLs and garbage → not resolvable here.
    return None


async def resolve_display_url(client: "ConfluenceClient", url: str) -> str | None:
    """Resolve a ``/display/<SPACE>/<Title>`` URL to a page id via the API.

    Returns ``None`` when ``url`` is not a display URL (so the caller can raise
    ``BAD_URL``). Raises :class:`ConfluenceError` (``PAGE_NOT_FOUND``) when the
    space/title pair matches no page.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    m = _DISPLAY_RE.search(parts.path)
    if not m:
        return None
    space = unquote(m.group(1))
    title = unquote(m.group(2).replace("+", " "))
    resp = await client._request(
        "GET",
        "/rest/api/content",
        params={"spaceKey": space, "title": title, "expand": "version"},
    )
    results = resp.json().get("results", [])
    if not results:
        raise ConfluenceError(
            "PAGE_NOT_FOUND",
            f"страница «{title}» в пространстве «{space}» не найдена",
        )
    return str(results[0].get("id", ""))


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _verify_arg(verify_ssl: bool, ca_path: str) -> bool | str:
    """Map (verify_ssl, ca_path) → the httpx ``verify`` argument.

    ``verify_ssl=False`` disables verification entirely (escape hatch); with a
    ``ca_path`` set it is used as the CA bundle; otherwise the system trust
    store (``True``).
    """
    if not verify_ssl:
        return False
    if ca_path:
        return ca_path
    return True


def _is_tls_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(
        marker in text
        for marker in ("ssl", "certificate", "cert verify", "verify failed")
    )


def _item(raw: dict[str, Any]) -> dict[str, Any]:
    """Reduce a content result to the ``{id, version, title}`` enumeration shape."""
    version = raw.get("version") or {}
    try:
        num = int(version.get("number", 0) or 0)
    except (TypeError, ValueError):
        num = 0
    return {"id": str(raw.get("id", "")), "version": num, "title": raw.get("title", "")}


def _looks_like_login_html(resp: httpx.Response) -> bool:
    """True when a 2xx/3xx response is actually an HTML SSO login page."""
    ctype = resp.headers.get("content-type", "").lower()
    if "html" not in ctype:
        return False
    body = resp.text.lower()
    return any(
        marker in body
        for marker in ("j_username", "j_password", "login-form", "name=\"os_username\"")
    ) or ("login" in body and "password" in body)


def _parse_retry_after(value: str | None) -> float:
    if not value:
        return 1.0
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return 1.0


# --------------------------------------------------------------------------- #
# Client
# --------------------------------------------------------------------------- #

SleepFn = Callable[[float], Awaitable[None]]
JitterFn = Callable[[], float]


class ConfluenceClient:
    """Async Confluence REST client built from resolved config + secret.

    Use as an async context manager::

        async with ConfluenceClient.from_config(cfg, secret) as client:
            page = await client.get_page("12345")
    """

    def __init__(
        self,
        *,
        base_url: str,
        auth_mode: str = "basic",
        login: str = "",
        password: str = "",
        pat: str = "",
        verify_ssl: bool = True,
        ca_path: str = "",
        max_concurrency: int = 3,
        transport: httpx.BaseTransport | None = None,
        sleep: SleepFn | None = None,
        jitter: JitterFn | None = None,
    ) -> None:
        self._base = (base_url or "").rstrip("/")
        self._auth_mode = auth_mode
        auth = (
            httpx.BasicAuth(login, password)
            if auth_mode == "basic" and login
            else None
        )
        headers = (
            {"Authorization": f"Bearer {pat}"} if auth_mode == "pat" and pat else {}
        )
        self._client = httpx.AsyncClient(
            base_url=self._base,
            verify=_verify_arg(verify_ssl, ca_path),
            auth=auth,
            headers=headers,
            transport=transport,
            timeout=httpx.Timeout(connect=10, read=30, write=30, pool=10),
        )
        self._sem = asyncio.Semaphore(max(1, max_concurrency))
        self._sleep: SleepFn = sleep or asyncio.sleep
        self._jitter: JitterFn = jitter or random.random

    @classmethod
    def from_config(
        cls,
        cfg: dict[str, Any],
        secret: dict[str, Any],
        *,
        max_concurrency: int = 3,
        transport: httpx.BaseTransport | None = None,
        sleep: SleepFn | None = None,
        jitter: JitterFn | None = None,
    ) -> "ConfluenceClient":
        """Build a client from a store config dict + secret dict."""
        return cls(
            base_url=str(cfg.get("base_url", "")),
            auth_mode=str(cfg.get("auth_mode", "basic")),
            login=str(cfg.get("login", "")),
            password=str(secret.get("password", "") or ""),
            pat=str(secret.get("pat", "") or ""),
            verify_ssl=bool(cfg.get("verify_ssl", True)),
            ca_path=str(cfg.get("ca_path", "") or ""),
            max_concurrency=max_concurrency,
            transport=transport,
            sleep=sleep,
            jitter=jitter,
        )

    @property
    def auth_mode(self) -> str:
        return self._auth_mode

    async def __aenter__(self) -> "ConfluenceClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------------ #
    # Central request path: retries, auth/SSO/TLS detection, error mapping
    # ------------------------------------------------------------------ #

    async def _request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        async with self._sem:
            attempt = 0
            while True:
                try:
                    resp = await self._client.request(method, path, **kw)
                except ssl.SSLError as exc:
                    raise ConfluenceError(
                        "TLS_ERROR",
                        "ошибка TLS при подключении к Confluence — проверьте ca_path",
                        detail=str(exc),
                    ) from exc
                except httpx.ConnectError as exc:
                    if _is_tls_error(exc):
                        raise ConfluenceError(
                            "TLS_ERROR",
                            "ошибка TLS при подключении к Confluence — проверьте ca_path",
                            detail=str(exc),
                        ) from exc
                    raise ConfluenceError(
                        "CONF_UNAVAILABLE",
                        "Confluence недоступен",
                        detail=str(exc) or exc.__class__.__name__,
                    ) from exc
                except httpx.HTTPError as exc:
                    if _is_tls_error(exc):
                        raise ConfluenceError(
                            "TLS_ERROR",
                            "ошибка TLS при подключении к Confluence — проверьте ca_path",
                            detail=str(exc),
                        ) from exc
                    raise ConfluenceError(
                        "CONF_UNAVAILABLE",
                        "Confluence недоступен",
                        detail=str(exc) or exc.__class__.__name__,
                    ) from exc

                status = resp.status_code

                # 429 — respect Retry-After (+ up to 20% jitter), retry <= 3.
                if status == 429 and attempt < 3:
                    base_delay = _parse_retry_after(resp.headers.get("Retry-After"))
                    delay = base_delay + base_delay * 0.2 * self._jitter()
                    await self._sleep(delay)
                    attempt += 1
                    continue

                # 5xx — retry once.
                if 500 <= status < 600 and attempt < 1:
                    await self._sleep(0.5 + 0.5 * self._jitter())
                    attempt += 1
                    continue

                return self._raise_for_response(resp)

    def _raise_for_response(self, resp: httpx.Response) -> httpx.Response:
        status = resp.status_code

        # Basic disabled / SSO: clean 401, a redirect to a login page, or a
        # 200 that is actually the HTML login form.
        if status == 401:
            raise ConfluenceError("AUTH_FAILED_BASIC_SSO", SSO_MESSAGE)
        if status in (301, 302, 303, 307, 308):
            location = resp.headers.get("location", "").lower()
            if "login" in location:
                raise ConfluenceError("AUTH_FAILED_BASIC_SSO", SSO_MESSAGE)
        if 200 <= status < 400 and _looks_like_login_html(resp):
            raise ConfluenceError("AUTH_FAILED_BASIC_SSO", SSO_MESSAGE)

        if status == 404:
            raise ConfluenceError("PAGE_NOT_FOUND", "страница не найдена")

        if not (200 <= status < 300):
            raise ConfluenceError(
                f"CONF_HTTP_{status}",
                f"Confluence вернул HTTP {status}",
                detail=resp.text[:500],
            )
        return resp

    # ------------------------------------------------------------------ #
    # Pagination
    # ------------------------------------------------------------------ #

    async def _collect(
        self, path: str, params: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """Collect ``results`` across all pages, following ``_links.next``.

        Reads ``size`` per page (does not assume ``limit``); a relative
        ``_links.next`` is joined against the client base.
        """
        results: list[dict[str, Any]] = []
        url = path
        use_params: dict[str, Any] | None = params
        while True:
            resp = await self._request("GET", url, params=use_params)
            data = resp.json()
            page = data.get("results", []) or []
            results.extend(page)
            nxt = (data.get("_links") or {}).get("next")
            if not nxt:
                break
            url = urljoin(str(self._client.base_url), nxt)
            use_params = None
        return results

    # ------------------------------------------------------------------ #
    # Subtree enumeration
    # ------------------------------------------------------------------ #

    async def enumerate_subtree(self, root_id: str) -> list[dict[str, Any]]:
        """List ``{id, version, title}`` for the root page and every descendant.

        Primary path: CQL ``ancestor={root_id} and type=page`` (which excludes
        the root itself, so the root is fetched separately and prepended).
        If the CQL endpoint answers 4xx (older Confluence, CQL disabled), fall
        back to a BFS over ``/child/page``.
        """
        root = await self.get_page(root_id)
        root_item = {
            "id": str(root["id"]),
            "version": int(root["version"]),
            "title": root["title"],
        }

        try:
            raw = await self._collect(
                "/rest/api/content/search",
                {
                    "cql": f"ancestor={root_id} and type=page",
                    "expand": "version",
                    "limit": 100,
                },
            )
            descendants = [_item(r) for r in raw]
        except ConfluenceError as exc:
            if exc.code.startswith("CONF_HTTP_4"):
                descendants = await self._bfs_subtree(root_id)
            else:
                raise

        result = [root_item]
        seen = {root_item["id"]}
        for item in descendants:
            if item["id"] and item["id"] not in seen:
                seen.add(item["id"])
                result.append(item)
        return result

    async def _bfs_subtree(self, root_id: str) -> list[dict[str, Any]]:
        """BFS fallback over ``/rest/api/content/{id}/child/page``."""
        items: list[dict[str, Any]] = []
        seen: set[str] = {str(root_id)}
        queue: deque[str] = deque([str(root_id)])
        while queue:
            parent = queue.popleft()
            raw = await self._collect(
                f"/rest/api/content/{parent}/child/page",
                {"limit": 100, "expand": "version"},
            )
            for r in raw:
                item = _item(r)
                if item["id"] and item["id"] not in seen:
                    seen.add(item["id"])
                    items.append(item)
                    queue.append(item["id"])
        return items

    # ------------------------------------------------------------------ #
    # Page content
    # ------------------------------------------------------------------ #

    async def get_page(self, page_id: str) -> dict[str, Any]:
        """Fetch a page and map it to the shared Page dict contract."""
        resp = await self._request(
            "GET",
            f"/rest/api/content/{page_id}",
            params={"expand": "body.storage,version,ancestors,metadata.labels,space"},
        )
        d = resp.json()
        version = d.get("version") or {}
        try:
            version_num = int(version.get("number", 0) or 0)
        except (TypeError, ValueError):
            version_num = 0
        ancestors = [
            a.get("title", "") for a in (d.get("ancestors") or [])
        ]
        labels_results = (
            ((d.get("metadata") or {}).get("labels") or {}).get("results") or []
        )
        labels = [lb.get("name", "") for lb in labels_results]
        space = (d.get("space") or {}).get("key", "")
        body_storage = (
            ((d.get("body") or {}).get("storage") or {}).get("value", "")
        )
        return {
            "id": str(d.get("id", page_id)),
            "title": d.get("title", ""),
            "space": space,
            "version": version_num,
            "last_updated": version.get("when", ""),
            "ancestors": ancestors,
            "labels": labels,
            "body_storage": body_storage,
            "source_url": f"{self._base}/pages/viewpage.action?pageId={page_id}",
        }

    async def get_export_view(self, page_id: str) -> str:
        """Return ``body.export_view.value`` (rendered HTML) for a page."""
        resp = await self._request(
            "GET",
            f"/rest/api/content/{page_id}",
            params={"expand": "body.export_view"},
        )
        d = resp.json()
        return ((d.get("body") or {}).get("export_view") or {}).get("value", "")

    async def list_attachments(self, page_id: str) -> list[dict[str, Any]]:
        """List attachments ``{filename, download_url, version, size, media_type}``."""
        raw = await self._collect(
            f"/rest/api/content/{page_id}/child/attachment", {"limit": 50}
        )
        out: list[dict[str, Any]] = []
        for a in raw:
            ext = a.get("extensions") or {}
            version = a.get("version") or {}
            try:
                version_num = int(version.get("number", 0) or 0)
            except (TypeError, ValueError):
                version_num = 0
            download = (a.get("_links") or {}).get("download", "")
            out.append(
                {
                    "filename": a.get("title", ""),
                    "download_url": urljoin(str(self._client.base_url), download)
                    if download
                    else "",
                    "version": version_num,
                    "size": ext.get("fileSize"),
                    "media_type": ext.get("mediaType", ""),
                }
            )
        return out

    async def download(self, url: str) -> bytes:
        """GET a (possibly relative) download URL with the same auth; return bytes."""
        full = urljoin(str(self._client.base_url) + "/", url)
        resp = await self._request("GET", full)
        return resp.content
