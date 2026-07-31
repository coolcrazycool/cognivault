# Развёртывание CogniVault в Sber DropApp / OpenShift — с нуля

**Это единственный актуальный набор манифестов.** Наборы `k8s/`, `cognivault.yaml`
и `cognivault-ui.yaml` в корне репозитория **устарели** — они оставлены для истории
и отката, применять их не надо.

> ⚠️ **ХРАНИЛИЩА НЕТ: `/data` бэкенда эфемерный (emptyDir).** PVC в namespace нет
> ни одного — платформа их не выдаёт. При **каждом** перезапуске или перепланировке
> пода бэкенда теряются `users.json` (все cv-токены — пользователей надо заводить
> заново), SQLite-индекс `index.db` и содержимое волтов `/data/vaults/*` — сами
> документы. Векторы живут во внешнем Qdrant и переживают рестарт бэкенда, но после
> потери волта переиндексировать нечего, пока файлы не зальют обратно.
> Чек-лист восстановления и способ это вылечить — раздел 10.

Namespace: `ci05490208-oasis-cognivault`.
Образы (пин на конкретный digest-тег, оба из одной сборки):

| Компонент | Образ |
|-----------|-------|
| бэкенд | `sberosc.sigma.sbrf.ru/ghcr.io/coolcrazycool/cognivault:sha-f8a989d` |
| UI | `sberosc.sigma.sbrf.ru/ghcr.io/coolcrazycool/cognivault-ui:sha-f8a989d` |

---

## 0. Что разворачивается

| Файл | Объекты | Обязателен? |
|------|---------|-------------|
| `00-secrets.example.yaml` | Secret `cognivault-gigachat-certs`, Secret `sber-ca` | **Шаблон, не применять.** Секреты создаются командами из шага 2 |
| `02-configmap-backend.yaml` | ConfigMap `cognivault-config` | **Да** |
| `03-configmap-ui.yaml` | ConfigMap `cognivault-ui-config` | **Да** |
| `04-backend.yaml` | Deployment `cognivault` + Service `cognivault` (:3000) | **Да** |
| `05-ui.yaml` | Deployment `cognivault-ui` + Service `cognivault-ui` (:8787) | **Да** |
| `06-ingress.yaml` | Ingress `oasis-cognivault-ingress` | **Уже существует в кластере** и настроен верно. Применять только при развёртывании с нуля, см. шаг 7 |
| `07-serviceentry-egress.yaml` | ServiceEntry `gigachat-egress`, `qdrant-external-egress`, `confluence-egress` | Только при Istio `REGISTRY_ONLY` |
| `99-qdrant-inhouse.yaml` | Service `qdrant` + Deployment `qdrant` | **Нет.** Откат на внутрикластерный Qdrant, по умолчанию НЕ применять |

Внешние зависимости, которые набор не создаёт:

- **внешний Qdrant** DropApp — `https://tsled-oasis0001.esrt.sber.ru:6433` (резерв `…0002`);
- **Secret `vectordb-creds`** (`username`, `password`) — заводит платформа DropApp;
- **Secret `sberosc-pull`** — создаёте вы (шаг 2);
- **GigaChat** — `https://gigachat-ift.sberdevices.delta.sbrf.ru/v1`, авторизация клиентским сертификатом (mTLS).

Схема потоков:

```
Ingress oasis-cognivault-ingress (nginx, HTTP, без TLS)
  host cognivault-ui.apps.bcayrqks.k8s.delta.sbrf.ru
   └─> Service cognivault-ui:8787 ──> под UI ──┬─> Service cognivault:3000 ─> под бэкенда
                                               │        └─> внешний Qdrant :6433 (Basic auth)
                                               │        └─> GigaChat (эмбеддинги, mTLS)
                                               ├─> GigaChat (генерация ответа, mTLS)
                                               └─> Confluence (опционально)
```

---

## 1. Предусловия

- `oc` установлен и залогинен: `oc login <api-url> --token=<token>`;
  `oc project ci05490208-oasis-cognivault`.
- Секрет **`vectordb-creds`** уже есть в namespace (его заводит платформа). Проверить:
  ```bash
  oc get secret vectordb-creds -n ci05490208-oasis-cognivault
  ```
  Если его нет — запросить у платформы, без него бэкенд не стартует.
- Реквизиты GigaChat: `client_crt.crt` + `client_key.key` (при наличии — CA-бандл `ca.pem`
  и пароль ключа).
- **Токен SberOSC** (сегмент sigma, раздел «Профиль» в `sberosc.sigma.sbrf.ru`).
- Пакеты ghcr `coolcrazycool/cognivault` и `coolcrazycool/cognivault-ui` — **PUBLIC**,
  иначе прокси SberOSC не сможет их стянуть. Тег всегда конкретный `sha-…`:
  `latest` SberOSC не проксирует. Первый пул запускает сканирование —
  следите за статусом на `sberosc.sigma.sbrf.ru/dashboard`; очень свежие артефакты
  (младше ~3 дней) прокси может временно не отдавать.
- **PVC в namespace нет вообще** — платформа их не выдаёт. Поэтому `/data` у всех
  компонентов (бэкенд, UI, внутрикластерный Qdrant) — `emptyDir`, то есть данные
  эфемерны. Последствия и порядок восстановления — раздел 10.

---

## 2. Создание секретов

`00-secrets.example.yaml` — **шаблон, `oc apply` его не делать**. Создаём реально:

```bash
NS=ci05490208-oasis-cognivault

# 2.1 mTLS-сертификаты GigaChat.
# --from-file=./путь берёт ИМЯ ФАЙЛА как ключ секрета — имена должны совпадать
# с GIGACHAT_CERT_PATH / GIGACHAT_KEY_PATH в ConfigMap'ах.
oc create secret generic cognivault-gigachat-certs -n $NS \
  --from-file=./certs/client_crt.crt \
  --from-file=./certs/client_key.key
# опционально, если есть CA-бандл GigaChat:
#   --from-file=./certs/ca.pem
# опционально, если приватный ключ с паролем:
#   --from-literal=key.passphrase='<ПАРОЛЬ>'

# 2.2 pull-secret для образов через прокси SberOSC.
oc create secret docker-registry sberosc-pull -n $NS \
  --docker-server=sberosc.sigma.sbrf.ru \
  --docker-username=token \
  --docker-password='<ТОКЕН_SBEROSC>'

# 2.3 ОПЦИОНАЛЬНО: бандл внутреннего УЦ Сбера (см. шаг 3 — понадобится, только
# если внешний Qdrant предъявляет сертификат внутреннего УЦ).
oc create secret generic sber-ca -n $NS \
  --from-file=sber-ca.pem=./certs/sber-ca.pem
```

Если добавили `ca.pem` для GigaChat — раскомментируйте `GIGACHAT_CA_PATH`
в `02-configmap-backend.yaml` и верните `GIGACHAT_VERIFY_SSL: "true"`.

> **Про `sber-ca`.** В старой документации он назван то Secret'ом (`k8s/README.md`),
> то ConfigMap'ом (`cognivault-ui.yaml`, `cognivault-ui/DEPLOY.md`). В этом наборе
> он **везде Secret** — как и остальные материалы TLS. Если в кластере остался
> ConfigMap с таким именем, удалите его перед созданием секрета.

---

## 3. Проверка связности до внешнего Qdrant — ДО выкатки

Бэкенд подключается к Qdrant **на старте** и создаёт коллекцию `cognivault`.
Если Qdrant недоступен — под уходит в CrashLoopBackOff (startupProbe даёт ~150 с
ретраев). Проверять связность разумно заранее, из уже работающего пода
(например, из пода UI, который от Qdrant не зависит) или сразу после первой выкатки.

`curl` в образах нет. Готовые рецепты:

```bash
NS=ci05490208-oasis-cognivault
QU=$(oc get secret vectordb-creds -n $NS -o jsonpath='{.data.username}' | base64 -d)
QP=$(oc get secret vectordb-creds -n $NS -o jsonpath='{.data.password}' | base64 -d)
QAUTH=$(printf '%s:%s' "$QU" "$QP" | base64 | tr -d '\n')
```

**Бэкенд-под (`node:22-slim`) — есть `node`.** Берёт `QDRANT_URL` и креды прямо из env
пода, то есть проверяет ровно ту конфигурацию, с которой работает приложение:

```bash
oc exec -n $NS deploy/cognivault -- node -e '
const a = Buffer.from(`${process.env.QDRANT_USERNAME}:${process.env.QDRANT_PASSWORD}`).toString("base64");
fetch(process.env.QDRANT_URL, { headers: { Authorization: `Basic ${a}` } })
  .then(r => r.text().then(t => console.log(r.status, t.slice(0, 120))))
  .catch(e => console.log("ERR", e.message, e.cause?.code ?? ""));'
```

**UI-под (`python:3.12-alpine`) — есть `python`:**

```bash
oc exec -n $NS deploy/cognivault-ui -- python -c "
import urllib.request as u
r = u.urlopen(u.Request('https://tsled-oasis0001.esrt.sber.ru:6433/',
              headers={'Authorization': 'Basic $QAUTH'}), timeout=10)
print(r.status, r.read()[:120].decode())"
```

**UI-под — busybox `wget`** (когда нужно проверить и вариант «без проверки сертификата»):

```bash
oc exec -n $NS deploy/cognivault-ui -- wget -q -O - --no-check-certificate \
  --header="Authorization: Basic $QAUTH" \
  https://tsled-oasis0001.esrt.sber.ru:6433/
```

Успешный ответ корня Qdrant:

```json
{"title":"qdrant - vector search engine","version":"1.16.x"}
```

Как читать результат:

| Что видно | Что это значит | Что делать |
|-----------|----------------|------------|
| `{"title":"qdrant - vector search engine",…}` | сеть, TLS и Basic-креды рабочие | ничего |
| `401` / HTML-страница логина от прокси | неверные `username`/`password` | проверить `vectordb-creds`, запросить у платформы |
| `ERR … UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` | сеть есть, не хватает CA внутреннего УЦ (тот же URL через `wget --no-check-certificate` при этом ответит корректно) | смонтировать `sber-ca` и включить `NODE_EXTRA_CA_CERTS` — см. ниже |
| `ERR … ENOTFOUND` | нет DNS до `*.esrt.sber.ru` | проверить резолвер кластера / сеть |
| `ERR … ECONNREFUSED` или зависание до таймаута | закрыт egress | применить `07-serviceentry-egress.yaml`, проверить NetworkPolicy |

### Если не хватает CA внутреннего УЦ

Настроить доверие **из кода нельзя**: `fetch` в Node 22 идёт через undici, публичного
`Agent` для подмены CA нет, а `NODE_EXTRA_CA_CERTS` Node читает **только при старте
процесса**. Поэтому переменной `QDRANT_CA_PATH` в конфиге приложения нет — вопрос
решается на уровне пода.

1. Создать Secret `sber-ca` (шаг 2.3).
2. В `04-backend.yaml` раскомментировать три блока: `env` c `NODE_EXTRA_CA_CERTS:
   /certs-ca/sber-ca.pem`, `volumeMount` на `/certs-ca` и `volume` `sber-ca`.
3. `oc apply -f deploy/dropapp/04-backend.yaml` (Deployment перезапустится сам).

Крайняя мера — `NODE_TLS_REJECT_UNAUTHORIZED=0` (закомментированный блок там же).
⚠️ Это **глобальный** тумблер процесса: он снимает проверку сертификата не только
для Qdrant, но и **для GigaChat**, MITM станет незаметен. Сейчас в конфиге и так
`GIGACHAT_VERIFY_SSL: "false"`, так что фактической регрессии нет, но как только
появится CA-бандл — уходить на `NODE_EXTRA_CA_CERTS` и возвращать
`GIGACHAT_VERIFY_SSL: "true"` + `GIGACHAT_CA_PATH`.

---

## 4. Порядок применения

```bash
NS=ci05490208-oasis-cognivault
oc project $NS

oc apply -f deploy/dropapp/02-configmap-backend.yaml
oc apply -f deploy/dropapp/03-configmap-ui.yaml
oc apply -f deploy/dropapp/04-backend.yaml
oc apply -f deploy/dropapp/05-ui.yaml

# Только если Istio режет egress (REGISTRY_ONLY):
# oc apply -f deploy/dropapp/07-serviceentry-egress.yaml

# Ingress — только при развёртывании с нуля. В существующем окружении объект
# oasis-cognivault-ingress УЖЕ есть и уже смотрит на cognivault-ui:8787,
# трогать его не нужно. Подробности — шаг 7.
# oc apply -f deploy/dropapp/06-ingress.yaml
```

`00-secrets.example.yaml` и `99-qdrant-inhouse.yaml` **не применять**.

---

## 5. Проверка после выкатки

```bash
oc rollout status deploy/cognivault
oc rollout status deploy/cognivault-ui
oc get pods -l app.kubernetes.io/name=cognivault
oc logs deploy/cognivault | head -50
```

В логах бэкенда должны быть:

- строка про подключение к Qdrant — **`Connected to Qdrant`** с версией сервера
  (она же подтверждает, что Basic-auth и TLS отработали);
- создание/проверка коллекции `cognivault`;
- `Server listening`.

Health-эндпоинты (снаружи `curl` может не дойти, поэтому изнутри подов):

```bash
# бэкенд
oc exec deploy/cognivault -- node -e \
  "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"

# UI
oc exec deploy/cognivault-ui -- python -c \
  "import urllib.request as u; print(u.urlopen('http://127.0.0.1:8787/healthz').read().decode())"

# UI видит бэкенд по Service?
oc exec deploy/cognivault-ui -- python -c \
  "import urllib.request as u; print(u.urlopen('http://cognivault:3000/health').read().decode())"
```

> Пробы бэкенда намеренно бьют в **`/health`**, а не в `/ready`: при незаданном
> `VAULT_PATH` (мультитенантный режим) `/ready` отдаёт 503 и под никогда не станет Ready.

Частые причины CrashLoop:

| Симптом в логах | Причина | Что делать |
|-----------------|---------|------------|
| ошибка подключения к Qdrant | DNS / egress / TLS / креды | прогнать проверки из шага 3 |
| `QDRANT_PASSWORD is required when QDRANT_USERNAME is set` | задан только один ключ Basic-auth | проверить оба `secretKeyRef` на `vectordb-creds` |
| жалоба на `EMBEDDING_DIMENSIONS` | размерность не задана/нечисловая или не совпала с коллекцией | `EMBEDDING_DIMENSIONS: "2560"`; при несовпадении — новая коллекция + reindex |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` на GigaChat | нет CA-бандла GigaChat | `ca.pem` в секрет + `GIGACHAT_CA_PATH`, либо `GIGACHAT_VERIFY_SSL=false` |
| `413 Request size exceeded` | шлюз режет тело запроса | снизить `GIGACHAT_MAX_REQUEST_BYTES` / `GIGACHAT_MAX_BATCH_ITEMS` |
| `Tokens limit exceeded … (max 4096)` | cl100k недосчитывает русские токены | снизить `GIGACHAT_MAX_EMBEDDING_TOKENS` (напр. до 2500) |
| `too many requests` при массовой индексации | rate limit GigaChat | поднять `GIGACHAT_RETRY_BASE_DELAY_MS` |

---

## 6. Пользователь и ОБЯЗАТЕЛЬНАЯ переиндексация

Внешний Qdrant при развёртывании с нуля **пустой** — сам по себе он не наполнится,
поэтому после первого старта нужен полный reindex.

> ⚠️ `/data` бэкенда — `emptyDir`. Всё, что описано в этом разделе (пользователь,
> его cv-токен, залитые документы, построенный индекс), живёт **только до
> перезапуска пода**. После рестарта раздел проходится заново — см. чек-лист
> восстановления в разделе 10.

### 6.1 Завести пользователя и получить cv-токен

```bash
oc rsh deploy/cognivault \
  node dist/cli/index.js add-local-user bob --vault-path /data/vaults/bob
```

CLI печатает ключ вида `cv-…` — **сохраните его**, повторно он не показывается.
Запись идёт в `/data/users.json`, сервер подхватывает изменения на лету.

⚠️ И `users.json`, и папка волта `/data/vaults/bob` лежат на `emptyDir` и
**перезапуск пода не переживают**: после рестарта пользователя (и токен) придётся
создавать заново, а документы — заливать повторно. Держите исходники заметок
у себя локально.

Залить `.md`-файлы в волт — двумя способами:

```bash
# А) прямым копированием в под
oc cp ./notes/. $(oc get pod -l app.kubernetes.io/name=cognivault -o name | cut -d/ -f2):/data/vaults/bob/

# Б) по HTTP zip-архивом (до 50 МБ) — когда прав на `oc cp` нет.
# Загрузка идёт из браузера через UI либо curl'ом изнутри кластера:
zip -r notes.zip ./notes
#   curl -H "Authorization: Bearer $CV" -F file=@notes.zip \
#        http://cognivault:3000/api/vault/upload
```

Файлы попадают в watched-каталог волта и подхватываются поллером в течение
одного цикла; полный reindex после заливки — шаг 6.2.

### 6.2 Запустить полную переиндексацию

```bash
CV=cv-<ВАШ_КЛЮЧ>
oc exec deploy/cognivault -- node -e "
fetch('http://127.0.0.1:3000/api/admin/reindex', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer $CV', 'Content-Type': 'application/json' },
  body: JSON.stringify({ scope: 'full' }),
}).then(r => r.text()).then(console.log);"
```

Ответ `202` c `jobId`. Прогресс:

```bash
oc exec deploy/cognivault -- node -e "
fetch('http://127.0.0.1:3000/api/admin/reindex/status?jobId=<JOB_ID>', {
  headers: { 'Authorization': 'Bearer $CV' },
}).then(r => r.text()).then(console.log);"
```

Индексация идёт через GigaChat-эмбеддинги, на большом волте это долго — следите за
`filesProcessed` / `totalFiles` и за `errorCount`.

---

## 7. Внешний вход

Наружу выставляется **только UI**. REST API остаётся внутренним (ClusterIP) — морда
ходит в него по `http://cognivault:3000`.

Ingress **`oasis-cognivault-ingress` уже существует в кластере** (создан платформой)
и уже настроен правильно:

```
ingressClassName: nginx
host cognivault-ui.apps.bcayrqks.k8s.delta.sbrf.ru  →  cognivault-ui:8787
```

**При штатном обновлении его трогать не надо.** `06-ingress.yaml` применяется только
при развёртывании окружения с нуля. Сначала всегда смотрите фактическое состояние:

```bash
oc get ingress -n ci05490208-oasis-cognivault -o yaml
```

Проверка: открыть `http://cognivault-ui.apps.bcayrqks.k8s.delta.sbrf.ru/` в браузере,
залогиниться cv-токеном из шага 6.1.

### 7.1 Убрать второе правило — публичный Qdrant

У существующего объекта есть **второе правило**: host
`qdrant.apps.bcayrqks.k8s.delta.sbrf.ru` → `qdrant:6333`. Его надо удалить:

1. **У внутрикластерного Qdrant нет никакой аутентификации.** Пока это правило живо,
   векторы (и всё содержимое коллекции) может читать и **перезаписывать** кто угодно,
   кто дотянется до этого хоста. Это дыра, а не удобство.
2. **После переезда на внешний Qdrant Service `qdrant` вообще не существует** —
   правило висит впустую и только вводит в заблуждение.

```bash
# Правило Qdrant — второй элемент spec.rules (индекс 1). СНАЧАЛА убедитесь,
# что порядок правил именно такой:
oc get ingress oasis-cognivault-ingress -n ci05490208-oasis-cognivault \
  -o jsonpath='{range .spec.rules[*]}{.host}{"\n"}{end}'

oc patch ingress oasis-cognivault-ingress -n ci05490208-oasis-cognivault \
  --type=json -p '[{"op":"remove","path":"/spec/rules/1"}]'
```

Альтернатива — руками: `oc edit ingress oasis-cognivault-ingress`, удалить блок
правила с host `qdrant.apps.bcayrqks.k8s.delta.sbrf.ru`. Либо просто применить
`06-ingress.yaml` — он воспроизводит объект **с одним правилом**.

> ⚠️ **TLS на входе не настроен.** Трафик идёт по обычному HTTP: cv-токены
> (`Authorization: Bearer cv-…`) и содержимое чатов передаются **открытым текстом**.
> Когда появится сертификат под этот host — добавить `spec.tls[].secretName`
> (шаблон закомментирован в `06-ingress.yaml`).

---

## 8. Что менять при обновлении версии

В штатном случае — **только две вещи**:

1. пин образа `sha-…` в `04-backend.yaml` и/или `05-ui.yaml` (оба образа собираются
   из одного коммита, обновлять их обычно нужно парой);
2. новые ключи в `02-configmap-backend.yaml` / `03-configmap-ui.yaml`, если релиз
   их добавил.

```bash
oc apply -f deploy/dropapp/02-configmap-backend.yaml
oc apply -f deploy/dropapp/04-backend.yaml
oc rollout status deploy/cognivault
```

> Изменение ConfigMap **само по себе не перезапускает** под. Если правили только
> ConfigMap — нужен `oc rollout restart deploy/cognivault` (и/или `deploy/cognivault-ui`).

> ⚠️ Любое обновление бэкенда пересоздаёт под, а значит **стирает `/data`**: токены,
> волты и индекс. После каждой выкатки проходите чек-лист восстановления (раздел 10.2).

**Переиндексация НУЖНА, когда:**

- меняется модель эмбеддингов или `EMBEDDING_DIMENSIONS` (нужна новая коллекция
  Qdrant — при несовпадении размерности приложение падает на старте);
- меняется схема коллекции / стратегия чанкинга (планируется в Волне 3: BM25 и
  sparse-векторы);
- откатились на внутрикластерный Qdrant на emptyDir и он перезапустился;
- **перезапустился под бэкенда** — `/data` эфемерный, волт и индекс потеряны;
  сначала залить документы обратно, потом reindex (раздел 10.2);
- разворачиваете окружение с нуля (шаг 6.2).

**Переиндексация НЕ нужна, когда:**

- меняется `GIGACHAT_QUERY_INSTRUCTION` — `EmbeddingsGigaR` асимметрична, инструкцию
  несёт только поисковый запрос, документы её не видят;
- меняются любые `RAG_*` у UI, промпты, температура, лимиты контекста;
- меняются таймауты, ретраи, размеры батчей, `LOG_LEVEL`;
- обновился образ без изменения модели/размерности эмбеддингов.

---

## 9. Резервный хост Qdrant

`QdrantClient` принимает **ровно один** URL, клиентской балансировки нет.
Переключение на резерв — правка одного ключа и рестарт:

```bash
oc edit configmap cognivault-config
#   QDRANT_URL: "https://tsled-oasis0002.esrt.sber.ru:6433"
oc rollout restart deploy/cognivault
oc rollout status deploy/cognivault
```

Оба хоста уже перечислены в `qdrant-external-egress` (`07-serviceentry-egress.yaml`),
так что egress править не нужно. Креды `vectordb-creds` для обоих узлов одни и те же.
Если на резервном узле коллекция пустая — понадобится reindex (шаг 6.2).

---

## 10. Известные ограничения

### 10.1 Главное: постоянного хранилища нет, `/data` бэкенда эфемерный

**PVC в namespace нет ни одного — платформа их не выдаёт.** Поэтому том `data`
бэкенда в `04-backend.yaml` — это `emptyDir`, живущий ровно столько же, сколько под.

При **каждом** перезапуске или перепланировке пода бэкенда теряются:

- **`/data/users.json`** — то есть **все cv-токены**; пользователей надо заводить заново;
- **SQLite-индекс `/data/index.db`** — состояние индексации;
- **содержимое волтов `/data/vaults/*`** — **сами документы**.

Векторы лежат во внешнем Qdrant и рестарт бэкенда переживают, но пользы от этого
мало: после потери волта **переиндексировать нечего**, пока файлы не зальют обратно.
(Если откатились на внутрикластерный Qdrant из `99-qdrant-inhouse.yaml`, он тоже на
`emptyDir` — тогда теряются и векторы.)

Тот же диагноз у UI: `/data` в `05-ui.yaml` — `emptyDir`, история чатов и
`rag_log.jsonl` перезапуск не переживают.

**Практический вывод:** держите исходники заметок у себя локально, а cv-токен
считайте одноразовым — после любого рестарта он невалиден.

### 10.2 Чек-лист восстановления после перезапуска пода

```bash
NS=ci05490208-oasis-cognivault
oc project $NS

# 1. Убедиться, что под поднялся и подключился к Qdrant.
oc rollout status deploy/cognivault
oc logs deploy/cognivault | head -50   # ждём «Connected to Qdrant» и «Server listening»

# 2. Завести пользователя заново — выдаётся НОВЫЙ cv-токен, сохраните его.
oc rsh deploy/cognivault \
  node dist/cli/index.js add-local-user bob --vault-path /data/vaults/bob

# 3. Залить документы обратно (вариант А — копированием в под).
oc cp ./notes/. $(oc get pod -l app.kubernetes.io/name=cognivault -o name | cut -d/ -f2):/data/vaults/bob/
#    Вариант Б — zip-архивом по HTTP (до 50 МБ), из браузера через UI либо:
#    curl -H "Authorization: Bearer $CV" -F file=@notes.zip \
#         http://cognivault:3000/api/vault/upload

# 4. Полная переиндексация.
CV=cv-<НОВЫЙ_КЛЮЧ>
oc exec deploy/cognivault -- node -e "
fetch('http://127.0.0.1:3000/api/admin/reindex', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer $CV', 'Content-Type': 'application/json' },
  body: JSON.stringify({ scope: 'full' }),
}).then(r => r.text()).then(console.log);"

# 5. Прогресс (jobId из ответа шага 4).
oc exec deploy/cognivault -- node -e "
fetch('http://127.0.0.1:3000/api/admin/reindex/status?jobId=<JOB_ID>', {
  headers: { 'Authorization': 'Bearer $CV' },
}).then(r => r.text()).then(console.log);"
```

Новый cv-токен нужно ввести в UI заново (шаг 7). Подробности по каждому шагу —
раздел 6.

### 10.3 Чем это лечится

Честно: **только PVC от платформы** — нужна квота на PersistentVolumeClaim в
namespace. Обходного пути на уровне приложения нет: код и так пишет всё в один
каталог `/data`, менять в нём ничего не потребуется.

Как только PVC появится, в `04-backend.yaml` том `data` возвращается к виду
(копипастой, `mountPath` остаётся `/data`):

```yaml
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: cognivault-data
```

и рядом в набор добавляется сам claim:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cognivault-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
```

Аналогично для UI (`05-ui.yaml`) и внутрикластерного Qdrant
(`99-qdrant-inhouse.yaml`) — каждому нужен свой claim с отдельным именем.

### 10.4 Прочие ограничения

- **Одна реплика каждого компонента.** `users.json` и SQLite-индекс рассчитаны ровно
  на одного писателя, а реплики не разделяют `/data` (у каждой свой `emptyDir`).
  `replicas > 1` без общего тома (RWX) и дизайна с несколькими писателями сломает данные.
- **TLS на Ingress нет** — трафик, включая cv-токены, идёт открытым текстом (шаг 7).
- **Внешний Qdrant должен быть доступен на старте** — иначе бэкенд не поднимется.
  Проверять связность до выкатки (шаг 3).
- **`GIGACHAT_VERIFY_SSL: "false"`** — временный escape hatch, пока нет CA-бандла.
- **Внутрикластерный Qdrant — v1.3.0**, единственная версия, прошедшая скан SberOSC.
  Для Волны 3 (гибридный поиск на стороне Qdrant) понадобится 1.16.3 — её надо
  заранее провести через скан.
