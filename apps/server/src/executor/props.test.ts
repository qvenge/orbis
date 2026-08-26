// apps/server/src/executor/props.test.ts
// Веха B реформы: исполнитель пишет НОВУЮ правду сущности — `props` по id свойства и список
// `aspects[]` (§А1-1), а старая карта `aspects_legacy` становится её ПРОЕКЦИЕЙ. Здесь же
// стоят гейты флагов (§А2-5), ось `mechanism` (§А4-4) и вторая форма входа (РП-3).
//
// Тесты интеграционные: реальная БД под withIdentity, без моков — ровно потому, что
// проверяется СТРОКА, а не возвращённая wire-форма. Расхождение между тем, что уехало
// клиенту, и тем, что легло в колонки, — как раз тот класс дефекта, ради которого дуальная
// запись и держится под инвариантом.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  aspectJsonSchema,
  BUILTIN_ASPECT_IDS,
  buildFieldCatalog,
  newId,
  parseQuery,
} from '@orbis/shared';
import { eq, sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  freshUserId,
  requireEnv,
  seedCustomAspect,
  truncateAll,
} from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { readEntity } from '../entity-read';
import { compileQuery } from '../query/compile';
import { loadRegistry, type RegistrySnapshot } from '../registry/load';
import type { PropsViolation } from '../registry/validate-props';
import { toWireEntity, toWireEntityFromSql } from '../wire';
import { execute, touchesBudgetContour } from './executor';
import { makeChatJournalSink } from './journal';
import { projectLegacyAspects } from './legacy-form';
import { applyPropsPatch, resolvePropertyRef, touchedProperties } from './props';
import type { ExecuteOk, ExecuteRequest, ExecuteResult, WireEntity } from './types';
import { undoAction } from './undo';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const sink = makeChatJournalSink();
const T0 = new Date('2026-08-26T10:00:00.000Z');
const CATEGORY_A = '019e4466-aaaa-7e07-b5d4-64be9721da51';
const CATEGORY_B = '019e4466-bbbb-7e07-b5d4-64be9721da52';
// Своя категория у теста слитого свойства: конверт уникален по (категория, валюта, период)
// на ВЛАДЕЛЬЦА (§2.1), а владелец у файла один — чужая комбинация дала бы отказ дубля.
const CATEGORY_C = '019e4466-cccc-7e07-b5d4-64be9721da53';

/** Свободное свойство владельца, у которого id и key РАЗНЫЕ — резолв входа по обоим. */
const FREE_PROPERTY_ID = 'user/p-sleep';
const FREE_PROPERTY_KEY = 'user/sleep-hours';

let reg: RegistrySnapshot;

/** Каталог полей грамматики §6 — тот же, что собирает боевой путь запросов. */
const catalog = buildFieldCatalog(
  BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })),
);

function run(
  tool: string,
  input: unknown,
  over: Partial<ExecuteRequest> = {},
): Promise<ExecuteResult> {
  return execute(
    db,
    {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool, input }],
      clock: () => T0,
      ...over,
    },
    { sink },
  );
}

function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено ${r.error.code}: ${r.error.message}`);
  return r;
}

function entityOf(r: ExecuteResult): WireEntity {
  return ok(r).results[0] as WireEntity;
}

interface Row {
  props: Record<string, unknown>;
  aspects: string[];
  aspectsLegacy: Record<string, Record<string, unknown>>;
}

/** Три колонки строки как они легли в БД (не wire-форма — именно колонки). */
async function rowOf(id: string): Promise<Row> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx
      .select({
        props: entities.props,
        aspects: entities.aspects,
        aspectsLegacy: entities.aspectsLegacy,
      })
      .from(entities)
      .where(eq(entities.id, id)),
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`строка ${id} не найдена`);
  return {
    props: row.props as Record<string, unknown>,
    aspects: row.aspects,
    aspectsLegacy: row.aspectsLegacy as Record<string, Record<string, unknown>>,
  };
}

/**
 * Инвариант дуальной записи: старая карта — ровно проекция новой правды (§А1-1).
 *
 * Две половины, и вторая не украшение. Первая сверяет колонку с `projectLegacyAspects` —
 * той же функцией, которой пишет исполнитель, поэтому одна она поймала бы расхождение
 * ЗАПИСИ, но не порчу самой проекции (обе стороны сдвинулись бы вместе). Вторая проверяет
 * то, что от проекции НЕ зависит: ключи старой карты — ровно список аспектов строки.
 */
async function expectProjection(id: string): Promise<Row> {
  const row = await rowOf(id);
  expect(row.aspectsLegacy).toEqual(
    projectLegacyAspects(reg, { props: row.props, aspects: row.aspects }),
  );
  expect(Object.keys(row.aspectsLegacy).sort()).toEqual([...row.aspects].sort());
  return row;
}

function violationsOf(r: ExecuteResult): PropsViolation[] {
  if (r.ok) throw new Error('ожидался отказ');
  return ((r.error.details as { violations?: PropsViolation[] }).violations ??
    []) as PropsViolation[];
}

beforeAll(async () => {
  await truncateAll();
  await seedCustomAspect(owner, {
    key: 'user/sleep-log',
    label: { ru: 'Сон', en: 'Sleep' },
    properties: [{ key: 'hours', type: { kind: 'number' }, required: true }],
  });
  // Свободное свойство (§А1-2): носителя-аспекта у него нет вовсе, а id и key НЕ совпадают —
  // ровно та пара, на которой видно, что резолв входа принимает оба адреса.
  const admin = adminDb();
  try {
    await admin.db.execute(sql`
      INSERT INTO property_definitions
        (id, owner_id, key, label, description, type, status, storage, rank, flags)
      VALUES (${FREE_PROPERTY_ID}, ${owner}, ${FREE_PROPERTY_KEY},
              ${JSON.stringify({ ru: 'Часов сна' })}::jsonb,
              ${JSON.stringify({ ru: 'Сколько часов владелец спал' })}::jsonb,
              ${JSON.stringify({ kind: 'number' })}::jsonb, 'active', 'props', 100, '{}'::jsonb)
      ON CONFLICT (owner_id, id) WHERE owner_id IS NOT NULL DO NOTHING`);
  } finally {
    await admin.client.end();
  }
  reg = await withIdentity(db, owner, (tx) => loadRegistry(tx, owner));
});

afterAll(async () => {
  await truncateAll();
  await client.end();
});

// ---------------------------------------------------------------------------
// Что легло в строку
// ---------------------------------------------------------------------------

describe('исполнитель пишет props/aspects[] (§А1-1)', () => {
  test('entity_create со старым патчем aspects → props по id, aspects[] и aspects_legacy = projectLegacyAspects(props, aspects)', async () => {
    const e = entityOf(
      await run('entity_create', {
        title: 'Покупка кофе',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: '340.00',
            currency: 'RUB',
            direction: 'expense',
            category_ref: CATEGORY_A,
            occurred_on: '2026-08-26',
          },
        },
      }),
    );

    const row = await expectProjection(e.id);
    // Значения адресуются id СВОЙСТВА, а не парой «аспект + поле»
    expect(row.props).toEqual({
      'orbis/amount': '340.00',
      'orbis/currency': 'RUB',
      'orbis/direction': 'expense',
      'orbis/finance_category': CATEGORY_A,
      'orbis/occurred_on': '2026-08-26',
    });
    expect(row.aspects).toEqual(['orbis/financial']);
    // Старая карта не исчезла и не разъехалась: её пишет проекция (дуальная запись до 23)
    expect(row.aspectsLegacy['orbis/financial']).toEqual({
      amount: '340.00',
      currency: 'RUB',
      direction: 'expense',
      category_ref: CATEGORY_A,
      occurred_on: '2026-08-26',
    });
    // Мешок `meta` больше не пишется вовсе (§А1-1): колонка доживает до 0017 пустой
    expect(e.meta).toEqual({});
  });

  test('entity_create с новой формой {props, aspects:[…]} (exec-вход) → та же строка; key и id принимаются', async () => {
    const legacy = entityOf(
      await run('entity_create', {
        title: 'Обед',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: '500.00',
            direction: 'expense',
            category_ref: CATEGORY_A,
            occurred_on: '2026-08-26',
          },
        },
      }),
    );
    const fresh = entityOf(
      await run('entity_create', {
        title: 'Обед',
        tags: [],
        props: {
          'orbis/amount': '500.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': CATEGORY_A,
          'orbis/occurred_on': '2026-08-26',
        },
        aspects: ['orbis/financial'],
      }),
    );

    const a = await expectProjection(legacy.id);
    const b = await expectProjection(fresh.id);
    // Валюта подставлена умолчанием у конверта, а не у транзакции — обе строки совпадают
    expect(b.props).toEqual(a.props);
    expect(b.aspects).toEqual(a.aspects);
    expect(b.aspectsLegacy).toEqual(a.aspectsLegacy);

    // Тот же адрес — двумя именами: id свойства и его key (у своего свойства они разные)
    const byId = entityOf(
      await run('entity_create', {
        title: 'Сон по id',
        tags: [],
        props: { [FREE_PROPERTY_ID]: 7 },
      }),
    );
    const byKey = entityOf(
      await run('entity_create', {
        title: 'Сон по key',
        tags: [],
        props: { [FREE_PROPERTY_KEY]: 7 },
      }),
    );
    expect((await rowOf(byId.id)).props).toEqual({ [FREE_PROPERTY_ID]: 7 });
    expect((await rowOf(byKey.id)).props).toEqual({ [FREE_PROPERTY_ID]: 7 });
    // Свободное свойство (§А1-2) живёт без аспекта — и в старую карту не течёт
    expect((await rowOf(byKey.id)).aspectsLegacy).toEqual({});
  });

  test('detach аспекта оставляет значения свойств (Р9); explicit unset снимает свойство', async () => {
    const e = entityOf(
      await run('entity_create', {
        title: 'Такси',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: '700.00',
            direction: 'expense',
            category_ref: CATEGORY_A,
            occurred_on: '2026-08-26',
          },
        },
      }),
    );

    ok(await run('entity_update', { id: e.id, aspects: { 'orbis/financial': null } }));
    const afterDetach = await expectProjection(e.id);
    expect(afterDetach.aspects).toEqual([]);
    // Значение суммы — факт владельца, а не собственность аспекта (Р9)
    expect(afterDetach.props['orbis/amount']).toBe('700.00');
    // В старой карте его больше нет: носителя не осталось
    expect(afterDetach.aspectsLegacy).toEqual({});

    ok(await run('entity_update', { id: e.id, unset: ['orbis/amount'] }));
    const afterUnset = await expectProjection(e.id);
    expect(Object.hasOwn(afterUnset.props, 'orbis/amount')).toBe(false);
    expect(afterUnset.props['orbis/direction']).toBe('expense');
  });

  test('financial+budget с разной category_ref в одном create → VALIDATION (В1)', async () => {
    const r = await run('entity_create', {
      title: 'Конверт и трата разом',
      tags: [],
      aspects: {
        'orbis/financial': {
          amount: '100.00',
          direction: 'expense',
          category_ref: CATEGORY_A,
          occurred_on: '2026-08-26',
        },
        'orbis/budget': {
          category_ref: CATEGORY_B,
          limit: '5000.00',
          period_start: '2026-08-01',
          period_end: '2026-08-31',
        },
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('VALIDATION');
    expect((r.error.details as { reason?: string }).reason).toBe('merged_property_conflict');
    expect((r.error.details as { property?: string }).property).toBe('orbis/finance_category');
  });
});

// ---------------------------------------------------------------------------
// Инвариант проекции под случайными патчами
// ---------------------------------------------------------------------------

describe('инвариант дуальной записи', () => {
  test('после КАЖДОЙ мутации (create/update/attach/detach/undo) aspects_legacy === projectLegacyAspects(props, aspects) — 50 случайных патчей', async () => {
    // Генератор детерминированный: упавший прогон обязан воспроизводиться, а не «иногда».
    let seed = 20260826;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T => {
      const v = items[Math.floor(rnd() * items.length)];
      if (v === undefined) throw new Error('пустой список выбора');
      return v;
    };

    const STATUSES = ['inbox', 'planned', 'in_progress', 'waiting', 'done', 'cancelled'] as const;
    const PRIORITIES = ['low', 'medium', 'high'] as const;
    const AMOUNTS = ['10.00', '340.50', '1000.00'] as const;

    /** Валидный патч старой формы: у аспекта, который НАВЕШИВАЕТСЯ, обязательные всегда есть. */
    const legacyPatch = (): Record<string, Record<string, unknown> | null> => {
      switch (Math.floor(rnd() * 5)) {
        case 0:
          return { 'orbis/task': { status: pick(STATUSES), priority: pick(PRIORITIES) } };
        case 1:
          return { 'orbis/task': { priority: null } };
        case 2:
          return { 'orbis/note': { pinned: rnd() > 0.5 } };
        case 3:
          return {
            'orbis/financial': {
              amount: pick(AMOUNTS),
              direction: pick(['expense', 'income'] as const),
              category_ref: pick([CATEGORY_A, CATEGORY_B] as const),
              occurred_on: '2026-08-26',
            },
          };
        default:
          return { 'orbis/financial': null };
      }
    };

    const e = entityOf(
      await run('entity_create', {
        title: 'Подопытная запись',
        tags: [],
        aspects: { 'orbis/task': { status: 'inbox' } },
      }),
    );
    await expectProjection(e.id);

    let applied = 0;
    let lastActionId: string | undefined;
    for (let i = 0; i < 50; i++) {
      const roll = rnd();
      if (roll < 0.15 && lastActionId !== undefined) {
        // Откат последнего действия — тоже мутация, и инвариант обязан пережить её
        const undone = await undoAction(db, { actorUserId: owner, actionId: lastActionId });
        expect(undone.ok).toBe(true);
        lastActionId = undefined;
      } else if (roll < 0.3) {
        const r = ok(
          await run('attach_orbis_note', { entity_id: e.id, data: { pinned: rnd() > 0.5 } }),
        );
        lastActionId = r.actionId;
      } else {
        const r = ok(await run('entity_update', { id: e.id, aspects: legacyPatch() }));
        lastActionId = r.actionId;
      }
      applied += 1;
      await expectProjection(e.id);
    }
    expect(applied).toBe(50);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Гейты флагов (§А2-5) и ось mechanism (§А4-4)
// ---------------------------------------------------------------------------

describe('гейты флагов свойств', () => {
  const goalInput = (over: Record<string, unknown> = {}) => ({
    title: 'Накопить',
    tags: [],
    aspects: {
      'orbis/goal': {
        progress_source: { query: 'aspect=orbis/financial', aggregate: 'count' },
        target_value: '300000.00',
        ...over,
      },
    },
  });

  test('запись orbis/current_value из тула → COMPUTED_WRITE; из mechanism rule — проходит', async () => {
    const denied = await run('entity_create', goalInput({ current_value: '10' }));
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('COMPUTED_WRITE');
    expect(denied.error.details).toMatchObject({
      property: 'orbis/current_value',
      mechanism: 'user',
      reason: 'model_writable',
    });

    // Кэш вычисления пишет правило каталога — и только оно (правило 3 §10)
    const allowed = await run('entity_create', goalInput({ current_value: '10' }), {
      mechanism: 'rule',
    });
    const row = await expectProjection(entityOf(allowed).id);
    expect(row.props['orbis/current_value']).toBe('10');

    // Цель БЕЗ кэша заводится обычным путём: гейт смотрит на свойство, а не на аспект
    ok(await run('entity_create', goalInput()));
  });

  test('запись orbis/run_report с mechanism user → COMPUTED_WRITE (system_writable); с mechanism verb — проходит', async () => {
    const routineId = newId();
    const run0 = entityOf(
      await run(
        'entity_create',
        {
          title: 'Прогон рутины',
          tags: [],
          aspects: {
            'orbis/agent-run': {
              routine_id: routineId,
              outcome: 'running',
              started_at: '2026-08-26T07:00:00.000Z',
              last_step_at: '2026-08-26T07:00:00.000Z',
              step_count: 0,
              steps: [],
            },
          },
        },
        { mechanism: 'verb' },
      ),
    );

    const denied = await run('entity_update', {
      id: run0.id,
      aspects: { 'orbis/agent-run': { report: 'подделанный отчёт' } },
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('COMPUTED_WRITE');
    expect(denied.error.details).toMatchObject({
      property: 'orbis/run_report',
      mechanism: 'user',
      reason: 'system_writable',
    });

    ok(
      await run(
        'entity_update',
        { id: run0.id, aspects: { 'orbis/agent-run': { report: 'честный отчёт' } } },
        { mechanism: 'verb' },
      ),
    );
    const row = await expectProjection(run0.id);
    expect(row.props['orbis/run_report']).toBe('честный отчёт');
  });

  test('ЯВНОЕ снятие служебного свойства из тула → COMPUTED_WRITE обеими формами; из verb — проходит', async () => {
    const routineId = newId();
    const created = entityOf(
      await run(
        'entity_create',
        {
          title: 'Прогон с отчётом',
          tags: [],
          aspects: {
            'orbis/agent-run': {
              routine_id: routineId,
              outcome: 'finished',
              report: 'честный отчёт',
              started_at: '2026-08-26T07:00:00.000Z',
              last_step_at: '2026-08-26T07:00:00.000Z',
              step_count: 0,
              steps: [],
            },
          },
        },
        { mechanism: 'verb' },
      ),
    );

    // Форма НОВАЯ: `unset` по id свойства
    const byUnset = await run('entity_update', { id: created.id, unset: ['orbis/run_report'] });
    expect(byUnset.ok).toBe(false);
    if (byUnset.ok) return;
    expect(byUnset.error.code).toBe('COMPUTED_WRITE');
    expect(byUnset.error.details).toMatchObject({
      property: 'orbis/run_report',
      mechanism: 'user',
      reason: 'system_writable',
    });

    // Форма СТАРАЯ: `{поле: null}` в карте аспектов — тот же отказ, тот же reason
    const byNull = await run('entity_update', {
      id: created.id,
      aspects: { 'orbis/agent-run': { report: null } },
    });
    expect(byNull.ok).toBe(false);
    if (byNull.ok) return;
    expect(byNull.error.code).toBe('COMPUTED_WRITE');
    expect(byNull.error.details).toMatchObject({
      property: 'orbis/run_report',
      reason: 'system_writable',
    });

    // Вычисляемое свойство — тем же гейтом: снять кэш правила тулу тоже нельзя
    const goal = entityOf(
      await run(
        'entity_create',
        {
          title: 'Цель с кэшем',
          tags: [],
          aspects: {
            'orbis/goal': {
              progress_source: { query: 'aspect=orbis/financial', aggregate: 'count' },
              target_value: '10',
              current_value: '3',
            },
          },
        },
        { mechanism: 'rule' },
      ),
    );
    const byComputed = await run('entity_update', {
      id: goal.id,
      unset: ['orbis/current_value'],
    });
    expect(byComputed.ok).toBe(false);
    if (byComputed.ok) return;
    expect(byComputed.error.details).toMatchObject({ reason: 'model_writable' });

    // Значение на месте — ни одна из трёх проб ничего не стёрла
    expect((await expectProjection(created.id)).props['orbis/run_report']).toBe('честный отчёт');
    expect((await expectProjection(goal.id)).props['orbis/current_value']).toBe('3');

    // Тот же глагол, которому свойство принадлежит, снимает его без препятствий
    ok(
      await run(
        'entity_update',
        { id: created.id, unset: ['orbis/run_report'] },
        { mechanism: 'verb' },
      ),
    );
    expect(Object.hasOwn((await expectProjection(created.id)).props, 'orbis/run_report')).toBe(
      false,
    );
  });

  test('замена носителя (attach) не стирает служебное значение, но снимает свои: bank_txn_id переживает attach_orbis_financial', async () => {
    const imported = entityOf(
      await run(
        'entity_create',
        {
          title: 'Операция из выписки',
          tags: [],
          aspects: {
            'orbis/financial': {
              amount: '1200.00',
              direction: 'expense',
              category_ref: CATEGORY_A,
              occurred_on: '2026-08-20',
              payment_method: 'карта',
              bank_txn_id: 'BNK-42',
            },
          },
        },
        { mechanism: 'import' },
      ),
    );

    // attach заменяет носитель ЦЕЛИКОМ и приходит от лица владельца, но `bank_txn_id` он НЕ
    // НАЗЫВАЕТ — значит и снятие его не распоряжение автора.
    ok(
      await run('attach_orbis_financial', {
        entity_id: imported.id,
        data: {
          amount: '1500.00',
          direction: 'expense',
          category_ref: CATEGORY_A,
          occurred_on: '2026-08-20',
        },
      }),
    );

    const row = await expectProjection(imported.id);
    expect(row.props['orbis/amount']).toBe('1500.00');
    // Импортное тождество переживает навешивание аспекта…
    expect(row.props['orbis/bank_txn_id']).toBe('BNK-42');
    // …а СВОЁ поле, которого в `data` не было, замена честно снимает
    expect(Object.hasOwn(row.props, 'orbis/payment_method')).toBe(false);
    // …и его больше нет в старой карте: проекция и колонка сходятся (проверено выше)
    expect(row.aspectsLegacy['orbis/financial']).toMatchObject({ bank_txn_id: 'BNK-42' });

    // Фильтр — ТОЛЬКО про неназванное поле. Назвал явно — дошёл до гейта: схема
    // `attach_*`-тула служебные поля пока пропускает (вывод их из `attach_*` — Задача 12),
    // и отбивает их именно право записи, а не форма входа.
    const named = await run('attach_orbis_financial', {
      entity_id: imported.id,
      data: {
        amount: '1500.00',
        direction: 'expense',
        category_ref: CATEGORY_A,
        occurred_on: '2026-08-20',
        bank_txn_id: 'ПОДДЕЛКА',
      },
    });
    expect(named.ok).toBe(false);
    if (named.ok) return;
    expect(named.error.code).toBe('COMPUTED_WRITE');
    expect(named.error.details).toMatchObject({
      property: 'orbis/bank_txn_id',
      reason: 'system_writable',
    });
    expect((await rowOf(imported.id)).props['orbis/bank_txn_id']).toBe('BNK-42');
  });

  test('замена носителя не стирает СЛИТОЕ свойство, объявленное остающимся аспектом (В1)', async () => {
    // `orbis/finance_category` и `orbis/currency` объявлены И транзакцией, и конвертом (В1).
    // `attach_orbis_budget` заменяет носитель целиком и их во входе НЕ несёт — но снимать
    // их нельзя: они принадлежат и `orbis/financial`, который остаётся на записи. Снятие
    // сделало бы законный attach отказом `REQUIRED` (оба аспекта требуют категорию) и
    // заодно стёрло бы факт владельца у чужого носителя.
    const e = entityOf(
      await run('entity_create', {
        title: 'Трата, ставшая конвертом',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: '900.00',
            direction: 'expense',
            category_ref: CATEGORY_C,
            // Валюта НЕДЕФОЛТНАЯ намеренно. У обоих аспектов она необязательна, а
            // `normalizeEnvelopeProps` подставляет на место пропавшего значения умолчание
            // владельца (RUB): с 'RUB' в фикстуре currency-ассерты проходили бы и с вырезанной
            // защитой — стёртую валюту молча восстанавливала бы подстановка, и половина пина
            // оказалась бы вакуумной (найдено УЗКОЙ мутацией: защита снята только с валюты).
            currency: 'USD',
            // Дата ВНЕ периода конверта ниже: иначе бюджет-хук выбрал бы конвертом саму
            // запись (слитые категория и валюта совпадают по построению) и упал бы
            // `self_relation` — маскируя проверяемое здесь.
            occurred_on: '2026-08-26',
          },
        },
      }),
    );

    ok(
      await run('attach_orbis_budget', {
        entity_id: e.id,
        data: { limit: '30000.00', period_start: '2026-11-01', period_end: '2026-11-30' },
      }),
    );

    const row = await expectProjection(e.id);
    expect(row.props['orbis/finance_category']).toBe(CATEGORY_C);
    expect(row.props['orbis/currency']).toBe('USD');
    expect(row.aspects.sort()).toEqual(['orbis/budget', 'orbis/financial']);
    // Одно значение — два носителя: старая карта показывает его у обоих аспектов
    expect(row.aspectsLegacy['orbis/financial']).toMatchObject({
      category_ref: CATEGORY_C,
      currency: 'USD',
    });
    expect(row.aspectsLegacy['orbis/budget']).toMatchObject({
      category_ref: CATEGORY_C,
      currency: 'USD',
      period_start: '2026-11-01',
    });
    // …а СВОЁ поле транзакции, которого у конверта нет вовсе, замена не трогает тем более
    expect(row.props['orbis/occurred_on']).toBe('2026-08-26');
  });

  test('замена с НОВЫМ периодом не переносит carryover прошлого периода (03-budget §2.6)', async () => {
    // Перенос кладёт правило rollover — единственный, кому это разрешено (§А2-5)
    const envelope = entityOf(
      await run(
        'entity_create',
        {
          title: 'Конверт «Еда», июль',
          tags: [],
          aspects: {
            'orbis/budget': {
              category_ref: CATEGORY_A,
              currency: 'RUB',
              limit: '30000.00',
              period_start: '2026-07-01',
              period_end: '2026-07-31',
              carryover: '-120.00',
            },
          },
        },
        { mechanism: 'rule' },
      ),
    );
    expect((await rowOf(envelope.id)).props['orbis/carryover']).toBe('-120.00');

    // Владелец переносит конверт на сентябрь. Идентичность конверта (§2.1) сменилась —
    // июльский остаток к сентябрьскому лимиту отношения не имеет, и `effectiveLimit`
    // (limit + carryover) молча завышаться не должен.
    ok(
      await run('attach_orbis_budget', {
        entity_id: envelope.id,
        data: {
          category_ref: CATEGORY_A,
          currency: 'RUB',
          limit: '30000.00',
          period_start: '2026-09-01',
          period_end: '2026-09-30',
        },
      }),
    );
    const moved = await expectProjection(envelope.id);
    expect(moved.props['orbis/period_start']).toBe('2026-09-01');
    expect(Object.hasOwn(moved.props, 'orbis/carryover')).toBe(false);
    expect(moved.aspectsLegacy['orbis/budget']).not.toHaveProperty('carryover');
  });

  test('перенос, записанный ТЕМ ЖЕ патчем при смене периода, не считается устаревшим (продление конверта, §3.5)', async () => {
    // Единственный законный писатель переноса — правило rollover. Сегодня оно продлевает
    // конверт созданием, но §3.5 допускает и правку: «сменить период и положить новый
    // остаток» — одно действие, и значение в нём про НОВУЮ идентичность.
    const mk = async (title: string, start: string, end: string, carryover: string) =>
      entityOf(
        await run(
          'entity_create',
          {
            title,
            tags: [],
            aspects: {
              'orbis/budget': {
                category_ref: CATEGORY_B,
                currency: 'RUB',
                limit: '20000.00',
                period_start: start,
                period_end: end,
                carryover,
              },
            },
          },
          { mechanism: 'rule' },
        ),
      );

    // Путь 1: правка (merge) — период меняется и перенос приезжает в том же патче
    const byUpdate = await mk('Конверт под продление правкой', '2027-03-01', '2027-03-31', '10.00');
    ok(
      await run(
        'entity_update',
        {
          id: byUpdate.id,
          aspects: {
            'orbis/budget': {
              period_start: '2027-04-01',
              period_end: '2027-04-30',
              carryover: '777.00',
            },
          },
        },
        { mechanism: 'rule' },
      ),
    );
    const updated = await expectProjection(byUpdate.id);
    expect(updated.props['orbis/period_start']).toBe('2027-04-01');
    expect(updated.props['orbis/carryover']).toBe('777.00');

    // Путь 2: замена носителя (attach) — то же самое одним `attach_orbis_budget`
    const byAttach = await mk('Конверт под продление attach', '2027-03-01', '2027-03-31', '10.00');
    ok(
      await run(
        'attach_orbis_budget',
        {
          entity_id: byAttach.id,
          data: {
            category_ref: CATEGORY_B,
            currency: 'RUB',
            limit: '20000.00',
            period_start: '2027-05-01',
            period_end: '2027-05-31',
            carryover: '888.00',
          },
        },
        { mechanism: 'rule' },
      ),
    );
    const attached = await expectProjection(byAttach.id);
    expect(attached.props['orbis/period_start']).toBe('2027-05-01');
    expect(attached.props['orbis/carryover']).toBe('888.00');
  });

  test('перенос ПЕРЕЖИВАЕТ правку, не трогающую идентичность конверта, и не снимается при создании', async () => {
    const envelope = entityOf(
      await run(
        'entity_create',
        {
          title: 'Конверт «Развлечения», август',
          tags: [],
          aspects: {
            'orbis/budget': {
              category_ref: CATEGORY_B,
              currency: 'RUB',
              limit: '10000.00',
              period_start: '2026-08-01',
              period_end: '2026-08-31',
              carryover: '500.00',
            },
          },
        },
        { mechanism: 'rule' },
      ),
    );
    // Создание переносом и живёт (правило rollover заводит конверт СРАЗУ с ним): перенос
    // положил тот же патч, а устаревшим считается только тот, которого патч не касался.
    expect((await rowOf(envelope.id)).props['orbis/carryover']).toBe('500.00');

    // Правка лимита в том же периоде идентичность не трогает — перенос на месте
    ok(
      await run('entity_update', {
        id: envelope.id,
        aspects: { 'orbis/budget': { limit: '12000.00' } },
      }),
    );
    const patched = await expectProjection(envelope.id);
    expect(patched.props['orbis/limit']).toBe('12000.00');
    expect(patched.props['orbis/carryover']).toBe('500.00');

    // А смена периода тем же путём (merge, без attach) переносу тоже не даёт выжить:
    // правило про идентичность конверта, а не про форму входа.
    ok(
      await run('entity_update', {
        id: envelope.id,
        aspects: { 'orbis/budget': { period_start: '2026-10-01', period_end: '2026-10-31' } },
      }),
    );
    expect(Object.hasOwn((await expectProjection(envelope.id)).props, 'orbis/carryover')).toBe(
      false,
    );
  });

  test('internalUndo восстанавливает состояние с system_writable-свойствами без гейта', async () => {
    const routineId = newId();
    const created = entityOf(
      await run(
        'entity_create',
        {
          title: 'Прогон для отката',
          tags: [],
          aspects: {
            'orbis/agent-run': {
              routine_id: routineId,
              outcome: 'running',
              started_at: '2026-08-26T07:00:00.000Z',
              last_step_at: '2026-08-26T07:00:00.000Z',
              step_count: 0,
              steps: [],
            },
          },
        },
        { mechanism: 'verb' },
      ),
    );
    const patched = ok(
      await run(
        'entity_update',
        {
          id: created.id,
          aspects: { 'orbis/agent-run': { outcome: 'finished', report: 'сделано' } },
        },
        { mechanism: 'verb' },
      ),
    );

    // Откат идёт БЕЗ mechanism (умолчание `user`): без пропуска гейта он упал бы
    // COMPUTED_WRITE, то есть законно записанное состояние стало бы неотменяемым.
    const undone = await undoAction(db, { actorUserId: owner, actionId: patched.actionId });
    expect(undone.ok).toBe(true);
    const row = await expectProjection(created.id);
    expect(row.props['orbis/run_outcome']).toBe('running');
    expect(Object.hasOwn(row.props, 'orbis/run_report')).toBe(false);
  });
});

describe('затронутые аспекты считаются по свойствам, а не по форме входа', () => {
  test('правка слитого свойства новой формой доносит инвариант до аспекта, который во входе не назван', async () => {
    // `orbis/grant` слито у назначения и прогона (В1). Патч новой формы называет СВОЙСТВО и
    // не называет ни одного аспекта — но прогон он затрагивает, и XOR субъекта (V1.4)
    // обязан сработать: иначе в строке окажутся оба субъекта сразу.
    const routineId = newId();
    const created = entityOf(
      await run(
        'entity_create',
        {
          title: 'Прогон рутины',
          tags: [],
          aspects: {
            'orbis/agent-run': {
              routine_id: routineId,
              outcome: 'running',
              started_at: '2026-08-26T07:00:00.000Z',
              last_step_at: '2026-08-26T07:00:00.000Z',
              step_count: 0,
              steps: [],
            },
          },
        },
        { mechanism: 'verb' },
      ),
    );

    const r = await run(
      'entity_update',
      { id: created.id, props: { 'orbis/grant': newId() } },
      { mechanism: 'verb' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('VALIDATION');
    expect((r.error.details as { reason?: string }).reason).toBe('run_subject');

    // Ничего не записано: субъект по-прежнему один
    const row = await expectProjection(created.id);
    expect(row.props['orbis/run_routine']).toBe(routineId);
    expect(Object.hasOwn(row.props, 'orbis/grant')).toBe(false);
  });

  test('прежнее значение аспекта, названного только свойством, попадает в inverse (откат возвращает обе половины слияния)', async () => {
    // Транзакция и конверт делят `orbis/finance_category`. Патч называет ОДИН аспект, а
    // старая карта меняется у обоих — значит и в журнал обязаны уехать оба ключа.
    const e = entityOf(
      await run('entity_create', {
        title: 'Транзакция и конверт разом',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: '100.00',
            direction: 'expense',
            category_ref: CATEGORY_A,
            occurred_on: '2026-08-26',
          },
          // Период конверта НЕ накрывает дату транзакции намеренно: иначе бюджет-хук
          // привязал бы запись к самой себе (rel_no_self), а проверяется здесь слияние
          // свойств, а не привязка.
          'orbis/budget': {
            category_ref: CATEGORY_A,
            limit: '5000.00',
            period_start: '2026-07-01',
            period_end: '2026-07-31',
          },
        },
      }),
    );
    const patched = ok(
      await run('entity_update', {
        id: e.id,
        aspects: { 'orbis/financial': { category_ref: CATEGORY_B } },
      }),
    );
    expect((await expectProjection(e.id)).aspectsLegacy['orbis/budget']).toMatchObject({
      category_ref: CATEGORY_B,
    });

    const undone = await undoAction(db, { actorUserId: owner, actionId: patched.actionId });
    expect(undone.ok).toBe(true);
    const back = await expectProjection(e.id);
    expect(back.props['orbis/finance_category']).toBe(CATEGORY_A);
    expect(back.aspectsLegacy['orbis/budget']).toMatchObject({ category_ref: CATEGORY_A });
  });
});

// ---------------------------------------------------------------------------
// Замок бюджет-контура (Р-27)
// ---------------------------------------------------------------------------

describe('предикат замка бюджет-контура', () => {
  test('патч orbis/amount берёт замок контура; патч orbis/priority — нет', () => {
    const contour = (tool: string, input: unknown): boolean =>
      touchesBudgetContour(reg, { tool, input });

    // Новая форма: по id свойства и по key
    expect(contour('entity_update', { id: 'x', props: { 'orbis/amount': '10.00' } })).toBe(true);
    expect(contour('entity_update', { id: 'x', props: { 'orbis/limit': '10.00' } })).toBe(true);
    expect(contour('entity_update', { id: 'x', unset: ['orbis/finance_category'] })).toBe(true);
    expect(contour('entity_update', { id: 'x', props: { 'orbis/priority': 'high' } })).toBe(false);
    expect(contour('entity_update', { id: 'x', unset: ['orbis/priority'] })).toBe(false);

    // Новая форма списка аспектов и {attach, detach}
    expect(contour('entity_update', { id: 'x', aspects: { detach: ['orbis/financial'] } })).toBe(
      true,
    );
    expect(contour('entity_create', { title: 't', tags: [], aspects: ['orbis/budget'] })).toBe(
      true,
    );
    expect(contour('entity_create', { title: 't', tags: [], aspects: ['orbis/task'] })).toBe(false);

    // Старая карта и attach-тулы — как было
    expect(contour('entity_update', { id: 'x', aspects: { 'orbis/financial': null } })).toBe(true);
    expect(contour('attach_orbis_budget', { entity_id: 'x', data: {} })).toBe(true);
    expect(contour('attach_orbis_task', { entity_id: 'x', data: {} })).toBe(false);
    expect(contour('entity_update', { id: 'x', archived: true })).toBe(true);

    // Вложенный batch виден насквозь
    expect(
      contour('batch_execute', {
        batch_id: newId(),
        operations: [
          { tool: 'entity_update', input: { id: 'x', props: { 'orbis/priority': 'low' } } },
          { tool: 'entity_update', input: { id: 'y', props: { 'orbis/amount': '1.00' } } },
        ],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Валидация по реестру свойств владельца
// ---------------------------------------------------------------------------

describe('валидация по реестру (§А7-1)', () => {
  test('кастомный аспект с {hours: 7} проходит валидацию по property-строкам владельца; неизвестный key → UNKNOWN_PROPERTY', async () => {
    const e = entityOf(await run('entity_create', { title: 'Ночь', tags: [] }));
    ok(await run('attach_user_sleep-log', { entity_id: e.id, data: { hours: 7 } }));

    const row = await expectProjection(e.id);
    // Своё свойство владельца адресуется своим id — и попадает в старую карту под тем
    // именем поля, которое старая форма и знала (локальная часть ключа)
    expect(row.props).toEqual({ 'user/hours': 7 });
    expect(row.aspects).toEqual(['user/sleep-log']);
    expect(row.aspectsLegacy).toEqual({ 'user/sleep-log': { hours: 7 } });

    const denied = await run('attach_user_sleep-log', {
      entity_id: e.id,
      data: { hours: 7, минуты: 30 },
    });
    expect(denied.ok).toBe(false);
    expect(violationsOf(denied)).toContainEqual({
      code: 'UNKNOWN_PROPERTY',
      propertyId: 'orbis/минуты',
    });
  });

  test('REQUIRED по аспекту и TYPE — тот же VALIDATION с details.violations', async () => {
    const required = await run('entity_create', {
      title: 'Задача без статуса',
      tags: [],
      aspects: ['orbis/task'],
    });
    expect(violationsOf(required)).toEqual([
      { code: 'REQUIRED', aspectId: 'orbis/task', propertyId: 'orbis/task_status' },
    ]);

    const typed = await run('entity_create', {
      title: 'Задача с чужим статусом',
      tags: [],
      props: { 'orbis/task_status': 'придумано' },
      aspects: ['orbis/task'],
    });
    expect(violationsOf(typed).map((v) => v.code)).toEqual(['TYPE']);
  });
});

// ---------------------------------------------------------------------------
// Одиночное чтение против списочного (обязательный пункт гейта Задачи 4a)
// ---------------------------------------------------------------------------

describe('списочные пути несут новую форму', () => {
  test('entity_query и backlinks отдают те же props/aspects, что одиночное чтение', async () => {
    const target = entityOf(await run('entity_create', { title: 'Цель ссылок', tags: [] }));
    // Ссылающаяся заметка — она же и НЕСЁТ свойства: в backlinks цели приезжает именно она,
    // и сравнивать надо её списочную форму с её же одиночной.
    const note = entityOf(
      await run('entity_create', {
        title: 'Заметка со ссылкой',
        tags: [],
        body: `см. [[entity:${target.id}]]`,
        aspects: { 'orbis/task': { status: 'planned', priority: 'high' } },
      }),
    );

    const single = await withIdentity(db, owner, async (tx) => {
      const rows = await tx.select().from(entities).where(eq(entities.id, note.id));
      const row = rows[0];
      if (row === undefined) throw new Error('строка не найдена');
      return toWireEntity(row);
    });

    const listed = await withIdentity(db, owner, async (tx) => {
      const found = await readEntity(tx, owner, { id: target.id, include: ['backlinks'] });
      return found?.backlinks?.find((b) => b.entity.id === note.id)?.entity;
    });
    if (listed === undefined) throw new Error('заметка не нашлась в backlinks');

    // Второй списочный путь — компилятор §6: та же выдача кормит и tRPC `entity.query`, и
    // тул `entity_query` (tools/dispatch.ts). Он ходит своим SELECT-листом, и без него
    // проверка накрывала бы только backlinks.
    const queried = await withIdentity(db, owner, async (tx) => {
      const parsed = parseQuery(`aspect=orbis/task, sortBy=created_at:desc`, catalog);
      if (!parsed.ok) throw new Error(`невалидный запрос: ${parsed.error.message}`);
      const rows = [
        ...(await tx.execute(
          compileQuery(parsed.ast, {
            catalog,
            thisEntityId: note.id,
            today: '2026-08-26',
            timezone: 'Europe/Moscow',
          }),
        )),
      ] as Array<Record<string, unknown>>;
      return rows.map(toWireEntityFromSql).find((e) => e.id === note.id);
    });
    if (queried === undefined) throw new Error('заметка не нашлась в выдаче entity_query');
    expect(queried.props).toEqual(single.props);
    expect(queried.aspects).toEqual(single.aspects);
    expect(queried.queryRefs).toEqual(single.queryRefs);
    expect(queried.aspectsMap).toEqual(single.aspectsMap);

    // Расхождение одиночного и списочного чтения — молчаливое: списки ВЫГЛЯДЯТ рабочими,
    // просто новая форма в них пуста. Поэтому сравниваются все три поля целиком.
    expect(listed.props).toEqual(single.props);
    expect(listed.aspects).toEqual(single.aspects);
    expect(listed.queryRefs).toEqual(single.queryRefs);
    expect(listed.aspectsMap).toEqual(single.aspectsMap);
    expect(listed.props).toEqual({ 'orbis/task_status': 'planned', 'orbis/priority': 'high' });
  });
});

// ---------------------------------------------------------------------------
// Чистые функции модели
// ---------------------------------------------------------------------------

describe('applyPropsPatch и резолв адреса', () => {
  test('detach не трогает значения, unset побеждает set, attach идёт после detach', () => {
    const cur = { props: { 'orbis/amount': '1.00', 'orbis/priority': 'low' }, aspects: ['a', 'b'] };
    const next = applyPropsPatch(cur, {
      set: { 'orbis/priority': 'high' },
      unset: ['orbis/priority'],
      attach: ['b', 'c'],
      detach: ['a', 'c'],
    });
    expect(next.props).toEqual({ 'orbis/amount': '1.00' });
    expect(next.aspects).toEqual(['b', 'c']);
    // Вход не мутирован: то же состояние читают проверки следующих операций batch
    expect(cur.aspects).toEqual(['a', 'b']);
    expect(cur.props['orbis/priority']).toBe('low');
  });

  test('touchedProperties считает и записи, и снятия', () => {
    const touched = touchedProperties({ set: { x: 1 }, unset: ['y'], attach: ['orbis/task'] });
    expect([...touched].sort()).toEqual(['x', 'y']);
  });

  test('resolvePropertyRef: сначала key, потом id', () => {
    expect(resolvePropertyRef(reg, FREE_PROPERTY_KEY)?.id).toBe(FREE_PROPERTY_ID);
    expect(resolvePropertyRef(reg, FREE_PROPERTY_ID)?.id).toBe(FREE_PROPERTY_ID);
    expect(resolvePropertyRef(reg, 'orbis/amount')?.id).toBe('orbis/amount');
    expect(resolvePropertyRef(reg, 'user/такого-нет')).toBeUndefined();
  });

  test('resolvePropertyRef: своя строка владельца перекрывает системную с тем же ключом', () => {
    // Снимок собирается в памяти, а не сеется в базу, намеренно: строка, затеняющая
    // системный ключ, изменила бы резолв во ВСЕХ соседних тестах файла — а проверяется
    // здесь чистая функция, которой база не нужна.
    const system = reg.properties.get('orbis/run_report');
    if (system === undefined) throw new Error('в снимке нет orbis/run_report');
    const shadow = { ...system, id: 'user/p-shadow', ownerId: owner, flags: {} };
    const shadowed: RegistrySnapshot = {
      ...reg,
      properties: new Map([...reg.properties, ['user/p-shadow', shadow]]),
    };

    // Ключ один на двоих — выигрывает СВОЯ строка. Это не косметика: у системной стоит
    // `system_writable`, у своей флагов нет, и перепутанный резолв перевернул бы права.
    expect(resolvePropertyRef(shadowed, 'orbis/run_report')?.id).toBe('user/p-shadow');
    expect(resolvePropertyRef(shadowed, 'user/p-shadow')?.id).toBe('user/p-shadow');
    // Порядок перекрытия не зависит от порядка обхода: системная строка идёт первой
    // (ORDER BY owner_id NULLS FIRST), и заменить её вправе только собственная.
    const reversed: RegistrySnapshot = {
      ...reg,
      properties: new Map([['user/p-shadow', shadow], ...reg.properties]),
    };
    expect(resolvePropertyRef(reversed, 'orbis/run_report')?.id).toBe('user/p-shadow');
  });
});
