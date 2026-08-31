#!/usr/bin/env python3
"""Диагностика KitAI изнутри пода UI. Ничего не меняет, только спрашивает.

Зачем отдельный скрипт, а не `curl`: образ UI — `python:3.12-alpine`, curl в нём
нет, а `httpx` есть (это зависимость приложения). Поэтому проверка на python.

Запуск (переменные берутся из окружения пода, ничего вписывать не надо):

    kubectl exec -n ci05490208-oasis-cognivault deploy/cognivault-ui -- \
        python3 - < deploy/dropapp/kitai-check.py

Что делает по шагам и почему именно так:

1. **Список моделей** (`GET /api/v1/meta/model`). Отвечает на вопрос «существует
   ли вообще имя из KITAI_MODEL на этом контуре» — самая вероятная причина того,
   что запрос принимается, а потом финиширует со статусом `error`.
2. **Минимальный запрос** (`POST /api/v1/query/model` → опрос результата) и
   печать СЫРОГО ответа целиком. Приложение показывает разобранную ошибку, а
   здесь важно увидеть всё: `error`, `response_code`, `response_body` — платформа
   заполняет какое-то одно из них, и какое именно, заранее неизвестно.

Ничего не коммитит: шаг `PUT /commit` намеренно пропущен, чтобы диагностика не
меняла состояние запроса на платформе.
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid

import httpx

HOST = os.environ.get("KITAI_HOST", "").rstrip("/")
MODEL = os.environ.get("KITAI_MODEL", "")
SYSTEM = os.environ.get("KITAI_SYSTEM_NAME", "")
MODULE = os.environ.get("KITAI_MODULE_NAME", "")
# У KitAI может быть СВОЙ сертификат: это другой контур. Пустой KITAI_CERT_PATH
# означает «тот же, что у GigaChat» — ровно как в приложении.
_SHARED_CERT = os.environ.get("GIGACHAT_CERT_PATH", "/certs/client_crt.crt")
_SHARED_KEY = os.environ.get("GIGACHAT_KEY_PATH", "/certs/client_key.key")
_OWN_CERT = os.environ.get("KITAI_CERT_PATH") or ""
_OWN_KEY = os.environ.get("KITAI_KEY_PATH") or ""
# Тот же откат, что в приложении: путь задан, файла нет -> общая пара.
_use_own = bool(_OWN_CERT) and os.path.isfile(_OWN_CERT) and os.path.isfile(_OWN_KEY)
CERT = _OWN_CERT if _use_own else _SHARED_CERT
KEY = _OWN_KEY if _use_own else _SHARED_KEY
TIMEOUT = float(os.environ.get("KITAI_POLL_TIMEOUT", "60"))


def headers() -> dict[str, str]:
    h = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "x-identification-system": SYSTEM,
    }
    if MODULE:
        h["x-identification-module"] = MODULE
    return h


def dump(label: str, value: object) -> None:
    print(f"\n--- {label} ---")
    print(json.dumps(value, ensure_ascii=False, indent=2)[:4000])


def main() -> int:
    print("KITAI_HOST        =", HOST or "(пусто!)")
    print("KITAI_MODEL       =", MODEL or "(пусто!)")
    print("KITAI_SYSTEM_NAME =", SYSTEM or "(пусто!)")
    print("KITAI_MODULE_NAME =", MODULE or "(не задан)")
    # Показываем ФАКТ, а не намерение: приложение при отсутствии файла молча
    # (с WARNING в логе) откатывается на сертификат GigaChat, поэтому «путь
    # задан» и «сертификат используется» — разные вещи.
    wanted = os.environ.get("KITAI_CERT_PATH") or ""
    if wanted and not os.path.isfile(wanted):
        shared = os.environ.get("GIGACHAT_CERT_PATH", "/certs/client_crt.crt")
        print(f"сертификат        = {wanted} | НЕТ ФАЙЛА -> откат на {shared}")
        print("                    (секрет cognivault-kitai-certs не заведён?)")
    else:
        print("сертификат        =", CERT,
              "|", "есть" if os.path.isfile(CERT) else "НЕТ ФАЙЛА",
              "|", "свой у KitAI" if wanted else "общий с GigaChat")
    print("ключ              =", KEY, "|", "есть" if os.path.isfile(KEY) else "НЕТ ФАЙЛА")
    if not HOST or not SYSTEM:
        print("\nНечего проверять: не задан хост или имя системы.")
        return 2

    # Без сертификата httpx падает трейсбеком ещё до первого запроса. Для
    # диагностики это худший исход: непонятно, дело в сертификате или в сети.
    # Поэтому продолжаем БЕЗ клиентского сертификата и говорим об этом — отлуп
    # платформы тогда сам покажет, что причина в нём.
    kwargs: dict[str, object] = {
        "verify": False,
        "timeout": httpx.Timeout(connect=10, read=60, write=30, pool=10),
    }
    if os.path.isfile(CERT) and os.path.isfile(KEY):
        kwargs["cert"] = (CERT, KEY)
    else:
        print("\n!! Клиентский сертификат не найден — иду БЕЗ него.")
        print("   Если платформа ответит 401/403, причина именно в этом.")
    client = httpx.Client(**kwargs)  # type: ignore[arg-type]

    # ── 1. Какие модели вообще есть ────────────────────────────────────────
    with client:
        try:
            r = client.get(f"{HOST}/api/v1/meta/model", headers=headers())
            print(f"\n[1] GET /api/v1/meta/model → HTTP {r.status_code}")
            if r.status_code == 200:
                body = r.json()
                items = body if isinstance(body, list) else (body or {}).get("data") or []
                names = [str(i.get("model_name")) for i in items if isinstance(i, dict)]
                print("    доступно моделей:", len(names))
                for n in names:
                    mark = "  <-- KITAI_MODEL" if n == MODEL else ""
                    print(f"      {n}{mark}")
                if MODEL and MODEL not in names:
                    print(f"\n    !! {MODEL!r} НЕТ в списке — это и есть причина.")
            else:
                print("    тело:", r.text[:1000])
        except Exception as exc:  # noqa: BLE001 — диагностика не должна падать
            print(f"\n[1] GET /api/v1/meta/model — не удалось: {type(exc).__name__}: {exc}")

        # ── 2. Минимальный запрос и СЫРОЙ результат ────────────────────────
        query_id = str(uuid.uuid4())
        payload = {
            "query_id": query_id,
            "model_name": MODEL,
            "messages": [{"role": "user", "content": "Ответь одним словом: тест"}],
            "temperature": 0.05,
            "max_tokens": 32,
        }
        print(f"\n[2] POST /api/v1/query/model  query_id={query_id}")
        try:
            r = client.post(
                f"{HOST}/api/v1/query/model",
                content=json.dumps(payload, ensure_ascii=False).encode(),
                headers=headers(),
            )
            print(f"    → HTTP {r.status_code}")
            if r.status_code != 200:
                print("    тело:", r.text[:1000])
                return 1
        except Exception as exc:  # noqa: BLE001
            print(f"    не удалось: {type(exc).__name__}: {exc}")
            return 1

        deadline = time.time() + TIMEOUT
        last = None
        while time.time() < deadline:
            time.sleep(2)
            r = client.get(f"{HOST}/api/v1/query/{query_id}/result", headers=headers())
            if r.status_code != 200:
                print(f"    опрос → HTTP {r.status_code}: {r.text[:500]}")
                return 1
            last = r.json()
            data = (last or {}).get("data") or {}
            status = data.get("query_status")
            print(f"    статус: {status}  is_final={data.get('is_final')}")
            if status == "finished" or data.get("is_final"):
                break

        # Печатаем ВЕСЬ ответ: причина лежит в одном из error / response_code /
        # response_body, и заранее неизвестно, в каком именно.
        dump("сырой результат", last)
    return 0


if __name__ == "__main__":
    sys.exit(main())
