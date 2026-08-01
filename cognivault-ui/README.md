# CogniVault UI

Chat UI for CogniVault + GigaChat. A small FastAPI server serves the SPA from
`static/`, proxies to the CogniVault backend and to GigaChat over mTLS, and runs
the RAG pipeline (retrieval → grading → context assembly) itself.

## Two modes

`COGNIVAULT_UI_MODE` (default `local`) selects how the service is configured and
who it serves. `app/settings.py` is authoritative.

| | `local` | `server` |
| --- | --- | --- |
| Who it serves | one person, on their own machine | many users behind one deployment |
| Bind | `127.0.0.1:8787` (`run.sh`) | `0.0.0.0:8787` (`UI_HOST`/`UI_PORT`) |
| Auth | none — the CogniVault token sits in the config | `Authorization: Bearer <cv-token>` on every `/api` call; the token *is* the tenant id, validated against the backend |
| Config source | `~/.cognivault-ui/config.json`, deep-merged over `DEFAULT_CONFIG` | built from env by `settings.server_config()`, with per-user overrides merged on top |
| Data | `~/.cognivault-ui/{certs,history,tmp}` | `$UI_DATA_DIR/users/<sha256(token)[:16]>/{config.json,history,certs,tmp,confluence,rag_log.jsonl}` |
| `/api/env/*` | available | not registered (local-only concern) |

Server mode is what the cluster runs (`Dockerfile` → `COGNIVAULT_UI_MODE=server`,
`UI_DATA_DIR=/data`, `uvicorn app.main:app --host 0.0.0.0 --port 8787`); the
manifests and the full deployment procedure live in
[`deploy/dropapp/README.md`](../deploy/dropapp/README.md). The rest of this file
describes the local mode.

## First run (bootstrap, local mode)

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

> Caveat: `bootstrap.py` carries its own copy of `DEFAULT_CONFIG` (it must stay
> stdlib-only, so it cannot import `app/config.py`), and that copy has drifted —
> it writes `rag.source: "semantic"`, `rag.limit: 5`, `rag.max_context_chars:
> 12000` and no `prompts` block. Since a written value wins over the built-in
> default on deep-merge, a fresh install starts with a lower context budget than
> `app/config.py` intends. `mode` is not written at all, so the pipeline still
> runs in `auto` (where `source`/`limit` are ignored). Fix by editing
> `~/.cognivault-ui/config.json` or the corresponding fields in the UI.

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

## Run (local mode)

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
  `app/rag.py` assembles the context, `app/rag_pipeline.py` holds the two hidden
  GigaChat calls, `app/settings.py` owns mode + config policy.
- `static/` — the built SPA (served at `/`).
- `~/.cognivault-ui/` — runtime data in local mode: `config.json`, `certs/`,
  `history/`, `venv/`, `tmp/`. In server mode the same tree lives per user under
  `$UI_DATA_DIR/users/<hash>/`.

## Конвейер чата

Тумблер RAG в чате — простой вкл/выкл (`rag.default_on` задаёт начальное
положение). При включённом RAG на каждый вопрос происходит **два скрытых вызова
GigaChat** сверх самой генерации ответа (`app/rag_pipeline.py`):

1. **Интент + переписывание вопроса** (`condense`, temperature 0, таймаут 10 с,
   история — последние 6 реплик). Модель классифицирует реплику как
   `smalltalk` / `clarify` / `kb_question` и, для последнего, переписывает её в
   самодостаточный поисковый запрос (подставляет вместо местоимений конкретные
   названия из истории). `smalltalk` и `clarify` поиск вообще не запускают.
   Первая реплика без истории вызов пропускает.
2. **Батч-грейдер релевантности** (`grade`, таймаут 20 с) — он же реранкер.
   Все кандидаты оцениваются по шкале 1–5 одним вызовом; при >15 кандидатах
   они режутся на батчи по 12 и оцениваются параллельно (40 кандидатов → 4 вызова).

Между ними — сам поиск: `POST /api/vault/search/hybrid` c
`group_by_section: true` и `section_max_chars` (откат на `search/semantic`),
ширина выборки — `rag.rerank_candidates`.

Отбор после грейдинга (`select`, чистая функция): проходят фрагменты с оценкой
≥ `grader_threshold`; если таких нет — порог опускается до 3; топ-`grader_keep_top`
по рангу поиска добавляются всегда; в контекст попадает не больше 5 фрагментов.
Если не прошло ничего — генерация **не вызывается**, пользователь получает
готовый ответ «в доступных мне документах ответа на этот вопрос не нашлось»
(`finish_reason: "no_context"`).

Дальше отобранное расширяется до читаемых блоков: для верхних
`max_expanded_files` файлов подтягивается полный текст (`/api/vault/content`) и
выбирается глубина — **весь файл** (короткий документ или ≥3 попаданий, если
влезает в бюджет), **раздел** (`section_text` из ответа бэкенда) или
**фрагмент** (исходный чанк). Всё собирается в один блок под символьный бюджет,
вычисляемый из окна модели (`gigachat.model_context_tokens`) с запасом на
русский текст. Ответ обязан ссылаться на источники как `[Источник N]` —
это часть системного промпта, номера вне списка источников в UI не линкуются.

Каждый источник в UI получает бейдж глубины (`файл` / `раздел` / `фрагмент`) и
неброскую строку вида «контекст: 9 800 симв. · 3 источника». SSE-события идут в
порядке `meta` → (`notice` | `sources`) → `token`… → `done`; `sources`
эмитится **до** первого токена и несёт `n`, `title`, `path`, `section_path`,
`score`, `depth`, `grade` (оценка грейдера) и `url` для страниц, приехавших из
Confluence.

Отказоустойчивость: любая ошибка скрытого вызова (кривой JSON, таймаут,
транспорт) логируется предупреждением и не ломает ответ — condense
деградирует к сырому вопросу, грейдер пропускает кандидаты как есть.

## Настройки в UI

Панель настроек редактирует конфиг через `PUT /api/config` тремя независимыми
блоками. В server-режиме сохраняется **только** список
`settings.USER_EDITABLE_KEYS` и **только в конфиг вызывающего пользователя**
(`$UI_DATA_DIR/users/<hash>/config.json`); всё остальное из тела запроса
отбрасывается и возвращается в поле `ignored`. В local-режиме пишется
`~/.cognivault-ui/config.json` целиком.

**Модель и генерация** (`gigachat.*`): `model`, `temperature` (0–2),
`max_tokens` (1…`model_context_tokens`). Поле `model_context_tokens` показано,
но заблокировано — его задаёт администратор.

**Поиск и контекст** (`rag.*`):

| Ключ | По умолчанию | Назначение |
| --- | --- | --- |
| `default_on` | `false` | начальное положение тумблера RAG |
| `limit` | `10` | ширина выборки (только legacy-режим `mode != "auto"`) |
| `rerank_candidates` | `40` | сколько кандидатов запрашивать у бэкенда и отдавать грейдеру |
| `grader_enabled` | `true` | включить батч-грейдер |
| `grader_threshold` | `4` | минимальная оценка (1–5), с которой фрагмент проходит |
| `grader_keep_top` | `2` | сколько верхних по рангу поиска пропускать всегда |
| `condense_enabled` | `true` | включить интент + переписывание вопроса |
| `max_context_chars` | `24000` | потолок символьного бюджета |
| `file_full_chars` | `6000` | порог «взять файл целиком» |
| `section_max_chars` | `4000` | лимит на текст раздела |
| `max_expanded_files` | `2` | сколько верхних файлов расширять |
| `min_score` | `null` | нижний порог по score |

**Промпты** (`prompts.*`) — ровно два редактируемых: `system` (правила ответа,
включая формат `[Источник N]`) и `context_reminder` (напоминание между блоком
источников и вопросом). Пустое поле или кнопка «Сбросить к стандартному»
возвращают встроенный текст (`null` в конфиге, а не копия строки), рядом
показывается бейдж «изменён». Промпты самого конвейера (condense и грейдер)
показаны в свёрнутом блоке **только для чтения**: их ответ разбирается как JSON,
поэтому править их из UI нельзя.

Ключи, которые UI показывает заблокированными (`ADMIN_LOCKED_KEYS`):
`cognivault.base_url`/`token`, все `gigachat.*` про адрес и сертификаты,
`gigachat.model_context_tokens`, `rag.mode`, `rag.source`, `rag.token_budget`,
`env.*`. В server-режиме они приходят из переменных окружения пода.

Границы валидации (`settings.validate_user_overrides`): `limit` и
`rerank_candidates` 1–100, `grader_threshold` 1–5, `grader_keep_top` 0–10,
`max_expanded_files` 0–10, `max_context_chars` 500–200000, `file_full_chars` и
`section_max_chars` 100–100000, `min_score` 0–1 или `null`, промпты ≤20000
символов.

Поскольку ручки грейдера и ширина ретрива живут в конфиге пользователя, A/B двух
наборов настроек делается без пересборки образа — см. `tools/eval/README.md`.

## API surface

| Method | Path                        | Purpose                                       |
| ------ | --------------------------- | --------------------------------------------- |
| GET    | `/healthz`                  | liveness/readiness probe                       |
| GET    | `/api/whoami`               | identity; in server mode validates the token   |
| GET    | `/api/config`               | effective config + defaults, locked keys, read-only prompts |
| PUT    | `/api/config`               | deep-merge + persist a partial config          |
| GET    | `/api/status`               | health/cert/env/history status                 |
| POST   | `/api/chat`                 | streaming chat (SSE), optional RAG             |
| POST   | `/api/feedback`             | 👍/👎 on an answer → `rag_log.jsonl`           |
| GET    | `/api/history`              | list newest chats                              |
| GET    | `/api/history/{id}`         | load a chat                                    |
| DELETE | `/api/history/{id}`         | delete a chat                                  |
| POST   | `/api/upload`               | forward a vault zip to CogniVault              |
| GET    | `/api/confluence/config`    | current Confluence source config (no secrets)  |
| PUT    | `/api/confluence/config`    | save Confluence credentials + root link        |
| POST   | `/api/confluence/validate`  | check credentials / resolve the root page      |
| POST   | `/api/confluence/sync`      | run a sync, streaming progress (SSE)           |
| GET    | `/api/confluence/status`    | last sync result and manifest counters         |
| POST   | `/api/env/setup`            | provision venv + deps (SSE) — local only       |
| GET    | `/api/env/export`           | download an env backup zip — local only        |
| POST   | `/api/env/import`           | restore an env backup zip — local only         |

`/api/confluence/*` is registered only when the `CONFLUENCE_ENABLED` admin flag
is on (default), `/api/env/*` only in local mode.
