# Pin the base image (NO `latest` — the SberOSC proxy won't resolve `latest`).
#
# Alpine (musl) instead of Debian-slim: the SberOSC/Aqua scan blocked the
# Debian image on OS packages — glibc (CVE-2026-5450, 9.8 CRIT) and perl
# (CVE-2026-4176, 9.8 CRIT) plus 7 glibc HIGHs. Alpine ships neither glibc
# nor perl and carries a far smaller CVE surface.
#
# Single stage: our deps are pure-python except pydantic-core (a fastapi
# dep), which publishes musllinux wheels — so `pip install` resolves wheels
# with no compiler needed. No builder stage required.
FROM python:3.12-alpine

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv/cognivault-ui

# Контекст сборки — КОРЕНЬ репозитория, а не cognivault-ui/: в образ нужен ещё
# и харнесс оценки из tools/eval, а Docker не умеет COPY выше контекста.
# Корневой .dockerignore (тот же, что у бэкенда) отсекает node_modules и .git.
COPY cognivault-ui/requirements.txt .
# Upgrade pip/setuptools (harden the toolchain), then install pinned deps.
# --only-binary=:all: makes the build fail loudly if any wheel is missing
# rather than silently compiling from source on musl.
RUN pip install --no-cache-dir --upgrade pip setuptools \
 && pip install --no-cache-dir --only-binary=:all: -r requirements.txt

COPY cognivault-ui/app/ app/
COPY cognivault-ui/static/ static/

# Харнесс оценки качества ответов. Лежит в образе, потому что запускать его надо
# ИЗНУТРИ пода: снаружи закрытого контура недоступны ни UI, ни mTLS-эндпоинт
# судьи, а класть файлы в под правами не всегда разрешено. Зависимостей сверх
# уже установленных нет — только stdlib и httpx.
#   python3 -m eval.run --label baseline --ui-url http://localhost:8787
COPY tools/eval/ eval/

# Run as non-root uid:gid 1000 (matches the restricted PodSecurity in the
# namespace). /data is an emptyDir mounted at runtime; fsGroup 1000 makes it
# writable — no chown needed here. On Alpine the numeric USER needs no
# passwd entry.
USER 1000:1000

EXPOSE 8787
ENV COGNIVAULT_UI_MODE=server UI_DATA_DIR=/data

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787"]
