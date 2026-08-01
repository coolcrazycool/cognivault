"""Кладёт `tools/rag_audit` в sys.path — инструменты там лежат скриптами, не пакетом."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
