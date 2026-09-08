// apps/server/test/gate-c8-18.test.ts
// Гейт части Б (§С8-18, ревизия 3): два пользовательских аспекта, заведённых ТОЛЬКО декларацией,
// участвуют в четырёх потребителях без строки кода под них. Изначально все четыре утверждения
// были помечены `test.failing`: каждое переводит в `test` та задача вехи I, которая его зеленит
// (4 — excludeBlocked, 6 — Agenda, 7 — строка M14, 9 — spent; Р-К-9). С задачи 9 помеченных не
// осталось: все четыре потребителя зелены. Задача 10 проверяет это отдельно и снимает
// греп-доказательство.
//
// ПОЧЕМУ ТЕЛА `test.failing` СИНХРОННЫЕ. Bun 1.2.7 игнорирует пометку `.failing`, если
// тест вышел в макрозадачу (любой поход в БД или через tRPC — она): красный перестаёт
// поглощаться, а зелёный перестаёт валить сьют, то есть ломаются ОБЕ половины гарантии Р-К-9.
// Поэтому все походы к потребителям собраны в `beforeAll`, а тела тестов синхронно читают
// собранное. ПРАВИЛО: новый `test.failing` в этом репозитории — только с синхронным телом.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type RowProjection, rowProjectionOf } from '@orbis/shared';
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
 *  обязана остаться настоящей (отказ ручки, промах движка), а не выродиться в `undefined`. */
function taken<T>(r: Collected<T> | undefined, what: string): T {
  if (r === undefined) throw new Error(`сбор потребителя «${what}» не выполнялся`);
  if ('err' in r) throw r.err;
  return r.ok;
}

/**
 * Строки повестки — ОДНИМ вызовом подписки (§А5-5). Три боевых текста §6.1 сняты вместе с
 * переводом вкладки (шаг 18): собственного текста запроса у Повестки больше нет.
 * Аспект гейта попадает сюда ТОЛЬКО декларацией — `user/gate-plain` реализует `orbis/when`
 * (слот `moment`) и `orbis/completable`, ни строки кода под него ни в движке, ни в роутере.
 */
async function agendaRows(
  user: string,
): Promise<Array<{ id: string; section: 'window' | 'overdue' }>> {
  const r = await callerFor(user).agenda.list({ days: 8 });
  return r.rows.map((x) => ({ id: x.entity.id, section: x.section }));
}

/** Тот же текст, что у снимка `core/exclude-blocked` (0b): состав, а не порядок. */
const EXCLUDE_BLOCKED_QUERY = 'excludeBlocked=true, sortBy=orbis/title:asc, limit=50';

let overview: Collected<Overview>;
let agenda: Collected<Array<{ id: string; section: 'window' | 'overdue' }>>;
let m14: Collected<{ reg: Registry; fin: WireEntityRead; closed: WireEntityRead }>;
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
    const reg = await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner));
    const fin = (await c.entity.get({ id: world.finId })).entity;
    const closed = (await c.entity.get({ id: world.blockerClosedId })).entity;
    return { reg, fin, closed };
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

  // ЗЕЛЁНЫЙ с задачи 9. Прежде `spent` считал `spentByEnvelope` (`budget/aggregates.ts`) по
  // `'orbis/financial' = ANY(e.aspects)` и по свойствам `orbis/amount`/`orbis/direction`/
  // `orbis/occurred_on` — аспекта гейта он не видел вовсе. Теперь ведомость строит движок
  // подписки по КОНТРАКТУ `orbis/money-movement`, и привязка аспекта владельца попадает в тот же
  // COALESCE по привязкам без единой строки кода под неё. Ребро `envelope-binding` при этом
  // кладёт ФИКСТУРА: пишущая половина (бюджет-хук) ещё смотрит на жёсткие id `orbis/financial` —
  // её обобщает задача 11 и тем же коммитом снимает ручное ребро (Р-К-39).
  test('трата gate-fin попадает в spent своего конверта (§С8-18, потребитель 1)', () => {
    const env = taken(overview, 'budget.overview').envelopes.find(
      (e) => e.envelope.id === world.envelopeId,
    );
    expect(env).toBeDefined();
    expect(env?.spent).toBe(GATE_AMOUNT);
  });

  // ЗЕЛЁНЫЙ с задачи 6. Прежде вкладка спрашивала тремя текстами, требовавшими
  // `aspect=orbis/schedule`/`aspect=orbis/task`, и дело гейта, не несущее ни того ни другого,
  // не попадало ни в одну секцию. Теперь секции строит подписка по КОНТРАКТАМ — `user/gate-plain`
  // реализует `orbis/when` (слот `moment`) и `orbis/completable`, и этого достаточно.
  test('дела gate-plain попадают в Agenda: окно и просроченное (§С8-18, потребитель 2)', () => {
    const section = new Map(taken(agenda, 'Agenda').map((r) => [r.id, r.section]));
    expect(section.get(world.windowId)).toBe('window');
    expect(section.get(world.overdueId)).toBe('overdue');
  });

  // ЗЕЛЁНЫЙ с задачи 7. Прежде строку собирали ветки `if` по именам аспектов
  // (`orbis/task`/`orbis/financial`/`orbis/schedule`), и аспект гейта не давал ни чекбокса, ни
  // даты, ни суммы. Теперь правило — данные (`M14_ROW_ELEMENTS` + `rowProjectionOf`), и элемент
  // получает всякий, кто реализует контракт: под `user/gate-fin` нет ни строки кода.
  test('строка M14 собирается по контрактам: чекбокс, дата, сумма (§С8-18, потребитель 3)', () => {
    const { reg, fin, closed } = taken(m14, 'строка M14');
    const finRow: RowProjection = rowProjectionOf(fin, reg);
    expect(finRow.checkbox).toEqual({ closed: false, cls: 'active' });
    expect(finRow.amount).toEqual({ amount: GATE_AMOUNT, direction: 'outflow', currency: null });
    expect(finRow.date?.slot).toBe('moment');
    // Второй класс того же контракта: `closed` берётся из набора, а не из литерала `'done'`.
    expect(rowProjectionOf(closed, reg).checkbox).toEqual({ closed: true, cls: 'done' });
  });

  // ЗЕЛЁН С ЗАДАЧИ 4. Сахар разворачивается в `sourceNotIn: {contract, set}`, а компилятор
  // спрашивает членство в наборе `closed` по ПРИВЯЗКАМ (`expr/compile.ts`) — и привязка
  // `GATE_PLAIN_ASPECT` к `orbis/completable` попадает в него без единой строки кода под
  // этот аспект. До задачи 4 здесь стояла прямая проверка `orbis/task_status`, которого у
  // аспекта гейта нет, и ЗАКРЫТЫЙ блокер считался незакрытым и прятал цель.
  test('закрытый блокер-gate-plain перестаёт прятать цель (§С8-18, потребитель 4)', () => {
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
