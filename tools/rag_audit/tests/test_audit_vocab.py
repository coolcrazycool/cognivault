"""Тесты линейки парного замера словарного разрыва (`audit_vocab`).

Проверяется АРИФМЕТИКА и ЧТЕНИЕ НАБОРА, а не поиск: парный контраст, разрез по
механизмам, recall@k, интервалы, точный Макнемар и вердикт считаются на крошечных
входах, где ответ посчитан руками. Ни дампа, ни эмбеддера, ни npx здесь не нужно —
иначе тест мерил бы окружение, а не прибор.

Отдельная группа тестов — деградация: набора ещё нет, в строке нет поля, пара
осиротела. Всё это штатные состояния (набор пишется параллельно), и каждое обязано
читаться как одна фраза, а не как трейсбек.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

import audit_vocab as av


# --------------------------------------------------------------------------- #
# Хелперы синтетики
# --------------------------------------------------------------------------- #


def make_arm(
    pair_id: str,
    variant: str,
    rank: int | None,
    *,
    mechanism: str = "synonym",
    twin_rank: int | None = None,
    gold: tuple[str, ...] = ("gold.md",),
    near: tuple[str, ...] = (),
    question: str | None = None,
    branch_ranks: dict[str, int | None] | None = None,
) -> av.ArmOutcome:
    """Арка с заранее известной выдачей: ранги задаются, а не считаются."""
    arm = av.Arm(
        id=f"{pair_id}-{variant}",
        pair_id=pair_id,
        variant=variant,
        mechanism=mechanism,
        question=question or f"{variant} {pair_id}",
        gold_paths=gold,
        near_duplicates=near,
    )
    outcome = av.ArmOutcome(arm=arm)
    for branch in av.BRANCHES:
        outcome.ranks[branch] = branch_ranks[branch] if branch_ranks else rank
        outcome.twin_ranks[branch] = twin_rank
        outcome.top_paths[branch] = ["other.md", "another.md"]
        outcome.deep_ranks[branch] = None
    outcome.query_stems = ("а", "б")
    outcome.shared_stems = ("а",)
    outcome.missing_stems = ("б",)
    return outcome


def make_pair(
    pair_id: str,
    mismatch_rank: int | None,
    matched_rank: int | None,
    *,
    mechanism: str = "synonym",
    twin_rank: int | None = None,
    near: tuple[str, ...] = (),
) -> av.PairOutcome:
    mismatch = make_arm(
        pair_id, av.ARM_MISMATCH, mismatch_rank, mechanism=mechanism, twin_rank=twin_rank, near=near
    )
    matched = make_arm(pair_id, av.ARM_MATCHED, matched_rank, mechanism=mechanism, near=near)
    pair = av.Pair(
        pair_id=pair_id, mechanism=mechanism, mismatch=mismatch.arm, matched=matched.arm
    )
    return av.PairOutcome(pair=pair, mismatch=mismatch, matched=matched)


def row(**overrides: object) -> dict[str, object]:
    base = {
        "id": "v01-mismatch",
        "question": "как перекинуть деньги в другой банк",
        "pair_id": "v01",
        "variant": "mismatch",
        "mechanism": "synonym",
        "gold_paths": ["Confluence/Переводы.md"],
    }
    base.update(overrides)
    return base


# --------------------------------------------------------------------------- #
# Статистика
# --------------------------------------------------------------------------- #


def test_wilson_at_zero_hits_is_not_a_point() -> None:
    """Нормальное приближение на нуле дало бы интервал нулевой ширины — то есть
    соврало бы ровно там, где неопределённость максимальна."""
    lo, hi = av.wilson_interval(0, 10)
    assert lo == 0.0
    assert hi == pytest.approx(0.2776, abs=1e-4)


def test_wilson_is_symmetric_at_the_other_end() -> None:
    lo, hi = av.wilson_interval(10, 10)
    assert hi == 1.0
    assert lo == pytest.approx(1.0 - 0.2776, abs=1e-4)


def test_wilson_on_empty_sample_admits_it_knows_nothing() -> None:
    assert av.wilson_interval(0, 0) == (0.0, 1.0)


def test_mcnemar_without_discordant_pairs_says_nothing() -> None:
    """Согласные пары информации о направлении не несут — p обязан быть 1."""
    assert av.mcnemar_exact(0, 0) == 1.0


def test_mcnemar_matches_hand_computed_binomial() -> None:
    """5 пар в одну сторону при нуле в другую: 2·(1/2⁵) = 0.0625 — ещё НЕ 0.05."""
    assert av.mcnemar_exact(5, 0) == pytest.approx(2 * 0.5**5)
    assert av.mcnemar_exact(6, 0) == pytest.approx(2 * 0.5**6)


def test_mcnemar_is_capped_at_one() -> None:
    """Симметричная дискордантность: удвоенный хвост превышает 1 и обязан срезаться."""
    assert av.mcnemar_exact(3, 3) == 1.0


def test_resolution_of_the_paired_test_is_six_pairs() -> None:
    """Разрешающая способность считается ПО САМОМУ тесту, а не вписана числом:
    меньше шести пар в одну сторону этот прибор от монетки не отличает."""
    assert av.MIN_DISCORDANT == 6
    assert av.mcnemar_exact(av.MIN_DISCORDANT, 0) <= 0.05
    assert av.mcnemar_exact(av.MIN_DISCORDANT - 1, 0) > 0.05


# --------------------------------------------------------------------------- #
# Чтение набора
# --------------------------------------------------------------------------- #


def test_missing_set_file_is_one_sentence_not_a_traceback(tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as error:
        av.load_pairs(tmp_path / "нет.jsonl")
    text = str(error.value)
    assert "парного набора нет" in text
    assert "mismatch|matched" in text  # подсказка про ожидаемую форму строки


def test_rows_missing_required_fields_are_listed_together(tmp_path: Path) -> None:
    """Ошибки КОПЯТСЯ: набор пишется руками, и ошибок в нём обычно не одна."""
    path = tmp_path / "vocab.jsonl"
    path.write_text(
        "\n".join(
            json.dumps(r, ensure_ascii=False)
            for r in (
                row(id="v01-mismatch", pair_id=""),
                row(id="v01-matched", variant="matched", mechanism=""),
            )
        ),
        encoding="utf-8",
    )
    with pytest.raises(SystemExit) as error:
        av.load_pairs(path)
    text = str(error.value)
    assert "pair_id" in text and "mechanism" in text
    assert text.count("•") == 2


def test_unknown_mechanism_is_loud() -> None:
    """Незнакомый механизм молча выпал бы из разреза «чем лечить»."""
    with pytest.raises(SystemExit) as error:
        av.parse_rows([row(mechanism="typo")], "набор")
    assert "typo" in str(error.value)


def test_refusal_trap_has_no_paired_contrast() -> None:
    with pytest.raises(SystemExit) as error:
        av.parse_rows([row(expected_refusal=True)], "набор")
    assert "expected_refusal" in str(error.value)


def test_gold_paths_fall_back_to_the_old_golden_schema() -> None:
    """Строка, написанная полями харнесса, обязана работать: файл должен оставаться
    пригодным и для `tools/eval/run.py`, который про gold_paths не знает."""
    parsed = av.parse_rows(
        [
            row(
                gold_paths=None,
                source_path="Confluence/А.md",
                alt_source_paths=["Confluence/Б.md"],
            )
        ],
        "набор",
    )
    assert parsed[0].gold_paths == ("Confluence/А.md", "Confluence/Б.md")


def test_orphan_arm_is_an_error_not_a_silent_drop() -> None:
    """Осиротевшая арка уменьшила бы знаменатель парного контраста без следа."""
    arms = av.parse_rows([row()], "набор")
    with pytest.raises(SystemExit) as error:
        av.build_pairs(arms, "набор")
    assert "нет арок" in str(error.value)


def test_arms_pointing_at_different_documents_are_rejected() -> None:
    arms = av.parse_rows(
        [
            row(),
            row(id="v01-matched", variant="matched", gold_paths=["Confluence/Другой.md"]),
        ],
        "набор",
    )
    with pytest.raises(SystemExit) as error:
        av.build_pairs(arms, "набор")
    assert "gold_paths арок различаются" in str(error.value)


def test_two_arms_with_the_same_text_are_not_a_pair() -> None:
    arms = av.parse_rows(
        [row(), row(id="v01-matched", variant="matched")], "набор"
    )
    with pytest.raises(SystemExit) as error:
        av.build_pairs(arms, "набор")
    assert "один и тот же текст" in str(error.value)


def test_well_formed_set_becomes_pairs(tmp_path: Path) -> None:
    path = tmp_path / "vocab.jsonl"
    path.write_text(
        "\n".join(
            json.dumps(r, ensure_ascii=False)
            for r in (
                row(),
                row(id="v01-matched", variant="matched", question="перевод в другой банк"),
                # `accepted: false` выбрасывается правилами харнесса — обе арки сразу,
                # иначе пара осиротела бы.
                row(id="v02-mismatch", pair_id="v02", accepted=False),
                row(
                    id="v02-matched",
                    pair_id="v02",
                    variant="matched",
                    question="иное",
                    accepted=False,
                ),
            )
        ),
        encoding="utf-8",
    )
    pairs = av.load_pairs(path)
    assert [p.pair_id for p in pairs] == ["v01"]
    assert pairs[0].mismatch.variant == "mismatch"
    assert pairs[0].matched.variant == "matched"


# --------------------------------------------------------------------------- #
# Маргиналы
# --------------------------------------------------------------------------- #


def test_marginal_recall_counts_only_ranks_within_k() -> None:
    arms = [
        make_arm("p1", av.ARM_MISMATCH, 3),
        make_arm("p2", av.ARM_MISMATCH, 12),
        make_arm("p3", av.ARM_MISMATCH, None),
        make_arm("p4", av.ARM_MISMATCH, 5),
    ]
    at5 = av.marginal(arms, "bm25", 5)
    assert (at5["hits"], at5["n"], at5["recall"]) == (2, 4, 0.5)
    at20 = av.marginal(arms, "bm25", 20)
    assert at20["hits"] == 3


# --------------------------------------------------------------------------- #
# Парный контраст
# --------------------------------------------------------------------------- #


def test_paired_counts_fill_all_four_cells() -> None:
    """Четыре клетки, посчитанные руками: оба / только matched / только mismatch / ни один."""
    outcomes = [
        make_pair("p1", 2, 3),  # оба
        make_pair("p2", None, 4),  # разрыв
        make_pair("p3", 1, None),  # обратный
        make_pair("p4", None, None),  # ни один
    ]
    item = av.paired_counts(outcomes, "bm25", 5)
    assert (item["both"], item["only_matched"], item["only_mismatch"], item["neither"]) == (
        1,
        1,
        1,
        1,
    )
    assert item["gap"] == 1
    assert item["net"] == 0.0


def test_a_rank_beyond_k_is_a_miss_at_that_k() -> None:
    """Разрыв обязан зависеть от отсечки: на k=5 документ потерян, на k=20 — нет."""
    outcomes = [make_pair("p1", 12, 2)]
    assert av.paired_counts(outcomes, "bm25", 5)["gap"] == 1
    assert av.paired_counts(outcomes, "bm25", 20)["gap"] == 0
    assert av.paired_counts(outcomes, "bm25", 20)["both"] == 1


def test_near_twin_displacement_is_not_counted_as_a_vocabulary_gap() -> None:
    """Двойник на месте золотого — другой дефект, и в счёт словаря он не идёт."""
    outcomes = [
        make_pair("p1", None, 2, twin_rank=1, near=("twin.md",)),
        make_pair("p2", None, 2),
    ]
    item = av.paired_counts(outcomes, "bm25", 5)
    assert item["gap"] == 2
    assert item["gap_vocab"] == 1
    assert item["gap_near_twin"] == 1
    assert item["gap_vocab_pairs"] == ["p2"]
    assert item["gap_near_twin_pairs"] == ["p1"]


def test_gap_of_one_pair_is_declared_inside_the_noise_quantum() -> None:
    outcomes = [make_pair("p1", None, 2)] + [make_pair(f"q{i}", 1, 1) for i in range(29)]
    item = av.paired_counts(outcomes, "bm25", 40)
    assert item["gap_vocab"] == 1
    assert item["within_noise"] is True
    assert item["resolvable"] is False


def test_six_one_sided_pairs_are_resolvable_five_are_not() -> None:
    """Граница разрешающей способности проверяется с обеих сторон."""
    five = [make_pair(f"g{i}", None, 2) for i in range(5)] + [
        make_pair(f"s{i}", 1, 1) for i in range(20)
    ]
    six = [make_pair(f"g{i}", None, 2) for i in range(6)] + [
        make_pair(f"s{i}", 1, 1) for i in range(20)
    ]
    assert av.paired_counts(five, "bm25", 40)["resolvable"] is False
    assert av.paired_counts(five, "bm25", 40)["mcnemar_p"] > 0.05
    assert av.paired_counts(six, "bm25", 40)["resolvable"] is True
    assert av.paired_counts(six, "bm25", 40)["mcnemar_p"] <= 0.05


def test_reverse_discordance_cancels_the_net_but_is_kept_visible() -> None:
    """Нетто гасится, а обе клетки остаются в отчёте: без «только mismatch» число
    «только matched» нечем интерпретировать."""
    outcomes = [make_pair("p1", None, 2), make_pair("p2", 2, None), make_pair("p3", 1, 1)]
    item = av.paired_counts(outcomes, "bm25", 5)
    assert item["net"] == 0.0
    assert item["only_matched"] == 1 and item["only_mismatch"] == 1
    assert item["reverse_pairs"] == ["p2"]
    assert item["mcnemar_p"] == 1.0


def test_branches_are_counted_separately() -> None:
    """Ветки не складываются: разрыв на bm25 может отсутствовать на dense."""
    outcomes = [
        av.PairOutcome(
            pair=av.Pair(
                pair_id="p1",
                mechanism="synonym",
                mismatch=make_arm("p1", av.ARM_MISMATCH, None).arm,
                matched=make_arm("p1", av.ARM_MATCHED, 1).arm,
            ),
            mismatch=make_arm(
                "p1", av.ARM_MISMATCH, None, branch_ranks={"bm25": None, "dense": 2, "hybrid": 3}
            ),
            matched=make_arm(
                "p1", av.ARM_MATCHED, 1, branch_ranks={"bm25": 1, "dense": 1, "hybrid": 1}
            ),
        )
    ]
    assert av.paired_counts(outcomes, "bm25", 5)["gap"] == 1
    assert av.paired_counts(outcomes, "dense", 5)["gap"] == 0


# --------------------------------------------------------------------------- #
# Механизмы
# --------------------------------------------------------------------------- #


def test_by_mechanism_splits_pairs_into_their_own_denominators() -> None:
    outcomes = [
        make_pair("p1", None, 2, mechanism="alias"),
        make_pair("p2", None, 2, mechanism="alias"),
        make_pair("p3", 1, 1, mechanism="paraphrase"),
    ]
    split = av.by_mechanism(outcomes, "bm25", 5)
    assert set(split) == {"alias", "paraphrase"}
    assert split["alias"]["n_pairs"] == 2 and split["alias"]["gap_vocab"] == 2
    assert split["paraphrase"]["n_pairs"] == 1 and split["paraphrase"]["gap_vocab"] == 0


# --------------------------------------------------------------------------- #
# Вердикт: логика зафиксирована ДО чисел и обязана срабатывать одинаково
# --------------------------------------------------------------------------- #


def verdict_for(outcomes: list[av.PairOutcome]) -> str:
    return av.analyse(outcomes)["verdict"]["outcome"]


def test_zero_gap_kills_the_idea_and_says_so() -> None:
    """Ноль парных промахов — законный исход, а не сбой замера."""
    outcomes = [make_pair(f"p{i}", 1, 1) for i in range(30)]
    report = av.analyse(outcomes)
    assert "МЕРТВА" in report["verdict"]["outcome"]
    assert report["misses"] == []


def test_zero_gap_on_a_tiny_set_is_not_a_death_sentence() -> None:
    """Ноль промахов на трёх парах — «мы не смотрели», а не «разрыва нет»: верхняя
    граница доли разрыва там 0.56, то есть каждый второй вопрос всё ещё мог бы
    терять документ."""
    report = av.analyse([make_pair(f"p{i}", 1, 1) for i in range(3)])
    assert "НЕОПРЕДЕЛЁННО" in report["verdict"]["outcome"]
    assert report["verdict"]["can_deny_gap"] is False
    assert any("ЗАЯВИТЬ ОТСУТСТВИЕ" in line for line in report["verdict"]["reasons"])


def test_sixteen_clean_pairs_are_enough_to_deny_the_gap() -> None:
    """Граница проверяется с обеих сторон: на 15 парах верхняя граница ещё 0.204,
    на 16 — уже 0.194, и приговор становится доступен."""
    assert "НЕОПРЕДЕЛЁННО" in verdict_for([make_pair(f"p{i}", 1, 1) for i in range(15)])
    assert "МЕРТВА" in verdict_for([make_pair(f"p{i}", 1, 1) for i in range(16)])


def test_six_clean_gaps_support_the_idea() -> None:
    outcomes = [make_pair(f"g{i}", None, 2) for i in range(6)] + [
        make_pair(f"s{i}", 1, 1) for i in range(24)
    ]
    assert "HEADROOM" in verdict_for(outcomes)


def test_three_gaps_are_inconclusive_not_a_finding() -> None:
    outcomes = [make_pair(f"g{i}", None, 2) for i in range(3)] + [
        make_pair(f"s{i}", 1, 1) for i in range(27)
    ]
    assert "НЕОПРЕДЕЛЁННО" in verdict_for(outcomes)


def test_gap_only_at_the_shallow_cutoff_is_a_ranking_problem() -> None:
    """Золотой стоит на 20-м месте: в наборе кандидатов он есть, просто ниже —
    переписывание запроса тут ни при чём."""
    outcomes = [make_pair(f"g{i}", 20, 2) for i in range(6)] + [
        make_pair(f"s{i}", 1, 1) for i in range(24)
    ]
    assert "ПОРЯДКА" in verdict_for(outcomes)


def test_ranking_verdict_admits_when_the_deep_half_is_unproven() -> None:
    """«На k=40 разрыва нет» — тоже утверждение, и на восьми парах оно не доказано."""
    outcomes = [make_pair(f"g{i}", 20, 2) for i in range(6)] + [
        make_pair(f"s{i}", 1, 1) for i in range(2)
    ]
    report = av.analyse(outcomes)
    assert "ПОРЯДКА" in report["verdict"]["outcome"]
    assert any("ОГОВОРКА" in line for line in report["verdict"]["reasons"])


def test_reverse_direction_flags_the_set_not_the_system() -> None:
    outcomes = [make_pair(f"r{i}", 2, None) for i in range(4)] + [
        make_pair(f"g{i}", None, 2) for i in range(2)
    ]
    assert "НЕ ИЗМЕРЯЕТ" in verdict_for(outcomes)


def test_near_twin_dominance_is_reported_as_a_different_defect() -> None:
    outcomes = [
        make_pair(f"t{i}", None, 2, twin_rank=1, near=("twin.md",)) for i in range(5)
    ] + [make_pair("g0", None, 2), make_pair("s0", 1, 1)]
    assert "ВЫТЕСНЕНИЕ" in verdict_for(outcomes)


# --------------------------------------------------------------------------- #
# Сборка отчёта и печать
# --------------------------------------------------------------------------- #


def test_analyse_reports_every_branch_and_never_a_blended_number() -> None:
    outcomes = [make_pair("p1", None, 2), make_pair("p2", 1, 1)]
    report = av.analyse(outcomes)
    assert set(report["branches"]) == set(av.BRANCHES)
    assert report["load_bearing_branch"] == "bm25"
    assert "ПРОДОВАЯ" in report["branches"]["bm25"]["transfer"]
    assert "ПОДМЕНА" in report["branches"]["dense"]["transfer"]
    # Сводного числа по веткам в отчёте нет: оно было бы средним между измеренным
    # и предположенным.
    assert "overall" not in report and "combined" not in report


def test_noise_quantum_is_one_pair_of_this_set() -> None:
    outcomes = [make_pair(f"p{i}", 1, 1) for i in range(25)]
    assert av.analyse(outcomes)["noise"]["one_pair"] == pytest.approx(0.04)


def test_misses_carry_enough_to_diagnose() -> None:
    outcomes = [make_pair("p1", None, 2)]
    miss = av.analyse(outcomes)["misses"][0]
    assert miss["pair_id"] == "p1"
    assert miss["mismatch"]["rank"] is None
    assert miss["matched"]["rank"] == 2
    assert miss["mismatch"]["top_paths"] == ["other.md", "another.md"]
    assert miss["mismatch"]["stems_missing"] == ["б"]
    assert miss["verdict"] == "золотого нет в наборе кандидатов"


def test_miss_behind_a_near_twin_is_diagnosed_as_such() -> None:
    outcomes = [make_pair("p1", None, 2, twin_rank=1, near=("twin.md",))]
    assert av.analyse(outcomes)["misses"][0]["verdict"] == "вытеснение почти-двойником"


def test_render_prints_criteria_before_numbers() -> None:
    """Предзаявленные критерии обязаны стоять ВЫШЕ таблиц: иначе «мы так и думали»
    неотличимо от «мы так решили, посмотрев»."""
    outcomes = [make_pair("p1", None, 2), make_pair("p2", 1, 1)]
    text = av.render(av.analyse(outcomes))
    assert text.index("ЧТО РЕШЕНО ДО ПРОГОНА") < text.index("ВЕТКА bm25")
    assert text.index("ВЕТКА bm25") < text.index("ВЕРДИКТ ПО ПРЕДЗАЯВЛЕННЫМ")
    assert "УБИВАЕТ" in text and "ПОДДЕРЖИВАЕТ" in text
    assert "квант шума" in text


def test_render_states_what_the_dense_number_cannot_say() -> None:
    text = av.render(av.analyse([make_pair("p1", 1, 1)]))
    assert "EmbeddingsGigaR" in text
    assert "ПОДМЕНА" in text


def test_render_puts_the_production_branch_first() -> None:
    """Читатель, дошедший сверху до первой таблицы, должен увидеть продовую ветку,
    а не подменную модель."""
    text = av.render(av.analyse([make_pair("p1", None, 2)]))
    assert text.index("ВЕТКА bm25") < text.index("ВЕТКА dense")
    assert "НЕСУЩАЯ" in text


def test_render_says_when_the_branch_returned_nothing_at_all() -> None:
    """Пустой топ-5 — это не «мы не напечатали», а «лексическая ветка пуста»."""
    outcomes = [make_pair("p1", None, 2)]
    outcomes[0].mismatch.top_paths["bm25"] = []
    assert "выдача ПУСТА" in av.render(av.analyse(outcomes))


# --------------------------------------------------------------------------- #
# Мост к продовому токенизатору
# --------------------------------------------------------------------------- #


def test_readable_stems_are_the_same_terms_the_sparse_vector_counts() -> None:
    """Диагноз «этого слова нет в документе» обязан говорить про ТЕ ЖЕ термы, по
    которым считается лексическая ветка, иначе он про другую систему.

    Проверяется соответствие: сколько РАЗНЫХ стеммов отдал `tokenize`, столько же
    индексов в разреженном векторе того же текста (индекс — FNV-хэш терма)."""
    import audit_retrieval as ar

    text = "Реестр витрин / afpc_sss_src\n\nвитрина загружается ежедневно и не в выходные"
    try:
        stems = av.tokenize_texts([text])[0]
    except SystemExit:  # pragma: no cover — окружение без npx
        pytest.skip("npx tsx недоступен")
    vector = ar.sparse_vectors([text], "query")[0]
    assert len(set(stems)) == len(vector["indices"])
    # Стоп-слова выброшены, регистр свёрнут — это и есть продовое поведение.
    assert "не" not in stems and "и" not in stems
    assert all(s == s.lower() for s in stems)


# --------------------------------------------------------------------------- #
# Деградация на уровне команды
# --------------------------------------------------------------------------- #


def test_cli_without_the_set_stops_before_touching_the_corpus(tmp_path: Path) -> None:
    """Набор пишется параллельно: команда обязана сказать это словами и не тронуть
    ни чанки, ни эмбеддер (иначе разработчик увидит трейсбек из torch)."""
    with pytest.raises(SystemExit) as error:
        av.main(
            [
                "--chunks",
                str(tmp_path / "chunks.jsonl"),
                "--set",
                str(tmp_path / "нет.jsonl"),
                "--out",
                str(tmp_path / "out.json"),
            ]
        )
    assert "парного набора нет" in str(error.value)


def test_cli_rejects_a_limit_shallower_than_the_deepest_cutoff(tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as error:
        av.main(
            [
                "--chunks",
                str(tmp_path / "chunks.jsonl"),
                "--set",
                str(tmp_path / "vocab.jsonl"),
                "--out",
                str(tmp_path / "out.json"),
                "--limit",
                "10",
            ]
        )
    assert "меньше максимальной отсечки" in str(error.value)


def test_cli_reports_a_missing_chunk_dump_in_one_line(tmp_path: Path) -> None:
    path = tmp_path / "vocab.jsonl"
    path.write_text(
        "\n".join(
            json.dumps(r, ensure_ascii=False)
            for r in (row(), row(id="v01-matched", variant="matched", question="иначе"))
        ),
        encoding="utf-8",
    )
    with pytest.raises(SystemExit) as error:
        av.main(
            [
                "--chunks",
                str(tmp_path / "chunks.jsonl"),
                "--set",
                str(path),
                "--out",
                str(tmp_path / "out.json"),
            ]
        )
    assert "выгрузки чанков нет" in str(error.value)
