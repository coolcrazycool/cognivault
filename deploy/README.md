> ## ⚠️ УСТАРЕЛО
>
> Актуальный способ развёртывания — набор манифестов
> **[`deploy/dropapp/`](dropapp/README.md)** (бэкенд + UI + Service + Ingress +
> egress, пины образов `sha-fd27f9f`). Разворачивайте окружение по нему.
>
> Этот файл описывает bare-metal-установку на systemd и оставлен **для истории**:
> он не знает ни про UI (`cognivault-ui/`), ни про внешний Qdrant Platform V
> Vector DB (mTLS + JWT от IAM), ни про переменные окружения, добавленные
> последними волнами. Ничего отсюда не применяйте, не сверившись
> с `deploy/dropapp/`.

# Deploying CogniVault without Docker

Bare-metal deployment on a Linux server using **systemd**, with **Qdrant as a native
binary** and the app **built on the server**. This mirrors the production stage of the
`Dockerfile`, minus the container.

## Architecture on the box

```
systemd ── qdrant.service        → /opt/qdrant/qdrant      (127.0.0.1:6333)
        └─ cognivault.service    → node /opt/cognivault/dist/server.js  (:3000)
                                     ├─ spawns `ob sync` per user (obsidian-headless)
                                     ├─ SQLite via better-sqlite3  (native module)
                                     └─ talks to Qdrant over loopback
```

## 0. Prerequisites (one-time)

```bash
# Node.js 22 (NodeSource) — puts node + global bins in /usr/bin
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Toolchain to compile better-sqlite3 (native module)
sudo apt-get install -y build-essential python3

# pnpm
sudo corepack enable

# obsidian-headless — provides the `ob` CLI the app shells out to.
# Needed ONLY for Obsidian-synced vaults (add-user). Skip it entirely if every user
# is a "local folder" user (add-local-user) — see step 4.
sudo npm install -g obsidian-headless
which ob node   # confirm both resolve under /usr/bin or /usr/local/bin
```

## 1. Qdrant (native binary + systemd)

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin qdrant
sudo mkdir -p /opt/qdrant /var/lib/qdrant/{storage,snapshots}

# Download the latest static Linux binary from GitHub Releases:
#   https://github.com/qdrant/qdrant/releases  (asset: qdrant-x86_64-unknown-linux-gnu.tar.gz)
curl -fsSL -o /tmp/qdrant.tar.gz \
  https://github.com/qdrant/qdrant/releases/latest/download/qdrant-x86_64-unknown-linux-gnu.tar.gz
sudo tar -xzf /tmp/qdrant.tar.gz -C /opt/qdrant
sudo chown -R qdrant:qdrant /opt/qdrant /var/lib/qdrant

sudo cp /opt/cognivault/deploy/qdrant.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qdrant
curl -s http://127.0.0.1:6333/readyz   # -> "all shards are ready"
```

> Prefer managed Qdrant (Qdrant Cloud)? Skip this section, set `QDRANT_URL=https://…`
> in `.env`, and remove the `Requires=qdrant.service` line from `cognivault.service`.

## 2. Application

```bash
sudo useradd --system --create-home --home-dir /opt/cognivault --shell /bin/bash cognivault
sudo -u cognivault git clone https://github.com/coolcrazycool/cognivault.git /opt/cognivault
cd /opt/cognivault

# Configure
sudo -u cognivault cp .env.example .env
sudo -u cognivault $EDITOR .env       # set VAULT_PATH, QDRANT_URL, embedding provider…

# Build + prune (or just run deploy/update.sh, which does all of this)
sudo -u cognivault corepack enable
sudo -u cognivault pnpm install --frozen-lockfile
sudo -u cognivault pnpm run build
sudo -u cognivault pnpm prune --prod
```

DB migrations run automatically on first start (drizzle `migrate()` reads `drizzle/`),
so keep the `drizzle/` folder next to `dist/`.

## 3. Service

```bash
sudo cp /opt/cognivault/deploy/cognivault.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cognivault

systemctl status cognivault
curl -s http://127.0.0.1:3000/health
journalctl -u cognivault -f          # logs
```

## 4. Users

`cognivault-ctl` == `dist/cli/index.js`. Two kinds of users:

```bash
# (a) Obsidian-synced vault — runs `ob login` / `ob sync-setup`, needs obsidian-headless
sudo -u cognivault node /opt/cognivault/dist/cli/index.js add-user \
  --id alice --vault MyVault --obsidian-email … --obsidian-password … --openai-key …

# (b) Plain local folder — you edit files there yourself, no `ob`, no obsidian-headless.
#     --openai-key is optional (omit it on a GigaChat / non-OpenAI provider).
sudo -u cognivault node /opt/cognivault/dist/cli/index.js add-local-user \
  --id bob --vault-path /srv/notes/bob
```

The filesystem poller indexes whatever is in the folder within `POLL_INTERVAL_MS +
STABILITY_DELAY_MS`, regardless of how the files got there.

## 5. GigaChat embeddings (optional)

If `EMBEDDING_PROVIDER=gigachat`, place the mTLS PEM files on the server and point
`.env` at them (keep them readable only by the `cognivault` user):

```bash
sudo install -d -o cognivault -g cognivault -m 700 /opt/cognivault/certs
sudo install -o cognivault -g cognivault -m 600 client.pem client.key /opt/cognivault/certs/
```

```env
EMBEDDING_PROVIDER=gigachat
EMBEDDING_DIMENSIONS=<vector size of EmbeddingsGigaR>
GIGACHAT_CERT_PATH=/opt/cognivault/certs/client.pem
GIGACHAT_KEY_PATH=/opt/cognivault/certs/client.key
# GIGACHAT_CA_PATH=/opt/cognivault/certs/russian-ca-bundle.pem
```

> Switching embedding provider/model to a different vector size needs a **fresh Qdrant
> collection + re-index** — the app fails fast on a size mismatch at startup.

## Redeploys

```bash
sudo -u cognivault APP_DIR=/opt/cognivault deploy/update.sh
```

## Gotchas

- **`better-sqlite3` is native** — always build on the server (or a matching
  OS/arch/Node-ABI box). Never copy `node_modules` from macOS to Linux.
- **`ob` on PATH** — if the service can't find `ob`, vault sync silently fails. The unit
  sets `PATH=/usr/local/bin:/usr/bin:/bin`.
- **systemd hardening vs `ob`** — `ProtectHome=true` hides the obsidian auth token; see
  the notes inside `cognivault.service` before enabling it.
