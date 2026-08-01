"""Проверка ЛИНЕЙКИ сводного табло, а не корпуса.

Тот же принцип, что у остальных тестов линейки: входы синтетические и мелкие,
ответ на каждом посчитан руками. Табло решает, что считать регрессией, — и если
сломается оно само, «стало лучше» станет неотличимо от «сломался замер». Здесь
проверяется ровно это: вердикт порога, квант шума СВОЕГО origin, отказ сравнивать
разъехавшиеся прогоны и код выхода.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

import scorecard as sc

TOOLS_DIR = Path(__file__).resolve().parents[1]


# --------------------------------------------------------------------------- #
# Синтетические отчёты: только те поля, которые табло действительно читает.
# --------------------------------------------------------------------------- #


def make_reports() -> dict[str, dict]:
    return {
        "convert": {
            "corpus": {
                "pages": 100,
                "retention": {"corpus_recall": 0.99, "pages_below_50pct": 0},
                "tables": {
                    "cell_placement_accuracy": 0.98,
                    "converter_errors": 0,
                    "tables_with_cell_mismatch": 0,
                    "gfm_ragged_out": 0,
                },
                "code": {"exact_rate": 0.9},
                "images": {"links_broken": 0, "images_dropped_no_filename": 0},
            }
        },
        "chunk": {
            "corpus": {
                "chunks": 1000,
                "sections": 300,
                "sectionsOverCap": 40,
                "chunksInOversizedSections": 600,
                "parentIdCollisions": 0,
                "overBudget": {"chunks": 0},
                "structure": {
                    # 3 из 12 = 0.25 ровно — доля посчитана руками.
                    "code_blocks": 12,
                    "code_blocks_split": 3,
                    # 10 из 500 = 0.02.
                    "linearized_rows": 500,
                    "linearized_rows_split": 10,
                    "tables_split": 0,
                    "table_rows_lost": 0,
                    "headerless_table_chunks": 0,
                    "code_blocks_lost": 0,
                    "unbalanced_fence_chunks": 0,
                },
            },
            "duplicates": {"share_of_corpus": 0.05},
        },
        "retrieval": {
            "branches": {
                "hybrid": {
                    "file_by_origin": {
                        "customer": {
                            "n": 28,
                            "found": 28,
                            "hit_at": {"1": 0.75},
                            "mrr": 0.8,
                        },
                        "generated": {
                            "n": 160,
                            "found": 160,
                            "hit_at": {"1": 0.84},
                            "mrr": 0.9,
                        },
                        # Авторский срез мелкий НАМЕРЕННО: судятся только отвечаемые
                        # строки класса corpus_scope, ловушки и метавопросы — нет.
                        "authored": {
                            "n": 6,
                            "found": 6,
                            "hit_at": {"1": 0.6667},
                            "mrr": 0.8056,
                        },
                    }
                }
            }
        },
        "window": {
            "measure": {"threshold": 0.8},
            "prod": {
                "all": {"chars_mean": 2000.0, "chars_5_blocks": 10000},
                "by_origin": {
                    "customer": {"contained": 0.9, "judged": 28},
                    "generated": {"contained": 0.92, "judged": 156},
                    "authored": {"contained": 1.0, "judged": 5},
                },
                "oversized_only": {"contained": 0.8, "judged": 71},
            },
            "ceiling": {"attainable_share_mean": 0.78},
            "anchor_failures": {"total": 0},
        },
    }


def make_provenance() -> dict:
    return {
        "commit": "aaaaaaa",
        "dirty": False,
        "dump": {"name": "dump.zip", "sha256": "dump-sha", "pages": 100},
        "golden": [
            {"name": "golden.jsonl", "path": "tools/eval/golden.jsonl", "sha256": "g1", "rows": 39},
            {
                "name": "golden.corpus.jsonl",
                "path": "tools/eval/golden.corpus.jsonl",
                "sha256": "g2",
                "rows": 191,
            },
        ],
        "model": "intfloat/multilingual-e5-base",
        "retrieval_config": {"limit": 40, "group_by_section": True},
        "window_config": {"prod_cap": 4000, "threshold": 0.8},
        "rulers": {"audit_convert.py": "r1", "audit_retrieval.py": "r2"},
    }


def make_thresholds(**overrides: float) -> dict:
    """Пороги ровно по измеренному синтетическому прогону, если не сказано иначе."""
    base = {
        "convert.word_recall": 0.99,
        "convert.cell_placement": 0.98,
        "convert.code_exact": 0.9,
        "chunk.torn_code_share": 0.25,
        "chunk.torn_row_share": 0.02,
        "chunk.duplicate_share": 0.05,
        "retrieval.hit1.customer": 0.7,
        "retrieval.hit1.generated": 0.83,
        "retrieval.mrr.customer": 0.75,
        "retrieval.mrr.generated": 0.89,
        "window.contained.customer": 0.85,
        "window.contained.generated": 0.91,
        "window.contained.oversized": 0.78,
        "retrieval.hit1.authored": 0.5,
        "retrieval.mrr.authored": 0.6389,
        "window.contained.authored": 0.8,
    }
    base.update(overrides)
    return {"metrics": {key: {"threshold": value} for key, value in base.items()}}


def make_baseline(reports=None, provenance=None, per_query=None) -> dict:
    reports = reports or make_reports()
    card = sc.build(provenance or make_provenance(), reports, make_thresholds())
    return {
        "created_utc": "2026-08-01T00:00:00+00:00",
        "provenance": provenance or make_provenance(),
        "headline": {
            key: {"value": m.value, "n": m.n} for key, m in card.measurements.items()
        },
        "per_query": per_query or {"retrieval": [], "window": []},
    }


# --------------------------------------------------------------------------- #
# Извлечение
# --------------------------------------------------------------------------- #


def test_headline_computes_shares_by_hand():
    values = sc.headline(make_reports())
    assert values["chunk.torn_code_share"].value == 0.25  # 3 из 12
    assert values["chunk.torn_row_share"].value == 0.02  # 10 из 500
    assert values["convert.word_recall"].value == 0.99
    assert values["retrieval.hit1.customer"] == sc.Measurement(0.75, 28)
    assert values["retrieval.hit1.generated"] == sc.Measurement(0.84, 160)
    # Знаменатель стыка 4 — СУДИМЫЕ вопросы, а не все: 156, не 158.
    assert values["window.contained.generated"] == sc.Measurement(0.92, 156)
    assert values["window.contained.oversized"] == sc.Measurement(0.8, 71)


def test_headline_covers_every_declared_metric():
    values = sc.headline(make_reports())
    assert set(values) == {metric.key for metric in sc.METRICS}


def test_tripwires_cover_every_declared_key():
    values = sc.tripwires(make_reports())
    assert set(values) == {wire.key for wire in sc.TRIPWIRES}
    assert all(value == 0 for value in values.values())


def test_missing_origin_slice_fails_loudly():
    """Прогон без второго --golden не должен молча дать табло на половине набора."""
    reports = make_reports()
    del reports["retrieval"]["branches"]["hybrid"]["file_by_origin"]["generated"]
    with pytest.raises(KeyError, match="file_by_origin"):
        sc.headline(reports)


def test_missing_path_fails_loudly_not_silently():
    reports = make_reports()
    del reports["convert"]["corpus"]["retention"]["corpus_recall"]
    with pytest.raises(KeyError, match="corpus_recall"):
        sc.headline(reports)


# --------------------------------------------------------------------------- #
# Вердикт порога
# --------------------------------------------------------------------------- #


def test_threshold_verdict_up_direction():
    metric = sc.METRICS_BY_KEY["retrieval.hit1.customer"]
    assert sc.threshold_verdict(metric, sc.Measurement(0.8, 28), 0.75)["ok"]
    assert not sc.threshold_verdict(metric, sc.Measurement(0.7, 28), 0.75)["ok"]


def test_threshold_verdict_on_the_boundary_holds():
    """Пол — это «не ниже», а не «строго выше»: равенство обязано проходить."""
    metric = sc.METRICS_BY_KEY["convert.word_recall"]
    assert sc.threshold_verdict(metric, sc.Measurement(0.9993), 0.9993)["ok"]
    down = sc.METRICS_BY_KEY["chunk.torn_code_share"]
    assert sc.threshold_verdict(down, sc.Measurement(0.1746), 0.1746)["ok"]


def test_threshold_verdict_down_direction_is_a_ceiling():
    metric = sc.METRICS_BY_KEY["chunk.duplicate_share"]
    assert sc.threshold_verdict(metric, sc.Measurement(0.04), 0.05)["ok"]
    assert not sc.threshold_verdict(metric, sc.Measurement(0.06), 0.05)["ok"]


# --------------------------------------------------------------------------- #
# Шум: квант считается на n СВОЕГО origin
# --------------------------------------------------------------------------- #


def test_quantum_is_zero_for_deterministic_metrics():
    metric = sc.METRICS_BY_KEY["convert.word_recall"]
    assert sc.quantum(metric, sc.Measurement(0.99)) == 0.0


def test_quantum_differs_per_origin():
    customer = sc.METRICS_BY_KEY["retrieval.hit1.customer"]
    generated = sc.METRICS_BY_KEY["retrieval.hit1.generated"]
    authored = sc.METRICS_BY_KEY["retrieval.hit1.authored"]
    assert sc.quantum(customer, sc.Measurement(0.75, 28)) == 0.0357
    assert sc.quantum(generated, sc.Measurement(0.84, 160)) == 0.0063
    # Авторский срез — 6 судимых строк. Квант в четыре с половиной раза грубее
    # приёмочного, и линейка обязана говорить это числом, а не молчать.
    assert sc.quantum(authored, sc.Measurement(0.6667, 6)) == 0.1667


def test_authored_slice_is_coarse_and_says_so():
    """Сдвиг в один приёмочный вопрос на авторском срезе — всё ещё шум.

    Не дефект, а честная разрешающая способность: класс из шести судимых строк
    ловит ПРОПАДАНИЕ, а не настройку. Тест держит это свойство явным, чтобы
    порог 0.5 не прочитали как заниженную планку.
    """
    entry = sc.classify(
        sc.METRICS_BY_KEY["retrieval.hit1.authored"],
        sc.Measurement(0.5, 6),
        sc.Measurement(0.6667, 6),
    )
    assert entry["verdict"] == sc.NOISE
    # А выпадение двух из шести — уже не шум.
    worse = sc.classify(
        sc.METRICS_BY_KEY["retrieval.hit1.authored"],
        sc.Measurement(0.3333, 6),
        sc.Measurement(0.6667, 6),
    )
    assert worse["verdict"] == sc.WORSE


def test_every_origin_with_a_metric_also_has_a_tripwire():
    """Разрез, чьё качество меряют, обязан иметь и сигнализацию «вопрос не найден вовсе»."""
    metric_origins = {m.origin for m in sc.METRICS if m.stage == 3}
    wire_origins = {t.key.rsplit(".", 1)[1] for t in sc.TRIPWIRES if t.key.startswith("retrieval.")}
    assert metric_origins == wire_origins == set(sc.ORIGINS)


def test_one_question_is_noise_on_customer_and_change_on_generated():
    """Один и тот же сдвиг: на 28 вопросах — шум, на 160 — изменение.

    Ровно ради этого различия разрез по origin и заведён: усреднённый на общем
    n квант объявил бы шумом настоящее движение сгенерированного набора.
    """
    delta = 0.0357  # цена одного вопроса приёмочного набора
    customer = sc.classify(
        sc.METRICS_BY_KEY["retrieval.hit1.customer"],
        sc.Measurement(0.7857, 28),
        sc.Measurement(0.75, 28),
    )
    generated = sc.classify(
        sc.METRICS_BY_KEY["retrieval.hit1.generated"],
        sc.Measurement(round(0.84 + delta, 4), 160),
        sc.Measurement(0.84, 160),
    )
    assert customer["verdict"] == sc.NOISE
    assert generated["verdict"] == sc.BETTER


def test_deterministic_metric_has_no_noise_band():
    """Тот же дамп и тот же код — тот же результат: любая дельта реальна."""
    entry = sc.classify(
        sc.METRICS_BY_KEY["convert.word_recall"],
        sc.Measurement(0.9992),
        sc.Measurement(0.9993),
    )
    assert entry["verdict"] == sc.WORSE
    assert entry["quantum"] == 0.0


def test_identical_values_are_reported_as_unchanged():
    entry = sc.classify(
        sc.METRICS_BY_KEY["window.contained.oversized"],
        sc.Measurement(0.8028, 71),
        sc.Measurement(0.8028, 71),
    )
    assert entry["verdict"] == sc.SAME
    assert entry["delta"] == 0.0


def test_lower_is_better_metric_flips_the_verdict():
    worse = sc.classify(
        sc.METRICS_BY_KEY["chunk.torn_code_share"],
        sc.Measurement(0.2),
        sc.Measurement(0.1746),
    )
    better = sc.classify(
        sc.METRICS_BY_KEY["chunk.torn_code_share"],
        sc.Measurement(0.1),
        sc.Measurement(0.1746),
    )
    assert worse["verdict"] == sc.WORSE
    assert better["verdict"] == sc.BETTER


# --------------------------------------------------------------------------- #
# Отказ сравнивать
# --------------------------------------------------------------------------- #


def test_identical_provenance_is_comparable_everywhere():
    result = sc.comparability(make_provenance(), make_provenance())
    assert result["comparable"] == {1: True, 2: True, 3: True, 4: True}
    assert not result["reasons"]
    assert not result["warnings"]


def test_changed_corpus_blocks_all_four_stages():
    now = make_provenance()
    now["dump"]["sha256"] = "other-dump"
    result = sc.comparability(now, make_provenance())
    assert result["comparable"] == {1: False, 2: False, 3: False, 4: False}
    assert "dump" in result["reasons"]


def test_changed_golden_blocks_only_the_stages_that_read_it():
    """Правка разметки не имеет права выглядеть как изменение конвертера."""
    now = make_provenance()
    now["golden"][1]["sha256"] = "g2-edited"
    result = sc.comparability(now, make_provenance())
    assert result["comparable"] == {1: True, 2: True, 3: False, 4: False}
    assert "золотой набор другой" in result["reasons"]["golden"]


def test_added_golden_file_blocks_comparison_too():
    now = make_provenance()
    now["golden"].append({"name": "extra.jsonl", "path": "extra.jsonl", "sha256": "g3", "rows": 5})
    result = sc.comparability(now, make_provenance())
    assert result["comparable"][3] is False


def test_changed_model_blocks_retrieval_and_window():
    now = make_provenance()
    now["model"] = "some/other-model"
    result = sc.comparability(now, make_provenance())
    assert result["comparable"] == {1: True, 2: True, 3: False, 4: False}


def test_changed_search_config_blocks_only_stage_three():
    now = make_provenance()
    now["retrieval_config"]["limit"] = 10
    result = sc.comparability(now, make_provenance())
    assert result["comparable"] == {1: True, 2: True, 3: False, 4: True}
    assert "limit" in result["reasons"]["retrieval_config"]


def test_changed_window_config_blocks_only_stage_four():
    now = make_provenance()
    now["window_config"]["prod_cap"] = 8000
    result = sc.comparability(now, make_provenance())
    assert result["comparable"] == {1: True, 2: True, 3: True, 4: False}


def test_changed_ruler_warns_but_does_not_refuse():
    """Правка самого инструмента — предупреждение: иначе история обнулялась бы."""
    now = make_provenance()
    now["rulers"]["audit_retrieval.py"] = "r2-new"
    result = sc.comparability(now, make_provenance())
    assert result["comparable"] == {1: True, 2: True, 3: True, 4: True}
    assert any("ЛИНЕЙКА СДВИНУЛАСЬ" in w for w in result["warnings"])
    assert any("audit_retrieval.py" in w for w in result["warnings"])


def test_dirty_tree_is_flagged():
    now = make_provenance()
    now["dirty"] = True
    result = sc.comparability(now, make_provenance())
    assert any("грязное" in w for w in result["warnings"])


# --------------------------------------------------------------------------- #
# Сколько вопросов сменили ранг
# --------------------------------------------------------------------------- #


def test_rank_changes_counts_directions_per_origin():
    base = [
        {"id": "x1", "origin": "customer", "rank": 3},
        {"id": "x2", "origin": "customer", "rank": 1},
        {"id": "g1", "origin": "generated", "rank": 2},
        {"id": "g2", "origin": "generated", "rank": 1},
    ]
    now = [
        {"id": "x1", "origin": "customer", "rank": 1},  # лучше
        {"id": "x2", "origin": "customer", "rank": 4},  # хуже
        {"id": "g1", "origin": "generated", "rank": 2},  # без изменений
        {"id": "g2", "origin": "generated", "rank": None},  # выпал вовсе — хуже
    ]
    changes = sc.rank_changes(now, base)
    assert changes["customer"] == {
        "changed": 2,
        "improved": 1,
        "regressed": 1,
        "examples": [
            {"id": "x1", "was": 3, "now": 1},
            {"id": "x2", "was": 1, "now": 4},
        ],
    }
    assert changes["generated"]["changed"] == 1
    assert changes["generated"]["regressed"] == 1


def test_rank_changes_treats_appearing_from_nowhere_as_improvement():
    changes = sc.rank_changes(
        [{"id": "x1", "origin": "customer", "rank": 7}],
        [{"id": "x1", "origin": "customer", "rank": None}],
    )
    assert changes["customer"]["improved"] == 1


def test_rank_changes_ignores_questions_absent_from_the_baseline():
    changes = sc.rank_changes(
        [{"id": "new", "origin": "customer", "rank": 1}],
        [{"id": "old", "origin": "customer", "rank": 1}],
    )
    assert changes == {}


def test_identical_ranking_reports_nothing_changed():
    rows = [{"id": "x1", "origin": "customer", "rank": 2}]
    assert sc.rank_changes(rows, copy.deepcopy(rows)) == {}


def test_containment_changes_count_threshold_crossings_only():
    base = [
        {"id": "a", "origin": "customer", "judgeable": True, "contained": False, "containment": 0.5},
        {"id": "b", "origin": "customer", "judgeable": True, "contained": True, "containment": 1.0},
        {"id": "c", "origin": "generated", "judgeable": True, "contained": True, "containment": 0.9},
        {"id": "d", "origin": "generated", "judgeable": False, "contained": False, "containment": 0.0},
    ]
    now = [
        {"id": "a", "origin": "customer", "judgeable": True, "contained": True, "containment": 0.95},
        {"id": "b", "origin": "customer", "judgeable": True, "contained": True, "containment": 0.85},
        {"id": "c", "origin": "generated", "judgeable": True, "contained": False, "containment": 0.6},
        {"id": "d", "origin": "generated", "judgeable": False, "contained": True, "containment": 1.0},
    ]
    changes = sc.containment_changes(now, base)
    # `b` изменило покрытие, но не сторону порога — это не событие.
    assert changes["customer"] == {
        "changed": 1,
        "improved": 1,
        "regressed": 0,
        "examples": [{"id": "a", "was": 0.5, "now": 0.95}],
    }
    # `d` несудимо ни там, ни там — в счёт не идёт.
    assert changes["generated"]["changed"] == 1
    assert changes["generated"]["regressed"] == 1


# --------------------------------------------------------------------------- #
# Гейт и код выхода
# --------------------------------------------------------------------------- #


def test_clean_run_against_matching_baseline_exits_zero():
    card = sc.build(
        make_provenance(),
        make_reports(),
        make_thresholds(),
        make_baseline(),
        {"retrieval": [], "window": []},
    )
    assert card.failures == []
    assert card.refusals == []
    assert card.exit_code == sc.EXIT_OK


def test_metric_below_threshold_fails_the_gate():
    card = sc.build(
        make_provenance(),
        make_reports(),
        make_thresholds(**{"retrieval.hit1.customer": 0.9}),
        make_baseline(),
    )
    assert card.exit_code == sc.EXIT_GATE
    assert any("retrieval.hit1.customer" in f for f in card.failures)


def test_fired_tripwire_fails_the_gate():
    reports = make_reports()
    reports["chunk"]["corpus"]["structure"]["tables_split"] = 1
    card = sc.build(make_provenance(), reports, make_thresholds(), make_baseline())
    assert card.exit_code == sc.EXIT_GATE
    assert any("chunk.tables_split" in f for f in card.failures)


def test_unretrieved_question_is_a_tripwire_not_a_metric():
    reports = make_reports()
    reports["retrieval"]["branches"]["hybrid"]["file_by_origin"]["customer"]["found"] = 27
    card = sc.build(make_provenance(), reports, make_thresholds(), make_baseline())
    assert card.tripwire_values["retrieval.unretrieved.customer"] == 1
    assert card.exit_code == sc.EXIT_GATE


def test_regression_beyond_noise_fails_even_above_the_threshold():
    """Пол ещё держится, но метрика уехала больше чем на вопрос — это регрессия.

    Два механизма гейта независимы намеренно: порог ловит «упало ниже, чем
    когда-либо», дельта ловит «поехало вниз», пока запас до пола ещё есть.
    """
    baseline = make_baseline()
    reports = make_reports()
    # 0.84 → 0.833: выше порога 0.83, но больше кванта 0.0063 на n=160.
    reports["retrieval"]["branches"]["hybrid"]["file_by_origin"]["generated"]["hit_at"]["1"] = 0.833
    card = sc.build(make_provenance(), reports, make_thresholds(), baseline)
    threshold_ok = sc.threshold_verdict(
        sc.METRICS_BY_KEY["retrieval.hit1.generated"],
        card.measurements["retrieval.hit1.generated"],
        0.83,
    )["ok"]
    assert threshold_ok
    assert card.changes["metrics"]["retrieval.hit1.generated"]["verdict"] == sc.WORSE
    assert card.exit_code == sc.EXIT_GATE
    assert any("регрессия" in f for f in card.failures)


def test_regression_within_noise_does_not_fail():
    baseline = make_baseline()
    reports = make_reports()
    # 0.75 → 0.7143 это ровно один вопрос из 28.
    reports["retrieval"]["branches"]["hybrid"]["file_by_origin"]["customer"]["hit_at"]["1"] = 0.7143
    card = sc.build(make_provenance(), reports, make_thresholds(), baseline)
    assert card.changes["metrics"]["retrieval.hit1.customer"]["verdict"] == sc.NOISE
    assert card.exit_code == sc.EXIT_OK


def test_incomparable_baseline_exits_two_and_prints_no_delta():
    baseline = make_baseline()
    now = make_provenance()
    now["dump"]["sha256"] = "another-corpus"
    card = sc.build(now, make_reports(), make_thresholds(), baseline)
    assert card.exit_code == sc.EXIT_INCOMPARABLE
    assert card.refusals
    assert all(
        entry["verdict"] == "incomparable" for entry in card.changes["metrics"].values()
    )


def test_changed_golden_leaves_stages_one_and_two_comparable():
    baseline = make_baseline()
    now = make_provenance()
    now["golden"][0]["sha256"] = "edited"
    card = sc.build(now, make_reports(), make_thresholds(), baseline)
    assert card.changes["metrics"]["convert.word_recall"]["verdict"] == sc.SAME
    assert card.changes["metrics"]["retrieval.hit1.customer"]["verdict"] == "incomparable"
    assert "retrieval_ranks" not in card.changes


def test_failure_outranks_refusal_in_the_exit_code():
    """«Стало хуже» важнее «не знаю»: провал не должен маскироваться отказом."""
    baseline = make_baseline()
    now = make_provenance()
    now["dump"]["sha256"] = "another-corpus"
    card = sc.build(now, make_reports(), make_thresholds(**{"convert.code_exact": 0.99}), baseline)
    assert card.refusals and card.failures
    assert card.exit_code == sc.EXIT_GATE


def test_run_without_baseline_says_so_and_passes():
    card = sc.build(make_provenance(), make_reports(), make_thresholds(), None)
    assert card.exit_code == sc.EXIT_OK
    assert any("базового прогона нет" in w for w in card.warnings)
    assert card.changes == {}


def test_missing_threshold_warns_instead_of_silently_passing():
    thresholds = make_thresholds()
    del thresholds["metrics"]["convert.word_recall"]
    card = sc.build(make_provenance(), make_reports(), thresholds, None)
    assert any("не задан порог" in w for w in card.warnings)


# --------------------------------------------------------------------------- #
# Печать
# --------------------------------------------------------------------------- #


def test_render_states_what_the_numbers_do_not_mean():
    card = sc.build(make_provenance(), make_reports(), make_thresholds(), make_baseline())
    text = sc.render(card)
    assert "multilingual-e5-base" in text
    assert "tools/eval/" in text
    assert "МОНОТОННА" in text
    assert "код выхода 0" in text


def test_render_shows_rank_changes_in_both_directions():
    baseline = make_baseline(
        per_query={
            "retrieval": [
                {"id": "x1", "origin": "customer", "rank": 3},
                {"id": "x2", "origin": "customer", "rank": 1},
            ],
            "window": [],
        }
    )
    card = sc.build(
        make_provenance(),
        make_reports(),
        make_thresholds(),
        baseline,
        {
            "retrieval": [
                {"id": "x1", "origin": "customer", "rank": 1},
                {"id": "x2", "origin": "customer", "rank": 5},
            ],
            "window": [],
        },
    )
    text = sc.render(card)
    assert "лучше 1, хуже 1" in text


def test_render_refuses_loudly():
    now = make_provenance()
    now["dump"]["sha256"] = "another-corpus"
    card = sc.build(now, make_reports(), make_thresholds(), make_baseline())
    text = sc.render(card)
    assert "ОТКАЗ СРАВНИВАТЬ" in text
    assert "код выхода 2" in text


# --------------------------------------------------------------------------- #
# Конфигурация в дереве
# --------------------------------------------------------------------------- #


def test_shipped_thresholds_cover_every_metric():
    """Метрика без порога не калибрует гейт — файл обязан идти в ногу с METRICS."""
    thresholds = json.loads((TOOLS_DIR / "thresholds.json").read_text(encoding="utf-8"))
    assert set(thresholds["metrics"]) == {metric.key for metric in sc.METRICS}
    assert set(thresholds["tripwires"]["keys"]) == {wire.key for wire in sc.TRIPWIRES}


def test_shipped_thresholds_say_they_are_a_floor():
    thresholds = json.loads((TOOLS_DIR / "thresholds.json").read_text(encoding="utf-8"))
    assert "ПОРОГ — ЭТО ПОЛ, А НЕ ЦЕЛЬ." in "\n".join(thresholds["note"])


def test_shipped_baseline_matches_the_current_metric_set():
    """Базовый прогон в дереве обязан быть сравним с тем, что считается сегодня."""
    path = TOOLS_DIR / "baseline.json"
    if not path.exists():  # pragma: no cover — первый прогон до записи базы
        pytest.skip("базового прогона ещё нет")
    baseline = json.loads(path.read_text(encoding="utf-8"))
    assert set(baseline["headline"]) == {metric.key for metric in sc.METRICS}
    assert set(baseline["per_query"]) == {"retrieval", "window"}
    for key in ("dump", "golden", "model", "rulers"):
        assert key in baseline["provenance"]
