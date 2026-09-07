// apps/server/test/gate-c8-18.test.ts
// Гейт части Б (§С8-18, ревизия 3): два пользовательских аспекта, заведённых ТОЛЬКО декларацией,
// участвуют в четырёх потребителях без строки кода под них. Четыре утверждения помечены
// `test.failing`: сегодня они ложны, и каждое переводит в `test` та задача вехи I, которая его
// зеленит (4 — excludeBlocked, 6 — Agenda, 7 — строка M14, 9 — spent; Р-К-9). Задача 10 проверяет,
// что `test.failing` в файле не осталось, и снимает греп-доказательство.
//
// ПОЧЕМУ ТЕЛА ЧЕТЫРЁХ `test.failing` СИНХРОННЫЕ. Bun 1.2.7 игнорирует пометку `.failing`, если
// тест вышел в макрозадачу (любой поход в БД или через tRPC — она): красный перестаёт
// поглощаться, а зелёный перестаёт валить сьют, то есть ломаются ОБЕ половины гарантии Р-К-9.
// Поэтому все походы к потребителям собраны в `beforeAll`, а тела тестов синхронно читают
// собранное. ПРАВИЛО: новый `test.failing` в этом репозитории — только с синхронным телом.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AGENDA_QUERY_TEXTS } from '@orbis/shared/query/fixtures';
import { sql } from 'drizzle-orm';
import { withIdentity } from '../src/db/with-identity';
import { effectiveRegistry } from '../src/registry/cache';
import { appRouter } from '../src/router';
import { createCallerFactory } from '../src/trpc';
import {
  GATE_AMOUNT,
  GATE_ASPECT_KEYS,
  GATE_FIN_ASPECT,
  GATE_PLAIN_ASPECT,
  GATE_PROPS,
  type GateWorld,
  seedGateWorld,
} from './fixtures/gate-aspects';
import { adminDb, appDb, freshUserId, requireEnv, seedCustomAspect, truncateAll } from './helpers';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});

describe('фикстура гейта: хелпер пишет привязки', () => {
  test('seedCustomAspect кладёт implements и module — и ПЕРЕЗАПИСЫВАЕТ их при повторном севе', async () => {
    // ДВА утверждения, и оба обязательны (Р-К-53).
    // ПЕРВОЕ — после первого сева: сегодня хелпер `spec.implements`/`spec.module` не читает ВОВСЕ,
    // в INSERT стоят литералы `'[]'::jsonb` и `NULL`. Красным шаг делает именно оно.
    // ВТОРОЕ — после повторного, ловушка Р12: `ON CONFLICT … DO UPDATE SET` колонок
    // `implements`/`module` не перечисляет, и фикстура гейта, севшая дважды в одном прогоне,
    // вернула бы первую версию привязок. Одного второго мало: до правки оно ЗЕЛЁНОЕ — в базе и так
    // `[]` и NULL, но не потому, что хелпер их записал, а потому, что он записал литералы.
    const user = freshUserId();
    const spec = {
      key: 'user/impl-probe',
      label: { ru: 'Проба' },
      properties: [{ key: 'probe_flag', type: { kind: 'boolean' } as const }],
      module: 'finance' as string | null,
      implements: [
        { contract: 'orbis/completable', bind: { status: 'user/probe_flag' } },
      ] as unknown[],
    };
    const { db: adb, client: ac } = adminDb();
    // Чтение СЫРОЕ (jsonb как лежит), без zod: умолчания формы привязки подставляет схема задачи 2,
    // а здесь проверяется ровно то, что хелпер записал.
    const read = async (): Promise<{ implements: unknown[]; module: string | null } | undefined> =>
      (
        (await adb.execute(sql`SELECT implements, module FROM aspect_definitions
        WHERE owner_id = ${user} AND id = 'user/impl-probe'`)) as unknown as Array<{
          implements: unknown[];
          module: string | null;
        }>
      )[0];
    try {
      await seedCustomAspect(user, spec);
      const first = await read();
      expect(first?.implements).toEqual([
        { contract: 'orbis/completable', bind: { status: 'user/probe_flag' } },
      ]);
      expect(first?.module).toBe('finance');

      await seedCustomAspect(user, { ...spec, implements: [] as unknown[], module: null });
      const second = await read();
      expect(second?.implements).toEqual([]);
      expect(second?.module).toBeNull();
    } finally {
      await ac.end();
    }
  });
});

describe('фикстура гейта: два аспекта заведены только декларацией', () => {
  test('оба аспекта и восемь их свойств видны в снимке реестра владельца', async () => {
    const user = freshUserId();
    await seedCustomAspect(user, GATE_FIN_ASPECT);
    await seedCustomAspect(user, GATE_PLAIN_ASPECT);
    const reg = await withIdentity(db, user, (tx) => effectiveRegistry(tx, user));
    expect(GATE_ASPECT_KEYS.every((k) => reg.aspects.has(k))).toBe(true);
    for (const id of Object.values(GATE_PROPS)) expect(reg.properties.has(id)).toBe(true);
    // Привязки доехали до снимка как данные: на вехе 0 их никто не читает, и это ровно то,
    // что гейт обязан изменить — читателем станет реестр контрактов (задачи 1–2).
    expect((reg.aspects.get(GATE_ASPECT_KEYS[0])?.implements ?? []).length).toBe(3);
    expect((reg.aspects.get(GATE_ASPECT_KEYS[1])?.implements ?? []).length).toBe(2);
  });
});

const owner = freshUserId();
let world: GateWorld;
const createCaller = createCallerFactory(appRouter);
const callerFor = (user: string) =>
  createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });

type Caller = ReturnType<typeof callerFor>;
type Overview = Awaited<ReturnType<Caller['budget']['overview']>>;
type WireEntityRead = Awaited<ReturnType<Caller['entity']['get']>>['entity'];
type Registry = Awaited<ReturnType<typeof effectiveRegistry>>;

/** Поход к потребителю: ОШИБКА — тоже результат, а не поломка обстановки. */
type Collected<T> = { ok: T } | { err: unknown };

/**
 * Сходить к потребителю в `beforeAll` и запомнить исход.
 *
 * Отказ потребителя ловится здесь намеренно: свались на нём `beforeAll`, и три остальных
 * утверждения не выполнились бы вовсе — то есть перестали бы говорить каждое о своей причине.
 */
async function collect<T>(fn: () => Promise<T>): Promise<Collected<T>> {
  try {
    return { ok: await fn() };
  } catch (err) {
    return { err };
  }
}

/** Развернуть собранное СИНХРОННО. Ошибку потребителя перебрасывает КАК ЕСТЬ: причина провала
 *  обязана остаться настоящей («нет rowProjectionOf»), а не выродиться в `undefined`. */
function taken<T>(r: Collected<T> | undefined, what: string): T {
  if (r === undefined) throw new Error(`сбор потребителя «${what}» не выполнялся`);
  if ('err' in r) throw r.err;
  return r.ok;
}

interface GateRowProjection {
  checkbox: { closed: boolean; cls: string } | null;
  date: { value: string; slot: 'deadline' | 'moment' } | null;
  amount: { amount: string; direction: 'outflow' | 'inflow'; currency: string | null } | null;
}
/** Локальный слепок формы (Р-И-20). Задача 7 снимает его и импортирует настоящий `RowProjection`. */
type RowProjectionFn = (
  entity: { aspects: readonly string[]; props: Record<string, unknown> },
  reg: unknown,
) => GateRowProjection;

/**
 * Модуля `packages/shared/src/registry/row.ts` (задача 7) ещё нет, и импортировать его в шапке
 * НЕЛЬЗЯ: сломанный импорт уронил бы загрузку файла и все четыре теста разом — три из них
 * перестали бы говорить о своей причине. Поэтому ленивая загрузка с названной причиной.
 */
async function rowProjectionOrFail(): Promise<RowProjectionFn> {
  const shared = (await import('@orbis/shared')) as Record<string, unknown>;
  const fn = shared.rowProjectionOf;
  if (typeof fn !== 'function') {
    throw new Error(
      'строка M14 не переведена на контракты: в @orbis/shared нет rowProjectionOf ' +
        '(packages/shared/src/registry/row.ts — задача 7)',
    );
  }
  return fn as unknown as RowProjectionFn;
}

/**
 * Строки повестки. Сегодня — три боевых текста §6.1 (`AGENDA_QUERY_TEXTS`, они же
 * `useAgenda.ts`); задача 6 заменяет тело на `caller.agenda.list({ days: 8 })`. Утверждение
 * теста при этом не меняется — меняется только способ спросить; вызов остаётся из `beforeAll`.
 */
async function agendaRows(
  user: string,
): Promise<Array<{ id: string; section: 'window' | 'overdue' }>> {
  const c = callerFor(user);
  const win = await c.entity.query({ query: AGENDA_QUERY_TEXTS.days });
  const due = await c.entity.query({ query: AGENDA_QUERY_TEXTS.overdueDue });
  const start = await c.entity.query({ query: AGENDA_QUERY_TEXTS.overdueStart });
  return [
    ...win.map((e) => ({ id: e.id, section: 'window' as const })),
    ...due.map((e) => ({ id: e.id, section: 'overdue' as const })),
    ...start.map((e) => ({ id: e.id, section: 'overdue' as const })),
  ];
}

/** Тот же текст, что у снимка `core/exclude-blocked` (0b): состав, а не порядок. */
const EXCLUDE_BLOCKED_QUERY = 'excludeBlocked=true, sortBy=orbis/title:asc, limit=50';

let overview: Collected<Overview>;
let agenda: Collected<Array<{ id: string; section: 'window' | 'overdue' }>>;
let m14: Collected<{
  rowProjectionOf: RowProjectionFn;
  reg: Registry;
  fin: WireEntityRead;
  closed: WireEntityRead;
}>;
let excluded: Collected<Set<string>>;

beforeAll(async () => {
  await truncateAll();
  await seedCustomAspect(owner, GATE_FIN_ASPECT);
  await seedCustomAspect(owner, GATE_PLAIN_ASPECT);
  world = await seedGateWorld(owner);

  // Четыре похода к потребителям — здесь и только здесь (см. шапку файла про `test.failing`).
  const c = callerFor(owner);
  overview = await collect(() => c.budget.overview({ month: world.month }));
  agenda = await collect(() => agendaRows(owner));
  m14 = await collect(async () => {
    const rowProjectionOf = await rowProjectionOrFail();
    const reg = await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner));
    const fin = (await c.entity.get({ id: world.finId })).entity;
    const closed = (await c.entity.get({ id: world.blockerClosedId })).entity;
    return { rowProjectionOf, reg, fin, closed };
  });
  excluded = await collect(
    async () => new Set((await c.entity.query({ query: EXCLUDE_BLOCKED_QUERY })).map((e) => e.id)),
  );
});

describe('гейт §С8-18: аспект только декларацией', () => {
  test('обстановка гейта на месте: конверт, трата, два дела, блокеры и сущность §С8-21', async () => {
    const ids = new Set(
      (await callerFor(owner).entity.query({ query: 'sortBy=orbis/title:asc, limit=50' })).map(
        (e) => e.id,
      ),
    );
    for (const id of [
      world.envelopeId,
      world.finId,
      world.windowId,
      world.overdueId,
      world.blockedId,
      world.blockerClosedId,
      world.blockedOpenId,
      world.blockerOpenId,
      world.ambiguousId,
    ])
      expect(ids.has(id)).toBe(true);
  });

  // Зеленит задача 9 (подписка Budget). Сегодня `spent` считает `spentByEnvelope`
  // (`budget/aggregates.ts`) по `'orbis/financial' = ANY(e.aspects)` и по свойствам
  // `orbis/amount`/`orbis/direction`/`orbis/occurred_on` — аспекта гейта он не видит вовсе.
  test.failing('трата gate-fin попадает в spent своего конверта (§С8-18, потребитель 1)', () => {
    const env = taken(overview, 'budget.overview').envelopes.find(
      (e) => e.envelope.id === world.envelopeId,
    );
    expect(env).toBeDefined();
    expect(env?.spent).toBe(GATE_AMOUNT);
  });

  // Зеленит задача 6. Сегодня оба текста требуют `aspect=orbis/schedule`/`aspect=orbis/task` —
  // дело гейта не несёт ни того, ни другого и в повестку не попадает ни в одну секцию.
  test.failing('дела gate-plain попадают в Agenda: окно и просроченное (§С8-18, потребитель 2)', () => {
    const section = new Map(taken(agenda, 'Agenda').map((r) => [r.id, r.section]));
    expect(section.get(world.windowId)).toBe('window');
    expect(section.get(world.overdueId)).toBe('overdue');
  });

  // Зеленит задача 7 (контракт → элемент строки).
  test.failing('строка M14 собирается по контрактам: чекбокс, дата, сумма (§С8-18, потребитель 3)', () => {
    const { rowProjectionOf, reg, fin, closed } = taken(m14, 'строка M14');
    const finRow = rowProjectionOf(fin, reg);
    expect(finRow.checkbox).toEqual({ closed: false, cls: 'active' });
    expect(finRow.amount).toEqual({ amount: GATE_AMOUNT, direction: 'outflow', currency: null });
    expect(finRow.date?.slot).toBe('moment');
    // Второй класс того же контракта: `closed` берётся из набора, а не из литерала `'done'`.
    expect(rowProjectionOf(closed, reg).checkbox).toEqual({ closed: true, cls: 'done' });
  });

  // Зеленит задача 4. Сегодня сахар разворачивается в `sourceNotIn` по `orbis/task_status`
  // (`parse-ast.ts`), а `COALESCE(b.props->>'orbis/task_status','')` у блокера-gate-plain
  // пусто (`compile-ast.ts`) — то есть ЗАКРЫТЫЙ блокер считается незакрытым и прячет цель.
  test.failing('закрытый блокер-gate-plain перестаёт прятать цель (§С8-18, потребитель 4)', () => {
    expect(taken(excluded, 'excludeBlocked').has(world.blockedId)).toBe(true);
  });

  test('контроль: открытый блокер-gate-plain прячет цель — и сегодня, и после вехи I', () => {
    // Обычный тест, а не failing: он обязан быть зелёным ВСЕГДА, иначе «цель видна» из теста
    // выше окажется тавтологией «excludeBlocked перестал работать вовсе».
    const ids = taken(excluded, 'excludeBlocked');
    expect(ids.has(world.blockedOpenId)).toBe(false);
    expect(ids.has(world.finId)).toBe(true);
  });
});
