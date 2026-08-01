"""Разрез по origin: несколько golden-файлов, группировка метрик, шум на n своего набора.

Приёмочные 39 вопросов заказчика и сгенерированный набор живут в разных файлах и
меряются ВМЕСТЕ, но отчитываются РАЗДЕЛЬНО: приёмочное число не должно разбавляться
сгенерированным, а «квант шума» одного вопроса у каждого набора свой (1/его-n).
Тесты — на синтетических входах, где ответ посчитан руками.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from audit_retrieval import (
    Chunk,
    Corpus,
    SparseIndex,
    compute_delta,
    default_post_pipeline,
    evaluate,
    load_golden_files,
    parse_variant,
    rank_changes,
    summarize_ranks,
    to_queries,
)


# --- загрузка нескольких golden-файлов ---------------------------------------


def _write_jsonl(path: Path, rows: list[dict]) -> Path:
    path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )
    return path


def test_load_golden_files_concatenates_in_order(tmp_path) -> None:
    customer = _write_jsonl(tmp_path / "golden.jsonl", [{"id": "x01"}, {"id": "x02"}])
    generated = _write_jsonl(
        tmp_path / "golden.corpus.jsonl",
        [{"id": "g100", "origin": "generated"}],
    )
    rows = load_golden_files([customer, generated])
    assert [row["id"] for row in rows] == ["x01", "x02", "g100"]


def test_load_golden_files_rejects_duplicate_ids_across_files(tmp_path) -> None:
    """Повтор id между файлами — громкая ошибка: метрики по вопросу перестали бы
    быть однозначными."""
    first = _write_jsonl(tmp_path / "a.jsonl", [{"id": "x01"}])
    second = _write_jsonl(tmp_path / "b.jsonl", [{"id": "x01", "origin": "generated"}])
    with pytest.raises(SystemExit, match="x01"):
        load_golden_files([first, second])


def test_load_golden_files_keeps_harness_rules(tmp_path) -> None:
    """`accepted: false` выбрасывается тем же правилом, что в харнессе."""
    path = _write_jsonl(
        tmp_path / "g.jsonl", [{"id": "x01"}, {"id": "x02", "accepted": False}]
    )
    assert [row["id"] for row in load_golden_files([path])] == ["x01"]


def test_to_queries_defaults_missing_origin_to_customer() -> None:
    """Строки без поля `origin` — приёмочный набор заказчика: он написан до появления
    поля и не должен переехать в другую корзину."""
    queries = to_queries(
        [
            {"id": "x01", "question": "?", "source_path": "a.md"},
            {"id": "g100", "question": "?", "source_path": "b.md", "origin": "generated"},
        ]
    )
    assert queries[0].origin == "customer"
    assert queries[1].origin == "generated"


# --- группировка метрик по origin в evaluate ---------------------------------


def _tiny_corpus() -> Corpus:
    chunks = [
        Chunk("a.md", "a", 0, "", "", "text", 1, 1, "alpha"),
        Chunk("b.md", "b", 0, "", "", "text", 1, 1, "beta"),
    ]
    dense = np.array([[1.0, 0.0], [0.0, 1.0]])
    sparse = SparseIndex([{"indices": [], "values": []} for _ in chunks])
    return Corpus(chunks=chunks, dense=dense, sparse=sparse)


def _evaluate_two_origins() -> dict:
    corpus = _tiny_corpus()
    queries = to_queries(
        [
            # заказчик (без origin): правильный файл a.md, плотный запрос попадает в
            # него первым → file_rank 1
            {"id": "x01", "question": "alpha?", "source_path": "a.md"},
            # сгенерированный: правильный файл b.md, но запрос ближе к a.md →
            # file_rank 2
            {
                "id": "g100",
                "question": "beta?",
                "source_path": "b.md",
                "origin": "generated",
            },
            # по одной ловушке на каждый origin — для разреза refusal
            {"id": "x99", "question": "?", "expected_refusal": True},
            {
                "id": "g999",
                "question": "?",
                "expected_refusal": True,
                "origin": "generated",
            },
        ]
    )
    dense_queries = np.array(
        [[1.0, 0.0], [0.9, 0.1], [1.0, 0.0], [1.0, 0.0]]
    )
    sparse_queries = [{"indices": [], "values": []} for _ in queries]
    variant = parse_variant({"name": "prod"})
    return evaluate(
        corpus,
        queries,
        dense_queries,
        sparse_queries,
        variant,
        default_post_pipeline(True),
        cli_limit=10,
    )


def test_evaluate_reports_golden_counts_by_origin() -> None:
    result = _evaluate_two_origins()
    assert result["golden"]["by_origin"] == {
        "customer": {"rows": 2, "answerable": 1, "refusal_traps": 1},
        "generated": {"rows": 2, "answerable": 1, "refusal_traps": 1},
    }


def test_evaluate_splits_file_metrics_by_origin() -> None:
    """Аггрегат по всем строкам разбавил бы приёмочное число: hit@1 общего набора
    0.5, а у заказчика — 1.0. Разрез обязан держать их раздельно."""
    result = _evaluate_two_origins()
    dense = result["branches"]["dense"]
    assert dense["file"]["hit_at"]["1"] == 0.5
    assert dense["file_by_origin"]["customer"]["n"] == 1
    assert dense["file_by_origin"]["customer"]["hit_at"]["1"] == 1.0
    assert dense["file_by_origin"]["generated"]["hit_at"]["1"] == 0.0
    assert dense["file_by_origin"]["generated"]["hit_at"]["3"] == 1.0
    # вложенный разрез origin → категория существует и держит свои n
    assert dense["file_by_origin_category"]["customer"]["unclassified"]["n"] == 1


def test_evaluate_splits_refusal_scores_by_origin() -> None:
    result = _evaluate_two_origins()
    by_origin = result["refusal"]["dense"]["by_origin"]
    assert set(by_origin) == {"customer", "generated"}
    assert by_origin["customer"]["answerable"]["n"] == 1
    assert by_origin["customer"]["traps"]["n"] == 1


def test_per_query_records_carry_origin() -> None:
    result = _evaluate_two_origins()
    origins = {record["id"]: record["origin"] for record in result["per_query"]}
    assert origins == {
        "x01": "customer",
        "g100": "generated",
        "x99": "customer",
        "g999": "generated",
    }


# --- шум на n своего origin ---------------------------------------------------


def _origin_report(label: str, ranks: dict[str, tuple[str, int | None]]) -> dict:
    """Синтетический отчёт: id → (origin, file_rank). Аггрегаты — руками."""
    all_ranks = [rank for _, rank in ranks.values()]
    stats = summarize_ranks(all_ranks)
    by_origin: dict[str, list[int | None]] = {}
    for origin, rank in ranks.values():
        by_origin.setdefault(origin, []).append(rank)
    origin_stats = {origin: summarize_ranks(values) for origin, values in by_origin.items()}
    return {
        "model": {"name": "m"},
        "retrieval": {"limit": 40},
        "corpus": {"label": label, "chunks": 10, "source": "chunks.jsonl"},
        "golden": {
            "answerable": len(ranks),
            "section_labels": [],
            "section_labels_missing_in_corpus": [],
            "by_origin": {
                origin: {
                    "rows": len(values),
                    "answerable": len(values),
                    "refusal_traps": 0,
                }
                for origin, values in by_origin.items()
            },
        },
        "branches": {
            branch: {
                "file": stats,
                "file_by_category": {"t": stats},
                "file_by_origin": origin_stats,
                "section": stats,
            }
            for branch in ("dense", "bm25", "hybrid")
        },
        "per_query": [
            {
                "id": qid,
                "origin": origin,
                "branches": {
                    branch: {"file_rank": rank, "section_rank": None}
                    for branch in ("dense", "bm25", "hybrid")
                },
            }
            for qid, (origin, rank) in sorted(ranks.items())
        ],
    }


def test_rank_changes_are_counted_per_origin() -> None:
    new = _origin_report(
        "new", {"x01": ("customer", 2), "g100": ("generated", 1), "g101": ("generated", 3)}
    )
    old = _origin_report(
        "old", {"x01": ("customer", 1), "g100": ("generated", 1), "g101": ("generated", 1)}
    )
    changes = rank_changes(new, old)["hybrid"]
    assert changes["n_changed"] == 2
    assert changes["by_origin"] == {
        "customer": {"n_changed": 1, "improved": 0, "regressed": 1},
        "generated": {"n_changed": 1, "improved": 0, "regressed": 1},
    }


def test_noise_quantum_uses_per_origin_n_not_total() -> None:
    """28 отвечаемых заказчика = ±1/28 ≈ 0.036 на вопрос; у сгенерированных n больше
    и квант меньше. Квант от ОБЩЕГО n (1/178) занизил бы шум приёмочного числа."""
    customer = {f"x{i:02d}": ("customer", 1) for i in range(28)}
    generated = {f"g{i:03d}": ("generated", 1) for i in range(150)}
    new_ranks = dict(customer, **generated)
    old_ranks = dict(new_ranks)
    new_ranks["x00"] = ("customer", 2)  # один вопрос заказчика сменил ранг
    delta = compute_delta(
        _origin_report("new", new_ranks), _origin_report("old", old_ranks)
    )
    noise = delta["noise"]
    assert noise["by_origin"]["customer"]["answerable_n"] == 28
    assert noise["by_origin"]["customer"]["one_question"] == pytest.approx(1 / 28, abs=1e-4)
    assert noise["by_origin"]["generated"]["answerable_n"] == 150
    assert noise["by_origin"]["generated"]["one_question"] == pytest.approx(1 / 150, abs=1e-4)
    # вердикты — на счётчике СВОЕГО origin: у заказчика один сменивший, у
    # сгенерированных выдача идентична
    assert "шума одного вопроса" in noise["by_origin"]["customer"]["verdicts"]["hybrid"]
    assert "не изменилась" in noise["by_origin"]["generated"]["verdicts"]["hybrid"]
    # сводный вердикт не смешивает наборы: оба упомянуты со своими n
    assert "customer (n=28" in noise["verdicts"]["hybrid"]
    assert "generated (n=150" in noise["verdicts"]["hybrid"]


def test_noise_single_origin_keeps_plain_verdict() -> None:
    """Один origin (старые отчёты, чистый заказчик) — вердикт без префиксов, как был."""
    new = _origin_report("new", {"x01": ("customer", 1), "x02": ("customer", 1)})
    old = _origin_report("old", {"x01": ("customer", 1), "x02": ("customer", 2)})
    delta = compute_delta(new, old)
    assert delta["noise"]["verdicts"]["hybrid"] == (
        "сменил ранг 1 вопрос — дельта в пределах шума одного вопроса"
    )


def test_delta_reports_file_metrics_per_origin() -> None:
    new = _origin_report("new", {"x01": ("customer", 2), "g100": ("generated", 1)})
    old = _origin_report("old", {"x01": ("customer", 1), "g100": ("generated", 1)})
    delta = compute_delta(new, old)
    by_origin = delta["branches"]["hybrid"]["file_by_origin"]
    assert by_origin["customer"]["hit_at"]["1"] == pytest.approx(-1.0)
    assert by_origin["generated"]["hit_at"]["1"] == pytest.approx(0.0)


def test_delta_survives_baseline_without_origin_fields() -> None:
    """Старый отчёт (до разреза по origin) остаётся годным базовым: разрез просто
    пуст, падения нет."""
    old = _origin_report("old", {"x01": ("customer", 1)})
    del old["golden"]["by_origin"]
    for branch in old["branches"].values():
        del branch["file_by_origin"]
    for record in old["per_query"]:
        del record["origin"]
    new = _origin_report("new", {"x01": ("customer", 2)})
    delta = compute_delta(new, old)
    assert delta["branches"]["hybrid"]["file_by_origin"] == {}
    assert delta["rank_changes"]["hybrid"]["n_changed"] == 1
