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
    JUDGE_BLOCK_CAP_CHARS,
    JUDGE_CONTEXT_BUDGET_CHARS,
    METRIC_NAMES,
    PROMPT_VERSION,
    item_recall,
    aggregate,
    answer_relevancy_ru,
    context_precision,
    context_recall,
    coverage,
    faithfulness_ru,
    format_context,
    parse_citations,
    split_cited_statements,
    _pack_blocks,
    _verdict_fraction,
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
    # Заголовок сам по себе утверждением не считается — см. тест ниже.
    text = "## Заголовок\n\n- Первый пункт.\n- Первый пункт.\n\n1) Второй пункт."
    assert split_statements(text) == ["Первый пункт.", "Второй пункт."]


def test_list_items_are_separate_statements():
    """Списочный ответ — основной формат продукта, и он сливался в одно утверждение.

    Пункты не кончаются точкой, а `1.` в начале строки считается номером, а не
    границей, поэтому весь список копился до пустой строки. Прогон `baseline`:
    процедура из одиннадцати шагов на 1305 символов (x14) давала РОВНО одно
    утверждение, и `faithfulness` на списках вырождался в 0 или 1.
    """
    text = (
        "Шаги получения доступа:\n"
        "1. Открыть заявку в CTL\n"
        "2. Дождаться согласования\n"
        "- Уточнить у владельца\n"
        "- Проверить роль\n"
        "### Примечание\n"
        "Доступ выдаётся на год"
    )
    parts = split_sentences_ru(text)
    assert len(parts) == 6
    assert parts[1] == "1. Открыть заявку в CTL"
    assert parts[3] == "- Уточнить у владельца"
    # Заголовок со своим абзацем — одно утверждение: проверять надо абзац.
    assert parts[-1] == "### Примечание\nДоступ выдаётся на год"


def test_a_bare_heading_is_not_a_statement():
    """«Где почитать» подтвердить контекстом нельзя — судья ставит 0 за структуру."""
    text = "## Где почитать\n\nДокументация лежит в Confluence."
    assert split_statements(text) == ["Документация лежит в Confluence."]


def test_numbering_inside_a_line_still_does_not_split():
    """Граница — только НАЧАЛО строки: «п. 1) видимость» не список."""
    assert len(split_sentences_ru("Смотри п. 1) настройки и живи спокойно")) == 1


def test_verdict_key_is_read_in_russian_too():
    """Судья изредка переводит ключ сам, и пункт молча уходил в отрицательные."""
    raw = {"verdicts": [{"id": 1, "verdict": 1}, {"id": 2, "вердикт": 1}]}
    assert _verdict_fraction(raw, "verdict", 2) == 1.0


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


def test_answer_relevancy_hedged_answer_keeps_its_score():
    """«Прямого ответа не нашлось, но…» — и дальше эталон: это не отказ.

    В `baseline-2` такие ответы (x02, x09, fb23) уходили в 0.0 при оценке
    судьи 1–3: оговорка обнуляла содержательную часть. Теперь оговорка — метка.
    """
    answer = (
        "В доступных документах прямого ответа не нашлось.\n\n"
        "Из источников известно: YAFCA считает витрины на базе Feature Store."
    )
    result = asyncio.run(
        answer_relevancy_ru(StubJudge({"score": 4, "noncommittal": True}), "в?", answer)
    )
    assert result.score == 0.75
    assert result.hedged is True
    assert result.raw["noncommittal"] is True
    assert result.to_dict()["hedged"] is True


def test_answer_relevancy_pure_refusal_still_scores_zero():
    """Одна фраза отказа и ничего больше: судья ставит 1 → 0.0, hedged true."""
    refusal = "В доступных мне документах ответа на этот вопрос не нашлось."
    result = asyncio.run(
        answer_relevancy_ru(StubJudge({"score": 1, "noncommittal": True}), "в?", refusal)
    )
    assert result.score == 0.0
    assert result.hedged is True


def test_answer_relevancy_plain_answer_is_not_hedged():
    result = asyncio.run(
        answer_relevancy_ru(StubJudge({"score": 5, "noncommittal": False}), "в?", "ответ")
    )
    assert result.score == 1.0
    assert result.hedged is False
    assert asyncio.run(answer_relevancy_ru(StubJudge(), "в?", "")).hedged is False


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
# Citations: [Источник N] → which block a statement claims
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Факт [Источник 1].", [1]),
        ("[Источники 1, 3]", [1, 3]),
        ("[Источник 1][Источник 2]", [1, 2]),
        ("[Источники 1 и 3]", [1, 3]),
        ("[Источники 2–4]", [2, 3, 4]),
        ("[Источники 2-4]", [2, 3, 4]),
        ("[Источник №2]", [2]),
        ("[источник 5]", [5]),
        ("раз [Источник 2], два [Источник 2; 4]", [2, 4]),
        ("[Источник 1, стр. 3]", []),
        ("[Источник N]", []),
        ("[Источник 0]", []),
        ("без ссылок", []),
        ("", []),
    ],
)
def test_parse_citations_tolerates_the_forms_the_model_produces(text, expected):
    assert parse_citations(text) == expected


def test_parse_citations_does_not_explode_a_typo_range():
    """`[Источники 1–999]` — опечатка, не девятьсот блоков."""
    assert parse_citations("[Источники 1–999]") == [1, 999]


def test_trailing_citation_line_covers_the_block_above_it():
    """x18 в `baseline-2`: таблица, под ней строка `[Источник 1]` — и ноль.

    Строка из одних ссылок — не утверждение (судить её как утверждение — ноль
    «контекст не содержит информации»), а ссылка на весь переписанный блок.
    """
    answer = (
        "В таблице следующие колонки:\n\n"
        "| Колонка | Тип |\n| --- | --- |\n| id | bigint |\n| feed_type | text |\n\n"
        "[Источник 1]\n\n"
        "Отдельный факт без ссылки. Факт со ссылкой [Источник 2]."
    )
    items = split_cited_statements(answer)
    texts = [item.text for item in items]
    assert "[Источник 1]" not in texts
    assert texts[0] == "В таблице следующие колонки:"
    assert texts[-2:] == ["Отдельный факт без ссылки.", "Факт со ссылкой [Источник 2]."]
    assert [item.citations for item in items[:5]] == [[1]] * 5
    assert items[-2].citations == []
    assert items[-1].citations == [2]
    # Та же сегментация видна и через split_statements.
    assert split_statements(answer) == texts


def test_citation_walkback_stops_at_a_cited_statement():
    answer = "Первый [Источник 3]. Второй. Третий.\n\n[Источник 1]"
    items = split_cited_statements(answer)
    assert [item.citations for item in items] == [[3], [1], [1]]


# --------------------------------------------------------------------------- #
# The judge sees blocks in full (multi-call paths)
# --------------------------------------------------------------------------- #

#: Блок длиннее старого капа в 4000, с маркером в хвосте — там, где старый
#: судья уже ничего не видел.
DEEP_MARKER = "МАРКЕР_В_ГЛУБИНЕ_БЛОКА"
BIG_BLOCK = "слово " * 1500 + DEEP_MARKER + " хвост"  # ~9000 chars


def _block(size: int, tag: str) -> str:
    return (f"{tag} " * (size // (len(tag) + 1) + 1))[:size].strip()


def test_faithfulness_judges_a_cited_statement_against_its_block_in_full():
    judge = StubJudge({"verdicts": [{"id": 1, "verdict": 1, "reason": "есть"}]})
    answer = f"Таблица содержит {DEEP_MARKER} [Источник 1]."
    result = asyncio.run(faithfulness_ru(judge, answer, [BIG_BLOCK, "другой блок"]))

    assert result.score == 1.0
    assert result.raw["calls"] == 1
    assert len(judge.prompts) == 1
    prompt = judge.prompts[0]
    assert len(BIG_BLOCK) > 4000
    assert BIG_BLOCK in prompt  # блок целиком, не первые 4000 символов
    assert "[2] другой блок" not in prompt  # чужой блок в этот вызов не едет
    assert result.raw["context_clipped_by_judge"] is False
    assert result.raw["citations"] == [[1]]
    assert result.raw["verdicts"] == [
        {"id": 1, "blocks": [1], "verdict": 1, "reason": "есть"}
    ]
    assert result.raw["statements"] == [answer]


def test_faithfulness_falls_back_to_all_blocks_when_the_cited_one_rejects():
    """Модель сослалась не туда — это не повод для нуля: остаток судится по всем."""
    judge = StubJudge(
        {"verdicts": [{"id": 1, "verdict": 0, "reason": "не здесь"}]},  # блок 1
        {"verdicts": [{"id": 1, "verdict": 1, "reason": "во втором"}]},  # пакет [1, 2]
    )
    answer = "Факт из второго блока [Источник 1]."
    result = asyncio.run(faithfulness_ru(judge, answer, ["первый", "второй: факт"]))

    assert result.score == 1.0
    assert result.raw["calls"] == 2
    assert "[1] первый" in judge.prompts[1] and "[2] второй: факт" in judge.prompts[1]
    verdict = result.raw["verdicts"][0]
    assert verdict["verdict"] == 1
    assert verdict["blocks"] == [1, 2]
    assert verdict["reason"] == "во втором"


def test_faithfulness_groups_statements_per_cited_block_then_the_rest():
    judge = StubJudge(
        {"verdicts": [{"id": 1, "verdict": 1}]},  # блок 1: утверждение 1
        {"verdicts": [{"id": 1, "verdict": 1}]},  # блок 2: утверждение 3
        {"verdicts": [{"id": 1, "verdict": 0}]},  # все блоки: утверждение 2
    )
    answer = "Первое [Источник 1]. Второе без ссылки. Третье [Источник 2]."
    result = asyncio.run(faithfulness_ru(judge, answer, ["a", "b"]))

    assert result.score == pytest.approx(2 / 3)
    assert result.raw["calls"] == 3
    assert "1. Первое [Источник 1]." in judge.prompts[0]
    assert "1. Третье [Источник 2]." in judge.prompts[1]
    assert "1. Второе без ссылки." in judge.prompts[2]
    assert [v["verdict"] for v in result.raw["verdicts"]] == [1, 0, 1]


def test_faithfulness_uncited_answer_fitting_the_budget_is_one_uncut_call():
    judge = StubJudge({"verdicts": [{"id": 1, "verdict": 1}]})
    result = asyncio.run(faithfulness_ru(judge, "Факт.", [BIG_BLOCK, "второй"]))
    assert result.raw["calls"] == 1
    assert BIG_BLOCK in judge.prompts[0] and "[2] второй" in judge.prompts[0]
    assert "…" not in judge.prompts[0]
    assert result.raw["context_clipped_by_judge"] is False


def test_faithfulness_citation_beyond_the_context_is_ignored():
    """`[Источник 7]` при пяти блоках — ссылка в никуда, судим как без ссылки."""
    judge = StubJudge({"verdicts": [{"id": 1, "verdict": 1}]})
    result = asyncio.run(faithfulness_ru(judge, "Факт [Источник 7].", ["a", "b"]))
    assert result.raw["calls"] == 1
    assert result.raw["citations"] == [[]]
    assert result.score == 1.0


def test_faithfulness_failure_in_a_later_call_fails_the_metric():
    judge = StubJudge({"verdicts": [{"id": 1, "verdict": 0}]}, RuntimeError("упал"))
    result = asyncio.run(faithfulness_ru(judge, "Факт [Источник 1].", ["a", "b"]))
    assert result.score is None
    assert result.failed is True
    assert result.raw["calls"] == 1


def test_context_recall_unions_attribution_across_packs():
    """Три блока по 12000 не влезают в бюджет — по вызову на пакет, «или»."""
    assert 3 * 12000 > JUDGE_CONTEXT_BUDGET_CHARS
    blocks = [_block(12000, "первый"), _block(12000, "второй"), _block(12000, "третий")]
    judge = StubJudge(
        {"verdicts": [{"id": 1, "attributed": 1}, {"id": 2, "attributed": 0}]},
        # Во втором вызове остаётся одно предложение, и оно снова под номером 1.
        {"verdicts": [{"id": 1, "attributed": 1}]},
    )
    result = asyncio.run(
        context_recall(judge, "в?", "Первое предложение. Второе предложение.", blocks)
    )
    assert result.score == 1.0
    assert result.raw["calls"] == 2  # третий пакет не понадобился
    assert result.raw["packs"] == [[1], [2], [3]]
    assert blocks[0] in judge.prompts[0] and blocks[1] in judge.prompts[1]
    assert "1. Второе предложение." in judge.prompts[1]
    assert "Первое предложение." not in judge.prompts[1]
    assert [v["attributed"] for v in result.raw["verdicts"]] == [1, 1]
    assert result.raw["verdicts"][1]["blocks"] == [1, 2]
    assert result.raw["context_clipped_by_judge"] is False


def test_context_recall_within_budget_is_one_call_with_full_blocks():
    judge = StubJudge({"verdicts": [{"id": 1, "attributed": 1}]})
    result = asyncio.run(context_recall(judge, "в?", "Эталон.", [BIG_BLOCK, "b"]))
    assert result.raw["calls"] == 1
    assert BIG_BLOCK in judge.prompts[0]
    assert "…" not in judge.prompts[0]


def test_context_precision_judges_each_block_on_its_full_text():
    blocks = [_block(15000, "альфа"), _block(15000, "бета")]
    judge = StubJudge(
        {"verdicts": [{"id": 1, "relevant": 1}]},
        {"verdicts": [{"id": 2, "relevant": 0}]},
    )
    result = asyncio.run(context_precision(judge, "в?", blocks))
    assert result.score == 0.5
    assert result.raw["calls"] == 2
    assert blocks[0] in judge.prompts[0] and blocks[1] in judge.prompts[1]
    assert "[2] " in judge.prompts[1] and "[1] " not in judge.prompts[1]
    assert [v["relevant"] for v in result.raw["verdicts"]] == [1, 0]


def test_context_precision_reads_a_judge_that_renumbers_from_one():
    """Показали `[2] …`, судья ответил `id: 1` — вердикт всё равно к блоку 2."""
    blocks = [_block(15000, "альфа"), _block(15000, "бета")]
    judge = StubJudge(
        {"verdicts": [{"id": 1, "relevant": 0}]},
        {"verdicts": [{"id": 1, "relevant": 1}]},
    )
    result = asyncio.run(context_precision(judge, "в?", blocks))
    assert [v["relevant"] for v in result.raw["verdicts"]] == [0, 1]


def test_context_precision_within_budget_is_one_call():
    judge = StubJudge({"verdicts": [{"id": 1, "relevant": 1}, {"id": 2, "relevant": 1}]})
    result = asyncio.run(context_precision(judge, "в?", ["a", "b"]))
    assert result.score == 1.0
    assert result.raw["calls"] == 1


def test_pack_blocks_fills_a_budget_with_consecutive_blocks():
    assert _pack_blocks(["a" * 100, "b" * 100]) == [[1, 2]]
    assert _pack_blocks(
        ["a" * 12000, "b" * 6000, "c" * 6000, "d" * 25000, "e" * 100]
    ) == [[1, 2], [3], [4], [5]]
    assert _pack_blocks(["a", "b", "c"], budget=1) == [[1], [2], [3]]


def test_context_clipped_by_judge_flags_a_block_over_the_cap():
    huge = "x" * (JUDGE_BLOCK_CAP_CHARS + 1)
    verdict = {"verdicts": [{"id": 1, "verdict": 1, "relevant": 1, "attributed": 1}]}
    assert asyncio.run(faithfulness_ru(StubJudge(verdict), "Факт.", [huge])).raw[
        "context_clipped_by_judge"
    ] is True
    assert asyncio.run(context_precision(StubJudge(verdict), "в?", [huge])).raw[
        "context_clipped_by_judge"
    ] is True
    assert asyncio.run(context_recall(StubJudge(verdict), "в?", "Эталон.", [huge])).raw[
        "context_clipped_by_judge"
    ] is True
    assert asyncio.run(faithfulness_ru(StubJudge(verdict), "Факт.", [BIG_BLOCK])).raw[
        "context_clipped_by_judge"
    ] is False


def test_format_context_does_not_cut_by_default():
    assert format_context([BIG_BLOCK]) == f"[1] {BIG_BLOCK}"


def test_prompt_version_bumped_for_the_full_context_judge():
    """Промпты изменились — оценки v1 и v2 несравнимы, run.py печатает версию."""
    assert PROMPT_VERSION != "v1"
    assert PROMPT_VERSION == "v2"


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
