import { getEncoding } from 'js-tiktoken';
import type { Code, Heading, Node, Paragraph, Parent, Root, Table } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

// Initialize encoder once at module level (expensive initialization)
const enc = getEncoding('cl100k_base');

export const MIN_CHUNK_TOKENS = 100;
export const MAX_CHUNK_TOKENS = 500;

export interface MarkdownChunk {
  text: string;
  sectionPath: string;
  chunkIndex: number;
}

export interface ChunkOptions {
  title: string;
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

// Split a list of nodes at paragraph boundaries to stay within MAX_CHUNK_TOKENS
function splitAtParagraphBoundaries(nodes: Node[], headerText: string): string[] {
  const chunks: string[] = [];
  let currentNodes: Node[] = [];
  let currentTokens = countTokens(headerText);

  for (const node of nodes) {
    const nodeText = nodeToText(node);
    const nodeTokens = countTokens(nodeText);

    // Tables and code blocks are atomic — never split them
    if (isTable(node) || isCode(node)) {
      if (currentNodes.length > 0 && currentTokens + nodeTokens > MAX_CHUNK_TOKENS) {
        chunks.push(
          `${headerText}\n\n${normalizeObsidianSyntax(sectionNodesToText(currentNodes))}`,
        );
        currentNodes = [];
        currentTokens = countTokens(headerText);
      }
      currentNodes.push(node);
      currentTokens += nodeTokens;
    } else if (isParagraph(node)) {
      if (currentNodes.length > 0 && currentTokens + nodeTokens > MAX_CHUNK_TOKENS) {
        chunks.push(
          `${headerText}\n\n${normalizeObsidianSyntax(sectionNodesToText(currentNodes))}`,
        );
        currentNodes = [];
        currentTokens = countTokens(headerText);
      }
      currentNodes.push(node);
      currentTokens += nodeTokens;
    } else {
      // Other nodes (lists, blockquotes, etc.)
      if (currentNodes.length > 0 && currentTokens + nodeTokens > MAX_CHUNK_TOKENS) {
        chunks.push(
          `${headerText}\n\n${normalizeObsidianSyntax(sectionNodesToText(currentNodes))}`,
        );
        currentNodes = [];
        currentTokens = countTokens(headerText);
      }
      currentNodes.push(node);
      currentTokens += nodeTokens;
    }
  }

  if (currentNodes.length > 0) {
    chunks.push(`${headerText}\n\n${normalizeObsidianSyntax(sectionNodesToText(currentNodes))}`);
  }

  return chunks;
}

function sectionsToChunks(
  sections: Section[],
  title: string,
): Array<{ sectionPath: string; text: string }> {
  const result: Array<{ sectionPath: string; text: string }> = [];

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

    if (tokenCount > MAX_CHUNK_TOKENS) {
      const splitTexts = splitAtParagraphBoundaries(ps.nodes, header);
      for (const t of splitTexts) {
        result.push({ sectionPath: ps.sectionPath, text: t });
      }
    } else {
      result.push({
        sectionPath: ps.sectionPath,
        text: `${header}\n\n${text}`,
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

  return result;
}

export function chunkMarkdown(body: string, opts: ChunkOptions): MarkdownChunk[] {
  const { title } = opts;

  // Return empty array for empty/whitespace body
  if (!body || body.trim().length === 0) {
    return [];
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
    return [];
  }

  // Convert sections to text chunks (with merge/split logic)
  const textChunks = sectionsToChunks(sections, title);

  // Assign sequential chunkIndex
  return textChunks.map((item, idx) => ({
    text: item.text,
    sectionPath: item.sectionPath,
    chunkIndex: idx,
  }));
}
