"""Confluence source config / validate / status endpoints.

Registered in BOTH deployment modes under ``/api/confluence`` with the same
bearer-token dependency the other ``/api`` routers use (Confluence config is
per-user data). In server mode the admin-locked connection settings
(``base_url``/``ca_path``/``verify_ssl``) come from the environment and override
the per-user file; everything else stays per user.

Config/validate/status come from phase 1; ``POST /sync`` (SSE) and the live
``running`` flag on ``GET /status`` are wired here on top of the phase-3 sync
driver.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .. import settings
from ..confluence import store
from ..confluence.client import (
    ConfluenceClient,
    ConfluenceError,
    parse_page_url,
    resolve_display_url,
)
from ..confluence.sync import SYNC_LOCKS, sync_stream
from ..deps import cv_context, get_token, resolve_paths, user_bucket

router = APIRouter(prefix="/api/confluence")

# Connection settings the administrator owns in server mode.
_ADMIN_LOCKED_KEYS = ("base_url", "ca_path", "verify_ssl")
_SECRET_KEYS = ("password", "pat")


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _error(
    status: int, code: str, message: str, detail: str | None = None
) -> JSONResponse:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if detail is not None:
        body["error"]["detail"] = detail
    return JSONResponse(status_code=status, content=body)


def _effective_config(paths: Any) -> dict[str, Any]:
    """Per-user config with admin-locked keys overridden in server mode."""
    cfg = store.load_config(paths)
    if settings.is_server():
        cfg = {
            **cfg,
            "base_url": settings.confluence_base_url(),
            "ca_path": settings.confluence_ca_path(),
            "verify_ssl": settings.confluence_verify_ssl(),
        }
    return cfg


def _max_concurrency() -> int:
    return settings.confluence_max_concurrency() if settings.is_server() else 3


def _sync_lock_key(request: Request) -> str:
    """Per-tenant single-flight key: the user bucket in server mode, else local.

    Must match the ``lock_key`` handed to :func:`sync_stream` so ``GET /status``
    can read the same lock the running sync holds.
    """
    if settings.is_server():
        return user_bucket(get_token(request))
    return "local"


def _is_configured(cfg: dict[str, Any], secret: dict[str, Any]) -> bool:
    """True when a base URL, a root target, and a credential are all present."""
    has_target = bool(cfg.get("base_url")) and bool(
        cfg.get("root_url") or cfg.get("root_page_id")
    )
    has_cred = bool(secret.get("password")) or bool(secret.get("pat"))
    return has_target and has_cred


def _confluence_error_response(exc: ConfluenceError) -> JSONResponse:
    """Map a :class:`ConfluenceError` to the standard HTTP error envelope."""
    status_map = {
        "BAD_URL": 400,
        "AUTH_FAILED_BASIC_SSO": 401,
        "PAGE_NOT_FOUND": 404,
        "TLS_ERROR": 502,
        "CONF_UNAVAILABLE": 503,
    }
    status = status_map.get(exc.code, 502)
    return _error(status, exc.code, exc.message, exc.detail)


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #


@router.get("/config")
async def get_config(request: Request) -> dict[str, Any]:
    """Return the non-secret config + credential presence flags.

    Never returns the password/pat — only ``has_password``/``has_pat`` booleans.
    In server mode base_url/ca_path/verify_ssl reflect the admin environment.
    """
    paths = resolve_paths(request)
    cfg = _effective_config(paths)
    secret = store.load_secret(paths)
    public = {k: cfg.get(k) for k in store.DEFAULT_CONFLUENCE_CONFIG}
    public["mode"] = "server" if settings.is_server() else "local"
    public["has_password"] = bool(secret.get("password"))
    public["has_pat"] = bool(secret.get("pat"))
    return public


@router.put("/config")
async def put_config(
    request: Request, body: dict[str, Any] = Body(default_factory=dict)
) -> Any:
    """Persist non-secret settings; route ``password``/``pat`` to the secret file.

    An empty-string secret value clears it. In server mode, attempting to set an
    admin-locked key (base_url/ca_path/verify_ssl) is rejected with 403.
    """
    paths = resolve_paths(request)

    if settings.is_server():
        offending = [k for k in _ADMIN_LOCKED_KEYS if k in body]
        if offending:
            return _error(
                403,
                "MODE_FORBIDDEN",
                "эти настройки заданы администратором: " + ", ".join(offending),
            )

    # Split secrets out of the body.
    secret_updates = {k: body[k] for k in _SECRET_KEYS if k in body}
    non_secret = {
        k: v
        for k, v in body.items()
        if k in store.DEFAULT_CONFLUENCE_CONFIG and k not in _SECRET_KEYS
    }

    if non_secret:
        store.save_config(paths, non_secret)

    # Server-mode auto-sync opt-in: the background scheduler is tokenless at
    # rest, so when a user turns ``auto_sync`` on we capture their CogniVault
    # bearer token into the secret store as ``cv_token`` so the scheduler can act
    # as them. Turning it off deletes the token. Local mode never needs this (the
    # file-based token is already available), and the token is never echoed back.
    manage_cv_token = settings.is_server() and "auto_sync" in body

    if secret_updates or manage_cv_token:
        secret = store.load_secret(paths)
        for key, value in secret_updates.items():
            if value == "" or value is None:
                secret.pop(key, None)  # empty clears
            else:
                secret[key] = str(value)
        if manage_cv_token:
            if body.get("auto_sync"):
                secret["cv_token"] = get_token(request)
            else:
                secret.pop("cv_token", None)
        store.save_secret(paths, secret)

    # Response never carries the secret.
    return await get_config(request)


@router.post("/validate")
async def validate(
    request: Request, body: dict[str, Any] = Body(default_factory=dict)
) -> Any:
    """Probe the configured (or request-supplied) credentials against the root page.

    Resolves ``root_url`` → page id (with a title→id fallback for ``/display``
    URLs), fetches the root page, and estimates the subtree size. Returns
    ``{ok, root_title, space, page_count_estimate, auth_mode_used}`` or the typed
    Confluence error envelope.
    """
    paths = resolve_paths(request)
    cfg = _effective_config(paths)
    secret = store.load_secret(paths)

    # Request body may override stored creds/target for a dry-run.
    auth_mode = str(body.get("auth_mode", cfg.get("auth_mode", "basic")))
    merged_cfg = {
        **cfg,
        "auth_mode": auth_mode,
        "login": str(body.get("login", cfg.get("login", ""))),
    }
    merged_secret = {
        "password": body.get("password", secret.get("password", "")),
        "pat": body.get("pat", secret.get("pat", "")),
    }
    root_url = str(body.get("root_url", cfg.get("root_url", "")))

    if not root_url:
        return _error(400, "BAD_URL", "не указана ссылка на корневую страницу")

    client = ConfluenceClient.from_config(
        merged_cfg, merged_secret, max_concurrency=_max_concurrency()
    )
    try:
        async with client:
            root_id = parse_page_url(root_url)
            if root_id is None:
                root_id = await resolve_display_url(client, root_url)
            if not root_id:
                raise ConfluenceError(
                    "BAD_URL", "не удалось распознать ссылку на страницу Confluence"
                )
            root = await client.get_page(root_id)
            estimate = await _count_estimate(client, root_id)
    except ConfluenceError as exc:
        return _confluence_error_response(exc)

    return {
        "ok": True,
        "root_title": root["title"],
        "space": root["space"],
        "page_count_estimate": estimate,
        "auth_mode_used": auth_mode,
    }


async def _count_estimate(client: ConfluenceClient, root_id: str) -> int:
    """Best-effort subtree size: descendant totalSize (+1 for the root)."""
    try:
        resp = await client._request(
            "GET",
            "/rest/api/content/search",
            params={"cql": f"ancestor={root_id} and type=page", "limit": 1},
        )
        data = resp.json()
        total = data.get("totalSize")
        if total is None:
            total = data.get("size", 0)
        return int(total or 0) + 1
    except ConfluenceError:
        # CQL unavailable — the root alone is the floor.
        return 1


@router.post("/sync")
async def sync(
    request: Request, body: dict[str, Any] = Body(default_factory=dict)
) -> Any:
    """Run a full Confluence→CogniVault sync, streaming progress as SSE.

    Pre-flight (plain HTTP, before any streaming starts): a sync needs a saved
    connection (base URL + root target + a credential) — otherwise ``400
    CONFLUENCE_NOT_CONFIGURED``. Once streaming, the underlying
    :func:`sync_stream` self-guards single-flight (a terminal ``error
    SYNC_ALREADY_RUNNING`` frame if this tenant's lock is already held) and emits
    ``step``/``log``/``page``/``error``/``done`` frames.
    """
    paths = resolve_paths(request)
    cfg = _effective_config(paths)
    secret = store.load_secret(paths)

    if not _is_configured(cfg, secret):
        return _error(
            400,
            "CONFLUENCE_NOT_CONFIGURED",
            "Сначала сохраните подключение к Confluence",
        )

    cv = cv_context(request)
    replace = bool(body.get("replace", False))
    lock_key = _sync_lock_key(request)
    now_iso = datetime.now(timezone.utc).astimezone().isoformat()

    return StreamingResponse(
        sync_stream(
            cv=cv,
            paths=paths,
            cfg=cfg,
            secret=secret,
            replace=replace,
            max_concurrency=settings.confluence_max_concurrency(),
            now_iso=now_iso,
            lock_key=lock_key,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/status")
async def get_status(request: Request) -> dict[str, Any]:
    """Return sync status from the manifest meta, with a live ``running`` flag."""
    paths = resolve_paths(request)
    cfg = _effective_config(paths)
    manifest = store.load_manifest(paths)
    meta = manifest.get("meta", {}) if isinstance(manifest, dict) else {}
    configured = bool(cfg.get("base_url")) and bool(
        cfg.get("root_url") or cfg.get("root_page_id")
    )
    key = _sync_lock_key(request)
    running = key in SYNC_LOCKS and SYNC_LOCKS[key].locked()
    return {
        "configured": configured,
        "running": running,
        "last_sync_at": meta.get("last_sync_at"),
        "last_status": meta.get("last_status"),
        "page_count": meta.get("page_count"),
        "root_title": meta.get("root_title"),
    }
