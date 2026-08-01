/**
 * Тесты моста к нарезке окна.
 *
 * Проверяется НЕ поведение `sectionWindow` — оно продовое и живёт со своими
 * тестами в `src/`, — а то, что мост действительно до него дотягивается и не
 * подменяет его собственной логикой. Приватные методы снимаются кастом, и
 * переименование любого из них должно ронять мост здесь, а не тихо портить
 * отчёт: этим тестом и ловится.
 */

import { describe, expect, it } from 'vitest';
import { sectionsOf, windowFor, windowInternals } from './section_windows.js';

const internals = windowInternals();

/** Раздел, гарантированно длиннее любого лимита ниже. */
function longSection(head: string, marker: string, tail: string): string {
  const filler = (n: number, seed: string) =>
    Array.from({ length: n }, (_, i) => `${seed} строка ${i} наполнителя раздела`).join('\n');
  return [head, filler(120, 'до'), marker, filler(120, 'после'), tail].join('\n\n');
}

describe('windowFor', () => {
  it('центрирует окно на чанке, а префикс — нет', () => {
    const marker = 'уникальный маркер тела чанка живёт глубоко в середине раздела';
    const section = longSection('Раздел', marker, 'хвост');
    const request = {
      section: 's',
      chunk_text: `Раздел\n\n${marker}`,
      section_path: 'Раздел',
      limit: 1000,
      mode: 'centred' as const,
    };
    const centred = windowFor(internals, section, request);
    const prefix = windowFor(internals, section, { ...request, mode: 'prefix' as const });

    expect(section.length).toBeGreaterThan(1000);
    expect(centred.located).toBe(true);
    expect(centred.window).toContain(marker);
    expect(prefix.window).not.toContain(marker);
    expect(prefix.window).toBe(section.slice(0, 1000));
  });

  it('снимает крошку раздела с тела чанка', () => {
    const body = 'тело без крошки';
    const result = windowFor(internals, `Раздел\n\n${body}`, {
      section: 's',
      chunk_text: `Раздел\n\n${body}`,
      section_path: 'Раздел',
      limit: 10_000,
      mode: 'centred',
    });
    expect(result.body).toBe(body);
    expect(result.anchor_text).toBe(body);
  });

  it('отдаёт раздел целиком, когда он короче лимита', () => {
    const section = 'Раздел\n\nкороткое тело';
    const result = windowFor(internals, section, {
      section: 's',
      chunk_text: section,
      section_path: 'Раздел',
      limit: 4000,
      mode: 'centred',
    });
    expect(result.window).toBe(section);
  });

  it('сообщает о ненайденном якоре, а не притворяется, что нашёл', () => {
    // Дрейф индекса: заметку переписали после того, как точка попала в Qdrant, и тела
    // чанка в разделе больше нет ни целиком, ни головой. Мост обязан показать это
    // флагом, иначе тихий фолбэк в префикс не измерить.
    // (Раньше здесь стоял табличный чанк с крошкой `${sectionPath} > Таблица` — он
    // не находился из-за БАГА в `chunkBody`, а не потому, что его в разделе нет.)
    const marker = 'строки таблицы, которые ищутся в разделе';
    const section = longSection('Раздел', marker, 'хвост');
    const result = windowFor(internals, section, {
      section: 's',
      chunk_text: 'Раздел\n\nэтого текста в разделе больше нет ни целиком, ни головой',
      section_path: 'Раздел',
      limit: 1000,
      mode: 'centred',
    });
    expect(result.located).toBe(false);
    expect(result.anchor_text).toBe('');
    expect(result.window).toBe(section.slice(0, 1000));
  });
});

describe('sectionsOf', () => {
  it('выгружает разделы так же, как их пишет pipeline: (path, parentId, text)', () => {
    const rows = sectionsOf('заметка.md', '# Заголовок\n\nтело\n\n## Подраздел\n\nещё тело\n');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.path).toBe('заметка.md');
      expect(row.parent_id).not.toBe('');
      expect(row.chars).toBe(row.text.length);
      // Текст раздела отформатирован как чанк: крошка, пустая строка, тело.
      expect(row.text.startsWith(`${row.section_path}\n\n`)).toBe(true);
    }
  });

  it('снимает фронтматтер, как это делает индексатор', () => {
    const rows = sectionsOf('n.md', '---\ntags: [a]\n---\n\n# Заголовок\n\nтело\n');
    expect(rows.some((row) => row.text.includes('tags'))).toBe(false);
    expect(rows.some((row) => row.text.includes('тело'))).toBe(true);
  });
});
