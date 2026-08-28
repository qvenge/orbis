// apps/server/src/import/import-acceptance.test.ts
// Приёмка 03-budget §7.1 «Исторический импорт» — ЧЕРЕЗ РЕАЛЬНЫЙ ПУТЬ CSV-импорта.
//
//   «выписка с occurred_on=2026-05-31, импортированная 13 июня 2026 года, входит
//    в майский баланс/конверт и не входит в июньский; created_at на результат не влияет.»
//
// Почему этот файл существует отдельно от aggregates.test.ts (фаза A): там та же
// проверка сделана на транзакции, СОЗДАННОЙ напрямую executor'ом. Это доказывает
// формулы §2.2/§2.5, но не цепочку, по которой строка реально приходит:
//   файл → CanonicalRow (fileHash+rowIndex) → import.review → import.confirm →
//   batch_execute → авто-привязка бюджет-хука (§2.3) → строка entity_origins (§4.8).
// Здесь проверяется именно она — процедурами import.review/import.confirm и чтением
// агрегатов реальным budget.overview (оба через tRPC-caller, без прямых вызовов домена).
//
// Отдельно от import.test.ts (36 тестов флоу) — там сценарии процедур, здесь один
// сквозной приёмочный сценарий с фикстурой на весь файл.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type BudgetOverview,
  type CanonicalRow,
  externalRowId,
  type ImportConfirmResult,
  type ImportReviewResult,
  newId,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { ExecuteRequest, WireEntity } from '../executor/types';
import { appRouter } from '../router';
import { seedCategoryId, seedOnboarding } from '../seed/onboarding';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

const user = freshUserId();
const foodId = seedCategoryId(user, 'food');
const caller = createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });

const NS = 'csv:tinkoff-may-2026';

/**
 * Момент «импорта» по формулировке §7.1 — 13 июня 2026. created_at сущности ставит
 * сервер (executor'ов clock), а import.confirm собирает ExecuteRequest сам и шва для
 * clock наружу не выставляет, поэтому «13 июня» воспроизводится честно: транзакции
 * импортируются реальным путём (created_at = настоящее «сейчас», уже за пределами и
 * мая, и июня), после чего created_at переставляется на этот момент СЫРЫМ админ-UPDATE
 * и агрегаты перечитываются. Что это доказывает и чего не доказывает — см. комментарий
 * describe «created_at на результат не влияет».
 */
const IMPORT_MOMENT = '2026-06-13T09:41:00+00:00';

// ---------------------------------------------------------------------------
// Файл выписки и его канонизация
// ---------------------------------------------------------------------------

/**
 * Выписка «как из банка»: заголовок + три операции, разделитель `;`, дата DD.MM.YYYY,
 * сумма со знаком и запятой-разделителем. Строка §7.1 — первая (31.05.2026); остальные
 * две пинят границы периодов с ОБЕИХ сторон: 01.06.2026 обязана уйти в июнь, 01.05.2026
 * — в май (предикат §2.3 включает обе границы).
 */
const CSV_TEXT = [
  'Дата операции;Сумма;Описание',
  '31.05.2026;-1890,00;Продукты 843',
  '01.06.2026;-640,00;Кофе Хауз',
  '01.05.2026;-500,00;Обед в столовой',
].join('\r\n');

/**
 * Канонизация строк файла. Полноценный парсер (decodeCsvBytes/parseCsv/toCanonicalRows)
 * живёт в web-воркспейсе (apps/web/src/features/import/csv-parse.ts) и покрыт своими
 * тестами; серверный тест через границу воркспейсов не импортирует, поэтому здесь —
 * минимальное отображение ровно этого файла в CanonicalRow с теми же правилами, что
 * у клиента: знак живёт в direction, сумма положительная, `raw` — исходная строка,
 * `rowIndex` zero-based (оба входят в контракт, external_id считает shared).
 */
function canonicalRowsOf(text: string): CanonicalRow[] {
  const [, ...dataLines] = text.split('\r\n');
  return dataLines.map((line, rowIndex) => {
    const cells = line.split(';');
    const [day, month, year] = (cells[0] ?? '').split('.');
    const money = (cells[1] ?? '').replace(',', '.');
    const negative = money.startsWith('-');
    return {
      occurredOn: `${year}-${month}-${day}`,
      amount: negative ? money.slice(1) : money,
      direction: negative ? 'expense' : 'income',
      counterparty: cells[2] ?? '',
      raw: line,
      rowIndex,
    };
  });
}

/** sha256 по байтам файла в нижнем hex — тот же контракт, что fileHashHex клиента. */
async function fileHashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Фикстура и сырые чтения
// ---------------------------------------------------------------------------

async function exec(tool: string, input: unknown): Promise<WireEntity> {
  const req: ExecuteRequest = {
    actorUserId: user,
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool, input }],
  };
  const r = await execute(db, req);
  if (!r.ok) throw new Error(`${tool}: ${r.error.code} — ${r.error.message}`);
  return r.results[0] as WireEntity;
}

function envelope(periodStart: string, periodEnd: string): Record<string, unknown> {
  return {
    title: `Еда — ${periodStart.slice(0, 7)}`,
    tags: [],
    aspects: {
      'orbis/budget': {
        category_ref: foodId,
        limit: '30000.00',
        period_start: periodStart,
        period_end: periodEnd,
      },
    },
  };
}

/** Строки entity_origins владельца — сырым админ-соединением (мимо RLS и мимо кода C2). */
async function rawOrigins(): Promise<Array<{ namespace: string; externalId: string; id: string }>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = (await admin.execute(sql`
      SELECT namespace, external_id, entity_id FROM entity_origins
      WHERE owner_id = ${user} ORDER BY external_id
    `)) as unknown as Array<{ namespace: string; external_id: string; entity_id: string }>;
    return rows.map((r) => ({
      namespace: r.namespace,
      externalId: r.external_id,
      id: r.entity_id,
    }));
  } finally {
    await adminClient.end();
  }
}

/** budget-parent каждой из сущностей (relation parent от сущности с orbis/budget). */
async function rawBudgetParents(ids: string[]): Promise<Map<string, string[]>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const list = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = (await admin.execute(sql`
      SELECT r.target_id AS entity_id, r.source_id AS envelope_id
      FROM relations r
      JOIN entities p ON p.id = r.source_id
      WHERE r.target_id IN (${list}) AND r.relation_type = 'parent'
        AND 'orbis/budget' = ANY(p.aspects)
      ORDER BY r.target_id, r.source_id
    `)) as unknown as Array<{ entity_id: string; envelope_id: string }>;
    const map = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const row of rows) map.get(row.entity_id)?.push(row.envelope_id);
    return map;
  } finally {
    await adminClient.end();
  }
}

/** created_at сущностей в ISO — сырым админ-соединением (колонку не отдаёт ни один API). */
async function rawCreatedAt(ids: string[]): Promise<Map<string, string>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const list = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = (await admin.execute(sql`
      SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ') AS created_at
      FROM entities WHERE id IN (${list})
    `)) as unknown as Array<{ id: string; created_at: string }>;
    return new Map(rows.map((r) => [r.id, r.created_at]));
  } finally {
    await adminClient.end();
  }
}

/** Переставить created_at импортированных сущностей на момент «импорта» (см. IMPORT_MOMENT). */
async function setCreatedAt(ids: string[], moment: string): Promise<void> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const list = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    await admin.execute(sql`
      UPDATE entities SET created_at = ${moment}::timestamptz WHERE id IN (${list})
    `);
  } finally {
    await adminClient.end();
  }
}

function envById(ov: BudgetOverview, id: string) {
  const st = ov.envelopes.find((e) => e.envelope.id === id);
  if (st === undefined) throw new Error(`конверт ${id} не найден в overview`);
  return st;
}

// --- состояние сценария (собирается один раз в beforeAll) --------------------

let envMay = '';
let envJune = '';
let fileHash = '';
let rows: CanonicalRow[] = [];
let externalIds: string[] = [];
let review: ImportReviewResult;
let confirmed: ImportConfirmResult;
let reviewRepeat: ImportReviewResult;
let origins: Array<{ namespace: string; externalId: string; id: string }> = [];
let createdAtOnImport = new Map<string, string>();
let parentsOnImport = new Map<string, string[]>();
let parentsAfterBackdate = new Map<string, string[]>();
let mayOnImport: BudgetOverview;
let juneOnImport: BudgetOverview;
let mayAfterBackdate: BudgetOverview;
let juneAfterBackdate: BudgetOverview;

/** Сущность, созданная из строки файла с индексом rowIndex (через её provenance). */
function entityOfRow(rowIndex: number): string {
  const externalId = externalIds[rowIndex] as string;
  const origin = origins.find((o) => o.externalId === externalId);
  if (origin === undefined) throw new Error(`нет origin для строки ${rowIndex}`);
  return origin.id;
}

beforeAll(async () => {
  await truncateAll();
  await withIdentity(db, user, (tx) => seedOnboarding(tx, user));

  // Два конверта ОДНОЙ категории — соседние месяцы (§7.1: майский и июньский)
  envMay = (await exec('entity_create', envelope('2026-05-01', '2026-05-31'))).id;
  envJune = (await exec('entity_create', envelope('2026-06-01', '2026-06-30'))).id;

  fileHash = await fileHashOf(CSV_TEXT);
  rows = canonicalRowsOf(CSV_TEXT);
  externalIds = await Promise.all(rows.map((row) => externalRowId(fileHash, row)));

  // Реальный флоу §3.4: ревью файла → подтверждение. Категория берётся из предложения
  // ревью (как её отдаёт UI), а не подставляется тестом мимо процедуры.
  review = await caller.import.review({ rows, fileHash, namespace: NS });
  confirmed = await caller.import.confirm({
    batchId: newId(),
    namespace: NS,
    fileHash,
    items: rows.map((row, i) => ({
      row,
      action: 'create' as const,
      categoryRef: review.rows[i]?.suggestedCategoryRef ?? foodId,
    })),
  });

  origins = await rawOrigins();
  parentsOnImport = await rawBudgetParents(confirmed.entityIds);
  createdAtOnImport = await rawCreatedAt(confirmed.entityIds);
  mayOnImport = await caller.budget.overview({ month: '2026-05' });
  juneOnImport = await caller.budget.overview({ month: '2026-06' });

  // «Импортирована 13 июня 2026»: created_at сущностей переставляется на этот момент
  await setCreatedAt(confirmed.entityIds, IMPORT_MOMENT);

  parentsAfterBackdate = await rawBudgetParents(confirmed.entityIds);
  mayAfterBackdate = await caller.budget.overview({ month: '2026-05' });
  juneAfterBackdate = await caller.budget.overview({ month: '2026-06' });

  // Provenance ↔ приёмочный сценарий: тот же файл повторно (§7 edge «Повторный импорт»)
  reviewRepeat = await caller.import.review({ rows, fileHash, namespace: NS });
});

afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------------------

describe('§7.1 через реальный путь импорта: файл → review → confirm', () => {
  test('ревью видит три новые строки и само предлагает категорию по алиасам', () => {
    expect(review.rows.map((r) => r.status)).toEqual(['new', 'new', 'new']);
    expect(review.rows.map((r) => r.suggestedCategoryRef)).toEqual([foodId, foodId, foodId]);
    // external_id считает shared по (fileHash, строка) — provenance родом из файла
    expect(review.rows.map((r) => r.externalId)).toEqual(externalIds);
  });

  test('подтверждение создаёт три транзакции, и ни одна не осталась без конверта', () => {
    expect(confirmed.created).toBe(3);
    expect(confirmed.adopted).toBe(0);
    expect(confirmed.skipped).toBe(0);
    expect(confirmed.entityIds).toHaveLength(3);
    // §3.4 шаг 5: пустой unbudgeted = бюджет-хук привязал ВСЕ созданные строки
    expect(confirmed.unbudgeted).toEqual([]);
  });

  test('строка occurred_on=2026-05-31 имеет ровно один parent — МАЙСКИЙ конверт', () => {
    const id = entityOfRow(0);
    expect(parentsOnImport.get(id)).toEqual([envMay]);
    expect(parentsOnImport.get(id)).not.toContain(envJune);
  });

  test('границы периодов включительны с обеих сторон: 01.06 → июнь, 01.05 → май (§2.3)', () => {
    expect(parentsOnImport.get(entityOfRow(1))).toEqual([envJune]);
    expect(parentsOnImport.get(entityOfRow(2))).toEqual([envMay]);
  });
});

describe('§7.1: майский конверт и баланс мая — через budget.overview', () => {
  test('spent майского конверта включает импортированную сумму 31.05', () => {
    // 1890.00 (31.05) + 500.00 (01.05); 640.00 (01.06) в май не входит
    expect(envById(mayOnImport, envMay).spent).toBe('2390.00');
    expect(envById(mayOnImport, envMay).phase).toBe('closed');
  });

  test('spent июньского конверта её НЕ включает', () => {
    expect(envById(juneOnImport, envJune).spent).toBe('640.00');
  });

  test('баланс периода (§2.5) относит расход к маю, а не к июню', () => {
    expect(mayOnImport.balance.expense).toBe('2390.00');
    expect(juneOnImport.balance.expense).toBe('640.00');
  });

  test('майский конверт не появляется в июньском overview', () => {
    expect(juneOnImport.envelopes.some((e) => e.envelope.id === envMay)).toBe(false);
    expect(mayOnImport.envelopes.some((e) => e.envelope.id === envJune)).toBe(false);
  });
});

describe('§7.1: created_at на результат не влияет', () => {
  // ЧТО ДОКАЗЫВАЕТ: транзакция реально прошла путь импорта и получила серверный
  // created_at, не совпадающий по месяцу с occurred_on (сначала — настоящее «сейчас»,
  // затем — 13 июня 2026 по формулировке §7.1); при обоих значениях привязка к
  // конверту и все агрегаты идентичны, то есть результат зависит только от occurred_on.
  //
  // ЧЕГО НЕ ДОКАЗЫВАЕТ: «сегодня» агрегатов (localToday, §2.2 `occurred_on <= сегодня`)
  // остаётся реальной датой прогона — сервер шва для подмены «сегодня» не имеет.
  // Сценарий §7.1 от этого не слабеет: и май, и июнь 2026 — закрытые периоды, обе даты
  // ≤ «сегодня» при любом прогоне, а сам вопрос §7.1 — принадлежность периоду.
  test('created_at импорта — не месяц операции (реальное «сейчас» при импорте)', () => {
    const id = entityOfRow(0);
    const createdAt = createdAtOnImport.get(id) as string;
    expect(createdAt.slice(0, 7)).not.toBe('2026-05');
    expect(createdAt > '2026-05-31').toBe(true);
  });

  test('created_at = 13 июня 2026: конверт остаётся майским', () => {
    expect(parentsAfterBackdate.get(entityOfRow(0))).toEqual([envMay]);
    expect(parentsAfterBackdate.get(entityOfRow(1))).toEqual([envJune]);
    expect(parentsAfterBackdate.get(entityOfRow(2))).toEqual([envMay]);
  });

  test('created_at = 13 июня 2026: spent и баланс мая/июня не изменились', () => {
    expect(envById(mayAfterBackdate, envMay).spent).toBe(envById(mayOnImport, envMay).spent);
    expect(envById(juneAfterBackdate, envJune).spent).toBe(envById(juneOnImport, envJune).spent);
    expect(mayAfterBackdate.balance).toEqual(mayOnImport.balance);
    expect(juneAfterBackdate.balance).toEqual(juneOnImport.balance);
  });
});

describe('§7.1: provenance импортированной строки', () => {
  test('на каждую строку файла — строка entity_origins с (namespace, external_id)', () => {
    expect(origins).toHaveLength(3);
    const may31 = origins.find((o) => o.externalId === (externalIds[0] as string));
    expect(may31).toEqual({
      namespace: NS,
      externalId: externalIds[0] as string,
      id: entityOfRow(0),
    });
    expect(origins.every((o) => o.namespace === NS)).toBe(true);
    expect(new Set(origins.map((o) => o.id)).size).toBe(3);
  });

  test('повтор ТОГО ЖЕ файла → все строки already_imported (§7 edge, §3.4.1)', () => {
    expect(reviewRepeat.rows.map((r) => r.status)).toEqual([
      'already_imported',
      'already_imported',
      'already_imported',
    ]);
    expect(reviewRepeat.rows.map((r) => r.externalId)).toEqual(externalIds);
  });
});
