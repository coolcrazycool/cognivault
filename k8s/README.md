> ## ⚠️ НАБОР УСТАРЕЛ
>
> Актуальный набор манифестов — **[`deploy/dropapp/`](../deploy/dropapp/README.md)**.
> Он полный (бэкенд + UI + Service + Ingress + egress), с актуальными пинами образов
> `sha-f8a989d`. Разворачивайте окружение по нему.
>
> Файлы в `k8s/` оставлены **для истории и отката**; в них нет манифестов UI, а образ
> бэкенда запинен на старый тег. Ничего отсюда не применяйте, не сверившись
> с `deploy/dropapp/`.

# Раскатка CogniVault в OpenShift (проект `ci05490208-oasis-cognivault`)

Манифесты для развёртывания CogniVault с GigaChat‑эмбеддингами в OpenShift
(Managed DropApp, среда функционального тестирования). Qdrant — **внешний**
(DropApp, Basic auth, см. раздел «Внешний Qdrant»); доступ к приложению через
Ingress, образ идёт через SberOSC (сегмент sigma).

## Что разворачиваем

| Файл | Ресурс | Назначение |
|------|--------|-----------|
| `00-configmap.yaml` | ConfigMap | Несекретные переменные окружения (порт, Qdrant URL, GigaChat) |
| `01-secret.example.yaml` | Secret (шаблон) | mTLS‑сертификаты GigaChat — **не применять как есть** |
| `02-pvc.yaml` | PVC (RWO, 5Gi) | `/data`: `users.json`, SQLite‑индексы, волты |
| `08-qdrant.yaml` | StatefulSet + Service + PVC | Qdrant в кластере — **больше не используется** (перешли на внешний), оставлен как откат |
| `03-deployment.yaml` | Deployment | Под приложения (1 реплика) |
| `04-service.yaml` | Service | ClusterIP :3000 |
| `05-ingress.yaml` | Ingress | Внешний доступ (подставить host) |
| `06-serviceentry-egress.yaml` | ServiceEntry (опц.) | Разрешить egress к GigaChat и внешнему Qdrant, если mesh их блокирует |
| `07-build.yaml` | ImageStream + BuildConfig | Сборка образа силами кластера (путь B) |

## Предпосылки

- `oc` CLI, установленный локально, и залогиненность: `oc login <api-url> --token=<token>`.
- Доступ к проекту: `oc project ci05490208-oasis-cognivault`.
- Токен **SberOSC** (сегмент sigma, из раздела «Профиль») — кластер тянет через него образы.
- Права влить `feat/gigachat-integration` в `main` на GitHub (или собрать образ ветки иначе) —
  образ собирается на GitHub Actions и публикуется в ghcr; пакет ghcr сделать **публичным**.
- Реквизиты GigaChat: сертификат `client_crt.crt` + ключ `client_key.key` (+ по возможности CA‑бандл).
- Размерность вектора `EmbeddingsGigaR` — уже проставлена: `EMBEDDING_DIMENSIONS=2560`.

---

## Шаг 1. Образ приложения — ghcr через прокси SberOSC

Кластер — обычный **Kubernetes без OpenShift-сборки** (нет `BuildConfig`/`ImageStream`),
поэтому собрать образ внутри кластера нельзя. Внутренний пуш тоже не нужен. Схема:

1. Образ собирается **на GitHub Actions** (обычный `Dockerfile`, открытый интернет) и
   публикуется в **`ghcr.io/coolcrazycool/cognivault`**. CI триггерится на пуш в `main`,
   тегирует `sha-<gitsha>` и `latest`. Чтобы образ содержал GigaChat — влейте ветку
   `feat/gigachat-integration` в `main` (или добавьте ветку/тег в триггеры workflow).
2. SberOSC проксирует ghcr, и кластер тянет образ как
   **`sberosc.sigma.sbrf.ru/ghcr.io/coolcrazycool/cognivault:<sha-тег>`** (см. `03-deployment.yaml`).

Обязательно:
- **пакет ghcr — публичный** (Settings пакета → Change visibility → Public), иначе SberOSC не стянет;
- **тег конкретный** (`sha-…`), не `latest` — SberOSC `latest` не проксирует;
- pull-secret **`sberosc-pull`** (форма Image pull secret: server `sberosc.sigma.sbrf.ru`,
  user `token`, password — токен SberOSC), см. Шаг 4;
- первый пул запускает **сканирование** (следите на `sberosc.sigma.sbrf.ru/dashboard`);
  очень свежие артефакты (младше ~3 дней) прокси может временно не отдавать.

> **Не забудьте** подставить реальный `sha-…` тег в `image:` в `03-deployment.yaml`.

### Устаревшие файлы сборки (не для этого кластера)

`Dockerfile.sberosc`, `.npmrc.sberosc.example`, `07-build.yaml` были заготовлены под
сборку внутри кластера. На **этом** (ванильном) кластере `07-build.yaml` (BuildConfig/
ImageStream) **не применяется** — оставлены только как справка для полноценного OpenShift.

---

## Шаг 2. Секрет с сертификатами GigaChat

Не применяйте `01-secret.example.yaml` — создайте секрет из реальных PEM‑файлов:

```bash
# Имена ключей = имена локальных cert-файлов (client_crt.crt / client_key.key).
oc create secret generic cognivault-gigachat-certs \
  -n ci05490208-oasis-cognivault \
  --from-file=./certs/client_crt.crt \
  --from-file=./certs/client_key.key
# опционально, если есть CA‑бандл:
#  --from-file=./certs/ca.pem
# опционально, если ключ с паролем:
#  --from-literal=key.passphrase='...'
```

Если добавили `ca.pem` — раскомментируйте `GIGACHAT_CA_PATH` в `00-configmap.yaml`
и верните `GIGACHAT_VERIFY_SSL: "true"`.

---

## Шаг 3. Правки конфигурации перед применением

`00-configmap.yaml` уже заполнен проверенными значениями (`EMBEDDING_DIMENSIONS: 2560`,
`GIGACHAT_MODEL: EmbeddingsGigaR`, `GIGACHAT_VERIFY_SSL: "false"`,
`GIGACHAT_MAX_EMBEDDING_TOKENS: "3300"`) — менять по умолчанию нечего.
(3300 cl100k ≈ 4000 токенов GigaChat при контексте модели 4096; прежнее значение
2048 было занижено и просто не использовало контекст.)

Остаётся только `05-ingress.yaml`:
- `host` — домен, выданный проекту (обычно `cognivault-<namespace>.apps.<домен>`).

Qdrant — **внешний** (DropApp), см. раздел «Внешний Qdrant» ниже.

---

## Внешний Qdrant (Basic auth + TLS)

Приложение ходит во внешний Qdrant в DropApp:

- `QDRANT_URL: "https://tsled-oasis0001.esrt.sber.ru:6433"` (в `00-configmap.yaml`);
- резерв — `https://tsled-oasis0002.esrt.sber.ru:6433`. Клиент `QdrantClient` принимает
  **ровно один** URL, клиентской балансировки нет: переключение — правка `QDRANT_URL`
  + `kubectl rollout restart deploy/cognivault`;
- перед Qdrant стоит **реверс-прокси с HTTP Basic** (сам Qdrant умеет только заголовок
  `api-key`). Приложение шлёт `Authorization: Basic base64(username:password)`;
- креды берутся из секрета **`vectordb-creds`** (ключи `username` / `password`) через
  `secretKeyRef` → `QDRANT_USERNAME` / `QDRANT_PASSWORD`. Задавать **оба или ни одного**:
  при одном приложение падает на валидации конфига с внятным сообщением. Пароль нигде
  не логируется — в логах есть только `qdrantAuth: "basic" | "none"`;
- `QDRANT_TIMEOUT_MS` (по умолчанию `30000`) — таймаут запроса; дефолт клиента 300 с
  слишком велик для внешнего хопа;
- если mesh режет egress (`REGISTRY_ONLY`) — примените `06-serviceentry-egress.yaml`,
  там теперь есть ServiceEntry на **оба** хоста Qdrant (порт 6433, `protocol: TLS`,
  SNI passthrough; DestinationRule с origination TLS добавлять НЕЛЬЗЯ — TLS терминирует
  само приложение).

### TLS: сертификат внутреннего УЦ

Qdrant отдаёт сертификат внутреннего УЦ Сбера, которого нет в бандле Node. Настроить
доверие **из кода нельзя**: `fetch` в Node 22 ходит через undici, публичного `Agent`
для подмены CA нет, а `NODE_EXTRA_CA_CERTS` читается **только при старте процесса**.
Поэтому переменной `QDRANT_CA_PATH` в конфиге нет — вопрос решается на уровне пода.

**Штатный путь — смонтировать CA и указать `NODE_EXTRA_CA_CERTS`:**

```bash
kubectl create secret generic sber-ca -n ci05490208-oasis-cognivault \
  --from-file=sber-ca.pem=./certs/sber-ca.pem
```

```yaml
# в Deployment cognivault
          env:
            - name: NODE_EXTRA_CA_CERTS
              value: /certs-ca/sber-ca.pem
          volumeMounts:
            - name: sber-ca
              mountPath: /certs-ca
              readOnly: true
      volumes:
        - name: sber-ca
          secret:
            secretName: sber-ca
```

**Временный костыль — `NODE_TLS_REJECT_UNAUTHORIZED=0`:**

```yaml
          env:
            - name: NODE_TLS_REJECT_UNAUTHORIZED
              value: "0"
```

> ⚠️ Это **глобальный** тумблер процесса: он отключает проверку сертификата не только
> для Qdrant, но и **для GigaChat** — MITM становится незаметен. Сейчас в проме уже стоит
> `GIGACHAT_VERIFY_SSL: "false"`, так что регрессии по факту нет, но осознавать это надо.
> Как только появится CA-бандл — убрать переменную и перейти на `NODE_EXTRA_CA_CERTS`
> (и заодно вернуть `GIGACHAT_VERIFY_SSL: "true"` + `GIGACHAT_CA_PATH`).

### Проверка связности из подов (curl в образах нет)

Достаём креды из секрета в локальные переменные (не светим их в аргументах внутри пода):

```bash
NS=ci05490208-oasis-cognivault
QU=$(kubectl get secret vectordb-creds -n $NS -o jsonpath='{.data.username}' | base64 -d)
QP=$(kubectl get secret vectordb-creds -n $NS -o jsonpath='{.data.password}' | base64 -d)
QAUTH=$(printf '%s:%s' "$QU" "$QP" | base64 | tr -d '\n')
```

**Бэкенд-под (`node:22-slim`) — есть `node`.** Берёт `QDRANT_URL`/креды прямо из env пода,
то есть проверяет ровно ту конфигурацию, с которой работает приложение:

```bash
kubectl exec -n $NS deploy/cognivault -- node -e '
const a = Buffer.from(`${process.env.QDRANT_USERNAME}:${process.env.QDRANT_PASSWORD}`).toString("base64");
fetch(process.env.QDRANT_URL, { headers: { Authorization: `Basic ${a}` } })
  .then(r => r.text().then(t => console.log(r.status, t.slice(0, 120))))
  .catch(e => console.log("ERR", e.message, e.cause?.code ?? ""));'
```

**UI-под (`python:3.12-alpine`) — есть `python`:**

```bash
kubectl exec -n $NS deploy/cognivault-ui -- python -c "
import urllib.request as u
r = u.urlopen(u.Request('https://tsled-oasis0001.esrt.sber.ru:6433/',
              headers={'Authorization': 'Basic $QAUTH'}), timeout=10)
print(r.status, r.read()[:120].decode())"
```

**UI-под — busybox `wget`** (когда нужно проверить и вариант «без проверки сертификата»):

```bash
kubectl exec -n $NS deploy/cognivault-ui -- wget -q -O - --no-check-certificate \
  --header="Authorization: Basic $QAUTH" \
  https://tsled-oasis0001.esrt.sber.ru:6433/
```

Ожидаемый успешный ответ корня Qdrant:

```json
{"title":"qdrant - vector search engine","version":"1.16.x"}
```

Как читать результат:

| Что видно | Что это значит |
|-----------|----------------|
| `{"title":"qdrant - vector search engine",…}` | всё хорошо: сеть, TLS и Basic-креды рабочие |
| `401` / HTML-страница логина от прокси | неверные `username`/`password` в `vectordb-creds` |
| `ERR … UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` | сеть есть, не хватает CA — см. `NODE_EXTRA_CA_CERTS` выше (тот же URL через `wget --no-check-certificate` при этом ответит корректно) |
| `ERR … ENOTFOUND` | нет DNS до `*.esrt.sber.ru` |
| `ERR … ECONNREFUSED` / зависание до таймаута | закрыт egress: примените `06-serviceentry-egress.yaml` / проверьте сетевые политики |

---

## Шаг 4. Применение манифестов

Образ приложения тянется из SberOSC, поэтому поду нужен pull-secret `sberosc-pull`
(если ещё не создан на пути B сборки — создайте):

```bash
oc project ci05490208-oasis-cognivault

# pull-secret для образа из SberOSC (если ещё не создан)
oc create secret docker-registry sberosc-pull -n ci05490208-oasis-cognivault \
  --docker-server=sberosc.sigma.sbrf.ru \
  --docker-username=token --docker-password=<ВАШ_SBEROSC_ТОКЕН>

oc apply -f k8s/00-configmap.yaml
oc apply -f k8s/02-pvc.yaml
oc apply -f k8s/03-deployment.yaml
oc apply -f k8s/04-service.yaml
oc apply -f k8s/05-ingress.yaml
# опционально, если egress к GigaChat/Qdrant закрыт:
# oc apply -f k8s/06-serviceentry-egress.yaml
```

> Не применяйте `01-secret.example.yaml` — секрет уже создан в Шаге 2.
> `08-qdrant.yaml` применять НЕ нужно: Qdrant внешний. Секрет `vectordb-creds`
> (`username`/`password`) заводит платформа DropApp — проверьте, что он есть в namespace:
> `oc get secret vectordb-creds`.

---

## Шаг 5. Проверка

```bash
oc rollout status deploy/cognivault          # дождаться Ready
oc get pods -l app.kubernetes.io/name=cognivault
oc logs deploy/cognivault -f                 # смотрим старт

# health изнутри кластера
oc rsh deploy/cognivault node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"
```

Признаки успешного старта в логах: подключение к Qdrant, создание коллекции
`cognivault`, `Server listening`. Если под в CrashLoopBackOff — почти всегда это
недоступный `QDRANT_URL`, неверный `EMBEDDING_DIMENSIONS` или отсутствующие
сертификаты (см. раздел «Диагностика»).

---

## Шаг 6. Заведение пользователей (после старта)

API‑ключи создаются CLI внутри пода; запись идёт в `/data/users.json`, сервер
подхватывает изменения на лету.

```bash
# Пользователь с локальной папкой-волтом (для GigaChat, без Obsidian-sync):
oc rsh deploy/cognivault \
  node dist/cli/index.js add-local-user bob --vault-path /data/vaults/bob
```

CLI напечатает API‑ключ вида `cv-...` — сохраните его. Обращение к API:

```
Authorization: Bearer cv-<ключ>
```

Папка `/data/vaults/bob` лежит на PVC и переживает перезапуски. Кладите туда
`.md`‑файлы (через `oc cp ./notes/. cognivault-<pod>:/data/vaults/bob/`), поллер
проиндексирует их автоматически.

---

## Шаг 7. Обращение к API из ноутбука (как в `Giga_sigma`)

Локальный пример ходил в `http://localhost:3030/api/vault/search/semantic`. В OpenShift
поменяйте базовый адрес на Ingress‑host (Networking → Ingresses → cognivault), ключ и
эндпоинт те же:

```python
retrieved = requests.post(
    "https://<INGRESS_HOST>/api/vault/search/semantic",
    data=dumps({"query": q, "limit": k}, ensure_ascii=False),
    headers={"Authorization": "Bearer cv-<ВАШ_КЛЮЧ>", "Content-Type": "application/json"},
).json()["results"]
```

> В `Giga_sigma` GigaChat вызывался с `verify_ssl_certs=False`. Для паритета, пока не
> примонтирован CA‑бандл, держите в ConfigMap `GIGACHAT_VERIFY_SSL: "false"` (небезопасно,
> временно), затем добавьте `ca.crt` + `GIGACHAT_CA_PATH` и верните `"true"`.

> Egress: GigaChat живёт в сегменте `delta` (`gigachat-ift.sberdevices.delta.sbrf.ru`),
> а кластер — в `sigma`. Убедитесь, что из подов есть сетевой доступ к нему (и при
> `REGISTRY_ONLY` в mesh — примените `06-serviceentry-egress.yaml`).

---

## Диагностика

| Симптом | Причина | Что делать |
|--------|---------|-----------|
| CrashLoop, лог `EMBEDDING_DIMENSIONS` | не задана/нечисловая размерность | задать число в ConfigMap, `oc rollout restart deploy/cognivault` |
| CrashLoop, ошибка подключения к Qdrant | внешний Qdrant недоступен: DNS/egress/TLS/креды | прогнать проверку связности из раздела «Внешний Qdrant» и смотреть таблицу «как читать результат» |
| CrashLoop, `QDRANT_PASSWORD is required when QDRANT_USERNAME is set` | задан только один ключ Basic auth | проверить оба `secretKeyRef` на `vectordb-creds` (`username`, `password`) |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | нет CA‑бандла GigaChat | добавить `ca.crt` в секрет + `GIGACHAT_CA_PATH`, либо временно `GIGACHAT_VERIFY_SSL=false` |
| `413 Request size exceeded` | внутренний шлюз режет тело | снизить `GIGACHAT_MAX_REQUEST_BYTES`/`MAX_BATCH_ITEMS` |
| `Tokens limit exceeded ... (max 4096)` | cl100k недосчитывает русские токены | снизить `GIGACHAT_MAX_EMBEDDING_TOKENS` (напр. 2500) |
| Под не становится Ready | probe смотрит на `/ready` | должно быть `/health` (уже так в манифесте) |
| `too many requests` при массовой индексации | rate limit GigaChat | поднять `GIGACHAT_RETRY_BASE_DELAY_MS` |
| NXDOMAIN до GigaChat | нет корпоративного резолвера/сети | проверить DNS кластера/egress до `*.delta.sbrf.ru` |

## Важные ограничения

- **Одна реплика.** PVC — ReadWriteOnce, единственный писатель SQLite/`users.json`.
  Не масштабировать `replicas > 1`.
- **Внешний Qdrant должен быть доступен на старте** — приложение падает, если не может
  подключиться (startupProbe даёт ~150с ретраев). Проверять связность до раскатки.
- **Смена размерности/модели эмбеддинга** требует новой коллекции Qdrant + полной
  переиндексации (приложение падает на несовпадении размерности при старте).
- **PodSecurity:** UID **фиксируется жёстко** — в `03-deployment.yaml` стоит
  `runAsNonRoot: true`, `runAsUser: 1000`, `runAsGroup: 1000`, `fsGroup: 1000`
  (пользователь `node` в образе — uid 1000; числовое значение нужно, чтобы
  `runAsNonRoot` проверялся и на ванильном Kubernetes). Кластер здесь ванильный,
  а не OpenShift с restricted‑v2, поэтому «случайный UID из SCC» к нему неприменим.
