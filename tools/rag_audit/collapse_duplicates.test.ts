/**
 * Тесты моста к `SearchService.collapseCrossFileDuplicates`.
 *
 * Мост обязан отдавать РЕШЕНИЕ продовой стадии и ничего не решать сам: здесь
 * проверяется контракт (номера документов туда-обратно, порядок выдачи = ранг,
 * ошибка на неизвестном номере) и то, что через мост видны все свойства
 * оригинала, которые ломала бы переписанная копия. Сама логика схлопывания —
 * прод, её тесты живут в `src/features/search/__tests__/`.
 */

import { describe, expect, it } from 'vitest';
import { DOC_SUMMARY_PREFIX } from '../../src/lib/chunker.js';
import { Collapser } from './collapse_duplicates.js';
import type { CorpusDoc } from './collapse_duplicates.js';

/** Тело из `count` различных слов — выше/ниже `NEAR_DUPLICATE_MIN_TERMS` = 20. */
function body(count: number, prefix = 'слово'): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ');
}

function load(docs: CorpusDoc[]): Collapser {
  const collapser = new Collapser();
  collapser.load(docs);
  return collapser;
}

describe('Collapser', () => {
  it('возвращает номера документов, а не тексты, и в порядке выдачи', () => {
    const collapser = load([
      { path: 'a.md', text: body(30, 'альфа') },
      { path: 'b.md', text: body(30, 'бета') },
      { path: 'c.md', text: body(30, 'гамма') },
    ]);
    expect(collapser.collapse('вопрос', [2, 0, 1])).toEqual([2, 0, 1]);
  });

  it('схлопывает копию одного тела между РАЗНЫМИ файлами', () => {
    const text = body(40);
    const collapser = load([
      { path: 'a.md', text },
      { path: 'b.md', text },
    ]);
    expect(collapser.collapse('вопрос', [0, 1])).toEqual([0]);
  });

  it('НЕ трогает два чанка одного файла, как бы они ни совпадали', () => {
    const text = body(40);
    const collapser = load([
      { path: 'a.md', text },
      { path: 'a.md', text },
    ]);
    expect(collapser.collapse('вопрос', [0, 1])).toEqual([0, 1]);
  });

  it('щадит короткие тела: пол по числу различных слов', () => {
    const text = body(10);
    const collapser = load([
      { path: 'a.md', text },
      { path: 'b.md', text },
    ]);
    expect(collapser.collapse('вопрос', [0, 1])).toEqual([0, 1]);
  });

  it('щадит копию, несущую слово ЗАПРОСА, которого нет у выжившего', () => {
    const shared = body(40);
    const collapser = load([
      { path: 'a.md', text: `${shared} дбо` },
      { path: 'b.md', text: `${shared} юрлиц` },
    ]);
    // Без слова запроса вторая страница — дубликат первой…
    expect(collapser.collapse('как устроена витрина', [0, 1])).toEqual([0]);
    // …а с ним она отвечает на СВОЙ вопрос и остаётся.
    expect(collapser.collapse('витрина канала юрлиц', [0, 1])).toEqual([0, 1]);
  });

  it('снимает аннотацию документа перед сбором термов, но не крошку', () => {
    // Аннотация — префикс на КАЖДОМ чанке своего файла: если её не снять, два
    // разных тела с одинаковой аннотацией начинают выглядеть похожими, а порог
    // означает разное при INDEX_DOC_SUMMARY on и off.
    const anno = (text: string) => `${DOC_SUMMARY_PREFIX}${body(60, 'анно')}\n\n${text}`;
    const collapser = load([
      { path: 'a.md', text: anno(body(20, 'альфа')) },
      { path: 'b.md', text: anno(body(20, 'бета')) },
    ]);
    expect(collapser.collapse('вопрос', [0, 1])).toEqual([0, 1]);
  });

  it('падает громко на номере, которого в корпусе нет', () => {
    const collapser = load([{ path: 'a.md', text: body(30) }]);
    expect(() => collapser.collapse('вопрос', [5])).toThrow(/нет в загруженном корпусе/);
  });
});
