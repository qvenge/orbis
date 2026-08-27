// apps/server/src/query/compile.dataset.test.ts
// Эталонный датасет §6.2 на НОВОМ компиляторе (`compile-ast.ts`): скомпилированный SQL
// исполняется на реальной БД (локальный Supabase) СТРОГО под withIdentity — компилятор не
// добавляет owner-фильтр, изоляцию даёт RLS (§4.10). Проверяется состав И порядок.
//
// Тексты запросов переписаны в key-форму §А5-3 (`orbis/task_status` вместо `status`), а
// значения с пробелами закавычены: новый разбор идёт по РЕЕСТРУ, и старые тексты он
// отвергает по построению (см. докблок `parse-ast.ts`). Строки датасета при этом прежние —
// фикстура объявлена старой картой и уезжает в БД тремя колонками (`rowFromLegacy`).
//
// ОДНО МЕСТО, ГДЕ ВЫДАЧА ИЗМЕНИЛАСЬ, и это не опечатка теста: `excludeBlocked=true`. Новый
// разбор кодирует его как `!has_relation via=dependency` — «на сущность НЕТ входящего ребра
// dependency», без взгляда на состояние блокирующей работы. Сегодняшний компилятор смотрел
// и на состояние (`compile.ts:262`: блокер в `done`/`cancelled` не блокирует), поэтому
// «отпущенный» блокер теперь тоже прячет задачу. Набор «закрытых состояний» — это контракт
// `completable`, он приезжает срезом Б-1; до него интервал живёт с этой семантикой, и она
// здесь ЗАПИНЕНА, а не обойдена (тест 1 ниже называет обе выдачи).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseQueryAst, type QueryAst, toParseRegistry } from '@orbis/shared/query';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { entities, relations } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { rowFromLegacy } from '../executor/legacy-form';
import { loadRegistry, type RegistrySnapshot } from '../registry/load';
import { type CompileCtx, compileCountAst, compileQueryAst } from './compile-ast';

requireEnv();

const { db, client } = appDb();
const USER_A = freshUserId();
const USER_B = freshUserId();

/** «Сегодня» датасета — все due_date/updated_at эталона расставлены вокруг этой даты. */
const TODAY = '2026-07-03';
const TIMEZONE = 'Europe/Moscow';

/** category_ref: FK на сущность не объявлен — категория-сущность для датасета не нужна. */
const CAT = '019d48ea-4188-765d-8e96-93a0ad9c262a';

/**
 * Строка датасета объявлена СТАРОЙ картой аспектов: этот сьют — эталон компилятора §6,
 * а компилятор до «Пересева мира» читает именно её. В БД строка при этом уезжает в ТРЁХ
 * колонках (`datasetRows`): фикстура, положившая только карту, разошлась бы с писателем
 * новой правды молча.
 */
type DatasetRow = Omit<
  typeof entities.$inferInsert,
  'props' | 'aspects' | 'queryRefs' | 'aspectsLegacy'
> & { aspects: Record<string, Record<string, unknown>> };

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
  taskNext7: '019eb300-d5e1-7000-8000-000000000011',
  taskAfter7: '019eb300-d5e1-7000-8000-000000000012',
  taskAfter7b: '019eb300-d5e1-7000-8000-000000000013',
  taskWaiting1: '019eb300-d5e1-7000-8000-000000000014',
  taskWaiting2: '019eb300-d5e1-7000-8000-000000000015',
  fin030: '019eb300-d5e1-7000-8000-000000000016',
  catTransport: '019eb300-d5e1-7000-8000-000000000019',
  catFood: '019eb300-d5e1-7000-8000-00000000001a',
  catSalary: '019eb300-d5e1-7000-8000-00000000001b',
  finPlanned: '019eb300-d5e1-7000-8000-000000000017',
  finFact: '019eb300-d5e1-7000-8000-000000000018',
  eventOverdue: '019eb300-d5e1-7000-8000-00000000001c',
} as const;

/**
 * Эталонный датасет (Step 2 брифа): 2 пользователя; задачи со статусами/сроками/
 * приоритетами; financial с decimal-суммами "0.10"/"0.20"/"1000.00" (+ "340.00" —
 * негатив для amount>500); blocks-связь; архивная сущность; родитель+дети.
 * updated_at разложен на две «половины» вокруг 2026-07-02 — для курсора агента (§9.3).
 */
const DATASET_A: DatasetRow[] = [
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
  // ─── Строки финального ревью: Upcoming (next_7d/after_7d), «Ожидание», §13.6 ───
  // updated_at всех новых строк — «ранняя половина» (< 2026-07-02), чтобы не менять
  // выдачу курсорного теста 3.
  {
    id: ID.taskNext7,
    ownerId: USER_A,
    title: 'Задача через три дня',
    tags: ['task'],
    aspects: { 'orbis/task': { status: 'planned', priority: 'medium', due_date: '2026-07-06' } },
    createdAt: new Date('2026-06-29T09:00:00Z'),
    updatedAt: new Date('2026-07-01T11:30:00Z'),
  },
  {
    id: ID.taskAfter7,
    ownerId: USER_A,
    title: 'Задача через две недели',
    tags: ['task'],
    aspects: { 'orbis/task': { status: 'planned', priority: 'high', due_date: '2026-07-15' } },
    createdAt: new Date('2026-06-29T10:00:00Z'),
    updatedAt: new Date('2026-07-01T11:40:00Z'),
  },
  {
    id: ID.taskAfter7b,
    ownerId: USER_A,
    title: 'Задача в конце месяца',
    tags: ['task'],
    aspects: { 'orbis/task': { status: 'planned', priority: 'low', due_date: '2026-07-20' } },
    createdAt: new Date('2026-06-29T11:00:00Z'),
    updatedAt: new Date('2026-07-01T11:50:00Z'),
  },
  {
    // Без due_date: ждущая задача не попадает ни в «Сегодня», ни в Upcoming
    id: ID.taskWaiting1,
    ownerId: USER_A,
    title: 'Делегированная задача (ждёт давно)',
    tags: ['task'],
    aspects: { 'orbis/task': { status: 'waiting', priority: 'medium' } },
    createdAt: new Date('2026-06-20T09:00:00Z'),
    updatedAt: new Date('2026-06-29T10:00:00Z'),
  },
  {
    id: ID.taskWaiting2,
    ownerId: USER_A,
    title: 'Ожидание ответа подрядчика',
    tags: ['task'],
    aspects: { 'orbis/task': { status: 'waiting' } },
    createdAt: new Date('2026-06-30T09:00:00Z'),
    updatedAt: new Date('2026-07-01T15:00:00Z'),
  },
  // ─── Строки финала фазы B: семантика фильтра «Факт» planned=!true ───
  // Суммы вне окон amount-тестов (0.10..0.30, >500, =0.30); occurred_on вне окон теста 2b
  // (06-26..06-30 и >06-30); updated_at — «ранняя половина» (< 2026-07-02) для курсора теста 3.
  {
    // Явный planned=true — ручная planned-покупка (§2.7): фильтр «Факт» обязан её скрыть.
    id: ID.finPlanned,
    ownerId: USER_A,
    title: 'Запланированная покупка 45.00',
    tags: ['expense'],
    aspects: {
      'orbis/financial': {
        amount: '45.00',
        direction: 'expense',
        category_ref: CAT,
        occurred_on: '2026-06-24',
        planned: true,
      },
    },
    createdAt: new Date('2026-06-24T12:00:00Z'),
    updatedAt: new Date('2026-07-01T16:00:00Z'),
  },
  {
    // Явный planned=false (путь post-due/confirmPurchase): «Факт» обязан её показать.
    id: ID.finFact,
    ownerId: USER_A,
    title: 'Совершённая покупка 55.00',
    tags: ['expense'],
    aspects: {
      'orbis/financial': {
        amount: '55.00',
        direction: 'expense',
        category_ref: CAT,
        occurred_on: '2026-06-23',
        planned: false,
      },
    },
    createdAt: new Date('2026-06-23T12:00:00Z'),
    updatedAt: new Date('2026-07-01T16:30:00Z'),
  },
  {
    // §13.6: сущность с amount '0.30' — цель запроса грамматики amount=0.30
    id: ID.fin030,
    ownerId: USER_A,
    title: 'Комиссия 0.30',
    tags: ['expense'],
    aspects: {
      'orbis/financial': {
        amount: '0.30',
        direction: 'expense',
        category_ref: CAT,
        occurred_on: '2026-06-27',
      },
    },
    createdAt: new Date('2026-06-27T13:00:00Z'),
    updatedAt: new Date('2026-07-01T13:30:00Z'),
  },
  // Три стартовые категории 02 §7.1 — ДОСЛОВНЫЕ aliases сидера (seed/categories.ts).
  // Поле-массив внутри аспекта: `->>'aliases'` отдавал текст ВСЕГО массива, поэтому
  // `aliases=такси` давал тихий ноль, а `aliases=!такси` — все категории подряд.
  {
    id: ID.catTransport,
    ownerId: USER_A,
    title: 'Транспорт',
    tags: ['category'],
    aspects: {
      'orbis/category': {
        icon: '🚕',
        color: '#5a9ee0',
        aliases: ['транспорт', 'transport', 'такси', 'метро'],
        spend_class: 'fixed',
      },
    },
    createdAt: new Date('2026-06-20T10:00:00Z'),
    updatedAt: new Date('2026-07-01T10:00:00Z'),
  },
  {
    id: ID.catFood,
    ownerId: USER_A,
    title: 'Еда',
    tags: ['category'],
    aspects: {
      'orbis/category': {
        icon: '🍔',
        color: '#e0885a',
        aliases: [
          'еда',
          'food',
          'продукты',
          'groceries',
          'обед',
          'lunch',
          'ужин',
          'завтрак',
          'кофе',
        ],
        spend_class: 'discretionary',
      },
    },
    createdAt: new Date('2026-06-20T10:01:00Z'),
    updatedAt: new Date('2026-07-01T10:01:00Z'),
  },
  {
    // Доходная категория: spend_class отсутствует (§3.6) — заодно сущность с аспектом,
    // но БЕЗ искомого алиаса: отрицание обязано её вернуть.
    id: ID.catSalary,
    ownerId: USER_A,
    title: 'Зарплата',
    tags: ['category'],
    aspects: {
      'orbis/category': { icon: '💰', color: '#6fe05a', aliases: ['зарплата', 'salary'] },
    },
    createdAt: new Date('2026-06-20T10:02:00Z'),
    updatedAt: new Date('2026-07-01T10:02:00Z'),
  },
  {
    // Событие с ПРОСРОЧЕННЫМ началом и правилом повторения — вход сразу для двух новых
    // проверок: OR-дерева «просрочено по сроку ИЛИ по началу» (§А5-5) и `has(prop)` по
    // json-свойству. updated_at — «ранняя половина» (< 2026-07-02), чтобы не менять выдачу
    // курсорного теста 3.
    id: ID.eventOverdue,
    ownerId: USER_A,
    title: 'Еженедельная планёрка (начало вчера)',
    tags: ['event'],
    aspects: {
      'orbis/schedule': {
        start_at: '2026-07-01T10:00:00+03:00',
        recurrence: { freq: 'weekly', interval: 1 },
      },
    },
    createdAt: new Date('2026-06-20T11:00:00Z'),
    updatedAt: new Date('2026-07-01T17:00:00Z'),
  },
];

/**
 * Сущности userB: taskB намеренно подходит под ВСЕ условия блока «Сегодня»
 * (срок сегодня, активный статус, не заблокирована) — его отсутствие в выдаче
 * userA доказывает именно RLS, а не фильтры. updated_at — «ранняя половина»,
 * чтобы курсорный запрос под userB давал 0 строк.
 */
const DATASET_B: DatasetRow[] = [
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
    role: 'subitem',
    relationType: 'parent',
  },
  {
    id: crypto.randomUUID(),
    sourceId: ID.project,
    targetId: ID.taskOverdue,
    role: 'subitem',
    relationType: 'parent',
  },
  {
    id: crypto.randomUUID(),
    sourceId: ID.taskBlocker,
    targetId: ID.taskBlocked,
    role: 'dependency',
    relationType: 'blocks',
  },
  {
    // Блокер без orbis/task-аспекта — жив по COALESCE-семантике (§6.1).
    id: crypto.randomUUID(),
    sourceId: ID.noteBlocker,
    targetId: ID.taskBlocked2,
    role: 'dependency',
    relationType: 'blocks',
  },
  {
    // «Отпущенный» блокер: status=done НЕ блокирует — taskToday остаётся в «Сегодня».
    id: crypto.randomUUID(),
    sourceId: ID.taskDone,
    targetId: ID.taskToday,
    role: 'dependency',
    relationType: 'blocks',
  },
];

/** Блок «Сегодня» Daily Planning — 02 §3.3 в key-форме §А5-3. */
const DAILY_TODAY =
  'aspect=orbis/task, orbis/due_date=today|overdue,\n' +
  '         orbis/task_status=!done&!cancelled&!waiting,\n' +
  '         excludeBlocked=true, sortBy=orbis/priority:desc|orbis/due_date:asc,\n' +
  '         display=list, title=Сегодня';

let reg: RegistrySnapshot;

function ctx(): CompileCtx {
  return { ownerId: USER_A, today: TODAY, timeZone: TIMEZONE, reg, thisEntityId: null };
}

function astOf(query: string): QueryAst {
  const parsed = parseQueryAst(query, toParseRegistry(reg, 'ru'));
  if (!parsed.ok)
    throw new Error(`невалидный запрос в тесте: ${parsed.error.code} ${parsed.error.message}`);
  return parsed.ast;
}

/** Разбирает, компилирует и исполняет запрос под identity пользователя (RLS-путь). */
async function runAst(userId: string, ast: QueryAst): Promise<Record<string, unknown>[]> {
  const compiled = compileQueryAst(ast, ctx());
  return withIdentity(db, userId, async (tx) => [...(await tx.execute(compiled))]);
}

function run(userId: string, query: string): Promise<Record<string, unknown>[]> {
  return runAst(userId, astOf(query));
}

async function runCount(userId: string, query: string): Promise<number> {
  const compiled = compileCountAst(astOf(query), ctx());
  const rows = await withIdentity(db, userId, async (tx) => [...(await tx.execute(compiled))]);
  return Number(rows[0]?.count);
}

const ids = (rows: Record<string, unknown>[]) => rows.map((r) => r.id);

/** Старая карта фикстуры → три колонки строки (одна проекция на весь репозиторий). */
function datasetRows(
  snapshot: RegistrySnapshot,
  rows: DatasetRow[],
): (typeof entities.$inferInsert)[] {
  return rows.map(({ aspects, ...rest }) => ({ ...rest, ...rowFromLegacy(snapshot, aspects) }));
}

beforeAll(async () => {
  await truncateAll(); // санкционировано: локальная тестовая БД
  reg = await withIdentity(db, USER_A, (tx) => loadRegistry(tx, USER_A));
  await withIdentity(db, USER_A, async (tx) => {
    await tx.insert(entities).values(datasetRows(reg, DATASET_A));
    await tx.insert(relations).values(RELATIONS_A);
  });
  await withIdentity(db, USER_B, async (tx) => {
    await tx.insert(entities).values(datasetRows(reg, DATASET_B));
  });
});

afterAll(async () => {
  await client.end();
});

describe('датасет §6.2 на новом компиляторе: состав И порядок под RLS', () => {
  test('0. реестр из БД несёт типы и порядок вариантов select', () => {
    const priority = reg.properties.get('orbis/priority');
    expect(priority?.type.kind).toBe('select');
    if (priority?.type.kind === 'select') {
      expect(priority.type.options.map((o) => o.key)).toEqual(['low', 'medium', 'high']);
    }
    expect(reg.properties.get('orbis/amount')?.type.kind).toBe('decimal');
    expect(reg.properties.get('orbis/due_date')?.type.kind).toBe('date');
    expect(reg.properties.get('orbis/start_at')?.type.kind).toBe('timestamp');
    // Умолчание чтения (РП-9) приезжает из реестра, а не подставляется всем булевым.
    expect(reg.properties.get('orbis/planned')?.type).toMatchObject({ default: false });
    expect(reg.properties.get('orbis/all_day')?.type).not.toMatchObject({ default: false });
  });

  test('1. «Сегодня»: остаётся только просроченная — excludeBlocked интервала прячет и «отпущенных»', async () => {
    // taskBlocked исключён живым блокером, taskBlocked2 — блокером-заметкой, taskDone — по
    // статусу, taskB — RLS. taskToday тоже уходит, и ЭТО НОВОЕ: на нём висит входящее ребро
    // dependency от закрытой задачи, а «закрытость» до контракта `completable` (Б-1) не
    // выразима. Старый компилятор оставлял его (`compile.ts:262` смотрел на статус блокера).
    expect(ids(await run(USER_A, DAILY_TODAY))).toEqual([ID.taskOverdue]);
    // Отпущенность блокера действительно НЕ учитывается: у taskToday блокер в done, и его
    // единственное отличие от taskBlocked — именно статус блокера.
    const both = ids(
      await run(USER_A, 'aspect=orbis/task, has_relation=dependency, sortBy=orbis/created_at:asc'),
    );
    expect(both).toEqual([ID.taskBlocked, ID.taskBlocked2, ID.taskToday]);
  });

  test('1a. бейдж (02 §3.2): compileCountAst игнорирует limit, compileQueryAst — нет', async () => {
    const q =
      'aspect=orbis/task, orbis/due_date=today|overdue, orbis/task_status=!done&!cancelled&!waiting,' +
      ' excludeBlocked=true, sortBy=orbis/priority:desc|orbis/due_date:asc, limit=1';
    expect(ids(await run(USER_A, q))).toEqual([ID.taskOverdue]);
    expect(await runCount(USER_A, q)).toBe(1);
    // Тот же запрос без excludeBlocked — четыре задачи: limit режет выдачу, но не счётчик.
    const wide =
      'aspect=orbis/task, orbis/due_date=today|overdue, orbis/task_status=!done&!cancelled&!waiting,' +
      ' sortBy=orbis/priority:desc|orbis/due_date:asc, limit=1';
    expect(await run(USER_A, wide)).toHaveLength(1);
    expect(await runCount(USER_A, wide)).toBe(4);
  });

  test('2. decimal через ::numeric: orbis/amount>500 находит "1000.00", но не "340.00"', async () => {
    // Лексикографически '1000.00' < '500' — находка "1000.00" доказывает numeric-сравнение (§3.3).
    expect(ids(await run(USER_A, 'orbis/amount>500'))).toEqual([ID.fin1000]);
  });

  test('2a. orbis/amount=0.10..0.30 — границы включительно', async () => {
    expect(ids(await run(USER_A, 'orbis/amount=0.10..0.30, sortBy=orbis/amount:asc'))).toEqual([
      ID.fin010,
      ID.fin020,
      ID.fin030,
    ]);
    // Тот же диапазон включающим range без верхней границы (`>=`): §А5-7 не знает gte.
    expect(ids(await run(USER_A, 'orbis/amount>=1000, sortBy=orbis/amount:asc'))).toEqual([
      ID.fin1000,
    ]);
  });

  test('2b. date-свойство сравнивается как ::date, а не как текст', async () => {
    expect(
      ids(
        await run(USER_A, 'orbis/occurred_on=2026-06-26..2026-06-30, sortBy=orbis/occurred_on:asc'),
      ),
    ).toEqual([ID.fin020, ID.fin030, ID.fin340]);
    expect(ids(await run(USER_A, 'orbis/occurred_on>2026-06-30'))).toEqual([ID.fin1000]);
    // Включающая верхняя граница той же датой (`<=`) — тот же хвост окна.
    expect(
      ids(await run(USER_A, 'orbis/occurred_on<=2026-06-25, sortBy=orbis/occurred_on:asc')),
    ).toEqual([ID.finFact, ID.finPlanned, ID.fin010]);
  });

  test('2c. умолчание чтения (РП-9): orbis/planned=!true — NULL и явный false проходят', async () => {
    const fact = await run(
      USER_A,
      'aspect=orbis/financial, orbis/planned=!true, sortBy=orbis/occurred_on:asc',
    );
    expect(ids(fact)).toEqual([
      ID.finFact, // явный planned=false — виден
      ID.fin010, // ключа planned нет вовсе — виден (умолчание реестра false)
      ID.fin020,
      ID.fin030,
      ID.fin340,
      ID.fin1000,
    ]);
    expect(ids(await run(USER_A, 'aspect=orbis/financial, orbis/planned=true'))).toEqual([
      ID.finPlanned,
    ]);
    // Оператор `ne` даёт ТО ЖЕ множество, что `=!v` (одна семантика «не равно», решение 10).
    expect(
      ids(
        await run(
          USER_A,
          'aspect=orbis/financial, orbis/planned!=true, sortBy=orbis/occurred_on:asc',
        ),
      ),
    ).toEqual(ids(fact));
  });

  test('2d. списочное свойство: containment находит одну категорию, отрицание — остальные', async () => {
    expect(ids(await run(USER_A, 'aspect=orbis/category, orbis/aliases=такси'))).toEqual([
      ID.catTransport,
    ]);
    expect(
      ids(await run(USER_A, 'aspect=orbis/category, orbis/aliases=!такси, sortBy=orbis/title:asc')),
    ).toEqual([ID.catFood, ID.catSalary]);
    expect(
      ids(
        await run(
          USER_A,
          'aspect=orbis/category, orbis/aliases=такси|кофе, sortBy=orbis/title:asc',
        ),
      ),
    ).toEqual([ID.catFood, ID.catTransport]);
    expect(
      ids(await run(USER_A, 'aspect=orbis/category, orbis/aliases=метро, orbis/aliases=такси')),
    ).toEqual([ID.catTransport]);
    // Элемент ищется ЦЕЛИКОМ и точно: ни подстрока, ни другой регистр не проходят.
    for (const q of ['orbis/aliases=такс', 'orbis/aliases=Такси']) {
      expect(await run(USER_A, `aspect=orbis/category, ${q}`)).toHaveLength(0);
    }
  });

  test('2f. отрицание СКАЛЯРНОГО свойства пропускает записи, где свойства нет вовсе', async () => {
    // Решение 10 §6.1 («NULL проходит») в новой форме держится на том, что `not` компилируется
    // тотально: `NOT COALESCE(pred, false)`. У голого `NOT (pred)` предикат по отсутствующему
    // ключу равен NULL, и WHERE вычеркнул бы такие записи молча.
    //
    // Проверяется ИМЕННО на скаляре и БЕЗ `aspect=`: у `orbis/planned` умолчание объявлено
    // реестром (COALESCE стоит уже в самом выражении), у списка containment по отсутствующему
    // ключу даёт false, а не NULL, — на обоих мутация «убрать тотальность» проходит незаметно.
    const all = ids(await run(USER_A, 'sortBy=orbis/created_at:asc|orbis/title:asc'));
    const notDone = ids(
      await run(USER_A, 'orbis/task_status=!done, sortBy=orbis/created_at:asc|orbis/title:asc'),
    );
    expect(notDone).toEqual(all.filter((id) => id !== ID.taskDone));
    // Явно: в выдаче есть записи БЕЗ orbis/task_status вовсе.
    expect(notDone).toContain(ID.project);
    expect(notDone).toContain(ID.fin010);
    expect(notDone).toContain(ID.eventOverdue);
    // Оператор `ne` даёт то же множество — у «не равно» одна семантика (см. шапку файла).
    expect(
      ids(
        await run(USER_A, 'orbis/task_status!=done, sortBy=orbis/created_at:asc|orbis/title:asc'),
      ),
    ).toEqual(notDone);
  });

  test('2e. отрицание по списку БЕЗ aspect=: сущности без свойства проходят', async () => {
    const all = ids(await run(USER_A, 'sortBy=orbis/created_at:asc|orbis/title:asc'));
    const negated = ids(
      await run(USER_A, 'orbis/aliases=!такси, sortBy=orbis/created_at:asc|orbis/title:asc'),
    );
    expect(negated).toEqual(all.filter((id) => id !== ID.catTransport));
    expect(negated).toContain(ID.project);
    expect(negated).toContain(ID.taskInbox);
    expect(negated).not.toContain(ID.catTransport);
    expect(negated).toHaveLength(all.length - 1);
  });

  test('3. курсор агента (§9.3): orbis/updated_at> середины вставки — поздняя половина', async () => {
    const rows = await run(
      USER_A,
      'orbis/updated_at>2026-07-02T00:00:00Z, archived=any, sortBy=orbis/updated_at:asc',
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

  test('4. children_of=<проект> без via — семейство иерархии из реестра', async () => {
    const rows = await run(USER_A, `children_of=${ID.project}, sortBy=orbis/due_date:asc`);
    expect(ids(rows)).toEqual([ID.taskOverdue, ID.taskToday]);
    // Та же выдача с явной ролью: у детей проекта в датасете роль subitem.
    expect(
      ids(await run(USER_A, `children_of=${ID.project} via=subitem, sortBy=orbis/due_date:asc`)),
    ).toEqual([ID.taskOverdue, ID.taskToday]);
    // Чужая роль — пусто, а не «всё равно дети».
    expect(await run(USER_A, `children_of=${ID.project} via=ticket`)).toHaveLength(0);
  });

  test('4a. archived: по умолчанию скрыта, archived=any включает архивную', async () => {
    const base = ids(await run(USER_A, 'aspect=orbis/task'));
    expect(base).not.toContain(ID.archived);
    expect(base).toHaveLength(12);
    const withArchived = ids(await run(USER_A, 'aspect=orbis/task, archived=any'));
    expect(withArchived).toContain(ID.archived);
    expect(withArchived).toHaveLength(13);
    expect(ids(await run(USER_A, 'aspect=orbis/task, archived=true'))).toEqual([ID.archived]);
  });

  test('4b. search= находит по слову из body; отрицание поиска — всё остальное', async () => {
    expect(ids(await run(USER_A, 'search=платежей'))).toEqual([ID.project]);
    const rest = ids(await run(USER_A, '!search=платежей'));
    expect(rest).not.toContain(ID.project);
    expect(rest).toContain(ID.taskInbox);
  });

  test('5. sortBy=orbis/priority:desc — порядок вариантов реестра, NULLS LAST', async () => {
    const rows = await run(
      USER_A,
      'aspect=orbis/task, orbis/task_status=!done&!cancelled, sortBy=orbis/priority:desc|orbis/updated_at:asc',
    );
    const priorities = rows.map(
      (r) => (r.props as Record<string, unknown>)['orbis/priority'] ?? null,
    );
    expect(priorities).toEqual([
      'high',
      'high',
      'high',
      'medium',
      'medium',
      'medium',
      'medium',
      'low',
      'low',
      null,
      null,
    ]);
    expect(ids(rows)).toEqual([
      ID.taskToday,
      ID.taskAfter7,
      ID.taskBlocked,
      ID.taskWaiting1,
      ID.taskOverdue,
      ID.taskBlocked2,
      ID.taskNext7,
      ID.taskAfter7b,
      ID.taskBlocker,
      ID.taskWaiting2,
      ID.taskInbox,
    ]);
  });

  test('6. RLS: userB не видит данных userA (и наоборот)', async () => {
    expect(ids(await run(USER_B, DAILY_TODAY))).toEqual([ID.taskB]);
    for (const q of [
      `children_of=${ID.project}`,
      'orbis/amount=0.10..0.30',
      'search=платежей',
      'orbis/updated_at>2026-07-02T00:00:00Z, archived=any',
    ]) {
      expect(await run(USER_B, q)).toHaveLength(0);
    }
  });
});

describe('блоки Upcoming и «Ожидание» (02 §3.3) исполняются на датасете', () => {
  test('7. Upcoming «Ближайшие 7 дней»: next_7d включает сегодня, блокировка НЕ скрывает', async () => {
    const rows = await run(
      USER_A,
      'aspect=orbis/task, orbis/due_date=next_7d, orbis/task_status=!done&!cancelled,\n' +
        '         sortBy=orbis/due_date:asc|orbis/priority:desc, display=list, title="Ближайшие 7 дней"',
    );
    expect(ids(rows).slice(0, 2).sort()).toEqual([ID.taskToday, ID.taskBlocked].sort());
    expect(ids(rows).slice(2)).toEqual([ID.taskBlocked2, ID.taskNext7]);
  });

  test('7a. Upcoming «Позже»: after_7d — строго после горизонта, по сроку', async () => {
    const rows = await run(
      USER_A,
      'aspect=orbis/task, orbis/due_date=after_7d, orbis/task_status=!done&!cancelled,\n' +
        '         sortBy=orbis/due_date:asc, limit=30, display=compact, title=Позже',
    );
    expect(ids(rows)).toEqual([ID.taskAfter7, ID.taskAfter7b]);
  });

  test('7b. «Ожидание»: orbis/task_status=waiting, давно ждущие сверху', async () => {
    const rows = await run(
      USER_A,
      'aspect=orbis/task, orbis/task_status=waiting,\n' +
        '         sortBy=orbis/updated_at:asc, display=compact, title=Ожидание',
    );
    expect(ids(rows)).toEqual([ID.taskWaiting1, ID.taskWaiting2]);
  });
});

describe('новое в каноне: OR-дерево разных свойств, has(prop), обход по роли', () => {
  test('8. OR «просрочено по сроку ИЛИ по началу» (§А5-5) — плоским текстом невыразимо', async () => {
    // Три запроса Agenda со склейкой на клиенте заменяются ОДНИМ деревом. Текст такое дерево
    // не выражает (скобок в грамматике v1 нет), поэтому AST собирается здесь руками — ровно
    // так, как его соберёт форма или вход `ast:` тула (§А5-4).
    const ast: QueryAst = {
      filter: {
        or: [
          { prop: 'orbis/due_date', op: 'eq', value: { token: 'overdue' } },
          { prop: 'orbis/start_at', op: 'eq', value: { token: 'overdue' } },
        ],
      },
      sortBy: [{ field: 'orbis/created_at', dir: 'asc' }],
    };
    expect(ids(await runAst(USER_A, ast))).toEqual([ID.eventOverdue, ID.taskOverdue]);
    // Каждая половина по отдельности даёт свою сущность — объединение не выродилось в одну.
    expect(ids(await run(USER_A, 'orbis/due_date=overdue'))).toEqual([ID.taskOverdue]);
    expect(ids(await run(USER_A, 'orbis/start_at=overdue'))).toEqual([ID.eventOverdue]);
  });

  test('9. has(prop) — наличие ключа в props, а не его значение (дыра inv §1 п.11)', async () => {
    expect(ids(await run(USER_A, 'has=orbis/recurrence'))).toEqual([ID.eventOverdue]);
    // Отрицание: у остальных ключа нет — и они возвращаются все.
    const without = ids(await run(USER_A, '!has=orbis/recurrence'));
    expect(without).not.toContain(ID.eventOverdue);
    expect(without).toContain(ID.project);
    // has по свойству, которого нет ни у кого из выборки, — честный ноль.
    expect(await run(USER_A, 'has=orbis/session_url')).toHaveLength(0);
  });

  test('10. has_children / !has_children via=subitem — «терминальная задача»', async () => {
    expect(ids(await run(USER_A, 'has_children via=subitem, sortBy=orbis/created_at:asc'))).toEqual(
      [ID.project],
    );
    const terminal = ids(await run(USER_A, 'aspect=orbis/task, !has_children via=subitem'));
    expect(terminal).not.toContain(ID.project);
    expect(terminal).toContain(ID.taskToday);
  });
});

// ─── Служебные аспекты (02-core-os §3.9, §А5-6) ───
const USER_C = freshUserId();

const ID_C = {
  ticket: '019eb300-d5e1-7000-8000-000000000021',
  run: '019eb300-d5e1-7000-8000-000000000022',
} as const;

describe('служебные аспекты: спрятаны, пока не названы; список — колонка service реестра', () => {
  beforeAll(async () => {
    await withIdentity(db, USER_C, async (tx) => {
      const own = await loadRegistry(tx, USER_C);
      await tx.insert(entities).values(
        datasetRows(own, [
          {
            id: ID_C.ticket,
            ownerId: USER_C,
            title: 'Тикет',
            tags: ['task'],
            aspects: { 'orbis/task': { status: 'in_progress' } },
            createdAt: new Date('2026-07-01T08:00:00Z'),
            updatedAt: new Date('2026-07-01T08:00:00Z'),
          },
          {
            id: ID_C.run,
            ownerId: USER_C,
            title: 'Прогон исполнителя',
            tags: [],
            aspects: {
              'orbis/agent-run': {
                grant_id: '019eb300-d5e1-7000-8000-0000000000c0',
                outcome: 'running',
                started_at: '2026-07-03T10:00:00Z',
                last_step_at: '2026-07-03T10:05:00Z',
                step_count: 0,
                steps: [],
              },
            },
            createdAt: new Date('2026-07-03T10:00:00Z'),
            updatedAt: new Date('2026-07-03T10:05:00Z'),
          },
        ]),
      );
    });
  });

  test('11. запрос без aspect=orbis/agent-run не возвращает прогонов; с ним — возвращает', async () => {
    const all = ids(await run(USER_C, 'sortBy=orbis/updated_at:desc'));
    expect(all).toContain(ID_C.ticket);
    expect(all).not.toContain(ID_C.run);
    expect(await runCount(USER_C, 'sortBy=orbis/updated_at:desc')).toBe(1);
    expect(ids(await run(USER_C, 'aspect=orbis/agent-run'))).toEqual([ID_C.run]);
    expect(await run(USER_C, 'search=Прогон')).toHaveLength(0);
  });

  test('12. свойство служебного аспекта — то же упоминание, что aspect=', async () => {
    expect(ids(await run(USER_C, 'orbis/run_outcome=running'))).toEqual([ID_C.run]);
    expect(ids(await run(USER_C, 'orbis/step_count<5'))).toEqual([ID_C.run]);
    // Граница правила: sortBy целью выборки не является — прогоны не втягивает.
    expect(ids(await run(USER_C, 'sortBy=orbis/step_count:desc'))).toEqual([ID_C.ticket]);
  });

  test('13. прячущее условие собрано ИЗ КОЛОНКИ service, а не из списка в коде', async () => {
    // Проверяется не текст условия, а совпадение его параметров с тем, что лежит в БД:
    // список в коде дал бы то же условие при пустой колонке и разъехался бы молча.
    const rows = await withIdentity(db, USER_C, async (tx) => [
      ...(await tx.execute(sql`SELECT id FROM aspect_definitions WHERE service ORDER BY id`)),
    ]);
    const fromDb = rows.map((r) => r.id as string);
    expect(fromDb.length).toBeGreaterThan(0);
    const compiled = new PgDialect().sqlToQuery(
      compileQueryAst({ filter: { tag: 'task' } }, ctx()),
    );
    expect(compiled.sql).toContain('NOT (aspects && ARRAY[');
    for (const id of fromDb) expect(compiled.params).toContain(id);
  });
});

// ─── Семейство иерархии в children_of/parents_of (§А4-3, Ч10-С1) ───
const USER_D = freshUserId();

const ID_D = {
  project: '019eb300-d5e1-7000-8000-000000000031',
  ticket: '019eb300-d5e1-7000-8000-000000000032',
  subtask: '019eb300-d5e1-7000-8000-000000000033',
  envelope: '019eb300-d5e1-7000-8000-000000000034',
  txn: '019eb300-d5e1-7000-8000-000000000035',
} as const;

describe('children_of/parents_of: семейство иерархии из реестра, а не схлопнутый parent', () => {
  beforeAll(async () => {
    await withIdentity(db, USER_D, async (tx) => {
      const own = await loadRegistry(tx, USER_D);
      await tx.insert(entities).values(
        datasetRows(own, [
          {
            id: ID_D.project,
            ownerId: USER_D,
            title: 'Проект D',
            tags: [],
            aspects: { 'orbis/project': { stage: 'active' } },
            createdAt: new Date('2026-07-01T08:00:00Z'),
            updatedAt: new Date('2026-07-01T08:00:00Z'),
          },
          {
            id: ID_D.ticket,
            ownerId: USER_D,
            title: 'Тикет D',
            tags: [],
            aspects: { 'orbis/task': { status: 'planned' } },
            createdAt: new Date('2026-07-01T09:00:00Z'),
            updatedAt: new Date('2026-07-01T09:00:00Z'),
          },
          {
            id: ID_D.subtask,
            ownerId: USER_D,
            title: 'Подпункт D',
            tags: [],
            aspects: { 'orbis/task': { status: 'planned' } },
            createdAt: new Date('2026-07-01T10:00:00Z'),
            updatedAt: new Date('2026-07-01T10:00:00Z'),
          },
          {
            id: ID_D.envelope,
            ownerId: USER_D,
            title: 'Конверт D',
            tags: [],
            aspects: {
              'orbis/budget': {
                category_ref: '019eb300-d5e1-7000-8000-0000000000d1',
                limit: '1000.00',
                period_start: '2026-07-01',
                period_end: '2026-07-31',
              },
            },
            createdAt: new Date('2026-07-01T11:00:00Z'),
            updatedAt: new Date('2026-07-01T11:00:00Z'),
          },
          {
            id: ID_D.txn,
            ownerId: USER_D,
            title: 'Расход D',
            tags: [],
            aspects: {
              'orbis/financial': {
                amount: '100.00',
                direction: 'expense',
                category_ref: '019eb300-d5e1-7000-8000-0000000000d1',
                occurred_on: '2026-07-02',
              },
            },
            createdAt: new Date('2026-07-01T12:00:00Z'),
            updatedAt: new Date('2026-07-01T12:00:00Z'),
          },
        ]),
      );
      await tx.insert(relations).values([
        {
          id: crypto.randomUUID(),
          sourceId: ID_D.project,
          targetId: ID_D.ticket,
          role: 'ticket',
          relationType: 'parent',
        },
        {
          id: crypto.randomUUID(),
          sourceId: ID_D.project,
          targetId: ID_D.subtask,
          role: 'subitem',
          relationType: 'parent',
        },
        {
          id: crypto.randomUUID(),
          sourceId: ID_D.envelope,
          targetId: ID_D.txn,
          role: 'envelope-binding',
          relationType: 'parent',
        },
      ]);
    });
  });

  test('14. children_of берёт ВСЁ семейство иерархии: и subitem, и ticket', async () => {
    expect(
      ids(await run(USER_D, `children_of=${ID_D.project}, sortBy=orbis/created_at:asc`)),
    ).toEqual([ID_D.ticket, ID_D.subtask]);
  });

  test('15. envelope-binding в семейство НЕ входит: конверт не родитель транзакции', async () => {
    expect(ids(await run(USER_D, `children_of=${ID_D.envelope}`))).toEqual([]);
    expect(ids(await run(USER_D, `parents_of=${ID_D.txn}`))).toEqual([]);
    // Явной ролью — находится: исключено именно семейство, а не само ребро.
    expect(ids(await run(USER_D, `children_of=${ID_D.envelope} via=envelope-binding`))).toEqual([
      ID_D.txn,
    ]);
  });

  test('16. parents_of симметричен children_of по тому же семейству', async () => {
    expect(ids(await run(USER_D, `parents_of=${ID_D.ticket}`))).toEqual([ID_D.project]);
  });
});

// ─── Рекурсивный обход и кап глубины (§А5-1, QUERY_DEPTH_CAP) ───
const USER_E = freshUserId();

/** Цепочка subitem длиной 40 + ветка на глубине 2 — вход обоих тестов обхода. */
const CHAIN_LENGTH = 40;
const chainId = (i: number) => `019eb301-d5e1-7000-8000-${String(i).padStart(12, '0')}`;
const BRANCH_ID = chainId(900);

describe('descendants_of/ancestors_of: обход по одной роли и кап глубины 32', () => {
  beforeAll(async () => {
    await withIdentity(db, USER_E, async (tx) => {
      const own = await loadRegistry(tx, USER_E);
      const rows: DatasetRow[] = [];
      for (let i = 0; i <= CHAIN_LENGTH; i++) {
        rows.push({
          id: chainId(i),
          ownerId: USER_E,
          title: `Узел ${i}`,
          tags: [],
          aspects: {},
          createdAt: new Date(`2026-07-01T00:00:00Z`),
          updatedAt: new Date(`2026-07-01T00:00:00Z`),
        });
      }
      rows.push({
        id: BRANCH_ID,
        ownerId: USER_E,
        title: 'Ветка на глубине 2',
        tags: [],
        aspects: {},
        createdAt: new Date('2026-07-01T00:00:00Z'),
        updatedAt: new Date('2026-07-01T00:00:00Z'),
      });
      await tx.insert(entities).values(datasetRows(own, rows));
      const edges = [];
      for (let i = 0; i < CHAIN_LENGTH; i++) {
        edges.push({
          id: crypto.randomUUID(),
          sourceId: chainId(i),
          targetId: chainId(i + 1),
          role: 'subitem',
          relationType: 'parent' as const,
        });
      }
      edges.push({
        id: crypto.randomUUID(),
        sourceId: chainId(1),
        targetId: BRANCH_ID,
        role: 'subitem',
        relationType: 'parent' as const,
      });
      await tx.insert(relations).values(edges);
    });
  });

  test('17. descendants_of via=subitem: глубина 3 достижима, ветка тоже, кап 32 обрезает', async () => {
    const rows = ids(await run(USER_E, `descendants_of=${chainId(0)} via=subitem, limit=1000`));
    // Узел глубины 3 — на месте (обход не одноуровневый).
    expect(rows).toContain(chainId(3));
    // Ветка на глубине 2 — тоже: это обход дерева, а не одной цепочки.
    expect(rows).toContain(BRANCH_ID);
    // Кап: последний достижимый узел цепочки — 32-й, следующий уже нет.
    expect(rows).toContain(chainId(32));
    expect(rows).not.toContain(chainId(33));
    expect(rows).not.toContain(chainId(CHAIN_LENGTH));
    // 32 узла цепочки + одна ветка; цепочка из 40 бесконечного обхода не даёт.
    expect(rows).toHaveLength(33);
  });

  test('18. ancestors_of via=subitem — зеркальный обход вверх', async () => {
    const rows = ids(await run(USER_E, `ancestors_of=${chainId(5)} via=subitem, limit=1000`));
    expect(rows.sort()).toEqual([0, 1, 2, 3, 4].map(chainId).sort());
    // Ветка предком пятого узла не является — обход идёт вверх, а не по всему дереву.
    expect(rows).not.toContain(BRANCH_ID);
  });

  test('19. чужая роль — пустой обход, а не «всё равно всё поддерево»', async () => {
    expect(
      await run(USER_E, `descendants_of=${chainId(0)} via=category-parent, limit=1000`),
    ).toHaveLength(0);
  });

  test('20. RLS: чужое поддерево невидимо даже по своему запросу', async () => {
    expect(await run(USER_A, `descendants_of=${chainId(0)} via=subitem, limit=1000`)).toHaveLength(
      0,
    );
  });
});

describe('§13.6: decimal-точность в новой форме хранения', () => {
  test('21. 0.10+0.20=0.30 в numeric, orbis/amount=0.30, JSON без IEEE-754', async () => {
    const [sum] = await withIdentity(db, USER_A, async (tx) => [
      ...(await tx.execute(sql`
        SELECT sum((props->>'orbis/amount')::numeric)::text AS total
        FROM entities WHERE id IN (${ID.fin010}, ${ID.fin020})`)),
    ]);
    expect(sum?.total).toBe('0.30');

    expect(ids(await run(USER_A, 'orbis/amount=0.30'))).toEqual([ID.fin030]);

    // persisted JSON: сумма во ВСЕХ financial-строках — jsonb-строка, а не число IEEE-754.
    for (const [user, expected] of [
      [USER_A, 7],
      [USER_B, 1],
    ] as const) {
      const rows = await withIdentity(db, user, async (tx) => [
        ...(await tx.execute(sql`
          SELECT jsonb_typeof(props->'orbis/amount') AS t
          FROM entities WHERE aspects @> ARRAY['orbis/financial']`)),
      ]);
      expect(rows).toHaveLength(expected);
      expect(rows.every((r) => r.t === 'string')).toBe(true);
    }
  });
});
