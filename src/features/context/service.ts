import { getEncoding } from 'js-tiktoken';
import type { SearchResult } from '../search/schemas.js';

// Module-level encoder init (expensive — shared across calls)
const enc = getEncoding('cl100k_base');

export type SectionName = 'summary' | 'architecture' | 'adrs' | 'glossary' | 'implementation';

export interface AssembleOptions {
  tokenBudget: number;
  /**
   * Score cut-off applied to results exactly as the search service scored them — no second
   * normalisation happens here. `/context` feeds hybrid results, which `SearchService`
   * already rescales against the batch's own top hit (rank 1 === 1.0), so for that path
   * this is a fraction-of-top tail trim, NOT an absolute relevance floor: the top hit
   * passes for any value in [0, 1] even when it is a poor match in absolute terms.
   * If a caller ever feeds `semantic` results (absolute clamped cosine similarities,
   * never rescaled), the same comparison becomes an absolute cosine floor — which is the
   * correct reading for those scores precisely because nothing is renormalised here.
   */
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
    // 1. Score cut-off, on scores exactly as received. Rescaling happens ONCE, in
    // SearchService.rescaleToTop (hybrid/lexical only) — renormalising again here would
    // dress up an arbitrarily poor best hit as a perfect 1.0 and turn `minScore` into a
    // double-transformed value nobody can reason about. See AssembleOptions.minScore.
    const aboveFloor = results.filter((r) => r.score >= opts.minScore);
    const chunksExcluded = results.length - aboveFloor.length;

    // 2. Group by path
    const groups = new Map<string, { results: SearchResult[]; maxScore: number }>();
    for (const r of aboveFloor) {
      const existing = groups.get(r.path);
      if (existing) {
        existing.results.push(r);
        existing.maxScore = Math.max(existing.maxScore, r.score);
      } else {
        groups.set(r.path, { results: [r], maxScore: r.score });
      }
    }

    // 3. Sort chunks within each group by section_path (lexicographic = document order)
    for (const group of groups.values()) {
      group.results.sort((a, b) => a.section_path.localeCompare(b.section_path));
    }

    // 4. Merge groups into candidate entries
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

    // 5. Sort candidates by maxScore descending
    candidates.sort((a, b) => b.maxScore - a.maxScore);

    // 6. Greedy budget fill (do NOT break on skip — a smaller entry later may fit)
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

    // 7. Group entries by section, order within section by score descending
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

    // 8. Build response — only include sections with entries
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
