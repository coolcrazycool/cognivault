/**
 * Lexical (sparse) side of the hybrid retrieval pipeline.
 *
 * Turns free text into a Qdrant sparse vector. Used in exactly two places:
 *  - indexing: the chunk text, stored as the `bm25` named vector of each point;
 *  - querying: the standalone question, sent as the sparse prefetch branch.
 * Both paths MUST go through the same functions — if tokenization drifts between
 * them, terms stop lining up and the lexical branch silently returns nothing.
 *
 * Only the term-frequency part of BM25 is computed here. The IDF factor is applied
 * server-side by Qdrant via `sparse_vectors: { bm25: { modifier: 'idf' } }`, so the
 * corpus statistics never have to be maintained in this process.
 */

/** Named vector holding the BM25 sparse representation in Qdrant. */
export const BM25_VECTOR_NAME = 'bm25';

/** Named vector holding the dense embedding in Qdrant. */
export const DENSE_VECTOR_NAME = 'dense';

/**
 * Version of the tokenization + weighting scheme. Bump it whenever tokenize()
 * changes in a way that alters the produced indices, or whenever the weights
 * change enough that old and new points can no longer be ranked against each
 * other.
 *
 * It is enforced, not decorative. `src/plugins/qdrant.ts` stamps this value onto
 * the collection it creates (payload `bm25_scheme_version` on the marker point
 * `SCHEME_POINT_ID`) and compares it on every start. A collection built at an
 * older version keeps serving — dense retrieval is unaffected — but startup logs
 * an error naming both versions and the metric `cognivault_bm25_scheme_mismatch`
 * goes to 1, so a deploy without the required re-index is no longer silent.
 *
 * v2 — {@link BM25_AVG_LEN} corrected to the measured corpus average.
 * v3 — {@link tokenize} emits the whole compound identifier alongside its fragments,
 *      and {@link buildDocumentSparseVector} boosts the breadcrumb's term frequencies.
 */
export const BM25_SCHEME_VERSION = 3;

// --- BM25 term-frequency saturation parameters -------------------------------
// value = tf * (k1 + 1) / (tf + k1 * (1 - b + b * len / AVG_LEN))
/** Term-frequency saturation. Standard BM25 default; higher = less saturation. */
export const BM25_K1 = 1.2;
/** Length-normalization strength. Standard BM25 default; 0 = no normalization. */
export const BM25_B = 0.75;
/**
 * Average document length, in {@link tokenize} tokens. A live average would require
 * corpus statistics shared between the indexer and the query path; a fixed constant
 * keeps the module stateless.
 *
 * Measured, not guessed: 128 is the mean over the 1875 chunks the chunker produces
 * from this repository's 232 markdown files (median 116, p90 226). The previous value
 * of 300 was a guess off the cl100k chunk budget — but `tokenize()` drops stop words
 * and one-character tokens, so it yields far fewer terms than cl100k does. Overstating
 * the average by 2.3x flattens length normalization: it turned the nominal b = 0.75
 * into an effective ~0.34, which is most of the way to switching normalization off.
 * Changing it changes scoring, so it is part of {@link BM25_SCHEME_VERSION}.
 */
export const BM25_AVG_LEN = 128;

/**
 * How many times a document's breadcrumb counts towards its term frequencies —
 * the "title field weight" of BM25F, expressed as plain token repetition so the
 * scoring formula itself stays untouched. Applied by
 * {@link buildDocumentSparseVector} only; a query has no breadcrumb.
 *
 * Measured, not guessed. On the customer's Confluence corpus (920 chunks, 230
 * golden questions, `tools/rag_audit/audit_retrieval.py`) the lexical branch's
 * hit@1 over the 160 answerable generated questions runs 0.806 at x1, 0.838 at
 * x4, 0.844 at x5, 0.838 at x6 and 0.844 at x8: a broad plateau from x4 to x8
 * with the peak at x5, so the value is not on a knife edge. The gain is
 * concentrated exactly where the hypothesis predicted — sibling registry pages
 * that differ only in their title: `definition` 0.75 -> 1.00, `procedure`
 * 0.86 -> 1.00, `table` 0.82 -> 0.89. Pushing further starts drowning body terms
 * (`synthesis` falls back at x6+).
 *
 * Costs nothing in index size: the breadcrumb's terms are already in the vector,
 * only their values change.
 */
export const BM25_BREADCRUMB_BOOST = 5;

/** Sparse vector in Qdrant wire format: parallel arrays of u32 indices and weights. */
export interface SparseVector {
  indices: number[];
  values: number[];
}

/** Tokens shorter than this are dropped (single letters carry no lexical signal). */
const MIN_TOKEN_LENGTH = 2;

/** Splits on anything that is not a Unicode letter or number. */
const NON_WORD = /[^\p{L}\p{N}]+/u;

/** A token made purely of lowercase Cyrillic letters — the only thing we stem. */
const CYRILLIC_WORD = /^[а-я]+$/;

/**
 * A compound identifier: two or more alphanumeric parts joined by `_` or `.` with no
 * whitespace between them — `epk_id`, `afpc_sss_src.cards_event`, `build.sbt`.
 * Letters of any script, because the corpus contains identifiers with a stray Cyrillic
 * letter typed inside an otherwise Latin name (`afсc_inc_distr.event`).
 *
 * The lookbehind is load-bearing for SPEED, not for matching: it forbids starting a
 * match in the middle of an alphanumeric run. Without it, a long run of letters with no
 * separator (a base64 blob, a wall of table text) makes the leading `+` backtrack over
 * its whole length at EVERY offset — quadratic, and minutes on a 100 kB chunk. A match
 * that would start mid-run is always subsumed by one starting at the run's first
 * character, and matching is leftmost, so no match is lost.
 */
const IDENTIFIER_RUN = /(?<![\p{L}\p{N}])[\p{L}\p{N}]+(?:[._][\p{L}\p{N}]+)+/gu;

/** Splits a compound identifier into its parts. */
const IDENTIFIER_SEPARATOR = /[._]/;

/** Any letter — a run without one is a version or a decimal (`0.99`, `1.2.3`), not a name. */
const HAS_LETTER = /\p{L}/u;

/**
 * Shortest joined identifier worth emitting. Below this the joined form is an
 * abbreviation rather than a name — `т.д`, `т.е`, `p.s` — and carries no more signal
 * than the fragments it came from.
 */
const MIN_JOINED_LENGTH = 4;

/**
 * Short function-word list (ru + en). Deliberately not a full corpus: these are the
 * terms whose IDF would be near zero anyway, and dropping them keeps the sparse
 * vectors small. Matched against the surface form, before stemming.
 */
const STOP_WORDS: ReadonlySet<string> = new Set(
  [
    // Russian: prepositions, conjunctions, particles, pronouns, auxiliaries
    'без более больше будет будто бы был была были было быть вам вас ведь весь вот',
    'все всего всех вы где да даже для до его ее ей ему если есть еще же за здесь',
    'из или им их как кто когда ли между меня мне мы на над надо нас не него нее',
    'ней нет ни них но ну об он она они оно от очень по под после при про сам со',
    'так такой там те тебя тем то тоже только том тот ты уже хотя чего чем через',
    'что чтобы эта эти это этой этом этот эту',
    // English
    'an and are as at be been being but by can could did do does for from had has',
    'have he her his how if in is it its may might not of on or our she should so',
    'than that the their then there these they this those to was we were what when',
    'which who will with would you your',
  ].flatMap((line) => line.split(' ')),
);

// --- Snowball Russian stemmer (vendored) -------------------------------------
// Straight port of the Snowball "russian" algorithm (snowball.tartarus.org, BSD).
// Vendored rather than pulled from npm: the published JS ports ship every language
// in one ~850 KB untyped CommonJS bundle, which is a lot of scan surface for ~120
// lines of well-known, frozen logic. Verified byte-identical to the reference port
// on the repo's Russian vocabulary and on 300k randomized suffix-heavy words.

const RU_VOWELS = 'аеиоуыэюя';

/** Endings, longest first inside each group — that ordering is what makes the
 *  linear scan below behave like Snowball's longest-match `among`. */
const group = (list: string): readonly string[] => list.split(' ');

const PERFECTIVE_GERUND_AYA = group('вшись вши в');
const PERFECTIVE_GERUND = group('ившись ывшись ивши ывши ив ыв');
const ADJECTIVE = group(
  'ими ыми его ого ему ому ее ие ые ое ей ий ый ой ем им ым ом их ых ую юю ая яя ою ею',
);
const PARTICIPLE_AYA = group('ющ ем нн вш щ');
const PARTICIPLE = group('ивш ывш ующ');
const REFLEXIVE = group('ся сь');
const VERB_AYA = group('ете йте ешь нно ла на ли ем ло но ет ют ны ть й л н');
const VERB = group(
  'ейте уйте ила ыла ена ите или ыли ило ыло ено ует уют ены ить ыть ишь ' +
    'ей уй ил ыл им ым ен ят ит ыт ую ю',
);
const NOUN = group(
  'иями ями ами ией иям ием иях ев ов ие ье еи ии ей ой ий ям ем ам ом ах ях ию ью ия ья ' +
    'а е и й о у ы ь ю я',
);
const SUPERLATIVE = group('ейше ейш');
const DERIVATIONAL = group('ость ост');
const I_ENDING = group('и');

function isVowel(ch: string): boolean {
  return RU_VOWELS.includes(ch);
}

/**
 * RV = the region after the first vowel. R2 = the region after the first
 * non-vowel-following-a-vowel inside R1 (itself defined the same way over the word).
 */
function regions(word: string): { rv: number; r2: number } {
  const n = word.length;
  let rv = n;
  for (let i = 0; i < n; i++) {
    if (isVowel(word.charAt(i))) {
      rv = i + 1;
      break;
    }
  }
  let r1 = n;
  for (let i = 1; i < n; i++) {
    if (!isVowel(word.charAt(i)) && isVowel(word.charAt(i - 1))) {
      r1 = i + 1;
      break;
    }
  }
  let r2 = n;
  for (let i = r1 + 1; i < n; i++) {
    if (!isVowel(word.charAt(i)) && isVowel(word.charAt(i - 1))) {
      r2 = i + 1;
      break;
    }
  }
  return { rv, r2 };
}

/**
 * Removes the first matching ending that lies entirely inside RV, or returns null.
 * `needAYa` implements Snowball's group-1 rule: the ending must be preceded by
 * "а" or "я", which must itself sit inside RV.
 */
function cut(
  word: string,
  rv: number,
  endings: readonly string[],
  needAYa: boolean,
): string | null {
  for (const ending of endings) {
    const start = word.length - ending.length;
    if (start < rv || !word.endsWith(ending)) continue;
    if (needAYa) {
      if (start - 1 < rv) continue;
      const prev = word.charAt(start - 1);
      if (prev !== 'а' && prev !== 'я') continue;
    }
    return word.slice(0, start);
  }
  return null;
}

function stemRussian(input: string): string {
  let word = input;
  const { rv, r2 } = regions(word);

  // Step 1: perfective gerund, else reflexive + (adjectival | verb | noun).
  let cutted =
    cut(word, rv, PERFECTIVE_GERUND_AYA, true) ?? cut(word, rv, PERFECTIVE_GERUND, false);
  if (cutted !== null) {
    word = cutted;
  } else {
    cutted = cut(word, rv, REFLEXIVE, false);
    if (cutted !== null) word = cutted;

    cutted = cut(word, rv, ADJECTIVE, false);
    if (cutted !== null) {
      word = cutted;
      cutted = cut(word, rv, PARTICIPLE_AYA, true) ?? cut(word, rv, PARTICIPLE, false);
      if (cutted !== null) word = cutted;
    } else {
      cutted = cut(word, rv, VERB_AYA, true) ?? cut(word, rv, VERB, false);
      if (cutted === null) cutted = cut(word, rv, NOUN, false);
      if (cutted !== null) word = cutted;
    }
  }

  // Step 2: drop a trailing "и".
  cutted = cut(word, rv, I_ENDING, false);
  if (cutted !== null) word = cutted;

  // Step 3: derivational ending, but only if it lies entirely inside R2.
  for (const ending of DERIVATIONAL) {
    if (word.endsWith(ending) && word.length - ending.length >= r2) {
      word = word.slice(0, word.length - ending.length);
      break;
    }
  }

  // Step 4: undouble "нн", else strip a superlative (then undouble), else strip "ь".
  const endsInRv = (ending: string): boolean =>
    word.length - ending.length >= rv && word.endsWith(ending);

  if (endsInRv('нн')) {
    word = word.slice(0, -1);
  } else {
    cutted = cut(word, rv, SUPERLATIVE, false);
    if (cutted !== null) {
      word = cutted;
      if (endsInRv('нн')) word = word.slice(0, -1);
    } else if (endsInRv('ь')) {
      word = word.slice(0, -1);
    }
  }

  return word;
}

// --- Tokenization ------------------------------------------------------------

/**
 * Splits text into the terms used on both the index and the query side.
 *
 * Pipeline: lowercase -> "ё" folded to "е" -> split on non-alphanumerics -> drop
 * one-character tokens and stop words -> stem the purely-Cyrillic tokens.
 *
 * Latin words, digits, mixed alphanumerics and acronyms are left verbatim on
 * purpose. The whole point of the lexical branch is that "SberOSC", error codes and
 * part numbers stay findable literally; running them through Russian morphology
 * would only corrupt them, since its suffix rules mean nothing for an identifier.
 *
 * Folding "ё" is a deliberate deviation from stock Snowball (which treats "ё" as a
 * separate letter): it makes "развёрнутый" and "развернутый" collide, and it is
 * applied identically at index and query time, so the two sides still agree.
 *
 * A compound identifier additionally yields its JOINED form on top of its fragments:
 * `afpc_sss_inc_safp_rsa_mapping` produces the six fragments AND
 * `afpcsssincsafprsamapping`. Splitting alone made the identifier indistinguishable
 * from its dozens of sibling registry pages, which share every fragment; the joined
 * term is unique to the one page and so carries near-maximal IDF. The fragments stay
 * because queries naming only part of an identifier must keep working — and because
 * both sides run through this same function, the extra term lines up automatically.
 */
export function tokenize(text: string): string[] {
  if (text.length === 0) return [];

  const normalized = text.toLowerCase().replaceAll('ё', 'е');
  const tokens: string[] = [];

  const push = (raw: string): void => {
    if (raw.length < MIN_TOKEN_LENGTH) return;
    if (STOP_WORDS.has(raw)) return;
    const token = CYRILLIC_WORD.test(raw) ? stemRussian(raw) : raw;
    if (token.length === 0) return;
    tokens.push(token);
  };

  for (const raw of normalized.split(NON_WORD)) push(raw);

  for (const match of normalized.matchAll(IDENTIFIER_RUN)) {
    const joined = match[0].split(IDENTIFIER_SEPARATOR).join('');
    if (joined.length < MIN_JOINED_LENGTH) continue;
    if (!HAS_LETTER.test(joined)) continue;
    push(joined);
  }

  return tokens;
}

// --- Hashing -----------------------------------------------------------------

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const utf8 = new TextEncoder();

/**
 * FNV-1a over the UTF-8 bytes of the token, as an unsigned 32-bit integer — the
 * index of the term in Qdrant's sparse vector.
 *
 * Hand-rolled rather than taken from a library so the mapping is frozen: the same
 * token must hash to the same index across Node versions, machines and releases,
 * otherwise an index written yesterday cannot be queried today. Distinct tokens may
 * collide; their term frequencies then merge, which is the usual, harmless behavior
 * of hashed sparse representations at this vocabulary size.
 */
export function hashToken(token: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of utf8.encode(token)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

// --- Sparse vector -----------------------------------------------------------

/**
 * Builds the BM25 sparse vector for a piece of text.
 *
 * `indices` are unique (repeated tokens collapse into one entry whose value carries
 * the term frequency) and parallel to `values`, in first-occurrence order. Empty or
 * whitespace-only input yields an empty vector — callers must treat that as "no
 * lexical branch" rather than sending it to Qdrant.
 */
export function buildSparseVector(text: string): SparseVector {
  return vectorFromTokens(tokenize(text));
}

/**
 * Builds the BM25 sparse vector for an INDEXED chunk, whose breadcrumb counts
 * {@link BM25_BREADCRUMB_BOOST} times over.
 *
 * Every chunk the chunker emits is `<breadcrumb>\n\n<body>` (`withBreadcrumb`), so the
 * breadcrumb is exactly the first line — no extra plumbing needed to locate it. Sibling
 * pages of a registry routinely differ in nothing but their title, and at tf = 1 the
 * title's terms are outvoted by a body they all share; repeating them is the "title
 * field weight" of BM25F without leaving the plain BM25 formula.
 *
 * Only the DOCUMENT side does this — a question has no breadcrumb — but the terms still
 * come from the same {@link tokenize}, so index and query indices line up exactly as
 * before. Anything without a newline (and every query) falls through to
 * {@link buildSparseVector}.
 */
export function buildDocumentSparseVector(text: string): SparseVector {
  const newline = text.indexOf('\n');
  if (newline <= 0 || BM25_BREADCRUMB_BOOST <= 1) return buildSparseVector(text);

  const tokens = tokenize(text);
  if (tokens.length === 0) return { indices: [], values: [] };

  // The full text already counts the breadcrumb once; add the remaining copies.
  const breadcrumb = tokenize(text.slice(0, newline));
  for (let copy = 1; copy < BM25_BREADCRUMB_BOOST; copy++) tokens.push(...breadcrumb);

  return vectorFromTokens(tokens);
}

/** Term frequencies -> BM25 tf weights. The shared tail of both builders above. */
function vectorFromTokens(tokens: readonly string[]): SparseVector {
  if (tokens.length === 0) return { indices: [], values: [] };

  const frequencies = new Map<number, number>();
  for (const token of tokens) {
    const index = hashToken(token);
    frequencies.set(index, (frequencies.get(index) ?? 0) + 1);
  }

  // Length normalization is constant for the whole text, so hoist it out of the loop.
  const normalization = BM25_K1 * (1 - BM25_B + (BM25_B * tokens.length) / BM25_AVG_LEN);

  const indices: number[] = [];
  const values: number[] = [];
  for (const [index, tf] of frequencies) {
    indices.push(index);
    values.push((tf * (BM25_K1 + 1)) / (tf + normalization));
  }

  return { indices, values };
}
