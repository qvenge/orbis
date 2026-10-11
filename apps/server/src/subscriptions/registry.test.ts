// apps/server/src/subscriptions/registry.test.ts
// Валидатор декларации подписки (§Б5-1, §Б5-2) и чтение декларации из снимка.
// Чистые describe: вход это готовый снимок реестра и литерал декларации, живая база к ответу
// ничего не добавляет. Против БД — только строгость чтения строки и снимок.
//
// ОБРАЗЕЦ ДВИЖКА — БЮДЖЕТ (спека 1в §6.5): до 1в проверки этого файла держала декларация Повестки;
// её движок снят, и каждая проверка перевыражена на `BUDGET_DEF` с тем же смыслом (позиции E, сырая
// ссылка, отказы записи, поверхность). Разрешение слота у записи (`SLOT_AMBIGUOUS`, §С8-21) для
// Бюджета пинит `bindingForEntity` (`budget.test.ts`, остаток 40).
import { afterAll, describe, expect, test } from 'bun:test';
import {
  BUDGET_DEF,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  BUILTIN_SUBSCRIPTION_DEFS,
  type BudgetSubscription,
  SURFACE_ENGINE,
  SURFACES,
  subscriptionDefinitionSchema,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, mintGraph, personal, requireEnv } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { effectiveRegistry } from '../registry/cache';
import { loadRegistryRows, type RegistrySnapshot, type SubscriptionRow } from '../registry/load';
import { assertSubscription, builtinSubscription, exprSitesOf, rawValueRefs } from './registry';

requireEnv();

const { db, client } = appDb();

afterAll(async () => {
  await client.end();
});

/** Снимок «как из БД» без единой строки владельца: встроенные словари и обе версии. */
function snapshot(): RegistrySnapshot {
  return {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
    subscriptions: new Map(),
    actions: new Map(),
    ownerVersion: 1,
    systemVersion: 1,
  };
}

/**
 * Строка подписки вокруг декларации: валидатор смотрит и на неё (поверхность, id в отказе).
 * `definition` — `unknown` с кастом: тип строки после разбора на чтении (`load.ts`) обещает уже
 * РАЗОБРАННУЮ форму, а сюда нарочно подсовывают кривые декларации — ровно их валидатор и обязан
 * отвергнуть. Каст один здесь, а не `as never` в каждом из двенадцати вызовов.
 */
function row(definition: unknown, over: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: 'orbis/budget-overview',
    graphId: null,
    surface: 'finance/budget-overview',
    definition,
    module: 'finance',
    rank: 1,
    ...over,
  } as SubscriptionRow;
}

/** Где в декларации Бюджета стоит `where` суммы `spent` — точка, в которую тесты подкладывают предикаты. */
const SPENT = BUDGET_DEF.aggregates.spent as Extract<
  BudgetSubscription['aggregates'][string],
  { kind: 'sum' }
>;
/** Декларация Бюджета с другим `where` у `spent`; `unknown` — сюда нарочно кладут и кривое. */
const withSpentWhere = (where: unknown): unknown => ({
  ...BUDGET_DEF,
  aggregates: { ...BUDGET_DEF.aggregates, spent: { ...SPENT, where } },
});

/** Отказ ЦЕЛИКОМ — когда проверяются не только код и причина, но и адресные поля деталей. */
function failure(fn: () => unknown): ExecError {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof ExecError)) throw e;
    return e;
  }
  throw new Error('ожидался отказ, его не было');
}

/** Код отказа и его ПРИЧИНА: коды реформы закрыты (errors.ts), причина едет в details. */
function refusal(fn: () => unknown): { code: string; reason: string } {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof ExecError)) throw e;
    return { code: e.code, reason: (e.details as { reason?: string }).reason ?? '' };
  }
  throw new Error('ожидался отказ, его не было');
}

describe('позиции языка E в декларации и сырые ссылки (§Б5-2)', () => {
  test('budget: позиции E с путями — фазы, формулы, where сумм и списков, окна списков', () => {
    expect(exprSitesOf(BUDGET_DEF).map((s) => s.path)).toEqual([
      'phases.upcoming',
      'phases.closed',
      'phases.active',
      'aggregates.spent.where',
      'aggregates.effective_limit.expr',
      'aggregates.remaining.expr',
      'aggregates.daily_pace.expr',
      'aggregates.unbudgeted.where',
      'lists.coming_up.window.from',
      'lists.coming_up.window.to',
      'lists.planned.where',
    ]);
  });
  test('{prop} внутри where — сырая ссылка, её путь уезжает в пометку raw_value диффа Ш1', () => {
    const where = {
      op: 'and',
      args: [SPENT.where, { op: '!=', args: [{ prop: 'orbis/payment_method' }, { const: 'нал' }] }],
    };
    expect(rawValueRefs(withSpentWhere(where) as never)).toEqual([
      'aggregates.spent.where.args.1.args.0',
    ]);
  });
  test('deref по слоту сырой ссылкой НЕ считается: read — адрес свойства по построению', () => {
    const closed = {
      op: '=',
      args: [{ deref: { slot: 'category', read: 'orbis/title' } }, { const: 'Еда' }],
    };
    expect(
      rawValueRefs({ ...BUDGET_DEF, phases: { ...BUDGET_DEF.phases, closed } } as never),
    ).toEqual([]);
  });
  test('{has} по id свойства — тоже сырая ссылка; {has} по имени слота — нет', () => {
    // Узел `has` один, а смысла у него два (`expr/check.ts`): в области с контрактом он принимает и id
    // свойства, и имя слота. Различает их форма имени — слот слаг, id свойства несёт `/`.
    const byProp = { op: 'and', args: [SPENT.where, { has: 'orbis/payment_method' }] };
    expect(rawValueRefs(withSpentWhere(byProp) as never)).toEqual([
      'aggregates.spent.where.args.1',
    ]);
    const bySlot = { op: 'and', args: [SPENT.where, { has: 'counterparty' }] };
    expect(rawValueRefs(withSpentWhere(bySlot) as never)).toEqual([]);
  });
});

describe('валидатор подписки: SURFACE_UNKNOWN / SUBSCRIPTION_RAW_REF / raw_value', () => {
  const seed = { reg: snapshot(), systemSeed: true };
  test('поверхность вне словаря — SURFACE_UNKNOWN', () => {
    expect(
      refusal(() => assertSubscription(row(BUDGET_DEF, { surface: 'core/row' }), seed)).code,
    ).toBe('SURFACE_UNKNOWN');
  });
  test('строка в E-позиции — SECOND_LANGUAGE с путём, а не «форма не разобралась»', () => {
    const def = {
      ...BUDGET_DEF,
      phases: { ...BUDGET_DEF.phases, closed: 'сегодня позже конца периода' },
    };
    expect(failure(() => assertSubscription(row(def), seed))).toMatchObject({
      code: 'SECOND_LANGUAGE',
      details: { path: 'phases.closed' },
    });
  });
  test('кривая форма — VALIDATION/SUBSCRIPTION_MALFORMED', () => {
    const { rollup: _rollup, ...def } = BUDGET_DEF;
    expect(refusal(() => assertSubscription(row(def), seed))).toEqual({
      code: 'VALIDATION',
      reason: 'SUBSCRIPTION_MALFORMED',
    });
  });
  test('Повестки нет (1в §6.5): core/agenda и прежнее имя — SURFACE_UNKNOWN, движка agenda нет', () => {
    // Повестка — запись поставки из блоков: подписка на её прежнюю поверхность была бы настройкой,
    // которую никто не читает. Голова `core` по-прежнему законна (`SURFACE_RE`), отказывает словарь.
    expect(Object.keys(SURFACE_ENGINE)).toEqual(['finance/budget-overview']);
    for (const surface of ['core/agenda', 'planner/agenda']) {
      expect(refusal(() => assertSubscription(row(BUDGET_DEF, { surface }), seed)).code).toBe(
        'SURFACE_UNKNOWN',
      );
    }
    // Прежняя декларация Повестки у своей бывшей поверхности не доходит даже до формы.
    expect(
      refusal(() =>
        assertSubscription(
          row({ engine: 'agenda' }, { id: 'user/моя-повестка', surface: 'core/agenda' }),
          seed,
        ),
      ).code,
    ).toBe('SURFACE_UNKNOWN');
  });
  test('законная системная декларация проходит и возвращает разобранную форму', () => {
    expect(assertSubscription(row(BUDGET_DEF), seed).engine).toBe('budget');
  });
  test('движок против поверхности: таблица SURFACE_ENGINE называет только движки союза', () => {
    // Отказ SUBSCRIPTION_ENGINE_SURFACE с одним движком не достижим: союз `engine` — одна ветка, и
    // единственная поверхность обслуживается ею. Проверка в `assertSubscription` оставлена — она
    // встаёт на пути следующего движка; здесь пинится её опора: каждый движок таблицы — ветка союза,
    // иначе декларация «своей» поверхности отказывала бы формой, а не адресной причиной.
    const engines = subscriptionDefinitionSchema.options.map((o) => o.shape.engine.value);
    expect(engines).toEqual(['budget']);
    for (const s of SURFACES) expect(engines).toContain(SURFACE_ENGINE[s]);
    // Чужой движок на поверхности Бюджета — отказ формой (ветки нет), а не молчание.
    expect(
      refusal(() => assertSubscription(row({ ...BUDGET_DEF, engine: 'agenda' }), seed)),
    ).toEqual({ code: 'VALIDATION', reason: 'SUBSCRIPTION_MALFORMED' });
  });
  test('counted_set вне наборов контракта — SUBSCRIPTION_UNKNOWN_SET', () => {
    const def = {
      ...BUDGET_DEF,
      sources: {
        ...BUDGET_DEF.sources,
        movement: { ...BUDGET_DEF.sources.movement, counted_set: 'нет-такого' },
      },
    };
    expect(
      refusal(() => assertSubscription(row(def, { surface: 'finance/budget-overview' }), seed)),
    ).toEqual({ code: 'VALIDATION', reason: 'SUBSCRIPTION_UNKNOWN_SET' });
  });
  test('SUBSCRIPTION_UNKNOWN_SET НАЗЫВАЕТ контракт — по нему писатель наборов узнаёт СВОЮ поломку', () => {
    // Это вход второй ветки критерия `assertSetsFreeOfSubscribers` (`registry/ops.ts`): обход
    // дерева разбирает известные формы ссылки, а всё остальное ловится по ОТКАЗУ, называющему
    // контракт. Без `details.contract` отказ говорит «имени нет» и не отвечает на вопрос
    // «чья это правка» — писатель наборов пропускал бы форму, которой обход не знает.
    // `lists.<n>.counted_set` — та самая форма без соседнего контракта: он берётся из
    // `sources.movement`, и в отказе обязан оказаться оттуда же.
    const comingUp = BUDGET_DEF.lists.coming_up;
    if (comingUp === undefined) throw new Error('в сиде Бюджета нет списка coming_up');
    const def = {
      ...BUDGET_DEF,
      lists: { ...BUDGET_DEF.lists, coming_up: { ...comingUp, counted_set: 'нет-такого' } },
    };
    const e = failure(() =>
      assertSubscription(row(def, { surface: 'finance/budget-overview' }), seed),
    );
    expect([e.code, (e.details as { reason?: string }).reason]).toEqual([
      'VALIDATION',
      'SUBSCRIPTION_UNKNOWN_SET',
    ]);
    expect(e.details as { contract?: string; path?: string }).toMatchObject({
      contract: 'orbis/money-movement',
      path: 'lists.coming_up.counted_set',
    });
    // …и у второй позиции того же контракта контракт в отказе тот же — правило, а не случай.
    const movement = {
      ...BUDGET_DEF,
      sources: {
        ...BUDGET_DEF.sources,
        movement: { ...BUDGET_DEF.sources.movement, counted_set: 'нет-такого' },
      },
    };
    expect(
      (
        failure(() =>
          assertSubscription(row(movement, { surface: 'finance/budget-overview' }), seed),
        ).details as { contract?: string }
      ).contract,
    ).toBe('orbis/money-movement');
  });

  test('prefer с аспектом, не реализующим контракт секции, — SUBSCRIPTION_PREFER_UNBOUND', () => {
    // Операция в перечне КОНВЕРТА: приоритет, который никогда не сработает.
    const def = {
      ...BUDGET_DEF,
      sources: {
        ...BUDGET_DEF.sources,
        envelope: { ...BUDGET_DEF.sources.envelope, prefer: ['orbis/financial'] },
      },
    };
    expect(failure(() => assertSubscription(row(def), seed)).details).toMatchObject({
      reason: 'SUBSCRIPTION_PREFER_UNBOUND',
      path: 'sources.envelope.prefer',
    });
  });
  test('prefer Budget: аспекта нет — UNKNOWN_ASPECT, контракт секции не реализует — PREFER_UNBOUND', () => {
    const withPrefer = (movement: string[], envelope: string[]) => ({
      ...BUDGET_DEF,
      sources: {
        movement: { ...BUDGET_DEF.sources.movement, prefer: movement },
        envelope: { ...BUDGET_DEF.sources.envelope, prefer: envelope },
      },
    });
    const at = { surface: 'finance/budget-overview' };
    expect(
      refusal(() => assertSubscription(row(withPrefer(['user/нет'], []), at), seed)).reason,
    ).toBe('SUBSCRIPTION_UNKNOWN_ASPECT');
    // Конверт в перечне ДВИЖЕНИЯ — приоритет, который никогда не сработает (Р-24, паритет с Повесткой).
    const unbound = failure(() =>
      assertSubscription(row(withPrefer(['orbis/budget'], []), at), seed),
    );
    expect((unbound.details as { reason?: string; path?: string }).reason).toBe(
      'SUBSCRIPTION_PREFER_UNBOUND',
    );
    expect((unbound.details as { path?: string }).path).toBe('sources.movement.prefer');
    expect(
      assertSubscription(row(withPrefer(['orbis/financial'], ['orbis/budget']), at), seed).engine,
    ).toBe('budget');
  });
  test('prefer с реализующим аспектом законен — единственное место ссылки на аспект (§Б5-2)', () => {
    const def = {
      ...BUDGET_DEF,
      sources: {
        ...BUDGET_DEF.sources,
        movement: { ...BUDGET_DEF.sources.movement, prefer: ['orbis/financial'] },
      },
    };
    expect(assertSubscription(row(def), seed).engine).toBe('budget');
  });
  test('id аспекта ВНЕ prefer — SUBSCRIPTION_RAW_REF с путём и ссылкой', () => {
    const where = { op: '=', args: [{ const: 'orbis/financial' }, { const: 'orbis/financial' }] };
    expect(refusal(() => assertSubscription(row(withSpentWhere(where)), seed)).code).toBe(
      'SUBSCRIPTION_RAW_REF',
    );
  });
  test('{has} по id свойства системному сиду запрещён так же, как {prop}', () => {
    const def = withSpentWhere({ op: 'and', args: [SPENT.where, { has: 'orbis/payment_method' }] });
    expect(refusal(() => assertSubscription(row(def), seed)).code).toBe('SUBSCRIPTION_RAW_REF');
    const own = assertSubscription(row(def, { graphId: mintGraph() }), {
      reg: snapshot(),
      systemSeed: false,
    });
    expect(rawValueRefs(own)).toEqual(['aggregates.spent.where.args.1']);
  });
  test('сырой предикат по свойству: системному сиду запрещён, владельцу — помечается', () => {
    const def = withSpentWhere({
      op: 'and',
      args: [SPENT.where, { op: '!=', args: [{ prop: 'orbis/payment_method' }, { const: 'нал' }] }],
    });
    expect(refusal(() => assertSubscription(row(def), seed)).code).toBe('SUBSCRIPTION_RAW_REF');
    const own = assertSubscription(row(def, { graphId: mintGraph() }), {
      reg: snapshot(),
      systemSeed: false,
    });
    expect(rawValueRefs(own)).toEqual(['aggregates.spent.where.args.1.args.0']);
  });
});

describe('встроенный сид проходит валидатор записи (§Б5-1)', () => {
  // Сид кладёт строки МИМО `assertSubscription` (прямой INSERT в `seed-registries.ts`), поэтому
  // декларация, которую валидатор отверг бы у владельца, уехала бы в базу молча — и упала бы уже
  // на чтении снимка. Здесь список пиннится целиком: задача 9 дописывает budget в тот же массив.
  test('каждая BUILTIN_SUBSCRIPTION_DEFS законна как system-строка своей поверхности', () => {
    expect(BUILTIN_SUBSCRIPTION_DEFS.length).toBeGreaterThan(0); // не тавтология на пустом списке
    for (const s of BUILTIN_SUBSCRIPTION_DEFS) {
      const seeded = row(s.definition, {
        id: s.id,
        surface: s.surface,
        module: s.module,
        rank: s.rank,
      });
      expect(assertSubscription(seeded, { reg: snapshot(), systemSeed: true }).engine).toBe(
        s.definition.engine,
      );
    }
  });
});

describe('типы позиций E и круги ведомостей (§С8-28, §Б5-3)', () => {
  const seed = { reg: snapshot(), systemSeed: true };
  test('окно, объявленное булевым выражением, — EXPR_TYPE', () => {
    const comingUp = BUDGET_DEF.lists.coming_up;
    if (comingUp?.window === undefined) throw new Error('в сиде Бюджета нет окна coming_up');
    const lists = {
      ...BUDGET_DEF.lists,
      coming_up: { ...comingUp, window: { ...comingUp.window, to: { const: true } } },
    };
    expect(failure(() => assertSubscription(row({ ...BUDGET_DEF, lists }), seed))).toMatchObject({
      code: 'EXPR_TYPE',
    });
  });
  test('ведомости, ссылающиеся по кругу, — EXPR_RECURSION', () => {
    const aggregates = {
      ...BUDGET_DEF.aggregates,
      remaining: { kind: 'formula', scope: 'envelope', expr: { agg: 'daily_pace' } },
    };
    expect(
      refusal(() =>
        assertSubscription(
          row({ ...BUDGET_DEF, aggregates }, { surface: 'finance/budget-overview' }),
          seed,
        ),
      ).code,
    ).toBe('EXPR_RECURSION');
  });
  test('законная декларация Budget проходит целиком', () => {
    expect(
      assertSubscription(row(BUDGET_DEF, { surface: 'finance/budget-overview' }), seed).engine,
    ).toBe('budget');
  });

  /**
   * ОБЛАСТЬ `where` УЖЕ ОБЛАСТИ ГРАНИЦ (B3 I-1, вторая половина фикса). Предикат уезжает в
   * SQL-бэкенд, а тот не знает ни параметров вызова, ни разыменования: принять их на записи
   * значило бы адресовать отказ владельцу на чтении, а не автору декларации (Р-И-7).
   * Слоты контракта в этот перечень НЕ входят — их бэкенд умеет с той же правкой (`budget.ts` через
   * `compileContractPredicate`), и пин их законности стоит в `budget.test.ts`.
   */
  test('`where` без параметров и без разыменования — отказ на ЗАПИСИ', () => {
    const spent = BUDGET_DEF.aggregates.spent;
    const planned = BUDGET_DEF.lists.planned;
    if (spent === undefined || planned === undefined) throw new Error('сид Бюджета изменился');
    const withDeref = {
      ...BUDGET_DEF,
      aggregates: {
        ...BUDGET_DEF.aggregates,
        spent: {
          ...spent,
          where: {
            op: '=',
            args: [{ deref: { slot: 'category', read: 'orbis/title' } }, { const: 'Еда' }],
          },
        },
      },
    };
    const withParam = {
      ...BUDGET_DEF,
      lists: {
        ...BUDGET_DEF.lists,
        planned: {
          ...planned,
          where: { op: '>=', args: [{ slot: 'date' }, { param: 'period_start' }] },
        },
      },
    };
    for (const def of [withDeref, withParam]) {
      expect(
        refusal(() => assertSubscription(row(def, { surface: 'finance/budget-overview' }), seed))
          .code,
      ).toBe('EXPR_TYPE');
    }
    // Контроль: та же позиция со СЛОТОМ контракта по-прежнему принимается — сужение адресное.
    const withSlot = {
      ...BUDGET_DEF,
      aggregates: {
        ...BUDGET_DEF.aggregates,
        spent: { ...spent, where: { op: '>', args: [{ slot: 'amount' }, { const: '500' }] } },
      },
    };
    expect(
      assertSubscription(row(withSlot, { surface: 'finance/budget-overview' }), seed).engine,
    ).toBe('budget');
  });
});

describe('однозначность порога и границы словарей Budget (Ф-Б1-38, Ф-Б1-40в/г)', () => {
  const seed = { reg: snapshot(), systemSeed: true };
  const budget = (over: Record<string, unknown>) =>
    refusal(() =>
      assertSubscription(
        row({ ...BUDGET_DEF, ...over }, { surface: 'finance/budget-overview' }),
        seed,
      ),
    );

  test('вторая сумма конверта с bound_via — SUBSCRIPTION_ALERT_NUMERATOR, а не догадка движка', () => {
    // Числитель порога движок берёт СТРУКТУРНО (единственная сумма конверта по ребру привязки).
    // Второй кандидат означал бы бейдж, сравнивающий не ту величину, — и владелец увидел бы это
    // не отказом, а враньём счётчика.
    const aggregates = {
      ...BUDGET_DEF.aggregates,
      spent_cash: { ...BUDGET_DEF.aggregates.spent },
    };
    expect(budget({ aggregates })).toEqual({
      code: 'VALIDATION',
      reason: 'SUBSCRIPTION_ALERT_NUMERATOR',
    });
  });

  test('rollup.applies_to без числителя либо длиннее двух — SUBSCRIPTION_ALERT_DENOMINATOR', () => {
    const rollup = { ...BUDGET_DEF.rollup };
    expect(budget({ rollup: { ...rollup, applies_to: ['effective_limit'] } })).toEqual({
      code: 'VALIDATION',
      reason: 'SUBSCRIPTION_ALERT_DENOMINATOR',
    });
    expect(
      budget({ rollup: { ...rollup, applies_to: ['spent', 'effective_limit', 'remaining'] } }),
    ).toEqual({ code: 'VALIDATION', reason: 'SUBSCRIPTION_ALERT_DENOMINATOR' });
  });

  test('фаза вне словаря провода — SUBSCRIPTION_PHASE_UNKNOWN (Ф-Б1-40в)', () => {
    // Движок отдаёт фазу клиенту как есть: своё слово владельца доехало бы до трёх клиентов и
    // golden как чужой enum, то есть сломало бы разбор ответа. Фазы владельца — Б-2.
    const phases = { ...BUDGET_DEF.phases, frozen: { const: true } };
    expect(budget({ phases })).toEqual({
      code: 'VALIDATION',
      reason: 'SUBSCRIPTION_PHASE_UNKNOWN',
    });
  });

  test('фаза active с предикатом вместо остатка — отказ на записи (B3 M-1)', () => {
    // Движок трактует `active` как ОСТАТОК (`phaseOf`): дельта `active = (currency="RUB")`
    // оставила бы USD-конверт вне всех фаз, и `budget.overview` падал бы `INVARIANT` на чтении.
    const phases = {
      ...BUDGET_DEF.phases,
      active: { op: '=', args: [{ slot: 'currency' }, { const: 'RUB' }] },
    };
    expect(budget({ phases })).toEqual({
      code: 'VALIDATION',
      reason: 'SUBSCRIPTION_PHASE_ACTIVE_NOT_REMAINDER',
    });
  });

  test('формула конверта, читающая ведомость периода, — SUBSCRIPTION_PERIOD_AGG_IN_FORMULA (Ф-Б1-40г)', () => {
    // Раньше такая декларация проходила запись и падала INVARIANT на ЧТЕНИИ, у владельца.
    const aggregates = {
      ...BUDGET_DEF.aggregates,
      remaining: {
        kind: 'formula',
        scope: 'envelope',
        expr: { op: '-', args: [{ agg: 'effective_limit' }, { agg: 'period_balance' }] },
      },
    };
    expect(budget({ aggregates })).toEqual({
      code: 'VALIDATION',
      reason: 'SUBSCRIPTION_PERIOD_AGG_IN_FORMULA',
    });
  });

  /**
   * ПРОВОД ЧИТАЕТ ИМЕНА ЛИТЕРАЛАМИ (находка B3 I-2). Движок берёт `spent`/`effective_limit`/
   * `remaining` картой `WIRE_FIELDS`, оба списка — `runList(..., 'coming_up'|'planned')`, а
   * `cardKey` умеет ровно один `deref.read`. Имя, ушедшее из декларации, ломает Финансы на
   * ЧТЕНИИ (`NOT_FOUND`, `null` в непустом decimal-проводе → `formatAmount(null)` в web,
   * `EXPR_BACKEND_UNSUPPORTED` у первой же карточки) — то есть отказ приходит не автору
   * декларации. Довод Ф-Б1-40в о фазах дословно переносится на эти имена.
   */
  test.each([
    [
      'список coming_up',
      (d: BudgetSubscription) => {
        d.lists.upcoming_bills = d.lists.coming_up as never;
        delete d.lists.coming_up;
      },
      'SUBSCRIPTION_WIRE_LIST_MISSING',
    ],
    [
      'список planned',
      (d: BudgetSubscription) => {
        d.lists.manual = d.lists.planned as never;
        delete d.lists.planned;
      },
      'SUBSCRIPTION_WIRE_LIST_MISSING',
    ],
    [
      'ведомость spent',
      (d: BudgetSubscription) => {
        d.aggregates.outlay = d.aggregates.spent as never;
        delete d.aggregates.spent;
        (d.aggregates.remaining as unknown as { expr: { args: unknown[] } }).expr.args[1] = {
          agg: 'outlay',
        };
        d.rollup.applies_to = ['outlay', 'effective_limit'];
      },
      'SUBSCRIPTION_WIRE_AGG_MISSING',
    ],
    [
      'ведомость remaining',
      (d: BudgetSubscription) => {
        d.aggregates.left = d.aggregates.remaining as never;
        delete d.aggregates.remaining;
        delete d.aggregates.daily_pace;
      },
      'SUBSCRIPTION_WIRE_AGG_MISSING',
    ],
    [
      'deref.read',
      (d: BudgetSubscription) => {
        (d.cards.order_by[0] as unknown as { deref: { read: string } }).deref.read = 'orbis/icon';
      },
      'SUBSCRIPTION_WIRE_DEREF_READ',
    ],
  ])('провод пинит имя: %s', (_name, mutate, reason) => {
    const def = JSON.parse(JSON.stringify(BUDGET_DEF)) as BudgetSubscription;
    mutate(def);
    expect(
      refusal(() => assertSubscription(row(def, { surface: 'finance/budget-overview' }), seed))
        .reason,
    ).toBe(reason);
  });

  test('норматив проходит все четыре новых гейта', () => {
    expect(
      assertSubscription(row(BUDGET_DEF, { surface: 'finance/budget-overview' }), seed).engine,
    ).toBe('budget');
  });
});

describe('строгое чтение строки подписки', () => {
  const owner = mintGraph();
  test('кривая строка subscription_definitions роняет чтение реестра, а не проезжает молча', async () => {
    // Движок `agenda` снят срезом 1в: строка владельца с ним — ровно такая «кривая» строка, и её счёт
    // до миграции 0023 — дело `migrate-1v --report` (§6.5), а не молчаливого пропуска на чтении.
    const { db: admin, client: ac } = adminDb();
    await admin.execute(sql`INSERT INTO subscription_definitions (id, graph_id, surface, definition, module, rank)
      VALUES ('user/broken', ${owner}::uuid, 'core/agenda', '{"engine":"agenda"}'::jsonb, NULL, 1)`);
    await ac.end();
    await expect(
      withIdentity(db, personal(owner), (tx) => loadRegistryRows(tx, owner)),
    ).rejects.toThrow();
  });
});

describe('builtinSubscription: эффективная декларация из снимка', () => {
  const userA = mintGraph();
  test('orbis/budget-overview читается из снимка уже разобранным', async () => {
    await withIdentity(db, personal(userA), async (tx) => {
      const def = builtinSubscription(await effectiveRegistry(tx, userA), 'orbis/budget-overview');
      expect(def.engine).toBe('budget');
      expect((def as BudgetSubscription).alerts.warn_at).toBe('0.85');
    });
  });
  test('неизвестный id — NOT_FOUND, а не пустота (§С8-3)', async () => {
    await withIdentity(db, personal(userA), async (tx) => {
      const reg = await effectiveRegistry(tx, userA);
      let caught: ExecError | null = null;
      try {
        builtinSubscription(reg, 'orbis/nope');
      } catch (e) {
        caught = e as ExecError;
      }
      expect(caught).toBeInstanceOf(ExecError);
      expect(caught?.code).toBe('NOT_FOUND');
    });
  });
});
