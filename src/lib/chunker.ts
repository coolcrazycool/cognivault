import { createHash } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import type { Code, Heading, Node, Paragraph, Parent, Root, Table, TableRow } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

// Initialize encoder once at module level (expensive initialization)
const enc = getEncoding('cl100k_base');

export const MIN_CHUNK_TOKENS = 100;
export const MAX_CHUNK_TOKENS = 500;

/**
 * Token budget for a chunk that is nothing but table rows.
 *
 * Deliberately larger than {@link MAX_CHUNK_TOKENS}: a table row is only meaningful
 * next to its column headers, so cutting a table at the prose budget produces chunks
 * that cost more (repeated header + context prefix in every one) than they save. The
 * budget matches the Confluence converter's table threshold so the two never cut the
 * same table along two different seams.
 */
export const TABLE_MAX_TOKENS = 1200;

/** Upper bound on rows per table chunk — keeps a wide-but-thin table readable. */
const TABLE_MAX_ROWS_PER_CHUNK = 40;

/** Longest caption kept in a table chunk's context prefix, in characters. */
const TABLE_CAPTION_MAX_CHARS = 160;

/**
 * What a chunk's text actually is, surfaced in the Qdrant payload as `content_kind`.
 *
 * `table_rows` marks a chunk that is a header row plus data rows, which the retrieval
 * side may want to treat differently (it is tabular, not prose).
 */
export type ContentKind = 'text' | 'table_rows';

export interface MarkdownChunk {
  text: string;
  sectionPath: string;
  chunkIndex: number;
  /** Identifies the parent section this chunk was cut from (see {@link parentId}). */
  parentId: string;
  /** Shape of this chunk's text; the pipeline stores it as `content_kind`. */
  contentKind: ContentKind;
}

/**
 * A whole section as it existed before it was split into chunks — the "parent document"
 * that small-to-big retrieval expands a matched chunk into.
 */
export interface MarkdownSection {
  parentId: string;
  sectionPath: string;
  /** Full section text, formatted like a chunk: `sectionPath\n\n<body>`. */
  text: string;
}

export interface MarkdownChunkResult {
  chunks: MarkdownChunk[];
  sections: MarkdownSection[];
}

export interface ChunkOptions {
  title: string;
  /**
   * Vault-relative path of the note. Optional and deliberately NOT part of `parentId`:
   * keeping the file location out of the hash is what lets a rename stay a cheap
   * payload/`UPDATE` operation instead of a re-embed. Accepted only so call sites can
   * pass the note's full identity in one object.
   */
  path?: string;
}

const processor = unified().use(remarkParse).use(remarkGfm);

// Normalize Obsidian-specific syntax in text
export function normalizeObsidianSyntax(text: string): string {
  // Strip ![[embed]] embeds first (before wikilink normalization)
  text = text.replace(/!\[\[[^\]]*\]\]/g, '');
  // [[Page|Alias]] → "Alias"
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  // [[Page Name]] → "Page Name"
  text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
  return text;
}

function countTokens(text: string): number {
  return enc.encode(text).length;
}

function isHeading(node: Node): node is Heading {
  return node.type === 'heading';
}

function isCode(node: Node): node is Code {
  return node.type === 'code';
}

function isTable(node: Node): node is Table {
  return node.type === 'table';
}

function isParagraph(node: Node): node is Paragraph {
  return node.type === 'paragraph';
}

function nodeToText(node: Node): string {
  if (isCode(node)) {
    return node.value;
  }
  if (isTable(node)) {
    // Without this the generic child-concatenation below would glue every cell of
    // every row into one unreadable run ("ABCr1ar1br1c…") — the column structure is
    // the whole point of a table.
    const rendered = renderTable(node);
    return [rendered.header, rendered.delimiter, ...rendered.rows].join('\n');
  }
  if ('value' in node && typeof (node as { value: string }).value === 'string') {
    return (node as { value: string }).value;
  }
  if ('children' in node && Array.isArray((node as Parent).children)) {
    return (node as Parent).children.map(nodeToText).join('');
  }
  return '';
}

function sectionNodesToText(nodes: Node[]): string {
  return nodes
    .map((node) => nodeToText(node))
    .filter((t) => t.length > 0)
    .join('\n\n');
}

// ── GFM tables ──

interface RenderedTable {
  /** `| A | B |` — repeated at the top of every chunk cut from this table. */
  header: string;
  /** `| --- | ---: |` — kept so each chunk is still parsable as a table. */
  delimiter: string;
  /** One markdown line per data row; a row is never split across chunks. */
  rows: string[];
}

function alignmentMarker(align: string | null | undefined): string {
  if (align === 'left') return ':---';
  if (align === 'right') return '---:';
  if (align === 'center') return ':---:';
  return '---';
}

function cellToText(cell: Node | undefined): string {
  if (cell === undefined) return '';
  // Pipes inside a cell would fake a column break, and a newline would fake a row break.
  return normalizeObsidianSyntax(nodeToText(cell))
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function rowToText(row: TableRow, columns: number): string {
  const cells: string[] = [];
  for (let i = 0; i < columns; i++) {
    cells.push(cellToText(row.children[i]));
  }
  return `| ${cells.join(' | ')} |`;
}

/** Serialize an mdast table back to GFM: header row, delimiter row, data rows. */
function renderTable(table: Table): RenderedTable {
  const rows = table.children.filter((child): child is TableRow => child.type === 'tableRow');
  const columns = Math.max(1, ...rows.map((row) => row.children.length));
  const [headerRow, ...dataRows] = rows;

  const align = table.align ?? [];
  const delimiter = `| ${Array.from({ length: columns }, (_, i) => alignmentMarker(align[i])).join(' | ')} |`;

  return {
    header: headerRow === undefined ? '' : rowToText(headerRow, columns),
    delimiter,
    rows: dataRows.map((row) => rowToText(row, columns)),
  };
}

/**
 * `{sectionPath} > Таблица: {caption}` — the context every table chunk carries so a
 * group of rows still says which document, which section and which table it belongs to.
 * With no caption the prefix simply ends at `Таблица`, never at a dangling separator.
 */
function tableContextPrefix(header: string, caption: string | null): string {
  return caption === null ? `${header} > Таблица` : `${header} > Таблица: ${caption}`;
}

interface TableCaption {
  text: string;
  /** True when the prefix only shows a prefix of the paragraph, not all of it. */
  truncated: boolean;
}

/** The paragraph directly above a table is its de-facto caption. */
function tableCaption(previous: Node | undefined): TableCaption | null {
  if (previous === undefined || !isParagraph(previous)) return null;
  const text = normalizeObsidianSyntax(nodeToText(previous)).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  if (text.length <= TABLE_CAPTION_MAX_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, TABLE_CAPTION_MAX_CHARS).trimEnd()}…`, truncated: true };
}

/** Greedily pack whole rows up to the token budget and the row cap. */
function packRows(rows: string[], overheadTokens: number, maxRows: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentTokens = overheadTokens;

  for (const row of rows) {
    const rowTokens = countTokens(`${row}\n`);
    if (
      current.length > 0 &&
      (current.length >= maxRows || currentTokens + rowTokens > TABLE_MAX_TOKENS)
    ) {
      groups.push(current);
      current = [];
      currentTokens = overheadTokens;
    }
    // A row that does not fit on its own is still emitted whole: splitting it would
    // detach values from their column headers, which is the failure this all prevents.
    current.push(row);
    currentTokens += rowTokens;
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Cut a table into chunks of whole rows, each one self-describing.
 *
 * A table that fits the budget is emitted as a single chunk. A larger one is cut into
 * row groups; every group repeats the context prefix, the header row and the delimiter,
 * so a retrieved group of rows can still be read as a table.
 */
function chunkTable(table: Table, header: string, caption: TableCaption | null): string[] {
  const { header: headerRow, delimiter, rows } = renderTable(table);
  const prefix = tableContextPrefix(header, caption === null ? null : caption.text);
  const preamble = `${prefix}\n\n${headerRow}\n${delimiter}`;

  if (rows.length === 0) return [preamble];

  const whole = `${preamble}\n${rows.join('\n')}`;
  if (countTokens(whole) <= TABLE_MAX_TOKENS) return [whole];

  const overhead = countTokens(`${preamble}\n`);
  const greedy = packRows(rows, overhead, TABLE_MAX_ROWS_PER_CHUNK);
  // Second pass with an even row target: greedy packing alone can leave a one-row
  // orphan at the end, which embeds badly.
  const balanced =
    greedy.length > 1
      ? packRows(
          rows,
          overhead,
          Math.min(TABLE_MAX_ROWS_PER_CHUNK, Math.ceil(rows.length / greedy.length)),
        )
      : greedy;

  return balanced.map((group) => `${preamble}\n${group.join('\n')}`);
}

// Build heading path from heading stack (H2+ depths only, H1 is transparent)
function buildSectionPath(title: string, headingStack: string[]): string {
  if (headingStack.length === 0) {
    return title;
  }
  return [title, ...headingStack].join(' > ');
}

interface Section {
  depth: number; // Heading depth that introduced this section (0 = before any heading)
  headingStack: string[]; // H2+ heading texts in order
  nodes: Node[];
}

// Split oversized text by lines to stay within MAX_CHUNK_TOKENS
function splitTextByLines(text: string, headerText: string, maxTokens: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentTokens = countTokens(headerText);

  for (const line of lines) {
    const lineTokens = countTokens(line);
    if (currentLines.length > 0 && currentTokens + lineTokens > maxTokens) {
      chunks.push(`${headerText}\n\n${normalizeObsidianSyntax(currentLines.join('\n'))}`);
      currentLines = [];
      currentTokens = countTokens(headerText);
    }
    currentLines.push(line);
    currentTokens += lineTokens;
  }

  if (currentLines.length > 0) {
    chunks.push(`${headerText}\n\n${normalizeObsidianSyntax(currentLines.join('\n'))}`);
  }

  return chunks;
}

interface ChunkPiece {
  text: string;
  contentKind: ContentKind;
}

/**
 * Merge a sub-{@link MIN_CHUNK_TOKENS} tail into the piece before it.
 *
 * A short trailing *section* is already folded into its predecessor before any
 * splitting happens, but the split itself can still strand the final paragraph in a
 * chunk far too small to retrieve on its own. Table chunks are never merged into:
 * their prefix + header + rows contract is what makes them readable.
 */
function mergeUndersizedTail(pieces: ChunkPiece[], headerText: string): ChunkPiece[] {
  const merged = [...pieces];
  const prefix = `${headerText}\n\n`;
  const bodyOf = (piece: ChunkPiece): string =>
    piece.text.startsWith(prefix) ? piece.text.slice(prefix.length) : piece.text;

  while (merged.length > 1) {
    const last = merged[merged.length - 1] as ChunkPiece;
    const previous = merged[merged.length - 2] as ChunkPiece;
    if (last.contentKind !== 'text' || previous.contentKind !== 'text') break;
    if (countTokens(bodyOf(last)) >= MIN_CHUNK_TOKENS) break;

    merged.splice(merged.length - 2, 2, {
      text: `${previous.text}\n\n${bodyOf(last)}`,
      contentKind: 'text',
    });
  }

  return merged;
}

/** Separators tried in order: paragraphs first, then lines, then words. */
const TEXT_SEPARATORS: ReadonlyArray<{ pattern: RegExp; joiner: string }> = [
  { pattern: /\n{2,}/, joiner: '\n\n' },
  { pattern: /\n/, joiner: '\n' },
  { pattern: / +/, joiner: ' ' },
];

/** Last resort for text with no separator left to cut on (a single huge token run). */
function splitByTokenWindow(text: string, maxTokens: number): string[] {
  const tokens = enc.encode(text);
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i += maxTokens) {
    parts.push(enc.decode(tokens.slice(i, i + maxTokens)));
  }
  return parts;
}

function splitAtSeparator(text: string, maxTokens: number, level: number): string[] {
  const separator = TEXT_SEPARATORS[level];
  if (separator === undefined) return splitByTokenWindow(text, maxTokens);

  const units = text.split(separator.pattern).filter((unit) => unit.trim().length > 0);
  if (units.length <= 1) return splitAtSeparator(text, maxTokens, level + 1);

  const parts: string[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  const joinerTokens = countTokens(separator.joiner);

  const flush = (): void => {
    if (buffer.length === 0) return;
    parts.push(buffer.join(separator.joiner));
    buffer = [];
    bufferTokens = 0;
  };

  for (const unit of units) {
    const unitTokens = countTokens(unit);
    if (unitTokens > maxTokens) {
      flush();
      parts.push(...splitAtSeparator(unit, maxTokens, level + 1));
      continue;
    }
    if (buffer.length > 0 && bufferTokens + joinerTokens + unitTokens > maxTokens) {
      flush();
    }
    bufferTokens += (buffer.length > 0 ? joinerTokens : 0) + unitTokens;
    buffer.push(unit);
  }

  flush();
  return parts;
}

/**
 * Cut a plain string down to a token budget, preferring the largest natural boundary:
 * paragraph, then line, then word. Used by the canvas and drawing chunkers, whose
 * "documents" are free text with no markdown structure to lean on.
 *
 * Every returned part is guaranteed to fit `maxTokens`.
 */
export function splitTextByTokenBudget(
  text: string,
  maxTokens: number = MAX_CHUNK_TOKENS,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (countTokens(trimmed) <= maxTokens) return [trimmed];

  // Packing works off per-unit token counts, which can differ by a token or two from
  // the count of the joined string, so the budget is re-checked on the real output.
  return splitAtSeparator(trimmed, maxTokens, 0).flatMap((part) =>
    countTokens(part) <= maxTokens ? [part] : splitByTokenWindow(part, maxTokens),
  );
}

// Split a list of nodes at paragraph boundaries to stay within MAX_CHUNK_TOKENS
function splitAtParagraphBoundaries(nodes: Node[], headerText: string): ChunkPiece[] {
  const pieces: ChunkPiece[] = [];
  let currentNodes: Node[] = [];
  let currentTokens = countTokens(headerText);

  const flush = (): void => {
    if (currentNodes.length === 0) return;
    pieces.push({
      text: `${headerText}\n\n${normalizeObsidianSyntax(sectionNodesToText(currentNodes))}`,
      contentKind: 'text',
    });
    currentNodes = [];
    currentTokens = countTokens(headerText);
  };

  nodes.forEach((node, index) => {
    const nodeText = nodeToText(node);
    const nodeTokens = countTokens(nodeText);

    // A table too large to share a chunk with prose is cut on its own terms: whole
    // rows, header repeated. Line-splitting it would hand the model values with no
    // column names — the failure mode this replaces.
    if (isTable(node) && nodeTokens > MAX_CHUNK_TOKENS) {
      const caption = tableCaption(nodes[index - 1]);
      // The caption paragraph is reproduced in full in every one of this table's
      // chunks, so emitting it again on its own would only add a stub chunk.
      const captionIsPending =
        caption !== null &&
        !caption.truncated &&
        currentNodes.length === 1 &&
        currentNodes[0] === nodes[index - 1];
      if (captionIsPending) {
        currentNodes = [];
        currentTokens = countTokens(headerText);
      }
      flush();
      for (const text of chunkTable(node, headerText, caption)) {
        pieces.push({ text, contentKind: 'table_rows' });
      }
      return;
    }

    // Oversized code block — nothing better than line boundaries to cut on.
    if (isCode(node) && nodeTokens > MAX_CHUNK_TOKENS) {
      flush();
      for (const text of splitTextByLines(nodeText, headerText, MAX_CHUNK_TOKENS)) {
        pieces.push({ text, contentKind: 'text' });
      }
      return;
    }

    if (currentNodes.length > 0 && currentTokens + nodeTokens > MAX_CHUNK_TOKENS) {
      flush();
    }
    currentNodes.push(node);
    currentTokens += nodeTokens;
  });

  flush();

  return mergeUndersizedTail(pieces, headerText);
}

/**
 * Stable identity of a parent section.
 *
 * The ordinal is the position of the section among the parents this file actually
 * produced (post-merge), NOT the position of its heading in the source. `sectionPath`
 * alone cannot identify a parent: H1 headings are transparent, so every top-level
 * section of a note shares the bare note title as its path and two unrelated H1
 * sections would collapse into one parent. The file path is intentionally excluded —
 * see {@link ChunkOptions.path}.
 */
function sectionParentId(ordinal: number, sectionPath: string): string {
  return createHash('sha1').update(`${ordinal}\0${sectionPath}`).digest('hex');
}

function sectionsToChunks(
  sections: Section[],
  title: string,
): {
  chunks: Array<{
    sectionPath: string;
    text: string;
    parentId: string;
    contentKind: ContentKind;
  }>;
  sections: MarkdownSection[];
} {
  const result: Array<{
    sectionPath: string;
    text: string;
    parentId: string;
    contentKind: ContentKind;
  }> = [];
  const parents: MarkdownSection[] = [];
  // Incremented only when a parent is actually emitted, so the ordinal tracks the
  // merged sections that exist rather than the headings that were parsed.
  let ordinal = 0;

  // Process sections: merge short ones into adjacent content, split long ones
  // Strategy: maintain a pending accumulator per "logical parent"
  // A short section merges its content into the previous section's chunk
  // (appending to its node list) rather than forming its own chunk.

  type PendingSection = {
    depth: number;
    sectionPath: string;
    nodes: Node[];
  };

  const pending: PendingSection[] = [];

  const flushSection = (ps: PendingSection): void => {
    if (ps.nodes.length === 0) return;
    const header = ps.sectionPath;
    const text = normalizeObsidianSyntax(sectionNodesToText(ps.nodes));
    const tokenCount = countTokens(text);

    // This is the only point where the section exists as one whole string, so the
    // parent record is captured here, before any token-budget splitting.
    const parentId = sectionParentId(ordinal, ps.sectionPath);
    ordinal += 1;
    parents.push({
      parentId,
      sectionPath: ps.sectionPath,
      text: `${header}\n\n${text}`,
    });

    if (tokenCount > MAX_CHUNK_TOKENS) {
      // Every piece — prose or table rows — keeps the section's parentId: a table is
      // a region of its section, so all of its row groups expand to the same parent.
      for (const piece of splitAtParagraphBoundaries(ps.nodes, header)) {
        result.push({
          sectionPath: ps.sectionPath,
          text: piece.text,
          parentId,
          contentKind: piece.contentKind,
        });
      }
    } else {
      result.push({
        sectionPath: ps.sectionPath,
        text: `${header}\n\n${text}`,
        parentId,
        contentKind: 'text',
      });
    }
  };

  for (const section of sections) {
    const sectionPath = buildSectionPath(title, section.headingStack);
    const contentText = normalizeObsidianSyntax(sectionNodesToText(section.nodes));
    const tokenCount = countTokens(contentText);

    if (tokenCount < MIN_CHUNK_TOKENS) {
      // Short section: merge into the last pending section that is at a higher or equal level
      // OR start a new pending with this section's path if no suitable pending exists
      if (pending.length > 0) {
        // Merge into the last pending section
        const last = pending[pending.length - 1] as PendingSection;
        last.nodes = [...last.nodes, ...section.nodes];
      } else {
        // No pending yet — start one with this section's path
        pending.push({
          depth: section.depth,
          sectionPath,
          nodes: [...section.nodes],
        });
      }
    } else {
      // Section has enough tokens to stand on its own
      // First flush all pending sections
      for (const ps of pending) {
        flushSection(ps);
      }
      pending.length = 0;

      // Add this section as new pending (will be flushed when next section arrives or at end)
      pending.push({
        depth: section.depth,
        sectionPath,
        nodes: [...section.nodes],
      });
    }
  }

  // Flush remaining pending
  for (const ps of pending) {
    flushSection(ps);
  }

  return { chunks: result, sections: parents };
}

/**
 * Chunk a markdown body and also return the parent sections the chunks came from.
 * `chunkMarkdown` is the thin, chunks-only view of the same work.
 */
export function chunkMarkdownWithSections(body: string, opts: ChunkOptions): MarkdownChunkResult {
  const { title } = opts;

  // Return empty result for empty/whitespace body
  if (!body || body.trim().length === 0) {
    return { chunks: [], sections: [] };
  }

  // Parse markdown into AST
  const ast = processor.parse(body) as Root;

  // Walk root.children grouping nodes by heading boundaries
  // H1 headings are TRANSPARENT — they create section boundaries but are NOT added to section path
  // H2+ headings are added to the heading stack
  const sections: Section[] = [];
  let currentSection: Section = { depth: 0, headingStack: [], nodes: [] };

  // Track current heading stack for H2+: array indexed by depth
  // headingByDepth[2] = H2 heading text, headingByDepth[3] = H3 text, etc.
  const headingByDepth = new Map<number, string>();

  for (const node of ast.children) {
    if (isHeading(node)) {
      // Save current section if it has content
      if (currentSection.nodes.length > 0) {
        sections.push({ ...currentSection, nodes: [...currentSection.nodes] });
      }

      if (node.depth === 1) {
        // H1 is transparent — clears all heading state, starts fresh section at root level
        headingByDepth.clear();
        currentSection = { depth: 1, headingStack: [], nodes: [] };
      } else {
        // H2+: clear all depths >= current depth
        for (const depth of headingByDepth.keys()) {
          if (depth >= node.depth) {
            headingByDepth.delete(depth);
          }
        }
        headingByDepth.set(node.depth, nodeToText(node));

        // Build heading stack from depth map sorted by depth
        const sortedDepths = [...headingByDepth.keys()].sort((a, b) => a - b);
        const newStack = sortedDepths.map((d) => headingByDepth.get(d) as string);

        currentSection = { depth: node.depth, headingStack: newStack, nodes: [] };
      }
    } else {
      currentSection.nodes.push(node);
    }
  }

  // Push last section if it has content
  if (currentSection.nodes.length > 0) {
    sections.push(currentSection);
  }

  // If no sections produced any content, return empty
  if (sections.length === 0) {
    return { chunks: [], sections: [] };
  }

  // Convert sections to text chunks (with merge/split logic)
  const converted = sectionsToChunks(sections, title);

  // Assign sequential chunkIndex
  return {
    chunks: converted.chunks.map((item, idx) => ({
      text: item.text,
      sectionPath: item.sectionPath,
      chunkIndex: idx,
      parentId: item.parentId,
      contentKind: item.contentKind,
    })),
    sections: converted.sections,
  };
}

export function chunkMarkdown(body: string, opts: ChunkOptions): MarkdownChunk[] {
  return chunkMarkdownWithSections(body, opts).chunks;
}
