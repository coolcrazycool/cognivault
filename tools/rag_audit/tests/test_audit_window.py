"""Тесты стыка 4 — меры «доехал ли ответ до модели».

Всё на синтетических входах, где ответ посчитан руками: мера, которая молча
разъехалась, страшнее отсутствия меры — она превращает «стало хуже» в «стало
лучше» и никак себя не проявляет. Токенизатор и нарезка окна здесь не трогаются:
их считает НАСТОЯЩИЙ код через `section_windows.ts`, и подменять его заглушкой
значило бы тестировать заглушку.
"""

from __future__ import annotations

import audit_window as aw


# --------------------------------------------------------------------------- #
# Термы: ответ минус вопрос, достижимость, покрытие
# --------------------------------------------------------------------------- #


def test_answer_terms_drops_question_words() -> None:
    """Терм, прозвучавший в вопросе, из меры выбывает — он в окне по построению."""
    gt = {"финэффект", "эмуляц", "экономи"}
    question = {"финэффект", "зач"}
    assert aw.answer_terms(gt, question) == {"эмуляц", "экономи"}


def test_answer_terms_can_be_empty() -> None:
    """Эталон, целиком повторяющий вопрос, не даёт ни одного своего терма."""
    assert aw.answer_terms({"а", "б"}, {"а", "б", "в"}) == set()


def test_attainable_is_intersection_with_section() -> None:
    """Знаменатель — только то, что вообще есть в разделе."""
    assert aw.attainable_terms({"а", "б", "в"}, {"б", "в", "г"}) == {"б", "в"}


def test_attainable_excludes_paraphrase_gap() -> None:
    """Терм, которого в разделе нет, не попадает ни в числитель, ни в знаменатель:
    иначе разрыв пересказа записывался бы в потери обрезки."""
    attainable = aw.attainable_terms({"есть", "нету"}, {"есть", "лишний"})
    assert attainable == {"есть"}
    assert aw.containment(attainable, {"есть"}) == 1.0


def test_containment_counts_only_attainable() -> None:
    assert aw.containment({"а", "б", "в", "г"}, {"а", "б", "лишний"}) == 0.5


def test_containment_full_and_empty() -> None:
    assert aw.containment({"а"}, {"а", "б"}) == 1.0
    assert aw.containment({"а", "б"}, set()) == 0.0


def test_containment_empty_denominator_is_one() -> None:
    """Терять нечего — покрытие 1.0; такие вопросы отсеивает MIN_ATTAINABLE_TERMS."""
    assert aw.containment(set(), set()) == 1.0


def test_containment_is_monotone_in_window() -> None:
    """Ключевое ограничение меры, зафиксированное тестом: большее окно не может
    набрать меньше. Отсюда и требование читать её вместе с ценой в символах."""
    attainable = {"а", "б", "в"}
    small = aw.containment(attainable, {"а"})
    large = aw.containment(attainable, {"а", "б"})
    whole = aw.containment(attainable, {"а", "б", "в"})
    assert small <= large <= whole == 1.0


# --------------------------------------------------------------------------- #
# Локус ответа
# --------------------------------------------------------------------------- #


def test_locus_finds_the_tight_span() -> None:
    """Термы ответа лежат в строках 3–4; локус обязан взять именно их, а не весь
    раздел, хотя весь раздел их тоже покрывает."""
    lines = [
        {"шум"},
        {"шум2"},
        {"а", "б"},
        {"в"},
        {"шум3"},
    ]
    assert aw.answer_locus(lines, {"а", "б", "в"}, 1.0) == (2, 3)


def test_locus_picks_the_shortest_of_equal_covers() -> None:
    """Термы встречаются дважды: побеждает более короткий диапазон."""
    lines = [
        {"а"},
        {"шум"},
        {"шум"},
        {"б"},
        {"а", "б"},
    ]
    assert aw.answer_locus(lines, {"а", "б"}, 1.0) == (4, 4)


def test_locus_honours_partial_coverage() -> None:
    """При coverage 0.5 хватает половины термов — диапазон короче."""
    lines = [{"а"}, {"шум"}, {"б"}, {"в"}, {"г"}]
    assert aw.answer_locus(lines, {"а", "б", "в", "г"}, 0.5) == (2, 3)


def test_locus_single_line() -> None:
    lines = [{"шум"}, {"а", "б", "в"}, {"шум"}]
    assert aw.answer_locus(lines, {"а", "б", "в"}, 1.0) == (1, 1)


def test_locus_none_when_terms_unreachable() -> None:
    """Терм, которого нет ни в одной строке, покрыть нельзя — локуса нет."""
    assert aw.answer_locus([{"а"}, {"б"}], {"а", "б", "нигде"}, 1.0) is None


def test_locus_none_without_attainable_terms() -> None:
    assert aw.answer_locus([{"а"}], set(), 0.8) is None


# --------------------------------------------------------------------------- #
# Смещения строк
# --------------------------------------------------------------------------- #


def test_line_offsets_match_slicing() -> None:
    text = "первая\nвторая строка\n\nчетвёртая"
    offsets = aw.line_offsets(text)
    assert len(offsets) == 4
    assert [text[a:b] for a, b in offsets] == text.split("\n")


def test_line_offsets_locus_span_round_trip() -> None:
    """Диапазон локуса, собранный из смещений, обязан быть точной подстрокой."""
    text = "шум\nответ здесь\nи тут\nхвост"
    offsets = aw.line_offsets(text)
    locus = aw.answer_locus(
        [set(line.split()) for line in text.split("\n")], {"ответ", "тут"}, 1.0
    )
    assert locus == (1, 2)
    span = text[offsets[locus[0]][0] : offsets[locus[1]][1]]
    assert span == "ответ здесь\nи тут"
    assert span in text


# --------------------------------------------------------------------------- #
# Агрегаты
# --------------------------------------------------------------------------- #


def _row(**kwargs: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": "q",
        "origin": "customer",
        "category": "definition",
        "judgeable": True,
        "section_chars": 100,
        "cap": 4000,
        "mode": "centred",
        "containment": 1.0,
        "chars": 100,
        "locus_inside": True,
        "truncated": False,
    }
    base.update(kwargs)
    return base


def test_summarize_counts_only_judgeable_in_the_rate() -> None:
    """Вопрос, у которого достижимых термов слишком мало, в долю не входит,
    но в цену (символы) — входит: блок-то доехал."""
    rows = [
        _row(containment=1.0, chars=100),
        _row(containment=0.0, chars=300, judgeable=False),
    ]
    stats = aw.summarize(rows, 0.8)
    assert stats["questions"] == 2
    assert stats["judged"] == 1
    assert stats["too_few_terms"] == 1
    assert stats["contained"] == 1.0
    assert stats["chars_mean"] == 200.0


def test_summarize_threshold_is_inclusive() -> None:
    rows = [_row(containment=0.8), _row(containment=0.79)]
    assert aw.summarize(rows, 0.8)["contained"] == 0.5


def test_summarize_five_block_cost() -> None:
    """Цена печатается и на пять блоков — потолок контекста чат-конвейера."""
    rows = [_row(chars=1000), _row(chars=2000)]
    assert aw.summarize(rows, 0.8)["chars_5_blocks"] == 1500 * aw.MAX_CONTEXT_BLOCKS


def test_summarize_empty() -> None:
    stats = aw.summarize([], 0.8)
    assert stats["questions"] == 0
    assert stats["contained"] is None
    assert stats["chars_5_blocks"] is None


def test_split_by_origin_keeps_sets_apart() -> None:
    rows = [
        _row(origin="customer", containment=0.0),
        _row(origin="generated", containment=1.0),
        _row(origin="generated", containment=1.0),
    ]
    split = aw.split_by(rows, "origin", 0.8)
    assert split["customer"]["contained"] == 0.0
    assert split["generated"]["contained"] == 1.0
    assert split["generated"]["judged"] == 2


def test_threshold_sensitivity_is_monotone_non_increasing() -> None:
    rows = [_row(containment=c) for c in (0.45, 0.65, 0.85, 1.0)]
    grid = aw.threshold_sensitivity(rows)
    values = [grid[f"{t:.1f}"] for t in aw.THRESHOLD_GRID]
    assert values == sorted(values, reverse=True)
    assert grid["0.5"] == 0.75
    assert grid["1.0"] == 0.25


# --------------------------------------------------------------------------- #
# Разрез центрирования и тихий фолбэк якоря
# --------------------------------------------------------------------------- #


def _pq(**kwargs: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": "q",
        "oversized": True,
        "judgeable": True,
        "content_kind": "text",
        "path": "a.md",
        "section_path": "A",
        "anchor_located": True,
        "anchor_to_locus_chars": 100,
        "locus_inside_prod": True,
        "locus_inside_prefix": False,
        "containment_prod": 1.0,
        "containment_prefix": 0.5,
    }
    base.update(kwargs)
    return base


def test_centring_counts_only_oversized() -> None:
    """На коротком разделе оба режима отдают один и тот же текст — такие вопросы
    разбавили бы эффект и в срез не входят."""
    per_query = [_pq(id="a"), _pq(id="b", oversized=False)]
    rows = [_row(id="a", containment=1.0), _row(id="b", containment=1.0)]
    result = aw.centring_analysis(per_query, rows, 0.8)
    assert result["oversized_judged"] == 1
    assert result["better_centred"] == 1


def test_centring_tallies_all_three_outcomes() -> None:
    per_query = [
        _pq(id="a", containment_prod=1.0, containment_prefix=0.5),
        _pq(id="b", containment_prod=0.4, containment_prefix=0.9),
        _pq(id="c", containment_prod=0.7, containment_prefix=0.7),
    ]
    rows = [_row(id=i) for i in ("a", "b", "c")]
    result = aw.centring_analysis(per_query, rows, 0.8)
    assert (result["better_centred"], result["better_prefix"], result["equal"]) == (1, 1, 1)


def test_centring_distance_when_outside_uses_only_misses() -> None:
    """Медиана «якорь → локус» для промахов считается по промахам, а не по всем."""
    per_query = [
        _pq(id="a", locus_inside_prod=True, anchor_to_locus_chars=10),
        _pq(id="b", locus_inside_prod=False, anchor_to_locus_chars=9000),
        _pq(id="c", locus_inside_prod=False, anchor_to_locus_chars=7000),
    ]
    rows = [_row(id=i) for i in ("a", "b", "c")]
    result = aw.centring_analysis(per_query, rows, 0.8)
    assert result["locus_outside_centred"] == 2
    assert result["anchor_to_locus_chars_median_when_outside"] == 8000.0
    assert result["anchor_to_locus_chars_median"] == 7000.0


def test_anchor_failures_are_split_by_content_kind() -> None:
    """Тихий фолбэк в префикс — то, ради чего разрез вообще заведён."""
    per_query = [
        _pq(id="a", anchor_located=False, content_kind="table_rows"),
        _pq(id="b", anchor_located=False, content_kind="table_rows"),
        _pq(id="c", anchor_located=False, content_kind="text", oversized=False),
        _pq(id="d", anchor_located=True),
    ]
    result = aw.anchor_failures(per_query)
    assert result["total"] == 3
    assert result["oversized"] == 2
    assert result["oversized_of"] == 3
    assert result["by_content_kind"] == {"table_rows": 2, "text": 1}
    assert [e["id"] for e in result["examples"]] == ["a", "b", "c"]


# --------------------------------------------------------------------------- #
# Загрузка разделов
# --------------------------------------------------------------------------- #


def test_load_sections_keys_on_the_composite_pair(tmp_path) -> None:
    """`parent_id` уникален только ВНУТРИ файла — ключ обязан быть составным,
    иначе раздел одной заметки подменял бы раздел другой."""
    path = tmp_path / "sections.jsonl"
    path.write_text(
        "\n".join(
            [
                '{"path": "a.md", "parent_id": "p1", "section_path": "A", "text": "тело A"}',
                '{"path": "b.md", "parent_id": "p1", "section_path": "B", "text": "тело B"}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    sections = aw.load_sections(path)
    assert len(sections) == 2
    assert sections[("a.md", "p1")].text == "тело A"
    assert sections[("b.md", "p1")].text == "тело B"
