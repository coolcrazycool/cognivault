#!/usr/bin/env -S npx tsx
/**
 * Аудит стыка markdown → чанки: что делает `src/lib/chunker.ts` с реальным корпусом.
 *
 * Инструмент прогоняет НАСТОЯЩИЙ чанкер (`chunkMarkdownWithSections`) и НАСТОЯЩИЙ
 * построитель разреженных векторов (`buildSparseVector`/`tokenize`) по каждому файлу
 * вольта. Ничего не форкает и не переписывает: любая копия логики мерила бы копию, а
 * не то, что крутится в проде, и «стало лучше» нельзя было бы отличить от «разошлись
 * реализации».
 *
 * ЗАЧЕМ отдельный инструмент, а не глазами
 * ----------------------------------------
 * Порча на этом стыке невидима в выдаче: разорванный пополам SQL, продолжение таблицы
 * без строки заголовков, чанк из одного заголовка — всё это индексируется молча и
 * всплывает только как «ассистент ответил мимо». Единственный способ поймать — пройти
 * границы чанков программно и получить число, сравнимое с числом после правки.
 * Поэтому прогон офлайновый (ни Qdrant, ни GigaChat), детерминированный (файлы в
 * лексикографическом порядке) и печатает машиночитаемый JSON рядом с человеческой
 * сводкой — отчёт можно коммитить и диффать.
 *
 * Что меряется
 * ------------
 * 1. sizes       -- чанков на страницу, распределение токенов (тем же cl100k, что
 *                   считает бюджет сам чанкер), перебор бюджета, доля table_rows;
 * 2. structure   -- забор кода, GFM-таблица, список и линеаризованная строка,
 *                   разорванные границей чанка; чанки-огрызки;
 * 3. sections    -- родительские разделы: сколько, чанков на раздел, длина
 *                   `section_text` против `section_max_chars`, коллизии `parentId`;
 * 4. duplicates  -- почти одинаковые чанки в РАЗНЫХ файлах по Жаккару над индексами
 *                   разреженного вектора: они конкурируют друг с другом в RRF и
 *                   съедают top-k;
 * 5. outliers    -- крупнейшие страницы, страницы с нулём и одним чанком.
 *
 *     npx tsx tools/rag_audit/audit_chunk.ts \
 *         --vault /tmp/audit/vault --out /tmp/audit/chunk-report.json
 *
 * Вход — ровно то, что кладёт `audit_convert.py --out-dir`: `Confluence/<space>/…/<Заголовок>.md`
 * с YAML-фронтматтером. Фронтматтер снимается тем же `gray-matter`, а `title` берётся
 * из имени файла — как в `src/plugins/pipeline.ts`, иначе замер описывал бы другой вход.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BM25_AVG_LEN, buildSparseVector, tokenize } from '../../src/lib/bm25.js';
import type { ContentKind, MarkdownChunk } from '../../src/lib/chunker.js';
import {
  chunkMarkdownWithSections,
  countTokens,
  DOC_SUMMARY_PREFIX,
  MAX_CHUNK_TOKENS,
  MIN_CHUNK_TOKENS,
  TABLE_MAX_TOKENS,
} from '../../src/lib/chunker.js';

// ===========================================================================
// Пороги замера
// ===========================================================================

/**
 * Дефолт `section_max_chars` из UI (`cognivault-ui/bootstrap.py`): поиск режет
 * `section_text` по нему, так что раздел длиннее — это раздел, который до модели
 * доедет обрезанным.
 */
export const SECTION_MAX_CHARS = 4000;

/** Чанк короче — заведомо огрызок: матчится на заголовок и не несёт ответа. */
export const TINY_BODY_CHARS = 100;

/** Порог Жаккара по индексам разреженного вектора, при котором чанки считаем почти одинаковыми. */
export const DUPLICATE_THRESHOLD = 0.8;

/** Сколько самых редких термов чанка кладётся в инвертированный индекс кандидатов. */
const SKETCH_TOKENS = 16;

/** Постинг-лист длиннее не порождает пар: это уже не «редкий терм», а шум. */
const MAX_POSTING = 400;

/** Строки короче не годятся как отпечаток блока — совпадут случайно. */
const DISTINCTIVE_LINE_CHARS = 12;

// ===========================================================================
// Мелкая арифметика
// ===========================================================================

export interface Distribution {
  count: number;
  min: number;
  median: number;
  p90: number;
  max: number;
  total: number;
}

/** Квантиль по методу «ближайшего ранга» — без интерполяции, чтобы отчёт был воспроизводим. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] as number;
}

export function distribution(values: number[]): Distribution {
  if (values.length === 0) {
    return { count: 0, min: 0, median: 0, p90: 0, max: 0, total: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] as number,
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    max: sorted[sorted.length - 1] as number,
    total: sorted.reduce((sum, v) => sum + v, 0),
  };
}

/** Жаккар над двумя множествами индексов разреженного вектора. */
export function jaccard(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const index of small) {
    if (large.has(index)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

// ===========================================================================
// Текст чанка: тело без хлебной крошки
// ===========================================================================

/**
 * Тело чанка — то, что осталось после хлебной крошки (`withBreadcrumb`) и, если она
 * есть, аннотации документа (`DOC_SUMMARY_PREFIX`).
 *
 * Меряется именно тело: крошка повторяется в каждом чанке, и если считать её
 * содержимым, то чанк-огрызок из одного заголовка выглядит осмысленным.
 */
export function chunkBody(text: string, sectionPath: string): string {
  let body = text;
  if (body.startsWith(DOC_SUMMARY_PREFIX)) {
    const gap = body.indexOf('\n\n');
    if (gap !== -1) body = body.slice(gap + 2);
  }
  if (body.startsWith(`${sectionPath}\n\n`)) {
    return body.slice(sectionPath.length + 2);
  }
  // Табличный чанк несёт префикс `${sectionPath} > Таблица: …` — он тоже крошка.
  if (body.startsWith(`${sectionPath} > `)) {
    const gap = body.indexOf('\n\n');
    if (gap !== -1) return body.slice(gap + 2);
  }
  return body;
}

// ===========================================================================
// Разметка внутри чанка (замер по границам)
// ===========================================================================

const FENCE_RE = /^ {0,3}```/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const PIPE_LINE_RE = /^\s*\|.*\|\s*$/;
const LIST_LINE_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+\S/;
const HEADING_LINE_RE = /^#{1,6}\s+\S/;
const LINEARIZED_ROW_RE = /^\*\*[^*\n]+:\*\* /;

/** Сколько строк-заборов в тексте. Нечётное число = забор разорван границей чанка. */
export function fenceLineCount(text: string): number {
  return text.split('\n').filter((line) => FENCE_RE.test(line)).length;
}

export function hasUnbalancedFence(text: string): boolean {
  return fenceLineCount(text) % 2 === 1;
}

export interface PipeRun {
  /** Индекс первой строки прогона в теле чанка. */
  start: number;
  lines: string[];
  /** Есть ли под первой строкой строка-разделитель, то есть является ли прогон таблицей с шапкой. */
  headed: boolean;
}

/** Прогоны подряд идущих строк вида `| … |` — куски GFM-таблицы внутри чанка. */
export function pipeRuns(body: string): PipeRun[] {
  const lines = body.split('\n');
  const runs: PipeRun[] = [];
  let current: string[] = [];
  let start = 0;

  const flush = (): void => {
    if (current.length >= 2) {
      runs.push({
        start,
        lines: [...current],
        headed: TABLE_DELIM_RE.test(current[1] as string),
      });
    }
    current = [];
  };

  lines.forEach((line, index) => {
    if (PIPE_LINE_RE.test(line)) {
      if (current.length === 0) start = index;
      current.push(line);
      return;
    }
    flush();
  });
  flush();
  return runs;
}

/**
 * Строки данных GFM-таблицы в отрендеренном куске: без шапки, без разделителя и без
 * слишком коротких строк, по которым нельзя опознать таблицу.
 */
export function tableRowLines(rendered: string): string[] {
  const pipes = rendered
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => PIPE_LINE_RE.test(line));
  return pipes
    .slice(1)
    .filter((line) => !TABLE_DELIM_RE.test(line) && line.length >= DISTINCTIVE_LINE_CHARS);
}

/** Куски таблицы без строки заголовков: значения без имён колонок — ответ по ним не построить. */
export function headerlessTableRuns(body: string): PipeRun[] {
  return pipeRuns(body).filter((run) => !run.headed);
}

export function isListLine(line: string): boolean {
  return LIST_LINE_RE.test(line);
}

/** Продолжение пункта списка: отступ под маркером, не пустая строка. */
export function isListContinuation(line: string): boolean {
  return /^\s{2,}\S/.test(line) && !isListLine(line);
}

/** Чанк — только заголовок (или несколько заголовков подряд) и больше ничего. */
export function isHeadingOnly(body: string): boolean {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => HEADING_LINE_RE.test(line));
}

export function isTinyBody(body: string): boolean {
  return body.trim().length < TINY_BODY_CHARS;
}

// ===========================================================================
// Блоки исходника (замер по содержимому)
// ===========================================================================

export interface FencedBlock {
  lang: string;
  /** Тело забора без самих ``` — чанкер их срезает, сравнивать можно только содержимое. */
  body: string;
  line: number;
}

/** Заборы кода в исходном markdown. */
export function extractFencedBlocks(md: string): FencedBlock[] {
  const lines = md.split('\n');
  const blocks: FencedBlock[] = [];
  let open: { lang: string; line: number; body: string[] } | null = null;

  lines.forEach((line, index) => {
    const isFence = FENCE_RE.test(line);
    if (open === null) {
      if (isFence) open = { lang: line.trim().slice(3).trim(), line: index, body: [] };
      return;
    }
    if (isFence) {
      blocks.push({ lang: open.lang, body: open.body.join('\n'), line: open.line });
      open = null;
      return;
    }
    open.body.push(line);
  });
  return blocks;
}

export interface SourceTable {
  block: string;
  rows: number;
  line: number;
}

/** GFM-таблицы в исходном markdown: строка заголовков + разделитель + строки данных. */
export function extractGfmTables(md: string): SourceTable[] {
  const lines = md.split('\n');
  const tables: SourceTable[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = lines[index] as string;
    const delimiter = lines[index + 1];
    if (!PIPE_LINE_RE.test(header) || delimiter === undefined || !TABLE_DELIM_RE.test(delimiter)) {
      index += 1;
      continue;
    }
    let end = index + 2;
    while (end < lines.length && PIPE_LINE_RE.test(lines[end] as string)) end += 1;
    tables.push({
      block: lines.slice(index, end).join('\n'),
      rows: end - (index + 2),
      line: index,
    });
    index = end;
  }
  return tables;
}

/**
 * Блоки списков: прогон строк-пунктов вместе с их отступными продолжениями.
 * Пустая строка внутри блока допускается (loose list), но только если после неё
 * список продолжается.
 */
export function extractListBlocks(md: string): string[] {
  const lines = md.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let items = 0;

  const flush = (): void => {
    while (current.length > 0 && (current[current.length - 1] as string).trim().length === 0) {
      current.pop();
    }
    if (items >= 2) blocks.push(current.join('\n'));
    current = [];
    items = 0;
  };

  for (const line of lines) {
    if (isListLine(line)) {
      current.push(line);
      items += 1;
      continue;
    }
    if (current.length > 0 && (isListContinuation(line) || line.trim().length === 0)) {
      current.push(line);
      continue;
    }
    flush();
  }
  flush();
  return blocks;
}

/**
 * Строки линеаризованной таблицы: конвертер кладёт целую строку одним абзацем
 * `**Колонка:** значение. **Колонка:** значение.` — поля строки связаны только тем,
 * что стоят в одном абзаце. Разрежет чанкер абзац — связь исчезнет.
 */
export function extractLinearizedRows(md: string): string[] {
  return md.split('\n').filter((line) => LINEARIZED_ROW_RE.test(line));
}

/** Сколько первых символов строки берётся как якорь при поиске «с середины строки». */
const MID_ROW_ANCHOR_CHARS = 60;

/**
 * Тело чанка начинается не с начала линеаризованной строки, а с её середины.
 *
 * Проверка привязана к конкретным строкам страницы, а не к форме предложения: начало
 * чанка ищется ВНУТРИ известной строки таблицы. Совпало не с нулевой позиции — значит
 * читатель (и модель) получил хвост строки без ярлыков первых полей и не знает, к
 * какой сущности эти значения относятся.
 */
export function startsMidLinearizedRow(body: string, rowTexts: string[]): boolean {
  const first = (body.split('\n').find((line) => line.trim().length > 0) ?? '').trim();
  if (first.length < DISTINCTIVE_LINE_CHARS) return false;
  const anchor = first.slice(0, MID_ROW_ANCHOR_CHARS);
  return rowTexts.some((row) => !row.startsWith(anchor) && row.includes(anchor));
}

// ===========================================================================
// Эталонный рендер: спрашиваем сам чанкер, как выглядит блок в чанке
// ===========================================================================

/**
 * Как блок исходника выглядит ПОСЛЕ чанкера.
 *
 * Чанкер не хранит markdown как есть: он срезает `**` и заборы, перерисовывает
 * списки и таблицы. Сравнивать исходную строку с текстом чанка бессмысленно — она
 * не совпадёт никогда. Поэтому эталон рендера берётся у самого чанкера: блок
 * прогоняется отдельным «документом», и с чанками страницы сравнивается уже его
 * собственный вывод. Ноль своей логики рендера — ноль расхождений с продом.
 *
 * Длина возвращённого списка — это ещё и ответ на вопрос «влезает ли блок в один
 * чанк в принципе»: больше одного элемента = не влезает даже в одиночку.
 */
export function renderBlock(block: string, title: string): string[] {
  const { chunks } = chunkMarkdownWithSections(block, { title });
  return chunks.map((chunk) => flattenIndent(chunkBody(chunk.text, chunk.sectionPath)).trim());
}

/**
 * Отступы — не содержимое.
 *
 * `listToText` переносит вложенный блок под маркер пункта, добавляя ему отступ, так
 * что таблица или забор кода внутри списка приходит в чанк сдвинутой на 3 символа.
 * Сравнивать «как есть» — значит объявлять разорванным всё, что лежит внутри списка.
 */
export function flattenIndent(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

/**
 * Фильтр «строка встречается один раз».
 *
 * Отпечаток блока строится только на его уникальных строках: повторяющаяся строка
 * найдётся в чужом чанке и раздует «разъехался на N частей» до размера страницы.
 * Если уникальных не осталось (блок целиком состоит из повторов), фильтр пропускает
 * всё — лучше завышенная оценка, чем немая метрика.
 */
export function occurrenceFilter(all: string[]): (lines: string[]) => string[] {
  const counts = new Map<string, number>();
  for (const line of all) counts.set(line, (counts.get(line) ?? 0) + 1);
  return (lines: string[]): string[] => {
    const unique = lines.filter((line) => counts.get(line) === 1);
    return unique.length > 0 ? unique : lines;
  };
}

function distinctiveLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= DISTINCTIVE_LINE_CHARS);
}

/** Индексы чанков страницы, содержащих хоть одну характерную строку блока. */
function chunksContainingAny(lines: string[], texts: string[]): Set<number> {
  const found = new Set<number>();
  texts.forEach((text, index) => {
    if (lines.some((line) => text.includes(line))) found.add(index);
  });
  return found;
}

function containedWhole(rendered: string, texts: string[]): boolean {
  if (rendered.length === 0) return true;
  return texts.some((text) => text.includes(rendered));
}

// ===========================================================================
// Замер одной страницы
// ===========================================================================

export interface StructuralFinding {
  kind:
    | 'code_split'
    | 'code_lost'
    | 'table_split'
    | 'table_rows_lost'
    | 'headerless_table_chunk'
    | 'list_split'
    | 'linearized_row_split'
    | 'mid_row_chunk'
    | 'tiny_chunk'
    | 'heading_only_chunk'
    | 'unbalanced_fence';
  /** Сколько чанков затронул случай (для разрывов — на сколько частей разъехался блок). */
  spans: number;
  excerpt: string;
}

export interface ChunkRecord {
  file: string;
  title: string;
  chunkIndex: number;
  sectionPath: string;
  parentId: string;
  contentKind: ContentKind;
  tokens: number;
  /** Длина чанка в термах `tokenize()` — той самой мере, против которой нормируется BM25. */
  lexTokens: number;
  chars: number;
  bodyChars: number;
  text: string;
  indices: Set<number>;
}

export interface PageMetrics {
  path: string;
  title: string;
  mdChars: number;
  bodyChars: number;
  chunks: number;
  sections: number;
  tokens: Distribution;
  kinds: Record<ContentKind, number>;
  overBudget: number;
  overBudgetExcess: number;
  tinyChunks: number;
  headingOnlyChunks: number;
  unbalancedFenceChunks: number;
  fencesInSource: number;
  fencesInChunks: number;
  codeBlocks: number;
  codeBlocksSplit: number;
  codeBlocksLost: number;
  tablesInSource: number;
  tablesIntact: number;
  tablesChunkedByDesign: number;
  tablesSplit: number;
  tableRowsLost: number;
  headerlessTableChunks: number;
  listBlocks: number;
  listBlocksSplit: number;
  listCutBoundaries: number;
  linearizedRows: number;
  linearizedRowsSplit: number;
  linearizedRowsOverBudget: number;
  midRowChunks: number;
  sectionChars: Distribution;
  sectionsOverCap: number;
  chunksInOversizedSections: number;
  parentIdCollisions: number;
  findings: StructuralFinding[];
}

export interface PageAudit {
  metrics: PageMetrics;
  records: ChunkRecord[];
  /** Длины `section_text` всех разделов страницы — для сводного распределения по корпусу. */
  sectionLengths: number[];
}

const EXCERPT_CHARS = 140;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}…`;
}

/** Бюджет, по которому судится чанк: у табличных он свой и намеренно больший. */
export function budgetFor(kind: ContentKind): number {
  return kind === 'table_rows' ? TABLE_MAX_TOKENS : MAX_CHUNK_TOKENS;
}

export function auditPage(relPath: string, raw: string): PageAudit {
  const title = path.basename(relPath, '.md');
  let body: string;
  try {
    body = matter(raw).content;
  } catch {
    body = raw;
  }

  const { chunks, sections } = chunkMarkdownWithSections(body, { title, path: relPath });
  // `texts` — то, что реально уйдёт в индекс; `probe` — та же строка без отступов,
  // по ней ищутся блоки исходника (см. flattenIndent).
  const rawTexts = chunks.map((chunk) => chunk.text);
  const texts = rawTexts.map((text) => flattenIndent(text));
  const bodies = chunks.map((chunk) => chunkBody(chunk.text, chunk.sectionPath));
  const findings: StructuralFinding[] = [];

  // --- размеры и бюджет ---
  const tokens = chunks.map((chunk) => countTokens(chunk.text));
  const kinds: Record<ContentKind, number> = { text: 0, table_rows: 0 };
  let overBudget = 0;
  let overBudgetExcess = 0;
  chunks.forEach((chunk, index) => {
    kinds[chunk.contentKind] += 1;
    const excess = (tokens[index] as number) - budgetFor(chunk.contentKind);
    if (excess > 0) {
      overBudget += 1;
      overBudgetExcess = Math.max(overBudgetExcess, excess);
    }
  });

  // --- огрызки ---
  let tinyChunks = 0;
  let headingOnlyChunks = 0;
  let unbalancedFenceChunks = 0;
  bodies.forEach((chunkText, index) => {
    if (isHeadingOnly(chunkText)) {
      headingOnlyChunks += 1;
      findings.push({ kind: 'heading_only_chunk', spans: 1, excerpt: excerpt(chunkText) });
    } else if (isTinyBody(chunkText)) {
      tinyChunks += 1;
      findings.push({ kind: 'tiny_chunk', spans: 1, excerpt: excerpt(chunkText) });
    }
    if (hasUnbalancedFence(rawTexts[index] as string)) {
      unbalancedFenceChunks += 1;
      findings.push({ kind: 'unbalanced_fence', spans: 1, excerpt: excerpt(chunkText) });
    }
  });

  // --- код ---
  const fenced = extractFencedBlocks(body);
  // Отпечаток блока — только те его строки, которые среди блоков этой страницы
  // встречаются ровно один раз. Повторяющаяся строка (`AND a.event_dt = b.event_dt`,
  // закрывающая скобка) найдётся в половине чанков и раздует «разъехался на N частей»
  // до размера страницы.
  const codeFingerprint = occurrenceFilter(
    fenced.flatMap((block) => distinctiveLines(flattenIndent(block.body))),
  );
  let codeBlocksSplit = 0;
  let codeBlocksLost = 0;
  for (const block of fenced) {
    const trimmed = flattenIndent(block.body).trim();
    if (trimmed.length === 0) continue;
    if (containedWhole(trimmed, texts)) continue;
    const lines = distinctiveLines(trimmed);
    const spans = chunksContainingAny(codeFingerprint(lines), texts).size;
    if (spans === 0) {
      codeBlocksLost += 1;
      findings.push({ kind: 'code_lost', spans: 0, excerpt: excerpt(trimmed) });
    } else {
      codeBlocksSplit += 1;
      findings.push({ kind: 'code_split', spans, excerpt: excerpt(trimmed) });
    }
  }

  // --- таблицы ---
  const tables = extractGfmTables(body);
  const renderedTables = tables.map((table) => ({
    table,
    // Отступ снимается ДО рендера: таблица внутри пункта списка приходит сдвинутой,
    // а строка с отступом в четыре пробела (или таб) — это уже не таблица, а блок
    // кода, и эталон рендера получился бы не таблицей.
    pieces: renderBlock(flattenIndent(table.block), title),
  }));
  // Одинаковые строки в разных таблицах страницы («| id | id записи | bigint |») —
  // обычное дело в реестрах витрин. Их нельзя использовать как отпечаток: строка
  // найдётся в чужом чанке и целая таблица будет объявлена разъехавшейся.
  const rowOccurrences = new Map<string, number>();
  for (const { pieces } of renderedTables) {
    for (const line of pieces.flatMap((piece) => tableRowLines(piece))) {
      rowOccurrences.set(line, (rowOccurrences.get(line) ?? 0) + 1);
    }
  }

  let tablesIntact = 0;
  let tablesChunkedByDesign = 0;
  let tablesSplit = 0;
  let tableRowsLost = 0;
  for (const { table, pieces } of renderedTables) {
    const uniqueRows = [...new Set(pieces.flatMap((piece) => tableRowLines(piece)))].filter(
      (line) => rowOccurrences.get(line) === 1,
    );
    for (const row of uniqueRows) {
      if (chunksContainingAny([row], texts).size === 0) tableRowsLost += 1;
    }
    if (tableRowsLost > 0 && findings.every((f) => f.kind !== 'table_rows_lost')) {
      findings.push({
        kind: 'table_rows_lost',
        spans: tableRowsLost,
        excerpt: excerpt(table.block),
      });
    }
    if (pieces.length > 1) {
      // Таблица не влезает в бюджет и режется `chunkTable` по целым строкам с
      // повторённой шапкой — это штатный путь, а не разрыв.
      tablesChunkedByDesign += 1;
      continue;
    }
    if (containedWhole(pieces[0] ?? '', texts)) {
      tablesIntact += 1;
      continue;
    }
    const spans = chunksContainingAny(uniqueRows, texts).size;
    tablesSplit += 1;
    findings.push({ kind: 'table_split', spans, excerpt: excerpt(table.block) });
  }

  const headerlessTableChunks = bodies.filter((chunkText) => {
    return headerlessTableRuns(chunkText).length > 0;
  }).length;
  if (headerlessTableChunks > 0) {
    const sample = bodies.find((chunkText) => headerlessTableRuns(chunkText).length > 0) as string;
    findings.push({
      kind: 'headerless_table_chunk',
      spans: headerlessTableChunks,
      excerpt: excerpt(sample),
    });
  }

  // --- списки ---
  const listBlocks = extractListBlocks(body);
  const renderedLists = listBlocks.map((block) => ({
    block,
    pieces: renderBlock(block, title),
  }));
  const listFingerprint = occurrenceFilter(
    renderedLists.flatMap(({ pieces }) => pieces.flatMap((piece) => distinctiveLines(piece))),
  );
  let listBlocksSplit = 0;
  for (const { block, pieces: rendered } of renderedLists) {
    if (rendered.length === 1 && containedWhole(rendered[0] as string, texts)) continue;
    const lines = rendered.flatMap((piece) => distinctiveLines(piece));
    const spans = chunksContainingAny(listFingerprint(lines), texts).size;
    if (spans > 1) {
      listBlocksSplit += 1;
      findings.push({ kind: 'list_split', spans, excerpt: excerpt(block) });
    }
  }

  // Где именно прошла граница: конец одного чанка и начало следующего — оба пункты списка.
  let listCutBoundaries = 0;
  for (let i = 0; i + 1 < chunks.length; i += 1) {
    const left = chunks[i] as MarkdownChunk;
    const right = chunks[i + 1] as MarkdownChunk;
    if (left.parentId !== right.parentId) continue;
    if (left.contentKind !== 'text' || right.contentKind !== 'text') continue;
    const leftLines = (bodies[i] as string).split('\n').filter((line) => line.trim().length > 0);
    const rightLines = (bodies[i + 1] as string)
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const tail = leftLines[leftLines.length - 1] ?? '';
    const head = rightLines[0] ?? '';
    if (isListLine(tail) && (isListLine(head) || isListContinuation(head))) listCutBoundaries += 1;
  }

  // --- линеаризованные таблицы ---
  const rows = extractLinearizedRows(body);
  let linearizedRowsSplit = 0;
  let linearizedRowsOverBudget = 0;
  const renderedRows: string[] = [];
  for (const row of rows) {
    const rendered = renderBlock(row, title);
    renderedRows.push(rendered.join(' '));
    if (rendered.length > 1) {
      // Строка не помещается в чанк даже в одиночку — разрыв гарантирован конструкцией.
      linearizedRowsOverBudget += 1;
      linearizedRowsSplit += 1;
      findings.push({
        kind: 'linearized_row_split',
        spans: rendered.length,
        excerpt: excerpt(row),
      });
      continue;
    }
    const whole = (rendered[0] ?? '').trim();
    if (whole.length === 0 || containedWhole(whole, texts)) continue;
    const spans = chunksContainingAny(distinctiveLines(whole), texts).size;
    linearizedRowsSplit += 1;
    findings.push({ kind: 'linearized_row_split', spans, excerpt: excerpt(row) });
  }
  const midRow = bodies.filter((chunkText) => startsMidLinearizedRow(chunkText, renderedRows));
  for (const chunkText of midRow) {
    findings.push({ kind: 'mid_row_chunk', spans: 1, excerpt: excerpt(chunkText) });
  }
  const midRowChunks = midRow.length;

  // --- разделы ---
  const sectionLengths = sections.map((section) => section.text.length);
  const sectionChars = distribution(sectionLengths);
  const sectionsOverCap = sections.filter(
    (section) => section.text.length > SECTION_MAX_CHARS,
  ).length;
  const seen = new Map<string, number>();
  for (const section of sections) {
    seen.set(section.parentId, (seen.get(section.parentId) ?? 0) + 1);
  }
  const parentIdCollisions = [...seen.values()].filter((count) => count > 1).length;
  // Чанк, чей раздел длиннее лимита, при `group_by_section` доедет до модели с
  // обрезанным `section_text` — расширение «маленький к большому» для него не работает.
  const oversizedParents = new Set(
    sections
      .filter((section) => section.text.length > SECTION_MAX_CHARS)
      .map((section) => section.parentId),
  );
  const chunksInOversizedSections = chunks.filter((chunk) =>
    oversizedParents.has(chunk.parentId),
  ).length;

  const fencesInChunks = rawTexts.reduce((sum, text) => sum + fenceLineCount(text), 0);

  const records: ChunkRecord[] = chunks.map((chunk, index) => ({
    file: relPath,
    title,
    chunkIndex: chunk.chunkIndex,
    sectionPath: chunk.sectionPath,
    parentId: chunk.parentId,
    contentKind: chunk.contentKind,
    tokens: tokens[index] as number,
    lexTokens: tokenize(chunk.text).length,
    chars: chunk.text.length,
    bodyChars: (bodies[index] as string).length,
    text: chunk.text,
    indices: new Set(buildSparseVector(chunk.text).indices),
  }));

  return {
    records,
    sectionLengths,
    metrics: {
      path: relPath,
      title,
      mdChars: raw.length,
      bodyChars: body.length,
      chunks: chunks.length,
      sections: sections.length,
      tokens: distribution(tokens),
      kinds,
      overBudget,
      overBudgetExcess,
      tinyChunks,
      headingOnlyChunks,
      unbalancedFenceChunks,
      fencesInSource: fenced.length * 2,
      fencesInChunks,
      codeBlocks: fenced.length,
      codeBlocksSplit,
      codeBlocksLost,
      tablesInSource: tables.length,
      tablesIntact,
      tablesChunkedByDesign,
      tablesSplit,
      tableRowsLost,
      headerlessTableChunks,
      listBlocks: listBlocks.length,
      listBlocksSplit,
      listCutBoundaries,
      linearizedRows: rows.length,
      linearizedRowsSplit,
      linearizedRowsOverBudget,
      midRowChunks,
      sectionChars,
      sectionsOverCap,
      chunksInOversizedSections,
      parentIdCollisions,
      findings,
    },
  };
}

// ===========================================================================
// Дубликаты между файлами
// ===========================================================================

export interface DuplicateCluster {
  size: number;
  /** Медианная длина чанка кластера в токенах — сколько top-k он способен занять. */
  tokens: number;
  files: string[];
  members: Array<{ file: string; chunkIndex: number; sectionPath: string; tokens: number }>;
  excerpt: string;
}

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(node: number): number {
    let root = node;
    while ((this.parent[root] as number) !== root) root = this.parent[root] as number;
    let cursor = node;
    while ((this.parent[cursor] as number) !== cursor) {
      const next = this.parent[cursor] as number;
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  }
}

/**
 * Кластеры почти одинаковых чанков из РАЗНЫХ файлов.
 *
 * Кандидаты берутся по инвертированному индексу самых редких термов чанка: полный
 * перебор пар при нескольких тысячах чанков — это миллионы пересечений множеств, а
 * почти одинаковые тексты обязаны делить редкие термы, иначе они не почти одинаковые.
 * Порог — Жаккар по индексам разреженного вектора, то есть ровно по тому словарю, по
 * которому чанки конкурируют в лексической ветке.
 */
export function nearDuplicateClusters(
  records: ChunkRecord[],
  threshold: number,
): DuplicateCluster[] {
  const documentFrequency = new Map<number, number>();
  for (const record of records) {
    for (const index of record.indices) {
      documentFrequency.set(index, (documentFrequency.get(index) ?? 0) + 1);
    }
  }

  const postings = new Map<number, number[]>();
  records.forEach((record, position) => {
    const rarest = [...record.indices]
      .sort((a, b) => {
        const byFrequency =
          (documentFrequency.get(a) as number) - (documentFrequency.get(b) as number);
        return byFrequency !== 0 ? byFrequency : a - b;
      })
      .slice(0, SKETCH_TOKENS);
    for (const index of rarest) {
      const bucket = postings.get(index);
      if (bucket === undefined) postings.set(index, [position]);
      else bucket.push(position);
    }
  });

  const union = new UnionFind(records.length);
  const compared = new Set<string>();
  let pairs = 0;
  for (const bucket of [...postings.values()].sort((a, b) => a.length - b.length)) {
    if (bucket.length < 2 || bucket.length > MAX_POSTING) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const left = bucket[i] as number;
        const right = bucket[j] as number;
        const key = `${left}:${right}`;
        if (compared.has(key)) continue;
        compared.add(key);
        const a = records[left] as ChunkRecord;
        const b = records[right] as ChunkRecord;
        // Дубль внутри одного файла — это чанки одной таблицы с общей шапкой, а не
        // копипаста между страницами; в top-k они и должны стоять рядом.
        if (a.file === b.file) continue;
        pairs += 1;
        if (jaccard(a.indices, b.indices) >= threshold) union.union(left, right);
      }
    }
  }
  void pairs;

  const groups = new Map<number, number[]>();
  records.forEach((_, position) => {
    const root = union.find(position);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [position]);
    else group.push(position);
  });

  const clusters: DuplicateCluster[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const members = group.map((position) => records[position] as ChunkRecord);
    const files = [...new Set(members.map((member) => member.file))].sort();
    if (files.length < 2) continue;
    clusters.push({
      size: members.length,
      tokens: quantile(
        members.map((member) => member.tokens).sort((a, b) => a - b),
        0.5,
      ),
      files,
      members: members.map((member) => ({
        file: member.file,
        chunkIndex: member.chunkIndex,
        sectionPath: member.sectionPath,
        tokens: member.tokens,
      })),
      excerpt: excerpt(
        chunkBody((members[0] as ChunkRecord).text, (members[0] as ChunkRecord).sectionPath),
      ),
    });
  }

  clusters.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    return (a.files[0] as string) < (b.files[0] as string) ? -1 : 1;
  });
  return clusters;
}

/** Побайтово одинаковые тела чанков в разных файлах — верхняя граница «чистой копипасты». */
export function exactDuplicateGroups(records: ChunkRecord[]): Array<{
  files: string[];
  count: number;
  tokens: number;
  excerpt: string;
}> {
  const byBody = new Map<string, ChunkRecord[]>();
  for (const record of records) {
    const key = chunkBody(record.text, record.sectionPath).replace(/\s+/g, ' ').trim();
    if (key.length < DISTINCTIVE_LINE_CHARS) continue;
    const bucket = byBody.get(key);
    if (bucket === undefined) byBody.set(key, [record]);
    else bucket.push(record);
  }

  const groups: Array<{ files: string[]; count: number; tokens: number; excerpt: string }> = [];
  for (const [key, bucket] of byBody) {
    const files = [...new Set(bucket.map((record) => record.file))].sort();
    if (files.length < 2) continue;
    groups.push({
      files,
      count: bucket.length,
      tokens: (bucket[0] as ChunkRecord).tokens,
      excerpt: excerpt(key),
    });
  }
  groups.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return (a.files[0] as string) < (b.files[0] as string) ? -1 : 1;
  });
  return groups;
}

// ===========================================================================
// Свод по корпусу
// ===========================================================================

function sum(pages: PageMetrics[], pick: (page: PageMetrics) => number): number {
  return pages.reduce((total, page) => total + pick(page), 0);
}

export interface CorpusReport {
  pages: number;
  chunks: number;
  sections: number;
  kinds: Record<ContentKind, number>;
  chunkTokens: Distribution;
  /** Длина чанка в термах `tokenize()`; сравнивается с {@link BM25_AVG_LEN}. */
  lexicalTokens: Distribution;
  bm25AvgLen: number;
  textChunkTokens: Distribution;
  tableChunkTokens: Distribution;
  chunksPerPage: Distribution;
  chunksPerSection: Distribution;
  sectionChars: Distribution;
  sectionsOverCap: number;
  chunksInOversizedSections: number;
  parentIdCollisions: number;
  overBudget: { chunks: number; worstExcess: number; pages: string[] };
  underMinTokens: number;
  docSummaryPrefixTokens: number;
  atRiskWithDocSummary: number;
  structure: Record<string, number>;
}

function aggregate(
  pages: PageMetrics[],
  records: ChunkRecord[],
  sectionLengths: number[],
): CorpusReport {
  const perSection = new Map<string, number>();
  for (const record of records) {
    const key = `${record.file} ${record.parentId}`;
    perSection.set(key, (perSection.get(key) ?? 0) + 1);
  }

  const textTokens = records.filter((r) => r.contentKind === 'text').map((r) => r.tokens);
  const tableTokens = records.filter((r) => r.contentKind === 'table_rows').map((r) => r.tokens);
  const prefixTokens = countTokens(DOC_SUMMARY_PREFIX);
  // Аннотация документа приписывается к КАЖДОМУ чанку при INDEX_DOC_SUMMARY=1;
  // 64 токена — грубая, но честно обозначенная оценка её длины.
  const assumedSummaryTokens = prefixTokens + 64;

  return {
    pages: pages.length,
    chunks: records.length,
    sections: sum(pages, (page) => page.sections),
    kinds: {
      text: sum(pages, (page) => page.kinds.text),
      table_rows: sum(pages, (page) => page.kinds.table_rows),
    },
    chunkTokens: distribution(records.map((record) => record.tokens)),
    lexicalTokens: distribution(records.map((record) => record.lexTokens)),
    bm25AvgLen: BM25_AVG_LEN,
    textChunkTokens: distribution(textTokens),
    tableChunkTokens: distribution(tableTokens),
    chunksPerPage: distribution(pages.map((page) => page.chunks)),
    chunksPerSection: distribution([...perSection.values()]),
    sectionChars: distribution(sectionLengths),
    sectionsOverCap: sum(pages, (page) => page.sectionsOverCap),
    chunksInOversizedSections: sum(pages, (page) => page.chunksInOversizedSections),
    parentIdCollisions: sum(pages, (page) => page.parentIdCollisions),
    overBudget: {
      chunks: sum(pages, (page) => page.overBudget),
      worstExcess: Math.max(0, ...pages.map((page) => page.overBudgetExcess)),
      pages: pages.filter((page) => page.overBudget > 0).map((page) => page.path),
    },
    underMinTokens: records.filter((record) => record.tokens < MIN_CHUNK_TOKENS).length,
    docSummaryPrefixTokens: prefixTokens,
    atRiskWithDocSummary: records.filter(
      (record) =>
        record.contentKind === 'text' &&
        record.tokens + assumedSummaryTokens > MAX_CHUNK_TOKENS &&
        record.tokens <= MAX_CHUNK_TOKENS,
    ).length,
    structure: {
      code_blocks: sum(pages, (page) => page.codeBlocks),
      code_blocks_split: sum(pages, (page) => page.codeBlocksSplit),
      code_blocks_lost: sum(pages, (page) => page.codeBlocksLost),
      fences_in_source: sum(pages, (page) => page.fencesInSource),
      fences_in_chunks: sum(pages, (page) => page.fencesInChunks),
      unbalanced_fence_chunks: sum(pages, (page) => page.unbalancedFenceChunks),
      tables_in_source: sum(pages, (page) => page.tablesInSource),
      tables_intact: sum(pages, (page) => page.tablesIntact),
      tables_chunked_by_design: sum(pages, (page) => page.tablesChunkedByDesign),
      tables_split: sum(pages, (page) => page.tablesSplit),
      table_rows_lost: sum(pages, (page) => page.tableRowsLost),
      headerless_table_chunks: sum(pages, (page) => page.headerlessTableChunks),
      list_blocks: sum(pages, (page) => page.listBlocks),
      list_blocks_split: sum(pages, (page) => page.listBlocksSplit),
      list_cut_boundaries: sum(pages, (page) => page.listCutBoundaries),
      linearized_rows: sum(pages, (page) => page.linearizedRows),
      linearized_rows_split: sum(pages, (page) => page.linearizedRowsSplit),
      linearized_rows_over_budget: sum(pages, (page) => page.linearizedRowsOverBudget),
      mid_row_chunks: sum(pages, (page) => page.midRowChunks),
      tiny_chunks: sum(pages, (page) => page.tinyChunks),
      heading_only_chunks: sum(pages, (page) => page.headingOnlyChunks),
    },
  };
}

// ===========================================================================
// Ввод-вывод
// ===========================================================================

/** Файлы вольта в стабильном порядке: отчёт обязан быть побайтово воспроизводимым. */
export function listMarkdown(root: string): string[] {
  const entries = readdirSync(root, { recursive: true, encoding: 'utf8' });
  return entries
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => entry.split(path.sep).join('/'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ===========================================================================
// Человеческая сводка
// ===========================================================================

function printSummary(
  corpus: CorpusReport,
  pages: PageMetrics[],
  clusters: DuplicateCluster[],
  exact: ReturnType<typeof exactDuplicateGroups>,
  duplicateShare: number,
  top: number,
): void {
  const out = (line: string): void => {
    process.stdout.write(line);
  };
  const dist = (d: Distribution): string =>
    `min ${d.min} median ${d.median} p90 ${d.p90} max ${d.max}`;
  const short = (file: string): string => path.basename(file, '.md');

  out('\n=== РАЗМЕРЫ ===\n');
  out(
    `страниц: ${corpus.pages}   чанков: ${corpus.chunks}   разделов: ${corpus.sections}   ` +
      `text/table_rows: ${corpus.kinds.text}/${corpus.kinds.table_rows}\n`,
  );
  out(`токенов в чанке (cl100k):     ${dist(corpus.chunkTokens)}\n`);
  out(`  из них text:                ${dist(corpus.textChunkTokens)}\n`);
  out(`  из них table_rows:          ${dist(corpus.tableChunkTokens)}\n`);
  out(
    `термов tokenize() в чанке:    ${dist(corpus.lexicalTokens)} ` +
      `(среднее ${Math.round(corpus.lexicalTokens.total / Math.max(1, corpus.lexicalTokens.count))} ` +
      `против BM25_AVG_LEN ${corpus.bm25AvgLen})\n`,
  );
  out(`чанков на страницу:           ${dist(corpus.chunksPerPage)}\n`);
  out(`чанков на раздел:             ${dist(corpus.chunksPerSection)}\n`);
  out(
    `сверх бюджета (text>${MAX_CHUNK_TOKENS}, table>${TABLE_MAX_TOKENS}): ` +
      `${corpus.overBudget.chunks}, худший перебор +${corpus.overBudget.worstExcess} токенов, ` +
      `страниц ${corpus.overBudget.pages.length}\n`,
  );
  out(
    `чанков короче MIN_CHUNK_TOKENS (${MIN_CHUNK_TOKENS}): ${corpus.underMinTokens}; ` +
      `выйдут за ${MAX_CHUNK_TOKENS} с аннотацией документа (оценка +64 токена): ` +
      `${corpus.atRiskWithDocSummary}\n`,
  );
  for (const file of corpus.overBudget.pages.slice(0, top)) {
    const page = pages.find((p) => p.path === file) as PageMetrics;
    out(`  +${page.overBudgetExcess} токенов, ${page.overBudget} чанк(ов)  ${short(file)}\n`);
  }

  out('\n=== СТРУКТУРА ===\n');
  const s = corpus.structure;
  out(
    `заборов кода в исходнике: ${s.fences_in_source}, дошло до чанков: ${s.fences_in_chunks}; ` +
      `блоков ${s.code_blocks}, разорвано ${s.code_blocks_split}, потеряно ${s.code_blocks_lost}, ` +
      `чанков с непарным забором ${s.unbalanced_fence_chunks}\n`,
  );
  out(
    `GFM-таблиц: ${s.tables_in_source}, целиком в одном чанке ${s.tables_intact}, ` +
      `штатно порезано по строкам ${s.tables_chunked_by_design}, разорвано ${s.tables_split}, ` +
      `строк потеряно ${s.table_rows_lost}, чанков со строками без шапки ` +
      `${s.headerless_table_chunks}\n`,
  );
  out(
    `списков: ${s.list_blocks}, разорвано ${s.list_blocks_split}, ` +
      `границ, режущих список: ${s.list_cut_boundaries}\n`,
  );
  out(
    `линеаризованных строк: ${s.linearized_rows}, разорвано ${s.linearized_rows_split} ` +
      `(из них не влезают в чанк в одиночку ${s.linearized_rows_over_budget}), ` +
      `чанков, начинающихся с середины строки: ${s.mid_row_chunks}\n`,
  );
  out(
    `чанков-огрызков (<${TINY_BODY_CHARS} символов тела): ${s.tiny_chunks}, ` +
      `из одного заголовка: ${s.heading_only_chunks}\n`,
  );

  const worstStructure = [...pages]
    .filter((page) => page.codeBlocksSplit + page.tablesSplit + page.linearizedRowsSplit > 0)
    .sort(
      (a, b) =>
        b.codeBlocksSplit +
        b.tablesSplit +
        b.linearizedRowsSplit -
        (a.codeBlocksSplit + a.tablesSplit + a.linearizedRowsSplit),
    );
  out(`\n=== ХУДШИЕ ${top} СТРАНИЦ ПО РАЗРЫВАМ ===\n`);
  for (const page of worstStructure.slice(0, top)) {
    out(
      `  код ${page.codeBlocksSplit}  таблиц ${page.tablesSplit}  ` +
        `строк ${page.linearizedRowsSplit}  списков ${page.listBlocksSplit}  ` +
        `чанков ${page.chunks}  ${page.title.slice(0, 58)}\n`,
    );
  }

  out('\n=== РАЗДЕЛЫ ===\n');
  out(
    `разделов длиннее section_max_chars (${SECTION_MAX_CHARS}): ${corpus.sectionsOverCap} ` +
      `из ${corpus.sections}; чанков в них ${corpus.chunksInOversizedSections} ` +
      `(${((100 * corpus.chunksInOversizedSections) / Math.max(1, corpus.chunks)).toFixed(1)}% корпуса)\n`,
  );
  out(`коллизий parentId внутри файла: ${corpus.parentIdCollisions}\n`);
  out(`длина section_text: ${dist(corpus.sectionChars)} символов\n`);

  out('\n=== ДУБЛИКАТЫ МЕЖДУ ФАЙЛАМИ ===\n');
  const inClusters = clusters.reduce((total, cluster) => total + cluster.size, 0);
  out(
    `кластеров почти одинаковых чанков: ${clusters.length}, чанков в них ${inClusters} ` +
      `(${(duplicateShare * 100).toFixed(1)}% корпуса)\n`,
  );
  out(`групп побайтово одинаковых тел: ${exact.length}\n`);
  for (const cluster of clusters.slice(0, top)) {
    out(
      `  ×${cluster.size} чанк(ов) ~${cluster.tokens} токенов, файлов ${cluster.files.length}: ` +
        `${cluster.files.map(short).join(' | ').slice(0, 90)}\n`,
    );
    out(`      ${cluster.excerpt.slice(0, 96)}\n`);
  }

  out('\n=== ВЫБРОСЫ ===\n');
  const largest = [...pages].sort((a, b) => b.bodyChars - a.bodyChars).slice(0, top);
  for (const page of largest) {
    out(
      `  ${page.bodyChars.toString().padStart(7)}ch  чанков ${page.chunks
        .toString()
        .padStart(4)}  (text ${page.kinds.text}/table ${page.kinds.table_rows})  ` +
        `разделов ${page.sections}  max ${page.tokens.max}т  ${page.title.slice(0, 44)}\n`,
    );
  }
  const zero = pages.filter((page) => page.chunks === 0);
  const one = pages.filter((page) => page.chunks === 1);
  out(`страниц с нулём чанков: ${zero.length}, ровно с одним: ${one.length}\n`);
  for (const page of zero.slice(0, top)) {
    out(`  0 чанков, ${page.bodyChars}ch  ${page.title.slice(0, 60)}\n`);
  }
}

// ===========================================================================
// CLI
// ===========================================================================

interface Args {
  vault: string;
  out: string;
  top: number;
  limit: number | null;
  threshold: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    vault: '',
    out: '',
    top: 15,
    limit: null,
    threshold: DUPLICATE_THRESHOLD,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--vault':
        args.vault = value ?? '';
        i += 1;
        break;
      case '--out':
        args.out = value ?? '';
        i += 1;
        break;
      case '--top':
        args.top = Number(value);
        i += 1;
        break;
      case '--limit':
        args.limit = Number(value);
        i += 1;
        break;
      case '--dup-threshold':
        args.threshold = Number(value);
        i += 1;
        break;
      default:
        throw new Error(`неизвестный ключ: ${flag}`);
    }
  }
  if (args.vault === '' || args.out === '') {
    throw new Error('нужны --vault <каталог> и --out <report.json>');
  }
  return args;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const files = listMarkdown(args.vault);
  const selected = args.limit === null ? files : files.slice(0, args.limit);

  const pages: PageMetrics[] = [];
  const records: ChunkRecord[] = [];
  const sectionLengths: number[] = [];
  for (const file of selected) {
    const raw = readFileSync(path.join(args.vault, file), 'utf8');
    const audit = auditPage(file, raw);
    pages.push(audit.metrics);
    records.push(...audit.records);
    sectionLengths.push(...audit.sectionLengths);
  }

  const corpus = aggregate(pages, records, sectionLengths);
  const clusters = nearDuplicateClusters(records, args.threshold);
  const exact = exactDuplicateGroups(records);
  const inClusters = clusters.reduce((total, cluster) => total + cluster.size, 0);
  const duplicateShare = records.length === 0 ? 0 : inClusters / records.length;

  const report = {
    tool: 'cognivault-rag-audit/audit_chunk',
    format_version: 1,
    vault: { root: args.vault, files: files.length, audited: selected.length },
    budget: {
      min_chunk_tokens: MIN_CHUNK_TOKENS,
      max_chunk_tokens: MAX_CHUNK_TOKENS,
      table_max_tokens: TABLE_MAX_TOKENS,
      section_max_chars: SECTION_MAX_CHARS,
      tokenizer: 'cl100k_base (js-tiktoken), как в chunker.countTokens',
    },
    corpus,
    duplicates: {
      threshold: args.threshold,
      clusters: clusters.length,
      chunks_in_clusters: inClusters,
      share_of_corpus: Number(duplicateShare.toFixed(4)),
      exact_body_groups: exact.length,
      top_clusters: clusters.slice(0, args.top),
      top_exact: exact.slice(0, args.top),
    },
    pages: pages.map((page) => ({ ...page, findings: page.findings.slice(0, 50) })),
  };

  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  printSummary(corpus, pages, clusters, exact, duplicateShare, args.top);
  process.stdout.write(`\nотчёт: ${args.out}\n`);
  return 0;
}

// Запуск только как скрипт: под vitest модуль импортируется ради чистых функций.
if (process.argv[1] !== undefined && process.argv[1].endsWith('audit_chunk.ts')) {
  process.exitCode = main(process.argv.slice(2));
}
