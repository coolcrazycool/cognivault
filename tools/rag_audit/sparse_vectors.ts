#!/usr/bin/env -S npx tsx
/**
 * Мост к НАСТОЯЩЕМУ построителю разреженных векторов (`src/lib/bm25.ts`) для
 * питоновской части аудита (`audit_retrieval.py`).
 *
 * ЗАЧЕМ мост, а не реализация на Python
 * -------------------------------------
 * Весь смысл `bm25.ts` в том, что индексная и запросная стороны считаются ОДНИМИ
 * функциями: стоп-слова, стеммер Snowball, свёртка «ё»→«е», FNV-1a и насыщение tf
 * должны совпасть до бита, иначе термы перестают сходиться и лексическая ветка молча
 * возвращает пустоту. Вторая реализация на Python разошлась бы с продом незаметно —
 * и аудит мерил бы собственную копию, а не то, что крутится в проде.
 *
 * Формат: на вход JSON `{"texts": ["…", …]}`, на выход JSON
 * `{"vectors": [{"indices": [...], "values": [...]}, …]}` в том же порядке.
 * Один вызов на весь набор — запуск `npx tsx` стоит секунды, и делать его на каждый
 * текст было бы дороже самого счёта.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { buildSparseVector } from '../../src/lib/bm25.js';

interface Input {
  texts: string[];
}

export function buildAll(texts: string[]): { indices: number[]; values: number[] }[] {
  return texts.map((text) => buildSparseVector(text));
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
  writeFileSync(outPath, JSON.stringify({ vectors: buildAll(input.texts) }), 'utf8');
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('sparse_vectors.ts')) {
  process.exitCode = main(process.argv.slice(2));
}
