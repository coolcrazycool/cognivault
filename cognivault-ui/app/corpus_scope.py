"""Questions about the base itself: recognising them, and qualifying answers.

Three pure pieces, no model calls anywhere in this module:

* :func:`match_meta` — a deterministic recogniser for «что ты знаешь?» and its
  close relatives. It exists because the condense step *cannot* see them: with
  no history there is nothing to resolve against, so ``rag_pipeline.condense``
  short-circuits and the classifier never runs on the first turn — and a
  question about the assistant is almost always the first turn. On a miss it
  returns ``None`` and the caller does exactly what it did before.
* :data:`SCOPES` / :func:`parse_scope` — the ``scope`` field the condense call
  now returns alongside ``intent``. Absent, unknown or malformed ⇒
  :data:`DEFAULT_SCOPE` (``document``), which is today's behaviour. The
  tolerance is for the MODEL, not for a user: the condense prompt is read-only
  (``config_routes._readonly_prompts``), but a model that answers with a JSON
  object missing one key must not break the route.
* :func:`hedge` — the evidence-concentration caveat, shown only when the
  question was corpus-wide AND every selected fragment came from one section,
  and that section is not the base's own index page for it.

None of this touches the refusal path. The grader remains the only thing that
can decide "not in my documents": the matcher answers a question no document was
ever going to answer, and the hedge only qualifies an answer that was already
produced.

Why a matcher at all, rather than one more prompt sentence: prompts are stored
per user, so a user who saved their own ``prompts.system`` holds a frozen copy
and never receives wording added later. Code reaches everybody.
"""

from __future__ import annotations

import re
from typing import Any

# --------------------------------------------------------------------------- #
# Scope (the condense field)
# --------------------------------------------------------------------------- #

#: ``document`` — the answer is expected to live inside one document (the fields
#: of a table, the steps of a procedure). ``corpus`` — the question is about the
#: base as a whole (what products/sections/documents exist at all).
SCOPES: tuple[str, str] = ("document", "corpus")

#: What an absent/unknown ``scope`` means. Deliberately the one that changes
#: nothing: no hedge, no new branch — the behaviour that predates this field.
DEFAULT_SCOPE = "document"
CORPUS_SCOPE = "corpus"


def parse_scope(raw: Any) -> str:
    """Map the model's ``scope`` field onto :data:`SCOPES`.

    Tolerant on purpose — the field arrives from a model, so ``None``, a missing
    key, a number, or a hallucinated value all collapse to :data:`DEFAULT_SCOPE`
    rather than raising or inventing a branch.
    """
    if not isinstance(raw, str):
        return DEFAULT_SCOPE
    value = raw.strip().strip('"').lower()
    return value if value in SCOPES else DEFAULT_SCOPE


# --------------------------------------------------------------------------- #
# Meta-question matcher
# --------------------------------------------------------------------------- #

#: The two families :func:`match_meta` returns. They are NOT decoration: they
#: select different material in :func:`app.rag._build_meta` — the section tree
#: for :data:`META_CORPUS`, the assistant's own operating rules (plus the tree,
#: when available) for :data:`META_ASSISTANT` — and therefore different
#: fail-closed behaviour. A question about the base cannot be answered without
#: the base's structure; a question about the assistant always can.
META_ASSISTANT = "assistant"
META_CORPUS = "corpus"

# Longer than this and the turn is carrying subject matter, not a bare question
# about scope. A cheap guard in front of the patterns (which are anchored anyway)
# so a pathological input never walks the whole list.
_MAX_META_CHARS = 200

# Openers that carry no meaning for the match and are stripped from the head of
# every clause: greetings, politeness, and the verbs that introduce a request.
_FILLERS = (
    "привет",
    "приветствую",
    "здравствуй",
    "здравствуйте",
    "добрый день",
    "добрый вечер",
    "доброе утро",
    "слушай",
    "слушайте",
    "скажи",
    "скажите",
    "подскажи",
    "подскажите",
    "расскажи",
    "расскажите",
    # Imperatives that introduce a request and carry no meaning of their own.
    # «Перечисли разделы базы» is «разделы базы» with a verb in front; without
    # these the clause missed every pattern and fell through to retrieval, where
    # the only possible outcome is the grader's «в документах ответа не нашлось»
    # — the exact refusal this branch exists to remove.
    "перечисли",
    "перечислите",
    "покажи",
    "покажите",
    "назови",
    "назовите",
    "опиши",
    "опишите",
    "пожалуйста",
    "кстати",
    "а",
    "ну",
)
_FILLER_RE = re.compile(rf"^(?:{'|'.join(_FILLERS)})\b[\s,]*")

# Sentence split. A meta turn is often two short questions in a row («Что ты
# вообще знаешь? О чём эта база?»), and EVERY clause has to be a meta clause for
# the turn to match — see `match_meta`.
_CLAUSE_SPLIT = re.compile(r"[?!.;\n]+")

# Characters that only add noise to a match: quotes and the stray punctuation
# people leave around a question.
_STRIP_CHARS = " \t«»\"'`“”„-—–:,()[]"

#: Anchored formulations, each matched against a WHOLE clause. Two families:
#:
#: * ``assistant`` — about the assistant itself («что ты знаешь», «кто ты»,
#:   «всегда ли ответ в Markdown»);
#: * ``corpus`` — about the base as a whole («о чём эта база», «какие разделы»).
#:
#: The families select different material — see :data:`META_ASSISTANT`. The list
#: is narrow BY DESIGN: every pattern is a full-clause match with no room for a
#: topic qualifier, so «Что ты знаешь про PSI?» falls through to retrieval while
#: «Что ты знаешь?» does not. A pattern that would need a wildcard tail is a
#: pattern that belongs in retrieval.
_PATTERNS: tuple[tuple[str, str], ...] = (
    # --- about the assistant ------------------------------------------------ #
    ("assistant", r"что (?:ты |вы )?(?:вообще |ещё |еще |такого )?зна(?:ешь|ете)(?: вообще| ещё| еще)?"),
    ("assistant", r"что (?:ты |вы )?(?:вообще |ещё |еще )?(?:умеешь|умеете|можешь|можете)(?: делать)?"),
    ("assistant", r"кто (?:ты|вы)(?: такой| такая| такие)?"),
    ("assistant", r"что ты за (?:ассистент|бот|модель|помощник)(?: такой| такая)?"),
    ("assistant", r"(?:с )?чем (?:ты )?(?:можешь |умеешь )?(?:помочь|быть полезен)"),
    ("assistant", r"(?:о чем|о чём|про что) (?:ты )?(?:знаешь|можешь рассказать)"),
    ("assistant", r"(?:о себе|про себя)"),
    # --- about how the assistant works -------------------------------------- #
    #
    # A question about the assistant's own behaviour — the format of its
    # answers, where they come from — is answered from its OPERATING RULES
    # (`rag._operating_rules`), not from the corpus. There is no document in any
    # vault that describes this service, so before these patterns existed the
    # only reachable outcome was the grader's refusal (`x23-meta` of the
    # acceptance set). Still full-clause anchored: «в каком формате хранится
    # витрина?» carries a subject and goes to retrieval.
    (
        "assistant",
        r"(?:в каком (?:виде|формате)|как)(?: ты| вы)? "
        r"(?:отвечаешь|отвечаете|оформляешь ответ|оформляете ответ|"
        r"форматируешь ответ|форматируете ответ)",
    ),
    (
        "assistant",
        r"(?:всегда ли )?(?:твой |ваш |мой )?ответ(?:ы)? "
        r"(?:всегда |будет |будут )?(?:в |с )?(?:markdown|разметк[еиой]|"
        r"заголовками|разметкой)(?: с заголовками| с разметкой| и заголовками)?",
    ),
    (
        "assistant",
        r"(?:всегда ли |всегда )?(?:ты |вы )?(?:отвечаешь|отвечаете) "
        r"(?:в |с )(?:markdown|разметк[еиой]|заголовками)"
        r"(?: с заголовками| и заголовками)?",
    ),
    (
        "assistant",
        r"(?:ты |вы )?(?:используешь|используете)(?: ли)?(?: ты| вы)? "
        r"(?:markdown|разметку)(?: в ответах| в ответе)?",
    ),
    (
        "assistant",
        r"откуда (?:ты |вы )?бер[её](?:шь|те) (?:ответы|информацию|данные|факты)",
    ),
    ("assistant", r"как (?:ты |вы )?(?:работаешь|работаете|устроен|устроена)"),
    # Self-referential by construction: the clause names «ты»/«вы», so there is
    # no subject left for retrieval to look for.
    (
        "assistant",
        r"(?:какие|каких) (?:темы|тем|разделы|направления|вопросы) "
        r"(?:ты |вы )?(?:покрываешь|покрываете|охватываешь|охватываете|"
        r"знаешь|знаете)",
    ),
    (
        "assistant",
        r"на какие вопросы (?:ты |вы )?(?:можешь|можете) ответить",
    ),
    (
        "assistant",
        r"(?:какая|какие) (?:информация|документы|материалы|данные) "
        r"у (?:тебя|вас)(?: есть)?",
    ),
    # --- about the base as a whole ------------------------------------------ #
    ("corpus", r"(?:о чем|о чём|про что) (?:эта |эта твоя |твоя )?база(?: знаний)?"),
    ("corpus", r"что (?:это )?за база(?: знаний)?"),
    ("corpus", r"(?:о|об|про) (?:эту |этой )?баз[еу](?: знаний)?"),
    (
        "corpus",
        r"что (?:есть |лежит |хранится |содержится |находится )?"
        r"(?:у тебя )?в (?:твоей )?базе(?: знаний)?",
    ),
    (
        "corpus",
        r"(?:какие|каких) (?:есть )?(?:разделы|разделов|темы|тем|направления)"
        r"(?: есть)?(?: у тебя)? в (?:твоей )?базе(?: знаний)?",
    ),
    (
        "corpus",
        r"из каких разделов (?:состоит|состоит твоя) баз[аы](?: знаний)?",
    ),
    (
        "corpus",
        r"(?:какая |какова )?структур[ауы] (?:у )?базы(?: знаний)?",
    ),
    # «Какие есть разделы?» / «Разделы базы знаний» — the same question with the
    # «в базе» dropped or the verb moved. Both are full-clause anchored: the
    # noun list is closed and nothing may follow it, so «какие есть разделы у
    # витрины fincert_feeds» is not a match.
    (
        "corpus",
        r"(?:какие|каких) (?:есть )?"
        r"(?:разделы|разделов|темы|тем|направления)(?: есть)?",
    ),
    (
        "corpus",
        r"разделы базы(?: знаний)?",
    ),
    (
        "corpus",
        r"(?:о каких|про какие) (?:продуктах?|проектах?|темах?|системах?|"
        r"направлениях?) (?:ты )?(?:знаешь|есть (?:информация|данные|материалы)"
        r"(?: в базе(?: знаний)?)?)",
    ),
    (
        "corpus",
        r"какие (?:продукты|проекты|темы|разделы|направления) "
        r"(?:есть |описаны |представлены |лежат )?в базе(?: знаний)?",
    ),
    (
        "corpus",
        r"сколько (?:всего )?(?:страниц|документов|файлов|материалов) "
        r"(?:всего )?в базе(?: знаний)?"
        r"(?: и как (?:они )?(?:распределены|разложены|разбиты)"
        r"(?: по разделам)?)?",
    ),
)

_COMPILED: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (kind, re.compile(pattern)) for kind, pattern in _PATTERNS
)


def _normalise(text: str) -> str:
    """Lowercase, collapse whitespace, drop quotes and edge punctuation."""
    return " ".join(text.lower().replace("ё", "е").split()).strip(_STRIP_CHARS)


def _strip_fillers(clause: str) -> str:
    """Drop leading greetings/politeness («привет», «подскажи, …»), repeatedly."""
    text = clause
    while True:
        stripped = _FILLER_RE.sub("", text, count=1).strip(_STRIP_CHARS)
        if stripped == text:
            return text
        text = stripped


def _clause_kind(clause: str) -> str | None:
    """The family of a single clause, or ``None`` if it is not a meta clause."""
    for kind, pattern in _COMPILED:
        if pattern.fullmatch(clause):
            return kind
    return None


def match_meta(question: str) -> str | None:
    """``"assistant"`` / ``"corpus"`` for a question about the base, else ``None``.

    Deterministic, zero model calls, works on the very first turn — which is the
    whole point: the condense classifier is skipped when there is no history.

    A turn matches only when EVERY one of its clauses matches — a bare greeting
    («привет!») is not a clause, it is stripped. That is what keeps the
    recogniser honest on compound input: «Что ты вообще знаешь? О чём эта база?»
    is two meta clauses and matches; «Привет! Какие колонки в таблице
    fincert_feeds?» keeps one subject-matter clause and does not. When the
    clauses disagree in family the corpus one wins — it is the one that decides
    what the answer is built from.

    ``None`` is the fail-closed answer and covers everything not on the narrow
    list, including every topic-qualified variant: «Что ты знаешь про PSI?»
    carries a subject and must go to retrieval, where the grader can refuse.
    """
    if not question or len(question) > _MAX_META_CHARS:
        return None
    normalised = _normalise(question)
    if not normalised:
        return None

    kinds: list[str] = []
    for raw in _CLAUSE_SPLIT.split(normalised):
        clause = _strip_fillers(raw.strip(_STRIP_CHARS))
        if not clause:
            continue
        kind = _clause_kind(clause)
        if kind is None:
            return None
        kinds.append(kind)
    if not kinds:
        return None
    return META_CORPUS if META_CORPUS in kinds else META_ASSISTANT


# --------------------------------------------------------------------------- #
# Evidence-concentration hedge
# --------------------------------------------------------------------------- #

_HEDGE_HEAD = "Оговорка: вопрос охватывает базу целиком"

_HEDGE_TAIL = (
    "Ответ описывает только его и не является перечнем по всей базе; в других "
    "разделах может быть больше."
)


def _paths(sources: list[dict[str, Any]]) -> set[str]:
    """The distinct document paths behind ``sources``, blanks dropped."""
    paths = {str(s.get("path") or "") for s in sources if isinstance(s, dict)}
    paths.discard("")
    return paths


def _label(sources: list[dict[str, Any]], path: str) -> str:
    """Human-readable name of the document: its title, else the file stem."""
    for source in sources:
        if isinstance(source, dict) and str(source.get("path") or "") == path:
            title = str(source.get("title") or "").strip()
            if title and title != path:
                return title
    return path.rsplit("/", 1)[-1].rsplit(".", 1)[0] or path


def _plural_docs(n: int) -> str:
    """Russian plural of «документ» for ``n`` (1 / 2-4 / 5+)."""
    if n % 10 == 1 and n % 100 != 11:
        return "документ"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return "документа"
    return "документов"


def _concentration(
    sources: list[dict[str, Any]], containers: frozenset[str]
) -> tuple[str, int] | None:
    """``(name, n_documents)`` the evidence collapsed onto, or ``None``.

    ``n == 1`` names a document, ``n > 1`` names the single section its documents
    share — the two shapes the caveat can talk about.

    Two shapes count as concentrated, and the second is why the first is not
    enough. Chunks of ``…/Fincert/A.md`` and ``…/Fincert/B.md`` are two paths and
    used to pass as breadth, while 7.3% of the corpus sits in cross-file
    near-duplicate clusters: two sibling pages of one section are no more of a
    survey of the base than one page is.

    The exception is the whole reason this function takes ``containers``. A
    single document that is itself the index page of a section (it has
    descendants in the listing) is the base's OWN enumeration: «какие сервисы
    входят в продукт Fincert?» answered from ``Продукты/Fincert.md`` is
    complete, and a caveat there is a false alarm. All six answerable
    corpus-scope questions of the acceptance set have exactly that shape, and
    they were the only population this hedge could reach.
    """
    paths = _paths(sources)
    if not paths:
        return None
    if len(paths) == 1:
        path = next(iter(paths))
        if path in containers:
            return None
        return _label(sources, path), 1
    directories = {path.rsplit("/", 1)[0] if "/" in path else "" for path in paths}
    if len(directories) != 1:
        return None
    directory = next(iter(directories))
    if not directory:
        # Loose files in the vault root share no section — that is breadth.
        return None
    return directory.rsplit("/", 1)[-1], len(paths)


def hedge(
    scope: str,
    sources: list[dict[str, Any]] | None,
    total_docs: int | None = None,
    containers: frozenset[str] | None = None,
) -> str | None:
    """The caveat to append to a corpus-wide answer built on concentrated evidence.

    Returns ``None`` — no caveat — in every other case, and those cases are the
    point:

    * ``scope != "corpus"``: a question about one document answered from that
      document is exactly right, and the 56 control questions («перечисли все
      поля витрины X») live here. Since :func:`parse_scope` maps a missing field
      to ``document``, a failed, disabled or skipped condense call cannot produce
      a caveat either;
    * evidence from two or more sections: the answer already spans the base,
      which is what a corpus-wide question needs;
    * evidence concentrated on a section's own index page: that page IS the
      enumeration the question asked for (see :func:`_concentration`);
    * no sources at all: there is no answer to qualify (the grader's refusal
      path never reaches here);
    * ``containers is None``: the shape of the base could not be established
      this turn, so the container exception cannot be evaluated. Silence is the
      fail-closed answer — the caveat's only reachable population without it is
      the one where it is wrong.

    The text names what the evidence collapsed onto and the size of the base
    rather than hedging in the abstract, because "this may be incomplete" on
    every answer trains the reader to skip it. ``total_docs`` is omitted from the
    sentence when unknown — an invented denominator would be worse than none.
    """
    if scope != CORPUS_SCOPE or not sources:
        return None
    if isinstance(total_docs, int) and total_docs <= 1:
        return None
    if containers is None:
        return None
    found = _concentration(list(sources), containers)
    if found is None:
        return None
    name, count = found

    known_total = isinstance(total_docs, int) and total_docs > 1
    scale = f" из {total_docs} в базе" if known_total else ""
    subject = (
        f"из одного документа «{name}»{scale}"
        if count == 1
        else f"из одного раздела «{name}» — {count} {_plural_docs(count)}{scale}"
    )
    return f"{_HEDGE_HEAD}, а все найденные фрагменты — {subject}. {_HEDGE_TAIL}"
