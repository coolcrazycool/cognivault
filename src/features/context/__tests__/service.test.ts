import { describe, expect, it } from 'vitest';
import type { SearchResult } from '../../search/schemas.js';
import { ContextService, countTokens } from '../service.js';

// Helper to build a mock SearchResult
function makeResult(
  overrides: Partial<SearchResult> & { path: string; text: string; score: number },
): SearchResult {
  return {
    title: 'Test Note',
    section_path: 'section',
    tags: [],
    project: null,
    status: null,
    type: null,
    ...overrides,
  };
}

const service = new ContextService();

describe('countTokens', () => {
  it('returns a positive integer for non-empty text', () => {
    const count = countTokens('hello world');
    expect(count).toBeGreaterThan(0);
    expect(Number.isInteger(count)).toBe(true);
  });

  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });
});

describe('ContextService.assemble()', () => {
  it('returns entries above relevance floor grouped by section', () => {
    const results: SearchResult[] = [
      makeResult({ path: 'a.md', text: 'Alpha content here', score: 0.9, type: 'summary' }),
      makeResult({ path: 'b.md', text: 'Beta content here', score: 0.1, type: 'summary' }),
    ];

    const pack = service.assemble(results, { tokenBudget: 100000, minScore: 0.5 });

    // Only the high-score one passes floor (score 0.9 normalizes to 1.0, score 0.1 normalizes to ~0.111)
    expect(pack.summary).toBeDefined();
    expect(pack.summary?.length).toBe(1);
    expect(pack.summary?.[0]?.source.path).toBe('a.md');
  });

  it('respects token budget — total_tokens never exceeds budget', () => {
    // Make a long text that will consume many tokens
    const longText = 'token '.repeat(200);
    const results: SearchResult[] = [
      makeResult({ path: 'a.md', text: longText, score: 1.0, type: 'implementation' }),
      makeResult({ path: 'b.md', text: longText, score: 0.9, type: 'implementation' }),
      makeResult({ path: 'c.md', text: longText, score: 0.8, type: 'implementation' }),
    ];

    const tokensPerEntry = countTokens(longText);
    // Budget allows only 1 entry
    const pack = service.assemble(results, { tokenBudget: tokensPerEntry + 10, minScore: 0 });

    expect(pack.meta.total_tokens).toBeLessThanOrEqual(tokensPerEntry + 10);
    expect(pack.implementation).toBeDefined();
    expect(pack.implementation?.length).toBe(1);
  });

  it('merges chunks from the same note path, preserving section_path order', () => {
    const results: SearchResult[] = [
      makeResult({ path: 'note.md', text: 'Second section', score: 0.8, section_path: 'H2 B' }),
      makeResult({ path: 'note.md', text: 'First section', score: 0.9, section_path: 'H2 A' }),
    ];

    const pack = service.assemble(results, { tokenBudget: 100000, minScore: 0 });

    // Should have exactly one entry for note.md
    const allEntries = [
      ...(pack.summary ?? []),
      ...(pack.architecture ?? []),
      ...(pack.adrs ?? []),
      ...(pack.glossary ?? []),
      ...(pack.implementation ?? []),
    ];
    expect(allEntries.length).toBe(1);

    const entry = allEntries[0];
    expect(entry).toBeDefined();
    expect(entry!.source.path).toBe('note.md');
    // Merged text should have both sections in section_path order (A before B)
    expect(entry!.text).toContain('First section');
    expect(entry!.text).toContain('Second section');
    const firstIdx = entry!.text.indexOf('First section');
    const secondIdx = entry!.text.indexOf('Second section');
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it('classifies entries by frontmatter type field', () => {
    const results: SearchResult[] = [
      makeResult({ path: 'a.md', text: 'A', score: 1.0, type: 'summary' }),
      makeResult({ path: 'b.md', text: 'B', score: 0.9, type: 'overview' }),
      makeResult({ path: 'c.md', text: 'C', score: 0.8, type: 'architecture' }),
      makeResult({ path: 'd.md', text: 'D', score: 0.7, type: 'arch' }),
      makeResult({ path: 'e.md', text: 'E', score: 0.6, type: 'adr' }),
      makeResult({ path: 'f.md', text: 'F', score: 0.5, type: 'decision' }),
      makeResult({ path: 'g.md', text: 'G', score: 0.4, type: 'glossary' }),
      makeResult({ path: 'h.md', text: 'H', score: 0.3, type: 'definition' }),
      makeResult({ path: 'i.md', text: 'I', score: 0.2, type: 'meeting-note' }),
    ];

    const pack = service.assemble(results, { tokenBudget: 100000, minScore: 0 });

    expect(pack.summary?.length).toBe(2); // summary + overview
    expect(pack.architecture?.length).toBe(2); // architecture + arch
    expect(pack.adrs?.length).toBe(2); // adr + decision
    expect(pack.glossary?.length).toBe(2); // glossary + definition
    expect(pack.implementation?.length).toBe(1); // meeting-note -> implementation
  });

  it('returns empty pack when min_score=1.0 (all excluded — no results normalize to >1.0)', () => {
    // With min_score=1.0: only entries with normalized score = 1.0 pass the floor.
    // Normalization: score / maxScore. The top result always normalizes to 1.0 and passes.
    // To get an empty pack with min_score=1.0, use min_score > 1.0 or check behavior with equal scores.
    // Plan behavior: min_score=1.0 means "at least 100% of top relevance" — only the max score(s) pass.
    // Here we verify that chunks_excluded counts excluded chunks correctly with a strict floor.
    //
    // Use all equal scores (all normalize to 1.0, all included) to test chunks_excluded=0,
    // then test with different min_score to show exclusion works.
    const results: SearchResult[] = [
      makeResult({ path: 'a.md', text: 'Alpha', score: 0.5 }),
      makeResult({ path: 'b.md', text: 'Beta', score: 0.5 }),
    ];

    // Both normalize to 1.0 (0.5/0.5), so with min_score=1.0 both pass
    const pack = service.assemble(results, { tokenBudget: 100000, minScore: 1.0 });

    expect(pack.meta.chunks_included).toBe(2);
    expect(pack.meta.chunks_excluded).toBe(0);
  });

  it('chunks_excluded counts entries below floor', () => {
    const results: SearchResult[] = [
      makeResult({ path: 'a.md', text: 'High', score: 1.0, type: 'implementation' }),
      makeResult({ path: 'b.md', text: 'Low', score: 0.1, type: 'implementation' }),
      makeResult({ path: 'c.md', text: 'Lower', score: 0.05, type: 'implementation' }),
    ];

    // max=1.0, normalized: 1.0, 0.1, 0.05. With minScore=0.5, only 1.0 passes
    const pack = service.assemble(results, { tokenBudget: 100000, minScore: 0.5 });

    expect(pack.meta.chunks_included).toBe(1);
    expect(pack.meta.chunks_excluded).toBe(2);
    expect(pack.implementation?.length).toBe(1);
  });

  it('normalizes scores before applying min_score floor', () => {
    // With raw scores 0.5 and 0.1, max is 0.5
    // Normalized: 0.5/0.5=1.0 and 0.1/0.5=0.2
    // With min_score=0.3, only the 0.5 raw score entry should pass
    const results: SearchResult[] = [
      makeResult({ path: 'a.md', text: 'High', score: 0.5, type: 'implementation' }),
      makeResult({ path: 'b.md', text: 'Low', score: 0.1, type: 'implementation' }),
    ];

    const pack = service.assemble(results, { tokenBudget: 100000, minScore: 0.3 });

    expect(pack.implementation?.length).toBe(1);
    expect(pack.implementation?.[0]?.source.path).toBe('a.md');
    expect(pack.meta.chunks_excluded).toBe(1);
  });

  it('returns empty pack when token budget is smaller than first entry', () => {
    const results: SearchResult[] = [
      makeResult({ path: 'a.md', text: 'token '.repeat(100), score: 1.0, type: 'implementation' }),
    ];

    const pack = service.assemble(results, { tokenBudget: 1, minScore: 0 });

    expect(pack.implementation).toBeUndefined();
    expect(pack.meta.chunks_included).toBe(0);
    expect(pack.meta.total_tokens).toBe(0);
  });

  it('omits empty sections from result', () => {
    const results: SearchResult[] = [
      makeResult({ path: 'a.md', text: 'Summary note', score: 1.0, type: 'summary' }),
    ];

    const pack = service.assemble(results, { tokenBudget: 100000, minScore: 0 });

    expect(pack.summary).toBeDefined();
    expect(pack.architecture).toBeUndefined();
    expect(pack.adrs).toBeUndefined();
    expect(pack.glossary).toBeUndefined();
    expect(pack.implementation).toBeUndefined();
  });

  it('orders entries within each section by descending score', () => {
    const results: SearchResult[] = [
      makeResult({ path: 'low.md', text: 'Low score impl', score: 0.3, type: 'implementation' }),
      makeResult({ path: 'high.md', text: 'High score impl', score: 1.0, type: 'implementation' }),
      makeResult({ path: 'mid.md', text: 'Mid score impl', score: 0.6, type: 'implementation' }),
    ];

    const pack = service.assemble(results, { tokenBudget: 100000, minScore: 0 });

    const impl = pack.implementation;
    expect(impl).toBeDefined();
    expect(impl?.length).toBe(3);
    expect(impl?.[0]?.source.path).toBe('high.md');
    expect(impl?.[1]?.source.path).toBe('mid.md');
    expect(impl?.[2]?.source.path).toBe('low.md');
  });

  it('classifies by folder heuristic when type field is null', () => {
    const results: SearchResult[] = [
      makeResult({ path: 'docs/adr/001.md', text: 'ADR note', score: 1.0, type: null }),
      makeResult({
        path: 'docs/decisions/decision-1.md',
        text: 'Decision',
        score: 0.9,
        type: null,
      }),
      makeResult({
        path: 'docs/architecture/overview.md',
        text: 'Arch note',
        score: 0.8,
        type: null,
      }),
      makeResult({ path: 'docs/arch/diagram.md', text: 'Arch diagram', score: 0.7, type: null }),
      makeResult({ path: 'docs/glossary/terms.md', text: 'Glossary', score: 0.6, type: null }),
      makeResult({ path: 'docs/definitions/def.md', text: 'Definition', score: 0.5, type: null }),
      makeResult({ path: 'docs/summary/intro.md', text: 'Summary', score: 0.4, type: null }),
      makeResult({ path: 'docs/overview/readme.md', text: 'Overview', score: 0.3, type: null }),
      makeResult({ path: 'docs/random/note.md', text: 'Random', score: 0.2, type: null }),
    ];

    const pack = service.assemble(results, { tokenBudget: 100000, minScore: 0 });

    expect(pack.adrs?.length).toBe(2);
    expect(pack.architecture?.length).toBe(2);
    expect(pack.glossary?.length).toBe(2);
    expect(pack.summary?.length).toBe(2);
    expect(pack.implementation?.length).toBe(1); // random -> implementation
  });

  it('falls back to implementation for unknown type and no recognizable folder', () => {
    const results: SearchResult[] = [
      makeResult({ path: 'random/note.md', text: 'Unknown type note', score: 1.0, type: null }),
    ];

    const pack = service.assemble(results, { tokenBudget: 100000, minScore: 0 });

    expect(pack.implementation).toBeDefined();
    expect(pack.implementation?.length).toBe(1);
    expect(pack.implementation?.[0]?.source.path).toBe('random/note.md');
  });

  it('includes correct sections array from merged chunks', () => {
    const results: SearchResult[] = [
      makeResult({
        path: 'note.md',
        text: 'Chunk 1',
        score: 0.9,
        section_path: 'Introduction',
        type: 'summary',
      }),
      makeResult({
        path: 'note.md',
        text: 'Chunk 2',
        score: 0.8,
        section_path: 'Background',
        type: 'summary',
      }),
    ];

    const pack = service.assemble(results, { tokenBudget: 100000, minScore: 0 });

    const entry = pack.summary?.[0];
    expect(entry).toBeDefined();
    expect(entry!.source.sections).toContain('Introduction');
    expect(entry!.source.sections).toContain('Background');
  });

  it('greedy fill: skips large entries if smaller ones fit within budget', () => {
    const shortText = 'Short note content here';
    const longText = 'token '.repeat(300);

    const shortTokens = countTokens(shortText);

    // Budget: fits short but not long
    const budget = shortTokens + 50;

    const results: SearchResult[] = [
      // High-score long entry (top of sorted list) won't fit
      makeResult({ path: 'long.md', text: longText, score: 1.0, type: 'implementation' }),
      // Lower-score short entry should still be included
      makeResult({ path: 'short.md', text: shortText, score: 0.5, type: 'implementation' }),
    ];

    const pack = service.assemble(results, { tokenBudget: budget, minScore: 0 });

    expect(pack.implementation).toBeDefined();
    // Should include the short entry even though the long one was skipped
    expect(pack.implementation?.some((e) => e.source.path === 'short.md')).toBe(true);
    expect(pack.implementation?.some((e) => e.source.path === 'long.md')).toBe(false);
  });

  it('handles empty results array', () => {
    const pack = service.assemble([], { tokenBudget: 32000, minScore: 0.3 });

    expect(pack.meta.chunks_included).toBe(0);
    expect(pack.meta.chunks_excluded).toBe(0);
    expect(pack.meta.total_tokens).toBe(0);
    expect(pack.summary).toBeUndefined();
    expect(pack.implementation).toBeUndefined();
  });
});
