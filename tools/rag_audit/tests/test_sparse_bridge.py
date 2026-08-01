"""Тесты моста к разреженным построителям — стороны индекса не должны путаться.

Прод считает документ и запрос РАЗНЫМИ функциями `bm25.ts`: индексная сторона зовёт
`buildDocumentSparseVector` (крошка чанка весит `BM25_BREADCRUMB_BOOST`), запросная —
`buildSparseVector`. Аудит однажды гонял обе через запросный построитель: форма вектора
та же, веса другие, и замер молча описывал систему, которой нет. Здесь это закреплено:
кэш различает стороны, а прогон варианта запрашивает у моста именно ту сторону, что
соответствует тексту.

Сам `npx tsx` не запускается — проверяется маршрутизация, а не токенизация (её тесты
живут в `src/lib/__tests__/bm25.test.ts`).
"""

from __future__ import annotations

import json
import subprocess

import pytest

import audit_retrieval
from audit_retrieval import REPO_ROOT, SparseMemo, sparse_vectors


def test_memo_keys_by_side_so_one_text_can_be_both_document_and_query(monkeypatch) -> None:
    calls: list[tuple[tuple[str, ...], str]] = []

    def fake(texts, kind):
        calls.append((tuple(texts), kind))
        # Различимая «подпись» стороны — сам вектор здесь неважен.
        return [{"indices": [1], "values": [1.0 if kind == "document" else 2.0]} for _ in texts]

    monkeypatch.setattr(audit_retrieval, "sparse_vectors", fake)
    memo = SparseMemo()

    as_document = memo.vectors(["крошка\n\nтело"], "document")
    as_query = memo.vectors(["крошка\n\nтело"], "query")

    assert as_document != as_query, "документ и запрос не должны делить один ключ кэша"
    assert [kind for _, kind in calls] == ["document", "query"]
    assert memo.computed == 2

    # Повтор той же стороны кэшируется, как и раньше.
    memo.vectors(["крошка\n\nтело"], "document")
    assert memo.computed == 2


def test_memo_rejects_an_unknown_side() -> None:
    with pytest.raises(SystemExit):
        SparseMemo().vectors(["текст"], "документ")


def test_bridge_requires_the_side_and_weights_the_breadcrumb_only_for_documents(tmp_path) -> None:
    """Единственный тест, который реально дёргает tsx: он же и проверяет контракт."""
    script = REPO_ROOT / "tools" / "rag_audit" / "sparse_vectors.ts"
    chunk = "Реестр витрин / afpc_sss_src\n\nвитрина загружается ежедневно"

    def run(payload: dict) -> subprocess.CompletedProcess:
        in_path = tmp_path / "in.json"
        out_path = tmp_path / "out.json"
        in_path.write_text(json.dumps(payload), encoding="utf-8")
        return subprocess.run(
            ["npx", "tsx", str(script), str(in_path), str(out_path)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    if run({"kind": "query", "texts": []}).returncode != 0:
        pytest.skip("npx tsx недоступен")

    # Пропуск стороны — громкая ошибка, а не тихий дефолт.
    missing = run({"texts": [chunk]})
    assert missing.returncode == 2
    assert "kind" in missing.stderr

    document = sparse_vectors([chunk], "document")[0]
    query = sparse_vectors([chunk], "query")[0]

    # Термы одни и те же — расходятся только веса, и только у документа.
    assert set(document["indices"]) == set(query["indices"])
    assert document["values"] != query["values"]
