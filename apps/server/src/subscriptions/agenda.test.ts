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
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
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
  });

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
