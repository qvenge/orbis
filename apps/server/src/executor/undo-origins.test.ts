// apps/server/src/executor/undo-origins.test.ts
// Task C3: сквозной undo импорта ПОЛЬЗОВАТЕЛЬСКИМ путём (03-budget §3.4.1, 01-arch §4.8).
// Цепочка «журнал → action.inverse → executor в режиме internalUndo» ломается молча:
// inverse пишется на стадии 6 и может разъехаться с тем, что реально умеет проиграть
// исполнитель. Поэтому здесь НЕТ прямых вызовов операций origins — импорт идёт через
// tRPC-caller (import.confirm, один batch_execute), а отмена — через undoLast, ровно
// как «отмени последнее» из чата (ai.undoLast — тонкая обёртка над ним).
//
// Проверяемые инварианты §7.8 + §3.4.1 (последний абзац):
//   • строки entity_origins удаляются ФИЗИЧЕСКИ (все три ключа (namespace, external_id));
//   • созданные импортом сущности АРХИВИРУЮТСЯ (не удаляются);
//   • цель adopt жива и нетронута (усыновление откатилось, сущность — нет);
//   • budget-привязки, дописанные хуком A4 в тот же action, сняты;
//   • повторный undo отклонён и состояние не меняет;
//   • тот же файл после отмены снова читается как new — external_id свободны.
//
// Один describe, последовательные test-шаги (bun исполняет в порядке объявления),
// общее состояние — переменные describe-скоупа (образец — test/e2e.slice1b.test.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type CanonicalRow, externalRowId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  freshUserId,
  legacyEntityColumns,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { appRouter } from '../router';
import { seedCategoryId, seedOnboarding } from '../seed/onboarding';
import { createCallerFactory } from '../trpc';
import type { ExecuteErr, ExecuteOk, ExecuteResult } from './types';
import { undoAction, undoLast } from './undo';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

// ---------------------------------------------------------------------------
// Состояние сценария (общее для последовательных test-шагов)
// ---------------------------------------------------------------------------

const NS = 'csv:tinkoff-c3';
const FILE = 'c'.repeat(64);
const user = freshUserId();
const foodId = seedCategoryId(user, 'food');
const adoptTargetId = newId();
const controlId = newId();
const envelopeId = newId();
const batchId = newId();

const caller = createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });

function makeRow(o: {
  occurredOn: string;
  amount: string;
  counterparty: string;
  rowIndex: number;
}): CanonicalRow {
  return {
    occurredOn: o.occurredOn,
    amount: o.amount,
    direction: 'expense',
    counterparty: o.counterparty,
    raw: `${o.occurredOn};${o.amount};${o.counterparty}`,
    rowIndex: o.rowIndex,
  };
}

// Суммы всех строк НАМЕРЕННО не совпадают ни между собой, ни с суммами живых сущностей
// (999.00 у цели adopt, 777.00 у контрольной): содержательный критерий §3.4.1 требует
// точного совпадения суммы, поэтому после отмены review обязан дать чистое `new` всем
// трём строкам — статус зависит ТОЛЬКО от освобождения external_id, не от дедупа.
const rowCreate1 = makeRow({
  occurredOn: '2026-05-03',
  amount: '340.00',
  counterparty: 'Кофе Хауз',
  rowIndex: 0,
});
const rowCreate2 = makeRow({
  occurredOn: '2026-05-04',
  amount: '420.00',
  counterparty: 'Ужин в кафе',
  rowIndex: 1,
});
const rowAdopt = makeRow({
  occurredOn: '2026-05-09',
  amount: '500.00',
  counterparty: 'Перевод другу',
  rowIndex: 2,
});

let externalIds: string[] = [];
let actionId = '';
let createdIds: string[] = [];

interface EntitySnapshot {
  archived: boolean;
  updated_at: string;
  aspects: string;
}

let targetBefore: EntitySnapshot;
let controlBefore: EntitySnapshot;

// ---------------------------------------------------------------------------
// Хелперы: сырые админ-запросы (мимо RLS и мимо кода, который тестируется)
// ---------------------------------------------------------------------------

function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

function err(r: ExecuteResult): ExecuteErr {
  if (r.ok) throw new Error('ожидался структурированный отказ, получен успех');
  return r;
}

async function adminRows(query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    return [...(await admin.execute(query))];
  } finally {
    await adminClient.end();
  }
}

/** external_id строк entity_origins владельца по ТРЁМ ключам сценария (не по количеству). */
async function originKeysPresent(): Promise<string[]> {
  const list = sql.join(
    externalIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await adminRows(
    sql`SELECT external_id FROM entity_origins
        WHERE owner_id = ${user} AND namespace = ${NS} AND external_id IN (${list})
        ORDER BY external_id`,
  );
  return rows.map((r) => r.external_id as string);
}

/** target_id всех parent-связей конверта (budget-привязки хука A4). */
async function envelopeParentTargets(): Promise<string[]> {
  const rows = await adminRows(
    sql`SELECT target_id FROM relations
        WHERE source_id = ${envelopeId} AND relation_type = 'parent'
        ORDER BY target_id`,
  );
  return rows.map((r) => r.target_id as string);
}

/** Снимок строки сущности: ::text-касты дают стабильное байт-сравнение снимков. */
async function entitySnapshot(id: string): Promise<EntitySnapshot> {
  const rows = await adminRows(
    sql`SELECT archived, updated_at::text AS updated_at, aspects_legacy::text AS aspects
        FROM entities WHERE id = ${id}`,
  );
  const row = rows[0];
  if (!row) throw new Error(`сущность ${id} не найдена`);
  return row as unknown as EntitySnapshot;
}

/** Созданные импортом сущности: (archived) по id — «архивированы, но существуют». */
async function createdEntityRows(): Promise<Array<{ id: string; archived: boolean }>> {
  const list = sql.join(
    createdIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await adminRows(
    sql`SELECT id, archived FROM entities WHERE id IN (${list}) ORDER BY id`,
  );
  return rows.map((r) => ({ id: r.id as string, archived: r.archived as boolean }));
}

/** Все проверки состояния «после отмены» (п.4 сценария) — переиспользуются в п.5. */
async function assertUndoneState(): Promise<void> {
  // Origins удалены ФИЗИЧЕСКИ: ни один из трёх ключей (namespace, external_id) не найден
  expect(await originKeysPresent()).toEqual([]);

  // Созданные архивированы, но физически существуют (undo создания = архивация, §7.8)
  const created = await createdEntityRows();
  expect(created).toHaveLength(2);
  expect(created.map((r) => r.archived)).toEqual([true, true]);

  // Цель adopt ЖИВА и НЕ архивирована; updated_at и aspects — байт в байт как до импорта
  expect(await entitySnapshot(adoptTargetId)).toEqual({ ...targetBefore, archived: false });

  // Контрольная сущность не затронута
  expect(await entitySnapshot(controlId)).toEqual({ ...controlBefore, archived: false });

  // Budget-привязки хука A4 сняты — они входят в тот же action
  expect(await envelopeParentTargets()).toEqual([]);
}

// ---------------------------------------------------------------------------
// Подготовка
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await truncateAll();
  await withIdentity(db, user, (tx) => seedOnboarding(tx, user));

  // Подготовка МИМО executor и журнала (raw-вставки, как seedOnboarding): журнал
  // владельца должен содержать РОВНО ОДИН action — импорт, иначе второй undoLast
  // «отменил бы» подготовку вместо честного отказа (шаг 5 сценария).
  //   • adoptTarget — существующая финансовая сущность, цель усыновления;
  //   • control — финансовая сущность, не участвующая в импорте (undo не задел лишнего);
  //   • envelope — конверт «Еда» на май: хук A4 привяжет созданные транзакции,
  //     и undo обязан снять привязки вместе со всей группой.
  const now = new Date();
  await withIdentity(db, user, async (tx) =>
    tx.insert(entities).values([
      {
        id: adoptTargetId,
        ownerId: user,
        title: 'Ручной обед',
        tags: [],
        ...(await legacyEntityColumns(tx, user, {
          'orbis/financial': {
            amount: '999.00',
            direction: 'expense',
            category_ref: foodId,
            occurred_on: '2026-05-09',
            counterparty: 'Ручной обед',
          },
        })),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: controlId,
        ownerId: user,
        title: 'Контрольная запись',
        tags: [],
        ...(await legacyEntityColumns(tx, user, {
          'orbis/financial': {
            amount: '777.00',
            direction: 'expense',
            category_ref: foodId,
            occurred_on: '2026-05-05',
            counterparty: 'Контрольная запись',
          },
        })),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: envelopeId,
        ownerId: user,
        title: 'Конверт Еда',
        tags: [],
        ...(await legacyEntityColumns(tx, user, {
          'orbis/budget': {
            category_ref: foodId,
            limit: '10000.00',
            currency: 'RUB',
            period_start: '2026-05-01',
            period_end: '2026-05-31',
          },
        })),
        createdAt: now,
        updatedAt: now,
      },
    ]),
  );

  // Снимки ДО импорта: п.4 сценария требует, чтобы updated_at и aspects цели adopt
  // (и контрольной) не изменились — ни импортом, ни отменой
  targetBefore = await entitySnapshot(adoptTargetId);
  controlBefore = await entitySnapshot(controlId);

  externalIds = await Promise.all(
    [rowCreate1, rowCreate2, rowAdopt].map((row) => externalRowId(FILE, row)),
  );
});

afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------------------
// Сценарий
// ---------------------------------------------------------------------------

describe('Undo импорта сквозным путём: журнал → inverse → физическое удаление origins (§3.4.1)', () => {
  test('импорт одним batch: 2 create + 1 adopt; origins и budget-привязки на месте', async () => {
    const r = await caller.import.confirm({
      batchId,
      namespace: NS,
      fileHash: FILE,
      items: [
        { row: rowCreate1, action: 'create', categoryRef: foodId },
        { row: rowCreate2, action: 'create', categoryRef: foodId },
        { row: rowAdopt, action: 'adopt', adoptEntityId: adoptTargetId },
      ],
    });

    expect(r.created).toBe(2);
    expect(r.adopted).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.idempotentReplay).toBe(false);
    expect(r.entityIds).toHaveLength(2);
    actionId = r.actionId;
    createdIds = [...r.entityIds];

    // Все три ключа (namespace, external_id) зарегистрированы — якорь для проверки
    // «после отмены НЕТ ни одного»: без него та проверка прошла бы и на неверных ключах
    expect(await originKeysPresent()).toEqual([...externalIds].sort());

    // Хук A4 привязал обе созданные транзакции к конверту (в тот же action)
    expect(await envelopeParentTargets()).toEqual([...createdIds].sort());
  }, 20_000);

  test('«отмени последнее»: undoLast находит импорт в журнале и возвращает его actionId', async () => {
    // undoLast, а не undoAction: «отмени последнее» из чата идёт именно сканом журнала
    // с конца (ai.undoLast — обёртка над ним), без знания actionId. Это и есть
    // пользовательский путь, который таск обязан проверить.
    const u = ok(await undoLast(db, { actorUserId: user }));
    expect(u.actionId).toBe(actionId);
  }, 20_000);

  test('после отмены: origins удалены, созданные архивированы, adopt-цель и контрольная нетронуты', async () => {
    await assertUndoneState();
  }, 20_000);

  test('повторный undo отклонён и состояние не меняет', async () => {
    // Скан с конца: неотменённых действий в журнале больше нет
    const again = err(await undoLast(db, { actorUserId: user }));
    expect(again.error.code).toBe('NOT_FOUND');

    // Точечный повтор ТОГО ЖЕ action — тоже отказ («уже отменено», §7.8)
    const targeted = err(await undoAction(db, { actorUserId: user, actionId }));
    expect(targeted.error.code).toBe('VALIDATION');

    // Состояние из п.4 не изменилось
    await assertUndoneState();
  }, 20_000);

  test('тот же файл снова читается как new: external_id свободны (§3.4.1, последний абзац)', async () => {
    const review = await caller.import.review({
      rows: [rowCreate1, rowCreate2, rowAdopt],
      fileHash: FILE,
      namespace: NS,
    });
    // «Физически удалили», а не «пометили удалённым»: ни одна строка не читается
    // already_imported, и дедуп молчит (суммы подобраны без совпадений с живыми)
    expect(review.rows.map((row) => row.status)).toEqual(['new', 'new', 'new']);
  }, 20_000);
});
