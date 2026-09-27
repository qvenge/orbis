/**
 * Осиротевшие расширения (срез 1б §8.6, Р-9; С1б-11): что диалоги «Выключить приложение» и «Удалить
 * приложение» отмечают по умолчанию.
 */
import { APP_EXTENSIONS } from '@orbis/shared';
import { expect, test } from 'vitest';
import { type AppComposition, compositionOf, orphanExtensions } from './orphans';

const app = (
  id: string,
  extensions: AppComposition['extensions'],
  over: Partial<AppComposition> = {},
): AppComposition => ({ id, disabled: false, archived: false, extensions, ...over });

test('(б) у A «Цели» и «Проекты», у включённого B — «Проекты», у выключенного C — «Цели» → сирота «Цели»', () => {
  const a = app('A', ['goals', 'projects']);
  const b = app('B', ['projects']);
  const c = app('C', ['goals'], { disabled: true });
  expect(orphanExtensions(a, [a, b, c], [])).toEqual(['goals']);
});

test('архивное приложение расширение не держит; выключенное маской — не сирота (выключать нечего)', () => {
  const a = app('A', ['goals', 'projects', 'dev']);
  const gone = app('G', ['goals'], { archived: true });
  expect(orphanExtensions(a, [a, gone], ['dev'])).toEqual(['goals', 'projects']);
});

test('«Состав» — только переключаемые расширения, без повторов, в порядке записи', () => {
  expect(compositionOf({ [APP_EXTENSIONS]: ['projects', 'nope', 'goals', 'projects', 7] })).toEqual(
    ['projects', 'goals'],
  );
  expect(compositionOf({})).toEqual([]);
});
