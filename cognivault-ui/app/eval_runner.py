"""Прогон харнесса оценки прямо из UI — без консоли и без kubectl.

Зачем: харнесс обязан выполняться ВНУТРИ пода (снаружи закрытого контура нет ни
UI, ни mTLS-эндпоинта судьи), а прав на `kubectl exec`/`cp` у того, кто читает
отчёты, может не быть вовсе. Кнопка снимает это ограничение целиком.

Форма повторяет уже существующий фон-процесс переиндексации: старт возвращает
сразу, статус опрашивается, лог копится в памяти и отдаётся в окно. Второй
непохожий механизм для той же задачи только запутал бы.

Прогон дорогой — 47 пар × ~4 судейских вызова ≈ 190 обращений к GigaChat, — и
идёт от имени вызывающего пользователя: его токен, его настройки. Иначе A/B двух
конфигураций был бы бессмысленным, потому что ручки грейдера хранятся
пер-пользовательски.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import io
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Каталог харнесса внутри образа (см. Dockerfile: `COPY tools/eval/ eval/`).
# В dev-запуске из репозитория он лежит на два уровня выше.
_CANDIDATES = (
    Path(__file__).resolve().parents[1] / "eval",
    Path(__file__).resolve().parents[2] / "tools" / "eval",
)

# Метка + расширение — единственное, что попадает в имя файла отчёта.
# Всё остальное отвергаем, чтобы метка не превратилась в обход каталога.
_LABEL_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def harness_dir() -> Path | None:
    for path in _CANDIDATES:
        if (path / "run.py").is_file():
            return path
    return None


def available() -> bool:
    return harness_dir() is not None


def valid_label(label: str) -> bool:
    return bool(_LABEL_RE.match(label or ""))


@dataclass
class EvalJob:
    """Состояние одного прогона. Живёт в памяти процесса."""

    label: str
    status: str = "running"  # running | completed | failed
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    lines: list[str] = field(default_factory=list)
    error: str | None = None
    out_dir: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            # Хвост: лог прогона — сотни строк, а окно показывает последние.
            "log": self.lines[-200:],
            "error": self.error,
            "elapsed_sec": int((self.finished_at or time.time()) - self.started_at),
        }


class _LineSink(io.TextIOBase):
    """Приёмник stderr харнесса: копит целые строки в списке задачи.

    Харнесс печатает прогресс в stderr (`run._log`), другого канала прогресса у
    него нет. Перехват здесь дешевле, чем прикручивать к нему колбэки, и не
    расходится с тем, что видно при запуске из консоли.
    """

    def __init__(self, job: EvalJob) -> None:
        self._job = job
        self._buf = ""

    def write(self, s: str) -> int:  # noqa: D102 — интерфейс TextIOBase
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            if line.strip():
                self._job.lines.append(line.rstrip())
        return len(s)

    def flush(self) -> None:  # noqa: D102
        if self._buf.strip():
            self._job.lines.append(self._buf.rstrip())
            self._buf = ""


class EvalRunner:
    """Один прогон на процесс — больше не нужно и вредно.

    Два параллельных прогона дрались бы за один и тот же лимит GigaChat и за один
    файл отчёта, а сравнивать их всё равно нельзя: настройки между ними не
    менялись.
    """

    def __init__(self) -> None:
        self._job: EvalJob | None = None
        self._task: asyncio.Task[None] | None = None

    @property
    def job(self) -> EvalJob | None:
        return self._job

    def busy(self) -> bool:
        return self._job is not None and self._job.status == "running"

    def start(self, *, label: str, argv: list[str], out_dir: Path) -> EvalJob:
        if self.busy():
            raise RuntimeError("прогон уже идёт")
        out_dir.mkdir(parents=True, exist_ok=True)
        job = EvalJob(label=label, out_dir=str(out_dir))
        self._job = job
        self._task = asyncio.create_task(self._run(job, argv))
        return job

    async def _run(self, job: EvalJob, argv: list[str]) -> None:
        try:
            run_mod = _load_harness()
            sink = _LineSink(job)
            # `main_async` пишет только в stderr; stdout перехватываем на всякий
            # случай, чтобы случайный print не улетел в лог пода вперемешку.
            with contextlib.redirect_stderr(sink), contextlib.redirect_stdout(sink):
                code = await run_mod.main_async(argv)
            sink.flush()
            if code == 0:
                job.status = "completed"
            else:
                job.status = "failed"
                job.error = f"харнесс вернул код {code}"
        except asyncio.CancelledError:
            job.status = "failed"
            job.error = "прогон отменён"
            raise
        except Exception as exc:  # noqa: BLE001 — фон не должен ронять процесс
            job.status = "failed"
            job.error = f"{type(exc).__name__}: {exc}"
        finally:
            job.finished_at = time.time()


def _load_harness() -> Any:
    """Импортировать `run.py` харнесса.

    Каталог кладётся в `sys.path`, потому что харнесс импортирует соседей по
    голому имени (`import metrics`, `from gigachat_client import …`) — так он
    устроен и так же запускается из консоли. Модуль регистрируется под
    неконфликтным именем: `run` — слишком общее, чтобы занимать его глобально.
    """
    directory = harness_dir()
    if directory is None:
        raise RuntimeError("харнесс оценки не найден в образе")
    path = str(directory)
    if path not in sys.path:
        sys.path.insert(0, path)
    name = "cognivault_eval_run"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, directory / "run.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("не удалось загрузить run.py харнесса")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


RUNNER = EvalRunner()
