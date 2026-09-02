// packages/shared/src/registry/value-schema.test.ts
// Генератор схем значений (§А7-1).
//
// Переходная карта «поле старого аспекта → свойство» проверялась здесь же и снята вместе с
// собой: «Пересев мира» удалил `registry/legacy-field-map.ts` целиком, а с ним — и класс
// вопросов «как старое имя переводится в адрес». Адрес теперь один (§А5-3а).
import { describe, expect, test } from 'bun:test';
import { BUILTIN_PROPERTY_META } from './builtin-properties';
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

/**
 * Точные тексты паттернов трёх временных форм — пин, а не «какой-нибудь regexp».
 *
 * Вторая копия у них УЖЕ БЫЛА и с ней здесь и сверялись: до «Пересева мира» те же тексты
 * жили в zod-схемах аспектов. Копия осталась одна — генератор; чтобы её правка не прошла
 * молча, текст назван литералом.
 */
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
const ISO_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$';
const HHMM_PATTERN = '^([01]\\d|2[0-3]):[0-5]\\d$';

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

  test('date/timestamp/time: паттерны — точные тексты, а не «какой-нибудь» regexp', () => {
    // Тексты ПИНЯТСЯ литералом. Прежде они сверялись со старыми zod-схемами — вторым
    // описанием тех же полей, снятым «Пересевом мира»; сверять стало не с чем, а ослабить
    // проверку до «pattern определён» нельзя: именно эти формы едут в JSON Schema тула и в
    // ajv записи, и молча расширенный паттерн пропустил бы в граф мусор.
    expect(schemaOf('orbis/due_date')).toMatchObject({ pattern: DATE_PATTERN });
    expect(schemaOf('orbis/completed_at')).toMatchObject({ pattern: ISO_PATTERN });
    expect(schemaOf('orbis/routine_at')).toMatchObject({ pattern: HHMM_PATTERN });
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
    const iso = ISO_PATTERN;
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
