"""Tests for the metric module: RU sentence segmentation, verdict → score, aggregation.

No live GigaChat: the judge is a stub implementing ``complete_json``.
"""

from __future__ import annotations

import asyncio
import os
import sys

import pytest
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from metrics import (  # noqa: E402
    METRIC_NAMES,
    item_recall,
    aggregate,
    answer_relevancy_ru,
    context_precision,
    context_recall,
    coverage,
    faithfulness_ru,
    format_context,
    split_sentences_ru,
    split_statements,
)


class StubJudge:
    """Returns queued verdicts (or raises) instead of calling GigaChat."""

    def __init__(self, *verdicts: Any) -> None:
        self._verdicts = list(verdicts)
        self.prompts: list[str] = []

    async def complete_json(
        self, prompt: str, *, system: str | None = None, temperature: float | None = None
    ) -> dict[str, Any]:
        self.prompts.append(prompt)
        verdict = self._verdicts.pop(0) if self._verdicts else {}
        if isinstance(verdict, Exception):
            raise verdict
        return verdict


# --------------------------------------------------------------------------- #
# Sentence segmentation
# --------------------------------------------------------------------------- #


def test_splits_on_plain_sentences():
    text = "Индексация идёт поллером. Поиск — гибридный! Понятно?"
    assert split_sentences_ru(text) == [
        "Индексация идёт поллером.",
        "Поиск — гибридный!",
        "Понятно?",
    ]


def test_abbreviation_does_not_split():
    text = "Мы храним чанки, векторы и т.д. Затем идёт поиск."
    assert split_sentences_ru(text) == [
        "Мы храним чанки, векторы и т.д. Затем идёт поиск."
    ]


def test_more_abbreviations_kept_together():
    text = "См. рис. 3 и табл. 2 на стр. 15."
    assert split_sentences_ru(text) == ["См. рис. 3 и табл. 2 на стр. 15."]


def test_version_number_does_not_split():
    text = "Qdrant 1.16.3 стоит на проме. Клиент совместим."
    assert split_sentences_ru(text) == [
        "Qdrant 1.16.3 стоит на проме.",
        "Клиент совместим.",
    ]


def test_initials_do_not_split():
    text = "Автор — И. И. Иванов из отдела. Он согласовал схему."
    parts = split_sentences_ru(text)
    assert parts[0].startswith("Автор — И. И. Иванов")
    assert len(parts) == 2


def test_price_abbreviation():
    text = "Стоимость 100 руб. и 50 коп. указана в счёте."
    assert len(split_sentences_ru(text)) == 1


def test_blank_line_is_a_boundary():
    text = "Первый абзац без точки\n\nВторой абзац"
    assert split_sentences_ru(text) == ["Первый абзац без точки", "Второй абзац"]


def test_ellipsis_and_multi_terminator():
    text = "Что это?! Не знаю… Ладно."
    assert split_sentences_ru(text) == ["Что это?!", "Не знаю…", "Ладно."]


def test_empty_text_gives_no_sentences():
    assert split_sentences_ru("") == []
    assert split_sentences_ru("   \n  ") == []


def test_split_statements_strips_markdown_and_dedupes():
    text = "## Заголовок\n\n- Первый пункт.\n- Первый пункт.\n\n1) Второй пункт."
    assert split_statements(text) == ["Заголовок", "Первый пункт.", "Второй пункт."]


def test_format_context_numbers_and_caps():
    rendered = format_context(["a" * 50, "b"], max_chars=10)
    assert rendered.startswith("[1] aaaaaaaaaa…")
    assert "[2] b" in rendered
    assert format_context([]) == "(контекст пуст)"


# --------------------------------------------------------------------------- #
# Metrics against a stub judge
# --------------------------------------------------------------------------- #


def test_faithfulness_counts_supported_statements():
    judge = StubJudge(
        {
            "verdicts": [
                {"id": 1, "verdict": 1},
                {"id": 2, "verdict": 0},
                {"id": 3, "verdict": 1},
                {"id": 4, "verdict": 1},
            ]
        }
    )
    answer = "Первое утверждение. Второе утверждение. Третье утверждение. Четвёртое."
    result = asyncio.run(faithfulness_ru(judge, answer, ["контекст"]))
    assert result.score == 0.75
    assert result.raw["statements"]


def test_faithfulness_without_context_is_zero():
    result = asyncio.run(faithfulness_ru(StubJudge(), "Утверждение.", []))
    assert result.score == 0.0


def test_faithfulness_missing_verdicts_count_as_unsupported():
    judge = StubJudge({"verdicts": [{"id": 1, "verdict": 1}]})
    answer = "Раз. Два. Три. Четыре."
    result = asyncio.run(faithfulness_ru(judge, answer, ["ctx"]))
    assert result.score == 0.25


def test_faithfulness_judge_failure_degrades_to_none():
    judge = StubJudge(RuntimeError("судья недоступен"))
    result = asyncio.run(faithfulness_ru(judge, "Раз.", ["ctx"]))
    assert result.score is None
    assert "RuntimeError" in result.error


def test_answer_relevancy_maps_1_to_5_scale():
    assert asyncio.run(
        answer_relevancy_ru(StubJudge({"score": 5}), "в?", "ответ")
    ).score == 1.0
    assert asyncio.run(
        answer_relevancy_ru(StubJudge({"score": 3}), "в?", "ответ")
    ).score == 0.5
    assert asyncio.run(
        answer_relevancy_ru(StubJudge({"score": 1}), "в?", "ответ")
    ).score == 0.0


def test_answer_relevancy_noncommittal_is_zero():
    result = asyncio.run(
        answer_relevancy_ru(StubJudge({"score": 4, "noncommittal": True}), "в?", "о")
    )
    assert result.score == 0.0


def test_context_precision_fraction_of_relevant_chunks():
    judge = StubJudge(
        {"verdicts": [{"id": 1, "relevant": 1}, {"id": 2, "relevant": 0}]}
    )
    result = asyncio.run(context_precision(judge, "вопрос?", ["a", "b"]))
    assert result.score == 0.5


def test_context_recall_uses_ground_truth_sentences():
    judge = StubJudge(
        {"verdicts": [{"id": 1, "attributed": 1}, {"id": 2, "attributed": 1}]}
    )
    result = asyncio.run(
        context_recall(judge, "вопрос?", "Первое. Второе.", ["контекст"])
    )
    assert result.score == 1.0


def test_context_recall_without_context_is_zero():
    result = asyncio.run(context_recall(StubJudge(), "в?", "Эталон.", []))
    assert result.score == 0.0


# --------------------------------------------------------------------------- #
# Aggregation
# --------------------------------------------------------------------------- #


def _sample(**scores: Any) -> dict[str, Any]:
    return {"metrics": {name: {"score": value} for name, value in scores.items()}}


def test_aggregate_means_and_skips_none():
    samples = [
        _sample(faithfulness_ru=1.0, answer_relevancy_ru=0.5),
        _sample(faithfulness_ru=0.0, answer_relevancy_ru=None),
    ]
    agg = aggregate(samples)
    assert agg["faithfulness_ru"] == 0.5
    assert agg["answer_relevancy_ru"] == 0.5
    assert agg["context_precision"] is None  # никогда не считалась → не 0


def test_aggregate_ignores_bools_and_garbage():
    samples = [_sample(faithfulness_ru=True), _sample(faithfulness_ru="0.9")]
    assert aggregate(samples)["faithfulness_ru"] is None


def test_aggregate_covers_all_metric_names():
    assert set(aggregate([])) == set(METRIC_NAMES)


def test_coverage_counts_usable_scores():
    samples = [_sample(faithfulness_ru=1.0), _sample(faithfulness_ru=None)]
    assert coverage(samples)["faithfulness_ru"] == 1


# --------------------------------------------------------------------------- #
# item_recall — полнота перечисления
# --------------------------------------------------------------------------- #


def test_item_recall_counts_missing_items():
    """Воспроизводит реальный провал: 3 модели из 7 в ответе про финэффект.

    Судейские метрики этого не видят: всё сказанное верно, ответ релевантен и
    опирается на контекст — неполон только СПИСОК.
    """
    answer = "Не рассчитывается для *BNPL_1*, ACQUIRER и CARDS_DROP_MODEL."
    expected = [
        "BNPL_1",
        "ACQUIRER",
        "CARDS_DROP_MODEL",
        "PROF_NOT_PROF_CARDS",
        "СМС-модель",
        "Скоринг неплатежных",
        "PROF_NOT_PROF_DBO",
    ]

    result = item_recall(answer, expected)

    assert result.score == pytest.approx(3 / 7)
    assert result.raw["missing"] == expected[3:]


def test_item_recall_matches_inside_markup_and_ignores_case():
    result = item_recall(
        "Потоки: **psi_metric_compute**, `Simple_Metrics`.",
        ["psi_metric_compute", "simple_metrics"],
    )
    assert result.score == 1.0


def test_item_recall_is_none_without_expected_items():
    """Вопросы не про перечисление метрику не получают — None, а не ноль."""
    assert item_recall("любой ответ", []).score is None


def test_item_recall_zero_on_empty_answer():
    assert item_recall("", ["A", "B"]).score == 0.0
