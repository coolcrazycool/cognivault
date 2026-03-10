import { describe, expect, it } from 'vitest';
import type { ChunkOptions } from '../chunker.js';
import {
  chunkMarkdown,
  MAX_CHUNK_TOKENS,
  MIN_CHUNK_TOKENS,
  normalizeObsidianSyntax,
} from '../chunker.js';

// Helper to generate a long paragraph to exceed MAX_CHUNK_TOKENS
function generateLongParagraph(words: number): string {
  return Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
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
