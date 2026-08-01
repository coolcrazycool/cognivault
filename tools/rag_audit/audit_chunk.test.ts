/**
 * Тесты измерительных функций `audit_chunk`.
 *
 * Проверяется именно ЛИНЕЙКА, а не чанкер: на синтетических кусочках markdown, где
 * ответ известен заранее, метрика обязана дать точное число. Иначе аудит превращается
 * в генератор правдоподобных цифр, и «стало лучше» нечем отличить от «сломалась
 * метрика».
 *
 * Тесты живут вне `src/**\/__tests__`, поэтому основной `pnpm test` их не подхватывает
 * (см. `vitest.config.ts` в корне). Свой конфиг — рядом:
 *     npx vitest run --config tools/rag_audit/vitest.config.ts
 */

import { describe, expect, it } from 'vitest';
import { countTokens, DOC_SUMMARY_PREFIX, MAX_CHUNK_TOKENS } from '../../src/lib/chunker.js';
import {
  auditPage,
  chunkBody,
  chunkExportLine,
  distribution,
  exactDuplicateGroups,
  extractFencedBlocks,
  extractGfmTables,
  extractLinearizedRows,
  extractListBlocks,
  flattenIndent,
  hasUnbalancedFence,
  headerlessTableRuns,
  isHeadingOnly,
  isTinyBody,
  jaccard,
  nearDuplicateClusters,
  occurrenceFilter,
  parseArgs,
  pipeRuns,
  quantile,
  startsMidLinearizedRow,
  tableRowLines,
} from './audit_chunk.js';

// --- вспомогательное: текст заведомо больше бюджета ------------------------

/** Строки SQL, каждая своя (одинаковые строки не годятся: они не отпечаток). */
function sqlLines(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `SELECT col_${i} FROM schema_${i}.table_${i} WHERE partition_dt = '2026-01-${i}';`,
  ).join('\n');
}

function proseLines(count: number, tag: string): string {
  return Array.from(
    { length: count },
    (_, i) => `Абзац ${tag} номер ${i}: описание процесса обработки событий и расчёта витрины.`,
  ).join('\n\n');
}

// ===========================================================================

describe('арифметика', () => {
  it('квантиль берётся по ближайшему рангу', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(sorted, 0.5)).toBe(5);
    expect(quantile(sorted, 0.9)).toBe(9);
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([7], 0.9)).toBe(7);
  });

  it('распределение считает count/min/median/p90/max/total', () => {
    expect(distribution([3, 1, 2])).toEqual({
      count: 3,
      min: 1,
      median: 2,
      p90: 3,
      max: 3,
      total: 6,
    });
    expect(distribution([])).toEqual({ count: 0, min: 0, median: 0, p90: 0, max: 0, total: 0 });
  });

  it('Жаккар: пересечение к объединению', () => {
    expect(jaccard(new Set([1, 2, 3, 4]), new Set([3, 4, 5, 6]))).toBeCloseTo(2 / 6, 10);
    expect(jaccard(new Set([1, 2]), new Set([1, 2]))).toBe(1);
    expect(jaccard(new Set([1]), new Set())).toBe(0);
  });
});

describe('тело чанка', () => {
  it('снимает хлебную крошку', () => {
    expect(chunkBody('Заметка > Раздел\n\nтекст', 'Заметка > Раздел')).toBe('текст');
  });

  it('снимает префикс табличного чанка', () => {
    const text = 'Заметка > Раздел > Таблица: Тарифы\n\n| A |\n| --- |';
    expect(chunkBody(text, 'Заметка > Раздел')).toBe('| A |\n| --- |');
  });

  it('снимает аннотацию документа перед крошкой', () => {
    const text = `${DOC_SUMMARY_PREFIX}про витрины\n\nЗаметка\n\nтекст`;
    expect(chunkBody(text, 'Заметка')).toBe('текст');
  });

  it('оставляет текст как есть, если крошки нет', () => {
    expect(chunkBody('просто текст', 'Другой путь')).toBe('просто текст');
  });
});

describe('разметка внутри чанка', () => {
  it('непарный забор ловится по нечётному числу строк-заборов', () => {
    expect(hasUnbalancedFence('```sql\nSELECT 1;')).toBe(true);
    expect(hasUnbalancedFence('```sql\nSELECT 1;\n```')).toBe(false);
    expect(hasUnbalancedFence('текст без забора')).toBe(false);
  });

  it('прогон строк таблицы с шапкой и без', () => {
    const withHeader = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    expect(pipeRuns(withHeader)).toHaveLength(1);
    expect(headerlessTableRuns(withHeader)).toHaveLength(0);

    const continuation = 'какой-то текст\n| 1 | 2 |\n| 3 | 4 |';
    expect(headerlessTableRuns(continuation)).toHaveLength(1);
    expect(headerlessTableRuns(continuation)[0]?.lines).toEqual(['| 1 | 2 |', '| 3 | 4 |']);
  });

  it('строки данных таблицы — без шапки и разделителя', () => {
    const rendered = '| Атрибут | Тип |\n| --- | --- |\n| event_id | string |\n| amount | bigint |';
    expect(tableRowLines(rendered)).toEqual(['| event_id | string |', '| amount | bigint |']);
  });

  it('чанк из одних заголовков и чанк-огрызок', () => {
    expect(isHeadingOnly('# Тарифы\n\n### Команда')).toBe(true);
    expect(isHeadingOnly('# Тарифы\n\nтекст')).toBe(false);
    expect(isTinyBody('короткий хвост')).toBe(true);
    expect(isTinyBody('x'.repeat(100))).toBe(false);
  });

  it('отступы не считаются содержимым', () => {
    expect(flattenIndent('   | A |\n   | 1 |')).toBe('| A |\n| 1 |');
  });
});

describe('блоки исходника', () => {
  it('заборы кода: язык и тело', () => {
    const md = 'текст\n\n```sql\nSELECT 1;\nSELECT 2;\n```\n\nещё\n\n```\nplain\n```';
    const blocks = extractFencedBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.lang).toBe('sql');
    expect(blocks[0]?.body).toBe('SELECT 1;\nSELECT 2;');
    expect(blocks[1]?.lang).toBe('');
  });

  it('GFM-таблицы: только шапка + разделитель считаются началом', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nтекст\n\n| нет | разделителя |';
    const tables = extractGfmTables(md);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.rows).toBe(2);
  });

  it('списки: блок из двух и более пунктов вместе с продолжениями', () => {
    const md = 'вступление\n\n- раз\n- два\n  продолжение\n\nхвост\n\n- одинокий';
    const blocks = extractListBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBe('- раз\n- два\n  продолжение');
  });

  it('линеаризованные строки таблицы', () => {
    const md = '**Название:** А. **Тип:** B.\nобычный абзац\n**Название:** C. **Тип:** D.';
    expect(extractLinearizedRows(md)).toHaveLength(2);
  });

  it('чанк, начавшийся с середины линеаризованной строки', () => {
    const rows = ['Название: event_id. Тип: string. Описание: идентификатор события.'];
    expect(startsMidLinearizedRow('Тип: string. Описание: идентификатор события.', rows)).toBe(
      true,
    );
    expect(startsMidLinearizedRow('Название: event_id. Тип: string.', rows)).toBe(false);
    expect(startsMidLinearizedRow('совершенно другой абзац страницы', rows)).toBe(false);
    expect(startsMidLinearizedRow('короткий', rows)).toBe(false);
  });

  it('фильтр уникальных строк оставляет отпечаток, а на сплошных повторах не молчит', () => {
    const filter = occurrenceFilter(['повтор', 'повтор', 'уникальная']);
    expect(filter(['повтор', 'уникальная'])).toEqual(['уникальная']);
    expect(filter(['повтор'])).toEqual(['повтор']);
  });
});

describe('замер страницы', () => {
  it('короткая страница — один чанк, ни одной находки', () => {
    const page = auditPage('note.md', '---\ntitle: x\n---\n\n# Заголовок\n\nКороткий текст.\n');
    expect(page.metrics.chunks).toBe(1);
    expect(page.metrics.findings.filter((f) => f.kind !== 'tiny_chunk')).toHaveLength(0);
    expect(page.metrics.parentIdCollisions).toBe(0);
  });

  it('фронтматтер не попадает в чанки', () => {
    const page = auditPage('note.md', '---\nsecret: 42\n---\n\nТекст страницы.\n');
    expect(page.records[0]?.text).not.toContain('secret');
  });

  it('переразмерный забор кода разрезан, но каждый кусок остаётся огороженным', () => {
    // Раньше тест фиксировал потерю: `nodeToText` возвращал голое содержимое,
    // и `fencesInChunks` был нулём — код вклеивался в прозу без признака кода,
    // а язык блока пропадал. Чанкер это чинит; линейка не менялась, меряется
    // ровно то же самое, но теперь заборы обязаны доходить до чанков.
    const body = `# Инструкция\n\nПеред запуском:\n\n\`\`\`sql\n${sqlLines(120)}\n\`\`\`\n`;
    expect(countTokens(sqlLines(120))).toBeGreaterThan(MAX_CHUNK_TOKENS);

    const page = auditPage('sql.md', body);
    expect(page.metrics.codeBlocks).toBe(1);
    expect(page.metrics.codeBlocksSplit).toBe(1);
    expect(page.metrics.codeBlocksLost).toBe(0);
    expect(page.metrics.fencesInSource).toBe(2);
    // По два забора на каждый кусок — иначе обрывок нечем опознать как код.
    expect(page.metrics.fencesInChunks).toBeGreaterThanOrEqual(4);
    expect(page.metrics.fencesInChunks % 2).toBe(0);
    expect(page.metrics.unbalancedFenceChunks).toBe(0);
    const split = page.metrics.findings.find((f) => f.kind === 'code_split');
    expect(split?.spans).toBeGreaterThan(1);
  });

  it('забор в бюджете не считается разорванным', () => {
    const page = auditPage('sql.md', `# Инструкция\n\n\`\`\`sql\n${sqlLines(5)}\n\`\`\`\n`);
    expect(page.metrics.codeBlocks).toBe(1);
    expect(page.metrics.codeBlocksSplit).toBe(0);
  });

  it('таблица целиком в чанке — ни разрывов, ни строк без шапки', () => {
    const rows = Array.from({ length: 6 }, (_, i) => `| поле_${i} | string | описание ${i} |`).join(
      '\n',
    );
    const page = auditPage(
      'table.md',
      `# Витрина\n\n${proseLines(4, 'до')}\n\n| Атрибут | Тип | Значение |\n| --- | --- | --- |\n${rows}\n`,
    );
    expect(page.metrics.tablesInSource).toBe(1);
    expect(page.metrics.tablesIntact).toBe(1);
    expect(page.metrics.tablesSplit).toBe(0);
    expect(page.metrics.headerlessTableChunks).toBe(0);
  });

  it('большая таблица режется по строкам и каждый кусок несёт шапку', () => {
    const rows = Array.from(
      { length: 220 },
      (_, i) => `| атрибут_${i} | string | описание значения номер ${i} для витрины |`,
    ).join('\n');
    const page = auditPage(
      'big-table.md',
      `# Витрина\n\n| Атрибут | Тип | Значение |\n| --- | --- | --- |\n${rows}\n`,
    );
    expect(page.metrics.kinds.table_rows).toBeGreaterThan(1);
    expect(page.metrics.headerlessTableChunks).toBe(0);
    expect(page.metrics.tableRowsLost).toBe(0);
    expect(page.metrics.tablesChunkedByDesign).toBe(1);
  });

  it('линеаризованная строка длиннее бюджета считается разорванной', () => {
    const fields = Array.from(
      { length: 60 },
      (_, i) => `**Поле ${i}:** значение номер ${i} с пояснением про расчёт витрины`,
    ).join('. ');
    const page = auditPage('lin.md', `# Реестр\n\n${fields}.\n`);
    expect(page.metrics.linearizedRows).toBe(1);
    expect(page.metrics.linearizedRowsOverBudget).toBe(1);
    expect(page.metrics.linearizedRowsSplit).toBe(1);
  });

  it('короткие линеаризованные строки не считаются разорванными', () => {
    const rows = Array.from(
      { length: 5 },
      (_, i) => `**Название:** поток_${i}. **Тип:** стриминг. **Владелец:** команда_${i}.`,
    ).join('\n\n');
    const page = auditPage('lin-ok.md', `# Реестр\n\n${rows}\n`);
    expect(page.metrics.linearizedRows).toBe(5);
    expect(page.metrics.linearizedRowsSplit).toBe(0);
  });

  it('подпись перед переразмерным блоком уезжает вместе с ним, а не остаётся огрызком', () => {
    // Тест фиксировал дефект: буфер сбрасывался перед переразмерным узлом, а
    // дослияние работало только с хвостом, поэтому подводка вида «Пример
    // конфигурации:» становилась отдельным чанком в 21 символ. Метрика не
    // менялась — изменился чанкер, и подпись обязана ехать с тем, что она
    // подписывает.
    const page = auditPage(
      'caption.md',
      `# Конфигурация\n\nПример конфигурации:\n\n\`\`\`\n${sqlLines(120)}\n\`\`\`\n`,
    );
    expect(page.metrics.tinyChunks).toBe(0);
    expect(page.metrics.findings.some((f) => f.kind === 'tiny_chunk')).toBe(false);
    expect(page.records[0]?.text).toContain('Пример конфигурации:');
  });

  it('раздел длиннее section_max_chars виден в метрике', () => {
    const page = auditPage('long.md', `# Раздел\n\n${proseLines(80, 'длинный')}\n`);
    expect(page.metrics.sectionsOverCap).toBe(1);
    expect(page.metrics.sectionChars.max).toBeGreaterThan(4000);
  });

  it('бюджет: чанков сверх MAX_CHUNK_TOKENS нет', () => {
    const page = auditPage('long.md', `# Раздел\n\n${proseLines(80, 'бюджет')}\n`);
    expect(page.metrics.overBudget).toBe(0);
    expect(page.metrics.tokens.max).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
  });
});

describe('дубликаты', () => {
  const shared = `# Регламент\n\n${proseLines(8, 'общий')}\n`;

  it('одинаковый раздел в двух файлах даёт один кластер', () => {
    const a = auditPage('a.md', shared);
    const b = auditPage('b.md', shared);
    const clusters = nearDuplicateClusters([...a.records, ...b.records], 0.8);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.files).toEqual(['a.md', 'b.md']);
    expect(clusters[0]?.size).toBe(a.records.length + b.records.length);
  });

  it('повторы внутри одного файла кластером не считаются', () => {
    const a = auditPage('a.md', `${shared}\n\n${shared}`);
    expect(nearDuplicateClusters(a.records, 0.8)).toHaveLength(0);
  });

  it('разный текст порога не проходит', () => {
    const a = auditPage('a.md', `# Регламент\n\n${proseLines(8, 'первый')}\n`);
    const b = auditPage('b.md', `# Другое\n\n${proseLines(8, 'второй')}\n`);
    const clusters = nearDuplicateClusters([...a.records, ...b.records], 0.8);
    expect(clusters).toHaveLength(0);
  });

  it('побайтово одинаковые тела группируются по файлам', () => {
    const a = auditPage('a.md', shared);
    const b = auditPage('b.md', shared);
    const groups = exactDuplicateGroups([...a.records, ...b.records]);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groups[0]?.files).toEqual(['a.md', 'b.md']);
  });
});

// --- выгрузка чанков (--chunks, вход для стыка 3) --------------------------

describe('выгрузка чанков', () => {
  it('строка выгрузки несёт ровно те поля, по которым считается попадание', () => {
    const page = auditPage(
      'Confluence/OASISEXT/Регламент.md',
      '# Регламент\n\n## Шаги\n\nПервый шаг.\n',
    );
    const record = page.records[0];
    expect(record).toBeDefined();
    const line = JSON.parse(chunkExportLine(record!)) as Record<string, unknown>;
    expect(line.path).toBe('Confluence/OASISEXT/Регламент.md');
    expect(line.section_path).toBe(record?.sectionPath);
    expect(line.parent_id).toBe(record?.parentId);
    expect(line.content_kind).toBe(record?.contentKind);
    expect(line.text).toBe(record?.text);
    expect(line.chunk_index).toBe(record?.chunkIndex);
    // Разреженный вектор НЕ выгружается: лексическую сторону обоих корпусов
    // («до» и «после») обязан считать один и тот же bm25.ts, а не два разных.
    expect(line).not.toHaveProperty('indices');
  });

  it('строка выгрузки — одна строка JSON, без переводов внутри', () => {
    const page = auditPage('a.md', '# Заголовок\n\nСтрока один.\nСтрока два.\n');
    for (const record of page.records) {
      expect(chunkExportLine(record)).not.toContain('\n');
    }
  });

  it('--chunks разбирается и по умолчанию пуст', () => {
    expect(parseArgs(['--vault', 'v', '--out', 'o']).chunks).toBe('');
    expect(parseArgs(['--vault', 'v', '--out', 'o', '--chunks', 'c.jsonl']).chunks).toBe('c.jsonl');
  });
});
