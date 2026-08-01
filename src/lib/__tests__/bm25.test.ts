import { describe, expect, it } from 'vitest';
import {
  BM25_AVG_LEN,
  BM25_B,
  BM25_K1,
  BM25_SCHEME_VERSION,
  BM25_VECTOR_NAME,
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

  it('exposes a scheme version so tokenization changes can force a reindex', () => {
    expect(BM25_SCHEME_VERSION).toBe(1);
  });

  it('uses the standard BM25 parameters', () => {
    expect(BM25_K1).toBe(1.2);
    expect(BM25_B).toBe(0.75);
    expect(BM25_AVG_LEN).toBe(300);
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
    // "3" is dropped as a single character; everything else survives.
    expect(tokenize('Ошибка ERR-4013 в SberOSC v1.16.3')).toEqual([
      'ошибк',
      'err',
      '4013',
      'sberosc',
      'v1',
      '16',
    ]);
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

    // norm = 1.2 * (1 - 0.75 + 0.75 * 10 / 300) = 0.33
    // tf=1 -> 1 * 2.2 / 1.33 = 1.65413...   tf=5 -> 5 * 2.2 / 5.33 = 2.06378...
    expect(value1).toBeCloseTo(1.6541353, 6);
    expect(value5).toBeCloseTo(2.0637898, 6);
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
