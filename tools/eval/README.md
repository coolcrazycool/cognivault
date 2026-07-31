# tools/eval — оценка качества RAG-ответов (Волна 5, пункты 5.2–5.3)

Харнесс меряет **качество ответа** (генерация + контекст), а не ретрив.
Ретрив-харнесс — отдельный и уже существует: `test/eval/eval.ts` (recall@10 по
`/api/vault/search/*`). Одно другое не заменяет: `eval.ts` отвечает на вопрос
«нашли ли нужный документ», этот — «правильный ли получился ответ».

> **Абсолютным цифрам судьи не доверять.** Метрики выставляет та же LLM
> (GigaChat), что генерирует ответы. Значение «faithfulness 0.78» само по себе
> не значит ничего: судья плохо откалиброван, чувствителен к формулировке
> промпта и шумит между вызовами. Осмысленна только **дельта между двумя
> прогонами** этого же харнесса на том же golden-set и той же версии судейских
> промптов (`metrics.PROMPT_VERSION`). Это же предупреждение печатается в шапке
> каждого отчёта и каждой diff-таблицы.

**Baseline надо снять ДО Волны 3** (план, «Порядок и зависимости»: Волна 5
стартует после Волны 0, baseline до Волны 3, прогоны после 3 и 4).

## Зависимостей нет

Только стандартная библиотека + `httpx` (уже в `cognivault-ui/requirements.txt`).
`gigaragas` **не используется** и ставить его не нужно: закрытый контур,
карантин SberOSC. Метрики и русский сегментатор предложений — свои
(`metrics.py`), NLTK не нужен. Для тестов дополнительно нужен `pytest`
(dev-only, как и в `cognivault-ui/tests`).

## Файлы

| Файл | Назначение |
|---|---|
| `gigachat_client.py` | минимальный mTLS-клиент `chat/completions` (без стриминга) + устойчивый разбор JSON из ответа модели |
| `gen_golden.py` | генератор golden-set: корпус → фрагменты по заголовкам → пары «вопрос / эталон» |
| `metrics.py` | четыре судейские метрики, русский сегментатор предложений, агрегация |
| `run.py` | прогон golden-set через живой UI-API, отчёты `report-<label>.{json,md}`, `--compare` |
| `tests/` | офлайн-тесты (pytest + `httpx.MockTransport`) |

## Порядок работы

```bash
# 0. Поднять стек: бэкенд CogniVault + Qdrant + cognivault-ui, вольт проиндексирован.
#    Проверить, что чат в UI отвечает с включённым RAG.

# 1. Посмотреть, сколько фрагментов даёт корпус (без вызовов GigaChat)
python3 tools/eval/gen_golden.py --dry-run --limit 40

# 2. Сгенерировать golden-set (≈2 пары на фрагмент → 40 фрагментов ≈ 80 пар)
python3 tools/eval/gen_golden.py --out tools/eval/golden.jsonl --limit 40 --seed 42

# 3. ВРУЧНУЮ провалидировать: открыть golden.jsonl и проставить
#    "accepted": true  — вопрос осмысленный, эталон соответствует источнику
#    "accepted": false — мусорный вопрос / эталон не из фрагмента (пара исключается)
#    Оставленный null означает «не проверено» — такие пары в прогон ПОПАДАЮТ.

# 4. Baseline — ДО Волны 3
python3 tools/eval/run.py --label baseline --limit 0 --concurrency 2

# 5. После волны — второй прогон на ТОМ ЖЕ golden.jsonl
python3 tools/eval/run.py --label wave-3

# 6. Сравнить
python3 tools/eval/run.py --compare \
    tools/eval/reports/report-baseline.json \
    tools/eval/reports/report-wave-3.json
```

Отчёты складываются в `tools/eval/reports/` (в git не попадают, см. `.gitignore`).
`golden.jsonl` после ручной валидации имеет смысл закоммитить — прогоны сравнимы
только на одном и том же наборе.

## Схема `golden.jsonl`

По одной паре на строку, UTF-8 без экранирования кириллицы:

```json
{"id": "3f2a9c1b0d-f", "question": "Какой overlap у чанков?", "ground_truth": "Overlap отсутствует.", "kind": "factual", "source_path": "docs/indexing.md", "section_path": "Индексация > Чанкер", "accepted": null}
```

| Поле | Тип | Смысл |
|---|---|---|
| `id` | string | `<sha1(path::section::текст)[:10]>-f` / `-p` — стабилен между перегенерациями |
| `question` | string | самодостаточный вопрос на русском |
| `ground_truth` | string | эталонный ответ 1–3 предложения, строго по фрагменту |
| `kind` | `"factual"` \| `"practical"` | тип вопроса (по одному каждого на фрагмент) |
| `source_path` | string | путь документа-источника в вольте |
| `section_path` | string | breadcrumd раздела `H1 > H2 > H3` |
| `accepted` | `true` \| `false` \| `null` | ручная валидация; `false` → пара не участвует в прогоне |

## Схема отчёта

`report-<label>.json`:

```json
{
  "label": "baseline",
  "generated_at": "2026-07-31T12:00:00+00:00",
  "golden": "tools/eval/golden.jsonl",
  "ui_url": "http://localhost:8080",
  "judge_model": "GigaChat-3-Ultra-preview",
  "prompt_version": "v1",
  "counts": {"total": 80, "failed": 2, "evaluated": 78},
  "aggregate": {
    "faithfulness_ru": 0.71,
    "answer_relevancy_ru": 0.83,
    "context_precision": 0.55,
    "context_recall": 0.64,
    "retrieval_hit": 0.79
  },
  "coverage": {"faithfulness_ru": 78, "...": 0},
  "samples": [
    {
      "id": "3f2a9c1b0d-f", "kind": "factual",
      "question": "…", "ground_truth": "…", "answer": "…",
      "source_path": "docs/indexing.md", "section_path": "…", "accepted": null,
      "sources": [{"n": 1, "path": "…", "section_path": "…", "score": 0.71, "depth": "section"}],
      "context_count": 3, "retrieval_hit": true,
      "metrics": {"faithfulness_ru": {"name": "…", "score": 0.75, "raw": {...}, "error": ""}},
      "error": "", "latency_ms": 5231, "event_order": ["meta", "sources", "token", "done"]
    }
  ],
  "extra": {"concurrency": 2, "context_chars": 4000, "context_fetch": true, "judge_calls": 320}
}
```

`report-<label>.md` — та же информация человекочитаемо: дисклеймер про
абсолютные значения, таблица средних, правило диагностики, таблица по парам
(с колонкой «чанк найден»), список ошибок прогона.

`compare-<A>-vs-<B>.md` — таблица `| Метрика | A | B | Δ | Знак |`, где знак
`▲` — рост, `▼` — падение, `≈` — движение внутри шумовой полосы (< 0.02),
`—` — метрика не посчиталась. Диф предупреждает, если прогоны сделаны разными
версиями судейских промптов или на разных golden-set.

### Метрики

| Метрика | Что считает | Как |
|---|---|---|
| `faithfulness_ru` | доля утверждений ответа, подтверждённых контекстом | ответ режется своим русским сегментатором на предложения, судья ставит 0/1 каждому |
| `answer_relevancy_ru` | отвечает ли ответ на заданный вопрос | судья ставит 1–5 → `(score-1)/4`; уклончивый ответ → 0 |
| `context_precision` | доля выданных фрагментов, релевантных вопросу | судья помечает каждый источник 0/1 |
| `context_recall` | покрыт ли `ground_truth` контекстом | эталон режется на предложения, судья проверяет выводимость каждого |
| `retrieval_hit` | считается локально, без судьи | попал ли `source_path` golden-пары в выданные `sources` |

`retrieval_hit` — ключ к правилу диагностики из плана:
**нужный чанк был в контексте, а ответ неверен → чинить генерацию; не был →
чинить ретрив.**

### Ограничение: текст контекста восстанавливается приближённо

SSE-событие `sources` отдаёт только метаданные (`n, title, path, section_path,
score, depth`, + `url`/`grade`), самих чанков в нём нет. Поэтому `run.py`
дотягивает текст источника из бэкенда (`GET /api/vault/content`) и вырезает
раздел по `section_path` (или берёт начало файла, кап `--context-chars`).
Это **близко, но не байт-в-байт** тот текст, который видела модель. Для A/B это
не помеха — приближение одинаково в обоих прогонах, — но объясняет, почему
`context_precision` может отличаться от «идеальной» оценки. Флаг
`--no-context-fetch` отключает дотяжку (тогда метрики по контексту бессмысленны).

## Переменные окружения

Общее правило: **CLI-аргумент → ENV → `~/.cognivault-ui/config.json` → дефолт.**

### GigaChat (судья и генератор вопросов)

| Переменная | Обяз. | Смысл |
|---|---|---|
| `GIGACHAT_BASE_URL` | да* | напр. `https://gigachat-ift.sberdevices.delta.sbrf.ru/v1` |
| `GIGACHAT_CERT_PATH` | да | клиентский сертификат PEM — это и есть аутентификация (bearer-токена нет) |
| `GIGACHAT_KEY_PATH` | да | приватный ключ PEM |
| `GIGACHAT_KEY_PASSPHRASE` | нет | пароль ключа (тогда клиент строит `ssl.SSLContext`) |
| `GIGACHAT_CA_PATH` | нет | CA-бандл для проверки сервера |
| `GIGACHAT_VERIFY_SSL` | нет | `true`/`false`; по умолчанию берётся из config.json |
| `GIGACHAT_MODEL` | да* | модель по умолчанию (та же, что в чате) |
| `EVAL_JUDGE_MODEL` | нет | **переопределяет** модель-судью поверх всего остального |
| `EVAL_JUDGE_TEMPERATURE` | нет | по умолчанию `0` |
| `EVAL_JUDGE_MAX_TOKENS` | нет | по умолчанию `1024` |
| `EVAL_JUDGE_TIMEOUT` | нет | таймаут чтения, сек, по умолчанию `120` |

\* можно не задавать, если есть `~/.cognivault-ui/config.json` с секцией
`gigachat` — значения берутся оттуда.

### Бэкенд CogniVault (корпус для golden-set и текст источников)

| Переменная | Смысл |
|---|---|
| `COGNIVAULT_BASE_URL` | напр. `http://localhost:3000` (или `--base-url` / `--backend-url`) |
| `COGNIVAULT_TOKEN` (или `COGNIVAULT_API_KEY`) | Bearer-токен бэкенда |

### UI (прогон вопросов)

| Переменная | Смысл |
|---|---|
| `COGNIVAULT_UI_URL` | база UI, по умолчанию `http://localhost:8080` (или `--ui-url`) |
| `COGNIVAULT_UI_TOKEN` | Bearer-токен UI в server-режиме; в local-режиме не нужен |
| `COGNIVAULT_UI_CONFIG` | путь к `config.json` UI, если он не в `~/.cognivault-ui/` |

## Требования к контуру

* Клиентские **mTLS-сертификаты** GigaChat (`*.crt` + `*.key`) должны лежать на
  машине, откуда запускается харнесс, и быть доступны на чтение. Без них
  `gen_golden.py` и `run.py` падают сразу с `GIGACHAT_CERT_MISSING`
  (чистые функции модулей при этом остаются работоспособны — тесты офлайн).
* Сеть до GigaChat (VPN/корпоративный контур), до бэкенда и до UI.
* Вольт **проиндексирован** — иначе `sources` будут пустыми и все метрики уедут в 0.
* Стоимость прогона: ~4 судейских вызова на пару (+1 генерация на фрагмент).
  80 пар ≈ 320 вызовов — держите `--concurrency` маленьким (2–3), иначе GigaChat
  начнёт отдавать 429 (клиент их ретраит с backoff, но это лишнее время).

## CLI

```
gen_golden.py --out PATH --limit N --seed N --base-url URL --token TOKEN --dry-run
              [--concurrency N] [--max-chars N] [--min-chars N] [--ext .md,.txt] [--config PATH]

run.py --golden PATH --label NAME --ui-url URL --token TOKEN --limit N
       --concurrency N --out-dir DIR
       [--include-rejected] [--backend-url URL] [--backend-token TOKEN]
       [--no-context-fetch] [--context-chars N] [--config PATH]
run.py --compare A.json B.json [--out-dir DIR]
```

## Тесты

```bash
python3 -m compileall -q tools/eval
python3 -m pytest tools/eval/tests -q
```

Тесты полностью офлайн: GigaChat и REST мокаются через `httpx.MockTransport`,
судья — через стаб. Покрыто: сегментатор предложений, разбор SSE, устойчивый
разбор JSON (```json-обёртка, преамбула, битый), агрегация метрик, генерация
diff-таблицы, markdown-сплиттер и форма строк golden.jsonl.

## Что менять осторожно

Промпты судьи (`metrics.py`) версионируются `PROMPT_VERSION`. Меняете промпт —
**поднимайте версию**: старые отчёты после этого несравнимы с новыми, и
`--compare` об этом предупредит.
