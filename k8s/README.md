# Раскатка CogniVault в OpenShift (проект `ci05490208-oasis-cognivault`)

Манифесты для развёртывания CogniVault с GigaChat‑эмбеддингами в OpenShift
(Managed DropApp, среда функционального тестирования). Qdrant разворачивается
рядом в кластере, доступ через Ingress, образы (приложение и Qdrant) идут через
SberOSC (сегмент sigma).

## Что разворачиваем

| Файл | Ресурс | Назначение |
|------|--------|-----------|
| `00-configmap.yaml` | ConfigMap | Несекретные переменные окружения (порт, Qdrant URL, GigaChat) |
| `01-secret.example.yaml` | Secret (шаблон) | mTLS‑сертификаты GigaChat — **не применять как есть** |
| `02-pvc.yaml` | PVC (RWO, 5Gi) | `/data`: `users.json`, SQLite‑индексы, волты |
| `08-qdrant.yaml` | StatefulSet + Service + PVC | Qdrant в кластере (образ из SberOSC) |
| `03-deployment.yaml` | Deployment | Под приложения (1 реплика) |
| `04-service.yaml` | Service | ClusterIP :3000 |
| `05-ingress.yaml` | Ingress | Внешний доступ (подставить host) |
| `06-serviceentry-egress.yaml` | ServiceEntry (опц.) | Разрешить egress к GigaChat, если mesh его блокирует |
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

`00-configmap.yaml` уже заполнен проверенными значениями из локального
`docker-compose.override` (`EMBEDDING_DIMENSIONS: 2560`, `GIGACHAT_MODEL: EmbeddingsGigaR`,
`GIGACHAT_VERIFY_SSL: "false"`, `MAX_EMBEDDING_TOKENS: 2048`) — менять по умолчанию нечего.

Остаётся только `05-ingress.yaml`:
- `host` — домен, выданный проекту (обычно `cognivault-<namespace>.apps.<домен>`).

Qdrant в кластере — внешний URL не нужен (`QDRANT_URL: http://qdrant:6333`).

---

## Шаг 4. Применение манифестов

Qdrant тянется из SberOSC, поэтому его поду нужен pull-secret `sberosc-pull`
(если ещё не создан на пути B сборки — создайте):

```bash
oc project ci05490208-oasis-cognivault

# pull-secret для образа Qdrant из SberOSC (если ещё не создан)
oc create secret docker-registry sberosc-pull -n ci05490208-oasis-cognivault \
  --docker-server=sberosc.sigma.sbrf.ru \
  --docker-username=token --docker-password=<ВАШ_SBEROSC_ТОКЕН>

oc apply -f k8s/00-configmap.yaml
oc apply -f k8s/02-pvc.yaml
oc apply -f k8s/08-qdrant.yaml      # Qdrant поднять ПЕРВЫМ (приложение ждёт его на старте)
oc rollout status statefulset/qdrant
oc apply -f k8s/03-deployment.yaml
oc apply -f k8s/04-service.yaml
oc apply -f k8s/05-ingress.yaml
# опционально, если egress к GigaChat закрыт:
# oc apply -f k8s/06-serviceentry-egress.yaml
```

> Не применяйте `01-secret.example.yaml` — секрет уже создан в Шаге 2.
> Первая загрузка образа Qdrant из SberOSC запускает сканирование и может идти долго.

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
| CrashLoop, ошибка подключения к Qdrant | под `qdrant` не поднялся / образ не тянется | `oc get statefulset/qdrant`, `oc logs sts/qdrant`; проверить секрет `sberosc-pull` и статус сканирования в SberOSC |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | нет CA‑бандла GigaChat | добавить `ca.crt` в секрет + `GIGACHAT_CA_PATH`, либо временно `GIGACHAT_VERIFY_SSL=false` |
| `413 Request size exceeded` | внутренний шлюз режет тело | снизить `GIGACHAT_MAX_REQUEST_BYTES`/`MAX_BATCH_ITEMS` |
| `Tokens limit exceeded ... (max 4096)` | cl100k недосчитывает русские токены | снизить `GIGACHAT_MAX_EMBEDDING_TOKENS` (напр. 2500) |
| Под не становится Ready | probe смотрит на `/ready` | должно быть `/health` (уже так в манифесте) |
| `too many requests` при массовой индексации | rate limit GigaChat | поднять `GIGACHAT_RETRY_BASE_DELAY_MS` |
| NXDOMAIN до GigaChat | нет корпоративного резолвера/сети | проверить DNS кластера/egress до `*.delta.sbrf.ru` |

## Важные ограничения

- **Одна реплика.** PVC — ReadWriteOnce, единственный писатель SQLite/`users.json`.
  Не масштабировать `replicas > 1`.
- **Qdrant поднимать первым** — приложение падает, если Qdrant недоступен на старте
  (startupProbe даёт ~150с ретраев). Qdrant тоже одна реплика (RWO PVC).
- **Смена размерности/модели эмбеддинга** требует новой коллекции Qdrant + полной
  переиндексации (приложение падает на несовпадении размерности при старте).
- **OpenShift SCC:** `runAsUser` не фиксируем — restricted‑v2 назначает случайный UID
  и fsGroup, который chown‑ит PVC. Манифест уже совместим с restricted‑v2.
