#!/usr/bin/env bash
# Build & (re)deploy CogniVault on the server. Idempotent — safe to re-run.
# Usage: sudo -u cognivault deploy/update.sh   (run from /opt/cognivault)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/cognivault}"
SERVICE="${SERVICE:-cognivault}"

cd "$APP_DIR"

echo "==> Pulling latest source"
git pull --ff-only

echo "==> Enabling corepack / pnpm"
corepack enable >/dev/null 2>&1 || true

echo "==> Installing dependencies (incl. devDeps for the tsc build)"
# Full install: build needs typescript. better-sqlite3 compiles for THIS host here.
pnpm install --frozen-lockfile

echo "==> Building (tsc -> dist/)"
pnpm run build

echo "==> Pruning dev dependencies"
pnpm prune --prod

# Migrations are applied automatically at startup (drizzle migrate() in src/db/client.ts),
# so the drizzle/ folder must stay next to dist/. No manual migration step needed.

echo "==> Restarting service"
sudo systemctl restart "$SERVICE"
sudo systemctl --no-pager status "$SERVICE" | head -n 12

echo "==> Done."
