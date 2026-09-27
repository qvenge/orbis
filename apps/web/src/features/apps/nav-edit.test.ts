/**
 * Правила правки навигации (срез 1б §4.4, §9.3, §9.5; С1б-8, С1б-11 web): без дублей и с порядком,
 * архивные вычищаются, «Новое приложение» — одна операция `entity_create`.
 */
import { APP_ASPECT, APP_HOME, APP_NAV, APP_NAV_FORM, HOME_PROPERTY } from '@orbis/shared';
import { expect, test } from 'vitest';
import {
  cleanNav,
  goneOf,
  inNav,
  navOf,
  newAppOps,
  refIdsKey,
  withoutSection,
  withSection,
} from './nav-edit';

const A = '00000000-0000-4000-8000-00000000a001';
const B = '00000000-0000-4000-8000-00000000a002';
const C = '00000000-0000-4000-8000-00000000a003';
const PAGE = '00000000-0000-4000-8000-00000000a004';

test('(а) withSection не дублирует и сохраняет порядок; новый раздел — в конец', () => {
  const nav = [A, B, C];
  // Уже стоит — тот же список, не копия: «поставить» ничего не меняет.
  expect(withSection(nav, B)).toBe(nav);
  expect(withSection(nav, B)).toEqual([A, B, C]);
  expect(withSection([A, B], C)).toEqual([A, B, C]);
  expect(withSection([], A)).toEqual([A]);
  // Одно определение «уже в навигации» на меню и диалог.
  expect(inNav(nav, A)).toBe(true);
  expect(inNav(nav, PAGE)).toBe(false);
});

test('(а) withoutSection убирает один раздел, прочие — в прежнем порядке', () => {
  expect(withoutSection([A, B, C], B)).toEqual([A, C]);
  expect(withoutSection([A, C], B)).toEqual([A, C]);
});

test('(а) cleanNav вычищает архивные; goneOf — архивные и неизвестные ответу, без ответа — null', () => {
  expect(cleanNav([A, B, C], new Set([B]))).toEqual([A, C]);
  expect(cleanNav([A, B, C], new Set())).toEqual([A, B, C]);
  const resolved = [
    { id: A, archived: false },
    { id: B, archived: true },
  ];
  // C ответ не знает (удалена, чужая) — сервер отверг бы и её.
  expect([...(goneOf([A, B, C], resolved) ?? [])].sort()).toEqual([B, C]);
  expect(goneOf([A, B], undefined)).toBeNull();
  expect(goneOf([], undefined)).toEqual(new Set());
});

test('(а) navOf и ключ resolveRefs: не список — пусто; ключ без порядка и повторов', () => {
  expect(navOf({ [APP_NAV]: [A, 1, B] })).toEqual([A, B]);
  expect(navOf({ [APP_NAV]: 'x' })).toEqual([]);
  expect(navOf({})).toEqual([]);
  expect(refIdsKey([C, A, C, B])).toEqual([A, B, C]);
});

test('(а) newAppOps — одна entity_create: клиентский id, аспект «приложение», домашняя, навигация, форма', () => {
  const ops = newAppOps({
    title: ' Мой дом ',
    emoji: '🏡',
    homeId: PAGE,
    navIds: [PAGE],
    form: 'header-list',
  });
  expect(ops).toHaveLength(1);
  const [op] = ops;
  expect(op?.tool).toBe('entity_create');
  const input = op?.input as { id: string } & Record<string, unknown>;
  expect(input.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(input).toEqual({
    id: input.id,
    title: 'Мой дом',
    emoji: '🏡',
    tags: [],
    aspects: [APP_ASPECT],
    props: { [APP_HOME]: PAGE, [APP_NAV]: [PAGE], [APP_NAV_FORM]: 'header-list' },
  });
  // «Дом» странице клиент не пишет — его ставит сервер (§4.3, задача 10).
  expect(JSON.stringify(ops)).not.toContain(HOME_PROPERTY);
});

test('(а) newAppOps без домашней и иконки: навигация — пустым списком, эмодзи нет', () => {
  const [op] = newAppOps({ title: 'Пусто', emoji: '  ', navIds: [], form: 'header-list', id: A });
  expect(op).toEqual({
    tool: 'entity_create',
    input: {
      id: A,
      title: 'Пусто',
      tags: [],
      aspects: [APP_ASPECT],
      props: { [APP_NAV]: [], [APP_NAV_FORM]: 'header-list' },
    },
  });
});
