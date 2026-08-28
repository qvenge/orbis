// Генератор модель-обращённой поверхности реестра (§А9-1): имя attach_*-тула и схема его
// `data`. Реестр здесь — ВСТРОЕННЫЙ (`BUILTIN_*`), а не мок: схема тула обязана совпасть с
// той, по которой валидируется запись, и мок дал бы согласие двух выдумок.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS } from './builtin-aspects';
import { BUILTIN_PROPERTY_META } from './builtin-properties';
import type { AspectDefinition } from './property-type';
import { aspectToolJsonSchema, attachToolName, type ToolSchemaRegistry } from './tool-schema';
import { X_ORBIS_TYPE } from './value-schema';

const reg: ToolSchemaRegistry = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
};
const aspectById = new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a]));

function aspect(id: string): AspectDefinition {
  const def = aspectById.get(id);
  if (def === undefined) throw new Error(`нет встроенного аспекта ${id}`);
  return def;
}

function schemaOf(id: string, locale = 'ru'): Record<string, unknown> {
  return aspectToolJsonSchema(aspect(id), reg, locale);
}

function propsOf(id: string, locale = 'ru'): Record<string, Record<string, unknown>> {
  return schemaOf(id, locale).properties as Record<string, Record<string, unknown>>;
}

describe('attachToolName (§А9-1)', () => {
  test('«/» и «-» ключа → «_»: имя тула LLM/MCP остаётся [a-z0-9_]', () => {
    expect(attachToolName('orbis/task')).toBe('attach_orbis_task');
    // Дефис — та самая разница, на которой расходились две прежние нормализации.
    expect(attachToolName('orbis/agent-run')).toBe('attach_orbis_agent_run');
    expect(attachToolName('user/sleep-log')).toBe('attach_user_sleep_log');
    for (const a of BUILTIN_ASPECT_DEFS) expect(attachToolName(a.key)).toMatch(/^[a-z0-9_]+$/);
  });
});

describe('aspectToolJsonSchema (§А9-1)', () => {
  test('имена параметров — key свойств, порядок — по rank ссылки аспекта (§Б7-3)', () => {
    // Порядок вставки в JSON значим: модель читает поля в том же порядке, что владелец.
    expect(Object.keys(propsOf('orbis/task'))).toEqual([
      'orbis/task_status',
      'orbis/priority',
      'orbis/due_date',
      'orbis/completed_at',
      'orbis/effort_min',
      'orbis/waiting_for',
    ]);
    // Перемешанные ранги приводятся к порядку rank, а не порядку массива.
    const shuffled: AspectDefinition = {
      ...aspect('orbis/task'),
      properties: [...aspect('orbis/task').properties].reverse(),
    };
    expect(
      Object.keys(
        (aspectToolJsonSchema(shuffled, reg, 'ru').properties ?? {}) as Record<string, unknown>,
      ),
    ).toEqual([
      'orbis/task_status',
      'orbis/priority',
      'orbis/due_date',
      'orbis/completed_at',
      'orbis/effort_min',
      'orbis/waiting_for',
    ]);
  });

  test('required — ровно обязательные ссылки аспекта; additionalProperties: false', () => {
    const schema = schemaOf('orbis/task');
    expect(schema.required).toEqual(['orbis/task_status']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.type).toBe('object');
    // Финансы: три обязательных — сумма, направление и категория (§А8).
    expect(schemaOf('orbis/financial').required).toEqual([
      'orbis/amount',
      'orbis/direction',
      'orbis/finance_category',
    ]);
  });

  test('schema значения — из propertyValueJsonSchema: enum select по rank и x-orbis-type', () => {
    const status = propsOf('orbis/task')['orbis/task_status'];
    expect(status?.enum).toEqual([
      'inbox',
      'planned',
      'in_progress',
      'waiting',
      'done',
      'cancelled',
    ]);
    // Копия типа (ref Р1) едет в каждый параметр — по ней UI выбирает контрол, сервер границы.
    expect((status?.[X_ORBIS_TYPE] as { kind?: string } | undefined)?.kind).toBe('select');
    // decimal остаётся СТРОКОЙ с паттерном (§А7-3), а не числом.
    const amount = propsOf('orbis/financial')['orbis/amount'];
    expect(amount?.type).toBe('string');
    expect(amount?.pattern).toBe('^-?\\d+(\\.\\d+)?$');
  });

  test('description параметра = «label — description» локали, у select + список вариантов', () => {
    const ru = propsOf('orbis/financial')['orbis/direction'];
    expect(ru?.description).toBe(
      'Направление — Деньги приходят или уходят (варианты: income|expense)',
    );
    // Локаль читается, а не игнорируется: en-описание отличается от ru.
    const en = propsOf('orbis/financial', 'en')['orbis/direction'];
    expect(en?.description).toBe(
      'Direction — Money comes in or goes out (варианты: income|expense)',
    );
    // Не-select описания списка вариантов не получают.
    expect(propsOf('orbis/financial')['orbis/amount']?.description).toBe(
      'Сумма — Величина операции; знак задаёт направление, а не сама сумма',
    );
  });

  test('локаль без перевода откатывается на en (§А2-1), а не даёт undefined', () => {
    const pt = propsOf('orbis/financial', 'pt-BR')['orbis/direction'];
    expect(pt?.description).toBe(
      'Direction — Money comes in or goes out (варианты: income|expense)',
    );
  });

  test('ссылка на свойство вне снимка пропускается, остальной тул остаётся вызываемым', () => {
    // Снимок скоупится RLS и модулями: аспект с одним невидимым полем обязан работать по
    // остальным, а не исчезнуть из реестра целиком.
    const narrowed: ToolSchemaRegistry = {
      properties: new Map([...reg.properties].filter(([id]) => id !== 'orbis/priority')),
    };
    const props = (aspectToolJsonSchema(aspect('orbis/task'), narrowed, 'ru').properties ??
      {}) as Record<string, unknown>;
    expect(Object.keys(props)).not.toContain('orbis/priority');
    expect(Object.keys(props)).toContain('orbis/task_status');
  });

  test('обязательное свойство вне снимка не попадает и в required (иначе тул неисполним)', () => {
    const narrowed: ToolSchemaRegistry = {
      properties: new Map([...reg.properties].filter(([id]) => id !== 'orbis/task_status')),
    };
    expect(aspectToolJsonSchema(aspect('orbis/task'), narrowed, 'ru').required).toEqual([]);
  });
});
