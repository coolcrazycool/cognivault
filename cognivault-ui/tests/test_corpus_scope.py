"""Вопросы про саму базу — итерация 2, шаг 2 (а/б/в).

Покрывает:

* :func:`app.corpus_scope.match_meta` — детерминированный распознаватель
  метавопросов: якорные формулировки совпадают, тематические — нет
  («Что ты знаешь про PSI?» ≠ «Что ты знаешь?»), непопадание проваливается в
  сегодняшнее поведение;
* :func:`app.corpus_scope.parse_scope` — поле охвата из condense, включая
  отсутствие поля (промпт пользовательски редактируем — вырезанная фраза не
  должна ломать маршрут);
* :func:`app.corpus_scope.hedge` — оговорка по концентрации доказательств и,
  главное, ИЗМЕРЕНИЕ: доля ложных оговорок на замороженной контрольной группе
  из 56 вопросов класса B (см. ``tools/eval/golden.control.json``);
* :func:`app.rag.build_rag_context` — мета-ветка отвечает по дереву разделов,
  без поиска и без вызовов модели, и молча уходит в обычный путь, когда листинг
  вольта недоступен;
* :mod:`app.routes.chat_routes` — оговорка дописывается ПОСЛЕ ответа модели,
  тем же кадром ``token``, и попадает в историю.

Чего эти тесты НЕ видят (и не могут увидеть офлайн): вердикта живого
классификатора. Ложная оговорка возможна ровно одним способом — condense назовёт
охват ``corpus`` на вопросе про один документ; здесь зафиксировано, что при
любом ДРУГОМ вердикте (в том числе при отсутствующем, сломанном и выключенном)
оговорки нет.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import (  # noqa: E402
    catalog,
    cognivault,
    corpus_map,
    corpus_scope,
    rag,
    rag_pipeline,
    settings,
)
from app.config import AppPaths  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes import chat_routes  # noqa: E402

# Настоящий загрузчик листинга, снятый ДО подмены из `conftest`: мета-ветка
# строится как раз из него.
_REAL_FILES = corpus_map.files


@pytest.fixture(autouse=True)
def _local_mode(monkeypatch):
    monkeypatch.setattr(settings, "is_server", lambda: False)


# --------------------------------------------------------------------------- #
# 2а. Распознаватель метавопросов
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "question, kind",
    [
        ("Что ты знаешь?", "assistant"),
        ("что ты вообще знаешь", "assistant"),
        ("Что ты умеешь?", "assistant"),
        ("Кто ты?", "assistant"),
        ("Чем ты можешь помочь?", "assistant"),
        ("Привет! Что ты знаешь?", "assistant"),
        ("Подскажи, что ты умеешь?", "assistant"),
        ("О чём эта база?", "corpus"),
        ("О каких проектах знаешь?", "corpus"),
        ("О каких продуктах есть информация в базе знаний?", "corpus"),
        ("Из каких разделов состоит база знаний?", "corpus"),
        ("Какие разделы есть в базе знаний?", "corpus"),
        ("Что лежит в базе?", "corpus"),
        ("Сколько всего страниц в базе и как они распределены по разделам?", "corpus"),
        # Составной метавопрос: обе части — метавопросы, корпусная сильнее.
        ("Что ты вообще знаешь? О чём эта база?", "corpus"),
    ],
)
def test_meta_questions_are_recognised(question, kind):
    assert corpus_scope.match_meta(question) == kind


@pytest.mark.parametrize(
    "question",
    [
        # Та самая пара, которую нельзя перепутать.
        "Что ты знаешь про PSI?",
        "Что ты знаешь о витрине fincert_feeds?",
        # Тематические вопросы про охват — у них есть документ-ответ, их место
        # в поиске, а не в дереве.
        "Какие витрины ClickHouse описаны в базе?",
        "Что лежит в разделе «Архив»?",
        "Какие сервисы входят в продукт Fincert?",
        "Перечисли все поля витрины fincert_feeds",
        # Приветствие само по себе — не метавопрос (это smalltalk).
        "привет",
        "Спасибо!",
        # Приветствие + содержательный вопрос: содержательная часть решает.
        "Привет! Какие колонки в таблице fincert_feeds?",
        "",
    ],
)
def test_non_meta_questions_fall_through(question):
    """Непопадание — это ``None``: ход идёт ровно как сегодня (поиск + грейдер)."""
    assert corpus_scope.match_meta(question) is None


def test_matcher_ignores_long_input():
    """Длинная реплика несёт предмет, а не вопрос об охвате."""
    assert corpus_scope.match_meta("что ты знаешь " + "и " * 200) is None


# --------------------------------------------------------------------------- #
# 2б. Поле охвата
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("raw", ["corpus", " CORPUS ", '"corpus"'])
def test_parse_scope_reads_corpus(raw):
    assert corpus_scope.parse_scope(raw) == "corpus"


@pytest.mark.parametrize("raw", [None, "", "document", "весь корпус", 5, {"a": 1}, True])
def test_parse_scope_defaults_to_document(raw):
    """Нет поля, мусор, вырезанная из промпта фраза — сегодняшнее поведение."""
    assert corpus_scope.parse_scope(raw) == corpus_scope.DEFAULT_SCOPE == "document"


# --------------------------------------------------------------------------- #
# 2в. Оговорка
# --------------------------------------------------------------------------- #


def _sources(*paths: str) -> list[dict]:
    return [
        {"n": i, "path": p, "title": f"Документ {i}"}
        for i, p in enumerate(paths, start=1)
    ]


def test_hedge_fires_on_corpus_question_answered_from_one_document():
    text = corpus_scope.hedge("corpus", _sources("a.md", "a.md"), 127)

    assert text is not None
    assert "Документ 1" in text and "127" in text
    # Оговорка уточняет ответ, а не заменяет его: это одна фраза, а не отказ.
    assert "не нашлось" not in text


@pytest.mark.parametrize(
    "scope, sources, total, why",
    [
        ("document", _sources("a.md"), 127, "вопрос про один документ"),
        (corpus_scope.DEFAULT_SCOPE, _sources("a.md"), 127, "поля scope не было"),
        ("corpus", _sources("a.md", "b.md"), 127, "источники из двух документов"),
        ("corpus", [], 127, "источников нет вовсе"),
        ("corpus", _sources("a.md"), 1, "в базе один документ — оговариваться не о чем"),
    ],
)
def test_hedge_stays_silent(scope, sources, total, why):
    assert corpus_scope.hedge(scope, sources, total) is None, why


def test_hedge_omits_the_denominator_when_the_listing_is_unavailable():
    text = corpus_scope.hedge("corpus", _sources("a.md"), None)
    assert text is not None and "из None" not in text


# --------------------------------------------------------------------------- #
# ИЗМЕРЕНИЕ: ложные оговорки на 56 вопросах класса B
# --------------------------------------------------------------------------- #

_CONTROL = Path(__file__).resolve().parents[2] / "tools" / "eval" / "golden.control.json"


def _control_questions() -> list[dict]:
    if not _CONTROL.exists():  # пакет собран без набора eval
        pytest.skip(f"контрольная группа недоступна: {_CONTROL}")
    return json.loads(_CONTROL.read_text(encoding="utf-8"))["questions"]


def test_control_group_is_the_frozen_fifty_six():
    assert len(_control_questions()) == 56


def test_false_hedge_rate_on_the_control_group_is_zero():
    """Ни один из 56 отвечаемых сегодня вопросов не получает оговорку.

    Вердикты ФИКСИРОВАНЫ, потому что офлайн классификатора нет. Проверяются все
    вердикты, которые может выдать реальный ход, кроме одного:

    * ``document`` — правильный вердикт для вопроса про один документ;
    * отсутствующее поле ``scope`` — старый или обрезанный пользователем промпт;
    * сломанный/пустой ответ condense и выключенный condense — оба дают
      :data:`app.corpus_scope.DEFAULT_SCOPE`.

    Не проверяется (и офлайн непроверяемо): вердикт ``corpus`` на вопросе класса
    B. Это единственный способ получить здесь ложную оговорку, и он живёт в
    маршрутизации — мерить его можно только на живом стенде по полям
    ``scope``/``hedge`` в ``rag_log.jsonl``.
    """
    questions = _control_questions()
    verdicts = [
        corpus_scope.parse_scope("document"),
        corpus_scope.parse_scope(None),
        corpus_scope.parse_scope("не знаю"),
    ]

    hedged = [
        (row["id"], scope)
        for row in questions
        for scope in verdicts
        # Класс B отвечается ИЗ ОДНОГО документа — то есть сходится ровно в тот
        # признак, на который смотрит оговорка. Единственное, что её удерживает,
        # это охват.
        if corpus_scope.hedge(scope, _sources(row["source_path"]), 127) is not None
    ]

    assert hedged == [], f"ложная оговорка на {len(hedged)} парах (вопрос, вердикт)"


def test_the_control_measurement_is_not_vacuous():
    """Страховка от «нулевой доли» из-за того, что оговорка не работает вовсе.

    Тот же вопрос класса B с вердиктом ``corpus`` оговорку получает — значит
    ноль выше означает «охват удержал», а не «оговорка мертва».
    """
    row = _control_questions()[0]
    assert corpus_scope.hedge("corpus", _sources(row["source_path"]), 127) is not None


def test_no_control_question_is_swallowed_by_the_meta_matcher():
    """Ложное срабатывание 2а хуже ложной оговорки: ответ подменяется деревом."""
    matched = [
        row["id"] for row in _control_questions() if corpus_scope.match_meta(row["question"])
    ]
    assert matched == []


# --------------------------------------------------------------------------- #
# Мета-ветка в сборке контекста
# --------------------------------------------------------------------------- #


def _corpus() -> list[str]:
    paths = [f"Продукты/{s}/Стр {i}.md" for i, s in enumerate(["Fincert"] * 12)]
    paths += [f"Продукты/АРМ DS/Стр {i}.md" for i in range(9)]
    paths += [f"Архив/Проект {i}.md" for i in range(4)]
    paths += [f"База знаний/Инструкция {i}.md" for i in range(3)]
    return paths


def _install_listing(monkeypatch, paths: list[str] | None) -> None:
    """Оба шва структуры: листинг вольта и каталог.

    Каталог тут нужен ровно за одним полем — `document_extensions`: без него
    `corpus_map` не знает, что считать документом, и честно не строит блок
    вовсе (см. `tests/test_corpus_map.py`). Дерево разделов из шага 3 из этой
    заглушки не соберётся — в ней нет `documents`, — и это специально: мета-ветка
    обязана работать и на голом листинге, флаг `corpus_tree_enabled` выключен.
    """

    async def fake_list_files(cv=None, recursive=True, timeout=None):
        if paths is None:
            raise cognivault.CogniVaultError("list files failed (503)", 503, "")
        return paths

    async def fake_catalog(cv=None):
        return {
            "status": "summaries_pending",
            "summaries_enabled": True,
            "reason": None,
            "documents": [],
            "total": 0,
            "offset": 0,
            "documents_with_summary": 0,
            "document_extensions": ["md", "pdf", "canvas", "excalidraw", "csv"],
        }

    monkeypatch.setattr(corpus_map, "files", _REAL_FILES)
    monkeypatch.setattr(cognivault, "list_files", fake_list_files)
    monkeypatch.setattr(catalog, "payload", fake_catalog)
    corpus_map.reset_cache()
    catalog.reset_cache()


def _install_retrieval(monkeypatch) -> list[str]:
    """Поиск и обе скрытые модели; возвращает журнал вызовов."""
    seen: list[str] = []

    async def fake_hybrid(query, limit, cv=None, **kwargs):
        seen.append("search")
        return {
            "results": [
                {
                    "path": "Архив/Проект 1.md",
                    "title": "Проекты Ислама",
                    "section_path": "",
                    "score": 1.0,
                    "text": "нумерованный список личных проектов",
                    "chunk_index": 0,
                    "rank": 1,
                }
            ]
        }

    async def fake_content(path, cv=None):
        raise RuntimeError("content unavailable")

    async def fake_complete_json(messages, gcfg, **kwargs):
        prompt = messages[-1]["content"]
        seen.append("condense" if "Определи тип реплики" in prompt else "grade")
        if "Определи тип реплики" in prompt:
            return {"intent": "kb_question", "standalone_question": None}
        return {"grades": [{"id": 1, "score": 5}]}

    monkeypatch.setattr(rag.cognivault, "hybrid_search", fake_hybrid)
    monkeypatch.setattr(rag.cognivault, "content", fake_content)
    monkeypatch.setattr(
        rag_pipeline.gigachat, "complete_json", fake_complete_json, raising=False
    )
    return seen


def _build(query: str, **rcfg) -> rag.RagContext:
    return asyncio.run(
        rag.build_rag_context(
            query,
            {"mode": "auto", "max_expanded_files": 0, **rcfg},
            None,
            {},
            None,
        )
    )


def test_meta_question_is_answered_from_the_section_tree(monkeypatch):
    seen = _install_retrieval(monkeypatch)
    _install_listing(monkeypatch, _corpus())

    ctx = _build("Что ты знаешь?")

    assert ctx.intent == "meta"
    assert ctx.sources == []
    # Ни поиска, ни condense, ни грейдера: ветка детерминированная.
    assert seen == []
    # Ответ строится из настоящего дерева, а не из выдуманного текста.
    content = ctx.user_message["content"]
    assert "Структура базы знаний" in content
    assert "Всего документов в базе: 28." in content
    assert "- Продукты — 21" in content and "Fincert: 12" in content
    assert content.endswith("Вопрос: Что ты знаешь?")
    # Системный турн — свой: `NO_RAG_SYSTEM_PROMPT` запрещает утверждать то,
    # чего нет в истории диалога, то есть запрещает и рассказ об охвате.
    assert ctx.system_message["content"] == rag.META_SYSTEM_PROMPT
    assert ctx.system_message["content"] != rag.NO_RAG_SYSTEM_PROMPT


def test_meta_branch_falls_through_when_the_listing_is_unavailable(monkeypatch):
    """Нет дерева — нет и ответа по дереву: ход идёт обычным путём, до грейдера."""
    seen = _install_retrieval(monkeypatch)
    _install_listing(monkeypatch, None)

    ctx = _build("Что ты знаешь?")

    assert ctx.intent == "kb_question"
    assert "search" in seen and "grade" in seen
    assert ctx.sources and ctx.system_message["content"] == rag.SYSTEM_PROMPT


def test_ordinary_question_never_reaches_the_meta_branch(monkeypatch):
    seen = _install_retrieval(monkeypatch)
    _install_listing(monkeypatch, _corpus())

    ctx = _build("Что ты знаешь про PSI?")

    assert ctx.intent == "kb_question"
    assert "search" in seen
    assert "Источники:" in ctx.user_message["content"]


def test_user_system_prompt_does_not_apply_to_the_meta_turn(monkeypatch):
    """Сохранённый `prompts.system` — правила ответа по «Источникам», которых тут нет."""
    _install_retrieval(monkeypatch)
    _install_listing(monkeypatch, _corpus())

    ctx = asyncio.run(
        rag.build_rag_context(
            "О чём эта база?",
            {"mode": "auto"},
            None,
            {},
            None,
            prompts={"system": "мой собственный системный промпт"},
        )
    )

    assert ctx.system_message["content"] == rag.META_SYSTEM_PROMPT


# --------------------------------------------------------------------------- #
# Оговорка в маршруте
# --------------------------------------------------------------------------- #


def _parse_sse(text: str) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    for block in text.split("\n\n"):
        event = data = None
        for line in block.splitlines():
            if line.startswith("event: "):
                event = line[len("event: ") :]
            elif line.startswith("data: "):
                data = json.loads(line[len("data: ") :])
        if event is not None:
            out.append((event, data or {}))
    return out


def _install_chat(monkeypatch, paths, ctx, answer="ответ модели"):
    async def fake_build_rag_context(query, *args, **kwargs):
        return ctx

    async def fake_stream_chat(messages, gcfg):
        yield answer

    monkeypatch.setattr(chat_routes, "resolve_paths", lambda request: paths)
    monkeypatch.setattr(chat_routes.rag, "build_rag_context", fake_build_rag_context)
    monkeypatch.setattr(chat_routes.gigachat, "stream_chat", fake_stream_chat)
    monkeypatch.setattr(chat_routes.gigachat, "_files_present", lambda gcfg: None)


def _rag_ctx(hedge: str | None) -> rag.RagContext:
    return rag.RagContext(
        system_message={"role": "system", "content": "правила"},
        user_message={"role": "user", "content": "Источники:\n\nВопрос: вопрос"},
        sources=[{"n": 1, "title": "Док", "path": "a.md", "section_path": "", "depth": "chunk", "score": 1.0, "grade": 5}],
        context_chars=10,
        intent="kb_question",
        standalone_question="вопрос",
        scope="corpus" if hedge else "document",
        hedge=hedge,
    )


HEDGE = "Оговорка: вопрос охватывает базу целиком, а все найденные фрагменты — из одного документа."


def test_hedge_is_appended_after_the_answer(tmp_path, monkeypatch):
    """Оговорка идёт ПОСЛЕ ответа и отдельным кадром — она уточняет, а не заменяет."""
    paths = AppPaths(root=tmp_path / "ui")
    _install_chat(monkeypatch, paths, _rag_ctx(HEDGE), answer="краткий ответ")

    with TestClient(create_app()) as client:
        resp = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "какие продукты"}], "rag": True},
        )

    assert resp.status_code == 200
    tokens = [data["text"] for name, data in _parse_sse(resp.text) if name == "token"]
    assert tokens[0] == "краткий ответ"
    assert tokens[-1].strip() == HEDGE
    # И в сохранённую историю, и в лог качества — иначе долю оговорок не измерить.
    from app.history import load_chat

    saved = load_chat(next(iter(paths.history_dir.glob("*.json"))).stem, paths)
    assert saved["messages"][-1]["content"].endswith(HEDGE)


def test_no_hedge_no_extra_frame(tmp_path, monkeypatch):
    paths = AppPaths(root=tmp_path / "ui")
    _install_chat(monkeypatch, paths, _rag_ctx(None), answer="краткий ответ")

    with TestClient(create_app()) as client:
        resp = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "поля витрины"}], "rag": True},
        )

    tokens = [data["text"] for name, data in _parse_sse(resp.text) if name == "token"]
    assert tokens == ["краткий ответ"]
