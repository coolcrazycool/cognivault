#!/usr/bin/env -S npx tsx
/**
 * Мост к НАСТОЯЩЕЙ нарезке раздела в окно (`src/features/search/service.ts`) и к
 * НАСТОЯЩЕМУ построителю разделов (`src/lib/chunker.ts`) для питоновской части
 * аудита (`audit_window.py`).
 *
 * ЗАЧЕМ мост, а не реализация на Python
 * -------------------------------------
 * `sectionWindow` — это пять взаимодействующих тонкостей на сорок строк: снятие
 * аннотации документа и крошки (`chunkBody`), зондовый фолбэк при промахе
 * (`locateChunk`), кламп `anchorEnd` о конец раздела, случай «чанк не влезает
 * целиком», сдвиг окна у краёв раздела и два снапа, из которых первый двигается
 * ТОЛЬКО вперёд, а второй пересчитывается от нового начала. Питоновская копия
 * разошлась бы с оригиналом на первой же правке — и аудит мерил бы собственную
 * копию, а не то, что доезжает до модели. Тот же довод, по которому разреженную
 * сторону гоняет `sparse_vectors.ts`, а не питоновский токенизатор.
 *
 * Отдельно: даже тривиальное префиксное окно (`slice(0, limit)` — поведение до
 * 2026-го, с которым сравнивается центрирование) считается ЗДЕСЬ. `String.slice`
 * в JS режет по кодовым ЕДИНИЦАМ UTF-16, питоновский срез — по кодовым ТОЧКАМ:
 * на паре суррогатов они разъезжаются, и «контроль» отличался бы от того, что
 * когда-то отдавал прод.
 *
 * ПРО ПРИВАТНОСТЬ. `sectionWindow`, `chunkBody` и `locateChunk` объявлены
 * `private`. В TypeScript это аннотация ВРЕМЕНИ КОМПИЛЯЦИИ — в рантайме это
 * обычные методы прототипа. Каст ниже сделан осознанно и составляет весь смысл
 * моста: замеряется продовая функция, а не её пересказ. Обратная сторона —
 * переименование метода в `src/` уронит мост громко (TypeError), а не тихо
 * разойдётся с ним; это и требуется.
 *
 * Три команды:
 *
 *   sections <vault-dir> <out.jsonl>
 *       Прогоняет `chunkMarkdownWithSections` по вольту ровно так, как это делает
 *       `src/plugins/pipeline.ts` (фронтматтер снимает `gray-matter`, `title` —
 *       имя файла), и выгружает строки, которые прод кладёт в таблицу `sections`:
 *       (path, parent_id, section_path, text). Именно из неё `loadSectionTexts`
 *       достаёт текст раздела на выдаче.
 *
 *   windows <in.json> <out.json>
 *       Батч запросов к `sectionWindow` / префиксному окну. Вход:
 *         {"sections": {"<key>": "<текст раздела>"},
 *          "requests": [{"section": "<key>", "chunk_text": "…",
 *                        "section_path": "…", "limit": 4000,
 *                        "mode": "centred" | "prefix"}]}
 *       Выход: {"results": [{"window", "body", "anchor_text", "located"}]}.
 *       `anchor_text` — реальная подстрока раздела, найденная `locateChunk`
 *       (тело чанка либо зонд): по ней питон сам находит смещение якоря, не
 *       повторяя ни строчки логики поиска и не завися от кодировки смещений.
 *
 *   tokens <in.json> <out.json>
 *       {"texts": […]} → {"tokens": [[…], …]} НАСТОЯЩИМ `tokenize` из
 *       `src/lib/bm25.ts`: стеммер Snowball, стоп-слова, свёртка «ё»→«е». Мера
 *       содержательности эталонного ответа обязана считать термы тем же
 *       токенизатором, которым корпус индексируется, иначе она мерила бы
 *       расхождение двух токенизаторов.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { SearchService } from '../../src/features/search/service.js';
import { tokenize } from '../../src/lib/bm25.js';
import { chunkMarkdownWithSections } from '../../src/lib/chunker.js';

/** Приватные методы `SearchService`, которые мост дёргает напрямую. */
interface WindowInternals {
  sectionWindow(sectionText: string, chunkText: string, sectionPath: string, limit: number): string;
  chunkBody(chunkText: string, sectionPath: string): string;
  locateChunk(sectionText: string, body: string): number;
}

/**
 * Экземпляр `SearchService` без Qdrant, эмбеддера и БД: нарезка окна их не касается,
 * а конструктор только раскладывает аргументы по полям. Каст снимает `private` —
 * см. «ПРО ПРИВАТНОСТЬ» в шапке.
 */
export function windowInternals(): WindowInternals {
  const service = new SearchService(
    undefined as never,
    undefined as never,
    undefined,
  ) as unknown as WindowInternals;
  return service;
}

// --------------------------------------------------------------------------- //
// sections
// --------------------------------------------------------------------------- //

/** Файлы вольта в стабильном порядке — выгрузка обязана быть воспроизводимой. */
export function listMarkdown(root: string): string[] {
  const entries = readdirSync(root, { recursive: true, encoding: 'utf8' });
  return entries
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => entry.split(path.sep).join('/'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface SectionRow {
  path: string;
  parent_id: string;
  section_path: string;
  text: string;
  chars: number;
}

/** Разделы одной заметки — тем же вызовом и с теми же опциями, что и `pipeline.ts`. */
export function sectionsOf(relPath: string, raw: string): SectionRow[] {
  const title = path.basename(relPath, '.md');
  let body: string;
  try {
    body = matter(raw).content;
  } catch {
    body = raw;
  }
  const { sections } = chunkMarkdownWithSections(body, { title, path: relPath });
  return sections.map((section) => ({
    path: relPath,
    parent_id: section.parentId,
    section_path: section.sectionPath,
    text: section.text,
    chars: section.text.length,
  }));
}

function dumpSections(vault: string, outPath: string): number {
  const lines: string[] = [];
  let files = 0;
  for (const rel of listMarkdown(vault)) {
    const raw = readFileSync(path.join(vault, rel), 'utf8');
    files += 1;
    for (const row of sectionsOf(rel, raw)) {
      lines.push(JSON.stringify(row));
    }
  }
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  process.stderr.write(`sections: ${lines.length} из ${files} файлов -> ${outPath}\n`);
  return 0;
}

// --------------------------------------------------------------------------- //
// windows
// --------------------------------------------------------------------------- //

export type WindowMode = 'centred' | 'prefix';

export interface WindowRequest {
  section: string;
  chunk_text: string;
  section_path: string;
  limit: number;
  mode: WindowMode;
}

export interface WindowResult {
  window: string;
  body: string;
  anchor_text: string;
  located: boolean;
}

/**
 * Окно на один запрос.
 *
 * `centred` — продовый `sectionWindow` как есть. `prefix` — поведение до 2026-го,
 * то самое `slice(0, limit)`, которое центрирование заменило; сравнение с ним и есть
 * проверка, что замена вообще что-то дала.
 *
 * `body`/`anchor_text` считаются всегда и от режима не зависят: это диагностика
 * (нашёлся ли чанк в своём разделе и где именно), нужная обоим режимам одинаково.
 */
export function windowFor(
  internals: WindowInternals,
  sectionText: string,
  request: WindowRequest,
): WindowResult {
  const body = internals.chunkBody(request.chunk_text, request.section_path);
  const anchor = internals.locateChunk(sectionText, body);
  const anchorText =
    anchor === -1
      ? ''
      : sectionText.slice(anchor, Math.min(anchor + body.length, sectionText.length));
  const window =
    request.mode === 'prefix'
      ? sectionText.length <= request.limit
        ? sectionText
        : sectionText.slice(0, request.limit)
      : internals.sectionWindow(
          sectionText,
          request.chunk_text,
          request.section_path,
          request.limit,
        );
  return { window, body, anchor_text: anchorText, located: anchor !== -1 };
}

interface WindowInput {
  sections?: Record<string, string>;
  requests?: WindowRequest[];
}

function runWindows(inPath: string, outPath: string): number {
  const input = JSON.parse(readFileSync(inPath, 'utf8')) as WindowInput;
  const sections = input.sections ?? {};
  const requests = input.requests ?? [];
  const internals = windowInternals();
  const results: WindowResult[] = [];
  for (const request of requests) {
    const sectionText = sections[request.section];
    if (sectionText === undefined) {
      process.stderr.write(`нет текста раздела ${JSON.stringify(request.section)}\n`);
      return 2;
    }
    if (request.mode !== 'centred' && request.mode !== 'prefix') {
      process.stderr.write(`режим ${JSON.stringify(request.mode)} не из ('centred', 'prefix')\n`);
      return 2;
    }
    results.push(windowFor(internals, sectionText, request));
  }
  writeFileSync(outPath, JSON.stringify({ results }), 'utf8');
  return 0;
}

// --------------------------------------------------------------------------- //
// tokens
// --------------------------------------------------------------------------- //

function runTokens(inPath: string, outPath: string): number {
  const input = JSON.parse(readFileSync(inPath, 'utf8')) as { texts?: string[] };
  if (!Array.isArray(input.texts)) {
    process.stderr.write('во входном JSON нет массива texts\n');
    return 2;
  }
  writeFileSync(
    outPath,
    JSON.stringify({ tokens: input.texts.map((text) => tokenize(text)) }),
    'utf8',
  );
  return 0;
}

// --------------------------------------------------------------------------- //

function main(argv: string[]): number {
  const [command, first, second] = argv;
  if (command === 'sections' && first !== undefined && second !== undefined) {
    return dumpSections(first, second);
  }
  if (command === 'windows' && first !== undefined && second !== undefined) {
    return runWindows(first, second);
  }
  if (command === 'tokens' && first !== undefined && second !== undefined) {
    return runTokens(first, second);
  }
  process.stderr.write(
    'использование: section_windows.ts sections <vault> <out.jsonl>\n' +
      '               section_windows.ts windows  <in.json> <out.json>\n' +
      '               section_windows.ts tokens   <in.json> <out.json>\n',
  );
  return 2;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('section_windows.ts')) {
  process.exitCode = main(process.argv.slice(2));
}
