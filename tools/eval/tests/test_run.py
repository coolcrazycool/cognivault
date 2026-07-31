"""Tests for the harness: SSE parsing, golden loading, report + diff rendering.

Everything here is offline: the SSE bodies are literals, the chat client is
driven through ``httpx.MockTransport``.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from run import (  # noqa: E402
    REPORT_DISCLAIMER,
    RETRIEVAL_KEY,
    ChatClient,
    build_report,
    collect_chat,
    load_golden,
    parse_sse,
    render_compare_md,
    render_report_md,
    retrieval_hit_rate,
    slice_section,
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


def test_slice_section_extracts_named_section():
    content = "# Док\n\nвступление\n\n## Раздел\n\nтело раздела\n\n## Другой\n\nне то\n"
    sliced = slice_section(content, "Док > Раздел")
    assert "тело раздела" in sliced
    assert "не то" not in sliced


def test_slice_section_returns_none_when_absent():
    assert slice_section("# Док\n\nтекст", "Док > Нет такого") is None


# --------------------------------------------------------------------------- #
# Reports
# --------------------------------------------------------------------------- #


def _report(label: str, faith: float, hit: float) -> dict:
    samples = [
        {
            "id": "s1",
            "kind": "factual",
            "question": "Что такое CogniVault?",
            RETRIEVAL_KEY: hit >= 0.5,
            "metrics": {
                "faithfulness_ru": {"score": faith},
                "answer_relevancy_ru": {"score": 0.5},
                "context_precision": {"score": 0.5},
                "context_recall": {"score": 0.5},
            },
        }
    ]
    return build_report(
        samples,
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


def test_build_report_counts_failures():
    samples = [{"id": "a", "error": "HTTP 500", "metrics": {}}, {"id": "b", "metrics": {}}]
    report = build_report(
        samples,
        label="x",
        golden_path="g",
        ui_url="u",
        judge_model="m",
    )
    assert report["counts"] == {"total": 2, "failed": 1, "evaluated": 1}


def test_compare_table_signs_and_deltas():
    text = render_compare_md(_report("baseline", 0.60, 1.0), _report("wave-3", 0.80, 1.0))
    assert "| baseline | wave-3 |" in text
    assert "+0.200" in text
    assert "▲" in text
    # unchanged metrics land in the noise band
    assert "≈" in text


def test_compare_table_marks_regression():
    text = render_compare_md(_report("a", 0.90, 1.0), _report("b", 0.50, 1.0))
    assert "-0.400" in text
    assert "▼" in text


def test_compare_warns_on_prompt_version_mismatch():
    report_a = _report("a", 0.5, 1.0)
    report_b = _report("b", 0.5, 1.0)
    report_b["prompt_version"] = "v2"
    assert "разными версиями судейских промптов" in render_compare_md(report_a, report_b)


def test_compare_handles_missing_metric():
    report_a = _report("a", 0.5, 1.0)
    report_b = _report("b", 0.5, 1.0)
    report_b["aggregate"]["faithfulness_ru"] = None
    text = render_compare_md(report_a, report_b)
    assert "| faithfulness_ru | 0.500 | — | — | — |" in text
