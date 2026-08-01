"""Тесты измерительных функций `audit_retrieval`.

Проверяется ЛИНЕЙКА, а не поиск: слияние, попадания, MRR, разрез по категориям и
разделение популяций считаются на крошечных входах, где ответ посчитан руками. Иначе
«стало лучше» нечем отличить от «поехала метрика» — а отчёт стыка 3 существует ровно
затем, чтобы отвечать на этот вопрос.

Константы (RRF k, формула IDF, глубины веток) сверяются с их источниками —
`qdrant v1.16.3` и `src/features/search/service.ts` — теми же числами, что записаны в
модуле: тест ловит молчаливую правку константы, из-за которой отчёт стал бы описывать
не тот поиск, что крутится в проде.
"""

from __future__ import annotations

import json
import math

import pytest

from audit_retrieval import (
    Chunk,
    SparseIndex,
    best_threshold,
    branch_limits,
    compute_delta,
    dedupe_chunks,
    dedupe_sections,
    distribution,
    fancy_idf,
    first_relevant_rank,
    group_by_category,
    hit_at_k,
    load_chunks,
    mean_reciprocal_rank,
    post_filter,
    rrf_fuse,
    section_stats_on,
    summarize_ranks,
    top_indices,
    to_queries,
)

import numpy as np


# --- слияние ----------------------------------------------------------------


def test_rrf_matches_qdrant_formula() -> None:
    """`1 / (позиция + 2)`, позиция С НУЛЯ — как `position_score` в qdrant 1.16.

    Числа посчитаны руками: документ 0 стоит первым в одной ветке (0.5) и вторым в
    другой (1/3); документ 2 — третьим (0.25) и первым (0.5).
    """
    fused = rrf_fuse([[0, 1, 2], [2, 0, 3]])
    assert [doc for doc, _ in fused] == [0, 2, 1, 3]
    scores = dict(fused)
    assert scores[0] == pytest.approx(0.5 + 1 / 3)
    assert scores[2] == pytest.approx(0.25 + 0.5)
    assert scores[1] == pytest.approx(1 / 3)
    assert scores[3] == pytest.approx(0.25)


def test_rrf_single_branch_is_just_the_branch() -> None:
    """Пустой разреженный запрос оставляет одну ветку — порядок обязан уцелеть."""
    assert [doc for doc, _ in rrf_fuse([[7, 5, 3]])] == [7, 5, 3]


def test_rrf_breaks_ties_by_document_index() -> None:
    """Ничьи у Qdrant не определены; здесь они зафиксированы ради детерминизма."""
    assert [doc for doc, _ in rrf_fuse([[4], [1]])] == [1, 4]


# --- глубины веток ----------------------------------------------------------


def test_branch_limits_mirror_service_ts() -> None:
    """Прод-лимит 40: fetch = 40×2, глубина ветки = 80×2."""
    assert branch_limits(40) == (80, 160)


def test_branch_limits_apply_the_floor() -> None:
    """При маленьком лимите глубину держит `FUSION_CANDIDATE_FLOOR` = 40, не 2×fetch."""
    assert branch_limits(5) == (10, 40)


def test_branch_limits_apply_the_cap() -> None:
    """`POST_FILTER_OVERFETCH_CAP` = 200 ограничивает внешний перебор."""
    assert branch_limits(150) == (200, 400)


# --- отбор кандидатов -------------------------------------------------------


def test_top_indices_orders_by_score_then_index() -> None:
    scores = np.array([0.5, 1.0, 1.0, 0.1])
    assert top_indices(scores, 3) == [1, 2, 0]


def test_top_indices_can_drop_zero_scores() -> None:
    """Лексическая ветка не должна отдавать документы, не разделившие с запросом ни терма."""
    scores = np.array([2.0, 0.0, 1.0, 0.0])
    assert top_indices(scores, 4, positive_only=True) == [0, 2]


# --- лексический счёт -------------------------------------------------------


def test_fancy_idf_matches_qdrant() -> None:
    """`ln((n − df + 0.5) / (df + 0.5) + 1)`; при n=10, df=2 это ln(4.4)."""
    assert fancy_idf(10, 2) == pytest.approx(math.log(4.4))


def test_sparse_index_scores_are_idf_weighted_dot_products() -> None:
    """Счёт = скалярное произведение; IDF домножает вес ЗАПРОСА, как в Qdrant.

    Три документа, df: терм 1 — в двух, терм 3 — в одном. Значения посчитаны руками.
    """
    index = SparseIndex(
        [
            {"indices": [1, 2], "values": [1.0, 2.0]},
            {"indices": [2, 3], "values": [3.0, 1.0]},
            {"indices": [1], "values": [4.0]},
        ]
    )
    assert index.df == {1: 2, 2: 2, 3: 1}
    scores = index.scores({"indices": [1, 3], "values": [1.0, 1.0]})
    idf1 = math.log(1.5 / 2.5 + 1)
    idf3 = math.log(2.5 / 1.5 + 1)
    assert scores[0] == pytest.approx(idf1 * 1.0)
    assert scores[1] == pytest.approx(idf3 * 1.0)
    assert scores[2] == pytest.approx(idf1 * 4.0)


def test_sparse_index_ignores_unknown_terms() -> None:
    """Терм запроса, которого нет в корпусе, счёт не меняет (и не делит на ноль)."""
    index = SparseIndex([{"indices": [1], "values": [1.0]}])
    assert list(index.scores({"indices": [99], "values": [1.0]})) == [0.0]


# --- пост-фильтры -----------------------------------------------------------


def _chunk(path: str, index: int, parent: str) -> Chunk:
    return Chunk(
        path=path,
        title=path,
        chunk_index=index,
        section_path=f"{path} > {parent}",
        parent_id=parent,
        content_kind="text",
        tokens=10,
        chars=10,
        text="x",
    )


def test_dedupe_sections_keeps_the_best_chunk_of_each_section() -> None:
    chunks = [_chunk("a.md", 0, "s1"), _chunk("a.md", 1, "s1"), _chunk("a.md", 2, "s2")]
    assert dedupe_sections([0, 1, 2], chunks) == [0, 2]


def test_dedupe_sections_key_includes_the_path() -> None:
    """`parent_id` уникален только внутри файла — одинаковый id в разных файлах не схлопывается."""
    chunks = [_chunk("a.md", 0, "s1"), _chunk("b.md", 0, "s1")]
    assert dedupe_sections([0, 1], chunks) == [0, 1]


def test_dedupe_sections_passes_through_chunks_without_parent() -> None:
    chunks = [_chunk("a.md", 0, ""), _chunk("a.md", 1, "")]
    assert dedupe_sections([0, 1], chunks) == [0, 1]


def test_dedupe_chunks_drops_repeated_path_and_index() -> None:
    chunks = [_chunk("a.md", 0, "s1"), _chunk("a.md", 0, "s2")]
    assert dedupe_chunks([0, 1], chunks) == [0]


def test_post_filter_groups_then_cuts() -> None:
    chunks = [_chunk("a.md", 0, "s1"), _chunk("a.md", 1, "s1"), _chunk("b.md", 0, "s1")]
    assert post_filter([0, 1, 2], chunks, limit=5, group_by_section=True) == [0, 2]
    assert post_filter([0, 1, 2], chunks, limit=2, group_by_section=False) == [0, 1]


# --- метрики попадания ------------------------------------------------------


def test_first_relevant_rank_is_one_based() -> None:
    assert first_relevant_rank([7, 4, 9], {4}) == 2
    assert first_relevant_rank([7, 4, 9], {5}) is None


def test_hit_at_k_counts_only_ranks_within_k() -> None:
    ranks = [1, 3, None, 5]
    assert hit_at_k(ranks, 1) == pytest.approx(0.25)
    assert hit_at_k(ranks, 3) == pytest.approx(0.5)
    assert hit_at_k(ranks, 5) == pytest.approx(0.75)


def test_mrr_scores_a_miss_as_zero() -> None:
    """(1 + 1/3 + 0 + 1/5) / 4."""
    assert mean_reciprocal_rank([1, 3, None, 5]) == pytest.approx((1 + 1 / 3 + 1 / 5) / 4)


def test_hit_at_k_on_empty_input_is_zero_not_a_crash() -> None:
    assert hit_at_k([], 5) == 0.0
    assert mean_reciprocal_rank([]) == 0.0


def test_summarize_ranks_reports_every_cutoff() -> None:
    stats = summarize_ranks([1, 2, None])
    assert stats["n"] == 3
    assert stats["found"] == 2
    # summarize_ranks округляет до 4 знаков — отчёт коммитится и диффается.
    assert stats["hit_at"]["1"] == pytest.approx(1 / 3, abs=1e-4)
    assert stats["hit_at"]["10"] == pytest.approx(2 / 3, abs=1e-4)


def test_group_by_category_splits_and_keeps_every_bucket() -> None:
    groups = group_by_category([("table", 1), ("table", None), ("code", 2)])
    assert set(groups) == {"table", "code"}
    assert groups["table"]["n"] == 2
    assert groups["table"]["hit_at"]["1"] == pytest.approx(0.5)
    assert groups["code"]["hit_at"]["1"] == 0.0
    assert groups["code"]["hit_at"]["3"] == 1.0


# --- разделение ловушек -----------------------------------------------------


def test_best_threshold_maximizes_joint_accuracy() -> None:
    """Отвечаемые [1, 2], ловушки [0.5, 1.5]: порог 1.0 даёт 3 верных решения из 4."""
    best = best_threshold([1.0, 2.0], [0.5, 1.5])
    assert best is not None
    assert best["threshold"] == pytest.approx(1.0)
    assert best["accuracy"] == pytest.approx(0.75)
    assert best["answerable_kept"] == 2
    assert best["traps_refused"] == 1


def test_roc_auc_counts_winning_pairs() -> None:
    from audit_retrieval import roc_auc

    assert roc_auc([1.0, 2.0], [0.5, 1.5]) == pytest.approx(0.75)
    assert roc_auc([1.0], [1.0]) == pytest.approx(0.5)
    assert roc_auc([], [1.0]) is None


def test_distribution_reports_the_edges() -> None:
    stats = distribution([1.0, 2.0, 3.0, 4.0])
    assert stats["min"] == 1.0
    assert stats["max"] == 4.0
    assert stats["median"] == pytest.approx(2.5)


# --- загрузка и сравнение ---------------------------------------------------


def test_load_chunks_reads_the_export_shape(tmp_path) -> None:
    path = tmp_path / "chunks.jsonl"
    path.write_text(
        json.dumps(
            {
                "path": "a.md",
                "title": "a",
                "chunk_index": 0,
                "section_path": "a > b",
                "parent_id": "p",
                "content_kind": "table_rows",
                "tokens": 5,
                "chars": 7,
                "text": "текст",
            },
            ensure_ascii=False,
        )
        + "\n\n",
        encoding="utf-8",
    )
    chunks = load_chunks(path)
    assert len(chunks) == 1
    assert chunks[0].section_path == "a > b"
    assert chunks[0].content_kind == "table_rows"


def test_to_queries_keeps_refusal_and_category() -> None:
    queries = to_queries(
        [
            {"id": "q1", "question": "?", "category": "table", "source_path": "a.md"},
            {"id": "q2", "question": "?", "expected_refusal": True},
        ]
    )
    assert queries[0].category == "table"
    assert queries[0].source_path == "a.md"
    assert queries[1].expected_refusal is True
    # Пустая категория схлопывается в `unclassified` — правило харнесса, не своё.
    assert queries[1].category == "unclassified"


def _report(
    label: str,
    hit1: float,
    mrr: float,
    missing: list[str],
    section_ranks: dict[str, int | None] | None = None,
) -> dict:
    stats = {
        "n": 2,
        "hit_at": {"1": hit1, "3": 1.0, "5": 1.0, "10": 1.0},
        "mrr": mrr,
        "found": 2,
    }
    ranks = section_ranks or {"q1": 1, "x13": 1}
    return {
        "model": {"name": "m"},
        "retrieval": {"limit": 40},
        "corpus": {"label": label, "chunks": 10},
        "golden": {
            "answerable": 2,
            "section_labels": sorted(ranks),
            "section_labels_missing_in_corpus": missing,
        },
        "branches": {
            branch: {
                "file": stats,
                "file_by_category": {"table": stats},
                "section": stats,
            }
            for branch in ("dense", "bm25", "hybrid")
        },
        "per_query": [
            {
                "id": qid,
                "branches": {
                    branch: {"section_rank": rank} for branch in ("dense", "bm25", "hybrid")
                },
            }
            for qid, rank in sorted(ranks.items())
        ],
    }


def test_section_stats_on_restricts_the_denominator() -> None:
    """Метрики по разделам считаются ровно на переданном наборе вопросов."""
    report = _report("r", 1.0, 1.0, [], {"q1": 1, "q2": None, "q3": 4})
    stats = section_stats_on(report, {"q1", "q2"})
    assert stats["hybrid"]["n"] == 2
    assert stats["hybrid"]["hit_at"]["1"] == pytest.approx(0.5)
    assert stats["hybrid"]["mrr"] == pytest.approx(0.5)


def test_compute_delta_subtracts_the_baseline() -> None:
    delta = compute_delta(_report("after", 1.0, 0.9, []), _report("before", 0.5, 0.6, []))
    assert delta["branches"]["hybrid"]["file"]["hit_at"]["1"] == pytest.approx(0.5)
    assert delta["branches"]["hybrid"]["file"]["mrr"] == pytest.approx(0.3)
    assert delta["branches"]["hybrid"]["file_by_category"]["table"]["mrr"] == pytest.approx(0.3)
    assert delta["note"] == ""


def test_compute_delta_recomputes_sections_on_the_common_subset() -> None:
    """Метка, живая только в одном корпусе, выбрасывается из ОБЕИХ сторон дельты.

    `x13` найден в обоих корпусах на первом месте, но в «после» его раздела уже нет —
    если бы он остался в знаменателе, дельта по разделам показала бы движение там, где
    сменился набор строк, а не качество.
    """
    after = _report("after", 1.0, 0.9, ["x13"], {"q1": 2, "x13": 1})
    before = _report("before", 1.0, 0.9, [], {"q1": 1, "x13": 1})
    delta = compute_delta(after, before)
    assert delta["section_comparable_ids"] == ["q1"]
    assert "x13" in delta["note"]
    assert delta["branches"]["hybrid"]["section_baseline"]["n"] == 1
    assert delta["branches"]["hybrid"]["section_baseline"]["mrr"] == pytest.approx(1.0)
    assert delta["branches"]["hybrid"]["section_now"]["mrr"] == pytest.approx(0.5)
    assert delta["branches"]["hybrid"]["section"]["mrr"] == pytest.approx(-0.5)


def test_compute_delta_flags_a_different_model() -> None:
    baseline = _report("before", 1.0, 0.9, [])
    baseline["model"]["name"] = "другая"
    delta = compute_delta(_report("after", 1.0, 0.9, []), baseline)
    assert "РАЗНЫЕ МОДЕЛИ" in delta["note"]
