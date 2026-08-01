"""Консервативная оценка токенов и обрезка истории под контекст модели.

Точного токенайзера GigaChat у нас нет, а ``cl100k`` (tiktoken) на русском
тексте недосчитывает примерно 20% реальных токенов GigaChat. Поэтому здесь
используется грубая, но заведомо консервативная эвристика:
:data:`CHARS_PER_TOKEN` символов на токен. Переоценить объём безопаснее, чем
упереться в 32k-контекст и получить обрыв ответа.

Эта величина — **единственная** в проекте: ``rag._compute_budget`` считает
символьный бюджет контекста по ней же. Раньше рядом жила вторая константа
(2.0 в ``rag.py``), и от переполнения окна защищала более оптимистичная из двух.

Без внешних зависимостей — только стандартная библиотека.
"""

from __future__ import annotations

import math
from typing import Any

# Символов на токен: компромисс для русского текста вперемешку с кодом и
# markdown-таблицами (у чистой кириллицы отношение выше, у кода/таблиц — ниже).
# Публичное имя: значение переиспользует `app.rag._compute_budget`.
CHARS_PER_TOKEN = 2.5
# Историческое приватное имя — алиас той же величины.
_CHARS_PER_TOKEN = CHARS_PER_TOKEN
# Оверхед на одно сообщение: роль + служебные разделители чат-разметки.
_PER_MESSAGE_OVERHEAD_TOKENS = 4


def estimate_tokens(text: str) -> int:
    """Оценить число токенов в ``text`` как ``ceil(len(text) / CHARS_PER_TOKEN)``.

    Сознательно завышенная оценка: для кириллицы GigaChat расходует токенов
    больше, чем показывает ``cl100k``.
    """
    if not text:
        return 0
    return int(math.ceil(len(text) / CHARS_PER_TOKEN))


def estimate_messages_tokens(messages: list[dict[str, Any]]) -> int:
    """Оценить число токенов списка сообщений ``{role, content}``.

    Сумма оценок по ``content`` плюс небольшой фиксированный оверхед на каждое
    сообщение (роль и разделители чат-разметки).
    """
    total = 0
    for msg in messages:
        total += estimate_tokens(str(msg.get("content", "") or ""))
        total += _PER_MESSAGE_OVERHEAD_TOKENS
    return total


def _last_user_index(messages: list[dict[str, Any]]) -> int:
    """Индекс последнего ``user``-сообщения (или последнего сообщения вообще)."""
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            return i
    return len(messages) - 1


def trim_history(
    messages: list[dict[str, Any]], budget_tokens: int
) -> tuple[list[dict[str, Any]], int]:
    """Урезать историю диалога под ``budget_tokens``.

    Отбрасываются только *старые* сообщения — парами (user+assistant) с головы
    списка, пока оценка не уложится в бюджет. Последнее ``user``-сообщение
    сохраняется **всегда**, даже если оно одно превышает бюджет: лучше отправить
    заведомо длинный вопрос и получить ошибку модели, чем отправить пустой чат.
    Порядок и парность оставшихся сообщений не нарушаются.

    Возвращает ``(усечённый список, число отброшенных сообщений)``.
    Системные сообщения сюда передавать не нужно — их стоимость учитывается
    вызывающей стороной в самом ``budget_tokens``.
    """
    if not messages:
        return [], 0
    if estimate_messages_tokens(messages) <= budget_tokens:
        return list(messages), 0

    keep_from = _last_user_index(messages)
    head = list(messages[:keep_from])
    tail = list(messages[keep_from:])

    dropped = 0
    while dropped < len(head) and estimate_messages_tokens(
        head[dropped:] + tail
    ) > budget_tokens:
        dropped += 2
    dropped = min(dropped, len(head))
    return head[dropped:] + tail, dropped
