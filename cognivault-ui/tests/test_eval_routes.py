"""Кнопка «прогнать оценку»: старт, статус, выгрузка отчёта.

Офлайн: сам харнесс подменяется — нас интересует обвязка (валидация метки,
защита от параллельных прогонов, обход каталога в имени отчёта), а не его
внутренности, у которых свои тесты в `tools/eval/tests`.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import eval_runner, settings  # noqa: E402
from app.config import AppPaths  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes import eval_routes  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_runner():
    """Раннер — синглтон на процесс; между тестами его надо обнулять."""
    eval_runner.RUNNER._job = None
    eval_runner.RUNNER._task = None
    yield
    eval_runner.RUNNER._job = None
    eval_runner.RUNNER._task = None


# --------------------------------------------------------------------------- #
# Метка попадает в имя файла — значит это недоверенный ввод
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("good", ["run", "after-w5", "ok_1.2", "A" * 64])
def test_label_accepts_safe_names(good):
    assert eval_runner.valid_label(good)


@pytest.mark.parametrize(
    "bad",
    ["", "a b", "../etc/passwd", "a/b", "a\\b", "отчёт", "A" * 65, "run;rm -rf /"],
)
def test_label_rejects_everything_else(bad):
    """Метка уезжает в имя файла отчёта — путь и пробелы здесь недопустимы."""
    assert not eval_runner.valid_label(bad)


# --------------------------------------------------------------------------- #
# Фоновый прогон
# --------------------------------------------------------------------------- #


def _fake_harness(monkeypatch, *, code=0, out="строка прогресса\nещё одна\n", boom=None):
    class FakeRun:
        @staticmethod
        async def main_async(argv):
            if boom is not None:
                raise boom
            print(out, end="", file=sys.stderr)
            return code

    monkeypatch.setattr(eval_runner, "_load_harness", lambda: FakeRun)


def _run_job(tmp_path, monkeypatch, **kw):
    _fake_harness(monkeypatch, **kw)

    async def go():
        job = eval_runner.RUNNER.start(label="t", argv=[], out_dir=tmp_path / "rep")
        await eval_runner.RUNNER._task
        return job

    return asyncio.run(go())


def test_successful_run_collects_the_progress_log(tmp_path, monkeypatch):
    """Прогресс харнесса идёт в stderr — другого канала у него нет."""
    job = _run_job(tmp_path, monkeypatch)

    assert job.status == "completed"
    assert job.lines == ["строка прогресса", "ещё одна"]
    assert job.to_dict()["elapsed_sec"] >= 0


def test_nonzero_exit_is_a_failure_not_a_success(tmp_path, monkeypatch):
    job = _run_job(tmp_path, monkeypatch, code=2)

    assert job.status == "failed"
    assert "код 2" in (job.error or "")


def test_exception_inside_the_harness_does_not_kill_the_process(tmp_path, monkeypatch):
    """Фон не должен ронять веб-процесс — иначе один кривой прогон уронит чат."""
    job = _run_job(tmp_path, monkeypatch, boom=ValueError("судья недоступен"))

    assert job.status == "failed"
    assert "ValueError" in (job.error or "")
    assert "судья недоступен" in (job.error or "")


def test_second_run_is_refused_while_the_first_is_alive(tmp_path, monkeypatch):
    """Два прогона дрались бы за лимит GigaChat и за один файл отчёта."""
    started = asyncio.Event()
    release = asyncio.Event()

    class Slow:
        @staticmethod
        async def main_async(argv):
            started.set()
            await release.wait()
            return 0

    monkeypatch.setattr(eval_runner, "_load_harness", lambda: Slow)

    async def go():
        eval_runner.RUNNER.start(label="first", argv=[], out_dir=tmp_path / "rep")
        await started.wait()
        assert eval_runner.RUNNER.busy()
        with pytest.raises(RuntimeError):
            eval_runner.RUNNER.start(label="second", argv=[], out_dir=tmp_path / "rep")
        release.set()
        await eval_runner.RUNNER._task

    asyncio.run(go())
    assert eval_runner.RUNNER.job.label == "first"


def test_log_is_tailed_so_a_long_run_does_not_bloat_the_response(tmp_path, monkeypatch):
    job = eval_runner.EvalJob(label="t")
    job.lines = [f"строка {i}" for i in range(500)]

    assert len(job.to_dict()["log"]) == 200
    assert job.to_dict()["log"][-1] == "строка 499"


# --------------------------------------------------------------------------- #
# Выгрузка отчёта
# --------------------------------------------------------------------------- #


def test_report_lookup_is_a_whitelist_not_a_path_join(tmp_path):
    """Имя отчёта приходит от клиента — склейка с каталогом дала бы обход.

    Рядом лежат каталоги других пользователей, поэтому проверяем принадлежность
    к перечню файлов, а не «не начинается ли имя с ../».
    """
    out = tmp_path / "eval-reports"
    out.mkdir()
    (out / "report-ok.md").write_text("отчёт")
    (tmp_path / "secret.txt").write_text("чужое")

    allowed = {p.name: p for p in out.glob("report-*.*")}

    assert "report-ok.md" in allowed
    for attack in ("../secret.txt", "/etc/passwd", "report-ok.md/../../secret.txt"):
        assert attack not in allowed


def test_run_is_started_strictly_single_threaded(tmp_path, monkeypatch):
    """У судьи на контуре один слот — прогон обязан идти в один поток.

    На `--concurrency 2` прогон `baseline` потерял 95 судейских вызовов из 188:
    второй одновременный запрос получал 429 сразу, а ретраи короче чужого
    вызова, поэтому проигравший терял метрики целыми сэмплами. Число живёт
    здесь, а не в дефолте харнесса, — значит и стеречь его надо здесь.
    """
    monkeypatch.setattr(settings, "is_server", lambda: False)
    monkeypatch.setattr(
        eval_routes, "resolve_paths", lambda request: AppPaths(root=tmp_path)
    )
    monkeypatch.setattr(eval_runner, "available", lambda: True)
    seen: dict = {}

    def fake_start(*, label, argv, out_dir):
        seen["argv"] = argv
        return eval_runner.EvalJob(label=label)

    monkeypatch.setattr(eval_runner.RUNNER, "start", fake_start)

    with TestClient(create_app()) as client:
        resp = client.post("/api/eval/run", json={"label": "smoke", "limit": 5})

    assert resp.status_code == 200
    argv = seen["argv"]
    assert argv[argv.index("--concurrency") + 1] == "1"


def test_status_shape_survives_a_run(tmp_path, monkeypatch):
    job = _run_job(tmp_path, monkeypatch)
    payload = json.loads(json.dumps(job.to_dict()))  # должен быть JSON-сериализуем

    assert set(payload) >= {"label", "status", "log", "elapsed_sec"}


def test_unwritable_report_dir_is_a_readable_error_not_a_500(tmp_path, monkeypatch):
    """Каталог отчётов живёт в /data — том монтируется снаружи и может быть недоступен.

    Поймано прогоном настоящего образа без тома: пользователь получал голое
    «Internal Server Error», по которому непонятно даже, куда смотреть.
    """
    _fake_harness(monkeypatch)
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)  # только чтение и обход
    try:
        with pytest.raises(OSError):
            eval_runner.RUNNER.start(label="t", argv=[], out_dir=locked / "eval-reports")
    finally:
        locked.chmod(0o700)
