// apps/server/src/query/compile.dataset.test.ts
// Эталонный датасет §6.2: скомпилированный SQL исполняется на реальной БД
// (локальный Supabase) СТРОГО под withIdentity — компилятор не добавляет
// owner-фильтр, изоляцию даёт RLS (§4.10). Проверяется состав И порядок.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type FieldCatalog, parseQuery } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { entities, relations } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { type CompileContext, compileCount, compileQuery, loadCatalog } from './compile';

requireEnv();

const { db, client } = appDb();
const USER_A = freshUserId();
const USER_B = freshUserId();

/** «Сегодня» датасета — все due_date/updated_at эталона расставлены вокруг этой даты. */
const TODAY = '2026-07-03';
const TIMEZONE = 'Europe/Moscow';

/** category_ref: FK на сущность не объявлен — категория-сущность для датасета не нужна. */
const CAT = '019d48ea-4188-765d-8e96-93a0ad9c262a';

const ID = {
  project: '019eb300-d5e1-7000-8000-000000000001',
  taskToday: '019eb300-d5e1-7000-8000-000000000002',
  taskOverdue: '019eb300-d5e1-7000-8000-000000000003',
  taskBlocked: '019eb300-d5e1-7000-8000-000000000004',
  taskBlocker: '019eb300-d5e1-7000-8000-000000000005',
  taskBlocked2: '019eb300-d5e1-7000-8000-00000000000f',
  noteBlocker: '019eb300-d5e1-7000-8000-000000000010',
  taskInbox: '019eb300-d5e1-7000-8000-000000000006',
  taskDone: '019eb300-d5e1-7000-8000-000000000007',
  fin010: '019eb300-d5e1-7000-8000-000000000008',
  fin020: '019eb300-d5e1-7000-8000-000000000009',
  fin340: '019eb300-d5e1-7000-8000-00000000000a',
  fin1000: '019eb300-d5e1-7000-8000-00000000000b',
  archived: '019eb300-d5e1-7000-8000-00000000000c',
  taskB: '019eb300-d5e1-7000-8000-00000000000d',
  finB: '019eb300-d5e1-7000-8000-00000000000e',
} as const;

/**
 * Эталонный датасет (Step 2 брифа): 2 пользователя; задачи со статусами/сроками/
 * приоритетами; financial с decimal-суммами "0.10"/"0.20"/"1000.00" (+ "340.00" —
 * негатив для amount>500); blocks-связь; архивная сущность; родитель+дети.
 * updated_at разложен на две «половины» вокруг 2026-07-02 — для курсора агента (§9.3).
 */
const DATASET_A: (typeof entities.$inferInsert)[] = [
  {
    id: ID.project,
    ownerId: USER_A,
    title: 'Проект Орбис',
    body: 'Интеграция API платежей и обновление лендинга.',
    tags: ['project'],
    aspects: {},
    createdAt: new Date('2026-06-20T08:00:00Z'),
    updatedAt: new Date('2026-07-01T08:00:00Z'),
  },
  {
    id: ID.taskToday,
    ownerId: USER_A,
    title: 'Задача на сегодня',
    tags: ['task', 'work'],
    aspects: { 'orbis/task': { status: 'in_progress', priority: 'high', due_date: '2026-07-03' } },
    createdAt: new Date('2026-06-28T09:00:00Z'),
    updatedAt: new Date('2026-07-01T09:00:00Z'),
  },
  {
    id: ID.taskOverdue,
    ownerId: USER_A,
    title: 'Просроченная задача',
    tags: ['task'],
    aspects: { 'orbis/task': { status: 'planned', priority: 'medium', due_date: '2026-07-01' } },
    createdAt: new Date('2026-06-25T09:00:00Z'),
    updatedAt: new Date('2026-07-01T10:00:00Z'),
  },
  {
    id: ID.taskBlocked,
    ownerId: USER_A,
    title: 'Заблокированная задача со сроком сегодня',
    tags: ['task'],
    aspects: { 'orbis/task': { status: 'planned', priority: 'high', due_date: '2026-07-03' } },
    createdAt: new Date('2026-06-26T09:00:00Z'),
    updatedAt: new Date('2026-07-03T09:00:00Z'),
  },
  {
    id: ID.taskBlocker,
    ownerId: USER_A,
    title: 'Живой блокер (in_progress, без срока)',
    tags: ['task'],
    aspects: { 'orbis/task': { status: 'in_progress', priority: 'low' } },
    createdAt: new Date('2026-06-26T10:00:00Z'),
    updatedAt: new Date('2026-07-03T10:00:00Z'),
  },
  {
    // COALESCE-семантика excludeBlocked: заблокирована сущностью БЕЗ orbis/task —
    // такой блокер считается живым (§6.1), задача уходит из «Сегодня».
    id: ID.taskBlocked2,
    ownerId: USER_A,
    title: 'Задача, заблокированная заметкой без task-аспекта',
    tags: ['task'],
    aspects: { 'orbis/task': { status: 'planned', priority: 'medium', due_date: '2026-07-03' } },
    createdAt: new Date('2026-06-26T11:00:00Z'),
    updatedAt: new Date('2026-07-01T10:30:00Z'),
  },
  {
    // Блокер-заметка: orbis/task-аспекта нет вовсе — путь COALESCE(...,'') в SQL.
    id: ID.noteBlocker,
    ownerId: USER_A,
    title: 'Заметка-блокер без task-аспекта',
    tags: ['note'],
    aspects: { 'orbis/note': { content_type: 'plain' } },
    createdAt: new Date('2026-06-26T12:00:00Z'),
    updatedAt: new Date('2026-07-01T10:45:00Z'),
  },
  {
    id: ID.taskInbox,
    ownerId: USER_A,
    title: 'Неразобранная задача без приоритета',
    tags: ['task'],
    aspects: { 'orbis/task': { status: 'inbox' } },
    createdAt: new Date('2026-07-01T07:00:00Z'),
    updatedAt: new Date('2026-07-03T11:00:00Z'),
  },
  {
    id: ID.taskDone,
    ownerId: USER_A,
    title: 'Закрытая задача со сроком сегодня',
    tags: ['task'],
    aspects: {
      'orbis/task': {
        status: 'done',
        priority: 'low',
        due_date: '2026-07-03',
        completed_at: '2026-07-01T10:30:00Z',
      },
    },
    createdAt: new Date('2026-06-27T09:00:00Z'),
    updatedAt: new Date('2026-07-01T11:00:00Z'),
  },
  {
    id: ID.fin010,
    ownerId: USER_A,
    title: 'Комиссия 0.10',
    tags: ['expense'],
    aspects: {
      'orbis/financial': {
        amount: '0.10',
        direction: 'expense',
        category_ref: CAT,
        occurred_on: '2026-06-25',
      },
    },
    createdAt: new Date('2026-06-25T12:00:00Z'),
    updatedAt: new Date('2026-07-01T12:00:00Z'),
  },
  {
    id: ID.fin020,
    ownerId: USER_A,
    title: 'Комиссия 0.20',
    tags: ['expense'],
    aspects: {
      'orbis/financial': {
        amount: '0.20',
        direction: 'expense',
        category_ref: CAT,
        occurred_on: '2026-06-26',
      },
    },
    createdAt: new Date('2026-06-26T12:00:00Z'),
    updatedAt: new Date('2026-07-01T13:00:00Z'),
  },
  {
    id: ID.fin340,
    ownerId: USER_A,
    title: 'Обед 340.00',
    tags: ['expense'],
    aspects: {
      'orbis/financial': {
        amount: '340.00',
        direction: 'expense',
        category_ref: CAT,
        occurred_on: '2026-06-30',
      },
    },
    createdAt: new Date('2026-06-30T13:00:00Z'),
    updatedAt: new Date('2026-07-03T12:00:00Z'),
  },
  {
    id: ID.fin1000,
    ownerId: USER_A,
    title: 'Покупка 1000.00',
    tags: ['expense'],
    aspects: {
      'orbis/financial': {
        amount: '1000.00',
        direction: 'expense',
        category_ref: CAT,
        occurred_on: '2026-07-02',
      },
    },
    createdAt: new Date('2026-07-02T13:00:00Z'),
    updatedAt: new Date('2026-07-03T13:00:00Z'),
  },
  {
    id: ID.archived,
    ownerId: USER_A,
    title: 'Старый черновик плана',
    tags: ['task'],
    aspects: { 'orbis/task': { status: 'cancelled', priority: 'low' } },
    createdAt: new Date('2026-05-02T08:00:00Z'),
    updatedAt: new Date('2026-07-03T14:00:00Z'),
    archived: true,
  },
];

/**
 * Сущности userB: taskB намеренно подходит под ВСЕ условия блока «Сегодня»
 * (срок сегодня, активный статус, не заблокирована) — его отсутствие в выдаче
 * userA доказывает именно RLS, а не фильтры. updated_at — «ранняя половина»,
 * чтобы курсорный запрос под userB давал 0 строк.
 */
const DATASET_B: (typeof entities.$inferInsert)[] = [
  {
    id: ID.taskB,
    ownerId: USER_B,
    title: 'Чужая задача на сегодня',
    tags: ['task'],
    aspects: { 'orbis/task': { status: 'planned', priority: 'high', due_date: '2026-07-03' } },
    createdAt: new Date('2026-06-28T09:30:00Z'),
    updatedAt: new Date('2026-07-01T09:30:00Z'),
  },
  {
    id: ID.finB,
    ownerId: USER_B,
    title: 'Чужая покупка 1000.00',
    tags: ['expense'],
    aspects: {
      'orbis/financial': {
        amount: '1000.00',
        direction: 'expense',
        category_ref: CAT,
        occurred_on: '2026-07-01',
      },
    },
    createdAt: new Date('2026-07-01T14:00:00Z'),
    updatedAt: new Date('2026-07-01T14:00:00Z'),
  },
];

/** parent: source — родитель, target — ребёнок (норматив children_of, §6.1). */
const RELATIONS_A: (typeof relations.$inferInsert)[] = [
  {
    id: crypto.randomUUID(),
    sourceId: ID.project,
    targetId: ID.taskToday,
    relationType: 'parent',
  },
  {
    id: crypto.randomUUID(),
    sourceId: ID.project,
    targetId: ID.taskOverdue,
    relationType: 'parent',
  },
  {
    id: crypto.randomUUID(),
    sourceId: ID.taskBlocker,
    targetId: ID.taskBlocked,
    relationType: 'blocks',
  },
  {
    // Блокер без orbis/task-аспекта — жив по COALESCE-семантике (§6.1).
    id: crypto.randomUUID(),
    sourceId: ID.noteBlocker,
    targetId: ID.taskBlocked2,
    relationType: 'blocks',
  },
  {
    // «Отпущенный» блокер: status=done НЕ блокирует — taskToday остаётся в «Сегодня».
    id: crypto.randomUUID(),
    sourceId: ID.taskDone,
    targetId: ID.taskToday,
    relationType: 'blocks',
  },
];

/** Блок «Сегодня» Daily Planning — дословно из 02 §3.3. */
const DAILY_TODAY =
  'aspect=orbis/task, due_date=today|overdue, status=!done&!cancelled&!waiting,\n' +
  '         excludeBlocked=true, sortBy=priority:desc|due_date:asc,\n' +
  '         display=list, title=Сегодня';

let catalog: FieldCatalog;

function ctx(): CompileContext {
  return { catalog, thisEntityId: null, today: TODAY, timezone: TIMEZONE };
}

/** Парсит, компилирует и исполняет запрос под identity пользователя (RLS-путь). */
async function run(userId: string, query: string): Promise<Record<string, unknown>[]> {
  const parsed = parseQuery(query, catalog);
  if (!parsed.ok) throw new Error(`невалидный запрос в тесте: ${parsed.error.message}`);
  const compiled = compileQuery(parsed.ast, ctx());
  return withIdentity(db, userId, async (tx) => [...(await tx.execute(compiled))]);
}

async function runCount(userId: string, query: string): Promise<number> {
  const parsed = parseQuery(query, catalog);
  if (!parsed.ok) throw new Error(`невалидный запрос в тесте: ${parsed.error.message}`);
  const compiled = compileCount(parsed.ast, ctx());
  const rows = await withIdentity(db, userId, async (tx) => [...(await tx.execute(compiled))]);
  return Number(rows[0]?.count);
}

const ids = (rows: Record<string, unknown>[]) => rows.map((r) => r.id);

beforeAll(async () => {
  await truncateAll(); // санкционировано: локальная тестовая БД
  await withIdentity(db, USER_A, async (tx) => {
    await tx.insert(entities).values(DATASET_A);
    await tx.insert(relations).values(RELATIONS_A);
  });
  await withIdentity(db, USER_B, async (tx) => {
    await tx.insert(entities).values(DATASET_B);
  });
  // Каталог — из БД (builtin-реестр под RLS), а не из shared: заодно проверяет loadCatalog.
  catalog = await withIdentity(db, USER_A, (tx) => loadCatalog(tx));
});

afterAll(async () => {
  await client.end();
});

describe('датасет §6.2: состав И порядок под RLS', () => {
  test('loadCatalog: каталог из aspect_definitions несёт типы и порядок enum', () => {
    expect(catalog.fields.priority?.[0]).toMatchObject({
      aspect: 'orbis/task',
      enumValues: ['low', 'medium', 'high'],
    });
    expect(catalog.fields.amount?.[0]?.type).toBe('decimal');
    expect(catalog.fields.due_date?.[0]?.type).toBe('date');
    expect(catalog.fields.start_at?.[0]?.type).toBe('timestamp');
  });

  test('1. «Сегодня» Daily Planning: просроченная и сегодняшняя, priority:desc, без заблокированной и без чужих', () => {
    // taskBlocked исключён живым task-блокером; taskBlocked2 — блокером БЕЗ
    // task-аспекта (COALESCE-семантика §6.1); taskDone — по статусу; taskB — RLS.
    // taskToday остаётся, хотя на нём blocks-связь от done-блокера («отпущен»).
    // Порядок: high → medium.
    return run(USER_A, DAILY_TODAY).then((rows) => {
      expect(ids(rows)).toEqual([ID.taskToday, ID.taskOverdue]);
    });
  });

  test('1a. бейдж (02 §3.2): compileCount игнорирует limit, compileQuery — нет', async () => {
    const q =
      'aspect=orbis/task, due_date=today|overdue, status=!done&!cancelled&!waiting,' +
      ' excludeBlocked=true, sortBy=priority:desc|due_date:asc, limit=1';
    expect(ids(await run(USER_A, q))).toEqual([ID.taskToday]);
    expect(await runCount(USER_A, q)).toBe(2);
  });

  test('2. decimal через ::numeric: amount>500 находит "1000.00", но не "340.00"', async () => {
    // Лексикографически '1000.00' < '500' — находка "1000.00" доказывает numeric-сравнение (§3.3).
    expect(ids(await run(USER_A, 'amount>500'))).toEqual([ID.fin1000]);
  });

  test('2a. amount=0.10..0.30 находит "0.10" и "0.20" (границы включительно)', async () => {
    expect(ids(await run(USER_A, 'amount=0.10..0.30, sortBy=amount:asc'))).toEqual([
      ID.fin010,
      ID.fin020,
    ]);
  });

  test('3. курсор агента (§9.3): updated_at> середины вставки — только поздняя половина', async () => {
    const rows = await run(
      USER_A,
      'updated_at>2026-07-02T00:00:00Z, archived=any, sortBy=updated_at:asc',
    );
    expect(ids(rows)).toEqual([
      ID.taskBlocked,
      ID.taskBlocker,
      ID.taskInbox,
      ID.fin340,
      ID.fin1000,
      ID.archived,
    ]);
  });

  test('4. children_of=<проект> — только дети, по сроку', async () => {
    const rows = await run(USER_A, `children_of=${ID.project}, sortBy=due_date:asc`);
    expect(ids(rows)).toEqual([ID.taskOverdue, ID.taskToday]);
  });

  test('4a. archived: по умолчанию скрыта, archived=any включает архивную', async () => {
    const base = ids(await run(USER_A, 'aspect=orbis/task'));
    expect(base).not.toContain(ID.archived);
    expect(base).toHaveLength(7);
    const withArchived = ids(await run(USER_A, 'aspect=orbis/task, archived=any'));
    expect(withArchived).toContain(ID.archived);
    expect(withArchived).toHaveLength(8);
  });

  test('4b. search= находит по слову из body', async () => {
    expect(ids(await run(USER_A, 'search=платежей'))).toEqual([ID.project]);
  });

  test('5. sortBy=priority:desc: high → medium → low → NULL (порядок enum, NULLS LAST)', async () => {
    const rows = await run(
      USER_A,
      'aspect=orbis/task, status=!done&!cancelled, sortBy=priority:desc|updated_at:asc',
    );
    const priorities = rows.map(
      (r) => (r.aspects as Record<string, { priority?: string }>)['orbis/task']?.priority ?? null,
    );
    expect(priorities).toEqual(['high', 'high', 'medium', 'medium', 'low', null]);
    expect(ids(rows)).toEqual([
      ID.taskToday,
      ID.taskBlocked,
      ID.taskOverdue,
      ID.taskBlocked2,
      ID.taskBlocker,
      ID.taskInbox,
    ]);
  });

  test('6. RLS: userB не видит данных userA (и наоборот)', async () => {
    // «Сегодня» под B — ТОЛЬКО своя задача (симметрия изоляции).
    expect(ids(await run(USER_B, DAILY_TODAY))).toEqual([ID.taskB]);
    // Запросы по данным A под B — 0 строк.
    for (const q of [
      `children_of=${ID.project}`,
      'amount=0.10..0.30',
      'search=платежей',
      'updated_at>2026-07-02T00:00:00Z, archived=any',
    ]) {
      expect(await run(USER_B, q)).toHaveLength(0);
    }
  });
});
