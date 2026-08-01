import { describe, expect, it } from 'vitest';
import {
  BM25_AVG_LEN,
  BM25_B,
  BM25_BREADCRUMB_BOOST,
  BM25_K1,
  BM25_SCHEME_VERSION,
  BM25_VECTOR_NAME,
  buildDocumentSparseVector,
  buildSparseVector,
  DENSE_VECTOR_NAME,
  hashToken,
  tokenize,
} from '../bm25.js';

/** tf-component of BM25, mirrored here so tests assert the documented formula. */
function tfComponent(tf: number, len: number): number {
  return (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * len) / BM25_AVG_LEN));
}

describe('constants', () => {
  it('exposes the vector names the Qdrant collection is created with', () => {
    expect(BM25_VECTOR_NAME).toBe('bm25');
    expect(DENSE_VECTOR_NAME).toBe('dense');
  });

  it('exposes a scheme version so scoring changes can force a reindex', () => {
    // v2: BM25_AVG_LEN moved from a guessed 300 to the measured 128.
    // v3: joined compound identifiers (new indices) + breadcrumb boost (new values).
    expect(BM25_SCHEME_VERSION).toBe(3);
  });

  it('uses the standard BM25 parameters', () => {
    // Swept on the customer corpus: k1 ∈ {0.9, 1.2, 1.5} × b ∈ {0.4, 0.75, 1.0}. No cell
    // beat the defaults by more than a question or two either way on the lexical branch,
    // and b = 1.0 was worse everywhere. Pinned as a measured non-result, not a guess.
    expect(BM25_K1).toBe(1.2);
    expect(BM25_B).toBe(0.75);
  });

  it('pins the average length to the measured corpus average', () => {
    // Mean over the 1875 chunks of this repository's 232 markdown files. An inflated
    // value silently weakens length normalization: at 300 the effective b was ~0.34.
    expect(BM25_AVG_LEN).toBe(128);
  });

  it('normalizes an average-length document to the nominal b', () => {
    // A document of exactly the average length must get the un-normalized saturation,
    // which is the property the constant exists for.
    expect(tfComponent(1, BM25_AVG_LEN)).toBeCloseTo((1 * (BM25_K1 + 1)) / (1 + BM25_K1), 10);
  });
});

describe('tokenize — Russian stemming', () => {
  it('collapses inflected forms of the same noun to one token', () => {
    expect(tokenize('документами документа документ документов документе')).toEqual([
      'документ',
      'документ',
      'документ',
      'документ',
      'документ',
    ]);
  });

  it('collapses adjective and verb forms', () => {
    expect(new Set(tokenize('красивый красивая красивые'))).toEqual(new Set(['красив']));
    expect(new Set(tokenize('настройка настройки настройками'))).toEqual(new Set(['настройк']));
    expect(new Set(tokenize('система системы системе системами'))).toEqual(new Set(['систем']));
  });

  it('matches the reference Snowball russian stemmer on known words', () => {
    // Spot-checks pinned against snowball.tartarus.org's algorithm.
    expect(tokenize('ошибками')).toEqual(['ошибк']);
    expect(tokenize('интеграции')).toEqual(['интеграц']);
    expect(tokenize('создания')).toEqual(['создан']);
    expect(tokenize('стоимость')).toEqual(['стоимост']);
    expect(tokenize('ванна')).toEqual(['ван']);
    expect(tokenize('делавший')).toEqual(['дела']);
    // "план" keeps its "н": the preceding "а" is the first vowel, so it falls
    // outside RV and the group-1 verb rule does not fire.
    expect(tokenize('план плана планом')).toEqual(['план', 'план', 'план']);
  });

  it('folds "ё" to "е" so both spellings produce the same term', () => {
    expect(tokenize('развёрнутый')).toEqual(tokenize('развернутый'));
    expect(tokenize('развёрнутый развернуть')).toEqual(['развернут', 'развернут']);
  });
});

describe('tokenize — Latin, digits and codes are left verbatim', () => {
  it('lowercases Latin words but never stems them', () => {
    // The Russian stemmer would happily eat a trailing "с"/"ов"-lookalike; the
    // whole value of the lexical branch is that identifiers survive intact.
    expect(tokenize('SberOSC')).toEqual(['sberosc']);
    expect(tokenize('CogniVault Qdrant Fastify')).toEqual(['cognivault', 'qdrant', 'fastify']);
  });

  it('splits codes on the separator and keeps both parts', () => {
    // Documented behavior: "ERR-4013" becomes two terms, "err" and "4013".
    // Index and query sides both do this, so the code still matches literally.
    expect(tokenize('ERR-4013')).toEqual(['err', '4013']);
    expect(tokenize('err 4013')).toEqual(['err', '4013']);
  });

  it('keeps mixed alphanumeric tokens whole', () => {
    expect(tokenize('int8 sha256 utf8mb4')).toEqual(['int8', 'sha256', 'utf8mb4']);
  });

  it('handles a realistic mixed-script sentence', () => {
    // "3" is dropped as a single character; everything else survives. "v1.16.3" is a
    // dot-joined run, so its joined form is appended after the fragments — a version
    // string is exactly the kind of term that is only useful whole.
    expect(tokenize('Ошибка ERR-4013 в SberOSC v1.16.3')).toEqual([
      'ошибк',
      'err',
      '4013',
      'sberosc',
      'v1',
      '16',
      'v1163',
    ]);
  });
});

describe('tokenize — compound identifiers', () => {
  it('emits the whole identifier in ADDITION to its fragments', () => {
    // The fragments are shared by every sibling page of the registry; the joined form
    // belongs to one page only, which is where its IDF comes from.
    expect(tokenize('afpc_sss_inc_safp_rsa_mapping')).toEqual([
      'afpc',
      'sss',
      'inc',
      'safp',
      'rsa',
      'mapping',
      'afpcsssincsafprsamapping',
    ]);
  });

  it('treats "." like "_", so schema-qualified names join across the dot', () => {
    expect(tokenize('afpc_sss_src.cards_event')).toEqual([
      'afpc',
      'sss',
      'src',
      'cards',
      'event',
      'afpcssssrccardsevent',
    ]);
  });

  it('keeps a partial-name query matching, which is why the fragments stay', () => {
    // The golden set deliberately asks about identifiers by part of their name. Only
    // the WHOLE name gets a joined term, so a partial query's own joined form is absent
    // — the fragments are what carries the partial match, and that is precisely why
    // dropping them in favour of the joined form was never an option.
    const document = new Set(tokenize('таблица afpc_sss_src.cards_event'));
    expect(document.has('cardsevent')).toBe(false);
    for (const fragment of ['cards', 'event']) expect(document.has(fragment)).toBe(true);
  });

  it('stays linear on a long separator-free run', () => {
    // A naive run regex backtracks over the whole run at every offset; a 100 kB chunk
    // of unbroken text then costs minutes. Guarded here because the input is real:
    // base64 blobs and wide tables both produce runs like this.
    const started = performance.now();
    expect(tokenize('a'.repeat(200_000))).toEqual(['a'.repeat(200_000)]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('gives index and query side the same joined term', () => {
    const document = tokenize('витрина epk_id хранит идентификатор');
    expect(document).toContain('epkid');
    expect(tokenize('что такое epk_id?')).toContain('epkid');
  });

  it('does not join across a hyphen or whitespace', () => {
    // Hyphens run through ordinary Russian prose ("из-за"); joining there would
    // manufacture junk terms. Documented behavior, asserted so it stays deliberate.
    expect(tokenize('ERR-4013')).toEqual(['err', '4013']);
    expect(tokenize('event dt')).toEqual(['event', 'dt']);
  });

  it('leaves versions and decimals alone — a run needs a letter', () => {
    expect(tokenize('0.99')).toEqual(['99']);
    expect(tokenize('доля 0.95 и порог 1.2.3')).toEqual(['дол', '95', 'порог']);
  });

  it('ignores abbreviations too short to be names', () => {
    // "т.д" joins to "тд", below the minimum length: an abbreviation carries no more
    // signal joined than split.
    expect(tokenize('и т.д')).toEqual([]);
    expect(tokenize('p.s')).toEqual([]);
  });

  it('applies stop-word and stemming rules to the joined form as well', () => {
    // The joined term goes through the same filters as any other token.
    expect(tokenize('пере_ход')).toEqual(['пер', 'ход', 'переход']);
  });

  it('counts one joined term per occurrence, so term frequency still means something', () => {
    expect(tokenize('epk_id epk_id').filter((t) => t === 'epkid')).toHaveLength(2);
  });
});

describe('tokenize — filtering', () => {
  it('drops Russian and English stop words', () => {
    expect(tokenize('это не то что было бы для нас')).toEqual([]);
    expect(tokenize('the quick brown fox is on the mat')).toEqual(['quick', 'brown', 'fox', 'mat']);
  });

  it('drops single-character tokens', () => {
    expect(tokenize('a b c 1 2 3 я в с')).toEqual([]);
    expect(tokenize('x ok')).toEqual(['ok']);
  });

  it('keeps content words that merely sit next to stop words', () => {
    expect(tokenize('поиск по базе знаний')).toEqual(['поиск', 'баз', 'знан']);
  });
});

describe('hashToken', () => {
  it('produces the pinned FNV-1a/32 values', () => {
    // Golden values. Qdrant point indices depend on these: if this test fails,
    // the hashing changed and every indexed collection needs to be rebuilt.
    expect(hashToken('документ')).toBe(457117374);
    expect(hashToken('sberosc')).toBe(1208968134);
    expect(hashToken('err')).toBe(1821864748);
    expect(hashToken('4013')).toBe(3516647073);
    expect(hashToken('cognivault')).toBe(2529393467);
    expect(hashToken('qdrant')).toBe(1245003399);
    expect(hashToken('настройк')).toBe(4101802381);
    expect(hashToken('ошибк')).toBe(3223758527);
    expect(hashToken('систем')).toBe(1326294305);
    expect(hashToken('')).toBe(2166136261); // FNV offset basis
  });

  it('stays inside the unsigned 32-bit range Qdrant expects', () => {
    const samples = ['документ', 'sberosc', 'ошибк', '4013', 'мультитенантность', 'zzzzzzzz'];
    for (const token of samples) {
      const hash = hashToken(token);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('is stable across repeated calls', () => {
    expect(hashToken('документ')).toBe(hashToken('документ'));
  });
});

describe('buildSparseVector', () => {
  it('returns an empty vector for empty and whitespace-only input', () => {
    expect(buildSparseVector('')).toEqual({ indices: [], values: [] });
    expect(buildSparseVector('   ')).toEqual({ indices: [], values: [] });
    expect(buildSparseVector('\n\t  \r\n')).toEqual({ indices: [], values: [] });
    expect(buildSparseVector('— , . ! ?')).toEqual({ indices: [], values: [] });
  });

  it('returns an empty vector when every token is filtered out', () => {
    expect(buildSparseVector('это не то что бы')).toEqual({ indices: [], values: [] });
  });

  it('keeps indices and values parallel, unique and index-aligned', () => {
    const text = 'документ документами SberOSC документ ERR-4013 SberOSC настройка';
    const { indices, values } = buildSparseVector(text);

    expect(indices).toHaveLength(values.length);
    expect(new Set(indices).size).toBe(indices.length);
    // 4 distinct terms: документ, sberosc, err, 4013, настройк
    expect(indices).toHaveLength(5);
    expect(indices).toContain(hashToken('документ'));
    expect(indices).toContain(hashToken('sberosc'));
    expect(indices).toContain(hashToken('настройк'));
    for (const value of values) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('collapses repeated tokens into a single entry', () => {
    const { indices, values } = buildSparseVector('сервер сервер сервер');
    expect(indices).toEqual([hashToken('сервер')]);
    expect(values).toHaveLength(1);
  });

  it('produces bit-identical output on repeated calls', () => {
    const text = 'Гибридный поиск: SberOSC, ERR-4013, документами и настройками системы.';
    const first = buildSparseVector(text);
    const second = buildSparseVector(text);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('gives the index side and the query side the same term indices', () => {
    // The contract that makes the lexical branch work at all.
    const document = buildSparseVector(
      'Сертификат для SberOSC хранится в секрете; ошибка ERR-4013 при ротации.',
    );
    const query = buildSparseVector('ошибки SberOSC ERR-4013');
    for (const index of query.indices) {
      expect(document.indices).toContain(index);
    }
  });

  it('grows the tf component with frequency, but sublinearly', () => {
    const filler = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    // Both texts are exactly 10 tokens long, so only tf differs.
    const once = `zulu ${filler.slice(0, 9).concat('india').join(' ')}`;
    const fiveTimes = `zulu zulu zulu zulu zulu ${filler.slice(0, 5).join(' ')}`;

    expect(tokenize(once)).toHaveLength(10);
    expect(tokenize(fiveTimes)).toHaveLength(10);

    const index = hashToken('zulu');
    const vOnce = buildSparseVector(once);
    const vFive = buildSparseVector(fiveTimes);
    const value1 = vOnce.values[vOnce.indices.indexOf(index)] as number;
    const value5 = vFive.values[vFive.indices.indexOf(index)] as number;

    // norm = 1.2 * (1 - 0.75 + 0.75 * 10 / 128) = 0.3703125
    // tf=1 -> 2.2 / 1.3703125 = 1.60547...   tf=5 -> 11 / 5.3703125 = 2.04829...
    expect(value1).toBeCloseTo(1.6054732, 6);
    expect(value5).toBeCloseTo(2.0482979, 6);
    expect(value1).toBeCloseTo(tfComponent(1, 10), 12);
    expect(value5).toBeCloseTo(tfComponent(5, 10), 12);

    // Monotonic but saturating: 5x the frequency is far from 5x the weight,
    // and no frequency can ever exceed the k1 + 1 asymptote.
    expect(value5).toBeGreaterThan(value1);
    expect(value5).toBeLessThan(2 * value1);
    expect(value5).toBeLessThan(BM25_K1 + 1);
    expect(tfComponent(1000, 10)).toBeLessThan(BM25_K1 + 1);
  });

  it('penalizes a term in a long text relative to the same term in a short one', () => {
    const short = buildSparseVector('квота превышена');
    const longText = `квота превышена ${'lorem ipsum dolor sit amet '.repeat(60)}`;
    const long = buildSparseVector(longText);
    const index = hashToken('квот');
    const shortValue = short.values[short.indices.indexOf(index)] as number;
    const longValue = long.values[long.indices.indexOf(index)] as number;
    expect(longValue).toBeLessThan(shortValue);
  });

  it('handles a very long text without NaN, Infinity or overflow', () => {
    const words = ['документ', 'sberosc', 'ошибка', 'настройка', '4013', 'qdrant', 'вектор'];
    const parts: string[] = [];
    for (let i = 0; i < 200_000; i++) {
      parts.push(words[i % words.length] as string);
    }
    const text = parts.join(' ');

    const { indices, values } = buildSparseVector(text);
    expect(indices).toHaveLength(words.length);
    expect(values).toHaveLength(indices.length);
    for (const value of values) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(BM25_K1 + 1);
    }
    for (const index of indices) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('survives pathological input', () => {
    expect(() => buildSparseVector('a'.repeat(100_000))).not.toThrow();
    expect(buildSparseVector('ъ ь ы')).toEqual({ indices: [], values: [] });
    const emoji = buildSparseVector('🎉🎉🎉 отчёт 🎉');
    expect(emoji.indices).toEqual([hashToken('отчет')]);
  });
});

describe('buildDocumentSparseVector', () => {
  /** A chunk as the chunker emits it: `withBreadcrumb(sectionPath, body)`. */
  const chunk = (breadcrumb: string, body: string): string => `${breadcrumb}\n\n${body}`;

  const weight = (vector: { indices: number[]; values: number[] }, token: string): number => {
    const at = vector.indices.indexOf(hashToken(token));
    return at < 0 ? 0 : (vector.values[at] as number);
  };

  it('is exactly the breadcrumb repeated in the token stream', () => {
    // The definition, asserted against the plain builder: no separate scoring path,
    // so length normalization sees the repeated tokens too — as it must.
    const breadcrumb = 'Финансовый эффект > Расчёт';
    const body = 'Инструмент считает экономию по сработкам правил.';
    const repeated = `${[breadcrumb].concat(Array(BM25_BREADCRUMB_BOOST - 1).fill(breadcrumb)).join('\n')}\n\n${body}`;
    expect(buildDocumentSparseVector(chunk(breadcrumb, body))).toEqual(buildSparseVector(repeated));
  });

  it('raises breadcrumb terms above body terms of the same raw frequency', () => {
    const vector = buildDocumentSparseVector(chunk('Финансовый эффект', 'Расчёт экономии.'));
    expect(weight(vector, 'эффект')).toBeGreaterThan(weight(vector, 'эконом'));
  });

  it('leaves the set of terms alone — only their weights move', () => {
    const text = chunk('Data Quality > HiveStats', 'Поток собирает метаинформацию.');
    expect(new Set(buildDocumentSparseVector(text).indices)).toEqual(
      new Set(buildSparseVector(text).indices),
    );
  });

  it('boosts a term the breadcrumb shares with the body only once per copy', () => {
    // "эффект" occurs once in each; the boost adds BOOST-1 further occurrences, not
    // BOOST times the total. Sibling pages differ in their title, not in their body.
    const boosted = buildDocumentSparseVector(chunk('Финансовый эффект', 'эффект правила'));
    const plain = buildSparseVector(
      `${Array(BM25_BREADCRUMB_BOOST).fill('Финансовый эффект').join('\n')}\n\nэффект правила`,
    );
    expect(boosted).toEqual(plain);
  });

  it('falls back to the plain builder when there is no breadcrumb line', () => {
    // Queries and any single-line text: nothing to boost, and boosting a query would
    // desynchronize the two sides.
    const query = 'что такое финэффект';
    expect(buildDocumentSparseVector(query)).toEqual(buildSparseVector(query));
    expect(buildDocumentSparseVector('')).toEqual({ indices: [], values: [] });
    expect(buildDocumentSparseVector('\nтело без крошки')).toEqual(
      buildSparseVector('\nтело без крошки'),
    );
  });

  it('still yields nothing for a document with no lexical content', () => {
    expect(buildDocumentSparseVector('ъ ь\n\nы')).toEqual({ indices: [], values: [] });
  });

  it('keeps the joined identifier of a breadcrumb, boosted like any other term', () => {
    // Registry pages are titled with the table they document; the joined name is the
    // one term that tells them apart, and the boost is what makes it decisive.
    const vector = buildDocumentSparseVector(
      chunk('afpc_sss_src.cards_event', 'Структура витрины данных.'),
    );
    expect(weight(vector, 'afpcssssrccardsevent')).toBeGreaterThan(weight(vector, 'витрин'));
  });
});
