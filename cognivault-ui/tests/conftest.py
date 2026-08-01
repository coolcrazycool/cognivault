"""Общие предусловия для всех тестов UI.

Единственная задача: сделать тесты ГЕРМЕТИЧНЫМИ по отношению к листингу вольта.
`app.corpus_map` тянет ``GET /api/vault/files`` на каждом RAG-ходе, и без этой
фикстуры любой тест чата ходил бы в сеть (по дефолтному
``http://localhost:3000``), а его результат зависел бы от того, поднят ли у
разработчика бэкенд. По умолчанию листинг здесь НЕДОСТУПЕН — ровно тот случай,
в котором блок «состав базы» обязан молча исчезнуть, поэтому все остальные
тесты продолжают проверять прежний промпт слово в слово.

Подменяется именно `corpus_map.files` — шов, за которым нет никого, кроме
`corpus_map.corpus_block`. Подмена `cognivault.list_files` тут не годится: её
же зовёт `clear_vault` в тестах Confluence-синка, которые мокают транспорт, а
не функцию. Тест, которому нужен настоящий загрузчик листинга, возвращает его
на место сам (см. `tests/test_corpus_map.py`).

То же самое со ВТОРЫМ сетевым источником структуры — каталогом
(`GET /api/vault/catalog`, шов `catalog.payload`). Он появился в шаге 3 и его
читают оба блока: дерево разделов целиком и блок «состав базы» — ради одного
поля `document_extensions`, то есть ради определения, что вообще считать
документом. Заглушка возвращает «каталог недоступен»: и дерева, и футпринта в
этом случае нет, поэтому прежние тесты по-прежнему сверяют промпт слово в слово.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import catalog, corpus_map  # noqa: E402


@pytest.fixture(autouse=True)
def _no_vault_listing(monkeypatch):
    """Нет листинга и каталога — нет структурного блока (если тест не решит иначе)."""
    corpus_map.reset_cache()
    catalog.reset_cache()

    async def _unavailable(cv=None):
        return None

    monkeypatch.setattr(corpus_map, "files", _unavailable)
    monkeypatch.setattr(catalog, "payload", _unavailable)
    yield
    corpus_map.reset_cache()
    catalog.reset_cache()
