"""FastAPI application factory for CogniVault UI.

Serves the SPA from ``static/`` (same-origin) and exposes the ``/api`` surface.
The browser talks only to this localhost server; config/certs/token never leave
the machine.
"""

from __future__ import annotations

import warnings
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import deps, settings
from .config import PATHS
from .deps import ApiError, api_error_handler
from .routes import (
    chat_routes,
    config_routes,
    env_routes,
    history_routes,
    upload_routes,
)

_STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def _suppress_insecure_warnings() -> None:
    """Silence urllib3/httpx ``verify=False`` noise once at startup.

    Disabling TLS verification is a supported escape hatch for the Sber IFT
    contour; we don't want the warning printed on every request.
    """
    try:
        from urllib3.exceptions import InsecureRequestWarning

        warnings.simplefilter("ignore", InsecureRequestWarning)
    except Exception:  # noqa: BLE001 — urllib3 may be absent; best-effort only
        pass
    warnings.filterwarnings("ignore", message=".*[Uu]nverified HTTPS.*")


def create_app() -> FastAPI:
    _suppress_insecure_warnings()

    app = FastAPI(title="CogniVault UI", version="1.0.0")

    # Render the standard {"error": {...}} envelope for auth/CV failures raised
    # from dependencies or handlers.
    app.add_exception_handler(ApiError, api_error_handler)

    # Bearer-token gate. In LOCAL mode ``get_token`` is a no-op that returns the
    # config-file token (no header required); in SERVER mode it enforces a valid
    # ``Authorization: Bearer`` header (401 otherwise). Attaching it universally
    # keeps local behaviour unchanged while protecting every /api/* in server
    # mode — except public GET /api/config, /api/whoami (self-checks), /healthz,
    # and static assets.
    auth = [Depends(deps.get_token)]

    # Routers first so /api takes precedence over the SPA catch-all mount.
    # config_routes gates PUT/status per-route so GET /api/config stays public.
    app.include_router(config_routes.router)
    app.include_router(chat_routes.router, dependencies=auth)
    app.include_router(history_routes.router, dependencies=auth)
    app.include_router(upload_routes.router, dependencies=auth)
    if not settings.is_server():
        # Env provisioning is a local-only concern; in server mode these routes
        # simply don't exist (the 404 envelope handles them).
        app.include_router(env_routes.router)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        """Liveness/readiness probe for k8s — auth-free, both modes."""
        return {"status": "ok"}

    @app.get("/api/whoami")
    async def whoami(request: Request) -> Any:
        """Resolve the caller's identity.

        LOCAL: always ``{"userId": "local", "ok": true}``. SERVER: validate the
        bearer token against CogniVault — 200 → ``{"userId": <bucket>, "ok":
        true}``, invalid → 401 UNAUTHORIZED, CogniVault down → 503 CV_UNAVAILABLE.
        """
        if not settings.is_server():
            return {"userId": "local", "ok": True}
        token = deps.get_token(request)  # 401 if header missing/malformed
        try:
            valid = await deps.validate_token(token)
        except deps.CVUnavailable:
            return JSONResponse(
                status_code=503,
                content={
                    "error": {
                        "code": "CV_UNAVAILABLE",
                        "message": "CogniVault недоступен",
                    }
                },
            )
        if not valid:
            raise ApiError(401, "UNAUTHORIZED", "нет токена доступа")
        return {"userId": deps.user_bucket(token), "ok": True}

    @app.exception_handler(404)
    async def not_found_handler(request: Request, exc: Any) -> Any:
        """Return the standard error envelope for unknown ``/api`` paths."""
        if request.url.path.startswith("/api"):
            return JSONResponse(
                status_code=404,
                content={
                    "error": {
                        "code": "NOT_FOUND",
                        "message": f"нет такого маршрута: {request.url.path}",
                    }
                },
            )
        # Non-API 404: let the SPA/default handling apply.
        return JSONResponse(status_code=404, content={"detail": "Not Found"})

    # Catch-all for unknown /api/* paths. Registered after every real router but
    # before the static mount so it only fires when nothing else matched. Without
    # it, a non-GET request to an unregistered /api path (e.g. POST /api/env/setup
    # in server mode) would fall through to the static mount and get a bare
    # ``405 {"detail": ...}`` — here it always yields the standard 404 envelope.
    @app.api_route(
        "/api/{_rest:path}",
        methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
    )
    async def api_not_found(request: Request, _rest: str) -> Any:
        raise ApiError(
            404, "NOT_FOUND", f"нет такого маршрута: {request.url.path}"
        )

    # SPA + static assets. Mounted last so it only catches non-/api paths.
    _STATIC_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/", StaticFiles(directory=str(_STATIC_DIR), html=True), name="static")

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    if settings.is_server():
        # Multi-tenant: bind the configured address; per-user dirs are created
        # lazily per request. Ensure the data root exists.
        settings.data_root().mkdir(parents=True, exist_ok=True)
        uvicorn.run(app, host=settings.bind_host(), port=settings.bind_port())
    else:
        # Ensure the data dir exists for a bare `python -m app.main` run.
        PATHS.ensure_dirs()
        uvicorn.run(app, host="127.0.0.1", port=8787)
