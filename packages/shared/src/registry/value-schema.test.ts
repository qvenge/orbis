// packages/shared/src/registry/value-schema.test.ts
// Генератор схем значений (§А7-1) и переходная карта «поле старого аспекта → свойство».
// Карта проверяется здесь же, а не отдельным файлом: она умирает Задачей 23 вместе с
// zod-схемами, и второй тест-файл пришлось бы удалять тем же движением.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_IDS } from '../constants';
import { ASPECT_SCHEMAS, legacyAspectJsonSchema } from '../schemas/aspects';
import { BUILTIN_ASPECT_DEFS } from './builtin-aspects';
import { BUILTIN_PROPERTY_META, CORE_PROPERTY_IDS } from './builtin-properties';
import {
  legacyAspectsToProps,
  legacyFieldToProperty,
  propertyToLegacyField,
} from './legacy-field-map';
import { assertPatternRegular } from './property-type';
import type { PropertyType } from './types';
import { propertyValueJsonSchema, X_ORBIS_DECIMAL, X_ORBIS_TYPE } from './value-schema';

const byId = new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p]));
const typeOf = (id: string): PropertyType => {
  const def = byId.get(id);
  if (!def) throw new Error(`нет свойства ${id}`);
  return def.type;
};
const schemaOf = (id: string) => propertyValueJsonSchema(typeOf(id));

describe('propertyValueJsonSchema: словарь типов §А2-2 → JSON Schema значения', () => {
  test('text: голый текст, границы длины, pattern и все четыре format', () => {
    expect(propertyValueJsonSchema({ kind: 'text' })).toEqual({
      type: 'string',
      [X_ORBIS_TYPE]: { kind: 'text' },
    });
    expect(schemaOf('orbis/assignee')).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 200,
    });
    // url → format: 'uri' (ajv-formats), а не свой паттерн: разбор адреса регэкспом —
    // отдельный класс дефектов, и у ajv он уже написан.
    expect(schemaOf('orbis/session_url')).toMatchObject({ type: 'string', format: 'uri' });
    expect(schemaOf('orbis/color')).toMatchObject({ pattern: '^#[0-9a-fA-F]{6}$' });
    expect(schemaOf('orbis/currency')).toMatchObject({
      pattern: '^[A-Z]{3}$',
      minLength: 3,
      maxLength: 3,
    });
    // iana-tz — проверка ФОРМЫ имени зоны: база зон в JSON Schema не живёт.
    const tz = schemaOf('orbis/timezone') as { pattern: string };
    expect(new RegExp(tz.pattern).test('Europe/Moscow')).toBe(true);
    expect(new RegExp(tz.pattern).test('America/Argentina/Buenos_Aires')).toBe(true);
    expect(new RegExp(tz.pattern).test('UTC')).toBe(true);
    expect(new RegExp(tz.pattern).test('Мск')).toBe(false);
    expect(new RegExp(tz.pattern).test('Moscow')).toBe(false);
    // pattern из конфига доезжает как есть (bucket прогона)
    expect(schemaOf('orbis/run_bucket')).toMatchObject({
      pattern: '^(\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d|manual:\\S+)$',
    });
  });

  test('text: pattern конфига И pattern формата не затирают друг друга (allOf)', () => {
    const both = propertyValueJsonSchema({ kind: 'text', format: 'color', pattern: '^#a' }) as {
      allOf: { pattern: string }[];
      pattern?: string;
    };
    expect(both.pattern).toBeUndefined();
    expect(both.allOf.map((p) => p.pattern)).toEqual(['^#a', '^#[0-9a-fA-F]{6}$']);
  });

  test('number: integer/number + границы', () => {
    expect(schemaOf('orbis/duration_min')).toMatchObject({ type: 'integer', minimum: 1 });
    expect(schemaOf('orbis/step_count')).toMatchObject({ type: 'integer', minimum: 0 });
    expect(propertyValueJsonSchema({ kind: 'number', max: 5 })).toMatchObject({
      type: 'number',
      maximum: 5,
    });
  });

  test('decimal: строка с паттерном БЕЗ lookahead, границы — в аннотации x-orbis-decimal', () => {
    const amount = schemaOf('orbis/amount') as Record<string, unknown>;
    expect(amount).toMatchObject({ type: 'string', pattern: '^-?\\d+(\\.\\d+)?$' });
    expect(amount[X_ORBIS_DECIMAL]).toEqual({ exclusiveMin: '0' });
    // Причина всей развилки (В8/D29): границы не могут быть в JSON Schema, потому что
    // числовые ключевые слова к строке не применяются, а lookahead запрещён паспортом P.
    expect(() => assertPatternRegular(amount.pattern as string)).not.toThrow();
    expect(schemaOf('orbis/limit')[X_ORBIS_DECIMAL]).toEqual({ min: '0' });
    expect(schemaOf('orbis/carryover')[X_ORBIS_DECIMAL]).toBeUndefined(); // границ нет — аннотации нет
  });

  test('boolean: default в схему НЕ уезжает (умолчание — семантика чтения, РП-9)', () => {
    expect(schemaOf('orbis/planned')).toEqual({
      type: 'boolean',
      [X_ORBIS_TYPE]: { kind: 'boolean', default: false },
    });
  });

  test('date/timestamp/time: паттерны — те же тексты, что у старых zod-схем', () => {
    const legacyTask = legacyAspectJsonSchema('orbis/task') as {
      properties: { due_date: { pattern: string }; completed_at: { pattern: string } };
    };
    expect(schemaOf('orbis/due_date')).toMatchObject({
      pattern: legacyTask.properties.due_date.pattern,
    });
    expect(schemaOf('orbis/completed_at')).toMatchObject({
      pattern: legacyTask.properties.completed_at.pattern,
    });
    const legacyRoutine = legacyAspectJsonSchema('orbis/routine') as {
      properties: { at: { pattern: string } };
    };
    expect(schemaOf('orbis/routine_at')).toMatchObject({
      pattern: legacyRoutine.properties.at.pattern,
    });
  });

  test('select: enum ключей в порядке rank', () => {
    expect(schemaOf('orbis/task_status')).toMatchObject({
      type: 'string',
      enum: ['inbox', 'planned', 'in_progress', 'waiting', 'done', 'cancelled'],
    });
  });

  test('ref/grant/registry_ref: uuid у ссылок на сущности и гранты, строка у ссылки на реестр', () => {
    expect(schemaOf('orbis/finance_category')).toMatchObject({ type: 'string', format: 'uuid' });
    expect(schemaOf('orbis/grant')).toMatchObject({ type: 'string', format: 'uuid' });
    expect(schemaOf('orbis/rule_scope')).toMatchObject({ type: 'string' });
    expect((schemaOf('orbis/rule_scope') as { format?: string }).format).toBeUndefined();
    // ref many — массив uuid с капом из `max`. `target` ОПУЩЕН, а не `null`: §А6-1 объявляет
    // его необязательным (`target?: Q-AST | Q-AST[]`), и после сужения формы Задачей 8
    // «цели нет» записывается отсутствием ключа, а не вторым способом сказать то же самое.
    expect(propertyValueJsonSchema({ kind: 'ref', cardinality: 'many', max: 3 })).toMatchObject({
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      maxItems: 3,
    });
  });

  test('cardinality many у скаляров: массив с minItems/maxItems, items — схема элемента', () => {
    expect(schemaOf('orbis/aliases')).toMatchObject({
      type: 'array',
      maxItems: 50,
      items: { type: 'string' },
    });
    expect(schemaOf('orbis/routine_days')).toMatchObject({
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] },
    });
    expect(schemaOf('orbis/allowed_tools')).toMatchObject({
      type: 'array',
      maxItems: 50,
      items: { type: 'string', minLength: 1 },
    });
  });

  test('json: без maxItems — схема на ВСЁ значение; с maxItems — массив, схема на ЭЛЕМЕНТ', () => {
    const recurrence = schemaOf('orbis/recurrence') as { type: string; required: string[] };
    expect(recurrence.type).toBe('object');
    expect(recurrence.required).toEqual(['freq', 'interval']);
    const steps = schemaOf('orbis/run_steps') as {
      type: string;
      maxItems: number;
      items: { required: string[] };
    };
    expect(steps.type).toBe('array');
    expect(steps.maxItems).toBe(500);
    expect(steps.items.required).toEqual(['seq', 'at', 'summary', 'external']);
    // json без schema — любой объект (кастомные свойства 1b)
    expect(propertyValueJsonSchema({ kind: 'json' })).toMatchObject({ type: 'object' });
  });

  test('x-orbis-type — копия типа у КАЖДОГО встроенного свойства (ref Р1)', () => {
    for (const def of BUILTIN_PROPERTY_META) {
      expect(propertyValueJsonSchema(def.type)[X_ORBIS_TYPE]).toEqual(def.type);
    }
  });

  test('все паттерны всех встроенных свойств — внутри класса RE2 (паспорт P)', () => {
    const patterns: string[] = [];
    const collect = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) collect(item);
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === X_ORBIS_TYPE) continue; // копия типа, не схема
        if (key === 'pattern' && typeof value === 'string') patterns.push(value);
        else collect(value);
      }
    };
    for (const def of BUILTIN_PROPERTY_META) collect(propertyValueJsonSchema(def.type));
    expect(patterns.length).toBeGreaterThan(10);
    for (const pattern of patterns) expect(() => assertPatternRegular(pattern)).not.toThrow();
  });

  test('вложенные ISO-моменты прогона несут паттерн, а не голую строку (наследство гейта Задачи 1)', () => {
    const iso = (
      legacyAspectJsonSchema('orbis/task') as { properties: { completed_at: { pattern: string } } }
    ).properties.completed_at.pattern;
    const proposal = schemaOf('orbis/run_proposal') as {
      properties: { decided_at: { pattern?: string } };
    };
    expect(proposal.properties.decided_at.pattern).toBe(iso);
    const steps = schemaOf('orbis/run_steps') as {
      items: { properties: { at: { pattern?: string } } };
    };
    expect(steps.items.properties.at.pattern).toBe(iso);
    const checkpoint = schemaOf('orbis/run_checkpoint') as {
      properties: { asked_at: { pattern?: string } };
    };
    expect(checkpoint.properties.asked_at.pattern).toBe(iso);
    const reply = schemaOf('orbis/run_reply') as { properties: { at: { pattern?: string } } };
    expect(reply.properties.at.pattern).toBe(iso);
  });
});

describe('legacy-field-map: переходная карта «поле аспекта → свойство» (РП-3, умирает Задачей 23)', () => {
  const legacyFields = (aspectId: string): string[] =>
    Object.keys(
      (
        ASPECT_SCHEMAS[aspectId as keyof typeof ASPECT_SCHEMAS] as {
          shape: Record<string, unknown>;
        }
      ).shape,
    );

  test('карта покрывает КАЖДОЕ поле всех тринадцати аспектов, кроме удалённого project_id', () => {
    for (const aspectId of BUILTIN_ASPECT_IDS) {
      const aspect = BUILTIN_ASPECT_DEFS.find((a) => a.id === aspectId);
      if (!aspect) throw new Error(`нет аспекта ${aspectId}`);
      for (const field of legacyFields(aspectId)) {
        const propertyId = legacyFieldToProperty(aspectId, field);
        if (aspectId === 'orbis/agent-run' && field === 'project_id') {
          expect(propertyId).toBeUndefined(); // §А8 удаляет ручную денормализацию
          continue;
        }
        expect(propertyId).toBeString();
        expect(byId.has(propertyId as string)).toBe(true);
        // Свойство обязано быть в СВОЁМ аспекте: иначе required проверялся бы не там.
        expect(aspect.properties.map((p) => p.propertyId)).toContain(propertyId);
      }
    }
  });

  test('поле без карты уезжает под orbis/<имя> и ни разу не совпадает с core-свойством', () => {
    // Запасное имя выбрано ради читаемого отказа («неизвестное свойство orbis/project_id»).
    // Оно было бы ловушкой, совпади оно с настоящим id, — этого не случается.
    for (const aspectId of BUILTIN_ASPECT_IDS) {
      for (const field of legacyFields(aspectId)) {
        expect(CORE_PROPERTY_IDS as readonly string[]).not.toContain(`orbis/${field}`);
      }
    }
  });

  test('обратная карта: свойство + аспект → поле; слитые свойства разводятся аспектом', () => {
    expect(propertyToLegacyField('orbis/task_status', 'orbis/task')).toBe('status');
    expect(propertyToLegacyField('orbis/finance_category', 'orbis/financial')).toBe('category_ref');
    expect(propertyToLegacyField('orbis/finance_category', 'orbis/budget')).toBe('category_ref');
    expect(propertyToLegacyField('orbis/grant', 'orbis/agent-run')).toBe('grant_id');
    expect(propertyToLegacyField('orbis/task_status', 'orbis/budget')).toBeUndefined();
  });

  test('legacyAspectsToProps: financial+budget с разной finance_category → conflict; с одинаковой → одно свойство', () => {
    const same = legacyAspectsToProps({
      'orbis/financial': { amount: '340.00', direction: 'expense', category_ref: 'cat-1' },
      'orbis/budget': {
        category_ref: 'cat-1',
        limit: '30000.00',
        period_start: '2026-06-01',
        period_end: '2026-06-30',
      },
    });
    expect(same.ok).toBe(true);
    if (!same.ok) throw new Error('недостижимо');
    expect(same.props['orbis/finance_category']).toBe('cat-1');
    expect(same.aspects).toEqual(['orbis/financial', 'orbis/budget']);

    const clash = legacyAspectsToProps({
      'orbis/financial': { amount: '340.00', direction: 'expense', category_ref: 'cat-1' },
      'orbis/budget': {
        category_ref: 'cat-2',
        limit: '30000.00',
        period_start: '2026-06-01',
        period_end: '2026-06-30',
      },
    });
    expect(clash.ok).toBe(false);
    if (clash.ok) throw new Error('недостижимо');
    expect(clash.conflict.propertyId).toBe('orbis/finance_category');
    expect(clash.conflict.values).toEqual(['cat-1', 'cat-2']);
  });

  test('legacyAspectsToProps: currency и grant — те же два слияния В1', () => {
    const currency = legacyAspectsToProps({
      'orbis/financial': { currency: 'RUB' },
      'orbis/budget': { currency: 'USD' },
    });
    expect(currency.ok).toBe(false);
    const grant = legacyAspectsToProps({
      'orbis/assignment': { grant_id: 'g-1' },
      'orbis/agent-run': { grant_id: 'g-2' },
    });
    expect(grant.ok).toBe(false);
    if (grant.ok) throw new Error('недостижимо');
    expect(grant.conflict.propertyId).toBe('orbis/grant');
  });

  test('перевод форм: progress_source.query строка → Q-AST-объект; mismatches аспект+поле → свойство', () => {
    const goal = legacyAspectsToProps({
      'orbis/goal': { progress_source: { query: 'aspect=orbis/note', aggregate: 'count' } },
    });
    if (!goal.ok) throw new Error('недостижимо');
    expect(goal.props['orbis/progress_source']).toEqual({
      query: { text: 'aspect=orbis/note' },
      aggregate: 'count',
    });
    const run = legacyAspectsToProps({
      'orbis/agent-run': {
        proposal: {
          pending_id: 'p-1',
          status: 'stale',
          mismatches: [{ aspect: 'orbis/task', field: 'status', note: 'уже done' }],
        },
      },
    });
    if (!run.ok) throw new Error('недостижимо');
    expect(run.props['orbis/run_proposal']).toEqual({
      pending_id: 'p-1',
      status: 'stale',
      mismatches: [{ property: 'orbis/task_status', note: 'уже done' }],
    });
  });

  test('нераспознанные формы не переписываются: их обязана отвергнуть схема, а не карта', () => {
    const goal = legacyAspectsToProps({ 'orbis/goal': { progress_source: { query: 123 } } });
    if (!goal.ok) throw new Error('недостижимо');
    expect(goal.props['orbis/progress_source']).toEqual({ query: 123 });
    const run = legacyAspectsToProps({ 'orbis/agent-run': { proposal: { mismatches: 'нет' } } });
    if (!run.ok) throw new Error('недостижимо');
    expect(run.props['orbis/run_proposal']).toEqual({ mismatches: 'нет' });
  });
});
