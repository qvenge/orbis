// apps/server/src/registry/validate-props.test.ts
// Валидатор записи по реестру свойств (§А7-1): коды нарушений, границы decimal через
// decCmp, поведение общего кеша валидаторов.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  CORE_PROPERTY_IDS,
  type PropertyDefinition,
} from '@orbis/shared';
import { QUERY_TREE_DEPTH_CAP } from '@orbis/shared/query';
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
  /**
   * ГЛУБИНА ЗНАЧЕНИЯ: своё нарушение и СВОЙ ПОРЯДОК — гейт стоит перед ajv (Р-13c-2).
   *
   * Различить порядок можно только на глубине, где рекурсивен САМ ajv: замер даёт
   * `RangeError` начиная с 20 000 уровней (на 10 000 он ещё ПРИНИМАЕТ значение — та самая
   * полоса, в которой отравленное значение ложилось в jsonb и убивало чтение цели).
   * Стоит гейт первым — отказ наш, с нашим кодом и нашим числом; стоит он после ajv — до
   * него дело не доходит вовсе, и наружу уезжает переполнение стека.
   *
   * Проба ЮНИТ-уровня намеренно: на этой глубине рекурсивные помощники интеграционного
   * сьюта (фикстурная обвязка `seedCategoriesOfInput`) исчерпывают стек сами, и проба там
   * меряла бы их запас, а не наш порядок.
   */
  test('значение глубже капа: код VALUE_TOO_DEEP, и гейт стоит ПЕРЕД ajv', () => {
    const AJV_BREAKS_AT = 20_000;
    let node: unknown = { tag: 'дом' };
    for (let i = 0; i < AJV_BREAKS_AT; i++) node = { not: node };

    expect(
      validateEntityProps(REG, {
        props: { 'orbis/progress_source': { query: { filter: node }, aggregate: 'count' } },
        aspects: [],
      }),
    ).toEqual([
      { code: 'VALUE_TOO_DEEP', propertyId: 'orbis/progress_source', cap: QUERY_TREE_DEPTH_CAP },
    ]);

    // Законная форма тем же путём проходит — проверка не запрещает нормальную цель.
    expect(
      validateEntityProps(REG, {
        props: {
          'orbis/progress_source': {
            query: { filter: { aspect: 'orbis/task' } },
            aggregate: 'count',
          },
        },
        aspects: [],
      }),
    ).toEqual([]);
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

// Календарь — не форма, и ajv его не выражает вовсе: `2026-02-30` проходит паттерн схемы
// значения. Без этой проверки значение записывалось бы МОЛЧА, а падало позже и в другом
// месте — на первом же `::date` в запросе (Postgres 22008), то есть дефект записи выглядел
// бы поломкой чтения. Проверка живёт ВНЕ ajv, как и границы decimal, и потому не меняет ни
// байта в `propertyValueJsonSchema` (значит, и в сидированной схеме аспекта).
describe('календарь — hasValidCalendar, а не ajv (Р-9b-5)', () => {
  const date = (value: unknown) =>
    codes(validateEntityProps(REG, { props: { 'orbis/due_date': value }, aspects: [] }));
  const stamp = (value: unknown) =>
    codes(validateEntityProps(REG, { props: { 'orbis/start_at': value }, aspects: [] }));

  test('несуществующий день отвергается и у date, и у timestamp', () => {
    expect(date('2026-02-30')).toEqual(['TYPE']);
    expect(date('2026-13-01')).toEqual(['TYPE']);
    expect(date('2026-04-31')).toEqual(['TYPE']);
    expect(date('2026-01-00')).toEqual(['TYPE']);
    // У момента календарный день — те же первые десять символов, и второго правила нет.
    expect(stamp('2026-02-30T09:00:00Z')).toEqual(['TYPE']);
    expect(stamp('2026-13-01T09:00:00+03:00')).toEqual(['TYPE']);
  });

  test('у момента проверяется и время суток, и смещение зоны (I-1)', () => {
    // Реформа не имеет права оказаться слабее умирающего парсера: проверка компонент
    // времени есть у него (`query/parse.ts`, isValidCalendarTimestamp). Без неё момент
    // записывался бы молча и ронял бы любой `sortBy` по нему кодом 22008.
    expect(stamp('2026-08-27T25:00:00Z')).toEqual(['TYPE']);
    expect(stamp('2026-08-27T12:61:00Z')).toEqual(['TYPE']);
    expect(stamp('2026-08-27T12:00:60Z')).toEqual(['TYPE']);
    // Смещение: форму `[+-]\d{2}:\d{2}` проходит и `+23:00`, а Postgres берёт до ±15:59.
    expect(stamp('2026-08-27T12:00:00+23:00')).toEqual(['TYPE']);
    expect(stamp('2026-08-27T12:00:00+15:59')).toEqual([]);
    expect(stamp('2026-08-27T23:59:59Z')).toEqual([]);
  });

  test('нулевой год отвергается на записи — иначе он падал бы уже чтением (I-5)', () => {
    expect(date('0000-01-01')).toEqual(['TYPE']);
    expect(stamp('0000-06-15T12:00:00Z')).toEqual(['TYPE']);
    expect(date('0001-01-01')).toEqual([]);
  });

  test('високосный контроль: 29 февраля есть в 2028 и нет в 2029', () => {
    // Без этой пары проверка могла бы оказаться ГРУБЕЕ календаря («в феврале всегда 28»)
    // и осталась бы зелёной на всех примерах выше.
    expect(date('2028-02-29')).toEqual([]);
    expect(date('2029-02-29')).toEqual(['TYPE']);
    expect(stamp('2028-02-29T09:00:00Z')).toEqual([]);
    expect(stamp('2029-02-29T09:00:00Z')).toEqual(['TYPE']);
    // Вековые годы — то же правило, что у `lastDayOfMonth`: 2000 високосный, 1900 нет.
    expect(date('2000-02-29')).toEqual([]);
    expect(date('1900-02-29')).toEqual(['TYPE']);
  });

  test('здоровые значения проходят, а отказ называет свойство и значение', () => {
    expect(date('2026-07-05')).toEqual([]);
    expect(stamp('2026-07-05T09:00:00+03:00')).toEqual([]);
    const violations = validateEntityProps(REG, {
      props: { 'orbis/due_date': '2026-02-30' },
      aspects: [],
    });
    expect(violations).toEqual([
      {
        code: 'TYPE',
        propertyId: 'orbis/due_date',
        message: 'значения «2026-02-30» нет в календаре',
      },
    ]);
  });

  test('форма проверяется РАНЬШЕ календаря: мусор отвергает ajv, а не этот спутник', () => {
    // Иначе `hasValidCalendar('банан')` вернул бы true («это не дата»), и мусор проехал бы.
    expect(date('банан')).toEqual(['TYPE']);
    expect(date('05.07.2026')).toEqual(['TYPE']);
    expect(date(20260705)).toEqual(['TYPE']);
  });

  test('гейт по виду свойства: текстовое свойство с датой внутри паттерна не задето', () => {
    // `orbis/run_bucket` — тип text, паттерн несёт дату; в SQL он не кастуется, и Р-9b-5
    // оставил его как есть. Снятый гейт отвергал бы его молча.
    expect(
      codes(
        validateEntityProps(REG, {
          props: { 'orbis/run_bucket': '2026-02-30T07:00' },
          aspects: [],
        }),
      ),
    ).toEqual([]);
  });
});

/**
 * ЕДИНИЦА «15-БИС»: CORE-ПРОЕКЦИЯ В `props` — ОТКАЗ (§А1-3).
 *
 * Четыре свойства ядра (`storage: 'core'`) хранятся КОЛОНКАМИ `entities`, а реестр даёт им
 * лишь единый адрес для Q-AST, предусловий и подписи. Записанное в `props` значение под тем
 * же реестровым именем не читает НИ ОДИН боевой путь — то есть у записи появляется вторая
 * правда, невидимая всем читателям и вечная. Задача 15 закрыла вход со стороны слияния
 * (`MERGE_STORAGE`, `registry/ops.ts`); здесь закрывается вход со стороны обычной записи —
 * общим валидатором, через который идут все три пути (`entity_create`, `entity_update`,
 * `attach_*`, живые пробы — `executor/props.test.ts`).
 */
describe('core-проекция в props — CORE_IN_PROPS (§А1-3, единица 15-бис)', () => {
  test('каждое из четырёх core-свойств отвергается, даже со значением ПРАВИЛЬНОГО типа', () => {
    const values: Record<string, unknown> = {
      'orbis/archived': false,
      'orbis/title': 'Дом',
      'orbis/created_at': '2026-08-26T10:00:00.000Z',
      'orbis/updated_at': '2026-08-26T10:00:00.000Z',
    };
    for (const id of CORE_PROPERTY_IDS) {
      expect([id, validateEntityProps(REG, { props: { [id]: values[id] }, aspects: [] })]).toEqual([
        id,
        [{ code: 'CORE_IN_PROPS', propertyId: id, storage: 'core' }],
      ]);
    }
  });

  test('правило — по `storage` реестра, а не по списку имён в коде', () => {
    // Список `CORE_PROPERTY_IDS` — производная того же поля: разъедься они, отказ смотрел бы
    // на имена, которых в реестре уже нет (или пропускал бы новую core-проекцию).
    const core = BUILTIN_PROPERTY_META.filter((p) => p.storage === 'core').map((p) => p.id);
    expect(core).toEqual([...CORE_PROPERTY_IDS]);
    // Обратная сторона границы: доменное свойство (`storage: 'props'`) тем же входом проходит.
    expect(validateEntityProps(REG, { props: { 'orbis/priority': 'high' }, aspects: [] })).toEqual(
      [],
    );
  });

  test('отказ стоит РАНЬШЕ проверки типа: причина — «не тот дом», а не «не то значение»', () => {
    // Иначе владелец (и модель) чинили бы формат вместо адреса — и чинили бы вечно.
    expect(codes(validateEntityProps(REG, { props: { 'orbis/title': 42 }, aspects: [] }))).toEqual([
      'CORE_IN_PROPS',
    ]);
  });
});
