// apps/server/src/executor/legacy-form.test.ts
// Проекции старой формы (РП-2). Живёт ровно столько же, сколько сам модуль, — до задачи
// «Пересев мира».
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { RELATION_ROLE_IDS } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, seedCustomAspect, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import type { RegistrySnapshot } from '../registry/load';
import { loadRegistry } from '../registry/load';
import { projectLegacyAspects, projectLegacyRelationType, rowFromLegacy } from './legacy-form';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
let reg: RegistrySnapshot;

beforeAll(async () => {
  await truncateAll();
  // Кастомный аспект нужен ровно одному тесту — «свойство без носителя в старой карте».
  await seedCustomAspect(owner, {
    key: 'user/sleep-log',
    label: { ru: 'Сон', en: 'Sleep' },
    properties: [{ key: 'hours', type: { kind: 'number' }, required: true }],
  });
  reg = await withIdentity(db, owner, (tx) => loadRegistry(tx, owner));
});

afterAll(async () => {
  await truncateAll();
  await client.end();
});

/**
 * Нормативная таблица §А4-3 → сегодняшняя колонка `relation_type`, переписанная из находки 18
 * ревью плана РУКАМИ, а не выведенная из реализации: тест обязан ловить правку карты в коде.
 */
const EXPECTED_RELATION_TYPE: Record<string, string> = {
  subitem: 'parent',
  ticket: 'parent',
  run: 'parent',
  'envelope-binding': 'parent',
  'category-parent': 'parent',
  dependency: 'blocks',
  mention: 'related_to',
  'alternative-of': 'related_to',
  supersedes: 'related_to',
  'instance-of': 'derived_from',
  ref: 'ref',
};

test('projectLegacyRelationType тотальна на RELATION_ROLE_IDS (11)', () => {
  // Список ролей и таблица ожиданий сверяются между собой: новая роль без строки в таблице
  // обязана валить тест, а не молча получать проекцию по умолчанию.
  expect(Object.keys(EXPECTED_RELATION_TYPE).sort()).toEqual([...RELATION_ROLE_IDS].sort());
  expect(RELATION_ROLE_IDS.length).toBe(11);
  for (const role of RELATION_ROLE_IDS) {
    expect<string>(projectLegacyRelationType(role)).toBe(EXPECTED_RELATION_TYPE[role] as string);
  }
});

test('projectLegacyRelationType на неизвестной роли — отказ, а не молчаливый parent', () => {
  expect(() => projectLegacyRelationType('user/выдуманная')).toThrow(/user\/выдуманная/);
});

test('rowFromLegacy(financial+budget одной категории) → props по id, aspects[] и карта, равная входу', () => {
  const category = 'cat-food';
  const legacy = {
    'orbis/financial': {
      amount: '100.00',
      currency: 'RUB',
      direction: 'expense',
      category_ref: category,
      occurred_on: '2026-07-03',
    },
    'orbis/budget': {
      category_ref: category,
      limit: '5000.00',
      currency: 'RUB',
      period_start: '2026-07-01',
      period_end: '2026-07-31',
    },
  };

  const row = rowFromLegacy(reg, legacy);

  // Одиннадцать полей — восемь свойств: `orbis/finance_category` и `orbis/currency` слиты
  // (§А8/В1), и это ровно тот случай, ради которого карта переводится по id, а не по имени.
  expect(row.props).toEqual({
    'orbis/amount': '100.00',
    'orbis/currency': 'RUB',
    'orbis/direction': 'expense',
    'orbis/finance_category': category,
    'orbis/occurred_on': '2026-07-03',
    'orbis/limit': '5000.00',
    'orbis/period_start': '2026-07-01',
    'orbis/period_end': '2026-07-31',
  });
  expect(row.aspects).toEqual(['orbis/financial', 'orbis/budget']);
  expect(row.aspectsLegacy).toEqual(legacy);
});

test('rowFromLegacy пишет ТРИ колонки: ни одна не пропущена', () => {
  const row = rowFromLegacy(reg, { 'orbis/task': { status: 'todo' } });
  expect(Object.keys(row).sort()).toEqual(['aspects', 'aspectsLegacy', 'props']);
  expect(row.props).toEqual({ 'orbis/task_status': 'todo' });
  expect(row.aspects).toEqual(['orbis/task']);
  expect(row.aspectsLegacy).toEqual({ 'orbis/task': { status: 'todo' } });
});

test('rowFromLegacy: аспект без полей остаётся ключом карты', () => {
  const row = rowFromLegacy(reg, { 'orbis/note': {} });
  expect(row.props).toEqual({});
  expect(row.aspects).toEqual(['orbis/note']);
  expect(row.aspectsLegacy).toEqual({ 'orbis/note': {} });
});

test('rowFromLegacy: слитое свойство с разными значениями — отказ (В1), а не «последний выиграл»', () => {
  expect(() =>
    rowFromLegacy(reg, {
      'orbis/financial': { category_ref: 'cat-food' },
      'orbis/budget': { category_ref: 'cat-fun' },
    }),
  ).toThrow(/orbis\/finance_category/);
});

test('rowFromLegacy: поле, которое реформа переписала внутри, не выдаёт себя за круговой перевод', () => {
  // `progress_source.query` меняет ФОРМУ (строка → Q-AST, §А5-2), поэтому обратной дороги
  // у него нет. Фикстура, которая на такое поле опирается, обязана получить отказ, а не
  // тихо разъехавшуюся колонку: в срезе А истина фикстуры — старая карта.
  expect(() =>
    rowFromLegacy(reg, {
      'orbis/goal': { progress_source: { query: 'aspect=orbis/task', aggregate: 'count' } },
    }),
  ).toThrow(/orbis\/goal/);
});

test('projectLegacyAspects: свойство без носителя в старой карте в неё не попадает', () => {
  // Кастомный аспект владельца: у `user/hours` нет строки в переходной таблице §А8, и
  // придумывать ей имя поля нельзя — старая карта такого поля никогда не знала.
  const map = projectLegacyAspects(reg, {
    props: { 'user/hours': 7, 'orbis/task_status': 'todo' },
    aspects: ['user/sleep-log', 'orbis/task'],
  });
  expect(map).toEqual({ 'user/sleep-log': {}, 'orbis/task': { status: 'todo' } });
});

test('projectLegacyAspects: свойство, не объявленное ни одним из аспектов сущности, не течёт в карту', () => {
  const map = projectLegacyAspects(reg, {
    props: { 'orbis/task_status': 'todo', 'orbis/amount': '10.00' },
    aspects: ['orbis/task'],
  });
  expect(map).toEqual({ 'orbis/task': { status: 'todo' } });
});
