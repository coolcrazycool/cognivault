"""Tests for the harness: SSE parsing, golden loading, report + diff rendering.

Everything here is offline: the SSE bodies are literals, the chat client is
driven through ``httpx.MockTransport``.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gen_golden import BackendError  # noqa: E402
from metrics import JUDGE_METRIC_NAMES  # noqa: E402

from run import (  # noqa: E402
    _bucket_numbers,
    APPROXIMATE_WARNING,
    CATEGORY_KEY,
    CONDENSE_NOT_CALLED,
    DEFAULT_UI_URL,
    FALSE_REFUSAL_KEY,
    FALSE_REFUSAL_RATE_KEY,
    GRANULARITY_WARNING,
    META_KEY,
    META_RATE_KEY,
    OUTCOME_KEY,
    REFUSAL_KEY,
    REPORT_DISCLAIMER,
    RETRIEVAL_KEY,
    UNCATEGORIZED,
    ChatClient,
    RagLogIndex,
    build_parser,
    build_report,
    category_of,
    category_sets,
    collect_chat,
    context_from_log,
    dispersion,
    false_refusal_rate,
    group_by_category,
    expected_outcome,
    is_refusal,
    load_golden,
    meta_answered_rate,
    paired_delta,
    parse_sse,
    rebuild_contexts,
    render_compare_md,
    render_report_md,
    retrieval_hit,
    retrieval_hit_rate,
    slice_section,
    split_context_blocks,
)

SSE_BODY = (
    'event: meta\ndata: {"chat_id": "20260731-1"}\n\n'
    'event: sources\ndata: {"sources": [{"n": 1, "title": "Док", '
    '"path": "docs/a.md", "section_path": "Раздел", "score": 0.71, '
    '"depth": "section"}], "context_chars": 120}\n\n'
    'event: token\ndata: {"text": "Пер"}\n\n'
    'event: token\ndata: {"text": "вый ответ."}\n\n'
    'event: done\ndata: {"chat_id": "20260731-1", "finish_reason": "stop"}\n\n'
)


# --------------------------------------------------------------------------- #
# SSE
# --------------------------------------------------------------------------- #


def test_parse_sse_yields_events_in_order():
    events = parse_sse(SSE_BODY)
    assert [name for name, _ in events] == [
        "meta",
        "sources",
        "token",
        "token",
        "done",
    ]


def test_collect_chat_assembles_answer_and_sources():
    outcome = collect_chat(parse_sse(SSE_BODY))
    assert outcome.answer == "Первый ответ."
    assert outcome.chat_id == "20260731-1"
    assert outcome.finish_reason == "stop"
    assert outcome.sources[0]["path"] == "docs/a.md"
    assert outcome.error == ""


def test_collect_chat_tolerates_extra_source_fields():
    body = (
        'event: sources\ndata: {"sources": [{"n": 1, "path": "a.md", '
        '"grade": 5, "url": "https://conf/x", "unknown": 1}]}\n\n'
        'event: token\ndata: {"text": "ok"}\n\n'
    )
    outcome = collect_chat(parse_sse(body))
    assert outcome.sources[0]["grade"] == 5
    assert outcome.sources[0]["url"] == "https://conf/x"


def test_collect_chat_records_notice_and_error():
    body = (
        'event: meta\ndata: {"chat_id": "x"}\n\n'
        'event: notice\ndata: {"message": "источников не найдено"}\n\n'
        'event: error\ndata: {"code": "GIGACHAT_TLS", "message": "нет TLS"}\n\n'
    )
    outcome = collect_chat(parse_sse(body))
    assert outcome.notice == "источников не найдено"
    assert outcome.error == "GIGACHAT_TLS: нет TLS"


def test_parse_sse_tolerates_unterminated_and_malformed_frames():
    body = 'event: token\ndata: не json\n\nevent: done\ndata: {"finish_reason": "stop"}'
    events = parse_sse(body)
    assert events[0][1]["raw"] == "не json"
    assert events[1][1]["finish_reason"] == "stop"


def test_chat_client_posts_rag_body_and_streams():
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["auth"] = request.headers.get("Authorization")
        seen["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(200, text=SSE_BODY)

    async def go():
        async with ChatClient(
            "http://ui.example", "tkn", transport=httpx.MockTransport(handler)
        ) as client:
            return await client.ask("Как работает индексация?")

    outcome = asyncio.run(go())
    assert seen["path"] == "/api/chat"
    assert seen["auth"] == "Bearer tkn"
    assert seen["body"]["rag"] is True
    assert seen["body"]["messages"][0]["content"] == "Как работает индексация?"
    assert outcome.answer == "Первый ответ."


def test_chat_client_surfaces_http_error():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"code": "BAD", "message": "нет"}})

    async def go():
        async with ChatClient(
            "http://ui.example", transport=httpx.MockTransport(handler)
        ) as client:
            return await client.ask("вопрос?")

    outcome = asyncio.run(go())
    assert outcome.error.startswith("HTTP 400")


# --------------------------------------------------------------------------- #
# Golden set + retrieval bookkeeping
# --------------------------------------------------------------------------- #


def _write_golden(tmp_path, rows) -> str:
    path = tmp_path / "golden.jsonl"
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )
    return str(path)


def test_load_golden_skips_rejected_but_keeps_null(tmp_path):
    path = _write_golden(
        tmp_path,
        [
            {"id": "a", "question": "q1", "accepted": None},
            {"id": "b", "question": "q2", "accepted": True},
            {"id": "c", "question": "q3", "accepted": False},
        ],
    )
    assert [r["id"] for r in load_golden(path)] == ["a", "b"]
    assert [r["id"] for r in load_golden(path, include_rejected=True)] == ["a", "b", "c"]


def test_retrieval_hit_rate():
    samples = [
        {RETRIEVAL_KEY: True},
        {RETRIEVAL_KEY: False},
        {RETRIEVAL_KEY: None},
    ]
    assert retrieval_hit_rate(samples) == 0.5
    assert retrieval_hit_rate([{RETRIEVAL_KEY: None}]) is None


def test_retrieval_hit_rate_ignores_failed_samples():
    """Упавший сэмпл — не промах ретрива: его «нет попадания» ничего не значит."""
    samples = [
        {RETRIEVAL_KEY: True},
        {RETRIEVAL_KEY: False, "failed": True, "error": "HTTP 500"},
    ]
    assert retrieval_hit_rate(samples) == 1.0


# --------------------------------------------------------------------------- #
# retrieval_hit по паре (path, chunk_index)
# --------------------------------------------------------------------------- #


def test_hit_is_counted_per_chunk_not_per_file():
    """Тот же файл, другой чанк — это ПРОМАХ, а не попадание."""
    row = {"source_path": "docs/a.md", "source_chunk_index": 3}
    sources = [{"path": "docs/a.md", "depth": "section", "chunk_indexes": [0, 1]}]
    assert retrieval_hit(row, sources) == (False, "chunk")

    sources = [{"path": "docs/a.md", "depth": "section", "chunk_indexes": [1, 3]}]
    assert retrieval_hit(row, sources) == (True, "chunk")


def test_whole_file_block_covers_any_chunk_of_that_file():
    row = {"source_path": "docs/a.md", "source_chunk_index": 9}
    sources = [{"path": "docs/a.md", "depth": "file", "chunk_indexes": [0]}]
    assert retrieval_hit(row, sources) == (True, "chunk")


def test_hit_falls_back_to_scalar_chunk_index():
    row = {"source_path": "a.md", "source_chunk_index": 2}
    assert retrieval_hit(row, [{"path": "a.md", "chunk_index": 2}]) == (True, "chunk")
    assert retrieval_hit(row, [{"path": "a.md", "chunk_index": 5}]) == (False, "chunk")


def test_hit_degrades_to_section_then_file_and_says_so():
    """Без чанка в golden-паре точность падает — и отчёт это фиксирует."""
    row = {"source_path": "a.md", "section_path": "Док > Раздел"}
    assert retrieval_hit(row, [{"path": "a.md", "section_path": "Док > Раздел"}]) == (
        True,
        "section",
    )
    assert retrieval_hit(row, [{"path": "a.md", "section_path": "Док > Другой"}]) == (
        False,
        "section",
    )
    bare = {"source_path": "a.md"}
    assert retrieval_hit(bare, [{"path": "a.md"}]) == (True, "file")
    assert retrieval_hit(bare, [{"path": "b.md"}]) == (False, "file")
    assert retrieval_hit({}, [{"path": "a.md"}]) == (None, "none")


# --------------------------------------------------------------------------- #
# alt_source_paths: страницы-соседи, которые тоже отвечают на вопрос
# --------------------------------------------------------------------------- #


def test_alt_source_path_counts_as_hit_at_file_granularity():
    """Чанк альтернативной страницы — попадание, а не промах."""
    row = {"source_path": "a.md", "alt_source_paths": ["b.md"]}
    assert retrieval_hit(row, [{"path": "b.md"}]) == (True, "file")
    assert retrieval_hit(row, [{"path": "c.md"}]) == (False, "file")
    # каноническая страница по-прежнему засчитывается сама по себе
    assert retrieval_hit(row, [{"path": "a.md"}]) == (True, "file")


def test_alt_source_path_counts_as_hit_at_section_granularity():
    """Раздел размечен относительно source_path — к альтернативе он неприменим,
    поэтому любой чанк альтернативной страницы засчитывается целиком."""
    row = {
        "source_path": "a.md",
        "section_path": "Док > Раздел",
        "alt_source_paths": ["b.md"],
    }
    # альтернатива без канонической страницы в выдаче
    assert retrieval_hit(row, [{"path": "b.md", "section_path": "Другой док"}]) == (
        True,
        "section",
    )
    # каноническая страница попала НЕ ТЕМ разделом, но альтернатива есть
    sources = [
        {"path": "a.md", "section_path": "Док > Другой"},
        {"path": "b.md", "section_path": "Что угодно"},
    ]
    assert retrieval_hit(row, sources) == (True, "section")
    # ни правильного раздела, ни альтернативы — промах, как и раньше
    assert retrieval_hit(row, [{"path": "a.md", "section_path": "Док > Другой"}]) == (
        False,
        "section",
    )


def test_alt_source_path_counts_as_hit_at_chunk_granularity():
    row = {
        "source_path": "a.md",
        "source_chunk_index": 3,
        "alt_source_paths": ["b.md"],
    }
    sources = [
        {"path": "a.md", "depth": "section", "chunk_indexes": [0, 1]},
        {"path": "b.md", "depth": "section", "chunk_indexes": [7]},
    ]
    assert retrieval_hit(row, sources) == (True, "chunk")
    assert retrieval_hit(
        row, [{"path": "a.md", "depth": "section", "chunk_indexes": [0]}]
    ) == (False, "chunk")


def test_alt_source_paths_absent_empty_or_malformed_change_nothing():
    """Строки без поля (старый набор) и с битой разметкой работают как раньше."""
    assert retrieval_hit({"source_path": "a.md"}, [{"path": "b.md"}]) == (False, "file")
    row_empty = {"source_path": "a.md", "alt_source_paths": []}
    assert retrieval_hit(row_empty, [{"path": "b.md"}]) == (False, "file")
    row_bad = {"source_path": "a.md", "alt_source_paths": "b.md"}
    assert retrieval_hit(row_bad, [{"path": "b.md"}]) == (False, "file")
    row_junk = {"source_path": "a.md", "alt_source_paths": [None, 42, "  "]}
    assert retrieval_hit(row_junk, [{"path": "b.md"}]) == (False, "file")
    # ловушка без source_path не начинает мериться из-за одних альтернатив
    trap = {"source_path": None, "alt_source_paths": ["b.md"]}
    assert retrieval_hit(trap, [{"path": "b.md"}]) == (None, "none")


# --------------------------------------------------------------------------- #
# Ветка отказа
# --------------------------------------------------------------------------- #


def test_is_refusal_recognises_the_prompt_wording_and_no_context():
    assert is_refusal("В доступных мне документах ответа на этот вопрос не нашлось.")
    assert is_refusal("В базе знаний нет данных по этому вопросу.")
    assert is_refusal("", finish_reason="no_context")
    assert not is_refusal("Порог грейдера задаётся ключом RAG_GRADER_THRESHOLD.")


def test_is_refusal_ignores_a_caveat_after_a_real_answer():
    """Пара x35 прогона `baseline`: ответ по существу с оговоркой о неполноте.

    Поиск отказа по всему тексту засчитывал такой ответ как полный отказ и
    завышал `false_refusal_rate` — на 36 отвечаемых парах это треть метрики.
    """
    answered = (
        "ID батчевого потока afpc_sss_inc_safp_rsa_mapping — 4832 [Источник 1].\n\n"
        "В источниках нет явного описания назначения потока, однако из его "
        "структуры следует, что он переносит данные из src- в inc-слой."
    )
    assert not is_refusal(answered)
    # А тот же оборот первой фразой — по-прежнему отказ (пара x22).
    refused = (
        "В доступных мне документах ответа на этот вопрос не нашлось. "
        "В структуре базы знаний указано, что страница «Data Quality» "
        "находится в разделе «Архив»."
    )
    assert is_refusal(refused)


def test_slice_section_extracts_named_section():
    content = "# Док\n\nвступление\n\n## Раздел\n\nтело раздела\n\n## Другой\n\nне то\n"
    sliced = slice_section(content, "Док > Раздел")
    assert "тело раздела" in sliced
    assert "не то" not in sliced


def test_slice_section_returns_none_when_absent():
    assert slice_section("# Док\n\nтекст", "Док > Нет такого") is None


# --------------------------------------------------------------------------- #
# Контекст из rag_log.jsonl (вместо восстановления из метаданных)
# --------------------------------------------------------------------------- #

LOG_CONTEXT = (
    "### Источник 1: Док — docs/a.md > Раздел\n"
    "тело первого фрагмента\n\n"
    "### Источник 2: Док Б — docs/b.md\n"
    "тело второго фрагмента\n"
)


def _log_record(**extra) -> dict:
    record = {
        "type": "request",
        "chat_id": "20260731-1",
        "context_text": LOG_CONTEXT,
        "context_chars": len(LOG_CONTEXT),
        "context_truncated_in_log": False,
        "sources": [
            {"n": 1, "path": "docs/a.md", "depth": "section", "chunk_indexes": [3]},
            {"n": 2, "path": "docs/b.md", "depth": "file", "chunk_indexes": [0, 1]},
        ],
        "settings": {"rag": {"grader_threshold": 4}},
        "timings_ms": {"search": 120.0},
    }
    record.update(extra)
    return record


def test_split_context_blocks_restores_individual_fragments():
    blocks = split_context_blocks(LOG_CONTEXT)
    assert len(blocks) == 2
    assert blocks[0].startswith("### Источник 1:")
    assert "тело первого фрагмента" in blocks[0]
    assert "тело второго" not in blocks[0]
    assert split_context_blocks("") == []
    assert split_context_blocks("без заголовков") == ["без заголовков"]


def test_context_from_log_is_what_the_model_actually_saw():
    resolved = context_from_log(_log_record())
    assert resolved.origin == "rag_log"
    assert resolved.approximate is False
    assert len(resolved.contexts) == 2
    assert "тело первого фрагмента" in resolved.contexts[0]
    # Метаданные из лога богаче SSE: у источников есть chunk_indexes.
    assert resolved.sources[0]["chunk_indexes"] == [3]
    assert resolved.error == ""


def test_context_from_log_declines_a_record_without_the_text():
    """Старый UI без `context_text` → пусть решает фолбэк."""
    record = _log_record()
    record.pop("context_text")
    assert context_from_log(record) is None


def test_rag_log_index_selects_request_records_by_chat_id():
    text = "\n".join(
        [
            json.dumps(_log_record(chat_id="c1"), ensure_ascii=False),
            json.dumps({"type": "feedback", "chat_id": "c1", "vote": "up"}),
            "{битая строка",
            json.dumps(_log_record(chat_id="c2"), ensure_ascii=False),
        ]
    )
    index = RagLogIndex.from_text(text)
    assert len(index) == 2
    assert index.get("c1")["type"] == "request"
    assert index.get("нет такого") is None
    assert index.get("") is None


def test_rag_log_index_rereads_the_file_when_a_turn_appears(tmp_path):
    """Запись хода появляется в логе уже во время прогона — индекс её подхватывает."""
    path = tmp_path / "rag_log.jsonl"
    path.write_text(json.dumps(_log_record(chat_id="c1")) + "\n", encoding="utf-8")

    index = RagLogIndex.load(str(path))
    assert index is not None and index.get("c2") is None

    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_log_record(chat_id="c2")) + "\n")
    os.utime(path, (time.time() + 1, time.time() + 1))

    assert index.get("c2") is not None


def test_rag_log_index_load_returns_none_when_absent(tmp_path):
    assert RagLogIndex.load(str(tmp_path / "нет.jsonl")) is None


def test_metadata_fallback_marks_itself_approximate_and_fails_on_backend_error():
    """Фолбэк: приближённый, а ошибка бэкенда — это failed, а не пустой контекст."""

    class _Backend:
        def __init__(self, bodies):
            self._bodies = bodies

        async def content(self, path):
            if path not in self._bodies:
                raise BackendError("нет файла", 404)
            return self._bodies[path]

    doc = "# Док\n\n## Раздел\n\nтело раздела\n"
    sources = [
        {"path": "docs/a.md", "section_path": "Док > Раздел"},
        {"path": "docs/missing.md", "section_path": ""},
    ]
    resolved = asyncio.run(
        rebuild_contexts(_Backend({"docs/a.md": doc}), sources, cache={})
    )

    assert resolved.origin == "metadata"
    assert resolved.approximate is True
    assert "тело раздела" in resolved.contexts[0]
    assert resolved.error.startswith("context:")
    assert "docs/missing.md" in resolved.error


class _StubJudge:
    """Судья-заглушка: возвращает единицы, но запоминает, что ему показали."""

    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def complete_json(self, prompt, *, system=None, temperature=None):
        self.prompts.append(prompt)
        return {"score": 5, "verdicts": [{"id": i, "verdict": 1} for i in range(1, 6)]}


def _chat_client(body: str) -> ChatClient:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=body)

    return ChatClient("http://ui", transport=httpx.MockTransport(handler))


def _run_one(row, *, rag_log, backend=None, body=None):
    from run import run_sample

    async def go():
        chat = _chat_client(body if body is not None else SSE_BODY)
        judge = _StubJudge()
        try:
            sample = await run_sample(
                row,
                chat=chat,
                judge=judge,
                backend=backend,
                cache={},
                context_cap=4000,
                rag_log=rag_log,
            )
        finally:
            await chat.aclose()
        return sample, judge

    return asyncio.run(go())


def test_run_sample_judges_the_logged_context_not_a_rebuilt_one():
    """Ключевая правка: контекст берётся из лога, бэкенд не дёргается вовсе."""

    class _ForbiddenBackend:
        async def content(self, path):  # pragma: no cover — must never be called
            raise AssertionError("бэкенд не должен вызываться при наличии лога")

    row = {
        "id": "s1",
        "question": "вопрос?",
        "ground_truth": "эталон.",
        "source_path": "docs/a.md",
        "source_chunk_index": 3,
    }
    index = RagLogIndex.from_text(json.dumps(_log_record(), ensure_ascii=False))
    sample, judge = _run_one(row, rag_log=index, backend=_ForbiddenBackend())

    assert sample["context_origin"] == "rag_log"
    assert sample["context_count"] == 2
    assert sample["failed"] is False
    # Судья увидел ровно тот текст, что и отвечающая модель.
    assert any("тело первого фрагмента" in p for p in judge.prompts)
    # Метаданные из лога дали чанк — hit посчитан по паре (path, chunk_index).
    assert sample[RETRIEVAL_KEY] is True
    assert sample["retrieval_granularity"] == "chunk"
    assert sample["run_settings"] == {"rag": {"grader_threshold": 4}}
    assert sample["timings_ms"] == {"search": 120.0}


def test_run_sample_falls_back_to_metadata_and_marks_it():
    doc = "# Док\n\n## Раздел\n\nтело раздела из бэкенда\n"

    class _Backend:
        async def content(self, path):
            return doc

    row = {"id": "s1", "question": "вопрос?", "ground_truth": "эталон."}
    sample, judge = _run_one(row, rag_log=None, backend=_Backend())

    assert sample["context_origin"] == "metadata"
    assert sample["failed"] is False
    assert any("тело раздела из бэкенда" in p for p in judge.prompts)


def test_run_sample_marks_a_chat_error_as_failed():
    body = 'event: error\ndata: {"code": "GIGACHAT_TLS", "message": "нет TLS"}\n\n'
    row = {"id": "s1", "question": "вопрос?", "ground_truth": "эталон."}
    sample, judge = _run_one(row, rag_log=None, body=body)

    assert sample["failed"] is True
    assert sample["error"].startswith("GIGACHAT_TLS")
    assert sample["metrics"] == {}
    assert judge.prompts == []  # судью на упавшем сэмпле не тревожим


def test_ui_url_default_matches_the_port_the_ui_listens_on():
    """UI слушает 8787 — дефолт 8080 отправлял прогон в пустоту."""
    assert DEFAULT_UI_URL == "http://localhost:8787"
    assert build_parser().get_default("ui_url") is None  # ENV имеет приоритет
    assert "8787" in build_parser().format_help()


# --------------------------------------------------------------------------- #
# Reports
# --------------------------------------------------------------------------- #


def _sample(ident: str, faith: float, **extra) -> dict:
    sample = {
        "id": ident,
        "kind": "factual",
        "question": "Что такое CogniVault?",
        RETRIEVAL_KEY: True,
        "retrieval_granularity": "chunk",
        "context_origin": "rag_log",
        "context_count": 1,
        "metrics": {
            "faithfulness_ru": {"score": faith},
            "answer_relevancy_ru": {"score": 0.5},
            "context_precision": {"score": 0.5},
            "context_recall": {"score": 0.5},
        },
    }
    sample.update(extra)
    return sample


def _report(label: str, faith: float, hit: float = 1.0, samples=None) -> dict:
    rows = samples if samples is not None else [_sample("s1", faith, **{RETRIEVAL_KEY: hit >= 0.5})]
    return build_report(
        rows,
        label=label,
        golden_path="golden.jsonl",
        ui_url="http://ui",
        judge_model="GigaChat-Test",
    )


def test_report_md_has_disclaimer_and_metric_rows():
    text = render_report_md(_report("baseline", 0.8, 1.0))
    assert REPORT_DISCLAIMER.split("**")[1] in text  # ключевая фраза дисклеймера
    assert "faithfulness_ru" in text
    assert "чинить генерацию" in text  # правило диагностики
    assert "| s1 |" in text
    assert "Параметры прогона" in text


def test_build_report_counts_failures():
    samples = [{"id": "a", "error": "HTTP 500", "metrics": {}}, {"id": "b", "metrics": {}}]
    report = build_report(
        samples,
        label="x",
        golden_path="g",
        ui_url="u",
        judge_model="m",
    )
    assert report["counts"] == {
        "total": 2,
        "failed": 1,
        "evaluated": 1,
        "context_clipped": 0,
    }


def _turn(ident: str, *, grades, grade_ms, condense_ms=0.0, **cfg) -> dict:
    """Пара с разметкой хода: оценки грейдера у источников + тайминги стадий."""
    rag_cfg = {
        "grader_enabled": True,
        "condense_enabled": True,
        "condense_first_turn": False,
        "grader_timeout": 20.0,
        "condense_timeout": 45.0,
    }
    rag_cfg.update(cfg)
    return _sample(
        ident,
        0.8,
        sources=[{"n": i + 1, "path": "a.md", "grade": g} for i, g in enumerate(grades)],
        timings_ms={"condense": condense_ms, "search": 1100.0, "grade": grade_ms},
        run_settings={"rag": rag_cfg},
    )


def test_a_grader_that_never_graded_is_not_a_grader():
    """Прогон `baseline`: оценки появились у 2 пар из 47, и отчёт молчал.

    Провалившийся батч отдаёт все `None`, отбор пропускает кандидатов сырым
    порядком поиска — измерен пайплайн БЕЗ реранкера, а «грейдер: включён» в
    параметрах утверждает обратное.
    """
    report = _report(
        "x",
        0.8,
        samples=[
            _turn("dead", grades=[None, None, None], grade_ms=20017.5),
            _turn("alive", grades=[5, 4], grade_ms=11368.0),
            _turn("partial", grades=[5, None], grade_ms=20015.5),
        ],
    )

    assert report["grader_health"] == {
        "enabled": True,
        "applicable": 3,
        "graded": 2,
        "ungraded": 1,
        "partial": 1,
    }
    text = render_report_md(report)
    assert "Грейдер молча не отработал" in text
    assert "грейдер вернул оценки на 2 парах из 3" in text


def test_time_equal_to_the_leash_is_reported_as_a_timeout():
    """41 ход из 46 с `grade` в 20003–20023 мс при поводке 20 с — это таймаут.

    Разброс в 20 мс на вызове модели невозможен, но по одной медиане это не
    видно: нужен сам поводок рядом, поэтому он и попал в снимок настроек.
    """
    report = _report(
        "x",
        0.8,
        samples=[
            _turn("a", grades=[None], grade_ms=20003.2),
            _turn("b", grades=[None], grade_ms=20023.2),
            _turn("c", grades=[5], grade_ms=11368.0),
        ],
    )

    grade = report["stage_timings"]["grade"]
    assert grade["deadline_ms"] == 20000.0
    assert grade["at_deadline"] == 2
    assert grade["n"] == 3
    text = render_report_md(report)
    assert "## Скрытые вызовы" in text
    assert "упёрлось в поводок" in text


def test_condense_is_not_called_when_every_question_is_a_first_turn():
    """Харнесс задаёт каждый вопрос в новом чате — condense не запускается.

    Формально `condense_enabled: true`, фактически из двух скрытых вызовов на
    ход меряется один. «да» в параметрах было верно и вводило в заблуждение.
    """
    report = _report("x", 0.8, samples=[_turn("a", grades=[5], grade_ms=900.0)])
    assert CONDENSE_NOT_CALLED in render_report_md(report)

    ran = _report(
        "x", 0.8, samples=[_turn("a", grades=[5], grade_ms=900.0, condense_ms=410.0)]
    )
    assert CONDENSE_NOT_CALLED not in render_report_md(ran)


def test_condense_state_stays_honest_without_stage_marks():
    """Прогон без `rag_log`: стадий нет, значит и утверждать нечего."""
    plain = _report("x", 0.8, samples=[_sample("a", 0.8)])
    assert CONDENSE_NOT_CALLED not in render_report_md(plain)


def test_judge_failures_are_counted_and_shouted_about():
    """Прогон `baseline` печатал «ошибок 0», потеряв 95 вызовов судьи из 188.

    Упавший вызов судьи — не упавший сэмпл: сэмпл цел, а метрики у него нет.
    Пока это число не в шапке, `n=15` при 36 парах читается как свойство
    набора, а не как сбой контура.
    """
    dead = {
        "score": None,
        "error": "GigaChatHTTPError: GigaChat вернул HTTP 429",
        "failed": True,
    }
    lost = _sample(
        "lost", 0.0, metrics={name: dict(dead) for name in JUDGE_METRIC_NAMES}
    )
    report = _report("x", 0.0, samples=[_sample("ok", 0.9), lost])

    health = report["judge_failures"]
    assert health["expected"] == 8
    assert health["failed"] == 4
    assert health["samples_affected"] == 1
    assert health["by_error"] == {"GigaChatHTTPError: GigaChat вернул HTTP 429": 4}

    text = render_report_md(report)
    assert "судейских вызовов не вернулось: **4** из 8" in text
    assert "HTTP 429" in text


def test_structural_metric_skips_are_not_judge_failures():
    """«Пустой ground_truth» — вызова не было; списывать это на судью нельзя."""
    skipped = _sample(
        "skip",
        0.0,
        metrics={
            "faithfulness_ru": {"score": 0.5},
            "answer_relevancy_ru": {"score": 0.5},
            "context_precision": {"score": 0.5},
            "context_recall": {"score": None, "error": "пустой ground_truth"},
            # Судья тут не участвует вообще — в знаменатель не попадает.
            "item_recall": {"score": None, "error": "в вопросе нет expected_items"},
        },
    )
    report = _report("x", 0.0, samples=[skipped])
    assert report["judge_failures"] == {
        "expected": 4,
        "failed": 0,
        "samples_affected": 0,
        "by_error": {},
    }
    assert "судейских вызовов не вернулось: **0** из 4" in render_report_md(report)


def test_failed_samples_stay_out_of_every_average():
    """Нули упавшего сэмпла раньше уезжали в среднее и читались как регрессия."""
    good = _sample("ok", 0.9)
    broken = _sample(
        "broken",
        0.0,
        failed=True,
        error="context: docs/a.md: пустой ответ бэкенда",
        metrics={
            name: {"score": 0.0}
            for name in (
                "faithfulness_ru",
                "answer_relevancy_ru",
                "context_precision",
                "context_recall",
            )
        },
        **{RETRIEVAL_KEY: False},
    )
    report = _report("x", 0.0, samples=[good, broken])

    assert report["counts"] == {
        "total": 2,
        "failed": 1,
        "evaluated": 1,
        "context_clipped": 0,
    }
    assert report["aggregate"]["faithfulness_ru"] == 0.9  # не 0.45
    assert report["coverage"]["faithfulness_ru"] == 1
    assert report["dispersion"]["faithfulness_ru"]["n"] == 1
    assert report["aggregate"][RETRIEVAL_KEY] == 1.0

    text = render_report_md(report)
    assert "упало и исключено из средних: 1" in text
    assert "Упавшие пары (1)" in text
    assert "пустой ответ бэкенда" in text


def test_report_marks_approximate_runs():
    ok = _report("clean", 0.8)
    assert ok["approximate"] is False
    assert APPROXIMATE_WARNING.split("**")[1] not in render_report_md(ok)

    fallback = _report(
        "fallback", 0.8, samples=[_sample("s1", 0.8, context_origin="metadata")]
    )
    assert fallback["approximate"] is True
    assert "ПРИБЛИЖЁННЫЙ ПРОГОН" in render_report_md(fallback)


def test_report_shouts_when_retrieval_hit_is_measured_below_chunk_level():
    """Огрубление до раздела/файла обязано быть видно, а не молча завышать hit."""
    rows = [
        _sample("s1", 0.8, retrieval_granularity="section"),
        _sample("s2", 0.8, retrieval_granularity="file"),
        _sample("s3", 0.8, retrieval_granularity="chunk"),
    ]
    report = _report("degraded", 0.8, samples=rows)

    assert report["retrieval_degradation"] == {
        "degraded": 2,
        "measured": 3,
        "levels": {"section": 1, "file": 1, "chunk": 1},
    }
    text = render_report_md(report)
    assert GRANULARITY_WARNING.split("**")[1].split(":")[0] in text
    assert "2 из 3" in text
    # …и таблица средних честно подписывает, чем мерилась доля.
    assert "гранулярность — chunk: 1, file: 1, section: 1" in text


def test_report_stays_quiet_when_every_pair_is_measured_by_chunk():
    report = _report("clean", 0.8, samples=[_sample("s1", 0.8)])
    assert report["retrieval_degradation"]["degraded"] == 0
    assert "измерен НЕ на уровне чанка" not in render_report_md(report)


def test_compare_warns_when_runs_used_different_granularity():
    chunky = _report("a", 0.8, samples=[_sample("s1", 0.8)])
    sectiony = _report(
        "b", 0.8, samples=[_sample("s1", 0.8, retrieval_granularity="section")]
    )
    text = render_compare_md(chunky, sectiony)
    assert "измерен с разной" in text
    # Одинаковая гранулярность — предупреждения нет.
    assert "измерен с разной" not in render_compare_md(chunky, chunky)


def test_report_records_refusal_branch():
    rows = [
        _sample("r1", 0.8, expected_refusal=True, **{REFUSAL_KEY: True}),
        _sample("r2", 0.8, expected_refusal=True, **{REFUSAL_KEY: False}),
        _sample("q1", 0.8),
    ]
    report = _report("x", 0.8, samples=rows)
    assert report["aggregate"][REFUSAL_KEY] == 0.5
    assert REFUSAL_KEY in render_report_md(report)


def test_dispersion_reports_sd_and_n():
    rows = [_sample("a", 0.2), _sample("b", 0.8), _sample("c", 0.5)]
    spread = dispersion(rows)["faithfulness_ru"]
    assert spread["n"] == 3
    assert spread["mean"] == 0.5
    assert spread["sd"] == 0.3
    assert spread["stderr"] == round(0.3 / (3**0.5), 4)


# --------------------------------------------------------------------------- #
# Diff-таблица: парное сравнение, разброс, число пар
# --------------------------------------------------------------------------- #


def test_paired_delta_uses_common_questions_only():
    """Состав оценённых пар не должен подмешиваться в дельту."""
    report_a = _report("a", 0.0, samples=[_sample("s1", 0.5), _sample("s2", 0.9)])
    report_b = _report("b", 0.0, samples=[_sample("s1", 0.7), _sample("s3", 0.1)])

    pair = paired_delta(report_a, report_b, "faithfulness_ru")
    assert pair["n"] == 1  # общий только s1
    assert pair["delta"] == 0.2


def test_paired_delta_excludes_failed_samples():
    report_a = _report("a", 0.0, samples=[_sample("s1", 0.5), _sample("s2", 0.5)])
    report_b = _report(
        "b",
        0.0,
        samples=[_sample("s1", 0.9), _sample("s2", 0.0, failed=True, error="HTTP 500")],
    )
    pair = paired_delta(report_a, report_b, "faithfulness_ru")
    assert pair["n"] == 1 and pair["delta"] == 0.4


def test_compare_table_signs_and_deltas():
    text = render_compare_md(_report("baseline", 0.60, 1.0), _report("wave-3", 0.80, 1.0))
    assert "`baseline` → `wave-3`" in text
    assert "+0.200" in text
    assert "▲" in text
    # unchanged metrics land in the noise band
    assert "≈" in text


def test_compare_table_shows_spread_and_pair_count():
    rows_a = [_sample(f"s{i}", 0.5) for i in range(4)]
    rows_b = [_sample(f"s{i}", 0.6) for i in range(4)]
    text = render_compare_md(_report("a", 0.0, samples=rows_a), _report("b", 0.0, samples=rows_b))

    assert "Δ (парная) | ±sd | пар |" in text
    assert "(n=4)" in text  # разброс по сэмплам в каждом прогоне
    assert "| 4 |" in text  # число ПАР в дельте
    assert "число вопросов, оценённых В ОБОИХ прогонах" in text


def test_compare_calls_a_noisy_delta_noise():
    """Большой сдвиг при огромном разбросе на трёх парах — ещё не сигнал."""
    rows_a = [_sample("s1", 0.0), _sample("s2", 1.0), _sample("s3", 0.0)]
    rows_b = [_sample("s1", 1.0), _sample("s2", 0.0), _sample("s3", 1.0)]
    text = render_compare_md(_report("a", 0.0, samples=rows_a), _report("b", 0.0, samples=rows_b))

    faith = [line for line in text.splitlines() if line.startswith("| faithfulness_ru")][0]
    assert faith.endswith("≈ |")


def test_compare_table_marks_regression():
    rows_a = [_sample(f"s{i}", 0.90) for i in range(6)]
    rows_b = [_sample(f"s{i}", 0.50) for i in range(6)]
    text = render_compare_md(_report("a", 0.0, samples=rows_a), _report("b", 0.0, samples=rows_b))
    assert "-0.400" in text
    assert "▼" in text


def test_compare_warns_on_prompt_version_mismatch():
    report_a = _report("a", 0.5, 1.0)
    report_b = _report("b", 0.5, 1.0)
    report_b["prompt_version"] = "v2"
    assert "разными версиями судейских промптов" in render_compare_md(report_a, report_b)


def test_compare_warns_when_run_parameters_differ():
    report_a = _report(
        "a", 0.5, samples=[_sample("s1", 0.5, run_settings={"rag": {"grader_threshold": 4}})]
    )
    report_b = _report(
        "b", 0.5, samples=[_sample("s1", 0.5, run_settings={"rag": {"grader_threshold": 3}})]
    )
    text = render_compare_md(report_a, report_b)
    assert "различаются параметры прогонов" in text
    assert "грейдер: порог" in text


def test_compare_handles_missing_metric():
    report_a = _report("a", 0.5, 1.0)
    report_b = _report("b", 0.5, 1.0)
    report_b["dispersion"]["faithfulness_ru"] = {"mean": None, "sd": None, "n": 0}
    for sample in report_b["samples"]:
        sample["metrics"]["faithfulness_ru"] = {"score": None}
    text = render_compare_md(report_a, report_b)
    assert "| faithfulness_ru | 0.500 ±0.000 (n=1) | — | — | — | 0 | — |" in text


# --------------------------------------------------------------------------- #
# Воспроизводимость: параметры прогона попадают в отчёт
# --------------------------------------------------------------------------- #


def test_run_params_come_from_the_log_snapshot():
    settings = {
        "rag": {
            "mode": "auto",
            "rerank_candidates": 40,
            "grader_threshold": 4,
            "grader_enabled": True,
            "condense_enabled": True,
            "max_context_chars": 24000,
        },
        "gigachat": {"model": "GigaChat-3-Ultra", "temperature": 0.2, "max_tokens": 4096},
        "prompts": {"system": None, "context_reminder": "ab12cd34"},
    }
    report = build_report(
        [_sample("s1", 0.8, run_settings=settings)],
        label="x",
        golden_path="g",
        ui_url="u",
        judge_model="GigaChat-Judge",
        judge_temperature=0.0,
    )

    params = report["run_params"]
    assert params["judge_model"] == "GigaChat-Judge"
    assert params["judge_temperature"] == 0.0
    assert params["judge_prompt_version"]
    assert params["golden_prompt_version"] == "v2"
    assert params["ui_settings"] == settings

    text = render_report_md(report)
    for expected in ("GigaChat-3-Ultra", "`40`", "`4`", "`24000`", "ab12cd34"):
        assert expected in text


def test_run_params_flag_a_mixed_run():
    rows = [
        _sample("s1", 0.8, run_settings={"rag": {"grader_threshold": 4}}),
        _sample("s2", 0.8, run_settings={"rag": {"grader_threshold": 3}}),
    ]
    report = _report("x", 0.8, samples=rows)
    assert report["run_params"]["ui_settings"] == "(смешанные)"


# --------------------------------------------------------------------------- #
# Категория вопроса: сквозное поле golden-set → сэмпл → разрез отчёта
# --------------------------------------------------------------------------- #

REFUSAL_SSE = (
    'event: meta\ndata: {"chat_id": "20260731-9"}\n\n'
    'event: token\ndata: {"text": "В доступных мне документах ответа на этот '
    'вопрос не нашлось."}\n\n'
    'event: done\ndata: {"finish_reason": "stop"}\n\n'
)


def test_category_of_defaults_absent_and_blank_to_one_bucket():
    """Старый golden-set поля не знает — такие пары обязаны продолжать работать."""
    assert category_of({CATEGORY_KEY: "процессы"}) == "процессы"
    assert category_of({CATEGORY_KEY: "  отпуска  "}) == "отпуска"
    assert category_of({}) == UNCATEGORIZED
    assert category_of({CATEGORY_KEY: None}) == UNCATEGORIZED
    assert category_of({CATEGORY_KEY: "   "}) == UNCATEGORIZED


def test_run_sample_carries_the_category_into_the_report_row():
    row = {
        "id": "s1",
        "question": "вопрос?",
        "ground_truth": "эталон.",
        CATEGORY_KEY: "регламенты",
    }
    sample, _judge = _run_one(row, rag_log=None)
    assert sample[CATEGORY_KEY] == "регламенты"

    row.pop(CATEGORY_KEY)
    sample, _judge = _run_one(row, rag_log=None)
    assert sample[CATEGORY_KEY] == UNCATEGORIZED


def test_group_by_category_splits_metrics_and_counts_failures():
    rows = [
        _sample("a1", 0.8, category="процессы"),
        _sample("a2", 0.4, category="процессы"),
        _sample("b1", 0.0, category="регламенты", failed=True, error="HTTP 500"),
        _sample("c1", 0.6),  # без категории
    ]
    groups = group_by_category(rows)

    assert sorted(groups) == [UNCATEGORIZED, "процессы", "регламенты"]
    assert groups["процессы"]["n"] == 2
    assert groups["процессы"]["n_failed"] == 0
    assert groups["процессы"]["faithfulness_ru"] == 0.6
    # Упавшая пара считается в n, но её нули в среднее не идут.
    assert groups["регламенты"] == {
        "n": 1,
        "n_failed": 1,
        "faithfulness_ru": None,
        "answer_relevancy_ru": None,
        "context_precision": None,
        "context_recall": None,
        "item_recall": None,
        RETRIEVAL_KEY: None,
        REFUSAL_KEY: None,
        FALSE_REFUSAL_RATE_KEY: None,
        META_RATE_KEY: None,
    }
    assert groups[UNCATEGORIZED]["faithfulness_ru"] == 0.6


def test_report_skips_the_category_table_when_nobody_set_a_category():
    """Golden-set без категорий: одна строка `unclassified` дублировала бы средние."""
    report = _report("x", 0.0, samples=[_sample("s1", 0.8), _sample("s2", 0.4)])
    assert set(report["by_category"]) == {UNCATEGORIZED}  # в JSON разрез есть
    assert "## По категориям" not in render_report_md(report)  # в markdown — шума нет
    assert "## По категориям" not in render_compare_md(report, report)


def test_report_renders_a_category_table_sorted_by_name():
    rows = [
        _sample("a1", 0.8, category="процессы"),
        _sample("b1", 0.4, category="алгоритмы"),
    ]
    report = _report("x", 0.0, samples=rows)
    assert set(report["by_category"]) == {"процессы", "алгоритмы"}

    text = render_report_md(report)
    body = text.split("## По категориям", 1)[1]
    assert body.index("| алгоритмы |") < body.index("| процессы |")
    # …и разрез стоит ПОСЛЕ общих средних, но ДО таблицы по парам.
    assert text.index("## Средние значения") < text.index("## По категориям")
    assert text.index("## По категориям") < text.index("## По парам")


# --------------------------------------------------------------------------- #
# Пары-ловушки не портят судейские средние
# --------------------------------------------------------------------------- #


def test_refusal_rows_leave_the_judge_averages_and_get_their_own_bucket():
    """Правильный отказ получал 0 за answer_relevancy и ронял общее среднее."""
    rows = [
        _sample("q1", 0.8),
        _sample("t1", 0.0, expected_refusal=True, **{REFUSAL_KEY: True}),
        _sample("t2", 0.0, expected_refusal=True, **{REFUSAL_KEY: True}),
    ]
    report = _report("x", 0.0, samples=rows)

    assert report["aggregate"]["faithfulness_ru"] == 0.8  # не 0.267
    assert report["aggregate_refusal"]["faithfulness_ru"] == 0.0  # но и не потеряны
    assert report["buckets"] == {"answerable": 1, "refusal": 2, "meta": 0}
    assert report["coverage"]["faithfulness_ru"] == 1
    assert report["coverage_refusal"]["faithfulness_ru"] == 2
    assert report["dispersion"]["faithfulness_ru"]["n"] == 1
    # Ветка отказа считается по-прежнему.
    assert report["aggregate"][REFUSAL_KEY] == 1.0


def test_report_md_states_the_size_of_both_buckets():
    """39 вопросов против 30 не должны сравниваться незаметно."""
    rows = [
        _sample("q1", 0.8),
        _sample("t1", 0.0, expected_refusal=True, **{REFUSAL_KEY: True}),
    ]
    text = render_report_md(_report("x", 0.0, samples=rows))
    assert (
        "отвечаемых пар: 1, пар-ловушек `expected_refusal`: 1, "
        "метапар `expected_outcome: meta`: 0" in text
    )
    assert "ТОЛЬКО по отвечаемым парам (n=1)" in text
    assert "(n=2) вынесены" not in text  # n ловушек — своё число
    assert "Пары-ловушки `expected_refusal` (1)" in text


# --------------------------------------------------------------------------- #
# Ложный отказ: отвечаемый вопрос, на который ассистент зря не ответил
# --------------------------------------------------------------------------- #


def test_run_sample_marks_a_false_refusal_only_on_answerable_rows():
    answerable_row = {"id": "q1", "question": "вопрос?", "ground_truth": "эталон."}
    sample, _judge = _run_one(answerable_row, rag_log=None, body=REFUSAL_SSE)
    assert sample[REFUSAL_KEY] is True
    assert sample[FALSE_REFUSAL_KEY] is True

    trap = dict(answerable_row, expected_refusal=True)
    sample, _judge = _run_one(trap, rag_log=None, body=REFUSAL_SSE)
    assert sample[REFUSAL_KEY] is True
    assert sample[FALSE_REFUSAL_KEY] is None  # тут отказ и ожидался — мерить нечего

    sample, _judge = _run_one(answerable_row, rag_log=None, body=SSE_BODY)
    assert sample[FALSE_REFUSAL_KEY] is False


def test_false_refusal_rate_is_computed_over_answerable_rows_only():
    rows = [
        _sample("q1", 0.8, **{FALSE_REFUSAL_KEY: True}),
        _sample("q2", 0.8, **{FALSE_REFUSAL_KEY: False}),
        # Ловушки в знаменатель не входят, хотя отказ там и был.
        _sample(
            "t1",
            0.8,
            expected_refusal=True,
            **{REFUSAL_KEY: True, FALSE_REFUSAL_KEY: None},
        ),
        # Как и упавшие пары.
        _sample(
            "b1", 0.8, failed=True, error="HTTP 500", **{FALSE_REFUSAL_KEY: True}
        ),
    ]
    assert false_refusal_rate(rows) == 0.5
    assert false_refusal_rate([]) is None

    report = _report("x", 0.0, samples=rows)
    assert report["aggregate"][FALSE_REFUSAL_RATE_KEY] == 0.5
    text = render_report_md(report)
    assert "меньше — лучше" in text
    assert f"| {FALSE_REFUSAL_RATE_KEY} ↓" in text


def test_compare_treats_a_rising_false_refusal_rate_as_a_regression():
    """Рост доли ложных отказов — регрессия, даже что число «выросло»."""
    good = [_sample(f"s{i}", 0.5, **{FALSE_REFUSAL_KEY: False}) for i in range(4)]
    bad = [_sample(f"s{i}", 0.5, **{FALSE_REFUSAL_KEY: True}) for i in range(4)]
    text = render_compare_md(_report("a", 0.0, samples=good), _report("b", 0.0, samples=bad))

    row = [
        line for line in text.splitlines() if line.startswith(f"| {FALSE_REFUSAL_RATE_KEY}")
    ][0]
    assert "+1.000" in row
    assert row.endswith("▼ |")  # знак показывает КАЧЕСТВО, а не направление числа
    assert "меньше — лучше" in row

    # …и обратно: падение доли — улучшение.
    back = render_compare_md(_report("a", 0.0, samples=bad), _report("b", 0.0, samples=good))
    row = [
        line for line in back.splitlines() if line.startswith(f"| {FALSE_REFUSAL_RATE_KEY}")
    ][0]
    assert "-1.000" in row and row.endswith("▲ |")


# --------------------------------------------------------------------------- #
# Диф: разрез по категориям и совместимость со старыми отчётами
# --------------------------------------------------------------------------- #


def test_compare_lists_categories_present_in_only_one_run():
    """Разъехавшийся набор категорий — предупреждение, а не молчаливый пропуск."""
    report_a = _report(
        "a",
        0.0,
        samples=[_sample("s1", 0.5, category="процессы"), _sample("s2", 0.5, category="старая")],
    )
    report_b = _report(
        "b",
        0.0,
        samples=[_sample("s1", 0.9, category="процессы"), _sample("s3", 0.9, category="новая")],
    )
    assert category_sets(report_a, report_b) == {
        "common": ["процессы"],
        "only_a": ["старая"],
        "only_b": ["новая"],
    }

    text = render_compare_md(report_a, report_b)
    assert "| процессы | 1→1 | +0.400 ▲" in text
    assert "набор категорий между прогонами изменился" in text
    assert "`старая`" in text and "`новая`" in text


def test_compare_does_not_crash_on_a_report_from_the_old_harness():
    """Старый отчёт без by_category/aggregate_refusal/false_refusal_rate."""
    old = _report("old", 0.0, samples=[_sample("s1", 0.5), _sample("s2", 0.5)])
    for key in ("by_category", "aggregate_refusal", "buckets", "coverage_refusal"):
        old.pop(key)
    old["aggregate"].pop(FALSE_REFUSAL_RATE_KEY)
    for sample in old["samples"]:
        sample.pop(CATEGORY_KEY, None)
        sample.pop(FALSE_REFUSAL_KEY, None)
    new = _report("new", 0.0, samples=[_sample("s1", 0.9, category="процессы")])

    text = render_compare_md(old, new)
    assert "сделан прежней версией харнесса" in text
    assert "`by_category`" in text and "`aggregate_refusal`" in text
    # Категории второго прогона не выдаются за «пропавшие» в первом.
    assert "нет ключа `by_category`" in text
    assert "набор категорий между прогонами изменился" not in text
    assert f"| {FALSE_REFUSAL_RATE_KEY} ↓ (меньше — лучше) | — |" in text
    # Старый отчёт и сам по себе всё ещё рендерится.
    assert "# RAG eval — прогон `old`" in render_report_md(old)


# --------------------------------------------------------------------------- #
# Третий исход: метапара — вопрос про саму базу или про ассистента
# --------------------------------------------------------------------------- #


def test_expected_outcome_falls_back_to_the_binary_flag():
    """Старый golden-набор поля не знает — вердикт выводится, поведение то же."""
    assert expected_outcome({"id": "q"}) == "answer"
    assert expected_outcome({"id": "t", "expected_refusal": True}) == "refusal"
    # Мусор в поле не должен молча создавать четвёртую корзину.
    assert expected_outcome({"id": "q", OUTCOME_KEY: "чепуха"}) == "answer"
    assert expected_outcome({"id": "m", OUTCOME_KEY: "meta"}) == "meta"


def test_run_sample_scores_a_meta_row_by_answering_not_by_refusing():
    """На метапаре отказ — ПРОВАЛ; на ловушке он же — успех. Разные корзины."""
    meta_row = {
        "id": "m1",
        "question": "Что ты знаешь?",
        "ground_truth": "эталон.",
        OUTCOME_KEY: "meta",
    }
    sample, _judge = _run_one(meta_row, rag_log=None, body=REFUSAL_SSE)
    assert sample[REFUSAL_KEY] is True  # факт отказа записан как был
    assert sample[META_KEY] is False  # …но на метапаре это провал
    assert sample[FALSE_REFUSAL_KEY] is None  # и не подмешивается в чужой знаменатель
    assert sample[OUTCOME_KEY] == "meta"

    sample, _judge = _run_one(meta_row, rag_log=None, body=SSE_BODY)
    assert sample[META_KEY] is True

    # У ловушки и у отвечаемой пары третьего флага нет вовсе.
    trap = {"id": "t1", "question": "?", "expected_refusal": True}
    sample, _judge = _run_one(trap, rag_log=None, body=REFUSAL_SSE)
    assert sample[META_KEY] is None
    sample, _judge = _run_one({"id": "q1", "question": "?"}, rag_log=None, body=SSE_BODY)
    assert sample[META_KEY] is None


def test_meta_rows_get_their_own_bucket_and_leave_the_others_intact():
    """Метапара не разбавляет ни судейские средние, ни ветку отказа."""
    rows = [
        _sample("q1", 0.8, **{FALSE_REFUSAL_KEY: False}),
        _sample("t1", 0.0, expected_refusal=True, **{REFUSAL_KEY: True}),
        # Метапара с отказом НЕ попадает в false_refusal_rate: у него свой
        # знаменатель — отвечаемые пары, и подмешивание меняло бы старое число.
        _sample("m1", 0.2, **{OUTCOME_KEY: "meta", META_KEY: True}),
        _sample("m2", 0.2, **{OUTCOME_KEY: "meta", META_KEY: False}),
    ]
    report = _report("x", 0.0, samples=rows)

    assert report["buckets"] == {"answerable": 1, "refusal": 1, "meta": 2}
    assert report["aggregate"]["faithfulness_ru"] == 0.8  # метапары не в среднем
    assert report["aggregate_meta"]["faithfulness_ru"] == 0.2  # но и не потеряны
    assert report["coverage_meta"]["faithfulness_ru"] == 2
    assert report["aggregate"][META_RATE_KEY] == 0.5
    # Существующие метрики не переопределены: ловушка по-прежнему одна.
    assert report["aggregate"][REFUSAL_KEY] == 1.0
    assert report["aggregate"][FALSE_REFUSAL_RATE_KEY] == 0.0


def test_meta_answered_rate_ignores_failed_and_foreign_rows():
    rows = [
        _sample("m1", 0.5, **{OUTCOME_KEY: "meta", META_KEY: True}),
        _sample("m2", 0.5, **{OUTCOME_KEY: "meta", META_KEY: False}),
        _sample("m3", 0.5, failed=True, error="HTTP 500", **{OUTCOME_KEY: "meta", META_KEY: False}),
        _sample("t1", 0.5, expected_refusal=True, **{REFUSAL_KEY: True}),
    ]
    assert meta_answered_rate(rows) == 0.5
    assert meta_answered_rate([]) is None


def test_report_md_shows_the_meta_bucket_only_when_it_has_rows():
    rows = [_sample("q1", 0.8), _sample("m1", 0.4, **{OUTCOME_KEY: "meta", META_KEY: True})]
    text = render_report_md(_report("x", 0.0, samples=rows))
    assert "метапар `expected_outcome: meta`: 1" in text
    assert "## Метапары `expected_outcome: meta` (1)" in text
    assert f"| {META_RATE_KEY} " in text

    quiet = render_report_md(_report("y", 0.0, samples=[_sample("q1", 0.8)]))
    assert "## Метапары" not in quiet


def test_bucket_numbers_of_a_legacy_report_report_zero_meta():
    """Отчёт прежней версии метапар не знал — корзина честно нулевая."""
    report = _report("old", 0.0, samples=[_sample("q1", 0.8)])
    report.pop("buckets")
    assert _bucket_numbers(report) == {"answerable": 1, "refusal": 0, "meta": 0}


def test_compare_table_carries_the_meta_branch():
    """Третий исход обязан быть виден и в дифе, иначе его сдвиг не заметят."""
    rows_a = [_sample("m1", 0.5, **{OUTCOME_KEY: "meta", META_KEY: False})]
    rows_b = [_sample("m1", 0.5, **{OUTCOME_KEY: "meta", META_KEY: True})]
    text = render_compare_md(
        _report("a", 0.0, samples=rows_a), _report("b", 0.0, samples=rows_b)
    )
    line = [l for l in text.splitlines() if l.startswith(f"| {META_RATE_KEY}")][0]
    assert "+1.000" in line
    assert "▲" in line
