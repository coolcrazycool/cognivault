/**
 * Synthesises the document annotation that `INDEX_DOC_SUMMARY=true` puts in front of
 * every chunk, for corpora measured OFFLINE where GigaChat cannot be called.
 *
 * The feature is on by default in production and has never been measured: the offline
 * corpus carries no annotations at all, so every dense number measured so far describes
 * the `INDEX_DOC_SUMMARY=false` state. This script closes that gap by producing a
 * plausible stand-in per document, so a variant sweep can prepend it exactly the way
 * `src/plugins/pipeline.ts` does.
 *
 * What is REAL here and what is modelled:
 *
 * - the INPUT the annotator sees is the real one: `chunks.map(c => c.text).join('\n\n')`
 *   cut to `DOC_SUMMARY_MAX_CHARS` (4000), the same expression `resolveDocSummary` builds;
 * - the CAP is the real one: `capDocSummary` from `src/lib/chunker.ts` is imported, not
 *   reimplemented, so the 80-token ceiling and the word-boundary cut are production's;
 * - the TEXT of the annotation is modelled — GigaChat is unreachable offline. Three
 *   flavours bracket the answer instead of pretending one is the truth:
 *     `realistic` — title + the document's own opening prose + its first headings, i.e.
 *                   what a model answering «о чём документ» actually returns for a
 *                   structured Confluence page;
 *     `topics`    — title + the document's headings only: the structural annotation a
 *                   model returns for a page that is mostly tables and has no lead prose;
 *     `generic`   — ONE boilerplate string shared by every document, carrying zero
 *                   document-specific signal: the floor, a model that says nothing.
 *
 * The bracket is the point. An annotation invented to be maximally discriminative would
 * flatter the feature; pure boilerplate alone would condemn it. Both are measured.
 *
 * Usage:
 *   npx tsx tools/rag_audit/doc_annotations.ts <chunks.jsonl> <annotations.json>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { capDocSummary, countTokens, DOC_SUMMARY_PREFIX } from '../../src/lib/chunker.js';

/** Same slice `resolveDocSummary` feeds the prompt. */
const DOC_SUMMARY_MAX_CHARS = 4_000;

/** Flavours a document annotation can have; see the module comment. */
export type Flavour = 'realistic' | 'topics' | 'generic';

interface ChunkRow {
  path: string;
  title: string;
  chunk_index: number;
  section_path: string;
  text: string;
}

/**
 * The floor case: an annotator that produces the same sentence for every document.
 * Deliberately plausible Russian corp-speak rather than lorem ipsum — a real model that
 * is being lazy writes exactly this, and it is what the feature costs when it gives back
 * nothing.
 */
const GENERIC_ANNOTATION =
  'Документ описывает процессы, требования и порядок работы в рамках информационной ' +
  'системы. Приводятся основные положения, участники и результаты.';

/** A markdown table row / separator — never prose. */
function isTableLine(line: string): boolean {
  return line.startsWith('|');
}

/** A line that is only a URL or a bare link reference. */
function isLinkLine(line: string): boolean {
  return /^!?\[?[^\]]*\]?\(?https?:\/\/\S+\)?$/.test(line) || /^https?:\/\/\S+$/.test(line);
}

/**
 * Splits the annotator's input into (prose sentences, headings).
 *
 * Breadcrumbs are dropped: they repeat the heading path that the chunk already carries,
 * and a stand-in built out of them would measure the breadcrumb twice.
 */
function readDocument(
  body: string,
  title: string,
  breadcrumbs: ReadonlySet<string>,
): { prose: string[]; headings: string[] } {
  const prose: string[] = [];
  const headings: string[] = [];

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (breadcrumbs.has(line)) continue;
    if (isTableLine(line)) continue;
    if (isLinkLine(line)) continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const text = (heading[1] ?? '').trim();
      // The H1 repeats the file title in every Confluence page of this corpus.
      if (text !== '' && text !== title && !headings.includes(text)) headings.push(text);
      continue;
    }

    // List markers are prose once the marker is gone, but a one-word bullet is a label.
    const item = /^[-*]\s+(.*)$/.exec(line);
    const text = item ? (item[1] ?? '').trim() : line;
    if (text.length < 20) continue;
    prose.push(text);
  }

  return { prose, headings };
}

/** First one or two sentences of the document's own prose, as an annotator would quote. */
function leadSentences(prose: string[], maxChars: number): string {
  const flat = prose.join(' ');
  const parts = flat.split(/(?<=[.!?])\s+/);
  let out = '';
  for (const part of parts) {
    const next = out === '' ? part : `${out} ${part}`;
    if (out !== '' && next.length > maxChars) break;
    out = next;
    if (out.length > maxChars * 0.6) break;
  }
  return out.trim();
}

/** Trailing punctuation an annotation should end with exactly once. */
function endSentence(text: string): string {
  const trimmed = text.trim().replace(/[\s,;:]+$/, '');
  if (trimmed === '') return '';
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function synthesiseAnnotations(
  chunks: readonly ChunkRow[],
): Record<string, Record<Flavour, string>> {
  const byPath = new Map<string, ChunkRow[]>();
  for (const chunk of chunks) {
    const list = byPath.get(chunk.path);
    if (list) list.push(chunk);
    else byPath.set(chunk.path, [chunk]);
  }

  const out: Record<string, Record<Flavour, string>> = {};
  for (const [path, rows] of byPath) {
    const ordered = [...rows].sort((a, b) => a.chunk_index - b.chunk_index);
    // Exactly what `resolveDocSummary` puts in the prompt.
    const body = ordered
      .map((c) => c.text)
      .join('\n\n')
      .slice(0, DOC_SUMMARY_MAX_CHARS);
    const title = ordered[0]?.title ?? '';
    const breadcrumbs = new Set(ordered.map((c) => c.section_path).filter((s) => s !== ''));

    const { prose, headings } = readDocument(body, title, breadcrumbs);
    const lead = leadSentences(prose, 180);

    // The chunker strips `#` markers, so a page's section names survive in the chunk
    // text as breadcrumb lines, not as headings. They are part of what the annotator
    // reads, so they are part of what it can name.
    for (const crumb of ordered.map((c) => c.section_path)) {
      const tail = crumb.split(' > ').pop()?.trim() ?? '';
      if (tail !== '' && tail !== title && !headings.includes(tail)) headings.push(tail);
    }

    const topicList = headings.slice(0, 6).join(', ');
    const topicsText = endSentence(
      topicList === ''
        ? `Документ «${title}» описывает предметную область страницы`
        : `Документ «${title}». Рассматриваются: ${topicList}`,
    );

    const realisticParts = [
      lead === ''
        ? `Документ «${title}» описывает предметную область страницы`
        : `Документ «${title}»: ${lead}`,
    ];
    if (topicList !== '')
      realisticParts.push(`Рассматриваются: ${headings.slice(0, 4).join(', ')}`);
    const realisticText = endSentence(realisticParts.join('. '));

    out[path] = {
      realistic: capDocSummary(realisticText),
      topics: capDocSummary(topicsText),
      generic: capDocSummary(GENERIC_ANNOTATION),
    };
  }
  return out;
}

function main(): void {
  const [chunksPath, outPath] = process.argv.slice(2);
  if (!chunksPath || !outPath) {
    console.error('usage: doc_annotations.ts <chunks.jsonl> <annotations.json>');
    process.exit(2);
  }

  const chunks: ChunkRow[] = readFileSync(chunksPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ChunkRow);

  const annotations = synthesiseAnnotations(chunks);

  const stats: Record<string, { tokens: number[]; distinct: Set<string> }> = {};
  for (const flavours of Object.values(annotations)) {
    for (const [flavour, text] of Object.entries(flavours)) {
      stats[flavour] ??= { tokens: [], distinct: new Set() };
      const bucket = stats[flavour];
      bucket.tokens.push(countTokens(`${DOC_SUMMARY_PREFIX}${text}\n\n`));
      bucket.distinct.add(text);
    }
  }

  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        prefix: DOC_SUMMARY_PREFIX,
        source: chunksPath,
        documents: Object.keys(annotations).length,
        stats: Object.fromEntries(
          Object.entries(stats).map(([flavour, bucket]) => {
            const sorted = [...bucket.tokens].sort((a, b) => a - b);
            return [
              flavour,
              {
                distinct_texts: bucket.distinct.size,
                tokens_min: sorted[0] ?? 0,
                tokens_median: sorted[Math.floor(sorted.length / 2)] ?? 0,
                tokens_max: sorted[sorted.length - 1] ?? 0,
                tokens_mean:
                  Math.round((sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)) * 10) / 10,
              },
            ];
          }),
        ),
        annotations,
      },
      null,
      1,
    )}\n`,
    'utf8',
  );

  for (const [flavour, bucket] of Object.entries(stats)) {
    const sorted = [...bucket.tokens].sort((a, b) => a - b);
    console.log(
      `${flavour.padEnd(10)} различных текстов ${String(bucket.distinct.size).padStart(4)}  ` +
        `токенов с префиксом min ${sorted[0]} / med ${sorted[Math.floor(sorted.length / 2)]} / max ${sorted[sorted.length - 1]}`,
    );
  }
  console.log(`аннотации: ${outPath} (${Object.keys(annotations).length} документов)`);
}

main();
