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
 * Version of the tokenization + hashing scheme. Bump it whenever tokenize()
 * changes in a way that alters the produced indices: the value feeds the
 * collection fingerprint, so a bump forces a fresh collection and a reindex
 * instead of leaving query-time and index-time terms silently mismatched.
 */
export const BM25_SCHEME_VERSION = 1;

// --- BM25 term-frequency saturation parameters -------------------------------
// value = tf * (k1 + 1) / (tf + k1 * (1 - b + b * len / AVG_LEN))
/** Term-frequency saturation. Standard BM25 default; higher = less saturation. */
export const BM25_K1 = 1.2;
/** Length-normalization strength. Standard BM25 default; 0 = no normalization. */
export const BM25_B = 0.75;
/**
 * Assumed average document length in tokens. A real average would require corpus
 * statistics shared between the indexer and the query path; a fixed constant keeps
 * the module stateless. 300 tokens ~ a mid-sized chunk of the 100-500 cl100k-token
 * chunker budget. Changing it changes scoring, so treat it as part of the scheme.
 */
export const BM25_AVG_LEN = 300;

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
 */
export function tokenize(text: string): string[] {
  if (text.length === 0) return [];

  const normalized = text.toLowerCase().replaceAll('ё', 'е');
  const tokens: string[] = [];

  for (const raw of normalized.split(NON_WORD)) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    if (STOP_WORDS.has(raw)) continue;
    const token = CYRILLIC_WORD.test(raw) ? stemRussian(raw) : raw;
    if (token.length === 0) continue;
    tokens.push(token);
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
  const tokens = tokenize(text);
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
