/**
 * Смена режима показа в форме блока (`withDisplay`) вместе с парными ключами проекции: группировка по
 * дням (спека 1в §5.2) живёт только у строк — `list` и `compact` (и без `display`, это `compact`); с
 * `table` и `tile` разбор её отвергает (`groupNeedsRows`), и оставленная группа заблокировала бы
 * сохранение отказом, которого человек не делал.
 */
import type { QueryAst } from '@orbis/shared/query';
import { expect, test } from 'vitest';
import { withDisplay } from './model';

const grouped: QueryAst = {
  filter: null,
  group: { by: 'day', field: { contract: 'orbis/when' } },
  display: 'list',
};

test('table и tile снимают group', () => {
  expect(withDisplay(grouped, 'table').group).toBeUndefined();
  expect(withDisplay(grouped, 'tile').group).toBeUndefined();
  expect(withDisplay(grouped, 'tile').aggregate).toEqual({ fn: 'count' });
});

test('list, compact и «без display» group сохраняют', () => {
  expect(withDisplay(grouped, 'compact').group).toEqual(grouped.group);
  expect(withDisplay(grouped, undefined).group).toEqual(grouped.group);
  expect(withDisplay({ ...grouped, display: 'compact' }, 'list').group).toEqual(grouped.group);
});
