// apps/server/src/registry/validate-props.test.ts
// Валидатор записи по реестру свойств (§А7-1): коды нарушений, границы decimal через
// decCmp, поведение общего кеша валидаторов.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS, BUILTIN_PROPERTY_META, type PropertyDefinition } from '@orbis/shared';
import { type PropsRegistry, validateEntityProps } from './validate-props';

const REG: PropsRegistry = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
};

/** Реестр с подменённой одной строкой — для статусов, которых у встроенных нет. */
function withProperty(def: PropertyDefinition): PropsRegistry {
  return { properties: new Map([...REG.properties, [def.id, def]]), aspects: REG.aspects };
}

const codes = (violations: { code: string }[]): string[] => violations.map((v) => v.code);

describe('validateEntityProps: коды нарушений', () => {
  test('чистая сущность — ноль нарушений', () => {
    expect(
      validateEntityProps(REG, {
        props: { 'orbis/task_status': 'inbox', 'orbis/priority': 'high' },
        aspects: ['orbis/task'],
      }),
    ).toEqual([]);
  });

  test('unknown property / unknown aspect / deprecated — коды', () => {
    expect(validateEntityProps(REG, { props: { 'orbis/project_id': 'x' }, aspects: [] })).toEqual([
      { code: 'UNKNOWN_PROPERTY', propertyId: 'orbis/project_id' },
    ]);

    expect(validateEntityProps(REG, { props: {}, aspects: ['orbis/nope'] })).toEqual([
      { code: 'UNKNOWN_ASPECT', aspectId: 'orbis/nope' },
    ]);

    // §А10-3: строка реестра не удаляется, а становится deprecated — ЧТЕНИЕ старых значений
    // живо, а запись нового отвергается. Потому deprecated — отдельный код, а не TYPE.
    const dead = withProperty({
      ...(REG.properties.get('orbis/priority') as PropertyDefinition),
      status: 'deprecated',
    });
    expect(validateEntityProps(dead, { props: { 'orbis/priority': 'high' }, aspects: [] })).toEqual(
      [{ code: 'DEPRECATED', propertyId: 'orbis/priority' }],
    );
    // Значение, которое к тому же не проходит тип, всё равно даёт ОДИН отказ — тот, что
    // объясняет причину: свойства больше нет, и разбираться с его типом незачем.
    expect(
      codes(validateEntityProps(dead, { props: { 'orbis/priority': 'нет' }, aspects: [] })),
    ).toEqual(['DEPRECATED']);
    // `proposed` записи не мешает: свойство живо, просто ещё не подтверждено (§А2-7).
    const proposed = withProperty({
      ...(REG.properties.get('orbis/priority') as PropertyDefinition),
      status: 'proposed',
    });
    expect(
      validateEntityProps(proposed, { props: { 'orbis/priority': 'high' }, aspects: [] }),
    ).toEqual([]);
  });

  test('REQUIRED — по обязательным свойствам КАЖДОГО аспекта сущности', () => {
    expect(validateEntityProps(REG, { props: {}, aspects: ['orbis/routine'] })).toEqual([
      { code: 'REQUIRED', aspectId: 'orbis/routine', propertyId: 'orbis/routine_stage' },
      { code: 'REQUIRED', aspectId: 'orbis/routine', propertyId: 'orbis/routine_at' },
      { code: 'REQUIRED', aspectId: 'orbis/routine', propertyId: 'orbis/routine_mode' },
    ]);
    // Слитое свойство закрывает обязательность обоих носителей одним значением (В1).
    expect(
      codes(
        validateEntityProps(REG, {
          props: {
            'orbis/amount': '340.00',
            'orbis/direction': 'expense',
            'orbis/finance_category': '019d48ea-4188-765d-8e96-93a0ad9c262a',
            'orbis/limit': '30000.00',
            'orbis/period_start': '2026-06-01',
            'orbis/period_end': '2026-06-30',
          },
          aspects: ['orbis/financial', 'orbis/budget'],
        }),
      ),
    ).toEqual([]);
  });

  test('TYPE — отказ по схеме значения, с именем свойства в сообщении', () => {
    const violations = validateEntityProps(REG, {
      props: { 'orbis/task_status': 'todo' },
      aspects: [],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe('TYPE');
    expect((violations[0] as { propertyId: string }).propertyId).toBe('orbis/task_status');
    expect((violations[0] as { message: string }).message).toBeTruthy();
  });

  test('нарушения собираются по ВСЕМ свойствам, а не до первого', () => {
    expect(
      codes(
        validateEntityProps(REG, {
          props: { 'orbis/task_status': 'todo', 'orbis/effort_min': 0, 'orbis/nope': 1 },
          aspects: ['orbis/task'],
        }),
      ).sort(),
    ).toEqual(['TYPE', 'TYPE', 'UNKNOWN_PROPERTY']);
  });

  test('общий кешированный валидатор не тащит ошибки предыдущего вызова', () => {
    // Один и тот же ajv-валидатор переиспользуется по тексту схемы, а `validate.errors` у
    // ajv — состояние функции: прочитанное не в тот момент даёт отказ на здоровом значении.
    expect(
      codes(validateEntityProps(REG, { props: { 'orbis/priority': 'нет' }, aspects: [] })),
    ).toEqual(['TYPE']);
    expect(validateEntityProps(REG, { props: { 'orbis/priority': 'high' }, aspects: [] })).toEqual(
      [],
    );
  });
});

describe('границы decimal — decCmp, а не ajv (§А7-3, В8)', () => {
  test('propertyValueJsonSchema(decimal exclusiveMin 0): «0» → отказ через decCmp, «0.01» → ок; паттерн без lookahead', () => {
    const reject = (value: string) =>
      codes(validateEntityProps(REG, { props: { 'orbis/amount': value }, aspects: [] }));
    expect(reject('0')).toEqual(['TYPE']);
    expect(reject('0.00')).toEqual(['TYPE']); // ноль по ЗНАЧЕНИЮ, а не по тексту
    expect(reject('-0')).toEqual(['TYPE']);
    expect(reject('-1')).toEqual(['TYPE']);
    expect(reject('0.01')).toEqual([]);
    expect(reject('340.00')).toEqual([]);
    // «abc» отсекается паттерном ДО decCmp: parseDec бросил бы RangeError наружу.
    expect(reject('abc')).toEqual(['TYPE']);
    expect(reject('3.4e2')).toEqual(['TYPE']);
  });

  test('min включительна, max — обе границы по значению', () => {
    const limit = (value: string) =>
      codes(validateEntityProps(REG, { props: { 'orbis/limit': value }, aspects: [] }));
    expect(limit('0')).toEqual([]);
    expect(limit('0.00')).toEqual([]);
    expect(limit('-1.00')).toEqual(['TYPE']);
    // Границ у carryover нет вовсе — минус законен (перерасход переносится).
    expect(
      codes(validateEntityProps(REG, { props: { 'orbis/carryover': '-1200.00' }, aspects: [] })),
    ).toEqual([]);
  });

  test('«10.0» = «10.00»: сравнение по значению, а не по тексту', () => {
    const target = (value: string) =>
      codes(validateEntityProps(REG, { props: { 'orbis/target_value': value }, aspects: [] }));
    expect(target('10.0')).toEqual([]);
    expect(target('10.00')).toEqual([]);
    expect(target('0.000')).toEqual(['TYPE']);
  });
});
