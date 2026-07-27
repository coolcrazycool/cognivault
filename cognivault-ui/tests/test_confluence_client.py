"""Unit tests for app.confluence.client.

Uses httpx.MockTransport for the network and asyncio.run to drive the async
API (no pytest-asyncio needed). pytest is a dev-only dependency — install it in
your sandbox to run these; it is NOT in requirements.txt.
"""

from __future__ import annotations

import asyncio
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.confluence.client import (  # noqa: E402
    ConfluenceClient,
    ConfluenceError,
    parse_page_url,
    resolve_display_url,
)

BASE = "https://confluence.example.com"


def _client(handler, **kw) -> ConfluenceClient:
    return ConfluenceClient(
        base_url=BASE,
        transport=httpx.MockTransport(handler),
        **kw,
    )


def _json(request: httpx.Request, payload, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=payload, request=request)


# --------------------------------------------------------------------------- #
# parse_page_url matrix
# --------------------------------------------------------------------------- #


def test_parse_pageid_viewpage():
    url = f"{BASE}/pages/viewpage.action?pageId=12345"
    assert parse_page_url(url) == "12345"


def test_parse_pageid_arbitrary_query():
    assert parse_page_url(f"{BASE}/x/y?foo=1&pageId=999&bar=2") == "999"


def test_parse_spaces_pages():
    url = f"{BASE}/spaces/ENG/pages/67890/My+Page+Title"
    assert parse_page_url(url) == "67890"


def test_parse_context_path_pageid():
    url = f"{BASE}/confluence/pages/viewpage.action?pageId=555"
    assert parse_page_url(url) == "555"


def test_parse_context_path_spaces():
    url = f"{BASE}/confluence/spaces/ENG/pages/777/Title"
    assert parse_page_url(url) == "777"


def test_parse_display_returns_none():
    url = f"{BASE}/display/ENG/Some+Page"
    assert parse_page_url(url) is None


def test_parse_garbage_returns_none():
    assert parse_page_url("not a url at all") is None
    assert parse_page_url("") is None
    assert parse_page_url(f"{BASE}/dashboard.action") is None


# --------------------------------------------------------------------------- #
# resolve_display_url
# --------------------------------------------------------------------------- #


def test_resolve_display_url_hits_content_search():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        assert request.url.params["spaceKey"] == "ENG"
        assert request.url.params["title"] == "Some Page"
        return _json(request, {"results": [{"id": "42"}]})

    async def run():
        async with _client(handler) as c:
            return await resolve_display_url(c, f"{BASE}/display/ENG/Some+Page")

    assert asyncio.run(run()) == "42"
    assert "/rest/api/content" in seen["url"]


def test_resolve_display_url_not_found_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return _json(request, {"results": []})

    async def run():
        async with _client(handler) as c:
            await resolve_display_url(c, f"{BASE}/display/ENG/Missing")

    with pytest.raises(ConfluenceError) as ei:
        asyncio.run(run())
    assert ei.value.code == "PAGE_NOT_FOUND"


def test_resolve_display_url_non_display_returns_none():
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("should not be called")

    async def run():
        async with _client(handler) as c:
            return await resolve_display_url(c, f"{BASE}/pages/viewpage.action?pageId=1")

    assert asyncio.run(run()) is None


# --------------------------------------------------------------------------- #
# get_page field mapping
# --------------------------------------------------------------------------- #


def test_get_page_field_mapping():
    payload = {
        "id": "12345",
        "title": "Дизайн API",
        "space": {"key": "ENG"},
        "version": {"number": 7, "when": "2026-01-02T03:04:05.000Z"},
        "ancestors": [
            {"title": "Root"},
            {"title": "Section"},
        ],
        "metadata": {"labels": {"results": [{"name": "api"}, {"name": "draft"}]}},
        "body": {"storage": {"value": "<p>hello</p>"}},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert "body.storage" in request.url.params["expand"]
        return _json(request, payload)

    async def run():
        async with _client(handler) as c:
            return await c.get_page("12345")

    page = asyncio.run(run())
    assert page["id"] == "12345"
    assert page["title"] == "Дизайн API"
    assert page["space"] == "ENG"
    assert page["version"] == 7
    assert page["last_updated"] == "2026-01-02T03:04:05.000Z"
    assert page["ancestors"] == ["Root", "Section"]  # root-first, excludes self
    assert page["labels"] == ["api", "draft"]
    assert page["body_storage"] == "<p>hello</p>"
    assert page["source_url"] == f"{BASE}/pages/viewpage.action?pageId=12345"


# --------------------------------------------------------------------------- #
# enumerate_subtree: pagination + root inclusion + CQL->BFS fallback
# --------------------------------------------------------------------------- #


def test_enumerate_subtree_pagination_and_root_inclusion():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/rest/api/content/100":
            return _json(
                request,
                {
                    "id": "100",
                    "title": "Root",
                    "space": {"key": "ENG"},
                    "version": {"number": 1, "when": "t"},
                    "ancestors": [],
                    "metadata": {"labels": {"results": []}},
                    "body": {"storage": {"value": ""}},
                },
            )
        if path == "/rest/api/content/search":
            start = request.url.params.get("start")
            if start is None:
                # first page + next link
                return _json(
                    request,
                    {
                        "results": [
                            {"id": "101", "title": "A", "version": {"number": 2}}
                        ],
                        "size": 1,
                        "_links": {
                            "next": "/rest/api/content/search?cql=x&start=1&limit=1"
                        },
                    },
                )
            return _json(
                request,
                {
                    "results": [
                        {"id": "102", "title": "B", "version": {"number": 3}}
                    ],
                    "size": 1,
                    "_links": {},
                },
            )
        raise AssertionError(f"unexpected path {path}")

    async def run():
        async with _client(handler) as c:
            return await c.enumerate_subtree("100")

    items = asyncio.run(run())
    ids = [i["id"] for i in items]
    assert ids == ["100", "101", "102"]  # root prepended, then paginated
    assert items[0] == {"id": "100", "version": 1, "title": "Root"}
    assert items[1]["version"] == 2


def test_enumerate_subtree_cql_4xx_falls_back_to_bfs():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/rest/api/content/100":
            return _json(
                request,
                {
                    "id": "100",
                    "title": "Root",
                    "space": {"key": "ENG"},
                    "version": {"number": 1, "when": "t"},
                    "ancestors": [],
                    "metadata": {"labels": {"results": []}},
                    "body": {"storage": {"value": ""}},
                },
            )
        if path == "/rest/api/content/search":
            return _json(request, {"message": "cql disabled"}, status=400)
        if path == "/rest/api/content/100/child/page":
            return _json(
                request,
                {
                    "results": [
                        {"id": "201", "title": "Child", "version": {"number": 5}}
                    ],
                    "_links": {},
                },
            )
        if path == "/rest/api/content/201/child/page":
            return _json(request, {"results": [], "_links": {}})
        raise AssertionError(f"unexpected path {path}")

    async def run():
        async with _client(handler) as c:
            return await c.enumerate_subtree("100")

    items = asyncio.run(run())
    assert [i["id"] for i in items] == ["100", "201"]


# --------------------------------------------------------------------------- #
# 429 retry with injected sleep
# --------------------------------------------------------------------------- #


def test_429_retry_with_injected_sleep():
    calls = {"n": 0}
    slept: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(
                429, headers={"Retry-After": "2"}, request=request
            )
        return _json(request, {"results": []})

    async def fake_sleep(delay: float) -> None:
        slept.append(delay)

    async def run():
        c = _client(handler, sleep=fake_sleep, jitter=lambda: 0.5)
        async with c:
            return await c._request(
                "GET", "/rest/api/content", params={"title": "x"}
            )

    resp = asyncio.run(run())
    assert resp.status_code == 200
    assert calls["n"] == 2
    # 2s Retry-After + 20% * jitter(0.5) => 2 + 0.2*0.5*2 = 2.2
    assert slept == [pytest.approx(2.2)]


# --------------------------------------------------------------------------- #
# basic vs pat auth header selection
# --------------------------------------------------------------------------- #


def test_basic_auth_header():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization", "")
        return _json(request, {"results": []})

    async def run():
        c = _client(handler, auth_mode="basic", login="alice", password="secret")
        async with c:
            await c._request("GET", "/rest/api/content", params={"title": "x"})

    asyncio.run(run())
    assert seen["auth"].startswith("Basic ")


def test_pat_auth_header():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization", "")
        return _json(request, {"results": []})

    async def run():
        c = _client(handler, auth_mode="pat", pat="tok123")
        async with c:
            await c._request("GET", "/rest/api/content", params={"title": "x"})

    asyncio.run(run())
    assert seen["auth"] == "Bearer tok123"


# --------------------------------------------------------------------------- #
# SSO detection: 401, 302-to-login, HTML login body
# --------------------------------------------------------------------------- #


def test_sso_detection_401():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, request=request)

    async def run():
        async with _client(handler) as c:
            await c._request("GET", "/rest/api/content/1")

    with pytest.raises(ConfluenceError) as ei:
        asyncio.run(run())
    assert ei.value.code == "AUTH_FAILED_BASIC_SSO"
    assert "PAT" in ei.value.message


def test_sso_detection_302_to_login():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302,
            headers={"location": f"{BASE}/login.action?os_destination=%2Fx"},
            request=request,
        )

    async def run():
        async with _client(handler) as c:
            await c._request("GET", "/rest/api/content/1")

    with pytest.raises(ConfluenceError) as ei:
        asyncio.run(run())
    assert ei.value.code == "AUTH_FAILED_BASIC_SSO"


def test_sso_detection_html_login_body():
    def handler(request: httpx.Request) -> httpx.Response:
        html = (
            "<html><body><form name='loginform'>"
            "<input name='os_username'><input name='os_password' type='password'>"
            "</form></body></html>"
        )
        return httpx.Response(
            200,
            text=html,
            headers={"content-type": "text/html; charset=utf-8"},
            request=request,
        )

    async def run():
        async with _client(handler) as c:
            await c._request("GET", "/rest/api/content/1")

    with pytest.raises(ConfluenceError) as ei:
        asyncio.run(run())
    assert ei.value.code == "AUTH_FAILED_BASIC_SSO"


# --------------------------------------------------------------------------- #
# error mapping: 404 / other
# --------------------------------------------------------------------------- #


def test_404_maps_to_page_not_found():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, request=request)

    async def run():
        async with _client(handler) as c:
            await c.get_page("nope")

    with pytest.raises(ConfluenceError) as ei:
        asyncio.run(run())
    assert ei.value.code == "PAGE_NOT_FOUND"


def test_other_status_maps_to_conf_http():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text="forbidden", request=request)

    async def run():
        async with _client(handler) as c:
            await c._request("GET", "/rest/api/content/1")

    with pytest.raises(ConfluenceError) as ei:
        asyncio.run(run())
    assert ei.value.code == "CONF_HTTP_403"
    assert ei.value.detail == "forbidden"


# --------------------------------------------------------------------------- #
# list_attachments mapping
# --------------------------------------------------------------------------- #


def test_list_attachments_mapping():
    def handler(request: httpx.Request) -> httpx.Response:
        return _json(
            request,
            {
                "results": [
                    {
                        "title": "diagram.png",
                        "version": {"number": 2},
                        "extensions": {"fileSize": 1024, "mediaType": "image/png"},
                        "_links": {"download": "/download/attachments/1/diagram.png"},
                    }
                ],
                "_links": {},
            },
        )

    async def run():
        async with _client(handler) as c:
            return await c.list_attachments("1")

    atts = asyncio.run(run())
    assert atts[0]["filename"] == "diagram.png"
    assert atts[0]["download_url"] == f"{BASE}/download/attachments/1/diagram.png"
    assert atts[0]["version"] == 2
    assert atts[0]["size"] == 1024
    assert atts[0]["media_type"] == "image/png"
