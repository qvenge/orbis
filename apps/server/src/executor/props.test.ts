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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_PROPERTY_META,
  canonicalJson,
  entityUpdateExecInput,
  newId,
  type PropertyType,
  writableFromTool,
} from '@orbis/shared';
import { parseQueryAst, toParseRegistry } from '@orbis/shared/query';
import { eq, sql } from 'drizzle-orm';
import corpus from '../../test/golden/validator-verdicts.json';
import {
  adminDb,
  appDb,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  seedCustomAspect,
  truncateAll,
} from '../../test/helpers';
import { runStillMine, subjectProperty } from '../agent-loop/verbs';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { readEntity } from '../entity-read';
import { ROUTINE_STAGE_PROPERTY } from '../policy/confirmation';
import { compileQueryAst } from '../query/compile-ast';
import { loadRegistry, type RegistrySnapshot } from '../registry/load';
import type { PropsViolation } from '../registry/validate-props';
import { toWireEntity, toWireEntityFromSql } from '../wire';
import { touchesBudgetContour } from './executor';
import { makeChatJournalSink } from './journal';
import { fromLegacyInput, projectLegacyAspects } from './legacy-form';
import {
  applyPropsPatch,
  comparePropertyValue,
  type EntityState,
  nearestPropertyKey,
  resolvePropertyRef,
  stateDelta,
  touchedProperties,
  writableOnly,
} from './props';
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
          await run('attach_orbis_note', {
            entity_id: e.id,
            data: { 'orbis/pinned': rnd() > 0.5 },
          }),
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

// ---------------------------------------------------------------------------
// Обратимость журнала (§А7-4, §С7-13)
// ---------------------------------------------------------------------------

describe('golden: apply → undo → байт-в-байт по корпусу validator-verdicts', () => {
  /**
   * Обещание §С7-13 в самой сильной форме, какая проверяется без базы: полезная нагрузка
   * журнала и его inverse — это ДИФФЫ СОСТОЯНИЙ в обе стороны, поэтому применение inverse
   * к состоянию «после» обязано давать состояние «до» дословно — по всем трём формам
   * (`props`, `aspects[]`, проекция `aspects_legacy`).
   *
   * Корпус берётся чужой (`test/golden/validator-verdicts.json`, приёмка §С8-1): он собран
   * до этой задачи и по другим источникам, поэтому подтвердить сам себя не может.
   *
   * Круг идёт ЧЕРЕЗ exec-надмножество контракта, а не мимо: `applyUndo` (undo.ts) строит из
   * inverse ТУЛОВЫЙ вызов, и форма, не проходящая `entityUpdateExecInput`, отвалилась бы
   * VALIDATION'ом — молча, потому что «ничего не сделал» и «отказался» на этом пути
   * выглядят одинаково.
   *
   * `aspects[]` сверяется как МНОЖЕСТВО: это список интерпретаций, и порядок в нём —
   * не факт о сущности (снятый и заново навешенный аспект встаёт в конец списка).
   */
  const POSITIVES = 35;
  const PROBE_ID = '019e4466-dddd-7e07-b5d4-64be9721da54';

  test(`${POSITIVES} позитивных записей корпуса: inverse возвращает props/aspects/aspects_legacy дословно`, () => {
    const positives = corpus.filter((r) => r.legacyVerdict === 'ok' && r.newVerdict === 'ok');
    // Число точное, а не «хотя бы»: с порогом «не меньше» неудобную запись можно было бы
    // молча выкинуть из корпуса, и красным это не стало бы (урок гейт-ревью 2)
    expect(positives.length).toBe(POSITIVES);

    for (const record of positives) {
      // «До» непустое намеренно: свойство-сосед, которого патч не касается, обязан
      // пережить и запись, и откат — на этом стоит вся единица отката «свойство»
      const before: EntityState = { props: { [FREE_PROPERTY_ID]: 7 }, aspects: [] };
      const patch = fromLegacyInput(reg, {
        aspects: record.aspects as unknown as Record<string, Record<string, unknown>>,
      });
      const after = applyPropsPatch(before, patch);

      // Полезная нагрузка «как исполнено» — тоже исполнимый тул: круг проверяется в обе стороны
      const forward = entityUpdateExecInput.parse({ id: PROBE_ID, ...stateDelta(before, after) });
      const applied = applyPropsPatch(before, fromLegacyInput(reg, forward));
      expect(canonicalJson(applied.props)).toBe(canonicalJson(after.props));

      const inverse = entityUpdateExecInput.parse({ id: PROBE_ID, ...stateDelta(after, before) });
      const restored = applyPropsPatch(after, fromLegacyInput(reg, inverse));

      expect(canonicalJson(restored.props)).toBe(canonicalJson(before.props));
      expect([...restored.aspects].sort()).toEqual([...before.aspects].sort());
      expect(canonicalJson(projectLegacyAspects(reg, restored))).toBe(
        canonicalJson(projectLegacyAspects(reg, before)),
      );
    }
  });
});

describe('гейты флагов свойств', () => {
  test('поверхность и гейт прав отвечают одно: writableFromTool ≡ writeDenial(механизм тула)', () => {
    // Два представления одного правила: ПОВЕРХНОСТЬ решает, показывать ли свойство в
    // `attach_*` (§А2-5, shared `writableFromTool`), а ГЕЙТ ПРАВ — пропускать ли запись
    // (`writableOnly` по механизму). Разъедься они — и тул снова начал бы обещать модели
    // запрещённое, причём молча: схема бы звала, а исполнитель отказывал.
    const ids = BUILTIN_PROPERTY_META.map((p) => p.id);
    const bySurface = BUILTIN_PROPERTY_META.filter(writableFromTool).map((p) => p.id);
    // Механизм тула — `user`: ни в перечне §А4-4 (system_writable), ни среди пишущих кэш.
    expect(writableOnly(reg, 'user', ids)).toEqual(bySurface);
    // Не вырожденно: запрещённые к записи из тула свойства ЕСТЬ, и их ровно те три
    // семейства, что называет §А2-5, плюс кэши правил.
    const denied = ids.filter((id) => !bySurface.includes(id));
    expect(denied.length).toBeGreaterThan(0);
    expect(denied).toContain('orbis/bank_txn_id');
    expect(denied).toContain('orbis/carryover');
    expect(denied).toContain('orbis/current_value');
  });

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

  test('откат ЯВНО снимает служебное свойство и гейт флагов его пропускает (§7.8 поверх §А2-5)', async () => {
    // С единицей отката «свойство» (§А7-4) снятие на undo перестало быть побочным эффектом
    // замены носителя и стало ЯВНЫМ `unset` — той самой формой, которой гейт §А2-5 отказывает
    // тулу. Внутренний режим гейт пропускает по построению (откат ЗАКОННО записанного обязан
    // проходить), и это обязано быть запинено: иначе первая же перестановка гейта выключила бы
    // откат прогонов, и красным это не стало бы нигде.
    const routineId = newId();
    const run0 = entityOf(
      await run(
        'entity_create',
        {
          title: 'Прогон под откат',
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
    // Отчёт пишет глагол — законная запись служебного свойства
    const wrote = ok(
      await run(
        'entity_update',
        { id: run0.id, aspects: { 'orbis/agent-run': { report: 'отчёт глагола' } } },
        { mechanism: 'verb' },
      ),
    );
    expect((await expectProjection(run0.id)).props['orbis/run_report']).toBe('отчёт глагола');

    // Тот же `unset` от лица тула — COMPUTED_WRITE (контрольная половина: гейт жив)
    const denied = await run('entity_update', { id: run0.id, unset: ['orbis/run_report'] });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('COMPUTED_WRITE');

    // А откат той же законной записи — проходит, и свойство снимается
    const undone = await undoAction(db, { actorUserId: owner, actionId: wrote.actionId });
    expect(undone.ok).toBe(true);
    expect(Object.hasOwn((await expectProjection(run0.id)).props, 'orbis/run_report')).toBe(false);
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
          'orbis/amount': '1500.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': CATEGORY_A,
          'orbis/occurred_on': '2026-08-20',
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

    // Фильтр — ТОЛЬКО про неназванное поле. Назвал явно — дошёл до гейта прав.
    //
    // Схема `attach_orbis_financial` служебных полей БОЛЬШЕ НЕ НЕСЁТ (§А2-5/№33, фикс-раунд
    // 1 Задачи 12: `writableFromTool` выводит их из генератора), и модель, читающая схему,
    // такого входа не составит. Но исполнитель — ВТОРОЙ рубеж, а не единственный: `data`
    // приходит как `additionalProperties`-объект, и вход мимо схемы (свой клиент, ретрай
    // старого payload'а, батч) обязан упереться в право записи, а не проехать. Именно это
    // здесь и проверяется — гейт §А2-5 держит поле, которого в схеме уже нет.
    const named = await run('attach_orbis_financial', {
      entity_id: imported.id,
      data: {
        'orbis/amount': '1500.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': CATEGORY_A,
        'orbis/occurred_on': '2026-08-20',
        'orbis/bank_txn_id': 'ПОДДЕЛКА',
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
        data: {
          'orbis/limit': '30000.00',
          'orbis/period_start': '2026-11-01',
          'orbis/period_end': '2026-11-30',
        },
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
          'orbis/finance_category': CATEGORY_A,
          'orbis/currency': 'RUB',
          'orbis/limit': '30000.00',
          'orbis/period_start': '2026-09-01',
          'orbis/period_end': '2026-09-30',
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
            'orbis/finance_category': CATEGORY_B,
            'orbis/currency': 'RUB',
            'orbis/limit': '20000.00',
            'orbis/period_start': '2027-05-01',
            'orbis/period_end': '2027-05-31',
            'orbis/carryover': '888.00',
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
  test('кастомный аспект с {user/hours: 7} проходит валидацию по property-строкам владельца; неизвестный key → UNKNOWN_PROPERTY', async () => {
    const e = entityOf(await run('entity_create', { title: 'Ночь', tags: [] }));
    // Имя тула — общее (§А9-1, `attachToolName`): «/» и «-» ключа аспекта → «_».
    ok(await run('attach_user_sleep_log', { entity_id: e.id, data: { 'user/hours': 7 } }));

    const row = await expectProjection(e.id);
    // Своё свойство владельца адресуется своим key — и попадает в старую карту под тем
    // именем поля, которое старая форма и знала (локальная часть ключа)
    expect(row.props).toEqual({ 'user/hours': 7 });
    expect(row.aspects).toEqual(['user/sleep-log']);
    expect(row.aspectsLegacy).toEqual({ 'user/sleep-log': { hours: 7 } });

    const denied = await run('attach_user_sleep_log', {
      entity_id: e.id,
      data: { 'user/hours': 7, 'user/минуты': 30 },
    });
    expect(denied.ok).toBe(false);
    expect(violationsOf(denied)).toContainEqual({
      code: 'UNKNOWN_PROPERTY',
      propertyId: 'user/минуты',
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
      const parsed = parseQueryAst(
        `aspect=orbis/task, sortBy=orbis/created_at:desc`,
        toParseRegistry(reg, 'ru'),
      );
      if (!parsed.ok) throw new Error(`невалидный запрос: ${parsed.error.message}`);
      const rows = [
        ...(await tx.execute(
          compileQueryAst(parsed.ast, {
            ownerId: owner,
            reg,
            thisEntityId: note.id,
            today: '2026-08-26',
            timeZone: 'Europe/Moscow',
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

  test('nearestPropertyKey: подсказка на опечатку, тишина на чужом слове, детерминизм на равных', () => {
    // Опечатка на символ — ровно тот промах, ради которого подсказка и заведена.
    expect(nearestPropertyKey(reg, 'orbis/amout')).toBe('orbis/amount');
    expect(nearestPropertyKey(reg, 'orbis/task_statuss')).toBe('orbis/task_status');
    // Другое слово подсказки не получает: потолок и есть граница «опечатка ↔ не опечатка».
    expect(nearestPropertyKey(reg, 'user/выдуманное-поле')).toBeUndefined();
    // Точное имя резолвится само и до подсказки не доходит — но и она указывает на него же.
    expect(nearestPropertyKey(reg, 'orbis/amount')).toBe('orbis/amount');

    // ДЕТЕРМИНИЗМ на равном расстоянии: два кандидата на дистанции 1 от одного входа.
    // Порядок обхода снимка не гарантирован (`ORDER BY owner_id`), поэтому тай-брейк —
    // алфавит, и ответ обязан быть одним и тем же на снимках с РАЗНЫМ порядком вставки.
    const template = reg.properties.get('orbis/amount');
    if (template === undefined) throw new Error('в снимке нет orbis/amount');
    const twins: RegistrySnapshot = {
      ...reg,
      properties: new Map([
        ['user/p-a', { ...template, id: 'user/p-a', key: 'user/aa' }],
        ['user/p-b', { ...template, id: 'user/p-b', key: 'user/ba' }],
      ]),
    };
    const reversed: RegistrySnapshot = {
      ...twins,
      properties: new Map([...twins.properties].reverse()),
    };
    expect(nearestPropertyKey(twins, 'user/ca')).toBe('user/aa');
    expect(nearestPropertyKey(reversed, 'user/ca')).toBe('user/aa');
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

describe('stateDelta: дельта состояний — единица журнала и отката (§А7-4)', () => {
  const st = (props: Record<string, unknown>, aspects: string[] = []): EntityState => ({
    props,
    aspects,
  });

  test('в дельту попадают ТОЛЬКО изменённые: записанное, снятое, навешенное, снятый аспект', () => {
    const before = st({ a: 1, b: 2, c: 3 }, ['orbis/task', 'orbis/note']);
    const after = st({ a: 1, b: 9, d: 4 }, ['orbis/task', 'orbis/goal']);
    expect(stateDelta(before, after)).toEqual({
      props: { b: 9, d: 4 }, // `a` не изменилось — его в записи нет
      unset: ['c'],
      aspects: { attach: ['orbis/goal'], detach: ['orbis/note'] },
    });
  });

  test('inverse — зеркальная дельта: применение её к «после» даёт «до»', () => {
    const before = st({ a: 1, b: 2, c: 3 }, ['orbis/task', 'orbis/note']);
    const after = st({ a: 1, b: 9, d: 4 }, ['orbis/task', 'orbis/goal']);
    expect(stateDelta(after, before)).toEqual({
      props: { b: 2, c: 3 },
      unset: ['d'],
      aspects: { attach: ['orbis/note'], detach: ['orbis/goal'] },
    });
  });

  test('пустых частей в записи нет вовсе: правка без снятий не несёт ключа unset', () => {
    expect(stateDelta(st({ a: 1 }), st({ a: 2 }))).toEqual({ props: { a: 2 } });
    expect(stateDelta(st({ a: 1 }), st({ a: 1 }))).toEqual({});
    expect(stateDelta(st({}, ['orbis/note']), st({}, []))).toEqual({
      aspects: { detach: ['orbis/note'] },
    });
  });

  test('равенство значений — по КАНОНУ, а не по ссылке: тот же объект другим экземпляром не изменение', () => {
    // Значения перекладываются между объектами на каждом слиянии, и «другой объект с теми
    // же полями» изменением не является: попади он в журнал, владелец видел бы в карточке
    // правку, которой не было, а откат возвращал бы значение поверх такого же
    const before = st({ q: { freq: 'weekly', interval: 1 } });
    const after = st({ q: { interval: 1, freq: 'weekly' } });
    expect(stateDelta(before, after)).toEqual({});
    // …но настоящая правка того же объекта — изменение
    expect(stateDelta(before, st({ q: { freq: 'daily', interval: 1 } }))).toEqual({
      props: { q: { freq: 'daily', interval: 1 } },
    });
  });

  test('списки отсортированы: запись журнала не зависит от порядка обхода патча', () => {
    // Порядок вставки — `m, a, z`: он не совпадает ни с прямым, ни с обратным порядком
    // сортировки, поэтому ассерт краснеет и от «не сортировать», и от «сортировать наоборот»
    const before = st({ m: 1, a: 1, z: 1 }, ['orbis/note', 'orbis/goal']);
    const after = st({}, []);
    expect(stateDelta(before, after)).toEqual({
      unset: ['a', 'm', 'z'],
      aspects: { detach: ['orbis/goal', 'orbis/note'] },
    });
  });
});

describe('comparePropertyValue: равенство по ТИПУ свойства (§А7-3)', () => {
  test('decimal — численно: "10.0" = "10.00" = "10", а "10.01" — другое значение', () => {
    // Ровно та ложь, ради которой сравнение и переписано: до реформы стороны сверялись
    // `JSON.stringify`, и одна и та же сумма, записанная с другим числом нулей, давала
    // ЛОЖНЫЙ CONFLICT — «кто-то опередил» там, где не опередил никто.
    const amount: PropertyType = { kind: 'decimal', exclusiveMin: '0' };
    expect(comparePropertyValue(amount, '10.0', '10.00')).toBe(true);
    expect(comparePropertyValue(amount, '10', '10.000')).toBe(true);
    expect(comparePropertyValue(amount, '-0.00', '0.00')).toBe(true);
    expect(comparePropertyValue(amount, '10.01', '10.00')).toBe(false);
    // Зеркало: то же сравнение как ТЕКСТ дало бы обратный ответ на первой паре — значит
    // проверка отличает численное равенство от строкового, а не повторяет `===`.
    // Через `unknown`, потому что на литералах tsc сам объявляет сравнение заведомо ложным,
    // а нам нужно ПОКАЗАТЬ его ложность, а не спрятать.
    expect(('10.0' as unknown) === ('10.00' as unknown)).toBe(false);
  });

  test('decimal fail-closed: не-строка и невыразимое число не совпадают ни с чем', () => {
    // Сравнение стоит на пути записи, и бросок отсюда стал бы 500 вместо честного CONFLICT.
    const amount: PropertyType = { kind: 'decimal' };
    expect(comparePropertyValue(amount, 10, '10.00')).toBe(false);
    expect(comparePropertyValue(amount, 'десять', '10.00')).toBe(false);
    expect(comparePropertyValue(amount, 'десять', 'десять')).toBe(false);
    expect(comparePropertyValue(amount, null, null)).toBe(false);
  });

  test('json — по канону: порядок ключей объекта не значение (jsonb его не хранит)', () => {
    const json: PropertyType = { kind: 'json' };
    expect(comparePropertyValue(json, { a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(comparePropertyValue(json, { a: 1 }, { a: 2 })).toBe(false);
    // А вот порядок МАССИВА — значение, и канон его сохраняет.
    expect(comparePropertyValue(json, { a: [1, 2] }, { a: [2, 1] })).toBe(false);
    // Зеркало: голая ссылка совпала бы только сама с собой — значит сравниваются значения.
    const same: unknown = { a: 1, b: 2 };
    expect(same === ({ a: 1, b: 2 } as unknown)).toBe(false);
    expect(comparePropertyValue(json, same, { a: 1, b: 2 })).toBe(true);
  });

  test('дата и отметка времени — по нормализованному ISO, а не по тексту', () => {
    const ts: PropertyType = { kind: 'timestamp' };
    expect(comparePropertyValue(ts, '2026-08-26T10:00:00Z', '2026-08-26T10:00:00.000Z')).toBe(true);
    expect(comparePropertyValue(ts, '2026-08-26T10:00:00Z', '2026-08-26T10:00:01.000Z')).toBe(
      false,
    );
    // Неразбираемая строка остаётся собой: сравнение не выдумывает ей значение.
    expect(comparePropertyValue(ts, 'не дата', 'не дата')).toBe(true);
    expect(comparePropertyValue(ts, 'не дата', 'тоже не дата')).toBe(false);
  });

  test('список (`cardinality: many`) — поэлементно и ПО ПОРЯДКУ, с проверкой длины', () => {
    const list: PropertyType = { kind: 'text', cardinality: 'many', maxItems: 50 };
    expect(comparePropertyValue(list, ['а', 'б'], ['а', 'б'])).toBe(true);
    // Перестановка — другое значение: у списка порядок часть значения (дни рутины, тулы).
    expect(comparePropertyValue(list, ['а', 'б'], ['б', 'а'])).toBe(false);
    // Длина сверяется первой — иначе ['а'] совпадал бы с началом ['а','б'].
    expect(comparePropertyValue(list, ['а'], ['а', 'б'])).toBe(false);
    expect(comparePropertyValue(list, ['а', 'б'], ['а'])).toBe(false);
    // Не список с обеих сторон — не совпадение: скаляр и список это разные значения.
    expect(comparePropertyValue(list, 'а', ['а'])).toBe(false);
    expect(comparePropertyValue(list, ['а'], 'а')).toBe(false);
  });

  test('список ДЕНЕГ сравнивается правилом денег поэлементно, а не текстом', () => {
    // Проверка того, что `many` не подменяет правило типа своим: иначе список сумм сверялся
    // бы строками, и «10.0» в нём снова разошлось бы с «10.00».
    const money: PropertyType = { kind: 'decimal', cardinality: 'many', maxItems: 5 };
    expect(comparePropertyValue(money, ['10.0', '2.50'], ['10.00', '2.5'])).toBe(true);
    expect(comparePropertyValue(money, ['10.0', '2.50'], ['10.00', '2.51'])).toBe(false);
  });

  test('прочие типы — строгое равенство: text, boolean, number, select, ref, registry_ref, time', () => {
    // Заголовок перечисляет РОВНО то, что проверяет тело. Прежний называл `select`, которого
    // в теле не было, — та самая форма «утверждение шире проверки», на которой ветка ловилась
    // трижды: читатель верит заголовку и второй раз этот случай уже не проверит.
    expect(comparePropertyValue({ kind: 'text' }, 'а', 'а')).toBe(true);
    expect(comparePropertyValue({ kind: 'text' }, 'а', 'А')).toBe(false);
    expect(comparePropertyValue({ kind: 'boolean' }, false, false)).toBe(true);
    // false и «нет значения» — разные вещи (РП-9): отсутствие отсекает сам assertPrecondition,
    // но и здесь undefined не обязан совпадать с false.
    expect(comparePropertyValue({ kind: 'boolean' }, false, undefined)).toBe(false);
    expect(comparePropertyValue({ kind: 'number' }, 1, 1)).toBe(true);
    expect(comparePropertyValue({ kind: 'number' }, 1, '1')).toBe(false);

    const select: PropertyType = {
      kind: 'select',
      options: [
        { key: 'inbox', label: { ru: 'Инбокс', en: 'Inbox' }, rank: 1 },
        { key: 'done', label: { ru: 'Готово', en: 'Done' }, rank: 2 },
      ],
    };
    // Сравнивается КЛЮЧ варианта, лежащий в данных, а не его подпись (Р3).
    expect(comparePropertyValue(select, 'inbox', 'inbox')).toBe(true);
    expect(comparePropertyValue(select, 'inbox', 'done')).toBe(false);

    // `ref` — ссылка на сущность, и это не украшение списка: `orbis/run_routine` имеет ровно
    // этот kind, а он — вторая половина `runStillMine` для РУТИННЫХ прогонов («прогон всё ещё
    // мой»). Сломай кто-нибудь fallthrough `compareScalar` — условие умрёт молча, и увидеть
    // это можно только в гонке смены субъекта под замком, которой ни один сьют не ставит.
    const ref: PropertyType = { kind: 'ref', cardinality: 'one' };
    const RUN_A = '019e4466-aaaa-7e07-b5d4-64be9721da51';
    const RUN_B = '019e4466-bbbb-7e07-b5d4-64be9721da52';
    expect(comparePropertyValue(ref, RUN_A, RUN_A)).toBe(true);
    expect(comparePropertyValue(ref, RUN_A, RUN_B)).toBe(false);
    // uuid НЕ нормализуется по регистру: два разных написания — два разных значения, и
    // «умная» нормализация здесь превратила бы CAS в угадайку.
    expect(comparePropertyValue(ref, RUN_A, RUN_A.toUpperCase())).toBe(false);

    // `registry_ref` — ссылка на строку реестра; правило то же, а kind другой, и через
    // fallthrough он проходит своей веткой ровно так же, как `ref`.
    const registryRef: PropertyType = { kind: 'registry_ref', target: 'property' };
    expect(comparePropertyValue(registryRef, 'orbis/amount', 'orbis/amount')).toBe(true);
    expect(comparePropertyValue(registryRef, 'orbis/amount', 'orbis/limit')).toBe(false);

    // `time` — «ЧЧ:ММ», третий kind, доезжающий до общей ветки. Пин ровно на том же:
    // отличать одно время от другого. ПЕРЕПРОВЕРЕНО: «09:00» ISO-веткой НЕ разбирается
    // (`new Date('09:00')` — Invalid Date у V8, как и «9:00» и «09:00:00»), поэтому попытка
    // «заодно нормализовать» время исход не меняет — говорить, будто такая правка что-то
    // ломает, значило бы обещать проверку, которой здесь нет.
    expect(comparePropertyValue({ kind: 'time' }, '09:00', '09:00')).toBe(true);
    expect(comparePropertyValue({ kind: 'time' }, '09:00', '09:30')).toBe(false);
  });
});

describe('golden-близнец писателей предусловий (§А7-3)', () => {
  /**
   * Шесть файлов, в которых предусловия СТРОЯТСЯ. Список рукописный и это намеренно: он —
   * половина проверки. Появится седьмой — счётчик ниже разойдётся, и переводить его придётся
   * осознанно, а не «когда-нибудь заметим».
   */
  const WRITER_FILES = [
    'agent-loop/sweep.ts',
    'agent-loop/verbs.ts',
    'routers/agent-run.ts',
    'routines/lifecycle.ts',
    'routines/propose.ts',
    'tools/dispatch.ts',
  ];

  /** Место, где `precondition` ПОЛУЧАЕТ значение: литерал, генератор или push в накопитель. */
  const ASSIGNMENT = /precondition(?:\.push\s*\(|\s*[:=]\s*(?:\[|runStillMine\())/;
  /** Старая форма пункта — пара «аспект + поле». После §А7-3 её быть не должно нигде. */
  const LEGACY_ITEM = /\{\s*aspect:\s*'[^']*',\s*field:/;

  const sources = WRITER_FILES.map((path) => ({
    path,
    lines: readFileSync(join(import.meta.dir, '..', path), 'utf8').split('\n'),
  }));

  test('писателей ровно 18: 17 мест присвоения + один генератор-хелпер', () => {
    // Число из плана среза, подтверждённое пересчётом разведки. Разошлось — значит писатель
    // появился или исчез, и его форму надо посмотреть глазами: предусловие, забытое при
    // переводе, отказывает не в тесте, а у владельца на кнопке «Принять».
    const assignments = sources.flatMap(({ path, lines }) =>
      lines.flatMap((line, index) => (ASSIGNMENT.test(line) ? [`${path}:${index + 1}`] : [])),
    );
    expect(assignments).toHaveLength(17);
    // Восемнадцатый — `runStillMine`: он не присваивает `precondition`, а ОТДАЁТ пункты,
    // которые потом кладут два разных глагола (шаг и закрытие прогона).
    expect(runStillMine({ kind: 'routine', routineId: newId() })).toHaveLength(2);
  });

  test('закрытие прогона ставит предусловие ГЕНЕРАТОРОМ, а не своим списком', () => {
    // Пин против тихой потери половины условия. `runStillMine` — это ДВА пункта: «прогон
    // ещё идёт» и «прогон ВСЁ ЕЩЁ МОЙ», и второй под замком ловит то, чего не поймала
    // предпроверка `readRun`: субъект мог смениться между чтением и записью. Заменить вызов
    // своим однопунктовым списком — правка, которую не покажет ни один прогон сьюта (гонка
    // субъектов в тесте не воспроизводима), поэтому здесь она ловится формой.
    const verbs = sources.find((s) => s.path === 'agent-loop/verbs.ts');
    const uses = (verbs?.lines ?? []).filter((line) => /precondition:\s*runStillMine\(/.test(line));
    expect(uses).toHaveLength(1);
    // Шаг прогона кладёт те же пункты россыпью — вместе с CAS по счётчику.
    const spread = (verbs?.lines ?? []).filter((line) => /\.\.\.runStillMine\(/.test(line));
    expect(spread).toHaveLength(1);
  });

  test('каждый названный property-id есть в словаре свойств', () => {
    const known = new Set(BUILTIN_PROPERTY_META.map((p) => p.id));
    const named = new Set<string>();
    for (const { lines } of sources) {
      for (const line of lines) {
        const m = line.match(/\bproperty:\s*'([^']+)'/);
        if (m?.[1] !== undefined) named.add(m[1]);
      }
    }
    // Не пустой набор — иначе проверка «все известны» проходила бы на нуле имён. Порог 9, а не
    // 10, с фикс-раунда 8: адресов по-прежнему десять, но один писатель называет свой
    // КОНСТАНТОЙ, а не литералом (`routines/lifecycle.ts` перешла на общий
    // `ROUTINE_STAGE_PROPERTY` — дом адреса один, `policy/confirmation.ts`). Литеральный скан
    // его не видит, поэтому он проверяется отдельной строкой ниже; понижать порог молча было
    // бы подгонкой, а сканировать идентификаторы подряд — ложными срабатываниями: `property:`
    // встречается и в НОТАХ расхождения предложения, где `BODY_NOTE_PROPERTY` — синтетический
    // маркер (`orbis/body`), а не свойство реестра.
    expect(named.size).toBeGreaterThanOrEqual(9);
    expect([...named].filter((id) => !known.has(id))).toEqual([]);

    // Десятый адрес — тот самый, названный константой. Проверяется СИЛЬНЕЕ литерала: сама
    // константа пиннится к реестру в `confirmation.test.ts`, а здесь закреплено, что писатель
    // ровно один и что адрес есть в словаре.
    expect(known.has(ROUTINE_STAGE_PROPERTY)).toBe(true);
    const byConstant = sources.filter(({ lines }) =>
      lines.some((line) => /\bproperty:\s*ROUTINE_STAGE_PROPERTY\b/.test(line)),
    );
    expect(byConstant.map((entry) => entry.path)).toEqual(['routines/lifecycle.ts']);

    // Вычисляемый адрес субъекта прогона литералом не ловится — проверяем вызовом обеих
    // веток: `orbis/grant` (слитое свойство, В1) и `orbis/run_routine`.
    for (const subject of [
      { kind: 'grant', grant: { id: newId() } },
      { kind: 'routine', routineId: newId() },
    ] as const) {
      expect(known.has(subjectProperty(subject as never))).toBe(true);
    }
  });

  test('пары «аспект + поле» в предусловиях не осталось ни в одном писателе', () => {
    // Комментарии не считаются: докблоки НАЗЫВАЮТ старую форму, объясняя, почему её больше
    // нет, и запретить им это значило бы вычеркнуть объяснение вместе с кодом.
    const isComment = (line: string): boolean =>
      line.trimStart().startsWith('*') || line.trimStart().startsWith('//');
    for (const { path, lines } of sources) {
      const legacy = lines.flatMap((line, index) =>
        !isComment(line) && LEGACY_ITEM.test(line) ? [`${path}:${index + 1}`] : [],
      );
      expect(legacy).toEqual([]);
    }
    // Проверка не вакуумна: сам образец старой формы регулярка находит.
    expect(LEGACY_ITEM.test("{ aspect: 'orbis/task', field: 'status', in: ['planned'] }")).toBe(
      true,
    );
  });
});
