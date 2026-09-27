/** Построчное сравнение печати приложения (срез 1б §9.1 п. 2, «Сравнить» у оболочки хоста). */
import { expect, test } from 'vitest';
import { lineDiff } from './line-diff';

test('общие строки — на месте, убранная — «removed», добавленная — «added», порядок печати', () => {
  expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual([
    { kind: 'same', text: 'a' },
    { kind: 'removed', text: 'b' },
    { kind: 'same', text: 'c' },
    { kind: 'added', text: 'd' },
  ]);
});

test('перестановка раздела видна: одна строка уходит и приходит в другом месте', () => {
  const kinds = lineDiff('x\ny\nz', 'y\nx\nz').map((l) => `${l.kind}:${l.text}`);
  expect(kinds.filter((k) => k.startsWith('same'))).toEqual(['same:y', 'same:z']);
  expect(kinds).toContain('removed:x');
  expect(kinds).toContain('added:x');
});
