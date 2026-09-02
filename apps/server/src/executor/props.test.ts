// apps/server/src/executor/props.test.ts
// Веха B реформы: исполнитель пишет правду сущности — `props` по id свойства и список
// `aspects[]` (§А1-1). Здесь же стоят гейты флагов (§А2-5) и ось `mechanism` (§А4-4).
//
// СТАРОЙ КАРТЫ И ЕЁ ИНВАРИАНТА ЗДЕСЬ БОЛЬШЕ НЕТ. Пока колонка `aspects_legacy` жила, эти
// тесты сверяли её с проекцией после каждой мутации — дуальная запись держалась только
// инвариантом. «Пересев мира» снял колонку, и вопрос «сошлись ли две записи одного факта»
// исчез вместе со второй записью.
//
// Тесты интеграционные: реальная БД под withIdentity, без моков — ровно потому, что
// проверяется СТРОКА, а не возвращённая wire-форма. Расхождение между тем, что уехало
// клиенту, и тем, что легло в колонки, — тот класс дефекта, который иначе не виден.

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
import { parseQueryAst, QUERY_TREE_DEPTH_CAP, toParseRegistry } from '@orbis/shared/query';
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
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import type { PropsViolation } from '../registry/validate-props';
import { bumpOwnerRegistryVersion } from '../registry/version';
import { toWireEntity, toWireEntityFromSql } from '../wire';
import { touchesBudgetContour } from './executor';
import { makeChatJournalSink } from './journal';
import {
  applyPropsPatch,
  comparePropertyValue,
  type EntityState,
  nearestPropertyKey,
  propsPatchFromInput,
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
}

/** Колонки значений строки как они легли в БД (не wire-форма — именно колонки). */
async function rowOf(id: string): Promise<Row> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx
      .select({ props: entities.props, aspects: entities.aspects })
      .from(entities)
      .where(eq(entities.id, id)),
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`строка ${id} не найдена`);
  return { props: row.props as Record<string, unknown>, aspects: row.aspects };
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
    await bumpOwnerRegistryVersion(admin.db, owner); // мутация реестра двигает версию (§А10-1)
  } finally {
    await admin.client.end();
  }
  reg = await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner));
});

afterAll(async () => {
  await truncateAll();
  await client.end();
});

// ---------------------------------------------------------------------------
// Что легло в строку
// ---------------------------------------------------------------------------

describe('исполнитель пишет props/aspects[] (§А1-1)', () => {
  test('entity_create кладёт значения в props по id свойства, а список — в aspects[]', async () => {
    const e = entityOf(
      await run('entity_create', {
        title: 'Покупка кофе',
        tags: [],
        props: {
          'orbis/amount': '340.00',
          'orbis/currency': 'RUB',
          'orbis/direction': 'expense',
          'orbis/finance_category': CATEGORY_A,
          'orbis/occurred_on': '2026-08-26',
        },
        aspects: ['orbis/financial'],
      }),
    );

    const row = await rowOf(e.id);
    // Значения адресуются id СВОЙСТВА, а не парой «аспект + поле»
    expect(row.props).toEqual({
      'orbis/amount': '340.00',
      'orbis/currency': 'RUB',
      'orbis/direction': 'expense',
      'orbis/finance_category': CATEGORY_A,
      'orbis/occurred_on': '2026-08-26',
    });
    expect(row.aspects).toEqual(['orbis/financial']);
    // Мешка `meta` нет ни в wire-форме (§А1-3, Задача 13c), ни в базе: колонку сняла 0017.
    expect('meta' in e).toBe(false);
  });

  test('адрес свойства во входе — id ИЛИ key, и оба дают одну строку', async () => {
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
    // Свободное свойство (§А1-2) живёт без аспекта — список интерпретаций пуст
    expect((await rowOf(byKey.id)).aspects).toEqual([]);
  });

  test('detach аспекта оставляет значения свойств (Р9); explicit unset снимает свойство', async () => {
    const e = entityOf(
      await run('entity_create', {
        title: 'Такси',
        tags: [],
        props: {
          'orbis/amount': '700.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': CATEGORY_A,
          'orbis/occurred_on': '2026-08-26',
        },
        aspects: ['orbis/financial'],
      }),
    );

    ok(await run('entity_update', { id: e.id, aspects: { detach: ['orbis/financial'] } }));
    const afterDetach = await rowOf(e.id);
    expect(afterDetach.aspects).toEqual([]);
    // Значение суммы — факт владельца, а не собственность аспекта (Р9)
    expect(afterDetach.props['orbis/amount']).toBe('700.00');

    ok(await run('entity_update', { id: e.id, unset: ['orbis/amount'] }));
    const afterUnset = await rowOf(e.id);
    expect(Object.hasOwn(afterUnset.props, 'orbis/amount')).toBe(false);
    expect(afterUnset.props['orbis/direction']).toBe('expense');
  });

  test('financial+budget на одной записи: слитое свойство ОДНО, конфликту взяться неоткуда (В1)', async () => {
    // КЛАСС ОТКАЗА СНЯТ РЕФОРМОЙ, и это не послабление, а следствие формы.
    //
    // `merged_property_conflict` рождался ровно на границе старой карты: две ячейки
    // (`financial.category_ref` и `budget.category_ref`) адресовали ОДНО свойство
    // `orbis/finance_category` (§А8/В1), и патч мог назвать им два разных значения. Плоский
    // `props` двух значений одного свойства не несёт — противоречие невыразимо во входе, и
    // отказывать не в чем. Проверяется положительно: запись с обоими аспектами берёт одно
    // значение, и оба носителя видят его.
    const e = entityOf(
      await run('entity_create', {
        title: 'Конверт и трата разом',
        tags: [],
        props: {
          'orbis/amount': '100.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': CATEGORY_A,
          'orbis/occurred_on': '2026-08-26',
          'orbis/limit': '5000.00',
          'orbis/period_start': '2026-08-01',
          'orbis/period_end': '2026-08-31',
        },
        aspects: ['orbis/financial', 'orbis/budget'],
      }),
    );
    const row = await rowOf(e.id);
    expect(row.props['orbis/finance_category']).toBe(CATEGORY_A);
    expect(row.aspects.sort()).toEqual(['orbis/budget', 'orbis/financial']);
    // Второе значение того же свойства выразить нечем: ключ в объекте один.
    expect(Object.keys(row.props).filter((k) => k === 'orbis/finance_category')).toHaveLength(1);
  });
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
   * к состоянию «после» обязано давать состояние «до» дословно — по обеим формам
   * (`props` и `aspects[]`).
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
  const POSITIVES = 36;
  const PROBE_ID = '019e4466-dddd-7e07-b5d4-64be9721da54';

  test(`${POSITIVES} позитивных записей корпуса: inverse возвращает props/aspects дословно`, () => {
    const positives = corpus.filter((r) => r.legacyVerdict === 'ok' && r.newVerdict === 'ok');
    // Число точное, а не «хотя бы»: с порогом «не меньше» неудобную запись можно было бы
    // молча выкинуть из корпуса, и красным это не стало бы (урок гейт-ревью 2)
    expect(positives.length).toBe(POSITIVES);

    for (const record of positives) {
      // «До» непустое намеренно: свойство-сосед, которого патч не касается, обязан
      // пережить и запись, и откат — на этом стоит вся единица отката «свойство»
      const before: EntityState = { props: { [FREE_PROPERTY_ID]: 7 }, aspects: [] };
      const patch = propsPatchFromInput(reg, { props: record.props, aspects: record.aspects });
      const after = applyPropsPatch(before, patch);

      // Полезная нагрузка «как исполнено» — тоже исполнимый тул: круг проверяется в обе стороны
      const forward = entityUpdateExecInput.parse({ id: PROBE_ID, ...stateDelta(before, after) });
      const applied = applyPropsPatch(before, propsPatchFromInput(reg, forward));
      expect(canonicalJson(applied.props)).toBe(canonicalJson(after.props));

      const inverse = entityUpdateExecInput.parse({ id: PROBE_ID, ...stateDelta(after, before) });
      const restored = applyPropsPatch(after, propsPatchFromInput(reg, inverse));

      expect(canonicalJson(restored.props)).toBe(canonicalJson(before.props));
      expect([...restored.aspects].sort()).toEqual([...before.aspects].sort());
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
    props: {
      'orbis/progress_source': { query: { text: 'aspect=orbis/financial' }, aggregate: 'count' },
      'orbis/target_value': '300000.00',
      ...over,
    },
    aspects: ['orbis/goal'],
  });

  test('запись orbis/current_value из тула → COMPUTED_WRITE; из mechanism rule — проходит', async () => {
    const denied = await run('entity_create', goalInput({ 'orbis/current_value': '10' }));
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('COMPUTED_WRITE');
    expect(denied.error.details).toMatchObject({
      property: 'orbis/current_value',
      mechanism: 'user',
      reason: 'model_writable',
    });

    // Кэш вычисления пишет правило каталога — и только оно (правило 3 §10)
    const allowed = await run('entity_create', goalInput({ 'orbis/current_value': '10' }), {
      mechanism: 'rule',
    });
    const row = await rowOf(entityOf(allowed).id);
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
          props: {
            'orbis/run_routine': routineId,
            'orbis/run_outcome': 'running',
            'orbis/run_started_at': '2026-08-26T07:00:00.000Z',
            'orbis/last_step_at': '2026-08-26T07:00:00.000Z',
            'orbis/step_count': 0,
            'orbis/run_steps': [],
          },
          aspects: ['orbis/agent-run'],
        },
        { mechanism: 'verb' },
      ),
    );

    const denied = await run('entity_update', {
      id: run0.id,
      props: { 'orbis/run_report': 'подделанный отчёт' },
      aspects: { attach: ['orbis/agent-run'] },
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
        {
          id: run0.id,
          props: { 'orbis/run_report': 'честный отчёт' },
          aspects: { attach: ['orbis/agent-run'] },
        },
        { mechanism: 'verb' },
      ),
    );
    const row = await rowOf(run0.id);
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
          props: {
            'orbis/run_routine': routineId,
            'orbis/run_outcome': 'finished',
            'orbis/run_report': 'честный отчёт',
            'orbis/run_started_at': '2026-08-26T07:00:00.000Z',
            'orbis/last_step_at': '2026-08-26T07:00:00.000Z',
            'orbis/step_count': 0,
            'orbis/run_steps': [],
          },
          aspects: ['orbis/agent-run'],
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
      unset: ['orbis/run_report'],
      aspects: { attach: ['orbis/agent-run'] },
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
          props: {
            'orbis/progress_source': {
              query: { text: 'aspect=orbis/financial' },
              aggregate: 'count',
            },
            'orbis/target_value': '10',
            'orbis/current_value': '3',
          },
          aspects: ['orbis/goal'],
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
    expect((await rowOf(created.id)).props['orbis/run_report']).toBe('честный отчёт');
    expect((await rowOf(goal.id)).props['orbis/current_value']).toBe('3');

    // Тот же глагол, которому свойство принадлежит, снимает его без препятствий
    ok(
      await run(
        'entity_update',
        { id: created.id, unset: ['orbis/run_report'] },
        { mechanism: 'verb' },
      ),
    );
    expect(Object.hasOwn((await rowOf(created.id)).props, 'orbis/run_report')).toBe(false);
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
          props: {
            'orbis/run_routine': routineId,
            'orbis/run_outcome': 'running',
            'orbis/run_started_at': '2026-08-26T07:00:00.000Z',
            'orbis/last_step_at': '2026-08-26T07:00:00.000Z',
            'orbis/step_count': 0,
            'orbis/run_steps': [],
          },
          aspects: ['orbis/agent-run'],
        },
        { mechanism: 'verb' },
      ),
    );
    // Отчёт пишет глагол — законная запись служебного свойства
    const wrote = ok(
      await run(
        'entity_update',
        {
          id: run0.id,
          props: { 'orbis/run_report': 'отчёт глагола' },
          aspects: { attach: ['orbis/agent-run'] },
        },
        { mechanism: 'verb' },
      ),
    );
    expect((await rowOf(run0.id)).props['orbis/run_report']).toBe('отчёт глагола');

    // Тот же `unset` от лица тула — COMPUTED_WRITE (контрольная половина: гейт жив)
    const denied = await run('entity_update', { id: run0.id, unset: ['orbis/run_report'] });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('COMPUTED_WRITE');

    // А откат той же законной записи — проходит, и свойство снимается
    const undone = await undoAction(db, { actorUserId: owner, actionId: wrote.actionId });
    expect(undone.ok).toBe(true);
    expect(Object.hasOwn((await rowOf(run0.id)).props, 'orbis/run_report')).toBe(false);
  });

  test('замена носителя (attach) не стирает служебное значение, но снимает свои: bank_txn_id переживает attach_orbis_financial', async () => {
    const imported = entityOf(
      await run(
        'entity_create',
        {
          title: 'Операция из выписки',
          tags: [],
          props: {
            'orbis/amount': '1200.00',
            'orbis/direction': 'expense',
            'orbis/finance_category': CATEGORY_A,
            'orbis/occurred_on': '2026-08-20',
            'orbis/payment_method': 'карта',
            'orbis/bank_txn_id': 'BNK-42',
          },
          aspects: ['orbis/financial'],
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

    const row = await rowOf(imported.id);
    expect(row.props['orbis/amount']).toBe('1500.00');
    // Импортное тождество переживает навешивание аспекта…
    expect(row.props['orbis/bank_txn_id']).toBe('BNK-42');
    // …а СВОЁ поле, которого в `data` не было, замена честно снимает
    expect(Object.hasOwn(row.props, 'orbis/payment_method')).toBe(false);

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
        props: {
          'orbis/amount': '900.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': CATEGORY_C,
          // Валюта НЕДЕФОЛТНАЯ намеренно. У обоих аспектов она необязательна, а
          // `normalizeEnvelopeProps` подставляет на место пропавшего значения умолчание
          // владельца (RUB): с 'RUB' в фикстуре currency-ассерты проходили бы и с вырезанной
          // защитой — стёртую валюту молча восстанавливала бы подстановка, и половина пина
          // оказалась бы вакуумной (найдено УЗКОЙ мутацией: защита снята только с валюты).
          'orbis/currency': 'USD',
          // Дата ВНЕ периода конверта ниже: иначе бюджет-хук выбрал бы конвертом саму
          // запись (слитые категория и валюта совпадают по построению) и упал бы
          // `self_relation` — маскируя проверяемое здесь.
          'orbis/occurred_on': '2026-08-26',
        },
        aspects: ['orbis/financial'],
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

    const row = await rowOf(e.id);
    expect(row.props['orbis/finance_category']).toBe(CATEGORY_C);
    expect(row.props['orbis/currency']).toBe('USD');
    // Одно значение — ДВА НОСИТЕЛЯ, и в этом весь смысл слияния §А8/В1: свойство одно
    // (`orbis/finance_category`, `orbis/currency`), а объявляют его оба аспекта.
    expect(row.aspects.sort()).toEqual(['orbis/budget', 'orbis/financial']);
    expect(row.props['orbis/period_start']).toBe('2026-11-01');
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
          props: {
            'orbis/finance_category': CATEGORY_A,
            'orbis/currency': 'RUB',
            'orbis/limit': '30000.00',
            'orbis/period_start': '2026-07-01',
            'orbis/period_end': '2026-07-31',
            'orbis/carryover': '-120.00',
          },
          aspects: ['orbis/budget'],
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
    const moved = await rowOf(envelope.id);
    expect(moved.props['orbis/period_start']).toBe('2026-09-01');
    expect(Object.hasOwn(moved.props, 'orbis/carryover')).toBe(false);
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
            props: {
              'orbis/finance_category': CATEGORY_B,
              'orbis/currency': 'RUB',
              'orbis/limit': '20000.00',
              'orbis/period_start': start,
              'orbis/period_end': end,
              'orbis/carryover': carryover,
            },
            aspects: ['orbis/budget'],
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
          props: {
            'orbis/period_start': '2027-04-01',
            'orbis/period_end': '2027-04-30',
            'orbis/carryover': '777.00',
          },
          aspects: { attach: ['orbis/budget'] },
        },
        { mechanism: 'rule' },
      ),
    );
    const updated = await rowOf(byUpdate.id);
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
    const attached = await rowOf(byAttach.id);
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
          props: {
            'orbis/finance_category': CATEGORY_B,
            'orbis/currency': 'RUB',
            'orbis/limit': '10000.00',
            'orbis/period_start': '2026-08-01',
            'orbis/period_end': '2026-08-31',
            'orbis/carryover': '500.00',
          },
          aspects: ['orbis/budget'],
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
        props: { 'orbis/limit': '12000.00' },
        aspects: { attach: ['orbis/budget'] },
      }),
    );
    const patched = await rowOf(envelope.id);
    expect(patched.props['orbis/limit']).toBe('12000.00');
    expect(patched.props['orbis/carryover']).toBe('500.00');

    // А смена периода тем же путём (merge, без attach) переносу тоже не даёт выжить:
    // правило про идентичность конверта, а не про форму входа.
    ok(
      await run('entity_update', {
        id: envelope.id,
        props: { 'orbis/period_start': '2026-10-01', 'orbis/period_end': '2026-10-31' },
        aspects: { attach: ['orbis/budget'] },
      }),
    );
    expect(Object.hasOwn((await rowOf(envelope.id)).props, 'orbis/carryover')).toBe(false);
  });

  test('internalUndo восстанавливает состояние с system_writable-свойствами без гейта', async () => {
    const routineId = newId();
    const created = entityOf(
      await run(
        'entity_create',
        {
          title: 'Прогон для отката',
          tags: [],
          props: {
            'orbis/run_routine': routineId,
            'orbis/run_outcome': 'running',
            'orbis/run_started_at': '2026-08-26T07:00:00.000Z',
            'orbis/last_step_at': '2026-08-26T07:00:00.000Z',
            'orbis/step_count': 0,
            'orbis/run_steps': [],
          },
          aspects: ['orbis/agent-run'],
        },
        { mechanism: 'verb' },
      ),
    );
    const patched = ok(
      await run(
        'entity_update',
        {
          id: created.id,
          props: { 'orbis/run_outcome': 'finished', 'orbis/run_report': 'сделано' },
          aspects: { attach: ['orbis/agent-run'] },
        },
        { mechanism: 'verb' },
      ),
    );

    // Откат идёт БЕЗ mechanism (умолчание `user`): без пропуска гейта он упал бы
    // COMPUTED_WRITE, то есть законно записанное состояние стало бы неотменяемым.
    const undone = await undoAction(db, { actorUserId: owner, actionId: patched.actionId });
    expect(undone.ok).toBe(true);
    const row = await rowOf(created.id);
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
          props: {
            'orbis/run_routine': routineId,
            'orbis/run_outcome': 'running',
            'orbis/run_started_at': '2026-08-26T07:00:00.000Z',
            'orbis/last_step_at': '2026-08-26T07:00:00.000Z',
            'orbis/step_count': 0,
            'orbis/run_steps': [],
          },
          aspects: ['orbis/agent-run'],
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
    const row = await rowOf(created.id);
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
        props: {
          'orbis/amount': '100.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': CATEGORY_A,
          'orbis/occurred_on': '2026-08-26',
          'orbis/limit': '5000.00',
          'orbis/period_start': '2026-07-01',
          'orbis/period_end': '2026-07-31',
        },
        aspects: ['orbis/financial', 'orbis/budget'],
      }),
    );
    const patched = ok(
      await run('entity_update', {
        id: e.id,
        props: { 'orbis/finance_category': CATEGORY_B },
        aspects: { attach: ['orbis/financial'] },
      }),
    );
    expect((await rowOf(e.id)).props['orbis/finance_category']).toBe(CATEGORY_B);

    const undone = await undoAction(db, { actorUserId: owner, actionId: patched.actionId });
    expect(undone.ok).toBe(true);
    const back = await rowOf(e.id);
    expect(back.props['orbis/finance_category']).toBe(CATEGORY_A);
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

    // Старая карта и attach-тулы — как было. ALLOWLIST старой формы (Задача 23a): предикат
    // замка обязан узнавать её, пока союз легаси-входа жив (снос — 23b).
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

    const row = await rowOf(e.id);
    // Своё свойство владельца адресуется СВОИМ key — и никаким другим именем: локальной
    // части (`hours`) не знает ни вход тула, ни строка.
    expect(row.props).toEqual({ 'user/hours': 7 });
    expect(row.aspects).toEqual(['user/sleep-log']);

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

  /**
   * ОТРАВЛЕННОЕ ЗНАЧЕНИЕ НЕ ЛОЖИТСЯ (рулинг Р-13c-2, сторона ЗАПИСИ).
   *
   * Замер, ради которого проверка написана: цепочка `not` глубиной 10 000 уровней (80 КБ,
   * `JSON.parse` её переваривает) ПРОХОДИЛА ajv записи и ложилась в jsonb, а zod чтения
   * (`goals/progress.ts`) падал на ней `RangeError` — переполнением стека, которого
   * `safeParse` не ловит. Итог: `entity.get` такой цели отдавал 500 навсегда, чинить —
   * только правкой jsonb руками. Свойство при этом пишется моделью обычным путём: у
   * `orbis/progress_source` нет `flags`, запрещающих запись.
   *
   * Глубина берётся ВДВОЕ больше капа, а не «кап + 1»: проба не должна зависеть от того,
   * считает ли код конверт значения вместе с деревом.
   */
  test('значение глубже капа отвергается ЗАПИСЬЮ, а не падает на чтении (Р-13c-2)', async () => {
    let node: unknown = { tag: 'дом' };
    for (let i = 0; i < QUERY_TREE_DEPTH_CAP * 2; i++) node = { not: node };

    const denied = await run('entity_create', {
      title: 'Цель с отравленным источником',
      tags: [],
      props: {
        'orbis/progress_source': { query: { filter: node }, aggregate: 'count' },
        'orbis/target_value': '100',
      },
      aspects: ['orbis/goal'],
    });
    expect(denied.ok).toBe(false);
    expect(violationsOf(denied)).toContainEqual({
      code: 'VALUE_TOO_DEEP',
      propertyId: 'orbis/progress_source',
      cap: QUERY_TREE_DEPTH_CAP,
    });
    // Названо ИМЕННО то число, которое код и меряет.
    if (denied.ok) throw new Error('ожидался отказ');
    expect(denied.error.message).toContain(String(QUERY_TREE_DEPTH_CAP));

    // Отказ СТРУКТУРНЫЙ и наш. Порядок «гейт до ajv» отсюда НЕ следует и не проверяется:
    // ajv 128 уровней принимает, и то же самое вышло бы при обратном порядке. Порядок —
    // свойство самой `validateEntityProps`, и проверяется он её собственным юнит-тестом
    // (`registry/validate-props.test.ts`), где нет ни БД, ни фикстурной обвязки: глубина,
    // на которой бросает ajv, роняет и рекурсивные помощники СЬЮТА, а проба обязана
    // проверять наш порядок, а не чужой запас стека.
    expect(denied.error.code).toBe('VALIDATION');

    // Мелкая цель тем же путём проходит — проверка не запрещает законную форму.
    const okGoal = await run('entity_create', {
      title: 'Обычная цель',
      tags: [],
      props: {
        'orbis/progress_source': {
          query: { filter: { aspect: 'orbis/task' } },
          aggregate: 'count',
        },
        'orbis/target_value': '100',
      },
      aspects: ['orbis/goal'],
    });
    expect(okGoal.ok).toBe(true);
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
        props: { 'orbis/task_status': 'planned', 'orbis/priority': 'high' },
        aspects: ['orbis/task'],
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

    // Расхождение одиночного и списочного чтения — молчаливое: списки ВЫГЛЯДЯТ рабочими,
    // просто новая форма в них пуста. Поэтому сравниваются все три поля целиком.
    expect(listed.props).toEqual(single.props);
    expect(listed.aspects).toEqual(single.aspects);
    expect(listed.queryRefs).toEqual(single.queryRefs);
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

// ---------------------------------------------------------------------------
// Единица «15-бис»: core-проекция в `props` (§А1-3)
// ---------------------------------------------------------------------------

/**
 * ВТОРАЯ ПРАВДА ПОД ОДНИМ ИМЕНЕМ — закрытый вход, а не теоретический.
 *
 * Четыре core-проекции (§А1-3) хранятся колонками; `entity_update {props:{'orbis/title':…}}`
 * до этой правки ПРИНИМАЛСЯ живьём (проба Задачи 15), и запись уносила `title` в колонке и
 * `orbis/title` в `props` — расходящиеся навсегда, потому что второе не читает ни один путь.
 *
 * Пробы стоят на ВСЕХ ТРЁХ путях записи, а не на одном: гейт живёт в общей стадии 2
 * (`validateEntityProps`), но «общая» — это утверждение о конвейере, и проверяется оно только
 * тем, что каждый путь до неё реально доходит. Четвёртый вход — слияние — закрыт Задачей 15
 * (`MERGE_STORAGE`, `registry/ops.test.ts`).
 */
/**
 * FAIL-CLOSED ФОРМЫ ПРАВИЛА ПАМЯТИ (В7, §А8): «невалидное правило незаписываемо», а не
 * «записано и молча мёртво».
 *
 * До этой задачи машиночитаемая часть правила жила в ЗАГОЛОВКЕ, и заголовок без разделителя
 * проходил запись целиком: правило лежало в «Памяти AI», выглядело рабочим и не применялось
 * НИ ОДНИМ детерминированным путём (быстрый ввод, резолв импорта, гейт эскалации). Класс
 * закрывается здесь — на записи, а не показом значка.
 *
 * Пробы стоят на ВСЕХ ТРЁХ путях записи по тому же доводу, что у core-проекций: гейт живёт в
 * общей стадии 2 (`assertEntityProps`), но «общая» — это утверждение о конвейере, и
 * проверяется оно только тем, что каждый путь до неё реально доходит. Цель ВНЕ множества
 * категорий закрыта другим механизмом и проверяется у него (`registry/ref.test.ts`,
 * `REF_TARGET`): это работа валидатора ссылок по `target` свойства, а не формы правила.
 */
describe('правило памяти без образца — отказ на всех путях записи (В7, §А8)', () => {
  const RULE_TARGET_CATEGORY = '019e4466-dddd-7e07-b5d4-64be9721da54';

  function ruleProps(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      'orbis/memory_kind': 'rule',
      'orbis/rule_pattern': 'пятерочка',
      'orbis/rule_scope': 'orbis/money-movement',
      'orbis/rule_target': RULE_TARGET_CATEGORY,
      ...over,
    };
  }

  test('entity_create: полное правило записывается — свойства по id, подпись в колонке title', async () => {
    const e = entityOf(
      await run('entity_create', {
        title: 'пятерочка → Продукты',
        tags: [],
        props: ruleProps(),
        aspects: ['orbis/memory'],
      }),
    );
    expect(e.title).toBe('пятерочка → Продукты');
    const row = await rowOf(e.id);
    expect(row.props).toMatchObject(ruleProps());
    expect(row.aspects).toEqual(['orbis/memory']);
    // Подпись живёт КОЛОНКОЙ: `orbis/title` в `props` закрыт (CORE_IN_PROPS, §А1-3).
    expect(Object.keys(row.props)).not.toContain('orbis/title');
  });

  test('entity_create: правило без orbis/rule_pattern → VALIDATION, строки нет', async () => {
    const entityId = newId();
    const props = ruleProps();
    delete props['orbis/rule_pattern'];
    const denied = await run('entity_create', {
      id: entityId,
      title: 'мусор без разделителя',
      tags: [],
      props,
      aspects: ['orbis/memory'],
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('VALIDATION');
    expect(violationsOf(denied)).toContainEqual({ code: 'RULE_WITHOUT_PATTERN' });
    // Отказ НАЗЫВАЕТ ВЫХОД — иначе автор записи уйдёт искать обходной путь.
    expect(denied.error.message).toContain('orbis/rule_pattern');
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select({ id: entities.id }).from(entities).where(eq(entities.id, entityId)),
    );
    expect(rows.length).toBe(0);
  });

  test('entity_create: денежное правило без orbis/rule_target → VALIDATION (подставлять нечего)', async () => {
    const props = ruleProps();
    delete props['orbis/rule_target'];
    const denied = await run('entity_create', {
      title: 'пятерочка → ?',
      tags: [],
      props,
      aspects: ['orbis/memory'],
    });
    expect(violationsOf(denied)).toContainEqual({
      code: 'RULE_WITHOUT_TARGET',
      scope: 'orbis/money-movement',
    });
  });

  test('entity_update: снятие образца у живого правила → VALIDATION, значение остаётся', async () => {
    const e = entityOf(
      await run('entity_create', {
        title: 'пятерочка → Продукты',
        tags: [],
        props: ruleProps(),
        aspects: ['orbis/memory'],
      }),
    );
    const denied = await run('entity_update', { id: e.id, unset: ['orbis/rule_pattern'] });
    expect(violationsOf(denied)).toContainEqual({ code: 'RULE_WITHOUT_PATTERN' });
    expect((await rowOf(e.id)).props['orbis/rule_pattern']).toBe('пятерочка');

    // ВТОРАЯ ФОРМА ТОГО ЖЕ НАМЕРЕНИЯ: не «снять образец», а «стать правилом» уже после
    // создания. Проверяется отдельно, потому что гейт смотрит на ИТОГОВОЕ состояние, и
    // путь сюда другой — patch без единого свойства правила в нём самом.
    const note = entityOf(await run('entity_create', { title: 'Просто запись', tags: [] }));
    const becameRule = await run('entity_update', {
      id: note.id,
      props: { 'orbis/memory_kind': 'rule' },
      aspects: { attach: ['orbis/memory'] },
    });
    expect(violationsOf(becameRule)).toContainEqual({ code: 'RULE_WITHOUT_PATTERN' });
  });

  test('attach_orbis_memory: третий путь закрыт тем же кодом', async () => {
    const e = entityOf(await run('entity_create', { title: 'Заметка', tags: [] }));
    const denied = await run('attach_orbis_memory', {
      entity_id: e.id,
      data: { 'orbis/memory_kind': 'rule' },
    });
    expect(violationsOf(denied)).toContainEqual({ code: 'RULE_WITHOUT_PATTERN' });

    // attach ЗАМЕНЯЕТ носитель целиком — и этим же может СНЯТЬ образец у готового правила:
    // не назвал в `data` — значит снять. Путь закрыт тем же гейтом по итоговому состоянию.
    const rule = entityOf(
      await run('entity_create', {
        title: 'пятерочка → Продукты',
        tags: [],
        props: ruleProps(),
        aspects: ['orbis/memory'],
      }),
    );
    const wiped = await run('attach_orbis_memory', {
      entity_id: rule.id,
      data: { 'orbis/memory_kind': 'rule' },
    });
    expect(violationsOf(wiped)).toContainEqual({ code: 'RULE_WITHOUT_PATTERN' });
    expect((await rowOf(rule.id)).props['orbis/rule_pattern']).toBe('пятерочка');
  });

  // Половина «факта» обязана остаться свободной: у факта образца не бывает, и гейт,
  // задевший его, запретил бы владельцу записать в память обычное знание о себе.
  test('факт памяти без образца пишется свободно', async () => {
    const e = entityOf(
      await run('entity_create', {
        title: 'Владелец не ест мясо',
        tags: [],
        props: { 'orbis/memory_kind': 'fact' },
        aspects: ['orbis/memory'],
      }),
    );
    expect((await rowOf(e.id)).props).toEqual({ 'orbis/memory_kind': 'fact' });
  });
});

describe('core-проекция в props — отказ на всех путях записи (§А1-3, единица 15-бис)', () => {
  const CORE_VALUES: Record<string, unknown> = {
    'orbis/archived': true,
    'orbis/title': 'Вторая правда',
    'orbis/created_at': '2026-08-26T10:00:00.000Z',
    'orbis/updated_at': '2026-08-26T10:00:00.000Z',
  };

  test('entity_create: каждое из четырёх core-свойств в props → CORE_IN_PROPS, строки нет', async () => {
    for (const [id, value] of Object.entries(CORE_VALUES)) {
      const entityId = newId();
      const denied = await run('entity_create', {
        id: entityId,
        title: 'Заголовок в колонке',
        tags: [],
        props: { [id]: value },
      });
      expect([id, denied.ok]).toEqual([id, false]);
      expect([id, violationsOf(denied)]).toEqual([
        id,
        [{ code: 'CORE_IN_PROPS', propertyId: id, storage: 'core' }],
      ]);
      // Отказ ДО записи: фантомной строки после него не остаётся.
      const rows = await withIdentity(db, owner, (tx) =>
        tx.select({ id: entities.id }).from(entities).where(eq(entities.id, entityId)),
      );
      expect([id, rows.length]).toEqual([id, 0]);
    }
  });

  test('entity_update: тот же отказ; колонка при этом остаётся ЕДИНСТВЕННОЙ правдой', async () => {
    const e = entityOf(await run('entity_create', { title: 'Настоящий заголовок', tags: [] }));
    const denied = await run('entity_update', { id: e.id, props: { 'orbis/title': 'Подмена' } });
    expect(denied.ok).toBe(false);
    expect(violationsOf(denied)).toEqual([
      { code: 'CORE_IN_PROPS', propertyId: 'orbis/title', storage: 'core' },
    ]);
    const row = await rowOf(e.id);
    expect(Object.keys(row.props)).not.toContain('orbis/title');

    // ОТКАЗ ВЕДЁТ К ВЫХОДУ: то же намерение своим полем вызова исполняется — и меняет
    // именно ту правду, которую читают все (колонку), а не заводит вторую.
    const renamed = entityOf(await run('entity_update', { id: e.id, title: 'Подмена' }));
    expect(renamed.title).toBe('Подмена');
    expect(Object.keys((await rowOf(e.id)).props)).not.toContain('orbis/title');
    // Архивация — тем же способом, своим полем; `orbis/archived` в props так же закрыт.
    const archiveDenied = await run('entity_update', {
      id: e.id,
      props: { 'orbis/archived': true },
    });
    expect(violationsOf(archiveDenied)).toEqual([
      { code: 'CORE_IN_PROPS', propertyId: 'orbis/archived', storage: 'core' },
    ]);
    expect(ok(await run('entity_update', { id: e.id, archived: true })).ok).toBe(true);
  });

  test('attach_*: третий путь появления значений закрыт тем же кодом', async () => {
    const e = entityOf(await run('entity_create', { title: 'Ночь', tags: [] }));
    const denied = await run('attach_user_sleep_log', {
      entity_id: e.id,
      data: { 'user/hours': 7, 'orbis/title': 'Подмена через носитель' },
    });
    expect(denied.ok).toBe(false);
    expect(violationsOf(denied)).toContainEqual({
      code: 'CORE_IN_PROPS',
      propertyId: 'orbis/title',
      storage: 'core',
    });
  });

  test('предусловие CAS по core-свойству НЕ задето: адрес в реестре остаётся живым', async () => {
    // Гейт запрещает core-свойству ЗНАЧЕНИЕ в `props`, а не сам адрес: §А1-3 завёл его ради
    // Q-AST, подписи и предусловий, и запрет, задевший бы их, отнял бы у реформы её же цель.
    const e = entityOf(await run('entity_create', { title: 'Цель предусловия', tags: [] }));
    const byTitle = await run('entity_update', {
      id: e.id,
      precondition: [{ property: 'orbis/title', in: ['Цель предусловия'] }],
      tags: ['помечена'],
    });
    expect(entityOf(byTitle).tags).toEqual(['помечена']);
  });
});
