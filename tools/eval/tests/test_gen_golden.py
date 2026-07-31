"""Tests for the golden-set generator: markdown splitter, selection, row shape."""

from __future__ import annotations

import asyncio
import os
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gen_golden import (  # noqa: E402
    BackendClient,
    Fragment,
    extract_paths,
    pairs_from_verdict,
    select_fragments,
    split_fragments,
    write_jsonl,
)

DOC = """---
title: Индексация
---

# Индексация

Общее описание процесса индексации вольта, которого хватает на осмысленный
фрагмент: поллер обходит директорию, сравнивает mtime и размер, затем считает
хэш содержимого и ставит файл в очередь на чанкинг и эмбеддинг.

## Чанкер

Чанкер режет документ по markdown-заголовкам, целевой размер чанка — от ста до
пятисот токенов cl100k, overlap отсутствует, в текст чанка добавляется
breadcrumb из заголовков документа.

```python
# ## Это не заголовок, а комментарий внутри кода
print("hi")
```

## Эмбеддинги

Эмбеддинги считает EmbeddingsGigaR через mTLS; размер вектора задаётся
переменной EMBEDDING_DIMENSIONS, а сам вектор кладётся в Qdrant вместе с
payload, где лежат path, chunk_index и section_path.
"""


def test_split_by_headings_builds_breadcrumbs():
    fragments = split_fragments("docs/index.md", DOC, min_chars=100)
    paths = [f.section_path for f in fragments]
    assert paths == [
        "Индексация",
        "Индексация > Чанкер",
        "Индексация > Эмбеддинги",
    ]


def test_headings_inside_code_fence_are_ignored():
    fragments = split_fragments("docs/index.md", DOC, min_chars=100)
    chunker = [f for f in fragments if f.section_path.endswith("Чанкер")][0]
    assert "не заголовок" in chunker.text
    assert len([f for f in fragments if "не заголовок" in f.section_path]) == 0


def test_front_matter_is_stripped():
    fragments = split_fragments("docs/index.md", DOC, min_chars=100)
    assert all("title: Индексация" not in f.text for f in fragments)


def test_long_section_is_packed_by_paragraphs():
    para = "Абзац про очень важные детали конфигурации. " * 10  # ~440 chars
    doc = "# H1\n\n" + "\n\n".join([para] * 8)
    fragments = split_fragments("a.md", doc, max_chars=1000, min_chars=100)
    assert len(fragments) > 1
    assert all(len(f.text) <= 1000 for f in fragments)
    # paragraphs are never cut in half
    assert all(f.text.strip().endswith(".") for f in fragments)


def test_small_tail_sections_are_merged_or_dropped():
    doc = "# A\n\nкоротко\n\n## B\n\nтоже коротко\n"
    assert split_fragments("a.md", doc, min_chars=400) == []
    merged = split_fragments("a.md", doc, min_chars=10)
    assert merged and merged[0].section_path == "A"


def test_fragment_id_is_stable_and_distinct():
    a = Fragment("a.md", "S", "текст фрагмента")
    b = Fragment("a.md", "S", "текст фрагмента")
    c = Fragment("a.md", "S", "другой текст")
    assert a.fragment_id() == b.fragment_id()
    assert a.fragment_id() != c.fragment_id()
    assert a.title == "a"


def test_select_fragments_is_deterministic_and_spreads_over_files():
    fragments = [
        Fragment(f"doc{i}.md", f"S{j}", f"текст {i}-{j}")
        for i in range(3)
        for j in range(5)
    ]
    first = select_fragments(fragments, 6, seed=42)
    second = select_fragments(fragments, 6, seed=42)
    assert [f.text for f in first] == [f.text for f in second]
    assert len({f.path for f in first}) == 3  # round-robin across documents


def test_select_fragments_caps_at_available():
    fragments = [Fragment("a.md", "S", "t")]
    assert len(select_fragments(fragments, 10, seed=1)) == 1


def test_pairs_from_verdict_row_shape():
    fragment = Fragment("docs/a.md", "Индексация > Чанкер", "текст")
    rows = pairs_from_verdict(
        fragment,
        {
            "factual": {"question": "Какой overlap?", "ground_truth": "Нулевой."},
            "practical": {"question": "Как настроить?", "ground_truth": "Через ENV."},
        },
    )
    assert [r["kind"] for r in rows] == ["factual", "practical"]
    assert all(r["accepted"] is None for r in rows)
    assert rows[0]["source_path"] == "docs/a.md"
    assert rows[0]["section_path"] == "Индексация > Чанкер"
    assert set(rows[0]) == {
        "id",
        "question",
        "ground_truth",
        "kind",
        "source_path",
        "section_path",
        "accepted",
    }


def test_pairs_from_verdict_skips_nulls_and_blanks():
    fragment = Fragment("a.md", "S", "текст")
    rows = pairs_from_verdict(
        fragment,
        {
            "factual": None,
            "practical": {"question": "Как?", "ground_truth": "  "},
        },
    )
    assert rows == []


def test_write_jsonl_keeps_cyrillic_raw(tmp_path):
    out = tmp_path / "golden.jsonl"
    write_jsonl([{"id": "a", "question": "Привет?"}], str(out))
    text = out.read_text(encoding="utf-8")
    assert "Привет?" in text
    assert "\\u04" not in text


# --------------------------------------------------------------------------- #
# Backend client
# --------------------------------------------------------------------------- #


def test_extract_paths_tolerates_shapes():
    assert extract_paths(["a.md", "b.md"]) == ["a.md", "b.md"]
    assert extract_paths({"files": [{"path": "a.md"}, {"path": "d", "type": "dir"}]}) == [
        "a.md"
    ]
    assert extract_paths({"results": [{"name": "c.md"}]}) == ["c.md"]
    assert extract_paths({}) == []


def test_backend_client_sends_bearer_and_reads_content():
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen[request.url.path] = dict(request.url.params)
        seen["auth"] = request.headers.get("Authorization")
        if request.url.path == "/api/vault/files":
            return httpx.Response(200, json={"files": ["docs/a.md"]})
        return httpx.Response(200, json={"path": "docs/a.md", "content": "# Док"})

    async def go():
        async with BackendClient(
            "http://backend", "tkn", transport=httpx.MockTransport(handler)
        ) as client:
            files = await client.list_files()
            body = await client.content("docs/a.md")
            return files, body

    files, body = asyncio.run(go())
    assert files == ["docs/a.md"]
    assert body == "# Док"
    assert seen["auth"] == "Bearer tkn"
    assert seen["/api/vault/files"] == {"recursive": "true"}
