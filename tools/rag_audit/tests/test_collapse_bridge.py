"""Тесты моста к `SearchService.collapseCrossFileDuplicates`.

Стадия схлопывания копий между файлами — ЕДИНСТВЕННАЯ в хвосте прода, которая
зависит от текста запроса, и единственная, которую нельзя посчитать формулой:
в ней шесть решений (порог Жаккара, пол по числу различных слов, `WORD_PATTERN`,
снятие аннотации документа, освобождение для чанков одного файла, защита по слову
запроса). Поэтому она не переписана, а вызвана — и здесь проверяется, что вызов
устроен правильно: конвейер зовёт стадию продовым порядком, стадия ходит в мост,
мост отдаёт номера документов.

Настоящий `npx tsx` дёргает ровно один тест — он же проверяет контракт моста
end-to-end. Остальные работают на подмене: предмет проверки здесь маршрутизация,
а не схлопывание (его тесты — `tools/rag_audit/collapse_duplicates.test.ts` и
`src/features/search/__tests__/`).
"""

from __future__ import annotations

import numpy as np

import audit_retrieval
from audit_retrieval import (
    POST_STAGES,
    Chunk,
    CollapseBridge,
    StageContext,
    apply_stages,
    default_post_pipeline,
)


def chunk(path: str, text: str, chunk_index: int = 0, parent_id: str = "") -> Chunk:
    return Chunk(
        path=path,
        title="t",
        chunk_index=chunk_index,
        section_path="",
        parent_id=parent_id,
        content_kind="text",
        tokens=1,
        chars=len(text),
        text=text,
    )


def context(chunks: list[Chunk], query: str = "вопрос", limit: int = 10) -> StageContext:
    return StageContext(
        query_text=query,
        chunks=chunks,
        dense_docs=np.zeros((len(chunks), 2)),
        dense_query=np.zeros(2),
        fused_scores={i: 1.0 - i / 100 for i in range(len(chunks))},
        limit=limit,
    )


def words(count: int, prefix: str = "слово") -> str:
    """Тело из `count` различных слов — порог `NEAR_DUPLICATE_MIN_TERMS` = 20."""
    return " ".join(f"{prefix}{i}" for i in range(count))


# --------------------------------------------------------------------------- #
# Продовый конвейер
# --------------------------------------------------------------------------- #


def test_default_pipeline_mirrors_the_prod_tail_in_prod_order() -> None:
    """`SearchService.hybrid`: dedupeChunks → dedupeSections → collapse → slice.

    Схлопывание зовётся в бою ВСЕГДА, а не только при `group_by_section`, —
    иначе аудит мерил бы конвейер, которого нет.
    """
    assert default_post_pipeline(True) == (
        ("dedupe_chunks", {}),
        ("group_by_section", {}),
        ("collapse_cross_file_duplicates", {}),
    )
    assert default_post_pipeline(False) == (
        ("dedupe_chunks", {}),
        ("collapse_cross_file_duplicates", {}),
    )


def test_stage_delegates_to_the_bridge_and_keeps_its_answer(monkeypatch) -> None:
    seen: list[tuple[str, list[int]]] = []

    class FakeBridge:
        def collapse(self, query: str, docs: list[int]) -> list[int]:
            seen.append((query, list(docs)))
            return [docs[0]]

    monkeypatch.setattr(audit_retrieval, "collapse_bridge", lambda chunks: FakeBridge())
    chunks = [chunk("a.md", "альфа"), chunk("b.md", "бета")]
    ctx = context(chunks, query="как устроена витрина")

    assert POST_STAGES["collapse_cross_file_duplicates"]([0, 1], ctx, {}) == [0]
    assert seen == [("как устроена витрина", [0, 1])]


def test_slice_to_limit_happens_after_collapse(monkeypatch) -> None:
    """Порядок из `hybrid()`: сначала всё, что стадии выбрасывают, выброшено, и
    только потом срез. Резать раньше значило бы отдавать «сколько уцелело»."""

    class FakeBridge:
        def collapse(self, query: str, docs: list[int]) -> list[int]:
            return [doc for doc in docs if doc != 0]

    monkeypatch.setattr(audit_retrieval, "collapse_bridge", lambda chunks: FakeBridge())
    chunks = [chunk(f"{i}.md", "текст", chunk_index=i) for i in range(4)]
    ctx = context(chunks, limit=2)

    assert apply_stages([0, 1, 2, 3], ctx, default_post_pipeline(False)) == [1, 2]


def test_bridge_is_reused_for_one_corpus_and_recharged_for_another(monkeypatch) -> None:
    """Мост стоит секунду на старте, а зовут его сотни раз за прогон: он обязан
    быть один на корпус. И обязан перезаряжаться, когда корпус сменился, —
    иначе свип по двум корпусам считал бы второй по текстам первого."""
    built: list[int] = []

    class FakeBridge:
        def __init__(self, chunks) -> None:
            self.chunks = chunks
            built.append(len(chunks))

        def close(self) -> None:
            pass

    monkeypatch.setattr(audit_retrieval, "CollapseBridge", FakeBridge)
    monkeypatch.setattr(audit_retrieval, "_COLLAPSE_BRIDGE", None)

    first = [chunk("a.md", "альфа")]
    second = [chunk("b.md", "бета"), chunk("c.md", "гамма")]
    try:
        assert audit_retrieval.collapse_bridge(first) is audit_retrieval.collapse_bridge(first)
        audit_retrieval.collapse_bridge(second)
        assert built == [1, 2]
    finally:
        audit_retrieval.close_collapse_bridge()


# --------------------------------------------------------------------------- #
# Настоящий мост
# --------------------------------------------------------------------------- #


def test_bridge_runs_the_real_typescript_stage() -> None:
    """Единственный тест, который реально запускает tsx: он же и проверяет
    контракт. Проверяются те свойства продовой стадии, которые питоновская копия
    потеряла бы молча."""
    shared = words(40)
    chunks = [
        chunk("a.md", f"{shared} дбо"),
        chunk("b.md", f"{shared} юрлиц"),
        chunk("c.md", words(10, "мало")),
        chunk("c.md", words(10, "мало"), chunk_index=1),
        chunk("d.md", words(40, "своё")),
    ]
    bridge = CollapseBridge(chunks)
    try:
        # 1) Копия между файлами схлопывается, самобытный документ — нет.
        assert bridge.collapse("как устроена витрина", [0, 1, 4]) == [0, 4]
        # 2) …но копия, несущая слово ЗАПРОСА, которого нет у выжившего, остаётся.
        assert bridge.collapse("витрина канала юрлиц", [0, 1, 4]) == [0, 1, 4]
        # 3) Два одинаковых чанка ОДНОГО файла не сравниваются вовсе, а короткие
        #    тела не судятся по Жаккару (пол по числу различных слов).
        assert bridge.collapse("вопрос", [2, 3]) == [2, 3]
        # 4) Порядок выдачи сохраняется, номера документов ездят туда-обратно.
        assert bridge.collapse("вопрос", [4, 0]) == [4, 0]
        # 5) Пустой список кандидатов не стоит похода в мост.
        assert bridge.collapse("вопрос", []) == []
    finally:
        bridge.close()
