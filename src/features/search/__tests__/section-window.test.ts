import { describe, expect, it, vi } from 'vitest';
import type { SearchServiceLogger } from '../service.js';
import { chunkBody, locateChunk, SearchService } from '../service.js';

/**
 * Anchoring a retrieved chunk inside its own section — the step `sectionWindow` is built on.
 *
 * The fixtures are shaped like what the CHUNKER actually emits, because that is where the
 * misses came from: a chunk body does not always open with section text. A table chunk
 * repeats the header row above its own slice of the rows, a split code block gets a part
 * label and a reopened fence, a torn linearized row gets its identifying field repeated.
 * Each of those made `locateChunk` return -1, and the window fell back to the section prefix
 * with nothing in the logs — 14 of 182 measured anchors, 10 of them on sections long enough
 * for the fallback to actually lose the answer.
 */

// ── a table cut into groups of rows ──

const TABLE_SECTION_PATH = 'Стриминговые потоки > Активные потоки';
const TABLE_HEADER = '| ID потока | Статус | Наименование потока |';
const TABLE_DELIMITER = '| --- | --- | --- |';
const tableRow = (i: number): string => `| ${5500 + i} | [ACTIVE] | af_src_sss_unioned_${i} |`;
const TABLE_ROWS = Array.from({ length: 40 }, (_, i) => tableRow(i));
const TABLE_SECTION = `${TABLE_SECTION_PATH}\n\n${TABLE_HEADER}\n${TABLE_DELIMITER}\n${TABLE_ROWS.join('\n')}`;
/** `chunkTable`: the context prefix, then the header and delimiter above THIS group of rows. */
const TABLE_CHUNK = `${TABLE_SECTION_PATH} > Таблица: Таблица (часть 1 из 2)\n\n${TABLE_HEADER}\n${TABLE_DELIMITER}\n${TABLE_ROWS.slice(20, 30).join('\n')}`;

// ── a code block cut into fragments ──

const CODE_SECTION_PATH = 'Сервис получения ФИДов > Представление данных > SQL-запрос';
const codeLine = (i: number): string => `             number${i} AS feed_number_${i},`;
const CODE_LINES = Array.from({ length: 40 }, (_, i) => codeLine(i));
const CODE_SECTION = `${CODE_SECTION_PATH}\n\n\`\`\`sql\nCREATE MATERIALIZED VIEW fincert_feeds.feeds_all_view AS\nSELECT\n${CODE_LINES.join('\n')}\nFROM fincert_feeds.feed_fast_pay_number_view;\n\`\`\``;
/** `renderCodeFragment`: the part label (22 characters — under the minimum probe) and a fence. */
const CODE_CHUNK = `${CODE_SECTION_PATH}\n\nКод sql, часть 2 из 3:\n\`\`\`sql\n${CODE_LINES.slice(20, 30).join('\n')}\n\`\`\``;

// ── a linearized table row cut into fragments ──

const ROW_SECTION_PATH = 'Принципы работы моделей машинного обучения';
const ROW_TAIL =
  'Нюансы: в транзакциях данной модели отсутствует получатель платежа, учитываются сигналы из SDK мобильного устройства. Путь до результатов фин. эффекта (Q2): /share/antifraud/credits.';
const ROW_SECTION = [
  `${ROW_SECTION_PATH}\n`,
  'Название модели: ELCOM. Назначение: оценка онлайн-операции по карте. Нюансы: применяется в основном к ELCOM P2P. Путь до результатов фин. эффекта (Q2): /share/antifraud/elcom.',
  `Название модели: Кредитная. Назначение: доразметка платёжных операций Unirecevier. ${ROW_TAIL}`,
  'Название модели: ACQUIRER. Назначение: оценка эквайринговой операции. Нюансы: —. Путь до результатов фин. эффекта (Q2): фин. эффект не рассчитывается.',
].join('\n');
/** `chunkLinearizedRow`: the row's first field repeated, the fields in between left behind. */
const ROW_CHUNK = `${ROW_SECTION_PATH}\n\nНазвание модели: Кредитная. ${ROW_TAIL}`;

describe('chunkBody', () => {
  it('strips the breadcrumb every chunk carries', () => {
    expect(chunkBody('Заметка > Раздел\n\nтекст', 'Заметка > Раздел')).toBe('текст');
  });

  it('strips the EXTENDED breadcrumb of a table chunk', () => {
    // `${sectionPath} > Таблица: {caption}` — the section path alone never matches it, and
    // the residual line exists nowhere in the section.
    expect(chunkBody(TABLE_CHUNK, TABLE_SECTION_PATH)).toBe(
      `${TABLE_HEADER}\n${TABLE_DELIMITER}\n${TABLE_ROWS.slice(20, 30).join('\n')}`,
    );
  });

  it('strips the doc annotation ahead of the breadcrumb', () => {
    const text = 'Аннотация документа: о чём документ.\n\nЗаметка\n\nтекст';
    expect(chunkBody(text, 'Заметка')).toBe('текст');
  });

  it('with no section path strips the annotation and nothing else', () => {
    // What `collapseCrossFileDuplicates` asks for: comparing bodies must not depend on
    // whether INDEX_DOC_SUMMARY is on, but a breadcrumb is content there.
    expect(chunkBody('Аннотация документа: о чём.\n\nЗаметка\n\nтекст', '')).toBe(
      'Заметка\n\nтекст',
    );
  });

  it('leaves a body that carries no prefix alone', () => {
    expect(chunkBody('просто текст', 'Другой путь')).toBe('просто текст');
  });
});

describe('locateChunk', () => {
  it('finds a chunk that is in its section verbatim', () => {
    const body = chunkBody(
      `${TABLE_SECTION_PATH}\n\n${TABLE_ROWS.slice(3, 6).join('\n')}`,
      TABLE_SECTION_PATH,
    );
    expect(locateChunk(TABLE_SECTION, body)).toBe(TABLE_SECTION.indexOf(tableRow(3)));
  });

  it('anchors a table chunk on ITS OWN rows, not on the header the chunker repeats', () => {
    const body = chunkBody(TABLE_CHUNK, TABLE_SECTION_PATH);
    // The header row is in the section too — once, at the top of the table. Anchoring there
    // would centre the window on rows this chunk is not about.
    expect(locateChunk(TABLE_SECTION, body)).toBe(TABLE_SECTION.indexOf(tableRow(20)));
  });

  it('anchors a split code fence past its part label and reopened fence', () => {
    const body = chunkBody(CODE_CHUNK, CODE_SECTION_PATH);
    expect(locateChunk(CODE_SECTION, body)).toBe(CODE_SECTION.indexOf(codeLine(20)));
  });

  it('anchors a split linearized row past the identifying field it repeats', () => {
    const body = chunkBody(ROW_CHUNK, ROW_SECTION_PATH);
    expect(locateChunk(ROW_SECTION, body)).toBe(ROW_SECTION.indexOf(ROW_TAIL));
  });

  it('still relocates a chunk whose stored copy drifted past its opening', () => {
    // A table summary the indexer appended, or an edit to the note: no tail of the body is
    // section text any more, and only the probe can place it.
    const body = `${tableRow(31)}\n${tableRow(32)}\nСводка таблицы, которой в разделе нет.`;
    expect(locateChunk(TABLE_SECTION, body)).toBe(TABLE_SECTION.indexOf(tableRow(31)));
  });

  it('returns -1 when the chunk is genuinely gone from the section', () => {
    expect(locateChunk(TABLE_SECTION, 'этого текста в разделе больше нет')).toBe(-1);
    expect(locateChunk(TABLE_SECTION, '')).toBe(-1);
  });
});

/** The private methods the audit bridge reaches for; the cast is the same one it makes. */
interface WindowInternals {
  sectionWindow(
    sectionText: string,
    chunkText: string,
    sectionPath: string,
    limit: number,
    point?: Record<string, unknown>,
  ): string;
}

function serviceWith(logger?: SearchServiceLogger): WindowInternals {
  return new SearchService(
    undefined as never,
    undefined as never,
    undefined,
    logger,
  ) as unknown as WindowInternals;
}

describe('sectionWindow', () => {
  const LIMIT = 600;

  it('centres the window on the rows of a table chunk', () => {
    expect(TABLE_SECTION.length).toBeGreaterThan(LIMIT);
    const window = serviceWith().sectionWindow(
      TABLE_SECTION,
      TABLE_CHUNK,
      TABLE_SECTION_PATH,
      LIMIT,
    );

    expect(window).toContain(tableRow(20));
    expect(window).toContain(tableRow(29));
    expect(window.length).toBeLessThanOrEqual(LIMIT);
    // The premise: the prefix this replaces holds none of them
    expect(TABLE_SECTION.slice(0, LIMIT)).not.toContain(tableRow(20));
  });

  it('reports the fallback instead of degrading in silence', () => {
    const logger = { warn: vi.fn() };
    const window = serviceWith(logger).sectionWindow(
      TABLE_SECTION,
      'этого текста в разделе больше нет',
      TABLE_SECTION_PATH,
      LIMIT,
      { path: 'notes/streams.md', parent_id: 'parent-A', chunk_index: 7 },
    );

    expect(window).toBe(TABLE_SECTION.slice(0, LIMIT));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [context, message] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(context.path).toBe('notes/streams.md');
    expect(context.chunk_index).toBe(7);
    expect(context.section_path).toBe(TABLE_SECTION_PATH);
    expect(message).toContain('section window');
    // The note is named; its text is not. A log line is not a place to copy the vault into.
    expect(JSON.stringify(context)).not.toContain('af_src_sss_unioned');
  });

  it('says nothing when the chunk anchors, or when nothing is cut at all', () => {
    const logger = { warn: vi.fn() };
    serviceWith(logger).sectionWindow(TABLE_SECTION, TABLE_CHUNK, TABLE_SECTION_PATH, LIMIT);
    serviceWith(logger).sectionWindow(
      TABLE_SECTION,
      'этого текста в разделе больше нет',
      TABLE_SECTION_PATH,
      TABLE_SECTION.length,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
