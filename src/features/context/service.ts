import { getEncoding } from 'js-tiktoken';
import type { SearchResult } from '../search/schemas.js';

// Module-level encoder init (expensive — shared across calls)
const enc = getEncoding('cl100k_base');

export type SectionName = 'summary' | 'architecture' | 'adrs' | 'glossary' | 'implementation';

export interface AssembleOptions {
  tokenBudget: number;
  minScore: number;
}

interface ContextSource {
  path: string;
  title: string;
  sections: string[];
  score: number;
}

interface ContextEntry {
  text: string;
  source: ContextSource;
  section: SectionName;
}

interface ContextMeta {
  total_tokens: number;
  token_budget: number;
  chunks_included: number;
  chunks_excluded: number;
  query_ms: number;
}

interface ContextPack {
  summary?: ContextEntry[];
  architecture?: ContextEntry[];
  adrs?: ContextEntry[];
  glossary?: ContextEntry[];
  implementation?: ContextEntry[];
  meta: ContextMeta;
}

// Type field -> section name mapping
const TYPE_TO_SECTION: Record<string, SectionName> = {
  summary: 'summary',
  overview: 'summary',
  architecture: 'architecture',
  arch: 'architecture',
  adr: 'adrs',
  decision: 'adrs',
  glossary: 'glossary',
  definition: 'glossary',
};

// Folder path fragment -> section name (checked case-insensitively)
const FOLDER_PATTERNS: Array<[string, SectionName]> = [
  ['/adr/', 'adrs'],
  ['/decisions/', 'adrs'],
  ['/architecture/', 'architecture'],
  ['/arch/', 'architecture'],
  ['/glossary/', 'glossary'],
  ['/definitions/', 'glossary'],
  ['/summary/', 'summary'],
  ['/overview/', 'summary'],
];

export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return enc.encode(text).length;
}

function classifyEntry(type: string | null, path: string): SectionName {
  // 1. Type field first
  if (type !== null) {
    const mapped = TYPE_TO_SECTION[type.toLowerCase()];
    if (mapped !== undefined) return mapped;
  }

  // 2. Folder heuristic (case-insensitive)
  const lowerPath = path.toLowerCase();
  // Wrap path with / prefix and / suffix for segment matching
  const normalizedPath = `/${lowerPath.replace(/^\//, '')}/`;

  for (const [fragment, section] of FOLDER_PATTERNS) {
    if (normalizedPath.includes(fragment)) {
      return section;
    }
  }

  // 3. Default fallback
  return 'implementation';
}

export class ContextService {
  assemble(results: SearchResult[], opts: AssembleOptions): ContextPack {
    // 1. Score normalization: divide by max to get [0, 1] relative scores
    const maxScore = results.reduce((max, r) => Math.max(max, r.score), 0);

    type NormalizedResult = SearchResult & { normalizedScore: number };

    const normalized: NormalizedResult[] = results.map((r) => ({
      ...r,
      normalizedScore: maxScore > 0 ? r.score / maxScore : 0,
    }));

    // 2. Relevance floor filter
    const aboveFloor = normalized.filter((r) => r.normalizedScore >= opts.minScore);
    const chunksExcluded = results.length - aboveFloor.length;

    // 3. Group by path
    const groups = new Map<string, { results: NormalizedResult[]; maxScore: number }>();
    for (const r of aboveFloor) {
      const existing = groups.get(r.path);
      if (existing) {
        existing.results.push(r);
        existing.maxScore = Math.max(existing.maxScore, r.normalizedScore);
      } else {
        groups.set(r.path, { results: [r], maxScore: r.normalizedScore });
      }
    }

    // 4. Sort chunks within each group by section_path (lexicographic = document order)
    for (const group of groups.values()) {
      group.results.sort((a, b) => a.section_path.localeCompare(b.section_path));
    }

    // 5. Merge groups into candidate entries
    interface CandidateEntry {
      mergedText: string;
      tokenCount: number;
      source: ContextSource;
      section: SectionName;
      maxScore: number;
    }

    const candidates: CandidateEntry[] = [];
    for (const [path, group] of groups) {
      const first = group.results[0];
      if (first === undefined) continue;

      const mergedText = group.results.map((r) => r.text).join('\n\n');
      const tokenCount = countTokens(mergedText);
      const uniqueSections = [...new Set(group.results.map((r) => r.section_path))];

      // Use type from first chunk (all chunks from same note should have same type)
      const section = classifyEntry(first.type, path);

      candidates.push({
        mergedText,
        tokenCount,
        source: {
          path,
          title: first.title,
          sections: uniqueSections,
          score: group.maxScore,
        },
        section,
        maxScore: group.maxScore,
      });
    }

    // 6. Sort candidates by maxScore descending
    candidates.sort((a, b) => b.maxScore - a.maxScore);

    // 7. Greedy budget fill (do NOT break on skip — a smaller entry later may fit)
    let totalTokens = 0;
    let chunksIncluded = 0;
    const includedEntries: ContextEntry[] = [];

    for (const candidate of candidates) {
      if (totalTokens + candidate.tokenCount <= opts.tokenBudget) {
        totalTokens += candidate.tokenCount;
        chunksIncluded++;
        includedEntries.push({
          text: candidate.mergedText,
          source: candidate.source,
          section: candidate.section,
        });
      }
    }

    // 8. Group entries by section, order within section by score descending
    const sectionMap = new Map<SectionName, ContextEntry[]>();
    for (const entry of includedEntries) {
      const section = entry.section;
      const existing = sectionMap.get(section);
      if (existing) {
        existing.push(entry);
      } else {
        sectionMap.set(section, [entry]);
      }
    }

    // Sort within each section by score descending
    for (const entries of sectionMap.values()) {
      entries.sort((a, b) => b.source.score - a.source.score);
    }

    // 9. Build response — only include sections with entries
    const pack: ContextPack = {
      meta: {
        total_tokens: totalTokens,
        token_budget: opts.tokenBudget,
        chunks_included: chunksIncluded,
        chunks_excluded: chunksExcluded,
        query_ms: 0, // Set by route handler
      },
    };

    const summaryEntries = sectionMap.get('summary');
    if (summaryEntries !== undefined && summaryEntries.length > 0) {
      pack.summary = summaryEntries;
    }

    const architectureEntries = sectionMap.get('architecture');
    if (architectureEntries !== undefined && architectureEntries.length > 0) {
      pack.architecture = architectureEntries;
    }

    const adrsEntries = sectionMap.get('adrs');
    if (adrsEntries !== undefined && adrsEntries.length > 0) {
      pack.adrs = adrsEntries;
    }

    const glossaryEntries = sectionMap.get('glossary');
    if (glossaryEntries !== undefined && glossaryEntries.length > 0) {
      pack.glossary = glossaryEntries;
    }

    const implementationEntries = sectionMap.get('implementation');
    if (implementationEntries !== undefined && implementationEntries.length > 0) {
      pack.implementation = implementationEntries;
    }

    return pack;
  }
}
