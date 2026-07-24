"""Environment provisioning: venv/pip setup (streamed), export & import of the
``~/.cognivault-ui`` data directory.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator

from .config import DEFAULT_CONFIG, PATHS, AppPaths, build_pip_conf
from .sse import format_sse

# Path to this app package's directory (…/cognivault-ui/app) and its parent.
_APP_DIR = Path(__file__).resolve().parent
_PROJECT_DIR = _APP_DIR.parent  # …/cognivault-ui
_REQUIREMENTS = _PROJECT_DIR / "requirements.txt"

# Only one setup may run at a time (per-process).
setup_lock = asyncio.Lock()

# Whitelist for import entry names.
_IMPORT_WHITELIST = re.compile(
    r"^(config\.json|requirements\.txt|certs/[^/]+|history/[^/]+\.json)$"
)


# --------------------------------------------------------------------------- #
# Setup (streamed)
# --------------------------------------------------------------------------- #


def _redact(text: str, token: str) -> str:
    if token:
        text = text.replace(token, "***")
        # Also redact a token embedded in a URL (https://TOKEN@host).
        text = re.sub(r"(https?://)[^@\s/]+@", r"\1***@", text)
    return text


async def _stream_subprocess(
    cmd: list[str], token: str = "", env: dict[str, str] | None = None
) -> AsyncIterator[str]:
    """Run ``cmd``, yielding each stdout/stderr line as an SSE ``log`` frame.

    The final line yielded is a sentinel ``__RC__:<code>`` (not an SSE frame) so
    the caller can read the return code. Each emitted line is scrubbed of
    ``token`` (defensive — the token must never reach the log stream).
    """
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
    )
    assert proc.stdout is not None
    async for raw in proc.stdout:
        line = raw.decode("utf-8", errors="replace").rstrip("\n")
        yield format_sse("log", {"line": _redact(line, token)})
    rc = await proc.wait()
    yield f"__RC__:{rc}"


async def setup_stream(paths: AppPaths | None = None) -> AsyncIterator[str]:
    """Provision the data dir + venv + deps, streaming SSE frames.

    Emits ``step`` / ``log`` frames throughout and terminates with a single
    ``done`` (ok) or ``error`` frame.
    """
    paths = paths or PATHS
    from .config import load_config

    cfg = load_config(paths)
    env_cfg = cfg.get("env", {})
    pip_index = str(env_cfg.get("pip_index_url", "")) or DEFAULT_CONFIG["env"][
        "pip_index_url"
    ]
    pip_token = str(env_cfg.get("pip_token", "") or "")

    # Step: mkdir
    yield format_sse("step", {"name": "mkdir", "label": "Создание каталогов"})
    paths.ensure_dirs()

    # Step: config (never clobber an existing config.json)
    yield format_sse("step", {"name": "config", "label": "Инициализация конфигурации"})
    if not paths.config_file.exists():
        import json

        paths.config_file.write_text(
            json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        yield format_sse("log", {"line": f"записан {paths.config_file}"})
    else:
        yield format_sse("log", {"line": "config.json уже существует — пропускаю"})

    # Step: venv
    yield format_sse("step", {"name": "venv", "label": "Создание виртуального окружения"})
    venv_cmd = [sys.executable, "-m", "venv", "--clear", str(paths.venv_dir)]
    async for frame in _stream_subprocess(venv_cmd):
        if frame.startswith("__RC__:"):
            rc = int(frame.split(":", 1)[1])
            if rc != 0:
                yield format_sse(
                    "error",
                    {"code": "PIP_FAILED", "message": f"venv завершился с кодом {rc}"},
                )
                return
        else:
            yield frame

    # Step: pip install
    yield format_sse("step", {"name": "pip", "label": "Установка зависимостей"})
    pip_bin = (
        paths.venv_dir
        / ("Scripts" if os.name == "nt" else "bin")
        / ("pip.exe" if os.name == "nt" else "pip")
    )

    # SberOSC recommends a pip.conf (not inline --index-url/--trusted-host, which
    # can break transitive dependency resolution). Write it into the venv and
    # point pip at it via PIP_CONFIG_FILE. The token never touches the log stream
    # — only the redacted index URL is emitted.
    pip_conf_text, redacted_index, _trusted_host = build_pip_conf(pip_index, pip_token)
    pip_conf_path = paths.venv_dir / "pip.conf"
    pip_conf_path.write_text(pip_conf_text, encoding="utf-8")
    yield format_sse("log", {"line": f"записан {pip_conf_path}"})
    yield format_sse("log", {"line": f"index-url={redacted_index}"})

    sub_env = os.environ.copy()
    sub_env["PIP_CONFIG_FILE"] = str(pip_conf_path)

    pip_cmd = [
        str(pip_bin),
        "install",
        "-r",
        str(_REQUIREMENTS),
    ]
    async for frame in _stream_subprocess(pip_cmd, token=pip_token, env=sub_env):
        if frame.startswith("__RC__:"):
            rc = int(frame.split(":", 1)[1])
            if rc != 0:
                yield format_sse(
                    "error",
                    {"code": "PIP_FAILED", "message": f"pip install завершился с кодом {rc}"},
                )
                return
        else:
            yield frame

    yield format_sse("done", {"ok": True, "code": 0})


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #


def export_zip(paths: AppPaths | None = None) -> Path:
    """Build an export zip in ``tmp/`` (config, certs, history, requirements).

    Never includes the venv. Returns the path to the created zip.
    """
    paths = paths or PATHS
    paths.ensure_dirs()
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    out = paths.tmp_dir / f"cognivault-ui-env-{stamp}.zip"

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        if paths.config_file.is_file():
            zf.write(paths.config_file, "config.json")
        if paths.certs_dir.is_dir():
            for f in sorted(paths.certs_dir.iterdir()):
                if f.is_file():
                    zf.write(f, f"certs/{f.name}")
        if paths.history_dir.is_dir():
            for f in sorted(paths.history_dir.glob("*.json")):
                zf.write(f, f"history/{f.name}")
        if _REQUIREMENTS.is_file():
            zf.write(_REQUIREMENTS, "requirements.txt")
    return out


def export_filename() -> str:
    return f"cognivault-ui-env-{datetime.now().strftime('%Y%m%d-%H%M')}.zip"


# --------------------------------------------------------------------------- #
# Import
# --------------------------------------------------------------------------- #


class ImportError_(Exception):
    """Raised on an invalid/unsafe import archive (validated before any mutation)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _validate_archive(zip_path: Path) -> list[str]:
    """Validate every entry against the whitelist; reject traversal/absolute.

    Returns the list of whitelisted entry names. Raises :class:`ImportError_`
    on the first violation — nothing is written.
    """
    if not zipfile.is_zipfile(zip_path):
        raise ImportError_("IMPORT_BAD_ZIP", "Файл не является корректным ZIP-архивом")

    names: list[str] = []
    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            if name.endswith("/"):
                continue  # directory entry — nothing to extract
            norm = name.replace("\\", "/")
            if norm.startswith("/") or ".." in norm.split("/"):
                raise ImportError_(
                    "IMPORT_BAD_ZIP", f"Небезопасный путь в архиве: {name}"
                )
            if not _IMPORT_WHITELIST.match(norm):
                raise ImportError_(
                    "IMPORT_BAD_ZIP", f"Недопустимая запись в архиве: {name}"
                )
            names.append(norm)
    return names


def import_zip(zip_path_str: str, paths: AppPaths | None = None) -> dict[str, Any]:
    """Safely replace the data dir from an export zip.

    Fully validates the archive first; only then backs up the current dir
    (excluding ``venv/``) and extracts the whitelisted entries into a fresh
    directory. Returns ``{"imported": [...], "backup": str}``.
    """
    paths = paths or PATHS
    zip_path = Path(os.path.expanduser(zip_path_str))
    if not zip_path.is_file():
        raise ImportError_("IMPORT_BAD_ZIP", f"Файл не найден: {zip_path}")

    names = _validate_archive(zip_path)  # raises before any mutation

    root = paths.root
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = root.parent / f".cognivault-ui.bak-{stamp}"

    # Preserve the venv across the swap (backups must not include it).
    venv_src = paths.venv_dir
    venv_tmp = root.parent / f".cognivault-ui.venv-keep-{stamp}"
    moved_venv = False
    if venv_src.is_dir():
        shutil.move(str(venv_src), str(venv_tmp))
        moved_venv = True

    # Move current dir (now sans venv) to backup, recreate a fresh root.
    if root.exists():
        shutil.move(str(root), str(backup))
    root.mkdir(parents=True, exist_ok=True)

    # Restore venv into the fresh root.
    if moved_venv:
        shutil.move(str(venv_tmp), str(paths.venv_dir))

    # Extract whitelisted entries.
    imported: list[str] = []
    with zipfile.ZipFile(zip_path) as zf:
        for name in names:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(name) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            imported.append(name)

    # Lock down any private key files.
    if paths.certs_dir.is_dir():
        for key_file in paths.certs_dir.glob("*.key"):
            try:
                os.chmod(key_file, 0o600)
            except OSError:
                pass

    return {"imported": imported, "backup": str(backup)}
