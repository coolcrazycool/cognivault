#!/usr/bin/env bash
# Обновление CogniVault UI.
#
# Данные (~/.cognivault-ui: config.json, certs/, history/, venv/) НЕ трогаются —
# обновляется только КОД в этой папке. Порядок обновления:
#   1) остановите сервер (Ctrl+C)
#   2) замените код новой версией из РОДИТЕЛЬСКОЙ папки:  unzip -o cognivault-ui.zip
#   3) bash update.sh      (обновит зависимости в существующем venv)
#   4) bash run.sh         (запуск)
set -euo pipefail

DATA="${COGNIVAULT_UI_HOME:-$HOME/.cognivault-ui}"
VENV="$DATA/venv"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ ! -x "$VENV/bin/pip" ]; then
  echo "[update] venv не найден в $VENV"
  echo "[update] это первая установка — запустите:  SBEROSC_TOKEN=<токен> python3 bootstrap.py"
  exit 1
fi

echo "[update] обновляю зависимости в $VENV …"
# venv/pip.conf уже содержит index-url зеркала SberOSC + токен (создан bootstrap-ом);
# передаём его явно на случай, если pip его не подхватит автоматически.
PIP_CONFIG_FILE="$VENV/pip.conf" "$VENV/bin/pip" install -r "$HERE/requirements.txt"

echo "[update] готово. Запуск:  bash run.sh"
