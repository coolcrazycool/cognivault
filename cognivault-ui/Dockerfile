# Pin the base image (NO `latest` — the SberOSC proxy won't resolve `latest`).
# Single stage: all deps are pure-python (fastapi/uvicorn/httpx/python-multipart),
# nothing to compile, so a builder stage buys us nothing.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv/cognivault-ui

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ app/
COPY static/ static/

# Run as non-root uid:gid 1000 (matches the restricted PodSecurity in the
# namespace). /data is an emptyDir mounted at runtime; fsGroup 1000 makes it
# writable — no chown needed here.
USER 1000:1000

EXPOSE 8787
ENV COGNIVAULT_UI_MODE=server UI_DATA_DIR=/data

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787"]
