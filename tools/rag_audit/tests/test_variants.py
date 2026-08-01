"""Тесты платформы вариантов `audit_retrieval`.

Как и в `test_audit_retrieval.py`, проверяется ЛИНЕЙКА, а не поиск: каждый режим
слияния, веса, глубины, хуки трансформации, конвейер пост-обработки, зачёт
`alt_source_paths` и отчёт о шуме считаются на крошечных синтетических входах,
где ответ посчитан руками. Вариант — это конфигурация ЭКСПЕРИМЕНТА: если сама
машинерия вариантов врёт, «гипотеза победила» неотличимо от «поехала платформа».
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from audit_retrieval import (
    RRF_K,
    Chunk,
    FusionSpec,
    Query,
    StageContext,
    Variant,
    apply_stages,
    compute_delta,
    dbsf_fuse,
    default_post_pipeline,
    fuse_candidates,
    normalize_scores,
    parse_variant,
    rank_changes,
    register_post_stage,
    register_query_transform,
    register_reranker,
    register_variant,
    relevant_file_docs,
    rrf_fuse,
    summarize_ranks,
    to_queries,
    transfer_note,
    variant_depths,
    variant_doc_texts,
    variant_query_texts,
    variant_touches,
    POST_STAGES,
    QUERY_PREFIX,
    VARIANTS,
)


# --- слияние: RRF с параметрами ----------------------------------------------


def test_rrf_k_is_configurable() -> None:
    """k=60 — «классический» RRF; счёт первого места = 1/60, второго = 1/61."""
    fused = dict(rrf_fuse([[7, 8]], k=60))
    assert fused[7] == pytest.approx(1 / 60)
    assert fused[8] == pytest.approx(1 / 61)


def test_rrf_weights_scale_each_branch() -> None:
    """Взвешенный RRF: вклад ветки умножается на её вес. Руками (k=1):
    док 0: 1·(1/1) + 3·(1/2) = 2.5; док 1: 1·(1/2) + 3·(1/1) = 3.5 → порядок [1, 0]."""
    fused = rrf_fuse([[0, 1], [1, 0]], k=1, weights=[1.0, 3.0])
    assert [doc for doc, _ in fused] == [1, 0]
    scores = dict(fused)
    assert scores[0] == pytest.approx(2.5)
    assert scores[1] == pytest.approx(3.5)


def test_rrf_unit_weights_match_the_unweighted_formula() -> None:
    assert rrf_fuse([[0, 1], [1, 0]]) == rrf_fuse([[0, 1], [1, 0]], weights=[1.0, 1.0])


def test_rrf_rejects_mismatched_weights() -> None:
    with pytest.raises(ValueError):
        rrf_fuse([[0]], weights=[1.0, 2.0])


# --- слияние: нормировка и DBSF ----------------------------------------------


def test_minmax_maps_the_branch_onto_zero_one() -> None:
    assert normalize_scores([1.0, 3.0, 2.0], "minmax") == pytest.approx([0.0, 1.0, 0.5])


def test_minmax_of_a_constant_branch_is_all_ones() -> None:
    """Все кандидаты равны — каждый «топ своей ветки», а не «дно» (0.0 обнулил бы
    вклад ветки целиком и молча превратил бы dbsf в одиночную ветку)."""
    assert normalize_scores([2.0, 2.0], "minmax") == [1.0, 1.0]


def test_zscore_centres_and_scales_by_population_sd() -> None:
    """[1, 2, 3]: mean 2, σ = sqrt(2/3)."""
    sd = math.sqrt(2 / 3)
    assert normalize_scores([1.0, 2.0, 3.0], "zscore") == pytest.approx(
        [-1 / sd, 0.0, 1 / sd]
    )
    assert normalize_scores([5.0, 5.0], "zscore") == [0.0, 0.0]


def test_normalize_rejects_unknown_norm() -> None:
    with pytest.raises(ValueError):
        normalize_scores([1.0], "softmax")


def test_dbsf_is_a_weighted_sum_of_normalized_branches() -> None:
    """Ветка A: док 0 → 1.0, док 1 → 0.0; ветка B: док 1 → 1.0, док 0 → 0.0.
    Веса (1, 2): док 0 = 1, док 1 = 2."""
    fused = dbsf_fuse(
        [[(0, 10.0), (1, 4.0)], [(1, 5.0), (0, 1.0)]], weights=[1.0, 2.0], norm="minmax"
    )
    assert [doc for doc, _ in fused] == [1, 0]
    scores = dict(fused)
    assert scores[0] == pytest.approx(1.0)
    assert scores[1] == pytest.approx(2.0)


def test_dbsf_breaks_ties_by_document_index() -> None:
    """Равные веса дают доку 0 и доку 1 по 1.0 — первым идёт меньший индекс."""
    fused = dbsf_fuse([[(0, 10.0), (1, 4.0)], [(1, 5.0), (0, 1.0)]])
    assert [doc for doc, _ in fused] == [0, 1]


def test_dbsf_doc_missing_from_a_branch_gets_no_contribution() -> None:
    """Док 2 есть только во второй ветке — его счёт целиком из неё."""
    fused = dict(dbsf_fuse([[(0, 2.0), (1, 1.0)], [(2, 9.0), (0, 3.0)]]))
    assert fused[2] == pytest.approx(1.0)
    assert fused[0] == pytest.approx(1.0 + 0.0)  # топ первой ветки + дно второй


def test_fuse_candidates_single_branch_modes_pass_scores_through() -> None:
    dense = [(3, 0.9), (1, 0.5)]
    sparse = [(2, 7.0)]
    assert fuse_candidates(FusionSpec(mode="dense"), dense, sparse) == dense
    assert fuse_candidates(FusionSpec(mode="bm25"), dense, sparse) == sparse


def test_fuse_candidates_drops_the_empty_sparse_branch_with_its_weight() -> None:
    """Запрос из одних стоп-слов: разреженной ветки нет, и её вес не участвует —
    порядок плотной ветки обязан уцелеть при любом весе bm25."""
    dense = [(5, 0.9), (2, 0.8)]
    fused = fuse_candidates(FusionSpec(mode="rrf", weights=(1.0, 99.0)), dense, [])
    assert [doc for doc, _ in fused] == [5, 2]


# --- спека варианта ----------------------------------------------------------


def test_parse_variant_fills_prod_defaults() -> None:
    variant = parse_variant({"name": "x"})
    assert variant.fusion == FusionSpec()
    assert variant.fusion.k == RRF_K
    assert variant.query_dense == "identity"
    assert variant.doc_sparse == "as_indexed"
    assert variant.post is None  # None = продовый конвейер, не «пустой»


def test_parse_variant_reads_every_knob() -> None:
    variant = parse_variant(
        {
            "name": "custom",
            "fusion": {"mode": "dbsf", "norm": "zscore", "weights": {"dense": 2, "bm25": 1}},
            "depths": {"limit": 10, "candidate_limit": 100},
            "query": {"sparse": "split_identifiers"},
            "doc": {"dense": "prepend_title"},
            "post": ["dedupe_chunks", {"stage": "mmr", "lambda": 0.7}],
        }
    )
    assert variant.fusion.mode == "dbsf"
    assert variant.fusion.norm == "zscore"
    assert variant.fusion.weights == (2.0, 1.0)
    assert variant.limit == 10
    assert variant.candidate_limit == 100
    assert variant.fetch_limit is None
    assert variant.query_sparse == "split_identifiers"
    assert variant.query_dense == "identity"
    assert variant.doc_dense == "prepend_title"
    assert variant.post == (("dedupe_chunks", {}), ("mmr", {"lambda": 0.7}))


def test_parse_variant_rejects_unknown_keys_loudly() -> None:
    """Опечатка в спеке обязана падать, не мерить дефолт молча."""
    with pytest.raises(SystemExit):
        parse_variant({"name": "x", "fusoin": {"k": 60}})
    with pytest.raises(SystemExit):
        parse_variant({"name": "x", "fusion": {"kk": 60}})


def test_parse_variant_rejects_unknown_hook_names() -> None:
    with pytest.raises(SystemExit):
        parse_variant({"name": "x", "query": {"dense": "нет-такого"}})
    with pytest.raises(SystemExit):
        parse_variant({"name": "x", "post": ["нет-такой-стадии"]})
    with pytest.raises(SystemExit):
        parse_variant({"name": "x", "post": [{"stage": "rerank", "impl": "нет-такого"}]})


def test_parse_variant_requires_a_name() -> None:
    with pytest.raises(SystemExit):
        parse_variant({"fusion": {"k": 60}})


def test_register_variant_validates_and_lands_in_the_registry() -> None:
    register_variant({"name": "test-registered", "fusion": {"mode": "rrf", "k": 7}})
    assert "test-registered" in VARIANTS
    with pytest.raises(SystemExit):
        register_variant({"name": "bad", "fusion": {"mode": "wat"}})


def test_variant_depths_defaults_to_service_ts_formulas() -> None:
    assert variant_depths(Variant(name="x"), cli_limit=40) == (40, 80, 160)


def test_variant_depths_overrides_are_independent() -> None:
    """Глубину ветки можно двигать, не трогая внешний срез, и наоборот."""
    variant = Variant(name="x", candidate_limit=100)
    assert variant_depths(variant, cli_limit=40) == (40, 80, 100)
    variant = Variant(name="x", limit=10, fetch_limit=15)
    assert variant_depths(variant, cli_limit=40) == (10, 15, 40)


def test_variant_touches_names_the_side_the_variant_changes() -> None:
    assert variant_touches(Variant(name="x")) == []
    assert variant_touches(Variant(name="x", fusion=FusionSpec(k=60))) == ["fusion"]
    assert "dense" in variant_touches(Variant(name="x", doc_dense="prepend_title"))
    assert "sparse" in variant_touches(Variant(name="x", query_sparse="split_identifiers"))
    assert "depth" in variant_touches(Variant(name="x", candidate_limit=100))
    assert "post" in variant_touches(Variant(name="x", post=()))


def test_transfer_note_flags_dense_side_as_model_specific() -> None:
    """Честность: вывод варианта, трогающего плотную сторону, не переносится в прод."""
    assert "модел" in transfer_note(["dense"]).lower() or "гипотез" in transfer_note(["dense"])
    assert "переносится" in transfer_note(["fusion"])


# --- трансформы запроса и композиция документа -------------------------------


def _chunk(text: str, section_path: str = "", title: str = "t") -> Chunk:
    return Chunk(
        path="a.md",
        title=title,
        chunk_index=0,
        section_path=section_path,
        parent_id="p",
        content_kind="text",
        tokens=1,
        chars=len(text),
        text=text,
    )


def _query(question: str, **kwargs) -> Query:
    defaults = dict(
        id="q",
        question=question,
        category="c",
        source_path="a.md",
        section_path=None,
        expected_refusal=False,
    )
    defaults.update(kwargs)
    return Query(**defaults)


def test_query_transform_applies_before_the_model_prefix() -> None:
    """Префикс e5 — свойство модели, трансформ — свойство запроса; разреженная
    сторона префикса не получает никогда (bm25 его не знает)."""
    register_query_transform("test-upper")(lambda text: text.upper())
    variant = parse_variant(
        {"name": "x", "query": {"dense": "test-upper", "sparse": "test-upper"}}
    )
    dense, sparse = variant_query_texts(variant, [_query("абв_где")])
    assert dense == [QUERY_PREFIX + "АБВ_ГДЕ"]
    assert sparse == ["АБВ_ГДЕ"]


def test_split_identifiers_reference_transform() -> None:
    variant = parse_variant({"name": "x", "query": {"sparse": "split_identifiers"}})
    dense, sparse = variant_query_texts(variant, [_query("что такое event_dt")])
    assert sparse == ["что такое event dt"]
    assert dense == [QUERY_PREFIX + "что такое event_dt"]  # плотная сторона не тронута


def test_doc_composer_sides_are_independent() -> None:
    chunk = _chunk("тело", title="Заголовок")
    variant = parse_variant({"name": "x", "doc": {"dense": "prepend_title"}})
    dense, sparse = variant_doc_texts(variant, [chunk])
    assert dense == ["Заголовок\n\nтело"]
    assert sparse == ["тело"]


def test_strip_breadcrumb_removes_only_a_matching_first_line() -> None:
    from audit_retrieval import DOC_COMPOSERS

    strip = DOC_COMPOSERS["strip_breadcrumb"]
    assert strip(_chunk("A > B\n\nтело", section_path="A > B")) == "тело"
    assert strip(_chunk("не крошка\nтело", section_path="A > B")) == "не крошка\nтело"


# --- конвейер пост-обработки -------------------------------------------------


def _ctx(chunks, fused_scores, limit=10, dense_docs=None, query_text="q") -> StageContext:
    return StageContext(
        query_text=query_text,
        chunks=chunks,
        dense_docs=dense_docs if dense_docs is not None else np.eye(len(chunks)),
        dense_query=np.zeros(len(chunks)),
        fused_scores=fused_scores,
        limit=limit,
    )


def test_apply_stages_runs_in_order_and_cuts_after_all_stages() -> None:
    register_post_stage("test-reverse")(lambda docs, ctx, params: list(reversed(docs)))
    chunks = [_chunk(str(i)) for i in range(4)]
    ctx = _ctx(chunks, {}, limit=2)
    result = apply_stages([0, 1, 2, 3], ctx, [("test-reverse", {})])
    assert result == [3, 2]  # сначала стадия, срез до limit — после


def test_default_post_pipeline_mirrors_prod() -> None:
    assert default_post_pipeline(True) == (("dedupe_chunks", {}), ("group_by_section", {}))
    assert default_post_pipeline(False) == (("dedupe_chunks", {}),)


def test_dedupe_near_collapses_normalized_duplicates() -> None:
    """Референс: casefold + схлопнутые пробелы. Третий чанк другой — остаётся."""
    chunks = [_chunk("Текст  один"), _chunk("текст один"), _chunk("другой")]
    ctx = _ctx(chunks, {})
    assert POST_STAGES["dedupe_near"]([0, 1, 2], ctx, {}) == [0, 2]


def test_mmr_reference_diversifies_by_hand_computed_scores() -> None:
    """Доки 0 и 1 — одинаковые вектора, док 2 ортогонален. rel (minmax): 1, 0.5, 0.
    λ=0.5: после дока 0 у дока 1 счёт 0.25−0.5 = −0.25, у дока 2 — 0 → [0, 2, 1]."""
    chunks = [_chunk("a"), _chunk("b"), _chunk("c")]
    dense = np.array([[1.0, 0.0], [1.0, 0.0], [0.0, 1.0]])
    ctx = _ctx(chunks, {0: 3.0, 1: 2.0, 2: 1.0}, dense_docs=dense)
    assert POST_STAGES["mmr"]([0, 1, 2], ctx, {"lambda": 0.5}) == [0, 2, 1]


def test_rerank_stage_dispatches_to_the_registered_impl() -> None:
    register_reranker("test-rr-reverse")(lambda q, docs, ctx: list(reversed(docs)))
    chunks = [_chunk(str(i)) for i in range(3)]
    ctx = _ctx(chunks, {})
    assert POST_STAGES["rerank"]([0, 1, 2], ctx, {"impl": "test-rr-reverse"}) == [2, 1, 0]


def test_rerank_may_cut_but_never_invent_candidates() -> None:
    register_reranker("test-rr-cut")(lambda q, docs, ctx: docs[:1])
    register_reranker("test-rr-invent")(lambda q, docs, ctx: docs + [99])
    register_reranker("test-rr-dup")(lambda q, docs, ctx: [docs[0], docs[0]])
    chunks = [_chunk(str(i)) for i in range(3)]
    ctx = _ctx(chunks, {})
    assert POST_STAGES["rerank"]([0, 1], ctx, {"impl": "test-rr-cut"}) == [0]
    with pytest.raises(SystemExit):
        POST_STAGES["rerank"]([0, 1], ctx, {"impl": "test-rr-invent"})
    with pytest.raises(SystemExit):
        POST_STAGES["rerank"]([0, 1], ctx, {"impl": "test-rr-dup"})


# --- alt_source_paths --------------------------------------------------------


def test_to_queries_reads_alt_source_paths_and_tolerates_their_absence() -> None:
    queries = to_queries(
        [
            {"id": "q1", "question": "?", "source_path": "a.md", "alt_source_paths": ["b.md", ""]},
            {"id": "q2", "question": "?", "source_path": "a.md"},
            {"id": "q3", "question": "?", "source_path": "a.md", "alt_source_paths": None},
        ]
    )
    assert queries[0].alt_source_paths == ("b.md",)  # пустая строка выброшена
    assert queries[1].alt_source_paths == ()
    assert queries[2].alt_source_paths == ()


def test_relevant_file_docs_accepts_any_listed_path() -> None:
    """Попадание = source_path ЛИБО любой alt-путь; неизвестный путь не роняет."""
    by_path = {"a.md": {0, 1}, "b.md": {2}}
    query = _query("?", alt_source_paths=("b.md", "нет.md"))
    assert relevant_file_docs(by_path, query) == {0, 1, 2}
    assert relevant_file_docs(by_path, _query("?")) == {0, 1}
    assert relevant_file_docs(by_path, _query("?", source_path=None)) == set()


# --- дельта: смены ранга и шум -----------------------------------------------


def _vreport(
    label: str,
    file_ranks: dict[str, int | None],
    retrieval: dict | None = None,
    source: str = "chunks.jsonl",
) -> dict:
    stats = summarize_ranks(list(file_ranks.values()))
    return {
        "model": {"name": "m"},
        "retrieval": retrieval or {"limit": 40, "fusion": {"mode": "rrf", "k": 2}},
        "corpus": {"label": label, "chunks": 10, "source": source},
        "golden": {
            "answerable": len(file_ranks),
            "section_labels": [],
            "section_labels_missing_in_corpus": [],
        },
        "branches": {
            branch: {"file": stats, "file_by_category": {"t": stats}, "section": stats}
            for branch in ("dense", "bm25", "hybrid")
        },
        "per_query": [
            {
                "id": qid,
                "branches": {
                    branch: {"file_rank": rank, "section_rank": None}
                    for branch in ("dense", "bm25", "hybrid")
                },
            }
            for qid, rank in sorted(file_ranks.items())
        ],
    }


def test_rank_changes_counts_moved_questions_with_direction() -> None:
    """q1 хуже (1→2), q2 выпал (3→None), q3 не двигался, q4 нашёлся (None→5)."""
    new = _vreport("new", {"q1": 2, "q2": None, "q3": 1, "q4": 5})
    old = _vreport("old", {"q1": 1, "q2": 3, "q3": 1, "q4": None})
    changes = rank_changes(new, old)["hybrid"]
    assert changes["n_changed"] == 3
    assert changes["improved"] == 1
    assert changes["regressed"] == 2
    assert {c["id"] for c in changes["changes"]} == {"q1", "q2", "q4"}
    # запись о смене ранга несёт и origin (строки без поля — customer)
    assert {"id": "q2", "origin": "customer", "was": 3, "now": None} in changes["changes"]


def test_delta_says_plainly_when_one_question_is_noise() -> None:
    """Один сменивший ранг на n=2 двигает hit@1 на 0.5 — и всё равно это шум одного
    вопроса; отчёт обязан сказать это прямо, а не оставить читателю аггрегат."""
    delta = compute_delta(
        _vreport("new", {"q1": 1, "q2": 1}), _vreport("old", {"q1": 1, "q2": 2})
    )
    assert delta["noise"]["answerable_n"] == 2
    assert delta["noise"]["one_question"] == pytest.approx(0.5)
    assert delta["rank_changes"]["hybrid"]["n_changed"] == 1
    assert "шума одного вопроса" in delta["noise"]["verdicts"]["hybrid"]


def test_delta_says_when_nothing_moved_at_all() -> None:
    delta = compute_delta(
        _vreport("new", {"q1": 1, "q2": 2}), _vreport("old", {"q1": 1, "q2": 2})
    )
    assert delta["rank_changes"]["hybrid"]["n_changed"] == 0
    assert "не изменилась" in delta["noise"]["verdicts"]["hybrid"]


def test_delta_lists_config_differences_instead_of_refusing() -> None:
    """Сравнение двух ВАРИАНТОВ на одном корпусе — штатный случай: отличия
    перечисляются, сравнение остаётся действительным."""
    new = _vreport("v2", {"q1": 1}, retrieval={"limit": 40, "fusion": {"mode": "rrf", "k": 60}})
    old = _vreport("v1", {"q1": 1}, retrieval={"limit": 40, "fusion": {"mode": "rrf", "k": 2}})
    delta = compute_delta(new, old)
    assert delta["config_diff"] == ["fusion.k: 2 → 60"]
    assert "недействительно" not in delta["note"]


def test_delta_warns_when_corpus_and_config_change_together() -> None:
    """Два фактора сразу — дельту нельзя атрибутировать ни одному из них."""
    new = _vreport(
        "v2",
        {"q1": 1},
        retrieval={"limit": 40, "fusion": {"mode": "rrf", "k": 60}},
        source="chunks-after.jsonl",
    )
    old = _vreport(
        "v1",
        {"q1": 1},
        retrieval={"limit": 40, "fusion": {"mode": "rrf", "k": 2}},
        source="chunks-before.jsonl",
    )
    delta = compute_delta(new, old)
    assert "нельзя атрибутировать" in delta["note"]
