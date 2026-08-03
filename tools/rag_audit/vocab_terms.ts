#!/usr/bin/env -S npx tsx
/**
 * Мост к НАСТОЯЩЕМУ токенизатору (`src/lib/bm25.ts::tokenize`) для диагностики
 * словарного разрыва (`audit_vocab.py`).
 *
 * ЗАЧЕМ отдельный мост, а не `sparse_vectors.ts`
 * ---------------------------------------------
 * `sparse_vectors.ts` отдаёт индексы (FNV-1a от терма) — по ним пересечение термов
 * вопроса и документа СЧИТАЕТСЯ верно, но не ЧИТАЕТСЯ: в отчёт про «какое слово
 * пользователя не имеет якоря в документе» число 3106953969 не годится. Здесь тот же
 * `tokenize` отдаёт сами стеммы. Файл новый, а не правка `sparse_vectors.ts`,
 * намеренно: отпечаток последнего входит в провенанс сводного прогона (`RULERS` в
 * `audit_all.py`), и правка ради диагностики выглядела бы как «сдвинулась линейка».
 *
 * ПОЧЕМУ ЭТО ЧЕСТНО ДЛЯ ОБЕИХ СТОРОН
 * ----------------------------------
 * Документ и запрос считаются разными построителями (`buildDocumentSparseVector` vs
 * `buildSparseVector`), но различаются они только ВЕСАМИ: множество термов у обоих
 * даёт один и тот же `tokenize`. Поэтому пересечение стеммов — величина, определённая
 * одинаково для обеих сторон, и никакого «kind» тут не нужно.
 *
 * Формат: на вход JSON `{"texts": ["…", …]}`, на выход `{"tokens": [["…", …], …]}` в
 * том же порядке. Один вызов на весь набор — как у `sparse_vectors.ts`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { tokenize } from '../../src/lib/bm25.js';

interface Input {
  texts: string[];
}

export function tokenizeAll(texts: string[]): string[][] {
  return texts.map((text) => tokenize(text));
}

function main(argv: string[]): number {
  const [inPath, outPath] = argv;
  if (inPath === undefined || outPath === undefined) {
    process.stderr.write('нужны <in.json> <out.json>\n');
    return 2;
  }
  const input = JSON.parse(readFileSync(inPath, 'utf8')) as Input;
  if (!Array.isArray(input.texts)) {
    process.stderr.write('во входном JSON нет массива texts\n');
    return 2;
  }
  writeFileSync(outPath, JSON.stringify({ tokens: tokenizeAll(input.texts) }), 'utf8');
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('vocab_terms.ts')) {
  process.exitCode = main(process.argv.slice(2));
}
