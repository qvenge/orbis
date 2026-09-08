// apps/server/src/routers/agenda-acceptance.test.ts
// Task D6a — приёмка 02-core-os §8.1–8.4 (Agenda) на СЕРВЕРНОЙ стороне.
//
// Клиентская половина приёмки живёт в apps/web/src/features/agenda/AgendaScreen.test.tsx:
// там проверяется раскладка по секциям на моках. Здесь проверяется СМЫСЛ выборки на живой
// БД: какие сущности подписка `orbis/agenda` действительно вернёт и какие — нет.
//
// Вкладка спрашивает ОДНОЙ ручкой `agenda.list` (§А5-5), поэтому и приёмка спрашивает ею:
// собственных текстов запроса у Повестки больше нет, а паритет §С8-17 и означает, что все
// четыре пункта §8.1–§8.4 остались зелёными после перевода на подписку.
// Пункты §8.1 («остаётся доступна в Browser») и §8.4 («видна в Daily Planning/Upcoming»)
// вне вкладки Agenda вообще и на клиентских моках недоказуемы.
//
// «Сегодня» шва не имеет (K13) — фикстуры строятся ОТНОСИТЕЛЬНО реального «сегодня»
// в дефолтной таймзоне Europe/Moscow (прецедент aggregates.test.ts, post-due.test.ts).
// Ни одна фикстура не recurring: K15 — start_at=overdue расширяет окно материализации
// только до [today; today], прошлое задним числом не материализуется.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AgendaSubscription, addDays, BUILTIN_SUBSCRIPTION_DEFS } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { appDb, freshUserId, requireEnv, seedCustomAspect, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { setSubscriptionDelta } from '../registry/ops';
import { appRouter } from '../router';
import { DAILY_PLANNING_BODY, UPCOMING_BODY } from '../seed/smart-lists';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

const TZ = 'Europe/Moscow';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);

/** Момент 'YYYY-MM-DDTHH:MM:00+03:00' — фиксированное смещение Europe/Moscow. */
const at = (day: string, time: string) => `${day}T${time}:00+03:00`;

/** Browser без фильтров (apps/web/src/features/browser/query.ts browserQuery). */
const BROWSER_QUERY = 'sortBy=orbis/updated_at:desc, limit=50';

/** N-й {{query:}}-блок body smart-list'а — тот же разбор, что в onboarding.test.ts. */
function queryBlock(body: string, index: number): string {
  const matches = [...body.matchAll(/\{\{query:\s*([\s\S]*?)\}\}/g)];
  const block = matches[index]?.[1];
  if (block === undefined) throw new Error(`в body нет query-блока №${index}`);
  return block;
}

/**
 * Daily Planning, список «Сегодня» (02 §3.3) — ВТОРОЙ блок body.
 * Что этот блок вообще доезжает до экрана — отдельное утверждение продуктовой половины
 * §8.4: detail-экран обязан рендерить КАЖДЫЙ query-блок body (02 §3.4), а не первый.
 * Пиннится в apps/web/src/features/entity-detail/detail.test.tsx («detail рендерит
 * КАЖДЫЙ query-блок body: у Daily Planning — три секции, включая «Сегодня»»).
 */
const DAILY_TODAY_QUERY = queryBlock(DAILY_PLANNING_BODY, 1);
/** Upcoming, «Ближайшие 7 дней» (02 §3.3) — первый блок. */
const UPCOMING_7D_QUERY = queryBlock(UPCOMING_BODY, 0);

function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

/** Форма создания §А1-1: значения плоско по id свойства, аспекты — списком навешенного. */
type NewForm = { props?: Record<string, unknown>; aspects?: string[] };

async function createEntity(user: string, title: string, form: NewForm): Promise<string> {
  const e = await callerFor(user).entity.create({
    input: { title, tags: [], ...form },
    source: 'ui',
  });
  return e.id;
}

/** Секция повестки одним вызовом — ровно тем, которым её читает вкладка. */
const agendaIds = async (u: string, section: 'window' | 'overdue') =>
  new Set(
    (await callerFor(u).agenda.list({ days: 8 })).rows
      .filter((r) => r.section === section)
      .map((r) => r.entity.id),
  );

/** Browser и сид-списки остаются на entity.query — они не подписка. */
const queryIds = async (u: string, query: string) =>
  new Set((await callerFor(u).entity.query({ query })).map((r) => r.id));

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('приёмка 02-core-os §8.1: прошедшее чистое событие', () => {
  // «Прошедшая чистая сущность с одним orbis/schedule не появляется в „Просроченном“
  // и остаётся доступна в Browser».
  test('вчерашнее событие без orbis/task: нет в обеих выборках «Просроченного», есть в Browser', async () => {
    const user = freshUserId();
    const event = await createEntity(user, 'Прошедший созвон', {
      props: { 'orbis/start_at': at(yesterday, '10:00') },
      aspects: ['orbis/schedule'],
    });

    // Просроченное требует членства в наборе `open` контракта завершаемости (§Б5-6): у
    // чистого события класса нет вовсе, и обе причины просрочки — срок и начало — мимо.
    expect((await agendaIds(user, 'overdue')).has(event)).toBe(false);

    // …и при этом сущность жива и находится обычным списком Browser (02 §3)
    expect((await queryIds(user, BROWSER_QUERY)).has(event)).toBe(true);
    expect((await queryIds(user, `aspect=orbis/schedule, ${BROWSER_QUERY}`)).has(event)).toBe(true);
  });

  test('та же сущность с добавленным orbis/task попадает в «Просроченное» по start_at', async () => {
    // Негатив к предыдущему тесту: отсекает именно отсутствие orbis/task, а не что-то ещё
    // (иначе первый тест проходил бы и при сломанном start_at=overdue).
    const user = freshUserId();
    const event = await createEntity(user, 'Созвон, ставший задачей', {
      props: { 'orbis/start_at': at(yesterday, '10:00') },
      aspects: ['orbis/schedule'],
    });
    expect((await agendaIds(user, 'overdue')).has(event)).toBe(false);

    await callerFor(user).entity.update({
      id: event,
      props: {
        'orbis/task_status': 'planned',
      },
      aspects: { attach: ['orbis/task'] },
    });
    expect((await agendaIds(user, 'overdue')).has(event)).toBe(true);
  });
});

describe('приёмка 02-core-os §8.2: задача с просроченным due_date', () => {
  // «Незакрытая task-сущность с просроченным due_date появляется в „Просроченном“
  // независимо от наличия schedule; после done, переноса или архивации исчезает».
  test('появляется независимо от наличия schedule', async () => {
    const user = freshUserId();
    const bare = await createEntity(user, 'Закончить API', {
      props: { 'orbis/task_status': 'in_progress', 'orbis/due_date': yesterday },
      aspects: ['orbis/task'],
    });
    const scheduled = await createEntity(user, 'Оплатить интернет', {
      props: {
        'orbis/task_status': 'planned',
        'orbis/due_date': yesterday,
        'orbis/start_at': at(tomorrow, '09:00'), // расписание в БУДУЩЕМ
      },
      aspects: ['orbis/task', 'orbis/schedule'],
    });

    const overdue = await agendaIds(user, 'overdue');
    expect(overdue.has(bare)).toBe(true);
    expect(overdue.has(scheduled)).toBe(true);
    // …и просрочена она ПО СРОКУ: начало в будущем, слот строки обязан назвать причину
    const rows = (await callerFor(user).agenda.list({ days: 8 })).rows;
    expect(rows.find((r) => r.entity.id === scheduled && r.section === 'overdue')?.slot).toBe(
      'deadline',
    );
  });

  test('после done исчезает', async () => {
    const user = freshUserId();
    const task = await createEntity(user, 'Закончить API', {
      props: { 'orbis/task_status': 'in_progress', 'orbis/due_date': yesterday },
      aspects: ['orbis/task'],
    });
    expect((await agendaIds(user, 'overdue')).has(task)).toBe(true);

    await callerFor(user).entity.update({
      id: task,
      props: {
        'orbis/task_status': 'done',
      },
      aspects: { attach: ['orbis/task'] },
    });
    expect((await agendaIds(user, 'overdue')).has(task)).toBe(false);
  });

  test('после переноса срока исчезает', async () => {
    const user = freshUserId();
    const task = await createEntity(user, 'Закончить API', {
      props: { 'orbis/task_status': 'in_progress', 'orbis/due_date': yesterday },
      aspects: ['orbis/task'],
    });
    expect((await agendaIds(user, 'overdue')).has(task)).toBe(true);

    await callerFor(user).entity.update({
      id: task,
      props: {
        'orbis/due_date': tomorrow,
      },
      aspects: { attach: ['orbis/task'] },
    });
    expect((await agendaIds(user, 'overdue')).has(task)).toBe(false);
  });

  test('после архивации исчезает', async () => {
    const user = freshUserId();
    const task = await createEntity(user, 'Закончить API', {
      props: { 'orbis/task_status': 'in_progress', 'orbis/due_date': yesterday },
      aspects: ['orbis/task'],
    });
    expect((await agendaIds(user, 'overdue')).has(task)).toBe(true);

    await callerFor(user).entity.update({ id: task, archived: true });
    expect((await agendaIds(user, 'overdue')).has(task)).toBe(false);
  });
});

describe('приёмка 02-core-os §8.3: task+schedule с обеими прошедшими датами', () => {
  // «Task + schedule с прошедшим start_at показывается в „Просроченном“ один раз, даже если
  // одновременно просрочен due_date». Слияние по id уехало на сервер (§Б5-6): выборка одна,
  // и одна строка секции — теперь утверждение об ЭТОЙ выборке, а не о работе клиента.
  test('обе причины просрочки — ОДНА строка секции, слияние сделал сервер', async () => {
    const user = freshUserId();
    const both = await createEntity(user, 'Подтвердить созвон', {
      props: {
        'orbis/task_status': 'planned',
        'orbis/due_date': addDays(today, -3),
        'orbis/start_at': at(yesterday, '09:00'),
      },
      aspects: ['orbis/task', 'orbis/schedule'],
    });

    const overdue = (await callerFor(user).agenda.list({ days: 8 })).rows.filter(
      (r) => r.section === 'overdue',
    );
    expect(overdue.filter((r) => r.entity.id === both)).toHaveLength(1);
    // Дата строки — более ранняя из двух (срок), и слот назван ею же
    expect([overdue[0]?.at, overdue[0]?.slot]).toEqual([addDays(today, -3), 'deadline']);
  });
});

describe('приёмка 02-core-os §8.4: задача с одним due_date', () => {
  // «Задача с одним due_date видна в Daily Planning/Upcoming, но не в дневной секции
  // Agenda; после добавления orbis/schedule появляется в соответствующем дне».
  test('без schedule: видна в Daily Planning и Upcoming, но не в дневном окне Agenda', async () => {
    const user = freshUserId();
    const dueToday = await createEntity(user, 'Разобрать Inbox', {
      props: { 'orbis/task_status': 'in_progress', 'orbis/due_date': today },
      aspects: ['orbis/task'],
    });
    const dueTomorrow = await createEntity(user, 'Позвонить в банк', {
      props: { 'orbis/task_status': 'planned', 'orbis/due_date': tomorrow },
      aspects: ['orbis/task'],
    });

    // сид-списки владельца (02 §3.3) — задачи там видны обе, каждая в своём списке
    expect((await queryIds(user, DAILY_TODAY_QUERY)).has(dueToday)).toBe(true);
    expect((await queryIds(user, UPCOMING_7D_QUERY)).has(dueTomorrow)).toBe(true);

    // дневное окно Agenda требует orbis/schedule — одного due_date недостаточно (§4.1)
    const days = await agendaIds(user, 'window');
    expect(days.has(dueToday)).toBe(false);
    expect(days.has(dueTomorrow)).toBe(false);
  });

  test('после добавления orbis/schedule появляется в дневном окне', async () => {
    const user = freshUserId();
    const task = await createEntity(user, 'Врач', {
      props: { 'orbis/task_status': 'planned', 'orbis/due_date': tomorrow },
      aspects: ['orbis/task'],
    });
    expect((await agendaIds(user, 'window')).has(task)).toBe(false);

    await callerFor(user).entity.update({
      id: task,
      props: {
        'orbis/start_at': at(tomorrow, '14:00'),
      },
      aspects: { attach: ['orbis/schedule'] },
    });

    const rows = (await callerFor(user).agenda.list({ days: 8 })).rows;
    const row = rows.find((r) => r.entity.id === task && r.section === 'window');
    expect(row).toBeDefined();
    // «в соответствующем дне»: раскладку по дням делает клиент по этому же значению слота
    expect([row?.at, row?.slot]).toEqual([at(tomorrow, '14:00'), 'moment']);
  });
});

describe('приёмка §С8-17: просрочено по сроку ИЛИ по началу — одним запросом', () => {
  test('обе причины в одной секции, дата строки — более ранняя из двух', async () => {
    const user = freshUserId();
    const byDue = await createEntity(user, 'Закончить API', {
      props: { 'orbis/task_status': 'in_progress', 'orbis/due_date': yesterday },
      aspects: ['orbis/task'],
    });
    const byStart = await createEntity(user, 'Подтвердить созвон', {
      props: {
        'orbis/task_status': 'planned',
        'orbis/due_date': addDays(today, 3),
        'orbis/start_at': at(yesterday, '09:00'),
      },
      aspects: ['orbis/task', 'orbis/schedule'],
    });
    const overdue = (await callerFor(user).agenda.list({ days: 8 })).rows.filter(
      (r) => r.section === 'overdue',
    );
    expect(new Set(overdue.map((r) => r.entity.id))).toEqual(new Set([byDue, byStart]));
    // У задачи с прошедшим НАЧАЛОМ и будущим сроком дата строки — день начала, не срок
    const row = overdue.find((r) => r.entity.id === byStart);
    expect([row?.at, row?.slot]).toEqual([yesterday, 'moment']);
  });
});

describe('приёмка §С8-21 сквозь ручку: две привязки слота без prefer — отказ, с prefer — строка', () => {
  test('SLOT_AMBIGUOUS доезжает до клиента структурно; prefer в дельте подписки его снимает', async () => {
    const user = freshUserId();
    // Свой аспект со слотом `moment` — ДЕКЛАРАЦИЕЙ (0d расширила `CustomAspectSpec` полем `implements`).
    // Имя — `probe`, не `gate`: токены гейта разрешены только фикстуре 0d и golden (Р-К-27).
    await seedCustomAspect(user, {
      key: 'user/probe-when',
      label: { ru: 'Проба момента' },
      properties: [{ key: 'probe_at', type: { kind: 'timestamp' } }],
      implements: [
        { contract: 'orbis/when', bind: { moment: 'user/probe_at' }, value_map: [], fixed: {} },
      ],
    });
    const id = await createEntity(user, 'Две привязки момента', {
      aspects: ['user/probe-when', 'orbis/schedule'],
      props: { 'user/probe_at': at(tomorrow, '10:00'), 'orbis/start_at': at(tomorrow, '12:00') },
    });
    // Без prefer — отказ ДВИЖКА (не строки `rowOf` в юните задачи 5), и он структурный: `execErrorToTRPC`
    // кладёт исходный ExecError в `cause` (`errors.ts`), клиент видит код, подписку и сущность.
    const failed = await callerFor(user)
      .agenda.list({ days: 8 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(failed).toBeInstanceOf(TRPCError);
    const cause = (failed as TRPCError).cause;
    expect(cause).toBeInstanceOf(ExecError);
    const details = (cause as ExecError).details as
      | { subscription?: string; entityId?: string }
      | undefined;
    expect([(cause as ExecError).code, details?.subscription, details?.entityId]).toEqual([
      'SLOT_AMBIGUOUS',
      'orbis/agenda',
      id,
    ]);
    // `prefer` — дельта подписки владельца (§Б5-2): слот `moment` читается из `orbis/schedule`.
    const seeded = BUILTIN_SUBSCRIPTION_DEFS.find((s) => s.id === 'orbis/agenda')
      ?.definition as AgendaSubscription;
    await withIdentity(db, user, (tx) =>
      setSubscriptionDelta(tx, user, 'orbis/agenda', {
        definition: { ...seeded, show: { ...seeded.show, prefer: ['orbis/schedule'] } },
      }),
    );
    const row = (await callerFor(user).agenda.list({ days: 8 })).rows.find(
      (r) => r.entity.id === id,
    );
    expect([row?.section, row?.slot]).toEqual(['window', 'moment']);
    expect(new Date(row?.at ?? '').getTime()).toBe(new Date(at(tomorrow, '12:00')).getTime()); // start_at, не probe_at
  });
});
