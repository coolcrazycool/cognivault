"""Хуки и варианты для вопроса «из чего должен строиться ПЛОТНЫЙ вектор».

Файл подаётся `audit_retrieval.py --hooks`; сам инструмент при этом не правится.

Меряется две вещи.

1. **Аннотация документа (`INDEX_DOC_SUMMARY`, в проде ВКЛЮЧЕНА по умолчанию).**
   `src/plugins/pipeline.ts` просит у GigaChat описание документа в 1–2 предложения
   и ставит его перед текстом КАЖДОГО чанка этого файла — но только в плотный
   текст: разреженный вектор строится из `Chunk.lexicalText`, чтобы одна и та же
   аннотация не залила лексический индекс одинаковыми термами. Офлайн-корпус
   аннотаций не несёт вовсе, поэтому все плотные числа, посчитанные до сих пор,
   описывают состояние `INDEX_DOC_SUMMARY=false`, а прод работает с true.

   Тексты аннотаций синтезирует `doc_annotations.ts` (см. его шапку: вход — тот же
   срез, что видит промпт, кап — настоящий `capDocSummary`). Здесь они только
   приставляются — ровно так, как это делает `enrichChunks`:
   `${DOC_SUMMARY_PREFIX}${summary}\n\n${chunk.text}`, и только к плотной стороне.

2. **Состав плотного текста вообще** — крошка, заголовок, повтор пути. Композеры
   ниже трогают ТОЛЬКО плотную сторону: разреженная в проде уже настроена
   (`buildDocumentSparseVector` весит первую строку), и менять её здесь значило бы
   мерить два решения одним числом.

ВАЖНО о переносимости: плотные вектора здесь считает `multilingual-e5-base`, в проде —
GigaChat EmbeddingsGigaR. Эффекты СОСТАВА текста модельно-специфичны сильнее всего
измеренного до сих пор — инструмент помечает такие варианты `transfer: гипотеза для
живой проверки`, и это не формальность.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from audit_retrieval import Chunk, register_doc_composer, register_variant

# --------------------------------------------------------------------------- #
# Аннотации: загрузка того, что синтезировал doc_annotations.ts
# --------------------------------------------------------------------------- #

#: Где лежит выход `doc_annotations.ts`. Переопределяется переменной окружения, чтобы
#: один и тот же hooks-файл работал на любом каталоге прогона.
ANNOTATIONS_PATH = Path(
    os.environ.get("RAG_AUDIT_ANNOTATIONS", "/tmp/audit-doc/annotations.json")
)

_ANNOTATIONS: dict[str, Any] | None = None


def _annotations() -> dict[str, Any]:
    """Ленивая загрузка: hooks-файл импортируется раньше, чем читаются чанки."""
    global _ANNOTATIONS
    if _ANNOTATIONS is None:
        if not ANNOTATIONS_PATH.exists():
            raise SystemExit(
                f"нет файла аннотаций {ANNOTATIONS_PATH}; сначала "
                f"`npx tsx tools/rag_audit/doc_annotations.ts <chunks.jsonl> <out.json>` "
                f"(путь переопределяется RAG_AUDIT_ANNOTATIONS)"
            )
        _ANNOTATIONS = json.loads(ANNOTATIONS_PATH.read_text(encoding="utf-8"))
    return _ANNOTATIONS


def _annotate(chunk: Chunk, flavour: str) -> str:
    """`enrichChunks` дословно: префикс, аннотация, пустая строка, текст чанка.

    Документ, для которого аннотации нет, проходит насквозь — так же ведёт себя прод,
    когда `resolveDocSummary` вернул `undefined` (модель недоступна, ответ пуст).
    """
    data = _annotations()
    prefix = str(data["prefix"])
    summary = data["annotations"].get(chunk.path, {}).get(flavour)
    if not summary:
        return chunk.text
    return f"{prefix}{summary}\n\n{chunk.text}"


@register_doc_composer("anno_realistic")
def _dc_anno_realistic(chunk: Chunk) -> str:
    """Правдоподобная аннотация: заголовок + собственная вводная проза документа +
    его первые разделы. Верхняя граница осмысленности такого описания."""
    return _annotate(chunk, "realistic")


@register_doc_composer("anno_topics")
def _dc_anno_topics(chunk: Chunk) -> str:
    """Структурная аннотация: заголовок + перечень разделов. Ровно то, что модель
    отвечает про страницу, состоящую из таблиц и не имеющую вводной прозы."""
    return _annotate(chunk, "topics")


@register_doc_composer("anno_generic")
def _dc_anno_generic(chunk: Chunk) -> str:
    """Пол: ОДНА и та же канцелярская фраза на все документы корпуса. Несёт нулевой
    документо-специфичный сигнал и стоит ровно столько же места."""
    return _annotate(chunk, "generic")


# --------------------------------------------------------------------------- #
# Состав плотного текста
# --------------------------------------------------------------------------- #


def _strip_breadcrumb(chunk: Chunk) -> str:
    crumb = chunk.section_path + "\n"
    if chunk.section_path and chunk.text.startswith(crumb):
        return chunk.text[len(crumb) :].lstrip("\n")
    return chunk.text


@register_doc_composer("anno_realistic_no_crumb")
def _dc_anno_no_crumb(chunk: Chunk) -> str:
    """Аннотация ВМЕСТО крошки: проверка гипотезы «аннотация уже несёт то, ради чего
    крошка стоит в тексте», а не «аннотация добавлена сверх неё»."""
    data = _annotations()
    summary = data["annotations"].get(chunk.path, {}).get("realistic")
    body = _strip_breadcrumb(chunk)
    if not summary:
        return body
    return f"{data['prefix']}{summary}\n\n{body}"


@register_doc_composer("crumb_tail")
def _dc_crumb_tail(chunk: Chunk) -> str:
    """Крошка сокращена до последнего звена: `A > B > C` → `C`.

    Полный путь повторяет название файла и всех предков в каждом чанке; вопрос в том,
    несёт ли что-то хвост сверх заголовка или только разбавляет вектор.
    """
    if not chunk.section_path:
        return chunk.text
    tail = chunk.section_path.split(" > ")[-1].strip()
    crumb = chunk.section_path + "\n"
    if chunk.text.startswith(crumb):
        return f"{tail}\n{chunk.text[len(crumb) :]}"
    return chunk.text


@register_doc_composer("repeat_crumb")
def _dc_repeat_crumb(chunk: Chunk) -> str:
    """Путь заголовков повторён ещё раз в хвосте чанка: усиление той же темы без
    добавления новой информации. Контроль к аннотации — она тоже усиливает тему."""
    if not chunk.section_path:
        return chunk.text
    return f"{chunk.text}\n\n{chunk.section_path}"


@register_doc_composer("strip_h1")
def _dc_strip_h1(chunk: Chunk) -> str:
    """Снимает строку `# Заголовок`, дублирующую крошку.

    В этом корпусе первый чанк каждой страницы Confluence несёт название трижды:
    крошкой, H1 и обычно первой фразой. Тройной повтор — самая тяжёлая часть вектора
    первого чанка, а именно первый чанк чаще всего и есть правильный ответ.
    """
    lines = chunk.text.split("\n")
    kept = [line for line in lines if line.strip() != f"# {chunk.title}"]
    if len(kept) == len(lines):
        return chunk.text
    text = "\n".join(kept)
    while "\n\n\n" in text:
        text = text.replace("\n\n\n", "\n\n")
    return text


@register_doc_composer("title_only_crumb")
def _dc_title_only_crumb(chunk: Chunk) -> str:
    """Крошка сокращена до названия файла: путь предков выброшен, документ остаётся
    узнаваемым. Между `as_indexed` и `strip_breadcrumb`."""
    if not chunk.section_path or not chunk.title:
        return chunk.text
    crumb = chunk.section_path + "\n"
    if chunk.text.startswith(crumb):
        return f"{chunk.title}\n{chunk.text[len(crumb) :]}"
    return chunk.text


# --------------------------------------------------------------------------- #
# Варианты
# --------------------------------------------------------------------------- #
#
# Каждый вариант меняет ОДНО решение и только на ПЛОТНОЙ стороне: `doc.sparse`
# остаётся `as_indexed`, потому что в проде разреженный вектор строится из
# `Chunk.lexicalText` — то есть из неаннотированного текста. Вариант, тронувший обе
# стороны, смешал бы два решения в одном числе.


def _dense_doc(name: str, composer: str) -> dict[str, Any]:
    return {"name": name, "doc": {"dense": composer, "sparse": "as_indexed"}}


# --- три состояния фичи, которая в проде включена ---------------------------
register_variant(_dense_doc("anno-realistic", "anno_realistic"))
register_variant(_dense_doc("anno-topics", "anno_topics"))
register_variant(_dense_doc("anno-generic", "anno_generic"))

# --- состав плотного текста -------------------------------------------------
register_variant(_dense_doc("comp-no-crumb", "strip_breadcrumb"))
register_variant(_dense_doc("comp-crumb-tail", "crumb_tail"))
register_variant(_dense_doc("comp-title-crumb", "title_only_crumb"))
register_variant(_dense_doc("comp-repeat-crumb", "repeat_crumb"))
register_variant(_dense_doc("comp-prepend-title", "prepend_title"))
register_variant(_dense_doc("comp-strip-h1", "strip_h1"))

# --- комбинация: аннотация вместо крошки ------------------------------------
register_variant(_dense_doc("anno-instead-of-crumb", "anno_realistic_no_crumb"))

# --- вырожденные ветки, чтобы видеть плотную сторону без слияния -------------
register_variant(
    {
        "name": "dense-only-prod",
        "fusion": {"mode": "dense"},
    }
)
register_variant(
    {
        "name": "dense-only-anno",
        "fusion": {"mode": "dense"},
        "doc": {"dense": "anno_realistic", "sparse": "as_indexed"},
    }
)
