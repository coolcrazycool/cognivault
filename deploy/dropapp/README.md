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
| бэкенд | `sberosc.sigma.sbrf.ru/ghcr.io/coolcrazycool/cognivault:sha-895f591` |
| UI | `sberosc.sigma.sbrf.ru/ghcr.io/coolcrazycool/cognivault-ui:sha-f8a989d` |

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

- **внешний Qdrant** DropApp — `https://tsled-oasis0001.esrt.sber.ru:6433` (резерв `…0002`);
- **Secret `vectordb-creds`** (`username`, `password`) — заводит платформа DropApp.
  У внешнего Qdrant включена его РОДНАЯ аутентификация, поэтому используется только
  ключ `password` — как значение `QDRANT_API_KEY` (заголовок `api-key`), см. 3.5;
- **Secret `sberosc-pull`** — создаёте вы (шаг 2);
- **GigaChat** — `https://gigachat-ift.sberdevices.delta.sbrf.ru/v1`, авторизация клиентским сертификатом (mTLS).

Схема потоков:

```
Ingress oasis-cognivault-ingress (nginx, HTTP, без TLS)
  host cognivault-ui.apps.bcayrqks.k8s.delta.sbrf.ru
   └─> Service cognivault-ui:8787 ──> под UI ──┬─> Service cognivault:3000 ─> под бэкенда
                                               │        └─> внешний Qdrant :6433 (api-key + mTLS)
                                               │        └─> GigaChat (эмбеддинги, mTLS)
                                               ├─> GigaChat (генерация ответа, mTLS)
                                               └─> Confluence (опционально)
```

---

## 1. Предусловия

- Доступ в веб-консоль DropApp к namespace `ci05490208-oasis-cognivault`.
- Секрет **`vectordb-creds`** уже есть в namespace (его заводит платформа). Проверить:
  **Secrets** → в списке должен быть `vectordb-creds` с ключами `username`, `password`.
  Если его нет — запросить у платформы, без него бэкенд не стартует. По умолчанию
  используется только `password` — это api-key родной аутентификации Qdrant (раздел 3.5).
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
| `QDRANT_CERT_PATH` | ConfigMap | `/certs/client_crt.crt` | клиентский сертификат для прокси, требующего mTLS |
| `QDRANT_KEY_PATH` | ConfigMap | `/certs/client_key.key` | приватный ключ к нему. Задаётся **только вместе** с `QDRANT_CERT_PATH`, иначе приложение падает на валидации конфига |
| `QDRANT_KEY_PASSPHRASE` | Secret `cognivault-gigachat-certs`, ключ `key.passphrase` (`optional: true`) | не задан | пароль приватного ключа, если он зашифрован |
| `QDRANT_VERIFY_SSL` | ConfigMap | `true` | проверка сертификата сервера. `false` — временный escape hatch, гасит проверку **только** для Qdrant |

Все три файла лежат в одном секрете `cognivault-gigachat-certs`, смонтированном
в `/certs` (шаг 2.1) — отдельного секрета под CA нет.

Если не задано ничего (нет CA, нет пары cert+key, `QDRANT_VERIFY_SSL=true`),
перехват **не устанавливается вовсе** и TLS работает ровно как раньше.

> **Про клиентский сертификат.** По словам сопровождения, прокси перед внешним
> Qdrant требует mTLS, но **не специальный** сертификат: подойдёт любая валидная
> пара. Поэтому переиспользуется та же пара, что и для GigaChat
> (`/certs/client_crt.crt`, `/certs/client_key.key`). Если окажется, что прокси mTLS
> не требует, эти два ключа можно убрать из ConfigMap.

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

> Однострочники ниже проверяют **связность и TLS** — заголовок `Authorization: Basic`
> в них исторический и на результат этой проверки не влияет (при включённом
> `QDRANT_API_KEY` переменных `QDRANT_USERNAME`/`QDRANT_PASSWORD` в env пода вообще
> нет, и в заголовок уйдёт `:`). Аутентификация проверяется отдельно — раздел 3.5.

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

**UI-под (`python:3.12-alpine`, есть `python`)** — независимая проверка сети и Basic-auth.
Подставьте логин/пароль из `vectordb-creds` (их видно в консоли: **Secrets** →
`vectordb-creds` → **Reveal values**):

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
| `{"title":"qdrant - vector search engine",…}` | сеть и TLS рабочие (корень `/` у Qdrant открыт и без аутентификации — про креды это ничего не говорит) | проверить `/collections`, раздел 3.5 |
| `401` + тело `{"status":{"error":"Unauthorized: Must provide an API key or an Authorization bearer token"}}` | это ответ **самого Qdrant**: включена его родная аутентификация, а мы прислали не тот заголовок (или ничего). Basic тут не подходит и вдобавок мешает | задать `QDRANT_API_KEY` из `vectordb-creds/password`, Basic **выключить** — раздел 3.5 |
| `401` / HTML-страница логина от прокси, `WWW-Authenticate: Basic`, про api key ни слова | 401 отдаёт **прокси** перед Qdrant: нужна Basic-аутентификация | проверить `username`/`password` в `vectordb-creds`, включить пару `QDRANT_USERNAME`/`QDRANT_PASSWORD` (раздел 3.5) |
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

### 3.5 Аутентификация Qdrant: `api-key` или Basic

TLS и аутентификация — разные слои, и они ломаются по очереди: сначала не сходился
TLS, потом заработавшее соединение упёрлось в 401. Схем аутентификации две, и они
**взаимоисключающие**:

| Схема | Переменные | Что уходит в запрос | Когда нужна |
|-------|------------|---------------------|-------------|
| Родная аутентификация Qdrant | `QDRANT_API_KEY` | заголовок `api-key: <ключ>` (его ставит сам клиент) | Qdrant включил свою аутентификацию — наш случай |
| HTTP Basic | `QDRANT_USERNAME` + `QDRANT_PASSWORD` | `Authorization: Basic …` | перед Qdrant стоит реверс-прокси со своей Basic-аутентификацией |

**Включать обе сразу нельзя.** Бэкенд падает на валидации конфига
(`QDRANT_API_KEY and QDRANT_USERNAME/QDRANT_PASSWORD are mutually exclusive…`), и это
не перестраховка: Qdrant видит непустой `Authorization`, который не `Bearer`, и
отвечает 401 даже при верном api-key. Именно поэтому старая пара Basic не просто «не
помогала», а **мешала**.

**Как определить, что нужно, — по телу ответа 401:**

- `{"status":{"error":"Unauthorized: Must provide an API key or an Authorization bearer
  token"}}` — это формат **самого Qdrant**. Значит родная аутентификация: нужен
  `QDRANT_API_KEY`, Basic убрать.
- HTML-страница логина, `WWW-Authenticate: Basic`, текст от nginx/шлюза, про api key ни
  слова — 401 отдаёт **прокси**: нужна пара `QDRANT_USERNAME`/`QDRANT_PASSWORD`.

> Корень `/` у Qdrant отвечает `{"title":"qdrant - vector search engine",…}` и без
> аутентификации, поэтому проверять надо **`/collections`** — именно этот путь бэкенд
> дёргает на старте.

**Перебор вариантов из вкладки Terminal бэкенд-пода.** Однострочник по очереди пробует
`api-key`, `Bearer`, `Basic` и «без аутентификации». Идёт через `node:https` **с
клиентским сертификатом и CA из `/certs`** — без них соединение просто не установится и
до 401 дело не дойдёт. Ключ берётся из `QDRANT_API_KEY`, а если его нет — из
`QDRANT_PASSWORD`:

```
node -e "const https=require('https'),fs=require('fs');const u=new URL(process.env.QDRANT_URL);const k=process.env.QDRANT_API_KEY||process.env.QDRANT_PASSWORD||'';const b=Buffer.from((process.env.QDRANT_USERNAME||'')+':'+(process.env.QDRANT_PASSWORD||'')).toString('base64');const o={hostname:u.hostname,port:u.port||443,path:'/collections',cert:fs.readFileSync('/certs/client_crt.crt'),key:fs.readFileSync('/certs/client_key.key'),ca:fs.readFileSync('/certs/cacert.pem'),passphrase:process.env.QDRANT_KEY_PASSPHRASE};const v=[['api-key',{'api-key':k}],['bearer',{authorization:'Bearer '+k}],['basic',{authorization:'Basic '+b}],['none',{}]];(async()=>{for(const [n,h] of v){await new Promise(res=>{https.request(Object.assign({},o,{headers:h}),r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{console.log(n,r.statusCode,d.slice(0,120));res()})}).on('error',e=>{console.log(n,'ERR',e.message,e.code);res()}).end()})}})()"
```

Ожидаемый вывод при родной аутентификации Qdrant:

```
api-key 200 {"result":{"collections":[...]},"status":"ok",...}
bearer 401 {"status":{"error":"Unauthorized: Must provide an API key or an Authorization bearer token"}}
basic 401 {"status":{"error":"Unauthorized: Must provide an API key or an Authorization bearer token"}}
none 401 {"status":{"error":"Unauthorized: Must provide an API key or an Authorization bearer token"}}
```

Строка `basic` в перебор попадает даже когда `QDRANT_USERNAME`/`QDRANT_PASSWORD` в env
пода не заданы (тогда она заведомо бесполезна) — при необходимости подставьте креды из
`vectordb-creds` прямо в команду. Если 200 отдаёт `bearer`, а не `api-key`, — перед
Qdrant всё-таки прокси с Bearer-токеном; тогда пишите в задачу, поддержки этой схемы
в конфиге сейчас нет.

**Что менять по итогу.** Обе схемы живут в `04-backend.yaml` (блок `env`): вариант с
`QDRANT_API_KEY` через `secretKeyRef` на `vectordb-creds`/`password` включён, вариант с
`QDRANT_USERNAME`/`QDRANT_PASSWORD` лежит рядом закомментированным. Переключение —
закомментировать один блок и раскомментировать другой; одновременно активными их
оставлять нельзя. В логах после рестарта поле `qdrantAuth` строки
`Qdrant client configured` покажет выбранную схему: `api-key`, `basic` или `none`.
Ни ключ, ни пароль в логи не попадают.

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
- `Qdrant client configured` с полями `qdrantAuth`, `qdrantTls`, `qdrantClientCert`,
  `qdrantVerifySsl` — быстрый способ убедиться, что под подхватил именно ту конфигурацию,
  которую вы задали. `qdrantAuth` принимает три значения: `api-key` (родная
  аутентификация Qdrant, штатный режим), `basic` (прокси с HTTP Basic) и `none`.
  Значения ключа и пароля в лог не попадают никогда;
- **`Connected to Qdrant`** с версией сервера — подтверждает, что сеть и TLS отработали;
  на 401 эта строка появится, а вот следующий шаг (список коллекций) упадёт — смотрите
  раздел 3.5;
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
| `QDRANT_PASSWORD is required when QDRANT_USERNAME is set` | задан только один ключ Basic-auth | проверить оба `secretKeyRef` на `vectordb-creds` |
| `401 … Must provide an API key or an Authorization bearer token` | 401 отдаёт **сам Qdrant**: включена его родная аутентификация, а мы прислали Basic либо ничего | задать `QDRANT_API_KEY` из `vectordb-creds/password`, пару `QDRANT_USERNAME`/`QDRANT_PASSWORD` убрать — раздел 3.5 |
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
