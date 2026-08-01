#!/usr/bin/env -S npx tsx
/**
 * Мост к НАСТОЯЩЕМУ схлопыванию копий одного тела между РАЗНЫМИ файлами
 * (`SearchService.collapseCrossFileDuplicates`, `src/features/search/service.ts`)
 * для питоновской части аудита (`audit_retrieval.py`).
 *
 * ЗАЧЕМ мост, а не реализация на Python
 * -------------------------------------
 * Стадия выглядит как двадцать строк, и это ровно та причина, по которой её
 * хочется переписать — а переписанная она разойдётся с продом молча. В ней шесть
 * решений, каждое из которых меняет выдачу: порог Жаккара `NEAR_DUPLICATE_JACCARD`,
 * пол по числу различных слов `NEAR_DUPLICATE_MIN_TERMS`, `WORD_PATTERN` (какие
 * символы вообще составляют слово и что односимвольные слова выбрасываются),
 * снятие аннотации документа ПЕРЕД сбором термов (`chunkBody(text, '')` — пустой
 * путь раздела значит «снять аннотацию и БОЛЬШЕ НИЧЕГО», крошка остаётся),
 * освобождение от схлопывания для пары чанков ОДНОГО файла и — главное —
 * защита по слову ЗАПРОСА (`answersWithOwnWord`): копия, несущая слово запроса,
 * которого нет у выжившего, для ЭТОГО запроса не дубликат. Ни одно из шести не
 * проявит расхождение ничем, кроме неверных чисел.
 *
 * Тот же довод, по которому разреженную сторону гоняет `sparse_vectors.ts`, а
 * нарезку окна — `section_windows.ts`.
 *
 * ПРО ПРИВАТНОСТЬ. `collapseCrossFileDuplicates` объявлен `private`. В TypeScript
 * это аннотация ВРЕМЕНИ КОМПИЛЯЦИИ — в рантайме это обычный метод прототипа. Каст
 * ниже сделан осознанно и составляет весь смысл моста: замеряется продовая
 * функция, а не её пересказ. Переименование метода в `src/` уронит мост громко
 * (TypeError), а не тихо разойдётся с ним.
 *
 * ЧТО ЕДЕТ В `payload.text`. В проде это ТЕКСТ ТОЧКИ — чанк с крошкой и (при
 * `INDEX_DOC_SUMMARY`) с аннотацией; он не зависит от того, какой текст ушёл в
 * плотный вектор. Поэтому мост кормится `Chunk.text` из выгрузки `audit_chunk.ts`
 * как есть, а doc-композеры варианта на него не влияют — они меняют индексируемый
 * текст, а не полезную нагрузку.
 *
 * ДВА РЕЖИМА
 * ----------
 *   collapse_duplicates.ts <in.json> <out.json>
 *       Пакетный: {"corpus": [{"path": "…", "text": "…"}, …],
 *                  "requests": [{"query": "…", "docs": [3, 17, …]}, …]}
 *       → {"results": [[3, 17, …], …]} — выжившие ИНДЕКСЫ корпуса в порядке выдачи.
 *
 *   collapse_duplicates.ts --serve
 *       Потоковый: NDJSON на stdin, NDJSON на stdout, по строке на запрос.
 *         {"op": "corpus", "docs": [{"path", "text"}, …]} → {"ok": true, "docs": N}
 *         {"op": "collapse", "query": "…", "docs": [...]}  → {"kept": [...]}
 *       Стадия пост-обработки зовётся на КАЖДЫЙ вопрос и КАЖДУЮ ветку (сотни раз
 *       за прогон), а старт `npx tsx` стоит секунду — пакетного вызова тут не
 *       получается, потому что список кандидатов известен только после слияния.
 *       Поэтому процесс живёт весь прогон, корпус уезжает в него ОДИН раз, а
 *       запрос — это номера документов, а не их тексты.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { SearchService } from '../../src/features/search/service.js';

/** Приватный метод `SearchService`, который дёргает мост. */
interface CollapseInternals {
  collapseCrossFileDuplicates(points: BridgePoint[], query: string): BridgePoint[];
}

/**
 * Ровно те поля точки, которые читает стадия: `payload.text` (термы тела) и
 * `payload.path` (два чанка одного файла не сравниваются). `id` несёт номер
 * документа в корпусе — по нему питон и узнаёт выживших, не сверяя тексты.
 */
export interface BridgePoint {
  id: number;
  score: number;
  payload: { text: string; path: string };
}

export interface CorpusDoc {
  path: string;
  text: string;
}

/**
 * Экземпляр `SearchService` без Qdrant, эмбеддера и БД: схлопывание их не
 * касается, а конструктор только раскладывает аргументы по полям. Каст снимает
 * `private` — см. «ПРО ПРИВАТНОСТЬ» в шапке.
 */
export function collapseInternals(): CollapseInternals {
  return new SearchService(
    undefined as never,
    undefined as never,
    undefined,
  ) as unknown as CollapseInternals;
}

/** Корпус + продовая стадия поверх него. */
export class Collapser {
  private docs: CorpusDoc[] = [];
  private readonly internals = collapseInternals();

  load(docs: CorpusDoc[]): number {
    this.docs = docs;
    return docs.length;
  }

  /**
   * Кандидаты (номера документов, в порядке выдачи) → выжившие, в том же порядке.
   *
   * `score` всем ставится нулём намеренно: стадия его не читает, а порядок в
   * списке И ЕСТЬ ранг — выживает тот, кто пришёл раньше.
   */
  collapse(query: string, docs: number[]): number[] {
    const points: BridgePoint[] = docs.map((doc) => {
      const entry = this.docs[doc];
      if (entry === undefined) {
        throw new Error(`документа ${doc} нет в загруженном корпусе (${this.docs.length})`);
      }
      return { id: doc, score: 0, payload: { text: entry.text, path: entry.path } };
    });
    return this.internals.collapseCrossFileDuplicates(points, query).map((point) => point.id);
  }
}

// --------------------------------------------------------------------------- //
// Пакетный режим
// --------------------------------------------------------------------------- //

interface BatchInput {
  corpus?: CorpusDoc[];
  requests?: { query?: string; docs?: number[] }[];
}

function runBatch(inPath: string, outPath: string): number {
  const input = JSON.parse(readFileSync(inPath, 'utf8')) as BatchInput;
  if (!Array.isArray(input.corpus)) {
    process.stderr.write('во входном JSON нет массива corpus\n');
    return 2;
  }
  const collapser = new Collapser();
  collapser.load(input.corpus);
  const results = (input.requests ?? []).map((request) =>
    collapser.collapse(request.query ?? '', request.docs ?? []),
  );
  writeFileSync(outPath, JSON.stringify({ results }), 'utf8');
  return 0;
}

// --------------------------------------------------------------------------- //
// Потоковый режим
// --------------------------------------------------------------------------- //

function runServe(): void {
  const collapser = new Collapser();
  const reader = createInterface({ input: process.stdin });
  reader.on('line', (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    try {
      const message = JSON.parse(trimmed) as {
        op?: string;
        docs?: unknown;
        query?: string;
      };
      if (message.op === 'corpus') {
        const docs = message.docs as CorpusDoc[];
        process.stdout.write(`${JSON.stringify({ ok: true, docs: collapser.load(docs) })}\n`);
        return;
      }
      if (message.op === 'collapse') {
        const kept = collapser.collapse(message.query ?? '', (message.docs as number[]) ?? []);
        process.stdout.write(`${JSON.stringify({ kept })}\n`);
        return;
      }
      throw new Error(`неизвестная операция ${JSON.stringify(message.op)}`);
    } catch (error) {
      // Молчаливый пропуск сделал бы замер тихо неправильным: питон обязан
      // увидеть ошибку строкой протокола и упасть на ней.
      process.stdout.write(`${JSON.stringify({ error: String(error) })}\n`);
      process.exitCode = 1;
      reader.close();
    }
  });
}

// --------------------------------------------------------------------------- //

function main(argv: string[]): number {
  if (argv[0] === '--serve') {
    runServe();
    return 0;
  }
  const [inPath, outPath] = argv;
  if (inPath !== undefined && outPath !== undefined) {
    return runBatch(inPath, outPath);
  }
  process.stderr.write(
    'использование: collapse_duplicates.ts <in.json> <out.json>\n' +
      '               collapse_duplicates.ts --serve\n',
  );
  return 2;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('collapse_duplicates.ts')) {
  process.exitCode = main(process.argv.slice(2));
}
