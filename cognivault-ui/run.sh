#!/usr/bin/env bash
set -euo pipefail

# Run the CogniVault UI server from the bootstrapped virtualenv.
# Bind to localhost only — config, certs, and tokens never leave this machine.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

exec ~/.cognivault-ui/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8787
