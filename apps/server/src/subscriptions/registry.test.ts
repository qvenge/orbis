// apps/server/src/subscriptions/registry.test.ts
// Валидатор декларации подписки (§Б5-1, §Б5-2) и разрешение слота у сущности (§С8-21).
// Первые три describe — чистые: вход это готовый снимок реестра и литерал декларации, живая
// база к ответу ничего не добавляет. Четвёртый — против БД: конфликт слота живёт у СУЩНОСТИ,
// и собрать его можно только двумя настоящими привязками в реестре владельца.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  AGENDA_DEF,
  type BindingIndex,
  BUDGET_DEF,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  BUILTIN_SUBSCRIPTION_DEFS,
  bindingIndexOf,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { GATE_PLAIN_ASPECT } from '../../test/fixtures/gate-aspects';
import {
  adminDb,
  appDb,
  freshUserId,
  requireEnv,
  seedCustomAspect,
  truncateAll,
} from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { effectiveRegistry } from '../registry/cache';
import { loadRegistryRows, type RegistrySnapshot, type SubscriptionRow } from '../registry/load';
import { assertSubscription, exprSitesOf, rawValueRefs, resolveSlotOnEntity } from './registry';

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
    id: 'orbis/agenda',
    ownerId: null,
    surface: 'planner/agenda',
    definition,
    module: null,
    rank: 1,
    ...over,
  } as SubscriptionRow;
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
  test('agenda: четыре позиции E с путями', () => {
    expect(exprSitesOf(AGENDA_DEF).map((s) => s.path)).toEqual([
      'show.window.from',
      'show.window.to',
      'overdue.before',
      'overdue.where',
    ]);
  });
  test('{prop} внутри where — сырая ссылка, её путь уезжает в пометку raw_value диффа Ш1', () => {
    const where = {
      op: 'and',
      args: [
        { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: ['active'] }] },
        { op: '!=', args: [{ prop: 'orbis/task_status' }, { const: 'waiting' }] },
      ],
    };
    expect(
      rawValueRefs({ ...AGENDA_DEF, overdue: { ...AGENDA_DEF.overdue, where } } as never),
    ).toEqual(['overdue.where.args.1.args.0']);
  });
  test('deref по слоту сырой ссылкой НЕ считается: read — адрес свойства по построению', () => {
    const before = { deref: { slot: 'moment', read: 'orbis/title' } };
    expect(
      rawValueRefs({ ...AGENDA_DEF, overdue: { ...AGENDA_DEF.overdue, before } } as never),
    ).toEqual([]);
  });
  test('{has} по id свойства — тоже сырая ссылка; {has} по имени слота — нет', () => {
    // Узел `has` один, а смысла у него два (`expr/check.ts`): в области с контрактом он принимает и id
    // свойства, и имя слота. Различает их форма имени — слот слаг, id свойства несёт `/`.
    const byProp = { op: 'and', args: [AGENDA_DEF.overdue.where, { has: 'orbis/task_status' }] };
    expect(
      rawValueRefs({ ...AGENDA_DEF, overdue: { ...AGENDA_DEF.overdue, where: byProp } } as never),
    ).toEqual(['overdue.where.args.1']);
    const bySlot = { op: 'and', args: [AGENDA_DEF.overdue.where, { has: 'deadline' }] };
    expect(
      rawValueRefs({ ...AGENDA_DEF, overdue: { ...AGENDA_DEF.overdue, where: bySlot } } as never),
    ).toEqual([]);
  });
  test('budget: позиции — фазы, формулы, where сумм и окна списков', () => {
    expect(exprSitesOf(BUDGET_DEF).map((s) => s.path)).toContain('aggregates.daily_pace.expr');
  });
});

describe('валидатор подписки: SURFACE_UNKNOWN / SUBSCRIPTION_RAW_REF / raw_value', () => {
  const seed = { reg: snapshot(), systemSeed: true };
  test('поверхность вне словаря — SURFACE_UNKNOWN', () => {
    expect(
      refusal(() => assertSubscription(row(AGENDA_DEF, { surface: 'core/row' }), seed)).code,
    ).toBe('SURFACE_UNKNOWN');
  });
  test('строка в E-позиции — SECOND_LANGUAGE с путём, а не «форма не разобралась»', () => {
    const def = {
      ...AGENDA_DEF,
      overdue: { ...AGENDA_DEF.overdue, where: 'class(completable) in open' },
    };
    expect(refusal(() => assertSubscription(row(def), seed)).code).toBe('SECOND_LANGUAGE');
  });
  test('кривая форма — VALIDATION/SUBSCRIPTION_MALFORMED', () => {
    const { hide, ...def } = AGENDA_DEF;
    expect(refusal(() => assertSubscription(row(def), seed))).toEqual({
      code: 'VALIDATION',
      reason: 'SUBSCRIPTION_MALFORMED',
    });
  });
  test('законная системная декларация проходит и возвращает разобранную форму', () => {
    expect(assertSubscription(row(AGENDA_DEF), seed).engine).toBe('agenda');
  });
  test('движок, которого поверхность не обслуживает, — SUBSCRIPTION_ENGINE_SURFACE', () => {
    // Форма разбирается, ссылки целы — и всё равно отказ: иначе движок повестки получил бы форму
    // Budget уже на исполнении, у владельца, а не у автора декларации.
    expect(refusal(() => assertSubscription(row(BUDGET_DEF), seed))).toEqual({
      code: 'VALIDATION',
      reason: 'SUBSCRIPTION_ENGINE_SURFACE',
    });
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
  test('prefer с аспектом, не реализующим слот секции, — SUBSCRIPTION_PREFER_UNBOUND', () => {
    const def = { ...AGENDA_DEF, show: { ...AGENDA_DEF.show, prefer: ['orbis/note'] } };
    expect(refusal(() => assertSubscription(row(def), seed)).reason).toBe(
      'SUBSCRIPTION_PREFER_UNBOUND',
    );
  });
  test('prefer с реализующим аспектом законен — единственное место ссылки на аспект (§Б5-2)', () => {
    const def = { ...AGENDA_DEF, show: { ...AGENDA_DEF.show, prefer: ['orbis/schedule'] } };
    expect(assertSubscription(row(def), seed).engine).toBe('agenda');
  });
  test('id аспекта ВНЕ prefer — SUBSCRIPTION_RAW_REF с путём и ссылкой', () => {
    const where = { op: '=', args: [{ const: 'orbis/task' }, { const: 'orbis/task' }] };
    expect(
      refusal(() =>
        assertSubscription(row({ ...AGENDA_DEF, overdue: { ...AGENDA_DEF.overdue, where } }), seed),
      ).code,
    ).toBe('SUBSCRIPTION_RAW_REF');
  });
  test('{has} по id свойства системному сиду запрещён так же, как {prop}', () => {
    const where = { op: 'and', args: [AGENDA_DEF.overdue.where, { has: 'orbis/task_status' }] };
    const def = { ...AGENDA_DEF, overdue: { ...AGENDA_DEF.overdue, where } };
    expect(refusal(() => assertSubscription(row(def), seed)).code).toBe('SUBSCRIPTION_RAW_REF');
    const own = assertSubscription(row(def, { ownerId: freshUserId() }), {
      reg: snapshot(),
      systemSeed: false,
    });
    expect(rawValueRefs(own)).toEqual(['overdue.where.args.1']);
  });
  test('сырой предикат по свойству: системному сиду запрещён, владельцу — помечается', () => {
    const where = {
      op: 'and',
      args: [
        { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: ['active'] }] },
        { op: '!=', args: [{ prop: 'orbis/task_status' }, { const: 'waiting' }] },
      ],
    };
    const def = { ...AGENDA_DEF, overdue: { ...AGENDA_DEF.overdue, where } };
    expect(refusal(() => assertSubscription(row(def), seed)).code).toBe('SUBSCRIPTION_RAW_REF');
    const own = assertSubscription(row(def, { ownerId: freshUserId() }), {
      reg: snapshot(),
      systemSeed: false,
    });
    expect(rawValueRefs(own)).toEqual(['overdue.where.args.1.args.0']);
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
    const show = {
      ...AGENDA_DEF.show,
      window: { ...AGENDA_DEF.show.window, to: { const: true } },
    };
    expect(refusal(() => assertSubscription(row({ ...AGENDA_DEF, show }), seed)).code).toBe(
      'EXPR_TYPE',
    );
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
});

describe('SLOT_AMBIGUOUS на сущности: без prefer — отказ, с prefer — детерминированный выбор', () => {
  const owner = freshUserId();
  let idx: BindingIndex;
  let plain: string;
  let sched: string;
  beforeAll(async () => {
    await truncateAll();
    // Аспект владельца фикстуры реализует тот же слот `moment` контракта «когда», что и
    // `orbis/schedule`: две законные по отдельности привязки на одной сущности — и есть §С8-21.
    await seedCustomAspect(owner, GATE_PLAIN_ASPECT);
    idx = bindingIndexOf(await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner)));
    // Адрес свойства берётся ИЗ ПРИВЯЗКИ, а не литералом: иначе тест пинил бы форму фикстуры 0d.
    const a = idx.slotOf(GATE_PLAIN_ASPECT.key, 'orbis/when', 'moment');
    const b = idx.slotOf('orbis/schedule', 'orbis/when', 'moment');
    if (a === undefined || b === undefined || !('prop' in a) || !('prop' in b)) {
      throw new Error('фикстура: обе привязки — по свойству');
    }
    plain = a.prop;
    sched = b.prop;
  });
  const host = () => ({
    id: 'e1',
    aspects: [GATE_PLAIN_ASPECT.key, 'orbis/schedule'],
    props: { [plain]: '2026-09-01T09:00:00Z', [sched]: '2026-09-02T18:00:00Z' },
  });
  test('две привязки одного слота без prefer — SLOT_AMBIGUOUS с аспектами в details', () => {
    let caught: ExecError | null = null;
    try {
      resolveSlotOnEntity(idx, host(), 'orbis/when', 'moment', []);
    } catch (e) {
      caught = e as ExecError;
    }
    expect(caught?.code).toBe('SLOT_AMBIGUOUS');
    // Поле `subscription` (реестр §1.1) дописывает движок (задача 6, `rowOf`): чистая функция подписки не
    // знает, и лишний параметр ради одной строки отказа протаскивался бы через каждый вызов.
    expect(caught?.details).toEqual({
      contract: 'orbis/when',
      slot: 'moment',
      entityId: 'e1',
      aspects: [GATE_PLAIN_ASPECT.key, 'orbis/schedule'].sort(),
    });
  });
  test('prefer выбирает детерминированно — по порядку перечисления', () => {
    expect(
      resolveSlotOnEntity(idx, host(), 'orbis/when', 'moment', ['orbis/schedule'])?.aspectId,
    ).toBe('orbis/schedule');
    expect(
      resolveSlotOnEntity(idx, host(), 'orbis/when', 'moment', [GATE_PLAIN_ASPECT.key])?.value,
    ).toBe('2026-09-01T09:00:00Z');
  });
  test('пустой слот второй привязки конфликта не даёт (§Б2-3 частичная привязка)', () => {
    expect(
      resolveSlotOnEntity(
        idx,
        { ...host(), props: { [plain]: '2026-09-01T09:00:00Z' } },
        'orbis/when',
        'moment',
        [],
      )?.aspectId,
    ).toBe(GATE_PLAIN_ASPECT.key);
  });
  test('ни одной привязки — null, а не отказ: подписка просто не видит сущность', () => {
    expect(
      resolveSlotOnEntity(idx, { aspects: ['orbis/note'], props: {} }, 'orbis/when', 'moment', []),
    ).toBeNull();
  });
  test('кривая строка subscription_definitions роняет чтение реестра, а не проезжает молча', async () => {
    const { db: admin, client: ac } = adminDb();
    await admin.execute(sql`INSERT INTO subscription_definitions (id, owner_id, surface, definition, module, rank)
      VALUES ('user/broken', ${owner}::uuid, 'planner/agenda', '{"engine":"agenda"}'::jsonb, NULL, 1)`);
    await ac.end();
    await expect(withIdentity(db, owner, (tx) => loadRegistryRows(tx, owner))).rejects.toThrow();
  });
});
