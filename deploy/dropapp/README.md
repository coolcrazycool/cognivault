# Развёртывание CogniVault в Sber DropApp — с нуля

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
Образы пинятся на конкретный тег `sha-<gitsha>`. Теги у бэкенда и UI **не совпадают** —
образы собираются независимо, каждый из своего пути, поэтому компонент, который не менялся,
остаётся на прежнем коммите:

| Компонент | Образ |
|-----------|-------|
| бэкенд | `sberosc.sigma.sbrf.ru/ghcr.io/coolcrazycool/cognivault:sha-e30dc81` |
| UI | `sberosc.sigma.sbrf.ru/ghcr.io/coolcrazycool/cognivault-ui:sha-e30dc81` |

---

## Как работать с кластером: веб-консоль DropApp

**CLI (`kubectl`/`oc`) в этом окружении нет.** Всё делается через веб-консоль:

```
https://console.bcayrqks.k8s.delta.sbrf.ru/k8s/ns/ci05490208-oasis-cognivault/
```

Ниже — сокращения, которыми пользуется вся инструкция (`<ns>` = `ci05490208-oasis-cognivault`):

| Действие | Где в консоли |
|----------|---------------|
| **Применить манифест** | кнопка **«+»** вверху справа → **Import YAML**, либо прямая ссылка `/k8s/ns/<ns>/import`. Многодокументные файлы (с `---`) принимаются целиком — один файл за раз |
| **Посмотреть/править Deployment** | `/k8s/ns/<ns>/deployments/<name>/yaml`, вкладка **YAML**. Есть и вкладка **Environment** для переменных окружения. Сохранение само перезапускает под |
| **Посмотреть/править ConfigMap** | `/k8s/ns/<ns>/configmaps/<name>/yaml` |
| **Логи пода** | страница пода → вкладка **Logs** |
| **Команда внутри пода** | страница пода → вкладка **Terminal** (туда вставляются однострочники `node -e '…'` / `python -c '…'`) |
| **Секреты** | **Secrets** → **Create** → **Key/value secret**; значение можно загрузить файлом, base64 руками считать не нужно |
| **Ingress** | `/k8s/ns/<ns>/ingresses/oasis-cognivault-ingress/yaml` |
| **Перезапустить деплоймент** | страница Deployment → меню **Actions** → **Restart rollout** |

> Все команды для вкладки **Terminal** в этом README написаны **в одну строку**
> специально: консольный терминал теряет переносы при вставке многострочного текста.
> Никаких heredoc и переносов внутри кавычек.

Врезки «**если у вас есть CLI**» приведены справочно — на случай, когда доступ к
`kubectl`/`oc` всё-таки появится. Основной путь везде — консоль.

---

## 0. Что разворачивается

| Файл | Объекты | Обязателен? |
|------|---------|-------------|
| `00-secrets.example.yaml` | Secret `cognivault-gigachat-certs` | **Шаблон, не импортировать.** Секреты создаются формой из шага 2 |
| `02-configmap-backend.yaml` | ConfigMap `cognivault-config` | **Да** |
| `03-configmap-ui.yaml` | ConfigMap `cognivault-ui-config` | **Да** |
| `04-backend.yaml` | Deployment `cognivault` + Service `cognivault` (:3000) | **Да** |
| `05-ui.yaml` | Deployment `cognivault-ui` + Service `cognivault-ui` (:8787) | **Да** |
| `06-ingress.yaml` | Ingress `oasis-cognivault-ingress` | **Уже существует в кластере** и настроен верно. Импортировать только при развёртывании с нуля, см. шаг 7 |
| `07-serviceentry-egress.yaml` | ServiceEntry `gigachat-egress`, `qdrant-external-egress`, `confluence-egress` | Только при Istio `REGISTRY_ONLY` |
| `99-qdrant-inhouse.yaml` | Service `qdrant` + Deployment `qdrant` | **Нет.** Откат на внутрикластерный Qdrant, по умолчанию НЕ применять |

Внешние зависимости, которые набор не создаёт:

- **внешний Qdrant** DropApp — `https://tsled-oasis0001.esrt.sber.ru:6433` (резерв `…0002`).
  За этим адресом **Platform V Vector DB**, надстройка над Qdrant: без UI, только mTLS,
  авторизация JWT-токенами (раздел 3.5);
- **Secret `vectordb-creds`** (`username`, `password`) — заводит платформа DropApp.
  Используются ОБА ключа: это ТУЗ и пароль доменного пользователя, которые меняются
  на JWT у IAM-сервиса (`QDRANT_USERNAME`/`QDRANT_PASSWORD`), см. 3.5;
- **Secret `sberosc-pull`** — создаёте вы (шаг 2);
- **GigaChat** — `https://gigachat-ift.sberdevices.delta.sbrf.ru/v1`, авторизация клиентским сертификатом (mTLS).

Схема потоков:

```
Ingress oasis-cognivault-ingress (nginx, HTTP, без TLS)
  host cognivault-ui.apps.bcayrqks.k8s.delta.sbrf.ru
   └─> Service cognivault-ui:8787 ──> под UI ──┬─> Service cognivault:3000 ─> под бэкенда
                                               │        ├─> IAM :6433 /auth (mTLS) ─> JWT
                                               │        └─> Platform V Vector DB :6433 (mTLS + Bearer)
                                               │        └─> GigaChat (эмбеддинги, mTLS)
                                               ├─> GigaChat (генерация ответа, mTLS)
                                               └─> Confluence (опционально)
```

---

## 1. Предусловия

- Доступ в веб-консоль DropApp к namespace `ci05490208-oasis-cognivault`.
- Секрет **`vectordb-creds`** уже есть в namespace (его заводит платформа). Проверить:
  **Secrets** → в списке должен быть `vectordb-creds` с ключами `username`, `password`.
  Если его нет — запросить у платформы, без него бэкенд не стартует. Нужны ОБА ключа:
  `username` — ТУЗ, `password` — пароль доменного пользователя; вместе они меняются
  на JWT у IAM-сервиса Platform V Vector DB (раздел 3.5).
- TLS-материал одним комплектом: `client_crt.crt` + `client_key.key` (клиентская пара
  mTLS), `cacert.pem` (бандл внутреннего УЦ Сбера) и, если ключ зашифрован, его пароль.
  Всё это кладётся в один секрет — шаг 2.1.
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

`00-secrets.example.yaml` — **шаблон, импортировать его не надо**. Секреты создаются
формой: **Secrets** → **Create** → **Key/value secret**. У каждого значения есть кнопка
загрузки из файла — считать base64 вручную не нужно, консоль кодирует сама.

### 2.1 `cognivault-gigachat-certs` — весь TLS-материал одним секретом

Тип: **Key/value secret**. Имя: `cognivault-gigachat-certs`. Монтируется в `/certs`
и у бэкенда, и у UI; используется и для GigaChat, и для внешнего Qdrant.

| Ключ | Значение | Обязателен |
|------|----------|------------|
| `client_crt.crt` | файл клиентского сертификата | **да** |
| `client_key.key` | файл приватного ключа | **да** |
| `cacert.pem` | CA-бандл внутреннего УЦ Сбера | **да** для TLS до Qdrant (см. 3.1) |
| `key.passphrase` | пароль приватного ключа (строкой) | нет, если ключ зашифрован |

⚠️ **Имена ключей должны быть ровно такими** — они превращаются в имена файлов
в `/certs`. На них смотрят `GIGACHAT_CERT_PATH` / `GIGACHAT_KEY_PATH`,
`QDRANT_CERT_PATH` / `QDRANT_KEY_PATH` и `QDRANT_CA_PATH`
(`/certs/cacert.pem`) из `02-configmap-backend.yaml`.

> **Отдельного секрета `sber-ca` больше нет.** Раньше бандл внутреннего УЦ жил
> в собственном секрете и монтировался в `/certs-ca`. Теперь он лежит ключом
> `cacert.pem` в том же секрете, что и клиентская пара, — второй секрет и второе
> монтирование не нужны. Если в кластере остался старый `sber-ca` (Secret или
> ConfigMap), его можно удалить: набор на него не ссылается.

### 2.2 `sberosc-pull` — pull-secret для образов

В консоли: **Secrets** → **Create** → **Image pull secret** (если такого пункта нет —
**Key/value secret** не подойдёт, нужен именно `kubernetes.io/dockerconfigjson`).

| Поле | Значение |
|------|----------|
| Registry server address | `sberosc.sigma.sbrf.ru` |
| Username | `token` |
| Password | `<ТОКЕН_SBEROSC>` |

### 2.3 Права на файлы секрета

Оба Deployment'а монтируют секрет с **`defaultMode: 0440`**. Это осознанный выбор:
файлы секрета принадлежат `root:fsGroup` (то есть `root:1000`), а процесс работает
под uid 1000. При `0400` читать может **только root** — приложение упало бы на
старте, когда синхронно читает `cacert.pem` и `client_key.key`. `0440` даёт чтение
группе 1000 и при этом строже дефолтных `0644`, при которых файлы доступны кому
угодно внутри контейнера. Менять на `0400` не надо — сломается.

<details>
<summary><b>Если у вас есть CLI</b></summary>

```bash
NS=ci05490208-oasis-cognivault

kubectl create secret generic cognivault-gigachat-certs -n $NS \
  --from-file=./certs/client_crt.crt \
  --from-file=./certs/client_key.key \
  --from-file=./certs/cacert.pem
#   --from-literal=key.passphrase='<ПАРОЛЬ>'

kubectl create secret docker-registry sberosc-pull -n $NS \
  --docker-server=sberosc.sigma.sbrf.ru \
  --docker-username=token \
  --docker-password='<ТОКЕН_SBEROSC>'
```

`--from-file=./путь` берёт **имя файла** как ключ секрета — поэтому имена файлов
обязаны совпадать с путями в ConfigMap.
</details>

---

## 3. TLS и связность до внешнего Qdrant

Бэкенд подключается к Qdrant **на старте** и создаёт коллекцию `cognivault`.
Если Qdrant недоступен — под уходит в CrashLoopBackOff (startupProbe даёт ~150 с
ретраев). Проверять связность разумно заранее — из уже работающего пода (например,
из пода UI, который от Qdrant не зависит) или сразу после первой выкатки.

### 3.1 Как это настраивается (важное изменение)

`QdrantClientParams` никаких TLS-опций не имеет, и подсунуть свой транспорт тоже
нельзя: `@qdrant/js-client-rest` создаёт **собственный** HTTP-агент и передаёт его
в каждый запрос, перебивая любые глобальные настройки. Поэтому приложение
**перехватывает установку TLS-соединений** и подмешивает CA / клиентский сертификат
**только для пары host:port из `QDRANT_URL`**. Всё остальное — GigaChat, Confluence,
OTLP — проходит абсолютно нетронутым.

**`NODE_EXTRA_CA_CERTS` и `NODE_TLS_REJECT_UNAUTHORIZED` больше не нужны** — всё
настраивается ключами конфига:

| Ключ | Где задаётся | Значение в наборе | Назначение |
|------|--------------|-------------------|------------|
| `QDRANT_CA_PATH` | ConfigMap `cognivault-config` | `/certs/cacert.pem` | PEM-бандл внутреннего УЦ. **Заменяет** системное хранилище корней — но только для хоста Qdrant |
| `QDRANT_CERT_PATH` | ConfigMap | `/certs/client_crt.crt` | клиентский сертификат: Platform V Vector DB принимает соединения только по mTLS |
| `QDRANT_KEY_PATH` | ConfigMap | `/certs/client_key.key` | приватный ключ к нему. Задаётся **только вместе** с `QDRANT_CERT_PATH`, иначе приложение падает на валидации конфига |
| `QDRANT_KEY_PASSPHRASE` | Secret `cognivault-gigachat-certs`, ключ `key.passphrase` (`optional: true`) | не задан | пароль приватного ключа, если он зашифрован |
| `QDRANT_VERIFY_SSL` | ConfigMap | `true` | проверка сертификата сервера. `false` — временный escape hatch, гасит проверку **только** для Qdrant |

Все три файла лежат в одном секрете `cognivault-gigachat-certs`, смонтированном
в `/certs` (шаг 2.1) — отдельного секрета под CA нет.

Если не задано ничего (нет CA, нет пары cert+key, `QDRANT_VERIFY_SSL=true`),
перехват **не устанавливается вовсе** и TLS работает ровно как раньше.

> **Про клиентский сертификат.** Platform V Vector DB принимает соединения **только**
> по mTLS — клиент обязан предъявить сертификат, иначе не откроется ни `/auth`, ни
> сама СУБД. Сертификат при этом **не специальный**: подходит любая валидная пара,
> поэтому переиспользуется та же, что и для GigaChat (`/certs/client_crt.crt`,
> `/certs/client_key.key`). Проверено на стенде — работает.
>
> Тот же материал уходит и в запрос токена на `/auth`. Он передаётся туда **явно**,
> а не через перехват `tls.connect`: перехват привязан к паре host:port из
> `QDRANT_URL`, и если IAM вынесут на отдельный порт (`QDRANT_AUTH_URL`), перехват
> не сработает.

В логе старта появляются строки `Intercepting TLS connections to the Qdrant host`
и `Qdrant client configured` с полями `qdrantTls: custom|system`,
`qdrantClientCert: true|false`, `qdrantVerifySsl` — пути и пароли туда не пишутся
никогда.

#### Тот же бандл для GigaChat и Confluence

Сейчас `GIGACHAT_VERIFY_SSL: "false"` (и `CONFLUENCE_VERIFY_SSL: "false"` у UI) —
это временный режим, оставшийся с тех пор, когда бандла не было вовсе. Теперь
`cacert.pem` лежит в том же секрете и доступен обоим подам.

**Как только подключение к Qdrant заработает по CA** (то есть бандл доказал свою
пригодность), имеет смысл попробовать то же самое и здесь:

1. в `02-configmap-backend.yaml` раскомментировать `GIGACHAT_CA_PATH: "/certs/cacert.pem"`
   и поставить `GIGACHAT_VERIFY_SSL: "true"`;
2. в `03-configmap-ui.yaml` — аналогично `GIGACHAT_CA_PATH`, а также
   `CONFLUENCE_CA_PATH: "/certs/cacert.pem"` + `CONFLUENCE_VERIFY_SSL: "true"`;
3. перезапустить под и проверить логи.

По умолчанию **не включено намеренно**: не проверено, что этот бандл покрывает
цепочки именно хостов GigaChat и Confluence. Если после включения полезет
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` — вернуть `"false"` и снять `*_CA_PATH`.

### 3.2 Проверка из вкладки Terminal

`curl` в образах нет — проверяем средствами рантайма. Открываем под, вкладку
**Terminal**, вставляем однострочник.

> Однострочники ниже проверяют **связность и TLS**, а не аутентификацию: корень `/`
> отвечает и без токена. Заголовок `Authorization: Basic` в них исторический и на
> результат не влияет — Platform V Vector DB Basic **не понимает вовсе** (проверено:
> ответ на него ровно тот же 401, что и на запрос без заголовка). Аутентификация
> проверяется отдельно — раздел 3.5.

**Бэкенд-под (есть `node`).** Берёт `QDRANT_URL` и креды прямо из env пода, то есть
проверяет ровно ту конфигурацию, с которой работает приложение — **без** клиентского
сертификата и с системными корнями (базовая линия):

```
node -e "const a=Buffer.from(process.env.QDRANT_USERNAME+':'+process.env.QDRANT_PASSWORD).toString('base64');fetch(process.env.QDRANT_URL,{headers:{Authorization:'Basic '+a}}).then(r=>r.text().then(t=>console.log(r.status,t.slice(0,150)))).catch(e=>console.log('ERR',e.message,e.cause&&e.cause.code))"
```

**Бэкенд-под, с CA внутреннего УЦ** — проверяет, что бандл действительно чинит цепочку.
Использует только встроенный `node:https`, никаких зависимостей:

```
node -e "const https=require('https'),fs=require('fs');const u=new URL(process.env.QDRANT_URL);const a=Buffer.from(process.env.QDRANT_USERNAME+':'+process.env.QDRANT_PASSWORD).toString('base64');https.request({hostname:u.hostname,port:u.port||443,path:'/',headers:{authorization:'Basic '+a},ca:fs.readFileSync('/certs/cacert.pem')},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(r.statusCode,d.slice(0,150)))}).on('error',e=>console.log('ERR',e.message,e.code)).end()"
```

**Бэкенд-под, с клиентским сертификатом** — проверяет гипотезу «прокси требует mTLS».
`rejectUnauthorized:false` здесь намеренно, чтобы отделить проблему клиентского
сертификата от проблемы CA:

```
node -e "const https=require('https'),fs=require('fs');const u=new URL(process.env.QDRANT_URL);const a=Buffer.from(process.env.QDRANT_USERNAME+':'+process.env.QDRANT_PASSWORD).toString('base64');https.request({hostname:u.hostname,port:u.port||443,path:'/',headers:{authorization:'Basic '+a},cert:fs.readFileSync('/certs/client_crt.crt'),key:fs.readFileSync('/certs/client_key.key'),rejectUnauthorized:false},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(r.statusCode,d.slice(0,150)))}).on('error',e=>console.log('ERR',e.message,e.code)).end()"
```

> Если ключ зашифрован, добавьте в опции ещё `passphrase:process.env.QDRANT_KEY_PASSPHRASE`.
> Чтобы проверить «CA + клиентский сертификат» разом — оставьте `ca:` и уберите
> `rejectUnauthorized:false`.

**UI-под (`python:3.12-alpine`, есть `python`)** — независимая проверка сети до хоста
СУБД (аутентификацию она не проверяет: корень `/` открыт, а Basic здесь всё равно не
понимают). Логин/пароль из `vectordb-creds` видно в консоли: **Secrets** →
`vectordb-creds` → **Reveal values**:

```
python -c "import base64,urllib.request as u; a=base64.b64encode(b'ЛОГИН:ПАРОЛЬ').decode(); r=u.urlopen(u.Request('https://tsled-oasis0001.esrt.sber.ru:6433/',headers={'Authorization':'Basic '+a}),timeout=10); print(r.status, r.read()[:150].decode())"
```

**UI-под, без проверки сертификата** — отделяет «сеть не пускает» от «TLS не сходится»:

```
python -c "import base64,ssl,urllib.request as u; c=ssl._create_unverified_context(); a=base64.b64encode(b'ЛОГИН:ПАРОЛЬ').decode(); r=u.urlopen(u.Request('https://tsled-oasis0001.esrt.sber.ru:6433/',headers={'Authorization':'Basic '+a}),timeout=10,context=c); print(r.status, r.read()[:150].decode())"
```

Успешный ответ корня Qdrant:

```json
{"title":"qdrant - vector search engine","version":"1.16.x"}
```

### 3.3 Как читать результат

| Что видно | Что это значит | Что делать |
|-----------|----------------|------------|
| `{"title":"qdrant - vector search engine",…}` | сеть и TLS рабочие (корень `/` открыт и без аутентификации — про креды это ничего не говорит) | проверить `/collections`, раздел 3.5 |
| `401` + тело `{"status":{"error":"Unauthorized: Must provide an API key or an Authorization bearer token"}}` | токен не отправлен вовсе (либо отправлен `Authorization: Basic`, который здесь не понимают) | включить пару `QDRANT_USERNAME`/`QDRANT_PASSWORD` — раздел 3.5 |
| `401` + тело `{"status":{"error":"Invalid API key or JWT. If you are using API key while security RBAC is enabled, consider to use JWT"}}` | отправлено **не то**: `api-key` вместо JWT | убрать `QDRANT_API_KEY`, включить пару username/password — раздел 3.5 |
| `403` + тело `{"status":{"error":"Forbidden: InvalidSignature"}}` | JWT разобран, но подписан **не тем** секретом — выпущен не IAM'ом (самодельный токен так и выглядит) | брать токен только через `POST /auth`, раздел 3.5 |
| `ERR … UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` | сеть есть, не хватает CA внутреннего УЦ (тот же URL без проверки сертификата при этом отвечает корректно) | проверить `QDRANT_CA_PATH` и наличие `/certs/cacert.pem` — шаг 3.4 |
| `ERR … DEPTH_ZERO_SELF_SIGNED_CERT` | самоподписанный сертификат сервера | тот же CA-бандл; если его нет — временно `QDRANT_VERIFY_SSL: "false"` |
| `ERR … handshake failure` / `SSLV3_ALERT_HANDSHAKE_FAILURE` / `socket hang up` / `ECONNRESET` сразу после TLS-hello | **прокси требует клиентский сертификат**, а мы его не предъявили | задать `QDRANT_CERT_PATH` / `QDRANT_KEY_PATH` (шаг 3.1); проверить третьим однострочником из 3.2 |
| `ERR … ENOTFOUND` | нет DNS до `*.esrt.sber.ru` | проверить резолвер кластера / сеть |
| `ERR … ECONNREFUSED` или зависание до таймаута | закрыт egress | импортировать `07-serviceentry-egress.yaml`, проверить NetworkPolicy |

### 3.4 Если не хватает CA внутреннего УЦ

Ничего монтировать и создавать не нужно — бандл уже лежит ключом `cacert.pem`
в секрете `cognivault-gigachat-certs`, а `QDRANT_CA_PATH: "/certs/cacert.pem"`
активен в ConfigMap по умолчанию. Порядок проверки:

1. Убедиться, что ключ в секрете действительно есть: **Secrets** →
   `cognivault-gigachat-certs` — в списке ключей должен быть `cacert.pem`.
   Если его нет, приложение упадёт на старте с
   `Cannot read QDRANT_CA_PATH "/certs/cacert.pem": ENOENT`.
2. Проверить бандл вторым однострочником из 3.2 — он должен вернуть `200`.
3. Если всё сходится, оставить `QDRANT_VERIFY_SSL: "true"` и перезапустить под:
   страница Deployment → **Actions** → **Restart rollout**.

Временная мера, если бандл не подошёл: `QDRANT_VERIFY_SSL: "false"` в ConfigMap.
Она снимает проверку сертификата **только для хоста Qdrant** — GigaChat и всё
остальное не затрагиваются. Это правильная замена глобальному
`NODE_TLS_REJECT_UNAUTHORIZED=0`, который в `04-backend.yaml` оставлен закомментированным
как аварийный костыль: он гасит проверку **во всём процессе**, включая GigaChat.

### 3.5 Аутентификация: Platform V Vector DB и её IAM

TLS и аутентификация — разные слои, и они ломались по очереди: сначала не сходился
TLS, потом заработавшее соединение упёрлось в 401.

**Главное, что выяснилось:** за адресом `QDRANT_URL` стоит **не сырой Qdrant**, а
**Platform V Vector DB** — надстройка Сбера. Из её документации и проверок на стенде:

- **UI нет вовсе**, взаимодействие только по REST/gRPC;
- соединение **только по mTLS**: клиент обязан предъявить свой сертификат (раздел 3.1);
- запросы к самой СУБД авторизуются **JWT-токенами**, а не `api-key`;
- токен выдаёт отдельный **сервис IAM**: `POST /auth` с телом
  `{"username": "<ТУЗ>", "password": "<пароль доменного пользователя>"}`,
  `Content-Type: application/json`, тоже по mTLS;
- **время жизни токена — 1 час**, всё это время он переиспользуется.

Итоговая схема одного запроса:

```
mTLS-соединение клиентским сертификатом
  └─> POST https://…:6433/auth  {"username":…,"password":…}
        └─> 200 {"result":{"token":"eyJ0eXAiOiJKV1Q…"}}
              └─> GET https://…:6433/collections
                    Authorization: Bearer eyJ0eXAiOiJKV1Q…
```

#### Порт IAM

Документация вендора противоречит сама себе: в тексте — для версий Vector DB
**< 2.0.0** IAM слушает на 6533 (REST) / 6534 (gRPC), для **>= 2.0.0** на тех же
портах, что и СУБД, то есть 6433 / 6434; а в примерах `curl` в обоих случаях стоит
`:6533`.

**На нашем стенде проверено: IAM отвечает на 6433**, том же порту, что и СУБД. Поэтому
дефолт `QDRANT_AUTH_URL = ${QDRANT_URL}/auth` верен и задавать ключ не нужно. Он всё
равно оставлен конфигурируемым (закомментирован в `02-configmap-backend.yaml`) — на
другом стенде IAM может оказаться на 6533:

```yaml
QDRANT_AUTH_URL: "https://tsled-oasis0001.esrt.sber.ru:6533/auth"
```

#### Что настроено в наборе

| Схема | Переменные | Что уходит в запрос к СУБД | Когда нужна |
|-------|------------|----------------------------|-------------|
| **IAM → JWT** (действующая) | `QDRANT_USERNAME` + `QDRANT_PASSWORD` | `Authorization: Bearer <токен от /auth>` | Platform V Vector DB — наш случай |
| Статический api-key | `QDRANT_API_KEY` | заголовок `api-key: <ключ>` (его ставит сам клиент) | только сырой Qdrant с включённой родной аутентификацией |

**Включать обе сразу нельзя.** Бэкенд падает на валидации конфига
(`QDRANT_API_KEY and QDRANT_USERNAME/QDRANT_PASSWORD are mutually exclusive…`).

Пара username/password **к СУБД не уходит никогда** — только к `/auth`. Дальше по сети
летит исключительно токен.

**Обновление токена происходит само.** За `QDRANT_TOKEN_REFRESH_SKEW_MS` (по умолчанию
5 минут) до истечения приложение запрашивает новый токен и пересоздаёт HTTP-клиент с
новым заголовком. Перезапускать под не нужно. Если IAM в этот момент недоступен —
в лог уходит `Failed to refresh Qdrant IAM token`, приложение продолжает работать на
текущем токене и повторяет попытку через 30 секунд. А вот если IAM недоступен **на
старте** — под падает сразу и с внятной ошибкой, это правильное поведение.

#### Симптом → причина → что делать

Все ответы ниже наблюдались на живом стенде (`tsled-oasis0001`, сервер 1.16.3).

| Ответ на `/collections` | Причина | Что делать |
|-------------------------|---------|------------|
| `200 {"result":{"collections":[…]},"status":"ok"}` | всё верно: mTLS + валидный JWT | — |
| `401 {"status":{"error":"Unauthorized: Must provide an API key or an Authorization bearer token"}}` | **токен не отправлен вовсе.** Тот же ответ приходит и на `Authorization: Basic` — Basic здесь не понимают, поэтому эта схема из приложения удалена | включить пару `QDRANT_USERNAME`/`QDRANT_PASSWORD` в `04-backend.yaml` |
| `401 {"status":{"error":"Invalid API key or JWT. If you are using API key while security RBAC is enabled, consider to use JWT"}}` | **отправлено не то**: заголовок `api-key` со значением пароля. Сервер прямым текстом просит JWT | убрать `QDRANT_API_KEY`, включить пару username/password |
| `403 {"status":{"error":"Forbidden: InvalidSignature"}}` | **токен подписан не тем секретом**, то есть выпущен не IAM'ом. Так отвечает сервер на самодельный HS256-JWT, подписанный паролем или логином: разобрать разобрал, а подпись не сошлась | не изобретать токен, брать его только через `POST /auth` |
| `ERR … handshake failure` / `socket hang up` | клиентский сертификат не предъявлен | раздел 3.1, `QDRANT_CERT_PATH`/`QDRANT_KEY_PATH` |

> Корень `/` отвечает `{"title":"qdrant - vector search engine",…}` и **без**
> аутентификации, поэтому проверять надо **`/collections`** — именно этот путь бэкенд
> дёргает на старте.

#### Проверка из вкладки Terminal бэкенд-пода

Однострочник делает ровно то же, что приложение: берёт `QDRANT_URL`, `QDRANT_USERNAME`,
`QDRANT_PASSWORD` из env пода, идёт по mTLS на `/auth`, вынимает токен из
`result.token` и сразу дёргает `/collections` с `Authorization: Bearer`. Ни пароль, ни
токен не печатаются — только длина токена и статусы:

```
node -e "const https=require('https'),fs=require('fs');const u=new URL(process.env.QDRANT_URL);const a=process.env.QDRANT_AUTH_URL?new URL(process.env.QDRANT_AUTH_URL):new URL('/auth',u);const tls={cert:fs.readFileSync('/certs/client_crt.crt'),key:fs.readFileSync('/certs/client_key.key'),ca:fs.readFileSync('/certs/cacert.pem'),passphrase:process.env.QDRANT_KEY_PASSPHRASE};const go=(o,b)=>new Promise((res,rej)=>{const r=https.request(Object.assign({},tls,o),x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>res({s:x.statusCode,d}))});r.on('error',rej);if(b)r.write(b);r.end()});(async()=>{const body=JSON.stringify({username:process.env.QDRANT_USERNAME,password:process.env.QDRANT_PASSWORD});const auth=await go({hostname:a.hostname,port:a.port||443,path:a.pathname,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},body);console.log('auth',auth.s,auth.s===200?'ok':auth.d.slice(0,200));if(auth.s!==200)return;const t=JSON.parse(auth.d).result.token;console.log('token length',t.length,'exp',new Date(JSON.parse(Buffer.from(t.split('.')[1],'base64url')).exp*1000).toISOString());const col=await go({hostname:u.hostname,port:u.port||443,path:'/collections',headers:{authorization:'Bearer '+t}});console.log('collections',col.s,col.d.slice(0,200))})().catch(e=>console.log('ERR',e.message,e.code))"
```

Ожидаемый вывод:

```
auth 200 ok
token length 512 exp 2026-07-31T14:30:00.000Z
collections 200 {"result":{"collections":[{"name":"cognivault"}]},"status":"ok","time":0.0001}
```

Если `auth` вернул не 200 — смотрите тело: 401 значит неверные ТУЗ/пароль в
`vectordb-creds`, `ERR … ECONNREFUSED` на порту 6533 — IAM всё-таки на 6433 (уберите
`QDRANT_AUTH_URL`), и наоборот.

**Что менять по итогу.** Обе схемы живут в `04-backend.yaml` (блок `env`): пара
`QDRANT_USERNAME`/`QDRANT_PASSWORD` через `secretKeyRef` на `vectordb-creds` включена,
вариант с `QDRANT_API_KEY` лежит рядом закомментированным. Переключение —
закомментировать один блок и раскомментировать другой; одновременно активными их
оставлять нельзя. В логах после рестарта поле `qdrantAuth` строки
`Qdrant client configured` покажет выбранную схему: `iam`, `api-key` или `none`.
Ни пароль, ни токен в логи не попадают — токен описывается только длиной и сроком
истечения (`Obtained Qdrant IAM token`, поля `tokenLength`, `expiresAt`).
---

## 4. Порядок применения

Консоль: **«+»** → **Import YAML** (`/k8s/ns/ci05490208-oasis-cognivault/import`),
по одному файлу за шаг, в этом порядке:

1. `02-configmap-backend.yaml`
2. `03-configmap-ui.yaml`
3. `04-backend.yaml` (Deployment + Service — многодокументный файл, вставляется целиком)
4. `05-ui.yaml`

Дальше — только по необходимости:

- `07-serviceentry-egress.yaml` — если Istio режет egress (`REGISTRY_ONLY`);
- `06-ingress.yaml` — **только** при развёртывании с нуля. В существующем окружении
  объект `oasis-cognivault-ingress` уже есть и уже смотрит на `cognivault-ui:8787`,
  трогать его не нужно. Подробности — шаг 7.

`00-secrets.example.yaml` и `99-qdrant-inhouse.yaml` **не импортировать**.

> ConfigMap'ы идут первыми не случайно: под бэкенда читает их через `envFrom` при
> старте. Если импортировать Deployment раньше — под упадёт на отсутствии конфига.

<details>
<summary><b>Если у вас есть CLI</b></summary>

```bash
NS=ci05490208-oasis-cognivault
kubectl apply -n $NS -f deploy/dropapp/02-configmap-backend.yaml
kubectl apply -n $NS -f deploy/dropapp/03-configmap-ui.yaml
kubectl apply -n $NS -f deploy/dropapp/04-backend.yaml
kubectl apply -n $NS -f deploy/dropapp/05-ui.yaml
# kubectl apply -n $NS -f deploy/dropapp/07-serviceentry-egress.yaml
# kubectl apply -n $NS -f deploy/dropapp/06-ingress.yaml
```
</details>

---

## 5. Проверка после выкатки

**Pods** → под `cognivault-…` → вкладка **Logs**. В логах бэкенда должны быть:

- `Intercepting TLS connections to the Qdrant host` — если задан CA и/или клиентский
  сертификат (при пустой TLS-конфигурации строки не будет, это нормально);
- **`Obtained Qdrant IAM token`** с полями `qdrantAuthUrl`, `tokenLength`, `expiresAt`,
  `expirySource` — обмен с IAM прошёл (только в режиме `iam`). Сам токен и пароль в лог
  не попадают: токен описывается длиной и сроком истечения. `expirySource: jwt-exp`
  значит, что срок взят из самого токена; `default-ttl` — что в токене не нашлось `exp`
  и применён фолбэк в один час;
- `Qdrant client configured` с полями `qdrantAuth`, `qdrantTls`, `qdrantClientCert`,
  `qdrantVerifySsl` — быстрый способ убедиться, что под подхватил именно ту конфигурацию,
  которую вы задали. `qdrantAuth` принимает три значения: `iam` (Platform V Vector DB,
  штатный режим), `api-key` (сырой Qdrant со статическим ключом) и `none`.
  Значения ключа, пароля и токена в лог не попадают никогда;
- **`Connected to Qdrant`** с версией сервера — подтверждает, что сеть и TLS отработали;
  на 401/403 эта строка появится, а вот следующий шаг (список коллекций) упадёт —
  смотрите раздел 3.5;
- примерно раз в час — **`Refreshed Qdrant IAM token`** с новым `expiresAt`. Это норма,
  а не признак проблемы: токен живёт час и обновляется сам. Строка
  `Failed to refresh Qdrant IAM token — retrying shortly` означает, что IAM временно
  недоступен; приложение продолжает работать на текущем токене и повторяет попытку
  через 30 секунд;
- создание/проверка коллекции `cognivault`;
- `Server listening`.

Health-эндпоинты — вкладка **Terminal** соответствующего пода:

```
node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"
```

```
python -c "import urllib.request as u; print(u.urlopen('http://127.0.0.1:8787/healthz').read().decode())"
```

UI видит бэкенд по Service? — из терминала пода UI:

```
python -c "import urllib.request as u; print(u.urlopen('http://cognivault:3000/health').read().decode())"
```

> Пробы бэкенда намеренно бьют в **`/health`**, а не в `/ready`: при незаданном
> `VAULT_PATH` (мультитенантный режим) `/ready` отдаёт 503 и под никогда не станет Ready.

Частые причины CrashLoop:

| Симптом в логах | Причина | Что делать |
|-----------------|---------|------------|
| ошибка подключения к Qdrant | DNS / egress / TLS / креды | прогнать проверки из шага 3.2 |
| `Cannot read QDRANT_CA_PATH "…": ENOENT` | в секрете нет ключа `cacert.pem` | добавить его в `cognivault-gigachat-certs` (шаг 2.1) или снять `QDRANT_CA_PATH` |
| `QDRANT_KEY_PATH is required when QDRANT_CERT_PATH is set` | задан только один из двух ключей mTLS | задать оба или убрать оба |
| `QDRANT_PASSWORD is required when QDRANT_USERNAME is set` | из пары для IAM задан только один ключ | проверить оба `secretKeyRef` на `vectordb-creds` |
| `Qdrant IAM … answered 401` | ТУЗ или пароль в `vectordb-creds` неверны. Пароль и токен в текст ошибки не попадают — в `detail` только обрезанное тело ответа | сверить креды с платформой, проверить однострочником из 3.5 |
| `Qdrant IAM … returned no recognised token field` | IAM ответил 200, но в теле нет токена. В сообщении перечислены **имена** ключей ответа (значений там нет намеренно) | по именам понять, что вернулось: `status` обычно значит ошибку внутри 200 |
| `Qdrant IAM request to … failed` | до IAM не достучались: DNS, egress, mTLS или неверный порт | если задан `QDRANT_AUTH_URL` — проверить порт; наш стенд отвечает на 6433, см. 3.5 |
| `401 … Must provide an API key or an Authorization bearer token` | токен не отправлен вовсе | включить пару `QDRANT_USERNAME`/`QDRANT_PASSWORD` — раздел 3.5 |
| `401 … Invalid API key or JWT … consider to use JWT` | отправлен `api-key` вместо JWT | убрать `QDRANT_API_KEY`, включить пару username/password |
| `403 … Forbidden: InvalidSignature` | токен подписан не тем секретом (выпущен не IAM'ом) | брать токен только через `POST /auth` |
| `QDRANT_API_KEY and QDRANT_USERNAME/QDRANT_PASSWORD are mutually exclusive…` | в `04-backend.yaml` активны оба варианта аутентификации | оставить ровно один блок `env`, второй закомментировать |
| жалоба на `EMBEDDING_DIMENSIONS` | размерность не задана/нечисловая или не совпала с коллекцией | `EMBEDDING_DIMENSIONS: "2560"`; при несовпадении — новая коллекция + reindex |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` на GigaChat | бандл `cacert.pem` не покрывает цепочку GigaChat | вернуть `GIGACHAT_VERIFY_SSL=false` и снять `GIGACHAT_CA_PATH` (см. 3.1) |
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

Под бэкенда → вкладка **Terminal**:

```
node dist/cli/index.js add-local-user bob --vault-path /data/vaults/bob
```

CLI печатает ключ вида `cv-…` — **сохраните его**, повторно он не показывается.
Запись идёт в `/data/users.json`, сервер подхватывает изменения на лету.

⚠️ И `users.json`, и папка волта `/data/vaults/bob` лежат на `emptyDir` и
**перезапуск пода не переживают**: после рестарта пользователя (и токен) придётся
создавать заново, а документы — заливать повторно. Держите исходники заметок
у себя локально.

### 6.2 Залить документы

**Копирования файлов в под нет** — `kubectl cp` / `oc cp` требуют CLI, которого в этом
окружении нет, а вкладка Terminal файлы не передаёт. Единственный рабочий способ —
**HTTP-загрузка zip-архива** (до 50 МБ):

- **из браузера через UI** — форма загрузки на странице волта (основной путь);
- либо программно: `POST /api/vault/upload`, `multipart/form-data`, поле `file`,
  заголовок `Authorization: Bearer cv-…`.

Файлы попадают в watched-каталог волта и подхватываются поллером в течение одного
цикла; полный reindex после заливки — шаг 6.3.

### 6.3 Запустить полную переиндексацию

Под бэкенда → вкладка **Terminal** (подставьте свой cv-токен вместо `cv-КЛЮЧ`):

```
node -e "fetch('http://127.0.0.1:3000/api/admin/reindex',{method:'POST',headers:{Authorization:'Bearer cv-КЛЮЧ','Content-Type':'application/json'},body:JSON.stringify({scope:'full'})}).then(r=>r.text()).then(console.log)"
```

Ответ `202` c `jobId`. Прогресс (подставьте `jobId`):

```
node -e "fetch('http://127.0.0.1:3000/api/admin/reindex/status?jobId=JOB_ID',{headers:{Authorization:'Bearer cv-КЛЮЧ'}}).then(r=>r.text()).then(console.log)"
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

**При штатном обновлении его трогать не надо.** `06-ingress.yaml` импортируется только
при развёртывании окружения с нуля. Сначала всегда смотрите фактическое состояние:
`/k8s/ns/ci05490208-oasis-cognivault/ingresses/oasis-cognivault-ingress/yaml`.

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

Как удалить: открыть
`/k8s/ns/ci05490208-oasis-cognivault/ingresses/oasis-cognivault-ingress/yaml`,
найти в `spec.rules` элемент с `host: qdrant.apps.bcayrqks.k8s.delta.sbrf.ru`,
удалить весь этот элемент целиком и сохранить. Никакого `patch --type=json`
не требуется — правка делается прямо в YAML-редакторе.

Альтернатива — импортировать `06-ingress.yaml`: он воспроизводит объект
**с одним правилом**.

> ⚠️ **TLS на входе не настроен.** Трафик идёт по обычному HTTP: cv-токены
> (`Authorization: Bearer cv-…`) и содержимое чатов передаются **открытым текстом**.
> Когда появится сертификат под этот host — добавить `spec.tls[].secretName`
> (шаблон закомментирован в `06-ingress.yaml`).

---

## 8. Что менять при обновлении версии

В штатном случае — **только две вещи**:

1. пин образа `sha-…` в Deployment'ах (оба образа собираются из одного коммита,
   обновлять их обычно нужно парой);
2. новые ключи в ConfigMap'ах, если релиз их добавил.

Порядок в консоли:

1. `/k8s/ns/ci05490208-oasis-cognivault/configmaps/cognivault-config/yaml` — добавить
   новые ключи (или импортировать обновлённый `02-configmap-backend.yaml`), сохранить.
2. `/k8s/ns/ci05490208-oasis-cognivault/deployments/cognivault/yaml` — вкладка **YAML**,
   поправить строку `image: sberosc.sigma.sbrf.ru/ghcr.io/coolcrazycool/cognivault:sha-…`,
   сохранить. Под перезапустится сам.
3. То же для `cognivault-ui`, если менялся и UI.
4. Дождаться готовности на странице Deployment, проверить **Logs** (шаг 5).

> Изменение ConfigMap **само по себе не перезапускает** под. Если правили только
> ConfigMap — **Actions** → **Restart rollout** на странице Deployment.

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
- разворачиваете окружение с нуля (шаг 6.3).

**Переиндексация НЕ нужна, когда:**

- меняется `GIGACHAT_QUERY_INSTRUCTION` — `EmbeddingsGigaR` асимметрична, инструкцию
  несёт только поисковый запрос, документы её не видят;
- меняются любые `RAG_*` у UI, промпты, температура, лимиты контекста;
- меняются таймауты, ретраи, размеры батчей, `LOG_LEVEL`;
- меняются `QDRANT_CA_PATH` / `QDRANT_CERT_PATH` / `QDRANT_VERIFY_SSL` — это транспорт,
  на содержимое векторов он не влияет;
- обновился образ без изменения модели/размерности эмбеддингов.

---

## 9. Резервный хост Qdrant

`QdrantClient` принимает **ровно один** URL, клиентской балансировки нет.
Переключение на резерв — правка одного ключа и рестарт:

1. `/k8s/ns/ci05490208-oasis-cognivault/configmaps/cognivault-config/yaml` →
   `QDRANT_URL: "https://tsled-oasis0002.esrt.sber.ru:6433"`, сохранить.
2. Страница Deployment `cognivault` → **Actions** → **Restart rollout**.
3. Дождаться готовности, проверить **Logs** на `Connected to Qdrant`.

Оба хоста уже перечислены в `qdrant-external-egress` (`07-serviceentry-egress.yaml`),
так что egress править не нужно. Креды `vectordb-creds` для обоих узлов одни и те же,
TLS-настройки (`QDRANT_*`) тоже — перехват настроится на новый host:port при старте. Если на резервном узле коллекция пустая — понадобится reindex (шаг 6.3).

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

1. **Под поднялся и подключился к Qdrant.** Страница Deployment `cognivault` — готовность;
   под → **Logs** — ждём `Qdrant client configured`, `Connected to Qdrant`,
   `Server listening`.
2. **Завести пользователя заново** — под → **Terminal**, выдаётся **НОВЫЙ** cv-токен,
   сохраните его:

   ```
   node dist/cli/index.js add-local-user bob --vault-path /data/vaults/bob
   ```

3. **Залить документы обратно** — только через HTTP-загрузку zip: из браузера через UI
   либо `POST /api/vault/upload` (поле `file`, до 50 МБ). Копирования файлов в под
   без CLI нет (шаг 6.2).
4. **Полная переиндексация** — под → **Terminal**:

   ```
   node -e "fetch('http://127.0.0.1:3000/api/admin/reindex',{method:'POST',headers:{Authorization:'Bearer cv-КЛЮЧ','Content-Type':'application/json'},body:JSON.stringify({scope:'full'})}).then(r=>r.text()).then(console.log)"
   ```

5. **Прогресс** (`jobId` из ответа шага 4):

   ```
   node -e "fetch('http://127.0.0.1:3000/api/admin/reindex/status?jobId=JOB_ID',{headers:{Authorization:'Bearer cv-КЛЮЧ'}}).then(r=>r.text()).then(console.log)"
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

- **CLI к кластеру нет** — всё через веб-консоль. Отсюда два практических следствия:
  файлы в под не скопировать (только HTTP-загрузка, шаг 6.2), а команды в поде
  вставляются одной строкой во вкладку Terminal.
- **Одна реплика каждого компонента.** `users.json` и SQLite-индекс рассчитаны ровно
  на одного писателя, а реплики не разделяют `/data` (у каждой свой `emptyDir`).
  `replicas > 1` без общего тома (RWX) и дизайна с несколькими писателями сломает данные.
- **TLS на Ingress нет** — трафик, включая cv-токены, идёт открытым текстом (шаг 7).
- **Внешний Qdrant должен быть доступен на старте** — иначе бэкенд не поднимется.
  Проверять связность до выкатки (шаг 3.2).
- **`GIGACHAT_VERIFY_SSL: "false"`** — временный escape hatch, пока нет CA-бандла.
- **Внутрикластерный Qdrant — v1.3.0**, единственная версия, прошедшая скан SberOSC.
  Для Волны 3 (гибридный поиск на стороне Qdrant) понадобится 1.16.3 — её надо
  заранее провести через скан.
- **OpenShift-специфика.** Если когда-нибудь появится доступ к OpenShift-кластеру,
  в нём вместо Ingress используются `Route`, а сборка — `BuildConfig`/`ImageStream`.
  В этом кластере (ванильный Kubernetes + nginx Ingress) они **не применяются**.
