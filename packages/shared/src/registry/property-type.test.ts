// Словарь типов свойств (§А2-2) и схемы деклараций реестров (§А2-1, §А3-1, §А4-2).
// Проверяется ровно то, что в этих решениях названо ЗАКРЫТЫМ или ОБЯЗАТЕЛЬНЫМ: состав
// словаря kind, строгость форм и паспорт RE2 у паттернов (без него сгенерированная схема
// не компилируется у внешнего потребителя — причина `strict:false` D29, §А2-2).
import { expect, test } from 'bun:test';
import { financialAspectSchema } from '../schemas/aspects';
import { BUILTIN_PROPERTY_META } from './builtin-properties';
import {
  aspectDefinitionSchema,
  assertPatternRegular,
  PATTERN_NOT_REGULAR,
  propertyDefinitionSchema,
  relationRoleDefinitionSchema,
} from './property-type';
import { PROPERTY_KINDS, type PropertyKind, propertyTypeSchema } from './types';

/** Минимальный валидный конфиг каждого kind: ветка союза есть — конфиг разбирается. */
const MINIMAL: Record<PropertyKind, unknown> = {
  text: { kind: 'text' },
  number: { kind: 'number' },
  decimal: { kind: 'decimal' },
  boolean: { kind: 'boolean' },
  date: { kind: 'date' },
  timestamp: { kind: 'timestamp' },
  time: { kind: 'time' },
  select: { kind: 'select', options: [{ key: 'a', label: { ru: 'А', en: 'A' }, rank: 0 }] },
  ref: { kind: 'ref' },
  json: { kind: 'json' },
  grant: { kind: 'grant' },
  registry_ref: { kind: 'registry_ref', target: 'contract' },
};

const label = { ru: 'Подпись', en: 'Label' };
const description = { ru: 'Смысл', en: 'Meaning' };

test('словарь закрыт: неизвестный kind отвергается; известных ровно 12', () => {
  expect(PROPERTY_KINDS.length).toBe(12);
  expect(new Set(PROPERTY_KINDS).size).toBe(12);
  // Состав — дословно §А2-2 (10 базовых + `time` и `registry_ref` из добавок В8).
  expect([...PROPERTY_KINDS]).toEqual([
    'text',
    'number',
    'decimal',
    'boolean',
    'date',
    'timestamp',
    'time',
    'select',
    'ref',
    'json',
    'grant',
    'registry_ref',
  ]);
  // У каждого объявленного kind есть ветка союза, и наоборот — чужих веток нет.
  for (const kind of PROPERTY_KINDS) {
    expect(propertyTypeSchema.safeParse(MINIMAL[kind]).success).toBe(true);
  }
  // Имена, которые пробой П1 носил, а §А8 переименовала (Ф-13): в словарь не входят.
  expect(propertyTypeSchema.safeParse({ kind: 'integer' }).success).toBe(false);
  expect(propertyTypeSchema.safeParse({ kind: 'uuid' }).success).toBe(false);
  expect(propertyTypeSchema.safeParse({ kind: 'entity_ref' }).success).toBe(false);
  // Конфиг чужого kind не проезжает молча: каждая ветка .strict().
  expect(propertyTypeSchema.safeParse({ kind: 'boolean', maxLength: 5 }).success).toBe(false);
  expect(propertyTypeSchema.safeParse({ kind: 'date', pattern: '^a$' }).success).toBe(false);
  // select без вариантов бессмыслен, ключ варианта — ASCII-слаг (§А2-2, Р3).
  expect(propertyTypeSchema.safeParse({ kind: 'select', options: [] }).success).toBe(false);
  expect(
    propertyTypeSchema.safeParse({
      kind: 'select',
      options: [{ key: 'Расход', label, rank: 0 }],
    }).success,
  ).toBe(false);
  // registry_ref без цели — не запись реестра, а неизвестно что.
  expect(propertyTypeSchema.safeParse({ kind: 'registry_ref' }).success).toBe(false);
  expect(propertyTypeSchema.safeParse({ kind: 'registry_ref', target: 'entity' }).success).toBe(
    false,
  );
});

test('decimal: exclusiveMin вместо lookahead; assertPatternRegular отвергает (?= и \\1', () => {
  // Сегодняшняя форма «строго > 0» — паттерн с negative lookahead (aspects.ts:27-29):
  // именно он лежит вне RE2 и вынудил `strict:false` D29.
  const checks = financialAspectSchema.shape.amount._def.checks;
  const regexCheck = checks.find(
    (c): c is Extract<(typeof checks)[number], { kind: 'regex' }> => c.kind === 'regex',
  );
  expect(regexCheck).toBeDefined();
  expect(regexCheck?.regex.source).toContain('(?!');

  // Новая форма — граница ТИПА, а не паттерн (§А8, строки amount/target_value).
  const byId = new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p]));
  expect(byId.get('orbis/amount')?.type).toEqual({ kind: 'decimal', exclusiveMin: '0' });
  expect(byId.get('orbis/target_value')?.type).toEqual({ kind: 'decimal', exclusiveMin: '0' });
  expect(byId.get('orbis/limit')?.type).toEqual({ kind: 'decimal', min: '0' });
  expect(byId.get('orbis/current_value')?.type).toEqual({ kind: 'decimal', min: '0' });
  // Границы decimal — СТРОКИ: число IEEE-754 потеряло бы хвост копеек.
  expect(propertyTypeSchema.safeParse({ kind: 'decimal', exclusiveMin: 0 }).success).toBe(false);

  // Ни один паттерн реестра не выходит за класс RE2.
  for (const p of BUILTIN_PROPERTY_META) {
    if (p.type.kind !== 'text') continue;
    const { pattern } = p.type;
    if (pattern === undefined) continue;
    expect(() => assertPatternRegular(pattern)).not.toThrow();
  }

  for (const bad of ['^(?=x)a$', '^(?!0+$)\\d+$', '^(?<=x)a$', '^(?<!x)a$', '^(a)\\1$']) {
    expect(() => assertPatternRegular(bad)).toThrow();
    let code: unknown;
    try {
      assertPatternRegular(bad);
    } catch (e) {
      code = (e as { code?: unknown }).code;
    }
    expect(code).toBe(PATTERN_NOT_REGULAR);
  }
  // Регулярные конструкции RE2 остаются законными — гейт не должен быть глухим.
  for (const good of ['^[a-z]+$', '^(?:a|b)$', '^(?<year>\\d{4})$', '^manual:\\S+$']) {
    expect(() => assertPatternRegular(good)).not.toThrow();
  }
  expect(PATTERN_NOT_REGULAR).toBe('PATTERN_NOT_REGULAR');
});

test('формы деклараций строги: description обязателен, key — слаг, лишних полей нет', () => {
  const ok = {
    id: 'user/effort',
    ownerId: '00000000-0000-4000-8000-000000000001',
    key: 'user/effort',
    label,
    description,
    type: { kind: 'text' },
    status: 'active',
    rank: 1,
  };
  expect(propertyDefinitionSchema.safeParse(ok).success).toBe(true);
  // Умолчания §А2-1: свойство хранится в `props`, без scope, без слияния, вне модуля.
  const parsed = propertyDefinitionSchema.parse(ok);
  expect(parsed.storage).toBe('props');
  expect(parsed.scope).toBeNull();
  expect(parsed.mergedInto).toBeNull();
  expect(parsed.module).toBeNull();
  expect(parsed.flags).toEqual({});

  // description ОБЯЗАТЕЛЕН (Р4): единственный носитель смысла для AI.
  expect(propertyDefinitionSchema.safeParse({ ...ok, description: undefined }).success).toBe(false);
  expect(propertyDefinitionSchema.safeParse({ ...ok, description: {} }).success).toBe(false);
  expect(propertyDefinitionSchema.safeParse({ ...ok, label: { ru: '' } }).success).toBe(false);
  // key — namespaced ASCII-слаг (§А2-4); голое имя и кириллица отвергаются.
  expect(propertyDefinitionSchema.safeParse({ ...ok, key: 'effort' }).success).toBe(false);
  expect(propertyDefinitionSchema.safeParse({ ...ok, key: 'user/усилие' }).success).toBe(false);
  expect(propertyDefinitionSchema.safeParse({ ...ok, key: 'user/Effort' }).success).toBe(false);
  // Лишнее поле — отказ, а не тихое отбрасывание: сид пишет строку в БД дословно.
  expect(propertyDefinitionSchema.safeParse({ ...ok, aspect: 'orbis/task' }).success).toBe(false);
  expect(propertyDefinitionSchema.safeParse({ ...ok, ownerId: 'не-uuid' }).success).toBe(false);

  const aspect = {
    id: 'user/fitness',
    ownerId: null,
    key: 'user/fitness',
    label,
    description,
    properties: [{ propertyId: 'user/effort', required: false, rank: 1 }],
    aiInstructions: null,
    tagMappings: [],
    viewConfig: { keyFields: ['user/effort'] },
    module: null,
    service: false,
    rank: 1,
  };
  expect(aspectDefinitionSchema.safeParse(aspect).success).toBe(true);
  // §Б2 «implements» в части А пустует, но поле объявлено — умолчание пустой список.
  expect(aspectDefinitionSchema.parse(aspect).implements).toEqual([]);
  expect(aspectDefinitionSchema.safeParse({ ...aspect, service: undefined }).success).toBe(false);
  expect(
    aspectDefinitionSchema.safeParse({ ...aspect, viewConfig: { keyFields: ['x'], color: 'red' } })
      .success,
  ).toBe(false);

  const role = {
    id: 'subitem',
    ownerId: null,
    key: 'subitem',
    label,
    description,
    sourceLabel: label,
    targetLabel: label,
    hierarchical: true,
    module: null,
    rank: 1,
  };
  expect(relationRoleDefinitionSchema.safeParse(role).success).toBe(true);
  const parsedRole = relationRoleDefinitionSchema.parse(role);
  expect(parsedRole.constraints).toEqual({});
  // symmetric — named-future Ч10-С2: поле есть, значение только `false`.
  expect(parsedRole.symmetric).toBe(false);
  expect(relationRoleDefinitionSchema.safeParse({ ...role, symmetric: true }).success).toBe(false);
  expect(
    relationRoleDefinitionSchema.safeParse({ ...role, constraints: { target_max_incoming: 0 } })
      .success,
  ).toBe(false);
  expect(
    relationRoleDefinitionSchema.safeParse({ ...role, constraints: { created_by: 'owner' } })
      .success,
  ).toBe(false);
});
