"""Дерево разделов как ДОБАВЛЕННЫЙ источник — итерация 3, шаг 3.

Покрывает:

* :mod:`app.corpus_tree` — сборка дерева из каталога, свёртка коридора,
  пометки (архив / контейнер / пустая страница), описания из аннотаций,
  лестница деградации под потолком символов и молчаливый отказ на любом сбое;
* :func:`app.corpus_tree.enabled` — флаг ``rag.corpus_tree_enabled``;
* :func:`app.rag.build_rag_context` — дерево встаёт в ту же голову сообщения,
  где раньше стоял блок «состав базы», и НЕ трогает блок «Источники»;
* **ИЗМЕРЕНИЕ**: замороженная контрольная группа из 56 вопросов класса B
  (``tools/eval/golden.control.json``) — ни у одного из них дерево не вытесняет
  и не урезает настоящий источник.

Чего эти тесты НЕ видят (и не могут увидеть офлайн): пользуется ли модель
деревом хорошо. Здесь зафиксировано, что дерево ДОЕЗЖАЕТ до модели, что оно
говорит правду про пустые и архивные страницы и что оно ничего не отнимает у
источников; станет ли от него лучше ответ — вопрос живого стенда.
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
    corpus_tree,
    rag,
    rag_pipeline,
    settings,
)
from app.config import AppPaths  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes import chat_routes  # noqa: E402
from app.tokens import estimate_tokens  # noqa: E402

# Настоящие загрузчики, снятые ДО подмены из `conftest`: в этом файле
# проверяются как раз они (кэш, деградация, место в ходе), поэтому здесь оба
# возвращаются на место.
_REAL_FILES = corpus_map.files
_REAL_PAYLOAD = catalog.payload


@pytest.fixture(autouse=True)
def _local_mode(monkeypatch):
    monkeypatch.setattr(settings, "is_server", lambda: False)
    monkeypatch.setattr(catalog, "payload", _REAL_PAYLOAD)


# --------------------------------------------------------------------------- #
# Корпус-образец: та же форма, что у боевого (Confluence-коридор, архив,
# страницы-контейнеры без текста, витрины внутри «Описание витрин»)
# --------------------------------------------------------------------------- #

_ROOT = "Confluence/OASISEXT/OASIS External Home/Разработка"

# Ниже этого размера у страницы нет своего текста: остаётся фронтматтер и
# заголовок. См. `corpus_tree._EMPTY_MAX_BYTES`.
_EMPTY = 470
_FULL = 5200


def _doc(path: str, size: int = _FULL, summary: str | None = "Аннотация.") -> dict:
    return {
        "path": f"{_ROOT}/{path}",
        "title": path.rsplit("/", 1)[-1][:-3],
        "summary": None if size <= _EMPTY else summary,
        "size": size,
    }


def _documents() -> list[dict]:
    docs = [
        _doc("Архив.md", _EMPTY),
        _doc("Архив/Проекты Ислама.md", summary="Личные проекты одного инженера. Не продукт."),
        _doc("Архив/Data Quality.md"),
        _doc("База знаний.md", summary="Оглавление раздела. Перечислены не все страницы."),
        _doc("База знаний/Инструкция по работе с BitBucket.md"),
        _doc("База знаний/Инструкция по работе с CTL.md"),
        _doc("База знаний/Принципы работы моделей.md"),
        _doc("Продукты.md", _EMPTY),
        _doc("Продукты/Fincert.md", summary="Продукт обработки фидов ФинЦерта. Второе предложение."),
        _doc("Продукты/Fincert/Сервис получения ФИДов.md"),
        _doc("Продукты/Marksman.md", _EMPTY),
        _doc("Продукты/Описание витрин.md", summary="Витрины по хранилищам."),
        _doc("Продукты/Описание витрин/ClickHouse.md", _EMPTY),
        _doc("Продукты/Описание витрин/ClickHouse/АРМ Оператора.md", _EMPTY),
        _doc("Продукты/Описание витрин/ClickHouse/АРМ Оператора/Данные по резолюциям (afpc_inc_distr.resolutions_safp).md"),
        _doc("Продукты/Описание витрин/ClickHouse/Аналитика и статистика.md", _EMPTY),
        _doc("Продукты/Описание витрин/Hive.md", _EMPTY),
        _doc("Продукты/Описание витрин/Hive/Данные по фичам и скорам (afpc_sss_inc.tr_out_ext).md"),
        _doc("Продукты/АРМ DS.md", summary="Автоматизированное рабочее место дата-сайентиста."),
        _doc("Продукты/АРМ DS/Пользовательская инструкция. Финансовый эффект.md"),
        _doc("Продукты/АРМ DS/Пользовательская инструкция. Мониторинг моделей.md"),
    ]
    return sorted(docs, key=lambda d: d["path"])


def _payload(documents=None, **overrides) -> dict:
    docs = _documents() if documents is None else documents
    payload = {
        "status": "ok",
        "summaries_enabled": True,
        "reason": None,
        "documents": docs,
        "total": len(docs),
        "offset": 0,
        "documents_with_summary": sum(1 for d in docs if d.get("summary")),
        "document_extensions": ["md", "pdf", "canvas", "excalidraw", "csv"],
    }
    payload.update(overrides)
    return payload


# --------------------------------------------------------------------------- #
# Сборка дерева
# --------------------------------------------------------------------------- #


def test_corridor_is_folded_into_the_heading_not_into_four_levels():
    """`Confluence/<пространство>/<предки…>` — коридор, а не четыре раздела."""
    roots, prefix = corpus_tree.build(_documents())

    assert prefix == _ROOT
    assert [n.name for n in roots] == ["Архив", "База знаний", "Продукты"]


def test_a_page_and_its_subtree_are_one_node():
    """`X.md` и папка `X/` — одна страница с детьми, а не два элемента списка."""
    roots, _ = corpus_tree.build(_documents())
    products = next(n for n in roots if n.name == "Продукты")

    assert products.is_document is True
    assert products.subtree_documents == 13
    assert "Fincert" in [c.name for c in products.children]


def test_tree_survives_garbage_in_the_catalogue():
    docs = [{"path": ""}, {"path": None}, {}, _doc("Продукты/Fincert.md")]
    roots, prefix = corpus_tree.build(docs)
    assert [n.name for n in roots] == ["Fincert"]
    assert prefix == f"{_ROOT}/Продукты"


# --------------------------------------------------------------------------- #
# Пометки: что скрывают заголовки
# --------------------------------------------------------------------------- #


def test_empty_container_pages_are_marked():
    """Страница «Продукты» существует, пуста и является контейнером — всё три факта."""
    block = corpus_tree.render(_payload())

    assert "- Продукты [раздел: 13, пусто]" in block
    assert "- Marksman [пусто]" in block
    # У страницы с текстом пометки «пусто» нет.
    assert "- База знаний [раздел: 3]" in block


def test_archive_branch_is_marked_once_at_its_root():
    block = corpus_tree.render(_payload())

    assert "- Архив [архив, раздел: 2, пусто]" in block
    # Внутри архива пометка не повторяется на каждой строке — её несёт отступ.
    tree = block[block.index("- Архив") :]
    assert tree.count("[архив") == 1
    assert "  - Проекты Ислама" in block


def test_legend_explains_only_the_markers_that_occur():
    """Объяснять пометку, которой в выводе нет, — чистая трата символов."""
    full = corpus_tree.render(_payload())
    assert "[архив]" in full and "[пусто]" in full and "[раздел: N]" in full

    # Корпус без единой пометки не платит и за легенду.
    plain = corpus_tree.render(
        _payload([_doc("Заметки/а.md"), _doc("Заметки/б.md")])
    )
    assert "Пометки:" not in plain


@pytest.mark.parametrize(
    "size, summary, empty",
    [
        (_EMPTY, None, True),  # мало байт и нет аннотации — своего текста нет
        (_FULL, None, False),  # большая страница без аннотации — вызов упал, не пусто
        (_EMPTY, "Аннотация.", False),  # аннотирована ⇒ чанки были ⇒ не пуста
        (_FULL, "Аннотация.", False),
        (None, None, False),  # размер неизвестен — не утверждаем ничего
    ],
)
def test_emptiness_needs_both_signals(size, summary, empty):
    node = corpus_tree._Node(
        name="X", summary=summary, size=size, is_document=True
    )
    assert corpus_tree._is_empty(node) is empty


def test_emptiness_degrades_to_size_when_nothing_is_annotated():
    """Инсталляция без аннотаций (`EMBEDDING_PROVIDER=openai`) — не особый случай.

    Аннотаций нет ни у кого, признак «нет аннотации» перестаёт различать, и
    остаётся размер — с ЖЁСТКОЙ границей: недосказать про пустую страницу
    дешевле, чем назвать пустой короткую настоящую.
    """
    docs = [dict(d, summary=None) for d in _documents()]
    block = corpus_tree.render(_payload(docs, status="summaries_disabled",
                                        documents_with_summary=0))
    assert "- Продукты [раздел: 13, пусто]" in block
    assert "- База знаний [раздел: 3]" in block


def test_the_two_size_bounds_are_the_measured_ones():
    """Граница по размеру — в БАЙТАХ, и её нельзя мерить в символах.

    На боевом корпусе страницы с нулевым телом занимают 480–651 байт, а
    ближайшая страница с текстом — 652 байта (тело в 56 символов). Зазор шириной
    в один байт: размер сам по себе их не разделяет. Разделяет аннотация —
    страница с телом аннотирована, поэтому до проверки размера не доходит, и
    свободная граница ей не грозит. Когда аннотаций нет ни у кого, остаётся
    строгая.
    """
    node = lambda size: corpus_tree._Node(name="X", size=size, is_document=True)

    # 651 — самая большая пустая страница корпуса; 652 — самая маленькая непустая.
    assert corpus_tree._is_empty(node(651), annotated=True) is True
    assert corpus_tree._is_empty(node(652), annotated=True) is True  # спасёт аннотация
    assert corpus_tree._is_empty(node(651), annotated=False) is False  # строгая граница
    assert (
        corpus_tree._is_empty(
            corpus_tree._Node(name="X", size=500, summary="Есть.", is_document=True),
            annotated=True,
        )
        is False
    )
    assert corpus_tree._EMPTY_MAX_BYTES > corpus_tree._EMPTY_MAX_BYTES_UNANNOTATED


# --------------------------------------------------------------------------- #
# Описания: какая часть каталога едет в ход
# --------------------------------------------------------------------------- #


def test_descriptions_are_spent_on_the_top_two_levels_only():
    """Полный каталог — ~18 000 символов; в ход едут названия и верхние аннотации.

    Глубже второго уровня заголовок описывает себя сам («Пользовательская
    инструкция. Финансовый эффект»), а вверху стоят непрозрачные имена продуктов.
    """
    block = corpus_tree.render(_payload())

    assert "- Продукты/Описание витрин" not in block  # дерево, а не пути
    assert "- Fincert [раздел: 1] — Продукт обработки фидов ФинЦерта." in block
    # Третий уровень — только название, без аннотации.
    assert "    - Сервис получения ФИДов\n" in block


def test_description_is_the_first_sentence_only():
    assert corpus_tree._short("Первое. Второе. Третье.") == "Первое."
    assert corpus_tree._short("  много   пробелов\nи перенос  ") == "много пробелов и перенос"
    assert corpus_tree._short(None) == ""
    assert corpus_tree._short("") == ""
    # Сокращения и версии не считаются концом предложения.
    assert corpus_tree._short("Версия v 2.1 продукта") == "Версия v 2.1 продукта"
    long = "с" * 400
    assert len(corpus_tree._short(long)) <= corpus_tree._DESC_MAX_CHARS


# --------------------------------------------------------------------------- #
# Лестница деградации
# --------------------------------------------------------------------------- #


def test_ladder_drops_descriptions_one_level_at_a_time_then_depth():
    payload = _payload()
    full = corpus_tree.render(payload)

    tight = corpus_tree.render(payload, max_chars=len(full) - 60)
    assert len(tight) <= len(full)
    # Названия — это ответ, аннотации — украшение: уходят первыми.
    assert "- Сервис получения ФИДов" in tight

    shallow = corpus_tree.render(payload, max_chars=1200)
    assert len(shallow) <= 1200 or shallow.count("\n- ") <= 3
    # Свёрнутый узел не притворяется листом: счётчик говорит, сколько внутри.
    assert "[раздел: 13" in shallow


def test_last_rung_is_returned_even_if_it_still_overflows():
    """Дно лестницы — верхний уровень: короче сказать уже нечего."""
    block = corpus_tree.render(_payload(), max_chars=10)
    assert block is not None
    assert "- Продукты" in block


def test_block_stays_inside_its_own_budget_and_costs_what_it_says():
    block = corpus_tree.render(_payload(), n_sources=5)
    assert len(block) <= corpus_tree._MAX_TREE_CHARS
    assert estimate_tokens(block) <= corpus_tree._MAX_TREE_CHARS / 2.5 + 1


# --------------------------------------------------------------------------- #
# Честность цифр и молчаливая деградация
# --------------------------------------------------------------------------- #


def test_totals_come_from_the_catalogue_and_paging_is_admitted():
    payload = _payload(total=127)
    block = corpus_tree.render(payload, n_sources=5)

    assert "Всего документов в базе: 127." in block
    assert "показаны 21 документ" in block
    assert "— 5 фрагментов" in block


def test_nothing_to_say_is_no_block():
    assert corpus_tree.render(None) is None
    assert corpus_tree.render({}) is None
    assert corpus_tree.render(_payload([], status="empty_vault", total=0)) is None
    assert corpus_tree.render(_payload([])) is None
    assert corpus_tree.render({"documents": "не список"}) is None


def test_entry_points_never_raise(monkeypatch):
    async def boom(cv=None):
        raise cognivault.CogniVaultError("catalog failed (404)", 404, "")

    monkeypatch.setattr(catalog, "payload", boom)
    catalog.reset_cache()
    # `catalog.payload` подменён целиком, поэтому исключение уходит наружу —
    # ровно этот случай и покрывает кэширующая обёртка ниже.
    with pytest.raises(cognivault.CogniVaultError):
        asyncio.run(catalog.payload(None))

    async def unavailable(cv=None):
        return None

    monkeypatch.setattr(catalog, "payload", unavailable)
    assert asyncio.run(corpus_tree.tree_block(None, 5)) is None
    assert asyncio.run(corpus_tree.overview_block(None)) is None


def test_catalogue_failure_is_swallowed_and_cached(monkeypatch):
    calls: list[int] = []

    async def boom(cv=None, limit=None, offset=None, timeout=None):
        calls.append(1)
        raise cognivault.CogniVaultError("catalog failed (404)", 404, "")

    monkeypatch.setattr(cognivault, "catalog", boom)
    catalog.reset_cache()

    assert asyncio.run(corpus_tree.tree_block(None, 5)) is None
    assert asyncio.run(corpus_tree.tree_block(None, 5)) is None
    assert len(calls) == 1  # упавший каталог не зовётся на каждом ходе


def test_catalogue_is_cached_per_vault(monkeypatch):
    seen: list[str] = []

    async def fake_catalog(cv=None, limit=None, offset=None, timeout=None):
        token = (cv or {}).get("token", "")
        seen.append(token)
        return _payload([_doc(f"{token}/док.md")])

    monkeypatch.setattr(cognivault, "catalog", fake_catalog)
    catalog.reset_cache()

    a = asyncio.run(corpus_tree.tree_block({"base_url": "http://x", "token": "aaa"}))
    b = asyncio.run(corpus_tree.tree_block({"base_url": "http://x", "token": "bbb"}))

    assert seen == ["aaa", "bbb"]
    assert "aaa" in a and "bbb" in b


# --------------------------------------------------------------------------- #
# Флаг
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "value, on",
    [(True, True), (False, False), (None, False), ("true", False), (1, False)],
)
def test_flag_is_strict(value, on):
    assert corpus_tree.enabled({"corpus_tree_enabled": value}) is on


def test_flag_defaults_to_off():
    from app.config import DEFAULT_CONFIG

    assert DEFAULT_CONFIG["rag"]["corpus_tree_enabled"] is False
    assert corpus_tree.enabled({}) is False
    assert corpus_tree.enabled(None) is False


def test_flag_is_registered_everywhere_a_knob_has_to_be():
    """Ключ, забытый в одном из пяти мест, тихо перестаёт быть настройкой."""
    from app import rag_log
    from app.config import DEFAULT_CONFIG

    assert "corpus_tree_enabled" in DEFAULT_CONFIG["rag"]
    assert "corpus_tree_enabled" in settings.server_config()["rag"]
    assert "rag.corpus_tree_enabled" in settings.USER_EDITABLE_KEYS
    assert "corpus_tree_enabled" in rag_log._RAG_SNAPSHOT_KEYS
    # Валидация значения: только настоящий булев.
    assert settings.validate_user_overrides(
        {"rag": {"corpus_tree_enabled": True}}, {}
    ) == {"rag": {"corpus_tree_enabled": True}}
    with pytest.raises(settings.ConfigValueError):
        settings.validate_user_overrides({"rag": {"corpus_tree_enabled": "да"}}, {})


def test_snapshot_records_the_flag_of_the_turn():
    from app import rag_log

    snapshot = rag_log.settings_snapshot({"corpus_tree_enabled": True}, {}, {})
    assert snapshot["rag"]["corpus_tree_enabled"] is True


# --------------------------------------------------------------------------- #
# Место в собранном ходе
# --------------------------------------------------------------------------- #


def _hit(path: str, n: int) -> dict:
    return {
        "path": path,
        "title": path.rsplit("/", 1)[-1][:-3],
        "section_path": "",
        "score": 1.0 - n / 100,
        "text": f"содержимое фрагмента {n} из {path}",
        "chunk_index": n,
        "rank": n,
    }


def _install(monkeypatch, hits: list[dict], *, grade: int = 5) -> None:
    """Поиск, обе скрытые модели, листинг и каталог — всё офлайн."""

    async def fake_hybrid(query, limit, cv=None, **kwargs):
        return {"results": hits}

    async def fake_content(path, cv=None):
        raise RuntimeError("content unavailable")

    async def fake_complete_json(messages, gcfg, **kwargs):
        prompt = messages[-1]["content"]
        if "Определи тип реплики" in prompt:
            tail = prompt.split("Последняя реплика пользователя: ", 1)[1]
            return {
                "intent": "kb_question",
                "standalone_question": tail.split("\n", 1)[0],
                "scope": "document",
            }
        return {"grades": [{"id": i, "score": grade} for i in range(1, 41)]}

    async def fake_list_files(cv=None, recursive=True, timeout=None):
        return [d["path"] for d in _documents()]

    async def fake_catalog(cv=None, limit=None, offset=None, timeout=None):
        return _payload()

    monkeypatch.setattr(rag.cognivault, "hybrid_search", fake_hybrid)
    monkeypatch.setattr(rag.cognivault, "content", fake_content)
    monkeypatch.setattr(
        rag_pipeline.gigachat, "complete_json", fake_complete_json, raising=False
    )
    monkeypatch.setattr(corpus_map, "files", _REAL_FILES)
    monkeypatch.setattr(cognivault, "list_files", fake_list_files)
    monkeypatch.setattr(cognivault, "catalog", fake_catalog)
    corpus_map.reset_cache()
    catalog.reset_cache()


def _build(query: str, tree: bool) -> rag.RagContext:
    rcfg = {
        "mode": "auto",
        "max_expanded_files": 0,
        "corpus_tree_enabled": tree,
    }
    return asyncio.run(rag.build_rag_context(query, rcfg, None, {}, None))


def test_tree_takes_the_head_slot_only_when_the_flag_is_on(monkeypatch):
    _install(monkeypatch, [_hit(f"{_ROOT}/Продукты/Fincert.md", 1)])

    off = _build("какие поля у витрины", False)
    on = _build("какие поля у витрины", True)

    assert off.user_message["content"].startswith("Состав базы знаний")
    assert on.user_message["content"].startswith("Структура базы знаний")
    # Один структурный блок на ход, а не два: дерево — надмножество футпринта.
    assert "Состав базы знаний" not in on.user_message["content"]


def test_tree_is_added_to_the_sources_never_instead_of_them(monkeypatch):
    hits = [_hit(f"{_ROOT}/Продукты/Fincert.md", i) for i in range(1, 4)]
    _install(monkeypatch, hits)

    off = _build("какие поля у витрины", False)
    on = _build("какие поля у витрины", True)

    assert on.sources == off.sources
    assert on.context_chars == off.context_chars
    # Хвост сообщения — источники, напоминание, вопрос — совпадает посимвольно.
    tail = lambda ctx: ctx.user_message["content"][
        ctx.user_message["content"].index("Источники:") :
    ]
    assert tail(on) == tail(off)


def test_tree_cannot_answer_without_the_grader(monkeypatch):
    """Грейдер отверг всё — ход заканчивается отказом, дерева нигде нет.

    Единственный предохранитель против выдуманного ответа — грейдер. Ветка,
    отвечающая деревом в обход него, потратила бы его впустую.
    """
    _install(monkeypatch, [_hit(f"{_ROOT}/Продукты/Fincert.md", 1)], grade=1)

    ctx = _build("какие витрины ClickHouse описаны в базе", True)

    assert ctx.answer_override == rag._NO_ANSWER
    assert ctx.user_message is None


def test_no_sources_no_tree(monkeypatch):
    """Поиск ничего не нашёл — структурного блока тоже нет: нечего обрамлять."""
    _install(monkeypatch, [])
    ctx = _build("какие витрины ClickHouse описаны в базе", True)
    assert ctx.user_message is None


def test_tree_falls_back_to_the_footprint_when_the_catalogue_is_gone(monkeypatch):
    _install(monkeypatch, [_hit(f"{_ROOT}/Продукты/Fincert.md", 1)])

    async def boom(cv=None, limit=None, offset=None, timeout=None):
        raise cognivault.CogniVaultError("catalog failed (404)", 404, "")

    monkeypatch.setattr(cognivault, "catalog", boom)
    catalog.reset_cache()

    ctx = _build("какие поля у витрины", True)
    # Каталог отдаёт и `document_extensions`, без которых футпринт тоже не
    # строится: оба блока честно исчезают, ход идёт как до обеих итераций.
    assert ctx.user_message["content"].startswith("Источники:")


def test_meta_branch_prefers_the_tree_and_degrades_to_the_listing(monkeypatch):
    _install(monkeypatch, [_hit(f"{_ROOT}/Продукты/Fincert.md", 1)])

    with_tree = _build("О чём эта база?", True)
    assert with_tree.intent == rag._META_INTENT
    assert with_tree.user_message["content"].startswith("Структура базы знаний")
    assert "- Продукты [раздел: 13, пусто]" in with_tree.user_message["content"]

    without = _build("О чём эта база?", False)
    assert without.intent == rag._META_INTENT
    # Флаг выключен — материал прежний: свёрнутый листинг из шага 2, без
    # названий страниц и без пометок.
    assert "Построена по дереву разделов" in without.user_message["content"]
    assert "Разделы внутри" in without.user_message["content"]
    assert "[раздел:" not in without.user_message["content"]


def test_tree_reaches_the_model_and_history_pays_for_it(monkeypatch, tmp_path):
    """Сквозь маршрут: дерево доезжает до GigaChat и не срезается урезанием.

    Цену платит ИСТОРИЯ, а не источники. `trim_history` защищает последнее
    user-сообщение — то самое, где лежат и дерево, и блок «Источники», — и
    выбрасывает старые реплики, пока всё не влезет в окно. Поэтому включённое
    дерево не может ни переполнить окно, ни отнять места у найденных фрагментов;
    оно укорачивает память диалога.
    """
    captured: list[list[dict]] = []

    async def fake_stream_chat(messages, gcfg):
        captured.append([dict(m) for m in messages])
        yield "ответ"

    _install(monkeypatch, [_hit(f"{_ROOT}/Продукты/Fincert.md", 1)])
    monkeypatch.setattr(
        chat_routes, "resolve_paths", lambda request: AppPaths(root=tmp_path / "ui")
    )
    monkeypatch.setattr(chat_routes.gigachat, "stream_chat", fake_stream_chat)
    monkeypatch.setattr(chat_routes.gigachat, "_files_present", lambda gcfg: None)
    monkeypatch.setattr(
        chat_routes.settings,
        "effective_config_for",
        lambda paths=None: {
            "cognivault": {"base_url": "http://x", "token": ""},
            "gigachat": {"model": "m", "max_tokens": 4096, "model_context_tokens": 32768},
            "rag": {"mode": "auto", "max_expanded_files": 0, "corpus_tree_enabled": True},
            "prompts": {"system": None, "context_reminder": None},
        },
    )

    history = [{"role": "user", "content": f"вопрос {i} " * 200} for i in range(30)]
    question = "какие поля у витрины fincert_feeds"
    with TestClient(create_app()) as client:
        resp = client.post(
            "/api/chat",
            json={"messages": [*history, {"role": "user", "content": question}], "rag": True},
        )

    assert resp.status_code == 200
    last = captured[0][-1]["content"]
    assert last.startswith("Структура базы знаний")
    assert last.index("- Продукты [раздел: 13, пусто]") < last.index("Источники:")
    assert last.endswith(f"Вопрос: {question}")
    # И главное: окно не переполнено. Место под дерево взято из истории, а не
    # из источников и не за счёт выхода за 32k.
    from app.tokens import estimate_messages_tokens

    assert estimate_messages_tokens(captured[0]) + 4096 <= 32768


# --------------------------------------------------------------------------- #
# Четыре вопроса, ради которых шаг и делался
# --------------------------------------------------------------------------- #

_TOPIC_QUALIFIED = (
    "Какие витрины ClickHouse описаны в базе?",
    "Что лежит в разделе «Архив»?",
    "Какие страницы входят в раздел «База знаний»?",
    "Какие пользовательские инструкции есть в базе?",
)


def test_topic_qualified_questions_stay_in_retrieval():
    """Шаг 2 их специально не ловит: шаблон такой ширины начал бы ловить класс B."""
    assert [corpus_scope.match_meta(q) for q in _TOPIC_QUALIFIED] == [None] * 4


def test_the_tree_contains_what_those_four_questions_ask_for(monkeypatch):
    _install(monkeypatch, [_hit(f"{_ROOT}/Продукты/Fincert.md", 1)])
    content = _build("Какие витрины ClickHouse описаны в базе?", True).user_message[
        "content"
    ]

    # 1. Витрины ClickHouse — поддерево, а не документ: ни одна страница базы
    #    этого списка не содержит.
    assert "- ClickHouse [раздел: 3, пусто]" in content
    assert "Данные по резолюциям (afpc_inc_distr.resolutions_safp)" in content
    # 2. Раздел «Архив» — с пометкой, что он архивный.
    assert "- Архив [архив, раздел: 2, пусто]" in content
    # 3. «База знаний» — все три страницы, хотя сама страница-оглавление
    #    перечисляет не все.
    assert "- Инструкция по работе с CTL" in content
    # 4. Пользовательские инструкции разбросаны по дереву — они все на месте.
    assert content.count("Пользовательская инструкция.") >= 2


# --------------------------------------------------------------------------- #
# ИЗМЕРЕНИЕ: 56 вопросов класса B не деградируют
# --------------------------------------------------------------------------- #

_CONTROL = Path(__file__).resolve().parents[2] / "tools" / "eval" / "golden.control.json"


def _control_questions() -> list[dict]:
    if not _CONTROL.exists():  # пакет собран без набора eval
        pytest.skip(f"контрольная группа недоступна: {_CONTROL}")
    return json.loads(_CONTROL.read_text(encoding="utf-8"))["questions"]


def test_control_group_is_the_frozen_fifty_six():
    assert len(_control_questions()) == 56


def test_tree_displaces_nothing_on_the_control_group(monkeypatch):
    """Ни один из 56 отвечаемых сегодня вопросов не теряет свой источник.

    Регрессия, которой боится план, невидима для `refusal_ok` и `retrieval_hit`:
    документ найден, ответ формально не отказ — а перечисление полей витрины
    подменено перечнем разделов. Проверяется сильное свойство: при включённом
    дереве блок «Источники» СОВПАДАЕТ ПОСИМВОЛЬНО с тем, что собирается без
    него, и метаданные источников совпадают тоже. Дерево может только
    приписаться сверху.

    Почему это доказывает отсутствие вытеснения: блок источников отбирается и
    режется по своему бюджету (`rag._compute_budget`) ДО того, как структурный
    блок вообще запрашивается, и в `context_chars` он не входит.
    """
    failures: list[str] = []
    for row in _control_questions():
        _install(monkeypatch, [_hit(row["source_path"], 1)])
        off = _build(row["question"], False)
        on = _build(row["question"], True)

        content_on = on.user_message["content"]
        content_off = off.user_message["content"]
        tail_on = content_on[content_on.index("Источники:") :]
        tail_off = content_off[content_off.index("Источники:") :]

        if tail_on != tail_off:
            failures.append(f"{row['id']}: блок источников изменился")
        if on.sources != off.sources:
            failures.append(f"{row['id']}: метаданные источников изменились")
        if on.context_chars != off.context_chars:
            failures.append(f"{row['id']}: размер контекста изменился")
        if row["source_path"] not in tail_on:
            failures.append(f"{row['id']}: настоящий источник пропал")
        if on.hedge is not None:
            failures.append(f"{row['id']}: ложная оговорка")
        if not content_on.startswith("Структура базы знаний"):
            failures.append(f"{row['id']}: дерево не доехало")

    assert failures == [], f"{len(failures)} регрессий: {failures[:5]}"


def test_the_control_measurement_is_not_vacuous(monkeypatch):
    """Страховка: дерево в этих ходах ДЕЙСТВИТЕЛЬНО присутствует.

    Иначе «ничего не изменилось» означало бы «фича не включилась».
    """
    row = _control_questions()[0]
    _install(monkeypatch, [_hit(row["source_path"], 1)])
    on = _build(row["question"], True)

    head = on.user_message["content"][: on.user_message["content"].index("Источники:")]
    assert "- Продукты [раздел: 13, пусто]" in head
    assert len(head) > 500
