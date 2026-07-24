#!/usr/bin/env python3
"""First-run provisioner for CogniVault UI (standard library only).

Creates ``~/.cognivault-ui/{certs,history,tmp}``, writes a default config if
absent, builds a virtualenv, and installs dependencies from the SberOSC mirror.

A single run can succeed end-to-end: the SberOSC token is taken from
``--sberosc-token``, the ``SBEROSC_TOKEN`` env var, the existing config, or an
interactive prompt (TTY only), then persisted to config *before* the pip step.

Run:  ``python3 bootstrap.py --sberosc-token <TOKEN>``
  or:  ``SBEROSC_TOKEN=<TOKEN> python3 bootstrap.py``
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import subprocess
import sys
import venv
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(os.path.expanduser("~/.cognivault-ui"))
CERTS = ROOT / "certs"
HISTORY = ROOT / "history"
TMP = ROOT / "tmp"
VENV = ROOT / "venv"

PROJECT_DIR = Path(__file__).resolve().parent
REQUIREMENTS = PROJECT_DIR / "requirements.txt"

PIP_INDEX_URL = "https://sberosc.sigma.sbrf.ru/repo/pypi/simple"

# The SberOSC pip.conf helper is stdlib-only, so import it from the app package
# (bootstrap runs from PROJECT_DIR, which puts ``app`` on sys.path). If that ever
# fails, fall back to an inline copy so bootstrap stays self-sufficient.
try:
    from app.config import build_pip_conf, migrate_pip_index_url
except Exception:  # noqa: BLE001 — keep bootstrap dependency-free

    def migrate_pip_index_url(url: str) -> str:
        try:
            parts = urlsplit(url)
        except (ValueError, TypeError):
            return url
        host = parts.hostname or ""
        if "sberosc." in host and parts.path == "/pypi/simple":
            return urlunsplit(parts._replace(path="/repo/pypi/simple"))
        return url

    def build_pip_conf(index_url: str, token: str) -> tuple[str, str, str]:
        parts = urlsplit(index_url)
        trusted_host = parts.hostname or ""
        has_userinfo = "@" in parts.netloc
        if token and not has_userinfo:
            prefix = f"{parts.scheme}://" if parts.scheme else ""
            rest = (
                index_url[len(prefix):]
                if prefix and index_url.startswith(prefix)
                else index_url
            )
            auth_url = f"{prefix}token:{token}@{rest}"
            redacted = f"{prefix}token:***@{rest}"
        else:
            auth_url = index_url
            redacted = index_url
        text = (
            "[global]\n"
            f"index-url={auth_url}\n"
            f"trusted-host={trusted_host}\n"
            "default-timeout=120\n"
        )
        return text, redacted, trusted_host

# Kept in sync with app/config.py:DEFAULT_CONFIG (this file must stay stdlib-only,
# so the value is duplicated rather than imported).
DEFAULT_CONFIG = {
    "version": 1,
    "cognivault": {"base_url": "http://localhost:3000", "token": ""},
    "gigachat": {
        "base_url": "https://gigachat-ift.sberdevices.delta.sbrf.ru/v1",
        "model": "GigaChat-3-Ultra-preview",
        "cert_path": "~/.cognivault-ui/certs/client_crt.crt",
        "key_path": "~/.cognivault-ui/certs/client_key.key",
        "key_passphrase": "",
        "verify_ssl": False,
        "temperature": 0.2,
        "max_tokens": 4096,
    },
    "rag": {
        "default_on": False,
        "source": "semantic",
        "limit": 5,
        "min_score": None,
        "token_budget": 3000,
        "max_context_chars": 12000,
    },
    "env": {
        "pip_index_url": PIP_INDEX_URL,
        "pip_token": "",
    },
    "ui": {"theme": "auto"},
}


def log(msg: str) -> None:
    print(f"[bootstrap] {msg}", flush=True)


def make_dirs() -> None:
    log("создаю каталоги в ~/.cognivault-ui …")
    for d in (ROOT, CERTS, HISTORY, TMP):
        d.mkdir(parents=True, exist_ok=True)


def write_default_config() -> None:
    config_file = ROOT / "config.json"
    if config_file.exists():
        log("config.json уже существует — не трогаю")
        return
    config_file.write_text(
        json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    log(f"записан {config_file}")


def make_venv() -> None:
    log(f"создаю виртуальное окружение в {VENV} …")
    try:
        venv.create(str(VENV), with_pip=True, clear=True)
    except Exception as exc:  # noqa: BLE001 — fall back to the CLI module
        log(f"venv.create не сработал ({exc}); пробую python -m venv")
        subprocess.check_call([sys.executable, "-m", "venv", "--clear", str(VENV)])


def pip_path() -> Path:
    return VENV / ("Scripts" if os.name == "nt" else "bin") / "pip"


def _read_env_config() -> tuple[str, str]:
    """Return ``(pip_index_url, pip_token)`` from config.json, falling back to
    the default index URL and an empty token."""
    config_file = ROOT / "config.json"
    try:
        data = json.loads(config_file.read_text(encoding="utf-8"))
        env = data.get("env", {}) if isinstance(data, dict) else {}
        index_url = str(env.get("pip_index_url", "") or "") or PIP_INDEX_URL
        token = str(env.get("pip_token", "") or "")
        return index_url, token
    except Exception:  # noqa: BLE001 — missing/invalid config → defaults
        return PIP_INDEX_URL, ""


_PROMPT = (
    "Введите токен SberOSC (Профиль → скопировать токен), "
    "или Enter чтобы пропустить: "
)


def resolve_credentials(
    cli_token: str | None, cli_index_url: str | None
) -> tuple[str, str]:
    """Resolve ``(pip_index_url, pip_token)`` from all sources.

    Token priority: ``--sberosc-token`` → ``SBEROSC_TOKEN`` env → ``env.pip_token``
    in config.json → interactive prompt (only if stdin is a TTY and still empty).

    Index URL priority: ``--pip-index-url`` → ``PIP_INDEX_URL`` env →
    ``env.pip_index_url`` in config.json → the built-in default.
    """
    config_index_url, config_token = _read_env_config()

    index_url = (
        (cli_index_url or "").strip()
        or os.environ.get("PIP_INDEX_URL", "").strip()
        or config_index_url
    )

    token = (
        (cli_token or "").strip()
        or os.environ.get("SBEROSC_TOKEN", "").strip()
        or config_token
    )

    if not token and sys.stdin.isatty():
        try:
            token = getpass.getpass(_PROMPT).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            token = ""

    return index_url, token


def persist_env(index_url: str, token: str) -> None:
    """Write ``env.pip_index_url`` / ``env.pip_token`` into config.json.

    Deep-merges over the current file contents and writes atomically (temp file +
    ``os.replace``), mirroring ``app.config.save_config``. Never logs the token.
    """
    config_file = ROOT / "config.json"
    try:
        parsed = json.loads(config_file.read_text(encoding="utf-8"))
        data = parsed if isinstance(parsed, dict) else {}
    except Exception:  # noqa: BLE001 — missing/invalid → start from defaults
        data = json.loads(json.dumps(DEFAULT_CONFIG))

    env = data.get("env")
    if not isinstance(env, dict):
        env = {}
    env["pip_index_url"] = index_url
    env["pip_token"] = token
    data["env"] = env

    tmp = config_file.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(tmp, config_file)
    log("сохранил env.pip_index_url / env.pip_token в config.json")


def install_deps() -> None:
    log("устанавливаю зависимости через зеркало SberOSC …")
    index_url, token = _read_env_config()
    index_url = migrate_pip_index_url(index_url)
    pip_conf_text, redacted_index, _trusted_host = build_pip_conf(index_url, token)

    pip_conf_path = VENV / "pip.conf"
    pip_conf_path.write_text(pip_conf_text, encoding="utf-8")
    log(f"записан {pip_conf_path}")
    log(f"index-url={redacted_index}")

    if not token:
        log(
            "Токен SberOSC пуст — получите его в Профиле "
            "(https://sberosc.sigma.sbrf.ru/dashboard/profile/) и впишите "
            "env.pip_token в ~/.cognivault-ui/config.json, либо задайте в "
            "UI → Настройки → Окружение. Пробую установку — возможно, "
            "учётные данные уже заданы в глобальном pip.conf."
        )

    env = os.environ.copy()
    env["PIP_CONFIG_FILE"] = str(pip_conf_path)
    cmd = [str(pip_path()), "install", "-r", str(REQUIREMENTS)]
    subprocess.check_call(cmd, env=env)


def print_instructions() -> None:
    uvicorn = VENV / ("Scripts" if os.name == "nt" else "bin") / "uvicorn"
    print()
    log("готово! запустить сервер:")
    print(f"    {uvicorn} app.main:app --host 127.0.0.1 --port 8787")
    print("  или:")
    print(f"    bash {PROJECT_DIR / 'run.sh'}")
    print()
    log("откройте интерфейс в браузере: http://localhost:8787")
    log("НЕ открывайте через file:// — SPA работает только через сервер.")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="bootstrap.py",
        description=(
            "Первичная настройка CogniVault UI: создаёт ~/.cognivault-ui, venv "
            "и ставит зависимости через зеркало SberOSC за один прогон."
        ),
        epilog=(
            "Токен SberOSC берётся по порядку: --sberosc-token, переменная "
            "окружения SBEROSC_TOKEN, env.pip_token из config.json, затем "
            "интерактивный ввод (только если stdin — терминал). Токен нигде "
            "не печатается — в логах только «token:***@…»."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--sberosc-token",
        metavar="TOKEN",
        default=None,
        help=(
            "токен SberOSC (Профиль → скопировать токен). Альтернатива — "
            "переменная окружения SBEROSC_TOKEN."
        ),
    )
    parser.add_argument(
        "--pip-index-url",
        metavar="URL",
        default=None,
        help=(
            "переопределить index-url зеркала pip (по умолчанию "
            f"{PIP_INDEX_URL}). Альтернатива — переменная PIP_INDEX_URL."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    make_dirs()
    write_default_config()

    index_url, token = resolve_credentials(args.sberosc_token, args.pip_index_url)
    migrated_index_url = migrate_pip_index_url(index_url)
    if migrated_index_url != index_url:
        log(f"исправляю устаревший адрес зеркала → {migrated_index_url}")
        index_url = migrated_index_url
    persist_env(index_url, token)

    make_venv()
    try:
        install_deps()
    except subprocess.CalledProcessError as exc:
        log(f"pip install завершился с ошибкой (код {exc.returncode})")
        return exc.returncode or 1
    print_instructions()
    return 0


if __name__ == "__main__":
    sys.exit(main())
