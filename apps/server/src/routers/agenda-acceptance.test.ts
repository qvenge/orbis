// apps/server/src/routers/agenda-acceptance.test.ts
// Task D6a — приёмка 02-core-os §8.1–8.4 (Agenda) на СЕРВЕРНОЙ стороне.
//
// Клиентская половина приёмки живёт в apps/web/src/features/agenda/AgendaScreen.test.tsx:
// там пиннятся ДОСЛОВНЫЕ строки грамматики §6.1, которые шлёт вкладка «Повестка», и
// проверяется раскладка по секциям на моках. Здесь проверяется СМЫСЛ тех же строк на
// живой БД: какие сущности реальный компилятор §6.1 действительно вернёт и какие — нет.
// Пункты §8.1 («остаётся доступна в Browser») и §8.4 («видна в Daily Planning/Upcoming»)
// вне вкладки Agenda вообще и на клиентских моках недоказуемы.
//
// «Сегодня» шва не имеет (K13) — фикстуры строятся ОТНОСИТЕЛЬНО реального «сегодня»
// в дефолтной таймзоне Europe/Moscow (прецедент aggregates.test.ts, post-due.test.ts).
// Ни одна фикстура не recurring: K15 — start_at=overdue расширяет окно материализации
// только до [today; today], прошлое задним числом не материализуется.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { addDays } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
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

// --- три строки вкладки «Повестка» (apps/web/src/features/agenda/useAgenda.ts) ---------
// Скопированы дословно; на web-стороне они пиннятся тестом «Agenda шлёт три запроса
// грамматики §6.1 дословно», поэтому расхождение поймает та проверка, а не молчание.

const DAYS_QUERY = 'aspect=orbis/schedule, start_at=today|next_7d, sortBy=start_at:asc, limit=200';
const OVERDUE_DUE_QUERY =
  'aspect=orbis/task, due_date=overdue, status=!done&!cancelled, sortBy=due_date:asc, limit=200';
const OVERDUE_START_QUERY =
  'aspect=orbis/task, aspect=orbis/schedule, start_at=overdue, status=!done&!cancelled, sortBy=start_at:asc, limit=200';

/** Browser без фильтров (apps/web/src/features/browser/query.ts browserQuery). */
const BROWSER_QUERY = 'sortBy=updated_at:desc, limit=50';

/** N-й {{query:}}-блок body smart-list'а — тот же разбор, что в onboarding.test.ts. */
function queryBlock(body: string, index: number): string {
  const matches = [...body.matchAll(/\{\{query:\s*([\s\S]*?)\}\}/g)];
  const block = matches[index]?.[1];
  if (block === undefined) throw new Error(`в body нет query-блока №${index}`);
  return block;
}

/** Daily Planning, список «Сегодня» (02 §3.3) — второй блок. */
const DAILY_TODAY_QUERY = queryBlock(DAILY_PLANNING_BODY, 1);
/** Upcoming, «Ближайшие 7 дней» (02 §3.3) — первый блок. */
const UPCOMING_7D_QUERY = queryBlock(UPCOMING_BODY, 0);

function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

type Aspects = Record<string, Record<string, unknown>>;

async function createEntity(user: string, title: string, aspects: Aspects): Promise<string> {
  const e = await callerFor(user).entity.create({
    input: { title, tags: [], aspects },
    source: 'ui',
  });
  return e.id;
}

/** id'шники выдачи запроса — состав важен, порядок здесь не проверяется. */
async function idsOf(user: string, query: string): Promise<Set<string>> {
  const rows = await callerFor(user).entity.query({ query });
  return new Set(rows.map((r) => r.id));
}

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
      'orbis/schedule': { start_at: at(yesterday, '10:00') },
    });

    // Обе выборки §4.2 требуют aspect=orbis/task — чистое событие отсекается ими обеими.
    // Именно второй запрос нетривиален: два aspect= в одной строке компилируются в AND.
    expect((await idsOf(user, OVERDUE_DUE_QUERY)).has(event)).toBe(false);
    expect((await idsOf(user, OVERDUE_START_QUERY)).has(event)).toBe(false);

    // …и при этом сущность жива и находится обычным списком Browser (02 §3)
    expect((await idsOf(user, BROWSER_QUERY)).has(event)).toBe(true);
    expect((await idsOf(user, `aspect=orbis/schedule, ${BROWSER_QUERY}`)).has(event)).toBe(true);
  });

  test('та же сущность с добавленным orbis/task попадает в «Просроченное» по start_at', async () => {
    // Негатив к предыдущему тесту: отсекает именно отсутствие orbis/task, а не что-то ещё
    // (иначе первый тест проходил бы и при сломанном start_at=overdue).
    const user = freshUserId();
    const event = await createEntity(user, 'Созвон, ставший задачей', {
      'orbis/schedule': { start_at: at(yesterday, '10:00') },
    });
    expect((await idsOf(user, OVERDUE_START_QUERY)).has(event)).toBe(false);

    await callerFor(user).entity.update({
      id: event,
      aspects: { 'orbis/task': { status: 'planned' } },
    });
    expect((await idsOf(user, OVERDUE_START_QUERY)).has(event)).toBe(true);
  });
});

describe('приёмка 02-core-os §8.2: задача с просроченным due_date', () => {
  // «Незакрытая task-сущность с просроченным due_date появляется в „Просроченном“
  // независимо от наличия schedule; после done, переноса или архивации исчезает».
  test('появляется независимо от наличия schedule', async () => {
    const user = freshUserId();
    const bare = await createEntity(user, 'Закончить API', {
      'orbis/task': { status: 'in_progress', due_date: yesterday },
    });
    const scheduled = await createEntity(user, 'Оплатить интернет', {
      'orbis/task': { status: 'planned', due_date: yesterday },
      'orbis/schedule': { start_at: at(tomorrow, '09:00') }, // расписание в БУДУЩЕМ
    });

    const overdue = await idsOf(user, OVERDUE_DUE_QUERY);
    expect(overdue.has(bare)).toBe(true);
    expect(overdue.has(scheduled)).toBe(true);
    // вторая выборка §4.2 к делу не относится: её start_at не просрочен
    expect((await idsOf(user, OVERDUE_START_QUERY)).has(scheduled)).toBe(false);
  });

  test('после done исчезает', async () => {
    const user = freshUserId();
    const task = await createEntity(user, 'Закончить API', {
      'orbis/task': { status: 'in_progress', due_date: yesterday },
    });
    expect((await idsOf(user, OVERDUE_DUE_QUERY)).has(task)).toBe(true);

    await callerFor(user).entity.update({
      id: task,
      aspects: { 'orbis/task': { status: 'done' } },
    });
    expect((await idsOf(user, OVERDUE_DUE_QUERY)).has(task)).toBe(false);
  });

  test('после переноса срока исчезает', async () => {
    const user = freshUserId();
    const task = await createEntity(user, 'Закончить API', {
      'orbis/task': { status: 'in_progress', due_date: yesterday },
    });
    expect((await idsOf(user, OVERDUE_DUE_QUERY)).has(task)).toBe(true);

    await callerFor(user).entity.update({
      id: task,
      aspects: { 'orbis/task': { due_date: tomorrow } },
    });
    expect((await idsOf(user, OVERDUE_DUE_QUERY)).has(task)).toBe(false);
  });

  test('после архивации исчезает', async () => {
    const user = freshUserId();
    const task = await createEntity(user, 'Закончить API', {
      'orbis/task': { status: 'in_progress', due_date: yesterday },
    });
    expect((await idsOf(user, OVERDUE_DUE_QUERY)).has(task)).toBe(true);

    await callerFor(user).entity.update({ id: task, archived: true });
    expect((await idsOf(user, OVERDUE_DUE_QUERY)).has(task)).toBe(false);
  });
});

describe('приёмка 02-core-os §8.3: task+schedule с обеими прошедшими датами', () => {
  // «Task + schedule с прошедшим start_at показывается в „Просроченном“ один раз,
  // даже если одновременно просрочен due_date». Сервер отдаёт плоские выборки —
  // сущность приходит В ОБЕИХ, и именно поэтому клиент обязан слить их по id
  // (одна строка секции — AgendaScreen.test.tsx §8.3).
  test('сущность приходит в обеих выборках, в каждой — ровно одной строкой', async () => {
    const user = freshUserId();
    const both = await createEntity(user, 'Подтвердить созвон', {
      'orbis/task': { status: 'planned', due_date: addDays(today, -3) },
      'orbis/schedule': { start_at: at(yesterday, '09:00') },
    });

    const byDue = await callerFor(user).entity.query({ query: OVERDUE_DUE_QUERY });
    const byStart = await callerFor(user).entity.query({ query: OVERDUE_START_QUERY });
    expect(byDue.filter((r) => r.id === both)).toHaveLength(1);
    expect(byStart.filter((r) => r.id === both)).toHaveLength(1);
    // объединение двух выборок = один элемент «Просроченного»
    expect(new Set([...byDue, ...byStart].map((r) => r.id)).size).toBe(1);
  });
});

describe('приёмка 02-core-os §8.4: задача с одним due_date', () => {
  // «Задача с одним due_date видна в Daily Planning/Upcoming, но не в дневной секции
  // Agenda; после добавления orbis/schedule появляется в соответствующем дне».
  test('без schedule: видна в Daily Planning и Upcoming, но не в дневном окне Agenda', async () => {
    const user = freshUserId();
    const dueToday = await createEntity(user, 'Разобрать Inbox', {
      'orbis/task': { status: 'in_progress', due_date: today },
    });
    const dueTomorrow = await createEntity(user, 'Позвонить в банк', {
      'orbis/task': { status: 'planned', due_date: tomorrow },
    });

    // сид-списки владельца (02 §3.3) — задачи там видны обе, каждая в своём списке
    expect((await idsOf(user, DAILY_TODAY_QUERY)).has(dueToday)).toBe(true);
    expect((await idsOf(user, UPCOMING_7D_QUERY)).has(dueTomorrow)).toBe(true);

    // дневное окно Agenda требует orbis/schedule — одного due_date недостаточно (§4.1)
    const days = await idsOf(user, DAYS_QUERY);
    expect(days.has(dueToday)).toBe(false);
    expect(days.has(dueTomorrow)).toBe(false);
  });

  test('после добавления orbis/schedule появляется в дневном окне', async () => {
    const user = freshUserId();
    const task = await createEntity(user, 'Врач', {
      'orbis/task': { status: 'planned', due_date: tomorrow },
    });
    expect((await idsOf(user, DAYS_QUERY)).has(task)).toBe(false);

    await callerFor(user).entity.update({
      id: task,
      aspects: { 'orbis/schedule': { start_at: at(tomorrow, '14:00') } },
    });

    const rows = await callerFor(user).entity.query({ query: DAYS_QUERY });
    const row = rows.find((r) => r.id === task);
    expect(row).toBeDefined();
    // «в соответствующем дне»: раскладку по секциям делает клиент по этому же start_at
    expect((row?.aspects['orbis/schedule'] as { start_at?: string } | undefined)?.start_at).toBe(
      at(tomorrow, '14:00'),
    );
  });
});
