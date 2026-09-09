// apps/server/src/expr/compile.test.ts
// SQL-бэкенд предикатов E: предикат по слотам, членство в наборе, частичная привязка §Б2-3.
//
// БД здесь не нужна — меряется ТЕКСТ SQL и отказы компиляции; обстановка (свой аспект
// владельца с частичной привязкой) кладётся ДЕКЛАРАЦИЕЙ, потому что юнит меряет компилятор,
// а не сид.
import { describe, expect, test } from 'bun:test';
import {
  type AspectDefinition,
  aspectDefinitionSchema,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  type ContractDefinition,
  type PropertyDefinition,
  propertyDefinitionSchema,
  ROLE_DEPENDENCY,
  ROLE_SUBITEM,
} from '@orbis/shared';
import { checkExpr, type ExprNode, type ExprScope } from '@orbis/shared/expr';
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { GATE_FIN_ASPECT } from '../../test/fixtures/gate-aspects';
import { ExecError } from '../errors';
import type { CompileCtx } from '../query/compile-ast';
import { negated } from '../query/compile-ast';
import type { RegistrySnapshot } from '../registry/load';
import {
  compileClassListMembership,
  compileClassMembership,
  compileContractPredicate,
  compileExprPredicate,
} from './compile';

const dialect = new PgDialect();

function snapshot(over: Partial<RegistrySnapshot> = {}): RegistrySnapshot {
  return {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
    subscriptions: new Map(),
    ownerVersion: 0,
    systemVersion: 1,
    ...over,
  };
}

function ctxOf(over: Partial<CompileCtx> = {}): CompileCtx {
  return {
    ownerId: '00000000-0000-7000-8000-0000000000a1',
    today: '2026-07-03',
    timeZone: 'Europe/Moscow',
    reg: snapshot(),
    thisEntityId: '00000000-0000-7000-8000-0000000000f1',
    ...over,
  };
}

const CTX = ctxOf();
const ROW = sql.raw('e');
const sqlOf = (s: SQL): string => dialect.sqlToQuery(s).sql.replaceAll(/\s+/g, ' ').trim();

/** Отказ компилятора: код всегда VALIDATION, различает причина в details. */
function refusal(fn: () => unknown): { code: string; reason: string; details: unknown } {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExecError) {
      return {
        code: e.code,
        reason: String((e.details as { reason?: unknown })?.reason),
        details: e.details,
      };
    }
    throw e;
  }
  throw new Error('ожидался отказ компиляции, а его не было');
}

/**
 * Предикат `money-movement.sets.facts` (§Б5-4, реестр §1.3) — КОПИЯ того, что сеет задача 4:
 * компилятор обязан быть проверен раньше сева, а до задачи 4 набора `facts` в контракте нет
 * вовсе. Разойдутся — покраснеет тест задачи 4 «SQL набора совпадает с Budget бит-в-бит».
 */
const FACTS_EXPR: ExprNode = {
  op: 'and',
  args: [
    // Р-К-29: `not(planned = true)` тотален в обоих бэкендах одинаково и не требует у
    // аспекта слота `planned` (у аспекта гейта §С8-18 его нет): отсутствующее → `=` false →
    // `not` true — как оракул `coalesce(planned, false) = false`.
    { op: 'not', args: [{ op: '=', args: [{ slot: 'planned' }, { const: true }] }] },
    { op: '<=', args: [{ slot: 'date' }, { ctx: '$today' }] },
    {
      op: 'not',
      args: [
        { op: 'in', args: [{ class: { contract: 'orbis/recurrence' } }, { const: 'templates' }] },
      ],
    },
  ],
};

/**
 * Тот же контракт, но с ПРЕДИКАТНЫМ набором: подмена СНИМКОМ — тот же приём, каким
 * `compile-ast.test.ts` подменяет списки служебных аспектов. Каста здесь БОЛЬШЕ НЕТ: со
 * второй веткой `contractSetSchema` (задача 4) E-предикат — законное значение набора, и
 * подмена проходит типом. Своя копия `FACTS_EXPR` рядом остаётся намеренно: тест меряет
 * компилятор, а не сид, и разойдясь с севом — краснеет.
 */
function withFactsSet(): Map<string, ContractDefinition> {
  const map = new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c] as [string, ContractDefinition]));
  const mm = map.get('orbis/money-movement') as Extract<ContractDefinition, { kind: 'slots' }>;
  map.set(mm.id, { ...mm, sets: { ...mm.sets, facts: FACTS_EXPR } });
  return map;
}

/**
 * Аспект гейта — ДЕКЛАРАЦИЕЙ, без БД: юнит меряет компилятор, а не сид. Спека аспекта берётся
 * из фикстуры 0d и разворачивается в записи реестра тем же правилом `<namespace>/<поле>`,
 * каким её пишет `seedCustomAspect`. Ключи аспекта и его полей здесь НЕ пишутся строками ни
 * разу — только читаются из `GATE_FIN_ASPECT`: их единственный дом — та фикстура (дисциплина
 * токенов 0d, на ней стоит греп-доказательство «ноль строк кода» задачи 10).
 */
function gateRegistry(): Pick<RegistrySnapshot, 'properties' | 'aspects'> {
  const ns = GATE_FIN_ASPECT.key.split('/')[0] as string;
  const properties = new Map(
    BUILTIN_PROPERTY_META.map((p) => [p.id, p] as [string, PropertyDefinition]),
  );
  for (const [i, p] of GATE_FIN_ASPECT.properties.entries()) {
    const id = `${ns}/${p.key}`;
    properties.set(
      id,
      propertyDefinitionSchema.parse({
        id,
        key: id,
        label: { ru: p.key },
        description: { ru: `Поле ${p.key}` },
        type: p.type,
        ownerId: CTX.ownerId,
        status: 'active',
        rank: i + 1,
      }),
    );
  }
  const aspects = new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a] as [string, AspectDefinition]));
  aspects.set(
    GATE_FIN_ASPECT.key,
    aspectDefinitionSchema.parse({
      id: GATE_FIN_ASPECT.key,
      ownerId: CTX.ownerId,
      key: GATE_FIN_ASPECT.key,
      label: GATE_FIN_ASPECT.label,
      description: GATE_FIN_ASPECT.description,
      properties: GATE_FIN_ASPECT.properties.map((p, i) => ({
        propertyId: `${ns}/${p.key}`,
        required: p.required ?? false,
        rank: i + 1,
      })),
      aiInstructions: null,
      tagMappings: [],
      viewConfig: { keyFields: [] },
      module: GATE_FIN_ASPECT.module,
      service: false,
      rank: 900,
      implements: GATE_FIN_ASPECT.implements,
    }),
  );
  return { properties, aspects };
}

/**
 * Контракт завершаемости с ПРЕДИКАТНЫМ набором «заблокировано»: сам предикат — `has_relation`.
 * Ради него и заведён: набор, вызванный ИЗ `has_relation`, ставит второй EXISTS внутрь первого,
 * и это единственная форма, на которой видно затенение алиасов.
 */
function withBlockedSet(): Map<string, ContractDefinition> {
  const map = new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c] as [string, ContractDefinition]));
  const done = map.get('orbis/completable') as Extract<ContractDefinition, { kind: 'slots' }>;
  map.set(done.id, {
    ...done,
    sets: { ...done.sets, blocked: { has_relation: { role: ROLE_DEPENDENCY, alive: true } } },
  });
  return map;
}

const GATE = gateRegistry();

describe('SQL-бэкенд E: предикат по слотам — OR по привязкам', () => {
  test('facts money-movement компилируется по СВОЙСТВАМ привязки и совпадает с Budget бит-в-бит', () => {
    const s = sqlOf(compileContractPredicate('orbis/money-movement', FACTS_EXPR, CTX, ROW));
    expect(s).toContain(`e.aspects @> ARRAY['orbis/financial']`);
    // Умолчание берётся ИЗ РЕЕСТРА через castedExpr, отрицание — тотальное (`negated`).
    expect(s).toContain(
      `NOT COALESCE(COALESCE((e.props->>'orbis/planned')::boolean, false) = true, false)`,
    );
    expect(s).toContain(`(e.props->>'orbis/occurred_on')::date <=`);
  });

  test('§Б2-3 частичная привязка: пустой обязательный слот — не член контракта', () => {
    const s = sqlOf(compileContractPredicate('orbis/money-movement', { const: true }, CTX, ROW));
    expect(s).toContain(`e.props ? 'orbis/amount'`);
    expect(s).toContain(`e.props ? 'orbis/occurred_on'`);
  });

  test('гейт §С8-18: свой аспект с привязкой попадает в тот же OR без строки кода', () => {
    const ctx = ctxOf({ reg: snapshot(GATE) });
    const s = sqlOf(compileContractPredicate('orbis/money-movement', { const: true }, ctx, ROW));
    expect(s).toContain(`e.aspects @> ARRAY['${GATE_FIN_ASPECT.key}']`);
    expect(s.split(' OR ').length).toBe(2);
  });

  test('§Б2-3 частичная привязка: необязательный слот без свойства — NULL, а не UNKNOWN_SLOT', () => {
    // Гвоздь гейта §С8-18: у аспекта гейта нет свойства под НЕОБЯЗАТЕЛЬНЫЙ слот `planned`, а
    // предикат `facts` его читает. Отказ на этом месте ронял бы `compileClassMembership` у
    // КАЖДОГО владельца своего аспекта — то есть весь сквозной путь, а не одну привязку.
    const ctx = ctxOf({ reg: snapshot({ ...GATE, contracts: withFactsSet() }) });
    const s = sqlOf(compileClassMembership('orbis/money-movement', 'facts', ctx, ROW));
    expect(s).toContain(`e.aspects @> ARRAY['${GATE_FIN_ASPECT.key}']`);
    // связанный слот — по свойству
    expect(s).toContain(`COALESCE((e.props->>'orbis/planned')::boolean, false)`);
    // несвязанный — «значения нет»
    expect(s).toContain('NULL');
    // Членство ТОТАЛЬНО: NULL-предикат обязан читаться как «не член», иначе `NOT (…)` даёт
    // NULL и строка молча выпадает из выдачи — тот же довод, что у `negated`.
    expect(s.startsWith('COALESCE((')).toBe(true);
    expect(s.endsWith(', false)')).toBe(true);
  });

  test('слот, которого КОНТРАКТ не объявлял, — по-прежнему UNKNOWN_SLOT: это опечатка в декларации', () => {
    expect(
      refusal(() =>
        compileContractPredicate(
          'orbis/money-movement',
          { op: '=', args: [{ slot: 'нет-слота' }, { const: true }] } as never,
          CTX,
          ROW,
        ),
      ).reason,
    ).toBe('UNKNOWN_SLOT');
  });
});

describe('SQL-бэкенд E: членство в наборе', () => {
  test('списочный набор: варианты — из value_map привязки, а не из литералов кода', () => {
    expect(sqlOf(compileClassMembership('orbis/completable', 'closed', CTX, ROW))).toContain(
      `e.props->>'orbis/task_status' IN ('done', 'cancelled')`,
    );
  });

  test('членство ТОТАЛЬНО: у сущности без аспекта — false, не NULL (блокер-заметка блокирует)', () => {
    expect(
      sqlOf(negated(compileClassMembership('orbis/completable', 'closed', CTX, sql.raw('b')))),
    ).toContain('NOT COALESCE(');
  });

  test('json-слот: present/absent — наличие ключа, а не сравнение текста (Р-К-3)', () => {
    const s = sqlOf(compileClassMembership('orbis/recurrence', 'templates', CTX, ROW));
    expect(s).toContain(`e.aspects @> ARRAY['orbis/schedule']`);
    expect(s).toContain(`e.props ? 'orbis/recurrence'`);
    // Р-К-30: у orbis/financial маркера шаблона нет — в SQL набора его свойства не появляются.
    expect(s).not.toContain('orbis/recurring');
  });

  test('Р-И-11: имя набора и перечисление его классов — две формы правого операнда in, ОДИН SQL', () => {
    const inNode = (rhs: string | readonly string[]) =>
      sqlOf(
        compileExprPredicate(
          {
            op: 'in',
            args: [{ class: { contract: 'orbis/recurrence' } }, { const: rhs }],
          } as never,
          { cctx: CTX, row: ROW },
        ),
      );
    expect(inNode(['template'])).toBe(inNode('templates'));
    expect(inNode('templates')).toBe(
      sqlOf(compileClassMembership('orbis/recurrence', 'templates', CTX, ROW)),
    );
    // Перечисление законно и для деклараций владельца, где набор под нужный состав
    // контрактом не назван.
    expect(
      sqlOf(compileClassListMembership('orbis/completable', ['done', 'cancelled'], CTX, ROW)),
    ).toBe(sqlOf(compileClassMembership('orbis/completable', 'closed', CTX, ROW)));
  });

  test('набор, ссылающийся САМ НА СЕБЯ, отказывает названно, а не переполнением стека (Ф-Б1-21)', () => {
    // Обстановка кладётся ДЕКЛАРАЦИЕЙ — тулом такой набор владельцу не завести (состав своего
    // набора это классы контракта, `contractDeltaSchema`), и цикл сюда может прийти только
    // сидом либо будущей формой дельты. Проверяется именно то, ради чего кап заведён:
    // компилятор ОТКАЗЫВАЕТ, а не роняет процесс.
    const base = BUILTIN_CONTRACT_DEFS.find((c) => c.id === 'orbis/completable');
    if (base === undefined || base.kind !== 'slots') throw new Error('нет контракта фикстуры');
    const looped: ContractDefinition = {
      ...base,
      sets: {
        ...base.sets,
        // «Член набора `петля` тот, кто член набора `петля`» — короткий цикл из одного набора.
        петля: {
          op: 'in',
          args: [{ class: { contract: 'orbis/completable' } }, { const: 'петля' }],
        } as never,
      },
    };
    const ctx = ctxOf({
      reg: snapshot({
        contracts: new Map([
          ...BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c] as const),
          ['orbis/completable', looped],
        ]),
      }),
    });
    const e = refusal(() => compileClassMembership('orbis/completable', 'петля', ctx, ROW));
    expect([e.code, e.reason]).toEqual(['VALIDATION', 'EXPR_SHAPE']);
    // Отказ НАЗЫВАЕТ набор — иначе владелец искал бы цикл по всему реестру.
    expect(e.details).toMatchObject({ contract: 'orbis/completable', set: 'петля', setDepth: 16 });
    // Проба не вакуумна: без цикла тот же путь компилируется.
    expect(sqlOf(compileClassMembership('orbis/completable', 'closed', ctx, ROW))).toContain(
      'orbis/task_status',
    );
  });

  test('неизвестный контракт и неизвестный набор — РАЗНЫЕ причины, не пустота (§С8-3)', () => {
    expect(refusal(() => compileClassMembership('orbis/нет', 'closed', CTX, ROW)).reason).toBe(
      'UNKNOWN_CONTRACT',
    );
    expect(refusal(() => compileClassMembership('orbis/completable', 'нет', CTX, ROW)).reason).toBe(
      'UNKNOWN_SET',
    );
  });

  test('узел без SQL-бэкенда отказывает названно, а не молча даёт true', () => {
    expect(
      refusal(() => compileExprPredicate({ agg: 'spent' } as never, { cctx: CTX, row: ROW }))
        .reason,
    ).toBe('EXPR_BACKEND_UNSUPPORTED');
  });

  test('вложенный has_relation: у каждого уровня СВОИ алиасы, внутренний читает внешний far', () => {
    const ctx = ctxOf({ reg: snapshot({ contracts: withBlockedSet() }) });
    const s = sqlOf(
      compileExprPredicate(
        {
          has_relation: {
            role: ROLE_SUBITEM,
            in_set: { contract: 'orbis/completable', set: 'blocked' },
          },
        } as never,
        { cctx: ctx, row: ROW },
      ),
    );
    expect(s).toContain('FROM relations r JOIN entities far ON far.id = r.source_id');
    expect(s).toContain('FROM relations r2 JOIN entities far2 ON far2.id = r2.source_id');
    // Внутренний EXISTS спрашивает про ВНЕШНИЙ дальний конец. С одним именем на два уровня
    // здесь стояло бы `r2.target_id = far2.id` — законный SQL, всегда пустой ответ.
    expect(s).toContain('r2.target_id = far.id');
    expect(s).not.toContain('r2.target_id = far2.id');
  });

  test('роль сверяется с реестром: опечатка — отказ, а не «не выполнено» (§С8-3)', () => {
    expect(
      refusal(() =>
        compileExprPredicate({ has_relation: { role: 'нет-роли' } } as never, {
          cctx: CTX,
          row: ROW,
        }),
      ).reason,
    ).toBe('EXPR_SHAPE');
    // Контроль: роль реестра компилируется молча и даёт входящее ребро.
    expect(
      sqlOf(
        compileExprPredicate({ has_relation: { role: ROLE_SUBITEM } } as never, {
          cctx: CTX,
          row: ROW,
        }),
      ),
    ).toContain('r.target_id = e.id');
  });
});

// Ф-Б1-19: чекер обещает, что момент читается В ТАЙМЗОНЕ ВЛАДЕЛЬЦА, а сравнение timestamptz
// с `'…'::date` Postgres делает в СЕССИОННОЙ зоне — на границе суток это разные ответы.
describe('дата против момента: календарный день владельца (Ф-Б1-19)', () => {
  const ctx = ctxOf({ timeZone: 'Europe/Moscow', today: '2026-07-03' });
  const cmp = (op: '<' | '=', left: string): ExprNode => ({
    op,
    args: [{ prop: left }, { ctx: '$today' }],
  });

  test('timestamp против $today — обе стороны приведены к дню владельца', () => {
    // Момент 2026-07-02T23:30Z — это уже 3 июля по Москве, то есть СЕГОДНЯ и не просрочено.
    // Сессионная зона (UTC) назвала бы его вчерашним, и просроченным стало бы дело,
    // назначенное на сегодняшнее утро владельца.
    expect(sqlOf(compileExprPredicate(cmp('<', 'orbis/start_at'), { cctx: ctx, row: ROW }))).toBe(
      `((e.props->>'orbis/start_at')::timestamptz AT TIME ZONE $1)::date < $2::date`,
    );
  });

  test('date против $today — как было: приводить нечего, зона ни при чём', () => {
    expect(sqlOf(compileExprPredicate(cmp('=', 'orbis/due_date'), { cctx: ctx, row: ROW }))).toBe(
      `(e.props->>'orbis/due_date')::date = $1::date`,
    );
  });

  test('момент против момента — оба timestamptz, приведения к дню НЕТ', () => {
    const both: ExprNode = {
      op: '<',
      args: [{ prop: 'orbis/start_at' }, { prop: 'orbis/end_at' }],
    };
    expect(sqlOf(compileExprPredicate(both, { cctx: ctx, row: ROW }))).not.toContain(
      'AT TIME ZONE',
    );
  });
});

/** `$self` против ссылочного свойства: обе стороны текстовые, иначе Postgres 42883 (B2 M-2). */
test('$self компилируется текстом — сравнение со ссылочным свойством законно', () => {
  expect(
    sqlOf(
      compileExprPredicate(
        { op: '=', args: [{ ctx: '$self' }, { prop: 'orbis/finance_category' }] },
        { cctx: CTX, row: ROW },
      ),
    ),
  ).toBe(`e.id::text = e.props->>'orbis/finance_category'`);
});

/**
 * ПАРИТЕТ ГЕЙТА ЗАПИСИ И SQL-БЭКЕНДА (находка B2 I-2, §Б3-4). Чекер типизирует булев узел-значение
 * (`{prop}`/`{slot}`) и оператор `if` как `boolean` и пропускает декларацию на записи, а бэкенд
 * предикатов отвечал `EXPR_BACKEND_UNSUPPORTED` — то есть отказ приходил владельцу на ЧТЕНИИ
 * поверхности, а не автору декларации (Р-И-7). Инвариант написан «одним вердиктом»: обе стороны
 * обязаны отвечать одинаково, каким бы способом ни закрывали расхождение.
 */
describe('паритет гейта записи и SQL-бэкенда (B2 I-2)', () => {
  const accepts = (fn: () => unknown): boolean => {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  };
  const OPEN: ExprNode = {
    op: 'in',
    args: [{ class: { contract: 'orbis/completable' } }, { const: 'open' }],
  };
  const scopeOf = (contract: string): ExprScope => ({
    reg: { properties: CTX.reg.properties, contracts: CTX.reg.contracts },
    contract,
    params: {},
    allowDeref: false,
  });
  const BOOL_PROP: ExprNode = { op: 'and', args: [OPEN, { prop: 'orbis/all_day' }] };
  const IF_NODE: ExprNode = {
    op: 'if',
    args: [
      { has: 'orbis/due_date' },
      { op: '<', args: [{ prop: 'orbis/due_date' }, { ctx: '$today' }] },
      { const: false },
    ],
  };
  const BOOL_SLOT: ExprNode = { slot: 'planned' };

  test.each([
    ['булев {prop} предикатом', BOOL_PROP, 'orbis/when', () => compileExprPredicate(BOOL_PROP, { cctx: CTX, row: ROW })],
    ['оператор if предикатом', IF_NODE, 'orbis/when', () => compileExprPredicate(IF_NODE, { cctx: CTX, row: ROW })],
    [
      'булев {slot} предикатом',
      BOOL_SLOT,
      'orbis/money-movement',
      () => compileContractPredicate('orbis/money-movement', BOOL_SLOT, CTX, ROW),
    ],
  ])('%s: запись и чтение отвечают одинаково', (_name, expr, contract, compile) => {
    expect(accepts(() => checkExpr(expr as ExprNode, scopeOf(contract as string)))).toBe(
      accepts(compile as () => unknown),
    );
  });

  // ТОТАЛЬНОСТЬ — ОТДЕЛЬНЫМ ПИНОМ: инвариант выше её не ловит (значение без COALESCE даёт NULL,
  // и строка молча выпадает из выдачи вместо честного «не член»).
  test('булев узел-значение тотален, if — CASE WHEN', () => {
    expect(sqlOf(compileExprPredicate({ prop: 'orbis/all_day' }, { cctx: CTX, row: ROW }))).toBe(
      `COALESCE((e.props->>'orbis/all_day')::boolean, false)`,
    );
    expect(
      sqlOf(
        compileExprPredicate(
          { op: 'if', args: [{ has: 'orbis/due_date' }, { const: true }, { const: false }] },
          { cctx: CTX, row: ROW },
        ),
      ),
    ).toContain('CASE WHEN');
  });

  test('небулево свойство в предикатной позиции — EXPR_SHAPE, а не ошибка Postgres', () => {
    expect(refusal(() => compileExprPredicate({ prop: 'orbis/title' }, { cctx: CTX, row: ROW })))
      .toMatchObject({ code: 'VALIDATION', reason: 'EXPR_SHAPE' });
  });
});
