"""Прогон харнесса оценки из UI: старт, статус, выгрузка отчёта.

Три маршрута вместо одного, потому что прогон долгий (47 пар × ~4 судейских
вызова): один HTTP-запрос его не переживёт, а держать соединение открытым
несколько минут — верный способ получить обрыв на прокси. Форма та же, что у
переиндексации: старт → опрос статуса → результат.

Отчёты пишутся в каталог ВЫЗЫВАЮЩЕГО (`AppPaths.root/eval-reports`): прогон
идёт под его токеном и его настройками, значит и результат принадлежит ему.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, Request
from fastapi.responses import FileResponse, JSONResponse

from .. import eval_runner, settings
from ..deps import get_token, resolve_paths

log = logging.getLogger("cognivault-ui.eval")

router = APIRouter(prefix="/api/eval")


def _error(status: int, code: str, message: str, detail: str | None = None) -> JSONResponse:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if detail is not None:
        body["error"]["detail"] = detail
    return JSONResponse(status_code=status, content=body)


def _reports_dir(request: Request) -> Path:
    return Path(resolve_paths(request).root) / "eval-reports"


@router.post("/run")
async def start_eval(
    request: Request,
    payload: dict[str, Any] = Body(default_factory=dict),
    token: str = Depends(get_token),
) -> Any:
    """Запустить прогон в фоне и сразу вернуть его статус."""
    if not eval_runner.available():
        return _error(
            501,
            "EVAL_NOT_AVAILABLE",
            "Харнесс оценки не входит в этот образ",
            "Нужен образ UI, собранный вместе с tools/eval",
        )

    label = str(payload.get("label") or "run").strip()
    if not eval_runner.valid_label(label):
        return _error(
            400,
            "EVAL_BAD_LABEL",
            "Метка может содержать латиницу, цифры, точку, дефис и подчёркивание",
            label,
        )

    limit = payload.get("limit")
    try:
        limit_int = max(0, int(limit)) if limit is not None else 0
    except (TypeError, ValueError):
        return _error(400, "EVAL_BAD_LIMIT", "limit должен быть целым числом", str(limit))

    if eval_runner.RUNNER.busy():
        return _error(409, "EVAL_BUSY", "Прогон уже идёт — дождитесь его окончания")

    out_dir = _reports_dir(request)
    paths = resolve_paths(request)
    argv = [
        "--label", label,
        "--ui-url", f"http://127.0.0.1:{settings.bind_port()}",
        "--out-dir", str(out_dir),
        "--limit", str(limit_int),
        "--concurrency", "2",
        # Фактический контекст хода берётся из лога ЭТОГО пользователя — иначе
        # метрики по контексту считались бы по чужим ходам или по фолбэку.
        "--rag-log", str(Path(paths.root) / "rag_log.jsonl"),
    ]
    if token:
        # Прогон обязан идти под токеном вызывающего: настройки грейдера и
        # промпты хранятся пер-пользовательски, и без этого A/B не имеет смысла.
        argv += ["--token", token]

    try:
        job = eval_runner.RUNNER.start(label=label, argv=argv, out_dir=out_dir)
    except RuntimeError as exc:
        return _error(409, "EVAL_BUSY", str(exc))
    except OSError as exc:
        # Каталог отчётов лежит в /data, а он монтируется извне. Без тома или с
        # чужими правами это не «внутренняя ошибка», а понятная проблема
        # развёртывания — и сказать о ней надо так, чтобы её было где искать.
        log.warning("eval: каталог отчётов недоступен (%s): %s", out_dir, exc)
        return _error(
            503,
            "EVAL_NO_STORAGE",
            "Некуда писать отчёты — каталог данных недоступен",
            f"{out_dir}: {exc}",
        )
    log.info("eval: запущен прогон %r (limit=%s)", label, limit_int)
    return job.to_dict()


@router.get("/status")
async def eval_status(request: Request, _token: str = Depends(get_token)) -> Any:
    """Статус текущего/последнего прогона плюс список готовых отчётов."""
    job = eval_runner.RUNNER.job
    out_dir = _reports_dir(request)
    reports = sorted(p.name for p in out_dir.glob("report-*.*")) if out_dir.is_dir() else []
    return {
        "available": eval_runner.available(),
        "job": job.to_dict() if job else None,
        "reports": reports,
    }


@router.get("/report")
async def eval_report(
    request: Request, name: str = "", _token: str = Depends(get_token)
) -> Any:
    """Отдать готовый отчёт на скачивание.

    Имя проверяется по белому списку из каталога, а не склеивается с ним: любая
    склейка пути с пользовательским вводом — это обход каталога, а тут ещё и
    каталог с чужими данными рядом.
    """
    out_dir = _reports_dir(request)
    if not out_dir.is_dir():
        return _error(404, "EVAL_NO_REPORTS", "Отчётов пока нет")
    allowed = {p.name: p for p in out_dir.glob("report-*.*")}
    target = allowed.get(name)
    if target is None:
        return _error(404, "EVAL_NO_REPORT", "Такого отчёта нет", name)
    media = "text/markdown" if target.suffix == ".md" else "application/json"
    return FileResponse(target, media_type=media, filename=target.name)
