#!/usr/bin/env python3
"""Сводный прогон RAG-аудита: один дамп на входе — одно табло на выходе.

Четыре стыка меряются четырьмя разными инструментами, и это правильно: у каждого
свой предмет и свой набор проверок. Но пока их запускают руками четырьмя
командами в четыре временных каталога, «стало ли лучше после правки» — это чтение
четырёх JSON рядом, и ответ на него приходит через полчаса, а не через минуту.
Эта команда не заменяет и не форкает стыки: она их ЗОВЁТ (обычными подпроцессами,
теми же ключами, что в README), собирает провенанс прогона и печатает ОДНО табло
с вердиктом по каждой заголовочной метрике и с ответом «лучше или хуже, чем в
прошлый раз».

    python3 tools/rag_audit/audit_all.py --dump ~/Downloads/confluence-dump.zip

Что делает эту сводку не украшением, а инструментом:

* **Отказ сравнивать.** Прогон записывает sha256 дампа и каждого золотого файла,
  коммит, модель и конфигурацию поиска. Если что-то из этого разъехалось с
  базовым прогоном, дельта не печатается «примерно» — она не печатается вовсе, с
  причиной. День работы уже дал несколько случаев, когда метрика двигалась из-за
  правки РАЗМЕТКИ; ни один такой случай не должен читаться как качество.
* **Шум по origin.** Приёмочный набор заказчика — 28 отвечаемых вопросов, один
  сменивший ранг двигает hit@* на ±0.036; сгенерированный — 160, там квант
  ±0.006. Дельта меньше кванта СВОЕГО набора — шум, и так и написано.
* **Сколько вопросов сменили ранг.** Для стыков 3–4 печатается не только
  аггрегат, но и счёт вопросов, сменивших ранг (сторону порога), в каждую
  сторону: «+0.036» — это и «один дрогнул», и «пять вверх, четыре вниз».
* **Ненулевой код выхода**, когда заголовочная метрика ушла ниже порога или
  регрессировала сверх шума, — команда готова к CI как есть.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))

import scorecard as sc  # noqa: E402

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parents[1]
DEFAULT_GOLDEN = (
    REPO_ROOT / "tools" / "eval" / "golden.jsonl",
    REPO_ROOT / "tools" / "eval" / "golden.corpus.jsonl",
)
DEFAULT_BASELINE = TOOLS_DIR / "baseline.json"
DEFAULT_THRESHOLDS = TOOLS_DIR / "thresholds.json"
DEFAULT_WORK_ROOT = REPO_ROOT / ".rag-audit"

#: Инструменты, из которых состоит замер. Их отпечатки едут в провенанс: если
#: сдвинулась сама линейка, «улучшение» может оказаться другим способом мерить,
#: и об этом надо сказать вслух — но НЕ отказываться сравнивать, иначе любая
#: правка аудита обнуляла бы историю.
RULERS = (
    "audit_convert.py",
    "audit_chunk.ts",
    "audit_retrieval.py",
    "audit_window.py",
    "section_windows.ts",
    "sparse_vectors.ts",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _git(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def _count_lines(path: Path) -> int:
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


# --------------------------------------------------------------------------- #
# Запуск стыков
# --------------------------------------------------------------------------- #


class StageFailed(RuntimeError):
    pass


def run_stage(name: str, command: Sequence[str], log_dir: Path, quiet: bool) -> float:
    """Зовёт инструмент стыка подпроцессом и возвращает его время.

    Вывод стыка целиком уезжает в лог прогона, а не в табло: сводка обязана
    оставаться сводкой. Ненулевой код — громкая остановка с хвостом лога;
    молча продолжать значило бы напечатать табло по неполным данным.
    """
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{name}.log"
    started = time.monotonic()
    if not quiet:
        sys.stderr.write(f"[{name}] {' '.join(str(c) for c in command)}\n")
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.run(
            list(command), cwd=REPO_ROOT, stdout=log, stderr=subprocess.STDOUT, text=True
        )
    elapsed = time.monotonic() - started
    if process.returncode != 0:
        tail = log_path.read_text(encoding="utf-8").splitlines()[-25:]
        raise StageFailed(
            f"стык {name} упал (код {process.returncode}); лог {log_path}\n" + "\n".join(tail)
        )
    if not quiet:
        sys.stderr.write(f"[{name}] готово за {elapsed:.1f}s\n")
    return round(elapsed, 2)


def run_pipeline(args: argparse.Namespace, run_dir: Path) -> dict[str, float]:
    """Все четыре стыка по очереди — теми же ключами, что в README."""
    log_dir = run_dir / "logs"
    vault = run_dir / "vault"
    chunks = run_dir / "chunks.jsonl"
    sections = run_dir / "sections.jsonl"
    golden_args: list[str] = []
    for path in args.golden:
        golden_args += ["--golden", str(path)]

    timing: dict[str, float] = {}
    timing["convert"] = run_stage(
        "convert",
        [
            sys.executable,
            str(TOOLS_DIR / "audit_convert.py"),
            "--dump",
            str(args.dump),
            "--out-dir",
            str(run_dir),
        ],
        log_dir,
        args.quiet,
    )
    timing["chunk"] = run_stage(
        "chunk",
        [
            args.npx,
            "tsx",
            str(TOOLS_DIR / "audit_chunk.ts"),
            "--vault",
            str(vault),
            "--out",
            str(run_dir / "chunk-report.json"),
            "--chunks",
            str(chunks),
        ],
        log_dir,
        args.quiet,
    )
    timing["sections"] = run_stage(
        "sections",
        [args.npx, "tsx", str(TOOLS_DIR / "section_windows.ts"), "sections", str(vault), str(sections)],
        log_dir,
        args.quiet,
    )
    retrieval_cmd = [
        sys.executable,
        str(TOOLS_DIR / "audit_retrieval.py"),
        "--chunks",
        str(chunks),
        *golden_args,
        "--out",
        str(run_dir / "retrieval-report.json"),
        "--cache",
        str(args.cache),
        "--limit",
        str(args.limit),
        "--label",
        args.label,
        "--model",
        args.model,
    ]
    if args.device:
        retrieval_cmd += ["--device", args.device]
    timing["retrieval"] = run_stage("retrieval", retrieval_cmd, log_dir, args.quiet)

    window_cmd = [
        sys.executable,
        str(TOOLS_DIR / "audit_window.py"),
        "--chunks",
        str(chunks),
        "--sections",
        str(sections),
        *golden_args,
        "--out",
        str(run_dir / "window-report.json"),
        "--cache",
        str(args.cache),
        "--limit",
        str(args.limit),
        "--label",
        args.label,
        "--model",
        args.model,
    ]
    if args.device:
        window_cmd += ["--device", args.device]
    timing["window"] = run_stage("window", window_cmd, log_dir, args.quiet)
    timing["total_s"] = round(sum(timing.values()), 2)
    return timing


# --------------------------------------------------------------------------- #
# Провенанс и выжимка per-query
# --------------------------------------------------------------------------- #


def build_provenance(args: argparse.Namespace, reports: Mapping[str, Any]) -> dict[str, Any]:
    retrieval = reports["retrieval"]
    window = reports["window"]
    dirty_files = sorted(
        line[3:] for line in _git("status", "--porcelain", "--untracked-files=no").splitlines()
    )
    return {
        "commit": _git("rev-parse", "--short", "HEAD") or "?",
        # Только ОТСЛЕЖИВАЕМЫЕ правки: незакоммиченный черновик рядом не меняет
        # ни один из четырёх стыков, а вечное «дерево грязное» перестают читать.
        # Список файлов едет вместе с флагом: «прогон не привязан к коммиту» без
        # ответа на вопрос «а что было не так» — предупреждение, которое нечем
        # проверить.
        "dirty": bool(dirty_files),
        "dirty_files": dirty_files,
        "dump": {
            # Путь машинно-специфичен и в сравнении не участвует — в записи
            # прогона, которая коммитится, от дампа нужны имя и отпечаток.
            "name": Path(args.dump).name,
            "sha256": sha256_file(Path(args.dump)),
            "pages": int(reports["convert"]["corpus"]["pages"]),
        },
        "golden": [
            {
                "name": path.name,
                "path": str(path.relative_to(REPO_ROOT)) if path.is_relative_to(REPO_ROOT) else str(path),
                "sha256": sha256_file(path),
                "rows": _count_lines(path),
            }
            for path in args.golden
        ],
        "model": retrieval["model"]["name"],
        # Ровно поверхность вариантов: глубины, слияние, трансформы, пост-обработка.
        # Другая ручка — другой замер, и дельта стыка 3 к прогону с другой ручкой
        # описывала бы ручку, а не корпус.
        "retrieval_config": {
            key: retrieval["retrieval"][key]
            for key in (
                "limit",
                "fetch_limit",
                "candidate_limit",
                "fusion",
                "query_transform",
                "doc_text",
                "post",
                "group_by_section",
            )
            if key in retrieval["retrieval"]
        },
        "window_config": {
            "prod_cap": window["corpus"]["prod_cap"],
            "threshold": window["measure"]["threshold"],
            "locus_coverage": window["measure"]["locus_coverage"],
            "min_attainable_terms": window["measure"]["min_attainable_terms"],
        },
        "rulers": {name: sha256_file(TOOLS_DIR / name) for name in RULERS},
    }


def extract_per_query(reports: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Ровно то, из чего считается «сколько вопросов сменили ранг».

    Полные `per_query` стыков — сотни килобайт; базовый прогон коммитится, и в
    него едет только ключ, origin и ранг (сторона порога). Аггрегата для этого
    счёта не хватает по построению: он усредняет именно то, что надо считать
    поштучно.
    """
    retrieval = [
        {
            "id": record["id"],
            "origin": record.get("origin", "customer"),
            "rank": record.get("branches", {}).get("hybrid", {}).get("file_rank"),
        }
        for record in reports["retrieval"].get("per_query", [])
    ]
    threshold = float(reports["window"]["measure"]["threshold"])
    window = []
    for record in reports["window"].get("per_query", []):
        containment = record.get("containment_prod")
        window.append(
            {
                "id": record["id"],
                "origin": record.get("origin", "customer"),
                "judgeable": bool(record.get("judgeable", True)),
                "containment": containment,
                "contained": containment is not None and float(containment) >= threshold,
            }
        )
    return {"retrieval": retrieval, "window": window}


def to_record(
    card: sc.Scorecard, per_query: Mapping[str, Any], label: str
) -> dict[str, Any]:
    """Машиночитаемая запись прогона — она же формат базового прогона."""
    return {
        "tool": "cognivault-rag-audit/audit_all",
        "format_version": 1,
        "created_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "label": label,
        "provenance": card.provenance,
        "headline": {
            key: {"value": measurement.value, "n": measurement.n}
            for key, measurement in card.measurements.items()
        },
        "tripwires": card.tripwire_values,
        "context": card.context_values,
        "thresholds": card.thresholds,
        "comparison": card.comparison,
        "baseline": card.baseline_meta,
        "changes": card.changes,
        "failures": card.failures,
        "refusals": card.refusals,
        "warnings": card.warnings,
        "timing": card.timing,
        "exit_code": card.exit_code,
        "per_query": dict(per_query),
    }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Сводный прогон всех четырёх стыков RAG-аудита с одним табло и "
            "сравнением с базовым прогоном. НЕ прод-замер: плотная сторона — "
            "multilingual-e5-base, прод-замер живёт в tools/eval/."
        )
    )
    parser.add_argument("--dump", type=Path, required=True, help="zip от confluence_dump.py")
    parser.add_argument(
        "--run-dir",
        type=Path,
        default=None,
        help="каталог прогона (по умолчанию .rag-audit/runs/<UTC>-<коммит>)",
    )
    parser.add_argument(
        "--golden",
        action="append",
        type=Path,
        default=None,
        metavar="FILE.jsonl",
        help="золотой набор; повторяемый. По умолчанию golden.jsonl + golden.corpus.jsonl",
    )
    parser.add_argument(
        "--baseline",
        type=Path,
        default=DEFAULT_BASELINE,
        help="запись базового прогона для сравнения (по умолчанию tools/rag_audit/baseline.json)",
    )
    parser.add_argument(
        "--no-baseline", action="store_true", help="не сравнивать ни с чем — только пороги"
    )
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="перезаписать базовый прогон результатом этого (коммитить осознанно)",
    )
    parser.add_argument(
        "--thresholds", type=Path, default=DEFAULT_THRESHOLDS, help="файл порогов"
    )
    parser.add_argument(
        "--cache",
        type=Path,
        default=DEFAULT_WORK_ROOT / "embeddings.npz",
        help="кэш эмбеддингов, ОБЩИЙ для стыков 3 и 4 (тёплый кэш — минус ~60s)",
    )
    parser.add_argument("--model", default="intfloat/multilingual-e5-base", help="модель HF")
    parser.add_argument("--device", default=None, help="mps/cpu/cuda (по умолчанию — авто)")
    parser.add_argument("--limit", type=int, default=40, help="внешний лимит поиска (прод: 40)")
    parser.add_argument("--label", default=None, help="имя прогона (по умолчанию — коммит)")
    parser.add_argument(
        "--explain", action="store_true", help="печатать обоснование каждой метрики"
    )
    parser.add_argument("--quiet", action="store_true", help="не печатать ход стыков в stderr")
    parser.add_argument(
        "--no-gate",
        action="store_true",
        help="печатать табло, но всегда выходить с нулём (для разведочных прогонов)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.dump.exists():
        raise SystemExit(f"дампа нет: {args.dump}")
    args.golden = [Path(p) for p in (args.golden or DEFAULT_GOLDEN)]
    for path in args.golden:
        if not path.exists():
            raise SystemExit(f"золотого набора нет: {path}")
    if not args.thresholds.exists():
        raise SystemExit(f"файла порогов нет: {args.thresholds}")
    args.npx = os.environ.get("NPX", "npx")

    commit = _git("rev-parse", "--short", "HEAD") or "nogit"
    args.label = args.label or commit
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = args.run_dir or (DEFAULT_WORK_ROOT / "runs" / f"{stamp}-{commit}")
    run_dir.mkdir(parents=True, exist_ok=True)
    args.cache.parent.mkdir(parents=True, exist_ok=True)

    try:
        timing = run_pipeline(args, run_dir)
    except StageFailed as error:
        sys.stderr.write(f"\n{error}\n")
        return 3

    reports = {
        "convert": json.loads((run_dir / "convert-report.json").read_text(encoding="utf-8")),
        "chunk": json.loads((run_dir / "chunk-report.json").read_text(encoding="utf-8")),
        "retrieval": json.loads((run_dir / "retrieval-report.json").read_text(encoding="utf-8")),
        "window": json.loads((run_dir / "window-report.json").read_text(encoding="utf-8")),
    }

    thresholds = json.loads(args.thresholds.read_text(encoding="utf-8"))
    baseline = None
    if not args.no_baseline and args.baseline.exists():
        baseline = json.loads(args.baseline.read_text(encoding="utf-8"))

    provenance = build_provenance(args, reports)
    per_query = extract_per_query(reports)
    card = sc.build(provenance, reports, thresholds, baseline, per_query, timing)

    text = sc.render(card, explain=args.explain)
    sys.stdout.write(text)
    (run_dir / "scorecard.txt").write_text(text, encoding="utf-8")
    record = to_record(card, per_query, args.label)
    (run_dir / "run.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    latest = DEFAULT_WORK_ROOT / "latest"
    try:
        if latest.is_symlink() or latest.exists():
            latest.unlink()
        latest.symlink_to(run_dir, target_is_directory=True)
    except OSError:
        pass

    if args.update_baseline:
        if card.failures:
            sys.stderr.write(
                "ВНИМАНИЕ: базовый прогон перезаписывается прогоном, провалившим гейт — "
                "убедитесь, что это осознанная переразметка, а не фиксация регрессии\n"
            )
        args.baseline.write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        sys.stderr.write(f"базовый прогон записан: {args.baseline}\n")

    sys.stderr.write(f"прогон: {run_dir}\n")
    return 0 if args.no_gate else card.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
