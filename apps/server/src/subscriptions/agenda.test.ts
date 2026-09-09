// apps/server/src/subscriptions/agenda.test.ts
// Движок подписки Agenda (§Б5-6) на ЖИВОЙ БД: одна выборка вместо трёх текстов вкладки.
//
// Меряется ПАРИТЕТ с клиентскими правилами §8.1–§8.4: те же сущности в тех же секциях, тот
// же выбор даты у просроченного. Роутер и материализация здесь ни при чём — движок зовётся
// напрямую, иначе красный тест не отличал бы выборку от конвейера вокруг неё.
//
// «Сегодня» шва не имеет (K13): фикстуры строятся ОТНОСИТЕЛЬНО реального «сегодня» в
// Europe/Moscow — прецедент `agenda-acceptance.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AgendaListResult, addDays } from '@orbis/shared';
import { GATE_PLAIN_ASPECT, GATE_PLAIN_KEY, GATE_PROPS } from '../../test/fixtures/gate-aspects';
import { appDb, freshUserId, requireEnv, seedCustomAspect, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { materializeInstances } from '../recurring/materialize';
import { effectiveRegistry } from '../registry/cache';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { agendaListOf, agendaSubscriptionOf } from './agenda';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);
const TZ = 'Europe/Moscow';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const at = (day: string, time: string) => `${day}T${time}:00+03:00`;
const callerFor = (u: string) =>
  createCaller({ actorUserId: u, actorKind: 'owner', db, clientVersion: null });
const make = async (
  u: string,
  title: string,
  f: { props?: Record<string, unknown>; aspects?: string[] },
) => (await callerFor(u).entity.create({ input: { title, tags: [], ...f }, source: 'ui' })).id;

/** Движок напрямую — без роутера и материализации: проверяется выборка, а не конвейер. */
const listFor = (u: string, days = 8) =>
  withIdentity(db, u, async (tx) => {
    const reg = await effectiveRegistry(tx, u);
    return agendaListOf(tx, u, agendaSubscriptionOf(reg), { today, timeZone: TZ, days });
  });
const idsOf = (r: AgendaListResult, s: 'window' | 'overdue') =>
  new Set(r.rows.filter((x) => x.section === s).map((x) => x.entity.id));

beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

describe('движок Agenda: одна подписка, один запрос, тег секции', () => {
  test('§8.1: чистое событие вчера — ни в окне, ни в просроченном (класса завершаемости нет)', async () => {
    const u = freshUserId();
    const ev = await make(u, 'Прошедший созвон', {
      props: { 'orbis/start_at': at(addDays(today, -1), '10:00') },
      aspects: ['orbis/schedule'],
    });
    const r = await listFor(u);
    expect([idsOf(r, 'window').has(ev), idsOf(r, 'overdue').has(ev)]).toEqual([false, false]);
    // Негатив: с orbis/task та же сущность просрочена ПО СЛОТУ moment
    await callerFor(u).entity.update({
      id: ev,
      props: { 'orbis/task_status': 'planned' },
      aspects: { attach: ['orbis/task'] },
    });
    const r2 = await listFor(u);
    expect(idsOf(r2, 'overdue').has(ev)).toBe(true);
    expect(r2.rows.find((x) => x.entity.id === ev)?.slot).toBe('moment');
  });

  test('§8.2: срок вчера — просроченное; done уносит строку (класс вышел из набора open)', async () => {
    const u = freshUserId();
    const t = await make(u, 'Закончить API', {
      props: { 'orbis/task_status': 'in_progress', 'orbis/due_date': addDays(today, -1) },
      aspects: ['orbis/task'],
    });
    expect(idsOf(await listFor(u), 'overdue').has(t)).toBe(true);
    await callerFor(u).entity.update({
      id: t,
      props: { 'orbis/task_status': 'done' },
      aspects: { attach: ['orbis/task'] },
    });
    expect(idsOf(await listFor(u), 'overdue').has(t)).toBe(false);
  });

  test('§8.3: обе даты в прошлом — ОДНА строка, дата — минимум из двух, слот назван', async () => {
    const u = freshUserId();
    const t = await make(u, 'Подтвердить созвон', {
      props: {
        'orbis/task_status': 'planned',
        'orbis/due_date': addDays(today, -3),
        'orbis/start_at': at(addDays(today, -1), '09:00'),
      },
      aspects: ['orbis/task', 'orbis/schedule'],
    });
    const rows = (await listFor(u)).rows.filter((x) => x.entity.id === t);
    expect(rows).toHaveLength(1);
    expect([rows[0]?.section, rows[0]?.at, rows[0]?.slot]).toEqual([
      'overdue',
      addDays(today, -3),
      'deadline',
    ]);
  });

  test('§8.4: окно — только слот moment; задача с одним сроком в него не попадает', async () => {
    const u = freshUserId();
    const due = await make(u, 'Разобрать Inbox', {
      props: { 'orbis/task_status': 'in_progress', 'orbis/due_date': addDays(today, 1) },
      aspects: ['orbis/task'],
    });
    const sch = await make(u, 'Врач', {
      props: { 'orbis/task_status': 'planned', 'orbis/start_at': at(addDays(today, 1), '14:00') },
      aspects: ['orbis/task', 'orbis/schedule'],
    });
    const r = await listFor(u);
    expect([idsOf(r, 'window').has(due), idsOf(r, 'window').has(sch)]).toEqual([false, true]);
    expect(r.rows.find((x) => x.entity.id === sch)?.at).toBe(at(addDays(today, 1), '14:00'));
  });

  test('срок вчера + начало завтра — строки ОБЕИХ секций (паритет трёх запросов)', async () => {
    // Сегодня такая задача приходит и в дневном окне, и в просроченном; единственный запрос
    // обязан сохранить оба вхождения — иначе паритет §С8-17 фиктивен.
    const u = freshUserId();
    const t = await make(u, 'Оплатить интернет', {
      props: {
        'orbis/task_status': 'planned',
        'orbis/due_date': addDays(today, -1),
        'orbis/start_at': at(addDays(today, 1), '09:00'),
      },
      aspects: ['orbis/task', 'orbis/schedule'],
    });
    const r = await listFor(u);
    expect(
      r.rows
        .filter((x) => x.entity.id === t)
        .map((x) => x.section)
        .sort(),
    ).toEqual(['overdue', 'window']);
    expect([r.today, r.timezone]).toEqual([today, TZ]); // клиенту незачем считать их второй раз
  });
});

describe('движок Agenda: потолок секций, наборы контрактов, горизонт', () => {
  test('«200+» — ПО СЕКЦИИ: 201-я строка просроченного не приезжает, флаг поднят, окно цело', async () => {
    const u = freshUserId();
    for (let i = 0; i < 201; i++)
      await make(u, `Задача ${i}`, {
        props: { 'orbis/task_status': 'planned', 'orbis/due_date': addDays(today, -1) },
        aspects: ['orbis/task'],
      });
    const r = await listFor(u);
    expect(r.rows.filter((x) => x.section === 'overdue')).toHaveLength(200);
    expect(r.truncated).toEqual({ window: false, overdue: true });
  }, 30_000); // явный таймаут: десятки операций через исполнитель не влезают в 5 с при server ∥ web (Ф-Б1-41)

  test('шаблон повторения скрыт набором templates, инстанс виден; окно материализации из декларации (Р-К-12)', async () => {
    const u = freshUserId();
    const tpl = await make(u, 'Стендап (шаблон)', {
      props: {
        'orbis/start_at': at(today, '09:00'),
        'orbis/recurrence': { freq: 'daily', interval: 1 },
      },
      aspects: ['orbis/schedule'],
    });
    await materializeInstances({ db, ownerId: u, from: today, to: addDays(today, 7), today });
    const win = (await listFor(u)).rows.filter((x) => x.section === 'window');
    expect(win.map((x) => x.entity.id)).not.toContain(tpl);
    expect(win.length).toBeGreaterThanOrEqual(7); // по инстансу на каждый день окна
  });

  test('за потолком ОДНОЙ секции строка не просачивается через другую (I-1)', async () => {
    // 201 просроченная задача плюс 202-я, которая ещё и в окне: внешний WHERE пропускает её по
    // окну, и до правки цикл толкал её в просроченное — 201 строка при поднятом флаге.
    // Даты подобраны так, что двойная сортируется в просроченном ПОСЛЕДНЕЙ (LEAST по её паре
    // даёт вчера против позавчера у остальных), то есть её rn_overdue заведомо за сторожем.
    const u = freshUserId();
    for (let i = 0; i < 201; i++)
      await make(u, `Просрочено ${i}`, {
        props: { 'orbis/task_status': 'planned', 'orbis/due_date': addDays(today, -2) },
        aspects: ['orbis/task'],
      });
    const both = await make(u, 'И в окне, и просрочено', {
      props: {
        'orbis/task_status': 'planned',
        'orbis/due_date': addDays(today, -1),
        'orbis/start_at': at(addDays(today, 1), '09:00'),
      },
      aspects: ['orbis/task', 'orbis/schedule'],
    });
    const r = await listFor(u);
    expect(r.rows.filter((x) => x.section === 'overdue')).toHaveLength(200);
    expect(r.truncated).toEqual({ window: false, overdue: true });
    // …и своей ЗАКОННОЙ секции она при этом не теряет: потолок окна не задет
    expect(idsOf(r, 'window').has(both)).toBe(true);
    expect(idsOf(r, 'overdue').has(both)).toBe(false);
  }, 30_000); // явный таймаут: десятки операций через исполнитель не влезают в 5 с при server ∥ web (Ф-Б1-41)

  test('направление окна — из декларации: sortBy desc переворачивает порядок (M-3)', async () => {
    const u = freshUserId();
    const t1 = await make(u, 'Сегодня', {
      props: { 'orbis/start_at': at(today, '10:00') },
      aspects: ['orbis/schedule'],
    });
    const t2 = await make(u, 'Завтра', {
      props: { 'orbis/start_at': at(addDays(today, 1), '10:00') },
      aspects: ['orbis/schedule'],
    });
    const listWith = (sortBy: 'asc' | 'desc') =>
      withIdentity(db, u, async (tx) => {
        const def = agendaSubscriptionOf(await effectiveRegistry(tx, u));
        return agendaListOf(
          tx,
          u,
          { ...def, show: { ...def.show, sortBy } },
          { today, timeZone: TZ, days: 8 },
        );
      });
    const idsIn = (r: AgendaListResult) =>
      r.rows.filter((x) => x.section === 'window').map((x) => x.entity.id);
    expect(idsIn(await listWith('asc'))).toEqual([t1, t2]);
    expect(idsIn(await listWith('desc'))).toEqual([t2, t1]);
  });

  /**
   * B3 I-1: `overdue.where` валидатор типизирует в области контракта `orbis/when` (`agendaSites`),
   * а движок компилировал его БЕЗ привязки — и слот контракта, принятый на записи, отказывал
   * `EXPR_SHAPE` на чтении, роняя `agenda.list` целиком.
   */
  test('слот контракта в overdue.where: принято на записи — обязано считаться на чтении', async () => {
    const u = freshUserId();
    const byDeadline = await make(u, 'Со сроком', {
      props: { 'orbis/task_status': 'planned', 'orbis/due_date': addDays(today, -1) },
      aspects: ['orbis/task'],
    });
    const byMoment = await make(u, 'Только момент', {
      props: { 'orbis/task_status': 'planned', 'orbis/start_at': at(addDays(today, -1), '10:00') },
      aspects: ['orbis/task', 'orbis/schedule'],
    });
    const r = await withIdentity(db, u, async (tx) => {
      const def = agendaSubscriptionOf(await effectiveRegistry(tx, u));
      return agendaListOf(
        tx,
        u,
        {
          ...def,
          overdue: {
            ...def.overdue,
            where: { op: 'and', args: [def.overdue.where, { has: 'deadline' }] },
          },
        },
        { today, timeZone: TZ, days: 8 },
      );
    });
    const overdue = idsOf(r, 'overdue');
    expect([overdue.has(byDeadline), overdue.has(byMoment)]).toEqual([true, false]);
  });

  /**
   * `prefer` — ОДИН НА СЛОТ (Ф-Б1-60). Владелец, снявший `SLOT_AMBIGUOUS` документированным путём
   * (`show.prefer`), получал тот же отказ, когда сущность с двумя `moment` становилась
   * ПРОСРОЧЕННОЙ: секция `overdue` читала только свой `overdue.prefer` — и `agenda.list` падала
   * целиком, а не одной строкой. Явный `overdue.prefer` по-прежнему главнее.
   */
  test('overdue наследует show.prefer, когда свой prefer пуст (Ф-Б1-60)', async () => {
    const u = freshUserId();
    await seedCustomAspect(u, GATE_PLAIN_ASPECT);
    const both = await make(u, 'Две привязки moment, просрочено', {
      aspects: ['orbis/schedule', GATE_PLAIN_KEY],
      props: {
        'orbis/start_at': at(addDays(today, -1), '10:00'),
        [GATE_PROPS.plainState]: 'open',
        [GATE_PROPS.plainAt]: at(addDays(today, -1), '09:00'),
      },
    });
    const listWith = (prefer: { show: string[]; overdue: string[] }) =>
      withIdentity(db, u, async (tx) => {
        const def = agendaSubscriptionOf(await effectiveRegistry(tx, u));
        return agendaListOf(
          tx,
          u,
          {
            ...def,
            show: { ...def.show, prefer: prefer.show },
            overdue: { ...def.overdue, prefer: prefer.overdue },
          },
          { today, timeZone: TZ, days: 8 },
        );
      });
    // Без единого prefer движок обязан отказать — контроль, что фикстура и есть §С8-21.
    // `await` несущий: без него утверждение не ждётся, и фикстура, переставшая быть
    // неоднозначной, прошла бы контроль вхолостую, оставив два следующих утверждения
    // тривиальными (тест зелен, а fallback им больше не доказан).
    await expect(listWith({ show: [], overdue: [] })).rejects.toThrow();
    // `show.prefer` снимает неоднозначность и для просроченного.
    const r = await listWith({ show: [GATE_PLAIN_KEY], overdue: [] });
    expect(idsOf(r, 'overdue').has(both)).toBe(true);
    // Явный `overdue.prefer` главнее унаследованного: выбирается ДРУГАЯ привязка (09:00 vs 10:00).
    const own = await listWith({ show: [GATE_PLAIN_KEY], overdue: ['orbis/schedule'] });
    expect(idsOf(own, 'overdue').has(both)).toBe(true);
  });

  test('горизонт — параметр вызова: days=1 отдаёт только сегодняшний день', async () => {
    const u = freshUserId();
    const t1 = await make(u, 'Сегодня', {
      props: { 'orbis/start_at': at(today, '10:00') },
      aspects: ['orbis/schedule'],
    });
    const t2 = await make(u, 'Завтра', {
      props: { 'orbis/start_at': at(addDays(today, 1), '10:00') },
      aspects: ['orbis/schedule'],
    });
    const w = idsOf(await listFor(u, 1), 'window');
    expect([w.has(t1), w.has(t2)]).toEqual([true, false]);
  });
});
