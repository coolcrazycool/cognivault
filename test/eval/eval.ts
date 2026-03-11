/**
 * CogniVault Search Evaluation Harness
 *
 * Measures recall@10 for semantic, lexical, and hybrid search across
 * multilingual queries (English, Russian, mixed).
 *
 * Usage:
 *   npx tsx test/eval/eval.ts
 *
 * Environment:
 *   COGNIVAULT_API_KEY  Required. Bearer token for API auth.
 *   BASE_URL            Optional. Server URL (default: http://localhost:3000)
 *
 * Exit codes:
 *   0 — All categories pass recall threshold (>= 0.7)
 *   1 — One or more categories fail threshold
 *   2 — Server not ready or no indexed content found
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Query {
  id: string;
  category: string;
  query: string;
  relevant_paths: string[];
}

interface QuerySet {
  queries: Query[];
}

interface SearchResult {
  text: string;
  path: string;
  title: string;
  section_path: string;
  score: number;
  tags: string[];
  project: string | null;
  status: string | null;
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  limit: number;
  query_ms: number;
}

interface QueryResult {
  id: string;
  category: string;
  query: string;
  relevant_paths: string[];
  semantic_paths: string[];
  lexical_paths: string[];
  hybrid_paths: string[];
  semantic_recall: number;
  lexical_recall: number;
  hybrid_recall: number;
}

interface CategoryStats {
  semantic: number;
  lexical: number;
  hybrid: number;
  count: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:3000';
const API_KEY = process.env['COGNIVAULT_API_KEY'];
const RECALL_K = 10;
const THRESHOLD = 0.7;

if (!API_KEY) {
  console.error('Error: COGNIVAULT_API_KEY environment variable is required.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Load query set
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const queriesPath = join(__dirname, 'queries.json');

const rawQueries = readFileSync(queriesPath, 'utf-8');
const querySet: QuerySet = JSON.parse(rawQueries) as QuerySet;
const { queries } = querySet;

console.log(`Loaded ${queries.length} queries from ${queriesPath}`);

// ---------------------------------------------------------------------------
// Core metric: recall@K
// ---------------------------------------------------------------------------

/**
 * Compute recall@K for retrieved paths vs. relevant paths.
 *
 * recall@K = |relevant ∩ retrieved[:K]| / |relevant|
 *
 * If relevant is empty, return 1.0 (nothing to retrieve = trivially satisfied).
 */
function recallAtK(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 1.0;

  const topK = retrieved.slice(0, k);
  const relevantSet = new Set(relevant);
  let hits = 0;

  for (const path of topK) {
    if (relevantSet.has(path)) {
      hits++;
    }
  }

  return hits / relevant.length;
}

// ---------------------------------------------------------------------------
// Search function
// ---------------------------------------------------------------------------

/**
 * POST to a search endpoint and return the result paths.
 */
async function search(endpoint: string, query: string, limit: number): Promise<string[]> {
  const url = `${BASE_URL}/api/vault/search/${endpoint}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ query, limit }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Search ${endpoint} failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as SearchResponse;
  return data.results.map((r) => r.path);
}

// ---------------------------------------------------------------------------
// Preamble check: verify server has indexed content
// ---------------------------------------------------------------------------

console.log(`\nConnecting to ${BASE_URL}...`);

let preamblePaths: string[];

try {
  preamblePaths = await search('semantic', 'architecture documentation', 10);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nFailed to reach server: ${message}`);
  console.error('Make sure the API server is running and COGNIVAULT_API_KEY is correct.');
  process.exit(2);
}

if (preamblePaths.length === 0) {
  console.warn('\nWarning: Semantic search returned no results for preamble query.');
  console.warn('The vault may not have indexed content yet. Run the indexer first.');
  process.exit(2);
}

console.log(`Server ready. Preamble check returned ${preamblePaths.length} results.`);

// ---------------------------------------------------------------------------
// Run evaluation
// ---------------------------------------------------------------------------

console.log(`\nRunning evaluation over ${queries.length} queries...\n`);

const results: QueryResult[] = [];

for (const q of queries) {
  let semanticPaths: string[] = [];
  let lexicalPaths: string[] = [];
  let hybridPaths: string[] = [];

  try {
    semanticPaths = await search('semantic', q.query, RECALL_K);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [WARN] semantic search failed for ${q.id}: ${msg}`);
  }

  try {
    lexicalPaths = await search('lexical', q.query, RECALL_K);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [WARN] lexical search failed for ${q.id}: ${msg}`);
  }

  try {
    hybridPaths = await search('hybrid', q.query, RECALL_K);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [WARN] hybrid search failed for ${q.id}: ${msg}`);
  }

  const semanticRecall = recallAtK(semanticPaths, q.relevant_paths, RECALL_K);
  const lexicalRecall = recallAtK(lexicalPaths, q.relevant_paths, RECALL_K);
  const hybridRecall = recallAtK(hybridPaths, q.relevant_paths, RECALL_K);

  results.push({
    id: q.id,
    category: q.category,
    query: q.query,
    relevant_paths: q.relevant_paths,
    semantic_paths: semanticPaths,
    lexical_paths: lexicalPaths,
    hybrid_paths: hybridPaths,
    semantic_recall: semanticRecall,
    lexical_recall: lexicalRecall,
    hybrid_recall: hybridRecall,
  });
}

// ---------------------------------------------------------------------------
// Aggregate results by category
// ---------------------------------------------------------------------------

const categoryStats = new Map<string, CategoryStats>();

for (const r of results) {
  const stats = categoryStats.get(r.category) ?? {
    semantic: 0,
    lexical: 0,
    hybrid: 0,
    count: 0,
  };
  stats.semantic += r.semantic_recall;
  stats.lexical += r.lexical_recall;
  stats.hybrid += r.hybrid_recall;
  stats.count += 1;
  categoryStats.set(r.category, stats);
}

// Compute overall
const overall: CategoryStats = { semantic: 0, lexical: 0, hybrid: 0, count: 0 };
for (const [, stats] of categoryStats) {
  overall.semantic += stats.semantic;
  overall.lexical += stats.lexical;
  overall.hybrid += stats.hybrid;
  overall.count += stats.count;
}

function avg(stats: CategoryStats): { semantic: number; lexical: number; hybrid: number } {
  const n = stats.count === 0 ? 1 : stats.count;
  return {
    semantic: stats.semantic / n,
    lexical: stats.lexical / n,
    hybrid: stats.hybrid / n,
  };
}

function fmt(n: number): string {
  return n.toFixed(2).padStart(8);
}

function passOrFail(n: number): string {
  return n >= THRESHOLD ? 'PASS' : 'FAIL';
}

// ---------------------------------------------------------------------------
// Print tabular report
// ---------------------------------------------------------------------------

console.log('\n========================================');
console.log('  Search Quality Evaluation (recall@10)');
console.log('========================================\n');

const header = 'Category    | Semantic | Lexical | Hybrid  | Status';
const divider = '------------|----------|---------|---------|-------';

console.log(header);
console.log(divider);

const categories = ['english', 'russian', 'mixed'];
let anyFail = false;

for (const cat of categories) {
  const stats = categoryStats.get(cat);
  if (!stats) {
    console.log(`${cat.padEnd(11)} | (no queries)`);
    continue;
  }
  const a = avg(stats);
  const status = [a.semantic, a.lexical, a.hybrid].every((v) => v >= THRESHOLD) ? 'PASS' : 'FAIL';
  if (status === 'FAIL') anyFail = true;

  // Check per-type failures
  const semStatus = passOrFail(a.semantic);
  const lexStatus = passOrFail(a.lexical);
  const hybStatus = passOrFail(a.hybrid);
  const rowStatus = semStatus === 'PASS' && lexStatus === 'PASS' && hybStatus === 'PASS' ? 'PASS' : 'FAIL';
  if (rowStatus === 'FAIL') anyFail = true;

  console.log(
    `${cat.padEnd(11)} |${fmt(a.semantic)} |${fmt(a.lexical)} |${fmt(a.hybrid)} | ${rowStatus}`,
  );
}

console.log(divider);

const overallAvg = avg(overall);
const overallStatus =
  overallAvg.semantic >= THRESHOLD &&
  overallAvg.lexical >= THRESHOLD &&
  overallAvg.hybrid >= THRESHOLD
    ? 'PASS'
    : 'FAIL';
if (overallStatus === 'FAIL') anyFail = true;

console.log(
  `${'overall'.padEnd(11)} |${fmt(overallAvg.semantic)} |${fmt(overallAvg.lexical)} |${fmt(overallAvg.hybrid)} | ${overallStatus}`,
);

console.log(`\nThreshold: ${THRESHOLD} — PASS if all categories >= threshold\n`);

// ---------------------------------------------------------------------------
// Per-category PASS/FAIL breakdown
// ---------------------------------------------------------------------------

console.log('Per-category threshold check:');
for (const cat of categories) {
  const stats = categoryStats.get(cat);
  if (!stats) continue;
  const a = avg(stats);
  console.log(
    `  ${cat}: semantic=${passOrFail(a.semantic)}, lexical=${passOrFail(a.lexical)}, hybrid=${passOrFail(a.hybrid)}`,
  );
}

// ---------------------------------------------------------------------------
// Per-query details (for debugging)
// ---------------------------------------------------------------------------

console.log('\n========================================');
console.log('  Per-Query Details');
console.log('========================================\n');

for (const r of results) {
  console.log(`[${r.id}] (${r.category}) "${r.query}"`);
  console.log(`  Expected: ${r.relevant_paths.join(', ')}`);
  console.log(
    `  Recall   — semantic: ${r.semantic_recall.toFixed(2)}, lexical: ${r.lexical_recall.toFixed(2)}, hybrid: ${r.hybrid_recall.toFixed(2)}`,
  );

  const semanticHits = r.semantic_paths.filter((p) => r.relevant_paths.includes(p));
  const lexicalHits = r.lexical_paths.filter((p) => r.relevant_paths.includes(p));
  const hybridHits = r.hybrid_paths.filter((p) => r.relevant_paths.includes(p));

  if (semanticHits.length > 0) console.log(`  Sem hits : ${semanticHits.join(', ')}`);
  if (lexicalHits.length > 0) console.log(`  Lex hits : ${lexicalHits.join(', ')}`);
  if (hybridHits.length > 0) console.log(`  Hyb hits : ${hybridHits.join(', ')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Exit with appropriate code
// ---------------------------------------------------------------------------

if (anyFail) {
  console.error('RESULT: FAIL — one or more categories below recall threshold.');
  process.exit(1);
} else {
  console.log('RESULT: PASS — all categories meet recall threshold.');
  process.exit(0);
}
