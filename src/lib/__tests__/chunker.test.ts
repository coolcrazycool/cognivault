import { getEncoding } from 'js-tiktoken';
import { describe, expect, it } from 'vitest';
import type { ChunkOptions } from '../chunker.js';
import {
  chunkMarkdown,
  chunkMarkdownWithSections,
  MAX_CHUNK_TOKENS,
  MIN_CHUNK_TOKENS,
  normalizeObsidianSyntax,
  TABLE_MAX_TOKENS,
} from '../chunker.js';

const enc = getEncoding('cl100k_base');

function countTokens(text: string): number {
  return enc.encode(text).length;
}

// Helper to generate a long paragraph to exceed MAX_CHUNK_TOKENS
function generateLongParagraph(words: number): string {
  return Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
}

const TABLE_HEADER = '| Регион | Тариф | Комментарий |';
const TABLE_DELIMITER = '| --- | --- | --- |';

/** A GFM table whose rendered form is byte-identical to its source rows. */
function makeTable(rowCount: number): { rows: string[]; markdown: string } {
  const rows = Array.from(
    { length: rowCount },
    (_, i) => `| Регион ${i} | ${100 + i} руб | комментарий про регион номер ${i} |`,
  );
  return { rows, markdown: [TABLE_HEADER, TABLE_DELIMITER, ...rows].join('\n') };
}

/** Lines of a table chunk after its context prefix, blank line, header and delimiter. */
function dataRowsOf(chunkText: string): string[] {
  return chunkText.split('\n').slice(4);
}

describe('normalizeObsidianSyntax', () => {
  it('converts [[Page Name]] to "Page Name"', () => {
    expect(normalizeObsidianSyntax('See [[Page Name]] for details')).toBe(
      'See Page Name for details',
    );
  });

  it('converts [[Page|Alias]] to "Alias"', () => {
    expect(normalizeObsidianSyntax('See [[Real Page|Alias]] for details')).toBe(
      'See Alias for details',
    );
  });

  it('strips ![[embed]] embeds', () => {
    expect(normalizeObsidianSyntax('Before ![[embedded-note]] after')).toBe('Before  after');
  });

  it('keeps callout text as-is', () => {
    const callout = '> [!note] This is a callout\n> Content here';
    expect(normalizeObsidianSyntax(callout)).toBe(callout);
  });

  it('handles multiple wikilinks in same text', () => {
    const text = '[[Note A]] and [[Note B|alias B]] are linked';
    expect(normalizeObsidianSyntax(text)).toBe('Note A and alias B are linked');
  });

  it('handles text with no Obsidian syntax unchanged', () => {
    const text = 'Regular markdown text with **bold** and _italic_';
    expect(normalizeObsidianSyntax(text)).toBe(text);
  });
});

describe('chunkMarkdown constants', () => {
  it('exports MIN_CHUNK_TOKENS as ~100', () => {
    expect(MIN_CHUNK_TOKENS).toBe(100);
  });

  it('exports MAX_CHUNK_TOKENS as ~500', () => {
    expect(MAX_CHUNK_TOKENS).toBe(500);
  });
});

describe('chunkMarkdown - frontmatter handling', () => {
  it('returns empty array for frontmatter-only note (no body)', () => {
    const body = ''; // gray-matter already stripped; empty body
    const opts: ChunkOptions = { title: 'Test Note' };
    expect(chunkMarkdown(body, opts)).toEqual([]);
  });

  it('returns empty array for whitespace-only body', () => {
    const opts: ChunkOptions = { title: 'Test Note' };
    expect(chunkMarkdown('   \n\n  ', opts)).toEqual([]);
  });
});

describe('chunkMarkdown - IDX-03: heading boundary splitting', () => {
  it('splits at H1 and H2 heading boundaries', () => {
    // Use content >= MIN_CHUNK_TOKENS per section so each stays as its own chunk
    const para1 = generateLongParagraph(110); // ~110 tokens
    const para2 = generateLongParagraph(110);
    const body = `# H1\n\n${para1}\n\n## H2\n\n${para2}`;
    const opts: ChunkOptions = { title: 'Test Note' };
    const chunks = chunkMarkdown(body, opts);

    expect(chunks.length).toBe(2);
    expect(chunks[0]?.sectionPath).toBe('Test Note');
    expect(chunks[1]?.sectionPath).toBe('Test Note > H2');
  });

  it('does NOT split at heading inside a fenced code block', () => {
    const body = [
      '# Section One',
      '',
      'Some text',
      '',
      '```markdown',
      '## fake heading inside code',
      '```',
      '',
      'More text',
    ].join('\n');
    const opts: ChunkOptions = { title: 'Code Note' };
    const chunks = chunkMarkdown(body, opts);

    // Only one section (H1), code block heading should not create a new chunk
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.sectionPath).toBe('Code Note');
  });

  it('keeps GFM table whole and attached to its section', () => {
    const body = [
      '## Section with Table',
      '',
      'Some text before.',
      '',
      '| Col A | Col B |',
      '| ----- | ----- |',
      '| cell1 | cell2 |',
      '',
      'Some text after.',
    ].join('\n');
    const opts: ChunkOptions = { title: 'Table Note' };
    const chunks = chunkMarkdown(body, opts);

    // All content should be in one chunk for this section
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toContain('Col A');
    expect(chunks[0]?.text).toContain('cell1');
  });

  it('creates single section for note with no headings', () => {
    const body = 'Just some plain text paragraph.\n\nAnother paragraph.';
    const opts: ChunkOptions = { title: 'Plain Note' };
    const chunks = chunkMarkdown(body, opts);

    expect(chunks.length).toBe(1);
    expect(chunks[0]?.sectionPath).toBe('Plain Note');
  });
});

describe('chunkMarkdown - IDX-03: short section merging', () => {
  it('merges short H2 section (<100 tokens) into parent section', () => {
    const body = [
      '## Parent Section',
      '',
      'This is longer parent content that has some meaningful text.',
      '',
      '### Short Child',
      '',
      'Tiny.',
    ].join('\n');
    const opts: ChunkOptions = { title: 'Merge Note' };
    const chunks = chunkMarkdown(body, opts);

    // The "Tiny." H3 section should merge into parent H2 section
    expect(chunks.length).toBe(1);
  });

  it('keeps section that is >= MIN_CHUNK_TOKENS separate', () => {
    // Generate a body where parent section has plenty of tokens
    const parentContent = generateLongParagraph(80); // ~80 words, well over 100 tokens
    const childContent = generateLongParagraph(80);
    const body = `## Parent\n\n${parentContent}\n\n### Child\n\n${childContent}`;
    const opts: ChunkOptions = { title: 'Keep Separate' };
    const chunks = chunkMarkdown(body, opts);

    // Both sections have enough tokens to stand alone
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('chunkMarkdown - IDX-03: long section splitting', () => {
  it('splits section >500 tokens at paragraph boundaries', () => {
    // Generate content significantly over 500 tokens
    const para1 = generateLongParagraph(150); // ~150 tokens each
    const para2 = generateLongParagraph(150);
    const para3 = generateLongParagraph(150);
    const para4 = generateLongParagraph(150);

    const body = `## Long Section\n\n${para1}\n\n${para2}\n\n${para3}\n\n${para4}`;
    const opts: ChunkOptions = { title: 'Long Note' };
    const chunks = chunkMarkdown(body, opts);

    // Should be split into multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be <=500 tokens in content (rough check)
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThan(5000); // rough upper bound
    }
  });

  it('assigns correct chunkIndex to multiple chunks from same long section', () => {
    const para1 = generateLongParagraph(150);
    const para2 = generateLongParagraph(150);
    const para3 = generateLongParagraph(150);
    const para4 = generateLongParagraph(150);

    const body = `## Long\n\n${para1}\n\n${para2}\n\n${para3}\n\n${para4}`;
    const opts: ChunkOptions = { title: 'Index Test' };
    const chunks = chunkMarkdown(body, opts);

    // chunkIndex should be sequential starting at 0
    chunks.forEach((chunk, idx) => {
      expect(chunk.chunkIndex).toBe(idx);
    });
  });
});

describe('chunkMarkdown - IDX-04: section path metadata', () => {
  it('creates hierarchical section path for nested headings', () => {
    // Use content >= MIN_CHUNK_TOKENS per section so each section produces its own chunk
    const intro = generateLongParagraph(110);
    const content = generateLongParagraph(110);
    const subContent = generateLongParagraph(110);
    const body = `# Title\n\n${intro}\n\n## Section\n\n${content}\n\n### Sub\n\n${subContent}`;
    const opts: ChunkOptions = { title: 'Hierarchy Note' };
    const chunks = chunkMarkdown(body, opts);

    const paths = chunks.map((c) => c.sectionPath);
    expect(paths).toContain('Hierarchy Note');
    expect(paths).toContain('Hierarchy Note > Section');
    expect(paths).toContain('Hierarchy Note > Section > Sub');
  });

  it('resets hierarchy when same-level heading follows', () => {
    // Use content >= MIN_CHUNK_TOKENS per section so each section produces its own chunk
    const contentA = generateLongParagraph(110);
    const contentB = generateLongParagraph(110);
    const body = `## A\n\n${contentA}\n\n## B\n\n${contentB}`;
    const opts: ChunkOptions = { title: 'Sibling Note' };
    const chunks = chunkMarkdown(body, opts);

    const paths = chunks.map((c) => c.sectionPath);
    expect(paths).toContain('Sibling Note > A');
    expect(paths).toContain('Sibling Note > B');
    // B should NOT be nested under A
    expect(paths).not.toContain('Sibling Note > A > B');
  });

  it('handles H3 after H1 (skipping H2) correctly', () => {
    // Use content >= MIN_CHUNK_TOKENS per section
    const topContent = generateLongParagraph(110);
    const deepContent = generateLongParagraph(110);
    const body = `# Top\n\n${topContent}\n\n### Deep\n\n${deepContent}`;
    const opts: ChunkOptions = { title: 'Skip Note' };
    const chunks = chunkMarkdown(body, opts);

    const paths = chunks.map((c) => c.sectionPath);
    expect(paths).toContain('Skip Note');
    expect(paths).toContain('Skip Note > Deep');
  });
});

describe('chunkMarkdown - chunk text format', () => {
  it('prepends "Note Title > Section Path\\n\\n" to chunk text', () => {
    const body = '## My Section\n\nSome content here.';
    const opts: ChunkOptions = { title: 'My Note' };
    const chunks = chunkMarkdown(body, opts);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.text).toMatch(/^My Note > My Section\n\n/);
  });

  it('prepends just note title for top-level content', () => {
    const body = 'Intro paragraph without headings.';
    const opts: ChunkOptions = { title: 'Simple Note' };
    const chunks = chunkMarkdown(body, opts);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.text).toMatch(/^Simple Note\n\n/);
  });
});

describe('chunkMarkdown - Obsidian syntax normalization', () => {
  it('normalizes wikilinks in chunk text', () => {
    const body = '## Section\n\nSee [[Other Note]] for details.';
    const opts: ChunkOptions = { title: 'Wiki Note' };
    const chunks = chunkMarkdown(body, opts);

    expect(chunks[0]?.text).toContain('Other Note');
    expect(chunks[0]?.text).not.toContain('[[');
  });

  it('normalizes aliased wikilinks in chunk text', () => {
    const body = '## Section\n\nSee [[Real Page|display name]] here.';
    const opts: ChunkOptions = { title: 'Alias Note' };
    const chunks = chunkMarkdown(body, opts);

    expect(chunks[0]?.text).toContain('display name');
    expect(chunks[0]?.text).not.toContain('[[');
  });

  it('strips embeds from chunk text', () => {
    const body = '## Section\n\nBefore ![[embedded-note]] after.';
    const opts: ChunkOptions = { title: 'Embed Note' };
    const chunks = chunkMarkdown(body, opts);

    expect(chunks[0]?.text).not.toContain('![[');
    expect(chunks[0]?.text).not.toContain('embedded-note');
  });
});

describe('chunkMarkdown - chunkIndex ordering', () => {
  it('assigns sequential chunkIndex across all chunks', () => {
    const body = '## A\n\nContent A\n\n## B\n\nContent B\n\n## C\n\nContent C';
    const opts: ChunkOptions = { title: 'Multi Note' };
    const chunks = chunkMarkdown(body, opts);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    chunks.forEach((chunk, idx) => {
      expect(chunk.chunkIndex).toBe(idx);
    });
  });
});

describe('chunkMarkdown - parentId (small-to-big parents)', () => {
  it('gives two different H1 sections different parentIds despite an identical sectionPath', () => {
    // H1 headings are transparent, so both sections carry the bare note title as their
    // sectionPath. Hashing only the path would collapse them into one parent — the
    // section ordinal is what keeps them apart.
    const alpha = generateLongParagraph(110);
    const beta = generateLongParagraph(110);
    const body = `# Alpha\n\n${alpha}\n\n# Beta\n\n${beta}`;
    const opts: ChunkOptions = { title: 'Two Tops', path: 'notes/two-tops.md' };
    const chunks = chunkMarkdown(body, opts);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.sectionPath).toBe('Two Tops');
    expect(chunks[1]?.sectionPath).toBe('Two Tops');
    expect(chunks[0]?.parentId).not.toBe(chunks[1]?.parentId);
  });

  it('gives every chunk of one split section the same parentId', () => {
    const paragraphs = [
      generateLongParagraph(200),
      generateLongParagraph(200),
      generateLongParagraph(200),
    ].join('\n\n');
    const body = `## Long Section\n\n${paragraphs}`;
    const opts: ChunkOptions = { title: 'Split Note' };
    const chunks = chunkMarkdown(body, opts);

    expect(chunks.length).toBeGreaterThan(1);
    const parentIds = new Set(chunks.map((c) => c.parentId));
    expect(parentIds.size).toBe(1);
  });

  it('keeps parentId stable when the file is moved to another folder', () => {
    const body = `## A\n\n${generateLongParagraph(110)}\n\n## B\n\n${generateLongParagraph(110)}`;
    const before = chunkMarkdown(body, { title: 'Stable', path: 'inbox/stable.md' });
    const after = chunkMarkdown(body, { title: 'Stable', path: 'archive/2026/stable.md' });

    expect(before.map((c) => c.parentId)).toEqual(after.map((c) => c.parentId));
  });

  it('produces a sha1-shaped parentId', () => {
    const chunks = chunkMarkdown('Intro paragraph without headings.', { title: 'Simple' });
    expect(chunks[0]?.parentId).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('chunkMarkdown - table-aware chunking', () => {
  it('renders a small inline table as markdown rows instead of glued cell text', () => {
    const body = '## Раздел\n\n| Col A | Col B |\n| --- | --- |\n| cell1 | cell2 |';
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('| Col A | Col B |');
    expect(chunks[0]?.text).toContain('| cell1 | cell2 |');
    // Small enough to live next to prose — not a dedicated table chunk.
    expect(chunks[0]?.contentKind).toBe('text');
  });

  it('keeps a table that fits the table budget in a single chunk', () => {
    const { markdown } = makeTable(30);
    const body = `## Тарифы\n\nТаблица тарифов.\n\n${markdown}`;
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks).toHaveLength(1);
    const only = chunks[0];
    expect(only?.contentKind).toBe('table_rows');
    // Genuinely on the table path: over the prose budget, under the table budget.
    expect(countTokens(only?.text ?? '')).toBeGreaterThan(MAX_CHUNK_TOKENS);
    expect(countTokens(only?.text ?? '')).toBeLessThanOrEqual(TABLE_MAX_TOKENS);
    expect(dataRowsOf(only?.text ?? '')).toHaveLength(30);
  });

  it('cuts an oversized table into row groups that each repeat prefix, header and delimiter', () => {
    const { markdown } = makeTable(100);
    const body = `## Тарифы\n\nТаблица тарифов по регионам.\n\n${markdown}`;
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.contentKind).toBe('table_rows');
      const lines = chunk.text.split('\n');
      expect(lines[0]).toBe('Док > Тарифы > Таблица: Таблица тарифов по регионам.');
      expect(lines[1]).toBe('');
      expect(lines[2]).toBe(TABLE_HEADER);
      expect(lines[3]).toBe(TABLE_DELIMITER);
      expect(countTokens(chunk.text)).toBeLessThanOrEqual(TABLE_MAX_TOKENS);

      const dataRows = dataRowsOf(chunk.text);
      expect(dataRows.length).toBeGreaterThanOrEqual(15);
      expect(dataRows.length).toBeLessThanOrEqual(40);
    }
  });

  it('never splits a row: every source row appears once, whole and in order', () => {
    const { rows, markdown } = makeTable(100);
    const body = `## Тарифы\n\nТаблица тарифов по регионам.\n\n${markdown}`;
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks.flatMap((chunk) => dataRowsOf(chunk.text))).toEqual(rows);
  });

  it('omits the caption entirely rather than leaving a dangling separator', () => {
    const { markdown } = makeTable(100);
    const body = `## Тарифы\n\n${markdown}`;
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith('Док > Тарифы > Таблица\n\n')).toBe(true);
      expect(chunk.text).not.toContain('Таблица:');
      expect(chunk.text).not.toContain('> \n');
    }
  });

  it('does not repeat a caption paragraph as its own stub chunk', () => {
    const { markdown } = makeTable(100);
    const body = `## Тарифы\n\nТаблица тарифов по регионам.\n\n${markdown}`;
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks.every((chunk) => chunk.contentKind === 'table_rows')).toBe(true);
  });

  it('gives every row group of one table the same parentId and one whole-table parent', () => {
    const { markdown } = makeTable(100);
    const body = `## Тарифы\n\nТаблица тарифов по регионам.\n\n${markdown}`;
    const { chunks, sections } = chunkMarkdownWithSections(body, { title: 'Док' });

    expect(new Set(chunks.map((chunk) => chunk.parentId)).size).toBe(1);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain('| Регион 0 |');
    expect(sections[0]?.text).toContain('| Регион 99 |');
    expect(sections[0]?.parentId).toBe(chunks[0]?.parentId);
  });

  it('normalizes wikilinks and escapes pipes inside cells', () => {
    const { markdown } = makeTable(100);
    // A pipe inside a cell must be escaped in the source, or GFM reads it as a column
    // break — that is true of a wikilink alias too.
    const body = `## Тарифы\n\n${markdown}\n| [[Реальная страница\\|Алиас]] | a \\| b | хвост |`;
    const chunks = chunkMarkdown(body, { title: 'Док' });

    const cellChunk = chunks.find((chunk) => chunk.text.includes('Алиас'));
    expect(cellChunk).toBeDefined();
    expect(cellChunk?.text).not.toContain('[[');
    // An unescaped pipe inside a cell would fake an extra column.
    expect(cellChunk?.text).toContain('a \\| b');
  });

  it('marks prose chunks as text', () => {
    const body = `## Раздел\n\n${generateLongParagraph(110)}`;
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks.every((chunk) => chunk.contentKind === 'text')).toBe(true);
  });
});

describe('chunkMarkdown - block boundaries', () => {
  it('keeps list items apart instead of gluing them into one nonsense word', () => {
    const body = '## Настройка\n\n- открыть настройки\n- указать адрес сервера\n- сохранить';
    const chunks = chunkMarkdown(body, { title: 'Док' });

    const text = chunks[0]?.text ?? '';
    expect(text).toContain('- открыть настройки\n- указать адрес сервера\n- сохранить');
    // The glued form is the defect: it is a token no query can ever match.
    expect(text).not.toContain('настройкиуказать');
  });

  it('numbers an ordered list and indents a nested one under its item', () => {
    const body = '## Шаги\n\n1. первый шаг\n2. второй шаг\n   - вложенный пункт';
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks[0]?.text).toContain('1. первый шаг\n2. второй шаг\n   - вложенный пункт');
  });

  it('keeps task-list checkboxes and separates blockquote paragraphs', () => {
    const body =
      '## Разное\n\n- [ ] не сделано\n- [x] сделано\n\n> первый абзац\n>\n> второй абзац';
    const chunks = chunkMarkdown(body, { title: 'Док' });

    const text = chunks[0]?.text ?? '';
    expect(text).toContain('- [ ] не сделано\n- [x] сделано');
    expect(text).toContain('первый абзац\n\nвторой абзац');
  });

  it('honours a hard line break inside a paragraph', () => {
    const chunks = chunkMarkdown('## Перенос\n\nпервая строка  \nвторая строка', { title: 'Док' });

    expect(chunks[0]?.text).toContain('первая строка\nвторая строка');
  });
});

describe('chunkMarkdown - heading of a merged short section', () => {
  it('keeps the heading of a sub-MIN_CHUNK_TOKENS section in the merged chunk text', () => {
    const body = [
      '## Хранилище',
      '',
      generateLongParagraph(110),
      '',
      '### Квота арендатора',
      '',
      'до 20 ГБ.',
    ].join('\n');
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks).toHaveLength(1);
    // The short section has no sectionPath of its own, so the body is the only place
    // its heading words can survive.
    expect(chunks[0]?.sectionPath).toBe('Док > Хранилище');
    expect(chunks[0]?.text).toContain('### Квота арендатора');
    expect(chunks[0]?.text).toContain('до 20 ГБ.');
  });

  it('keeps the merged heading on the parent section as well', () => {
    const body = `## Big\n\n${generateLongParagraph(110)}\n\n## Приложение Б\n\nкоротко.`;
    const { sections } = chunkMarkdownWithSections(body, { title: 'Док' });

    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain('## Приложение Б');
  });
});

describe('chunkMarkdown - heading of a transparent H1 section', () => {
  it('keeps an H1 heading in the text of a section that stands on its own', () => {
    // H1 is transparent for sectionPath by design, so unlike an H2 the heading words
    // are nowhere in the breadcrumb — the body is the only place they can live.
    const body = `# Тарифы 2026\n\n${generateLongParagraph(110)}`;
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sectionPath).toBe('Док');
    expect(chunks[0]?.text).toContain('# Тарифы 2026');
  });

  it('keeps the H1 heading of the very first section, short and with no predecessor', () => {
    const body = '# Тарифы 2026\n\nкоротко про тарифы.';
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sectionPath).toBe('Док');
    expect(chunks[0]?.text).toContain('# Тарифы 2026');
    expect(chunks[0]?.text).toContain('коротко про тарифы.');
  });

  it('keeps each H1 heading with its own section when a note has several', () => {
    const body = `# Альфа\n\n${generateLongParagraph(110)}\n\n# Бета\n\n${generateLongParagraph(110)}`;
    const { chunks, sections } = chunkMarkdownWithSections(body, { title: 'Док' });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toContain('# Альфа');
    expect(chunks[0]?.text).not.toContain('# Бета');
    expect(chunks[1]?.text).toContain('# Бета');
    // Both sections still share the bare note title as their path (H1 stays
    // transparent) and are told apart by their ordinal, not by the heading.
    expect(chunks.map((c) => c.sectionPath)).toEqual(['Док', 'Док']);
    expect(chunks[0]?.parentId).not.toBe(chunks[1]?.parentId);
    expect(sections.map((s) => s.sectionPath)).toEqual(['Док', 'Док']);
  });

  it('does not repeat an H2 heading in the body — it is already in the breadcrumb', () => {
    const body = `## Хранилище\n\n${generateLongParagraph(110)}`;
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sectionPath).toBe('Док > Хранилище');
    expect(chunks[0]?.text).not.toContain('## Хранилище');
  });

  it('puts the H1 heading on the parent section too', () => {
    const body = `# Тарифы 2026\n\n${generateLongParagraph(300)}`;
    const { chunks, sections } = chunkMarkdownWithSections(body, { title: 'Док' });

    expect(chunks.length).toBeGreaterThan(1);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain('# Тарифы 2026');
  });
});

describe('chunkMarkdown - oversized single node', () => {
  it('cuts a paragraph larger than the budget instead of emitting it whole', () => {
    const body = `## Стена текста\n\n${generateLongParagraph(1000)}`;
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countTokens(chunk.text)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
      expect(chunk.text.startsWith('Док > Стена текста\n\n')).toBe(true);
    }
    // The tail used to reach the payload but not the vector — the embedder truncated it.
    expect(chunks[chunks.length - 1]?.text).toContain('word999');
  });

  it('cuts an oversized code block on line boundaries and keeps every part in budget', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `const value${i} = compute(${i});`);
    const body = `## Листинг\n\n\`\`\`ts\n${lines.join('\n')}\n\`\`\``;
    const chunks = chunkMarkdown(body, { title: 'Док' });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countTokens(chunk.text)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
    }
    expect(chunks.map((chunk) => chunk.text).join('\n')).toContain(
      'const value399 = compute(399);',
    );
  });

  it('keeps a table on the table path even when the prose budget is tighter', () => {
    const { markdown } = makeTable(100);
    const chunks = chunkMarkdown(`## Тарифы\n\n${markdown}`, { title: 'Док' });

    // Row-preserving table splitting must win over the generic oversized-node cut.
    expect(chunks.every((chunk) => chunk.contentKind === 'table_rows')).toBe(true);
  });
});

describe('chunkMarkdown - undersized tail handling', () => {
  it('merges a short trailing section into the last chunk of its predecessor', () => {
    const body = [
      '## Big',
      '',
      generateLongParagraph(300),
      '',
      generateLongParagraph(300),
      '',
      '## Tail',
      '',
      'tiny tail sentence.',
    ].join('\n');
    const chunks = chunkMarkdown(body, { title: 'T' });

    const last = chunks[chunks.length - 1];
    // The tail rides along with the previous chunk instead of forming a stub.
    expect(last?.text).toContain('word299');
    expect(last?.text).toContain('tiny tail sentence.');
  });

  it('never ends a split section with a sub-MIN_CHUNK_TOKENS scrap', () => {
    const body = [
      '## Big',
      '',
      generateLongParagraph(300),
      '',
      generateLongParagraph(300),
      '',
      'short closing remark.',
    ].join('\n');
    const chunks = chunkMarkdown(body, { title: 'T' });

    const last = chunks[chunks.length - 1];
    expect(last?.text).toContain('short closing remark.');
    expect(countTokens(last?.text ?? '')).toBeGreaterThanOrEqual(MIN_CHUNK_TOKENS);
  });

  it('does not fold a short trailing paragraph into a table chunk', () => {
    const { markdown } = makeTable(100);
    const body = `## Тарифы\n\n${markdown}\n\nИтого по таблице.`;
    const chunks = chunkMarkdown(body, { title: 'Док' });

    const last = chunks[chunks.length - 1];
    expect(last?.contentKind).toBe('text');
    expect(last?.text).toContain('Итого по таблице.');
    for (const chunk of chunks.filter((c) => c.contentKind === 'table_rows')) {
      expect(chunk.text).not.toContain('Итого');
    }
  });
});

describe('chunkMarkdownWithSections', () => {
  it('returns one section per parent, with every chunk pointing at an existing parent', () => {
    const body = `# Alpha\n\n${generateLongParagraph(110)}\n\n## Beta\n\n${generateLongParagraph(110)}`;
    const { chunks, sections } = chunkMarkdownWithSections(body, { title: 'Doc' });

    expect(sections).toHaveLength(2);
    const parentIds = new Set(sections.map((s) => s.parentId));
    expect(parentIds.size).toBe(2);
    for (const chunk of chunks) {
      expect(parentIds.has(chunk.parentId)).toBe(true);
    }
  });

  it('keeps the whole section text on the parent even when the chunks are split', () => {
    // Distinct markers: the filler words are identical, so only these tell the
    // beginning of the section apart from its end.
    const filler = generateLongParagraph(200);
    const body = `## Long\n\nalphamarker ${filler}\n\n${filler}\n\nomegamarker ${filler}`;
    const { chunks, sections } = chunkMarkdownWithSections(body, { title: 'Whole' });

    expect(chunks.length).toBeGreaterThan(1);
    expect(sections).toHaveLength(1);

    const parent = sections[0];
    expect(parent?.sectionPath).toBe('Whole > Long');
    expect(parent?.text).toMatch(/^Whole > Long\n\n/);
    // The parent spans content that no single chunk contains.
    expect(parent?.text).toContain('alphamarker');
    expect(parent?.text).toContain('omegamarker');
    expect(
      chunks.some((c) => c.text.includes('alphamarker') && c.text.includes('omegamarker')),
    ).toBe(false);
  });

  it('emits a single parent when a short section is merged into its predecessor', () => {
    const body = `## Big\n\n${generateLongParagraph(110)}\n\n## Tiny\n\nshort tail.`;
    const { chunks, sections } = chunkMarkdownWithSections(body, { title: 'Merged' });

    // The short section has no parent of its own — it lives inside the previous one.
    expect(sections).toHaveLength(1);
    expect(sections[0]?.sectionPath).toBe('Merged > Big');
    expect(sections[0]?.text).toContain('short tail.');
    expect(new Set(chunks.map((c) => c.parentId)).size).toBe(1);
  });

  it('returns empty chunks and sections for an empty body', () => {
    expect(chunkMarkdownWithSections('   \n\n ', { title: 'Empty' })).toEqual({
      chunks: [],
      sections: [],
    });
  });
});
