# CogniVault UI

Local single-user web UI for CogniVault + GigaChat. A small FastAPI server runs
on `127.0.0.1:8787`, serves the SPA from `static/`, and proxies to CogniVault
and GigaChat. Everything — config, certificates, bearer token — stays on
localhost.

## First run (bootstrap)

The bootstrap script uses only the Python standard library, so it runs before
any dependency is installed:

```bash
python3 bootstrap.py
```

It will:

1. create `~/.cognivault-ui/{certs,history,tmp}`,
2. write a default `~/.cognivault-ui/config.json` (only if absent),
3. build a virtualenv at `~/.cognivault-ui/venv`,
4. install `fastapi`, `uvicorn`, `httpx`, `python-multipart` from the SberOSC
   mirror.

Then drop your GigaChat client certificate and key into
`~/.cognivault-ui/certs/` (default names `client_crt.crt` / `client_key.key`)
and set `cognivault.token` in the config (or via the UI).

## SberOSC PyPI mirror

Dependencies install from the SberOSC proxy. Two config values (in
`~/.cognivault-ui/config.json` under `env`, or via **Настройки → Окружение** in
the UI) drive it:

- `env.pip_index_url` — default
  `https://sberosc.sigma.sbrf.ru/repo/pypi/simple` (note the `/repo/` prefix).
- `env.pip_token` — your personal SberOSC token, copied from the profile page
  <https://sberosc.sigma.sbrf.ru/dashboard/profile/>.

Rather than passing `--index-url`/`--trusted-host` inline (which can break
resolution of transitive dependencies), bootstrap and the in-app setup write a
`pip.conf` into the venv and run plain `pip install` with `PIP_CONFIG_FILE`
pointing at it:

```ini
[global]
index-url=https://token:<TOKEN>@sberosc.sigma.sbrf.ru/repo/pypi/simple
trusted-host=sberosc.sigma.sbrf.ru
default-timeout=120
```

The literal username is `token`; the password is your SberOSC token. The token
is never printed to logs — only a redacted `https://token:***@…` form is shown.

Notes:

- Brand-new package versions may be held under a ~3-day SberOSC quarantine
  before they appear in the proxy.
- For libraries that were explicitly ordered / marked «Загружен в Nexus», the
  proxy path may 404; in that case set `env.pip_index_url` to the Nexus mirror
  instead: `https://login:token@nexus-ci.sigma.sbrf.ru/repository/pypi-lib-ext/simple/`.

## Run

```bash
./run.sh
```

which is equivalent to:

```bash
~/.cognivault-ui/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8787
```

Then open **http://localhost:8787**.

> Open the UI only through `http://localhost:8787`. Opening the built SPA via
> `file://` will not work — the browser must talk to this server (same-origin)
> so the `/api` calls and SSE streams resolve.

## Layout

- `app/` — FastAPI app, routers, and clients (CogniVault, GigaChat, RAG).
- `static/` — the built SPA (served at `/`).
- `~/.cognivault-ui/` — runtime data: `config.json`, `certs/`, `history/`,
  `venv/`, `tmp/`.

## RAG — умное расширение контекста

Тумблер RAG в чате — простой вкл/выкл; глубина выбирается **автоматически**, без
каких-либо ручек в интерфейсе (`rag.mode = "auto"`, значение по умолчанию). На
каждый запрос:

- гибридный поиск (`/api/vault/search/hybrid`, с откатом на `search/semantic`),
- результаты группируются по файлам и ранжируются по лучшему совпадению,
- для верхних `max_expanded_files` файлов подтягивается полный текст
  (`/api/vault/content`) и выбирается глубина: **весь файл** (короткий документ
  или ≥3 попаданий, если влезает в бюджет), **раздел** (срез по заголовку из
  `section_path`) или **фрагмент** (исходный чанк);
- всё собирается в один блок под символьный бюджет, вычисляемый из окна модели
  (`gigachat.model_context_tokens`) с запасом на русский текст;
- несколько попаданий в один файл/раздел сливаются в **один** `[Источник N]`.

Каждый источник в UI получает бейдж глубины (`файл` / `раздел` / `фрагмент`) и
неброскую строку вида «контекст: 9 800 симв. · 3 источника».

Ключи в `rag` (все с рабочими значениями по умолчанию — старые конфиги
подхватывают `mode:"auto"` через deep-merge, без миграции):

| Ключ                 | По умолчанию | Назначение                                   |
| -------------------- | ------------ | -------------------------------------------- |
| `mode`               | `"auto"`     | `auto` — умное расширение; иначе legacy       |
| `source`             | `"hybrid"`   | принимается также `semantic` / `context`      |
| `limit`              | `10`         | ширина выборки                                |
| `max_context_chars`  | `24000`      | потолок символьного бюджета                    |
| `file_full_chars`    | `6000`       | порог «взять файл целиком»                     |
| `section_max_chars`  | `4000`       | лимит на срез раздела                          |
| `max_expanded_files` | `2`          | сколько верхних файлов расширять               |
| `min_score`          | `null`       | нижний порог по score (учитывается и в auto)  |

`gigachat.model_context_tokens` (по умолчанию `32768`) участвует в расчёте бюджета.

## API surface

| Method | Path                  | Purpose                              |
| ------ | --------------------- | ------------------------------------ |
| GET    | `/api/config`         | current effective config             |
| PUT    | `/api/config`         | deep-merge + persist a partial config|
| GET    | `/api/status`         | health/cert/env/history status       |
| POST   | `/api/chat`           | streaming chat (SSE), optional RAG   |
| GET    | `/api/history`        | list newest chats                    |
| GET    | `/api/history/{id}`   | load a chat                          |
| DELETE | `/api/history/{id}`   | delete a chat                        |
| POST   | `/api/upload`         | forward a vault zip to CogniVault    |
| POST   | `/api/env/setup`      | provision venv + deps (SSE)          |
| GET    | `/api/env/export`     | download an env backup zip           |
| POST   | `/api/env/import`     | restore an env backup zip (safe)     |
