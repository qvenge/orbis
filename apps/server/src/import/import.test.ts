// apps/server/src/import/import.test.ts
// Task C2: серверный флоу CSV-импорта (03-budget §3.4, §3.4.1) — три процедуры
// import.analyze / import.review / import.confirm против живой БД через tRPC-caller,
// плюс внутренние операции исполнителя entity_origin_create / entity_origin_delete.
//
// Приёмка PRD, закрываемая здесь:
//   §7 edge «Повторный импорт»  — повтор того же файла даёт все ⟳ already_imported;
//   §7.4 «Импорт пересекающихся файлов» — другой файл с той же операцией даёт ⊘;
//   §3.4.1 последний абзац — Undo импорта ФИЗИЧЕСКИ удаляет строки entity_origins,
//   поэтому тот же файл импортируется заново без ложных «уже импортирована».
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import {
  type CanonicalRow,
  externalRowId,
  globalThreadId,
  type ImportAnalyzeResult,
  MAX_ANALYZE_ROW_CHARS,
  MAX_IMPORT_ROWS,
  newId,
} from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { aiUsage, entities, relations } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { type EntitlementResolver, IMPORT_CSV_KEY } from '../entitlements';
import { ExecError } from '../errors';
import { ScriptedProvider } from '../llm/scripted';
import type { LLMProvider, LLMResponse } from '../llm/types';
import { appRouter } from '../router';
import { seedCategoryId, seedOnboarding } from '../seed/onboarding';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';
import { reviewImport } from './review';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);
const MODEL = 'scripted-test-model';

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

const NS = 'csv:tinkoff-may';
const NS_OTHER = 'csv:sber-may';
const FILE_A = 'a'.repeat(64);
const FILE_B = 'b'.repeat(64);

function ownerCaller(user: string, provider?: LLMProvider, entitlements?: EntitlementResolver) {
  return createCaller({
    actorUserId: user,
    actorKind: 'owner',
    db,
    clientVersion: null,
    // Резолвер §8 едет в ctx.ai (канал инъекции ai.sendMessage): роутер импорта
    // передаёт его в домен через importDeps, analyze — целиком как AiDeps
    ...(provider !== undefined && {
      ai: { provider, model: MODEL, ...(entitlements !== undefined && { entitlements }) },
    }),
  });
}

/** Свежий владелец с онбординг-категориями (aliases нужны suggestedCategoryRef). */
async function freshOwner(): Promise<{ user: string; foodId: string; transportId: string }> {
  const user = freshUserId();
  await withIdentity(db, user, (tx) => seedOnboarding(tx, user));
  return {
    user,
    foodId: seedCategoryId(user, 'food'),
    transportId: seedCategoryId(user, 'transport'),
  };
}

function makeRow(o: {
  occurredOn: string;
  amount: string;
  counterparty: string;
  direction?: 'income' | 'expense';
  rowIndex?: number;
  bankTxnId?: string;
}): CanonicalRow {
  const direction = o.direction ?? 'expense';
  return {
    occurredOn: o.occurredOn,
    amount: o.amount,
    direction,
    counterparty: o.counterparty,
    raw: `${o.occurredOn};${o.amount};${o.counterparty}`,
    rowIndex: o.rowIndex ?? 0,
    ...(o.bankTxnId !== undefined && { bankTxnId: o.bankTxnId }),
  };
}

/** Отказ ДОМЕННОЙ функции (мимо роутера): ExecError с кодом и details. */
async function execError(p: Promise<unknown>): Promise<ExecError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExecError) return e;
    throw e;
  }
  throw new Error('ожидался ExecError, вызов успешен');
}

async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

function causeOf(err: TRPCError): { code?: string; details?: Record<string, unknown> } {
  return err.cause as unknown as { code?: string; details?: Record<string, unknown> };
}

/** Строки entity_origins владельца — СЫРЫМ админ-соединением (мимо RLS и мимо кода C2). */
async function rawOrigins(
  user: string,
): Promise<Array<{ namespace: string; external_id: string; entity_id: string }>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = (await admin.execute(sql`
      SELECT namespace, external_id, entity_id FROM entity_origins
      WHERE owner_id = ${user} ORDER BY namespace, external_id
    `)) as unknown as Array<{ namespace: string; external_id: string; entity_id: string }>;
    return [...rows];
  } finally {
    await adminClient.end();
  }
}

/** Число финансовых сущностей владельца — СЫРЫМ админ-соединением (мимо RLS). */
async function rawFinancialCount(user: string): Promise<number> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = (await admin.execute(sql`
      SELECT count(*)::int AS count FROM entities
      WHERE owner_id = ${user} AND aspects ? 'orbis/financial'
    `)) as unknown as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  } finally {
    await adminClient.end();
  }
}

/** Финансовые сущности владельца (в т.ч. архивные) — проверка «создано/не создано». */
async function financialEntities(user: string) {
  return withIdentity(db, user, (tx) =>
    tx
      .select({ id: entities.id, title: entities.title, archived: entities.archived })
      .from(entities)
      .where(and(eq(entities.ownerId, user), sql`aspects ? 'orbis/financial'`))
      .orderBy(entities.title),
  );
}

function toolUse(input: Record<string, unknown>): LLMResponse {
  return {
    content: '',
    toolCalls: [{ id: 'call-0', name: 'csv_mapping', input }],
    usage: { inputTokens: 120, outputTokens: 40 },
    stopReason: 'tool_use',
  };
}

const MAPPING_SIGN = {
  mapping: {
    date: 0,
    counterparty: 2,
    direction: 'sign',
    amount: 1,
    dateFormat: 'DD.MM.YYYY',
  },
  confidence: 0.92,
} as const satisfies ImportAnalyzeResult;

// ---------------------------------------------------------------------------
// import.review — статусы строк (§3.4.1)
// ---------------------------------------------------------------------------

describe('import.review: статусы строк (§3.4.1)', () => {
  test('строка без origin и без содержательного совпадения → new + категория по алиасам', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const row = makeRow({ occurredOn: '2026-05-03', amount: '340.00', counterparty: 'Кофе Хауз' });

    const r = await caller.import.review({ rows: [row], fileHash: FILE_A, namespace: NS });

    expect(r.rows).toHaveLength(1);
    const reviewed = r.rows[0];
    expect(reviewed?.status).toBe('new');
    expect(reviewed?.externalId).toBe(await externalRowId(FILE_A, row));
    expect(reviewed?.suggestedCategoryRef).toBe(foodId);
    expect(reviewed?.duplicateOf).toBeUndefined();
  });

  test('counterparty без известного алиаса → suggestedCategoryRef не заполняется ([❓ выбрать])', async () => {
    const { user } = await freshOwner();
    const caller = ownerCaller(user);
    const row = makeRow({ occurredOn: '2026-05-07', amount: '3200.00', counterparty: 'OZON' });

    const r = await caller.import.review({ rows: [row], fileHash: FILE_A, namespace: NS });

    expect(r.rows[0]?.status).toBe('new');
    expect(r.rows[0]?.suggestedCategoryRef).toBeUndefined();
  });

  // Обязательство фазы C (Task C2 отложил его сознательно): suggestedCategoryRef строился
  // ТОЛЬКО по алиасам, потому что детерминированного формата memory-правила не было — его
  // задал D3a. Теперь правила применяются ПЕРЕД алиасами тем же кодом, что fast-path (§7.5):
  // на реальной выписке имена мерчантов алиасами не покрыты, и именно правила делают
  // категоризацию импорта полезной.
  test('memory-правило категоризирует строку, которую не покрывает ни один alias', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const row = makeRow({
      occurredOn: '2026-05-09',
      amount: '843.00',
      counterparty: 'SBOL ПЯТЁРОЧКА 843',
    });

    const before = await caller.import.review({ rows: [row], fileHash: FILE_A, namespace: NS });
    expect(before.rows[0]?.suggestedCategoryRef).toBeUndefined(); // без правила — [❓ выбрать]

    await caller.entity.create({
      input: {
        title: 'пятерочка → Еда',
        tags: [],
        aspects: { 'orbis/memory': { kind: 'rule', scope: 'orbis/financial' } },
      },
      source: 'ui',
    });

    const after = await caller.import.review({ rows: [row], fileHash: FILE_A, namespace: NS });
    expect(after.rows[0]?.suggestedCategoryRef).toBe(foodId);
  });

  // §7.4: архивная memory-сущность из контекста исключена — а значит, и из резолва
  // импорта. Фильтр NOT archived в memoryRules не проверялся ничем: снятое владельцем
  // правило продолжало бы категоризировать выписку, и ни один тест этого не заметил бы.
  // На серверной эскалации соседний инвариант закрыт («архивное правило не подавляет»).
  test('архивное правило выписку не категоризирует (§7.4)', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const row = makeRow({
      occurredOn: '2026-05-13',
      amount: '843.00',
      counterparty: 'SBOL ПЯТЁРОЧКА 843', // алиасами не покрыт: без правила предложения нет
    });
    const rule = await caller.entity.create({
      input: {
        title: 'пятерочка → Еда',
        tags: [],
        aspects: { 'orbis/memory': { kind: 'rule', scope: 'orbis/financial' } },
      },
      source: 'ui',
    });
    const active = await caller.import.review({ rows: [row], fileHash: FILE_A, namespace: NS });
    expect(active.rows[0]?.suggestedCategoryRef).toBe(foodId);

    await caller.entity.update({ id: rule.id, archived: true });

    const archived = await caller.import.review({ rows: [row], fileHash: FILE_A, namespace: NS });
    expect(archived.rows[0]?.suggestedCategoryRef).toBeUndefined();
  });

  // Конфликт «один паттерн — разные категории» штатно рождает эскалация §7.8: её гейты
  // пропускают предложение по НОВОЙ паре категорий, и рядом со старым правилом появляется
  // второе. Побеждать обязано свежее — иначе исправление, которое пользователь только что
  // подтвердил кнопкой [Запомнить], молча не работает. Тот же порядок, что у fast-path
  // (applyMemoryRules), поэтому время правки едет в правиле вместе с заголовком.
  test('два правила на один паттерн: импорт берёт СВЕЖЕЕ (а не первое по алфавиту)', async () => {
    const { user, foodId, transportId } = await freshOwner();
    const caller = ownerCaller(user);
    const row = makeRow({
      occurredOn: '2026-05-11',
      amount: '843.00',
      counterparty: 'SBOL ПЯТЁРОЧКА 843',
    });
    const rule = (title: string) =>
      caller.entity.create({
        input: {
          title,
          tags: [],
          aspects: { 'orbis/memory': { kind: 'rule', scope: 'orbis/financial' } },
        },
        source: 'ui' as const,
      });

    // Порядок важен: по алфавиту «пятерочка → Еда» < «пятерочка → Транспорт», то есть
    // лексикографический tie-break вернул бы отменённую пользователем Еду.
    await rule('пятерочка → Еда');
    const first = await caller.import.review({ rows: [row], fileHash: FILE_A, namespace: NS });
    expect(first.rows[0]?.suggestedCategoryRef).toBe(foodId);

    await rule('пятерочка → Транспорт');
    const second = await caller.import.review({ rows: [row], fileHash: FILE_A, namespace: NS });
    expect(second.rows[0]?.suggestedCategoryRef).toBe(transportId);
  });

  // DF п.2 (формулировка K11): порядок «правила ПЕРЕД алиасами» держался только на коде —
  // оба теста выше берут counterparty, которой алиасы не покрывают вовсе, и перестановка
  // двух ступеней местами оставляла серверные тесты зелёными. Здесь ступени КОНФЛИКТУЮТ:
  // alias «кофе» ведёт в Еду (seed/categories.ts), правило «кофе → Транспорт» его
  // перекрывает — при обратном порядке findCategory ответит Едой и тест упадёт.
  test('конфликт правила и alias на одной строке: побеждает правило («кофе» → Транспорт)', async () => {
    const { user, foodId, transportId } = await freshOwner();
    const caller = ownerCaller(user);
    const row = makeRow({
      occurredOn: '2026-05-13',
      amount: '250.00',
      counterparty: 'КОФЕ ХАУЗ 12',
    });

    // без правила — ступень алиасов: «кофе» → Еда
    const before = await caller.import.review({ rows: [row], fileHash: FILE_A, namespace: NS });
    expect(before.rows[0]?.suggestedCategoryRef).toBe(foodId);

    await caller.entity.create({
      input: {
        title: 'кофе → Транспорт',
        tags: [],
        aspects: { 'orbis/memory': { kind: 'rule', scope: 'orbis/financial' } },
      },
      source: 'ui',
    });

    const after = await caller.import.review({ rows: [row], fileHash: FILE_A, namespace: NS });
    expect(after.rows[0]?.suggestedCategoryRef).toBe(transportId);
  });

  test('повтор ТОГО ЖЕ файла после импорта → все строки already_imported (приёмка §7 edge)', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const rows = [
      makeRow({ occurredOn: '2026-05-03', amount: '340.00', counterparty: 'Обед', rowIndex: 0 }),
      makeRow({ occurredOn: '2026-05-04', amount: '420.00', counterparty: 'Такси', rowIndex: 1 }),
    ];
    const rowsToImport = rows.map((row) => ({
      row,
      action: 'create' as const,
      categoryRef: foodId,
    }));

    const confirmed = await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: rowsToImport,
    });
    expect(confirmed.created).toBe(2);

    const again = await caller.import.review({ rows, fileHash: FILE_A, namespace: NS });
    expect(again.rows.map((r) => r.status)).toEqual(['already_imported', 'already_imported']);
  });

  test('пересекающийся ДРУГОЙ файл → probable_duplicate + duplicateOf (приёмка §7.4)', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const imported = makeRow({
      occurredOn: '2026-05-03',
      amount: '1890.00',
      counterparty: 'ПЯТЕРОЧКА 843',
    });
    const confirmed = await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [{ row: imported, action: 'create', categoryRef: foodId }],
    });
    const createdId = confirmed.entityIds[0];

    // Другой файл того же банка: другой external_id, но та же экономическая операция,
    // проведённая на день позже и с «шумным» именем мерчанта (§3.4.1 п.3 — containment).
    const overlapping = makeRow({
      occurredOn: '2026-05-04',
      amount: '1890.00',
      counterparty: 'Пятёрочка',
    });
    const r = await caller.import.review({
      rows: [overlapping],
      fileHash: FILE_B,
      namespace: NS_OTHER,
    });

    expect(r.rows[0]?.status).toBe('probable_duplicate');
    expect(r.rows[0]?.duplicateOf).toBe(createdId as string);
  });

  test('«создать всё равно» для ⊘ → вторая сущность; повтор того же файла идемпотентен', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const first = makeRow({ occurredOn: '2026-05-03', amount: '340.00', counterparty: 'Обед' });
    await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [{ row: first, action: 'create', categoryRef: foodId }],
    });

    const duplicateRow = makeRow({
      occurredOn: '2026-05-03',
      amount: '340.00',
      counterparty: 'Обед',
    });
    const review = await caller.import.review({
      rows: [duplicateRow],
      fileHash: FILE_B,
      namespace: NS_OTHER,
    });
    expect(review.rows[0]?.status).toBe('probable_duplicate');

    // Пользователь переключил строку на «создать всё равно» (§3.4)
    await caller.import.confirm({
      batchId: newId(),
      namespace: NS_OTHER,
      fileHash: FILE_B,
      items: [{ row: duplicateRow, action: 'create', categoryRef: foodId }],
    });
    expect(await financialEntities(user)).toHaveLength(2);

    // Повтор ВТОРОГО файла после этого — уже импортирован, ничего не создаётся
    const repeat = await caller.import.review({
      rows: [duplicateRow],
      fileHash: FILE_B,
      namespace: NS_OTHER,
    });
    expect(repeat.rows[0]?.status).toBe('already_imported');
  });

  test('совпавший bank_txn_id закрывает критерий §3.4.1 при НЕпохожем counterparty (C2b)', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const imported = makeRow({
      occurredOn: '2026-05-10',
      amount: '3200.00',
      counterparty: 'OZON',
      bankTxnId: 'txn-42',
    });
    const confirmed = await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [{ row: imported, action: 'create', categoryRef: foodId }],
    });
    const createdId = confirmed.entityIds[0];

    // Другой файл и namespace (already_imported невозможен): тот же стабильный bank
    // transaction ID, та же сумма и направление, дата +1 день, но counterparty
    // НАМЕРЕННО непохожий — OZON против WILDBERRIES, пиннящая негативная пара C1
    // (similarity < 0.85). Дубль обязан найтись по ID «независимо от текста» (§3.4.1)
    const overlapping = makeRow({
      occurredOn: '2026-05-11',
      amount: '3200.00',
      counterparty: 'WILDBERRIES',
      bankTxnId: 'txn-42',
    });
    const r = await caller.import.review({
      rows: [overlapping],
      fileHash: FILE_B,
      namespace: NS_OTHER,
    });

    expect(r.rows[0]?.status).toBe('probable_duplicate');
    expect(r.rows[0]?.duplicateOf).toBe(createdId as string);
  });

  test('РАЗНЫЕ bank_txn_id не перекрывают и не дисквалифицируют: непохожий текст → new (C2b)', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const imported = makeRow({
      occurredOn: '2026-05-10',
      amount: '3200.00',
      counterparty: 'OZON',
      bankTxnId: 'txn-42',
    });
    await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [{ row: imported, action: 'create', categoryRef: foodId }],
    });

    // Тот же сценарий, но ID другой: падаем обратно на текст, который здесь не совпадает
    const overlapping = makeRow({
      occurredOn: '2026-05-11',
      amount: '3200.00',
      counterparty: 'WILDBERRIES',
      bankTxnId: 'txn-43',
    });
    const r = await caller.import.review({
      rows: [overlapping],
      fileHash: FILE_B,
      namespace: NS_OTHER,
    });

    expect(r.rows[0]?.status).toBe('new');
    expect(r.rows[0]?.duplicateOf).toBeUndefined();
  });

  test('шаблон recurring не участвует в дедупе (§2.8): строка остаётся new', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    // Шаблон повторения: financial + orbis/schedule.recurrence, occurred_on есть
    await withIdentity(db, user, (tx) =>
      tx.insert(entities).values({
        id: newId(),
        ownerId: user,
        title: 'NETFLIX',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: '599.00',
            direction: 'expense',
            category_ref: foodId,
            occurred_on: '2026-05-06',
            counterparty: 'NETFLIX',
          },
          'orbis/schedule': {
            start_at: '2026-05-06T00:00:00Z',
            recurrence: { freq: 'monthly', interval: 1 },
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );

    const row = makeRow({ occurredOn: '2026-05-06', amount: '599.00', counterparty: 'NETFLIX' });
    const r = await caller.import.review({ rows: [row], fileHash: FILE_A, namespace: NS });
    expect(r.rows[0]?.status).toBe('new');
  });

  test('потолок MAX_IMPORT_ROWS: схема режет массив на границе, домен несёт details.limit', async () => {
    const { user } = await freshOwner();
    const caller = ownerCaller(user);
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) =>
      makeRow({
        occurredOn: '2026-05-03',
        amount: '10.00',
        counterparty: `Строка ${i}`,
        rowIndex: i,
      }),
    );

    // (1) Граница СХЕМЫ: массив сверх потолка отклонён zod'ом целиком (400)
    const err = await trpcError(caller.import.review({ rows, fileHash: FILE_A, namespace: NS }));
    expect(err.code).toBe('BAD_REQUEST');
    expect((err.cause as { issues?: Array<{ code?: string }> }).issues?.[0]?.code).toBe('too_big');

    // (2) Доменная проверка НЕ убрана — у неё внятный details.limit (§3 брифа)
    const domainErr = await execError(
      reviewImport(db, user, { rows, fileHash: FILE_A, namespace: NS }),
    );
    expect(domainErr.code).toBe('VALIDATION');
    expect(domainErr.details).toMatchObject({ limit: MAX_IMPORT_ROWS, rows: rows.length });
  });

  test('несуществующая календарная дата отклоняется схемой, а не падает в дедупе', async () => {
    const { user } = await freshOwner();
    const caller = ownerCaller(user);
    // Регексп YYYY-MM-DD такую дату проходит, а календарная арифметика C1 на ней
    // бросила бы RangeError посреди review (Minor №3 ревью C1)
    const row = makeRow({ occurredOn: '2026-02-31', amount: '10.00', counterparty: 'X' });

    const err = await trpcError(
      caller.import.review({ rows: [row], fileHash: FILE_A, namespace: NS }),
    );
    expect(err.code).toBe('BAD_REQUEST');
  });

  test('namespace вне контракта «csv:<источник>» отклоняется схемой', async () => {
    const { user } = await freshOwner();
    const caller = ownerCaller(user);
    const row = makeRow({ occurredOn: '2026-05-03', amount: '10.00', counterparty: 'X' });
    for (const namespace of ['tinkoff', 'csv:', 'csv: пробел', `csv:${'x'.repeat(200)}`]) {
      const err = await trpcError(
        caller.import.review({ rows: [row], fileHash: FILE_A, namespace }),
      );
      expect(err.code).toBe('BAD_REQUEST');
    }
  });
});

// ---------------------------------------------------------------------------
// import.confirm — один batch_execute (§3.4 шаг 4)
// ---------------------------------------------------------------------------

describe('import.confirm: атомарная группа и origins (§3.4, §4.8)', () => {
  test('create → сущность + строка origins с правильным (namespace, external_id)', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const row = makeRow({ occurredOn: '2026-05-03', amount: '340.00', counterparty: 'Обед' });

    const r = await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [{ row, action: 'create', categoryRef: foodId }],
    });

    expect(r.created).toBe(1);
    expect(r.adopted).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.idempotentReplay).toBe(false);
    expect(r.entityIds).toHaveLength(1);

    const origins = await rawOrigins(user);
    expect(origins).toEqual([
      {
        namespace: NS,
        external_id: await externalRowId(FILE_A, row),
        entity_id: r.entityIds[0] as string,
      },
    ]);

    const created = await financialEntities(user);
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe('Обед');
  });

  test('bankTxnId: пробельный не доезжает до аспекта, длинный отклонён схемой (B2)', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);

    // (1) '   ' прошёл бы guard записи и min(1) аспекта — сервер тримит перед записью
    const blank = makeRow({
      occurredOn: '2026-05-03',
      amount: '340.00',
      counterparty: 'Обед',
      bankTxnId: '   ',
    });
    const r = await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [{ row: blank, action: 'create', categoryRef: foodId }],
    });
    const aspects = await withIdentity(db, user, (tx) =>
      tx
        .select({ aspects: entities.aspects })
        .from(entities)
        .where(eq(entities.id, r.entityIds[0] as string)),
    );
    const financial = (aspects[0]?.aspects as Record<string, Record<string, unknown>>)[
      'orbis/financial'
    ];
    expect(financial).not.toHaveProperty('bank_txn_id'); // ключа нет вовсе, не пустая строка

    // (2) ID длиннее аспектных 128 символов отклоняется НА ГРАНИЦЕ (review), а не
    // неспецифичной ошибкой схемы аспекта посреди confirm
    const long = makeRow({
      occurredOn: '2026-05-04',
      amount: '10.00',
      counterparty: 'X',
      bankTxnId: 'x'.repeat(129),
    });
    const err = await trpcError(
      caller.import.review({ rows: [long], fileHash: FILE_A, namespace: NS }),
    );
    expect(err.code).toBe('BAD_REQUEST');
    const confirmErr = await trpcError(
      caller.import.confirm({
        batchId: newId(),
        namespace: NS,
        fileHash: FILE_A,
        items: [{ row: long, action: 'create', categoryRef: foodId }],
      }),
    );
    expect(confirmErr.code).toBe('BAD_REQUEST');
  });

  test('adopt → только строка origins на существующую сущность, новой сущности нет', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const manual = makeRow({ occurredOn: '2026-05-03', amount: '340.00', counterparty: 'Обед' });
    const first = await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [{ row: manual, action: 'create', categoryRef: foodId }],
    });
    const existingId = first.entityIds[0] as string;

    const fromOtherFile = makeRow({
      occurredOn: '2026-05-04',
      amount: '340.00',
      counterparty: 'Обед',
    });
    const r = await caller.import.confirm({
      batchId: newId(),
      namespace: NS_OTHER,
      fileHash: FILE_B,
      items: [{ row: fromOtherFile, action: 'adopt', adoptEntityId: existingId }],
    });

    expect(r.adopted).toBe(1);
    expect(r.created).toBe(0);
    expect(r.entityIds).toEqual([]);
    expect(await financialEntities(user)).toHaveLength(1);

    const origins = await rawOrigins(user);
    expect(origins).toHaveLength(2);
    expect(origins.every((o) => o.entity_id === existingId)).toBe(true);
  });

  test('skip не порождает операций; смешанный набор считается по действиям', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const created = makeRow({
      occurredOn: '2026-05-03',
      amount: '340.00',
      counterparty: 'Обед',
      rowIndex: 0,
    });
    const skipped = makeRow({
      occurredOn: '2026-05-04',
      amount: '420.00',
      counterparty: 'Такси',
      rowIndex: 1,
    });

    const r = await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [
        { row: created, action: 'create', categoryRef: foodId },
        { row: skipped, action: 'skip' },
      ],
    });

    expect(r).toMatchObject({ created: 1, adopted: 0, skipped: 1 });
    expect(await rawOrigins(user)).toHaveLength(1);
  });

  test('невалидная строка валит ВЕСЬ batch: ни сущностей, ни origins (§3.4 шаг 4)', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const good = makeRow({
      occurredOn: '2026-05-03',
      amount: '340.00',
      counterparty: 'Обед',
      rowIndex: 0,
    });
    const bad = makeRow({
      occurredOn: '2026-05-04',
      amount: '420.00',
      counterparty: 'Такси',
      rowIndex: 1,
    });

    // adopt на несуществующую (для этого владельца) сущность — отказ стадии применения
    const err = await trpcError(
      caller.import.confirm({
        batchId: newId(),
        namespace: NS,
        fileHash: FILE_A,
        items: [
          { row: good, action: 'create', categoryRef: foodId },
          { row: bad, action: 'adopt', adoptEntityId: newId() },
        ],
      }),
    );
    expect(err.code).toBe('NOT_FOUND');
    expect(await financialEntities(user)).toHaveLength(0);
    expect(await rawOrigins(user)).toHaveLength(0);
  });

  test('adopt на нефинансовую сущность (категория) → VALIDATION, ничего не создано', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const good = makeRow({
      occurredOn: '2026-05-03',
      amount: '340.00',
      counterparty: 'Обед',
      rowIndex: 0,
    });
    const bad = makeRow({
      occurredOn: '2026-05-04',
      amount: '420.00',
      counterparty: 'Такси',
      rowIndex: 1,
    });

    // foodId — категория онбординга (orbis/category): владение проходит RLS, но
    // финансовой сущностью она не является — пречек обязан завалить batch целиком
    const err = await trpcError(
      caller.import.confirm({
        batchId: newId(),
        namespace: NS,
        fileHash: FILE_A,
        items: [
          { row: good, action: 'create', categoryRef: foodId },
          { row: bad, action: 'adopt', adoptEntityId: foodId },
        ],
      }),
    );
    expect(err.code).toBe('BAD_REQUEST');
    expect(causeOf(err).code).toBe('VALIDATION');
    expect(causeOf(err).details?.adoptEntityId).toBe(foodId);
    expect(causeOf(err).details?.reason).toBe('not_financial');

    // Сырым админ-соединением (мимо RLS): ни строки origins, ни новой сущности
    expect(await rawOrigins(user)).toEqual([]);
    expect(await rawFinancialCount(user)).toBe(0);
  });

  test('adopt на архивную финансовую сущность → VALIDATION (reason=archived)', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const archivedId = await withIdentity(db, user, async (tx) => {
      const id = newId();
      await tx.insert(entities).values({
        id,
        ownerId: user,
        title: 'Архивный обед',
        tags: [],
        archived: true,
        aspects: {
          'orbis/financial': {
            amount: '340.00',
            direction: 'expense',
            category_ref: foodId,
            occurred_on: '2026-05-03',
            counterparty: 'Обед',
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return id;
    });

    const row = makeRow({ occurredOn: '2026-05-03', amount: '340.00', counterparty: 'Обед' });
    const err = await trpcError(
      caller.import.confirm({
        batchId: newId(),
        namespace: NS,
        fileHash: FILE_A,
        items: [{ row, action: 'adopt', adoptEntityId: archivedId }],
      }),
    );
    expect(err.code).toBe('BAD_REQUEST');
    expect(causeOf(err).code).toBe('VALIDATION');
    expect(causeOf(err).details?.reason).toBe('archived');
    expect(await rawOrigins(user)).toEqual([]);
  });

  test('повтор batchId с adopt — replay, даже если цель архивирована после первого прогона', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const manualId = await withIdentity(db, user, async (tx) => {
      const id = newId();
      await tx.insert(entities).values({
        id,
        ownerId: user,
        title: 'Ручной обед',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: '340.00',
            direction: 'expense',
            category_ref: foodId,
            occurred_on: '2026-05-03',
            counterparty: 'Обед',
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return id;
    });

    const row = makeRow({ occurredOn: '2026-05-03', amount: '340.00', counterparty: 'Обед' });
    const input = {
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [{ row, action: 'adopt' as const, adoptEntityId: manualId }],
    };
    const first = await caller.import.confirm(input);
    expect(first.idempotentReplay).toBe(false);

    // Цель архивирована ПОСЛЕ первого прогона: честный повтор batchId (§7.8) обязан
    // вернуться сохранённым replay'ем, а не упасть пречеком «archived»
    await withIdentity(db, user, (tx) =>
      tx.update(entities).set({ archived: true }).where(eq(entities.id, manualId)),
    );
    const second = await caller.import.confirm(input);
    expect(second.idempotentReplay).toBe(true);
    expect(second.adopted).toBe(1);
    expect(await rawOrigins(user)).toHaveLength(1);
  });

  test('повторная вставка того же external_id отклонена БД (unique) — CONFLICT, ничего не создано', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const row = makeRow({ occurredOn: '2026-05-03', amount: '340.00', counterparty: 'Обед' });
    await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [{ row, action: 'create', categoryRef: foodId }],
    });

    // НОВЫЙ batchId (не replay) с той же строкой того же файла: уникальный индекс
    // (owner_id, namespace, external_id) обязан отклонить группу целиком
    const err = await trpcError(
      caller.import.confirm({
        batchId: newId(),
        namespace: NS,
        fileHash: FILE_A,
        items: [{ row, action: 'create', categoryRef: foodId }],
      }),
    );
    expect(err.code).toBe('CONFLICT');
    expect(causeOf(err).code).toBe('CONFLICT');
    expect(await financialEntities(user)).toHaveLength(1);
    expect(await rawOrigins(user)).toHaveLength(1);
  });

  test('повтор того же batchId → идемпотентный replay, второй раз ничего не применяется', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const row = makeRow({ occurredOn: '2026-05-03', amount: '340.00', counterparty: 'Обед' });
    const input = {
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [{ row, action: 'create' as const, categoryRef: foodId }],
    };

    const first = await caller.import.confirm(input);
    const second = await caller.import.confirm(input);

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.entityIds).toEqual(first.entityIds);
    expect(await financialEntities(user)).toHaveLength(1);
    expect(await rawOrigins(user)).toHaveLength(1);
  });

  test('без конверта → unbudgeted по категориям; с конвертом — привязка хуком A4', async () => {
    const { user, foodId, transportId } = await freshOwner();
    const caller = ownerCaller(user);
    // Конверт «Еда» на май — транзакция еды привяжется автоматически (A4), транспорт нет
    await withIdentity(db, user, (tx) =>
      tx.insert(entities).values({
        id: newId(),
        ownerId: user,
        title: 'Конверт Еда',
        tags: [],
        aspects: {
          'orbis/budget': {
            category_ref: foodId,
            limit: '10000.00',
            currency: 'RUB',
            period_start: '2026-05-01',
            period_end: '2026-05-31',
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );

    const food = makeRow({
      occurredOn: '2026-05-03',
      amount: '340.00',
      counterparty: 'Обед',
      rowIndex: 0,
    });
    const taxi = makeRow({
      occurredOn: '2026-05-04',
      amount: '420.00',
      counterparty: 'Такси',
      rowIndex: 1,
    });

    const r = await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [
        { row: food, action: 'create', categoryRef: foodId },
        { row: taxi, action: 'create', categoryRef: transportId },
      ],
    });

    expect(r.created).toBe(2);
    expect(r.unbudgeted).toEqual([{ categoryRef: transportId, count: 1 }]);

    // Привязка «Обеда» к конверту — дописана хуком исполнителя, а не импортом
    const parents = await withIdentity(db, user, (tx) =>
      tx
        .select({ targetId: relations.targetId })
        .from(relations)
        .where(eq(relations.relationType, 'parent')),
    );
    expect(parents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Undo импорта (§3.4.1, 01-arch §4.8)
// ---------------------------------------------------------------------------

describe('Undo импорта: origins удаляются физически (§3.4.1)', () => {
  test('созданные архивированы, усыновлённая жива, origins удалены, файл снова new', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);

    // Ручная (не импортная) операция — цель усыновления
    const manual = await withIdentity(db, user, async (tx) => {
      const id = newId();
      await tx.insert(entities).values({
        id,
        ownerId: user,
        title: 'Ручной обед',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: '999.00',
            direction: 'expense',
            category_ref: foodId,
            occurred_on: '2026-05-09',
            counterparty: 'Ручной обед',
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return id;
    });

    const created = makeRow({
      occurredOn: '2026-05-03',
      amount: '340.00',
      counterparty: 'Обед',
      rowIndex: 0,
    });
    const adopted = makeRow({
      occurredOn: '2026-05-09',
      amount: '999.00',
      counterparty: 'Ручной обед',
      rowIndex: 1,
    });

    const r = await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [
        { row: created, action: 'create', categoryRef: foodId },
        { row: adopted, action: 'adopt', adoptEntityId: manual },
      ],
    });
    expect(await rawOrigins(user)).toHaveLength(2);

    await caller.ai.undo({ actionId: r.actionId });

    // Созданная импортом — архивирована; усыновлённая — жива (§7.8: удаления нет)
    const after = await financialEntities(user);
    const importedRow = after.find((e) => e.id === r.entityIds[0]);
    const manualRow = after.find((e) => e.id === manual);
    expect(importedRow?.archived).toBe(true);
    expect(manualRow?.archived).toBe(false);

    // Строки origins УДАЛЕНЫ физически (не архивированы — их нельзя архивировать)
    expect(await rawOrigins(user)).toEqual([]);

    // …и тот же файл снова читается без ложных «уже импортирована»: созданная строка
    // снова new (её сущность архивирована), усыновлённая — ⊘ на живую ручную операцию
    const review = await caller.import.review({
      rows: [created, adopted],
      fileHash: FILE_A,
      namespace: NS,
    });
    expect(review.rows.map((row) => row.status)).toEqual(['new', 'probable_duplicate']);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Внутренние операции исполнителя недоступны LLM/MCP (§9.2)
// ---------------------------------------------------------------------------

describe('entity_origin_* : только внутренний путь', () => {
  test('dispatchTool не резолвит операции origins — структурная ошибка, без записи', async () => {
    const { user } = await freshOwner();
    for (const tool of ['entity_origin_create', 'entity_origin_delete']) {
      const r = await dispatchTool(
        { db, actorUserId: user, actorKind: 'ai', source: 'chat', explicitCommand: false },
        tool,
        { entity_id: newId(), namespace: NS, external_id: 'x'.repeat(64) },
      );
      expect(r.status).toBe('error');
      if (r.status === 'error') expect(r.error.code).toBe('FORBIDDEN_LEVEL');
    }
    expect(await rawOrigins(user)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// import.analyze — единственный LLM-вызов (§3.4 шаг 2, §7.9)
// ---------------------------------------------------------------------------

describe('import.analyze: маппинг колонок через tool-call', () => {
  test('tool-call модели → маппинг + confidence; в промпт уходят только образцы', async () => {
    const { user } = await freshOwner();
    const provider = new ScriptedProvider([toolUse(MAPPING_SIGN)]);
    const caller = ownerCaller(user, provider);

    const r = await caller.import.analyze({
      sampleRows: ['Дата;Сумма;Описание', '03.05.2026;-340.00;ОБЕД'],
    });

    expect(r).toEqual(MAPPING_SIGN);
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0];
    expect(request?.tools).toHaveLength(1);
    expect(request?.tools[0]?.name).toBe('csv_mapping');
    expect(request?.messages[0]?.content).toContain('03.05.2026;-340.00;ОБЕД');
  });

  test('маппинг с раздельными колонками дебет/кредит проходит согласованность', async () => {
    const { user } = await freshOwner();
    const provider = new ScriptedProvider([
      toolUse({
        mapping: {
          date: 0,
          counterparty: 1,
          direction: 'separate_columns',
          debit: 2,
          credit: 3,
          dateFormat: 'YYYY-MM-DD',
          bankTxnId: 4,
        },
        confidence: 0.7,
      }),
    ]);
    const caller = ownerCaller(user, provider);

    const r = await caller.import.analyze({ sampleRows: ['2026-05-03,ОБЕД,340.00,,tx-1'] });
    expect(r.mapping.direction).toBe('separate_columns');
    expect(r.mapping.debit).toBe(2);
    expect(r.confidence).toBe(0.7);
  });

  test('несогласованный маппинг модели (sign без amount) → структурная ошибка, не выдумка', async () => {
    const { user } = await freshOwner();
    const provider = new ScriptedProvider([
      toolUse({
        mapping: { date: 0, counterparty: 1, direction: 'sign', dateFormat: 'YYYY-MM-DD' },
        confidence: 0.9,
      }),
    ]);
    const caller = ownerCaller(user, provider);

    const err = await trpcError(caller.import.analyze({ sampleRows: ['2026-05-03,ОБЕД'] }));
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(causeOf(err).code).toBe('LLM_UNAVAILABLE');
  });

  test('лишние ключи в ответе модели ОТБРАСЫВАЮТСЯ, а не роняют импорт в 503 (B1)', async () => {
    // Единственный LLM-вызов фичи: строгая схема на границе ответа модели превращала бы
    // один лишний ключ в 503 и молча деградировала бы КАЖДЫЙ импорт в ручной маппинг.
    const { user } = await freshOwner();
    const provider = new ScriptedProvider([
      toolUse({
        mapping: { ...MAPPING_SIGN.mapping, reasoning: 'колонки видны по заголовку' },
        confidence: 0.9,
        note: 'лишнее поле верхнего уровня',
      }),
    ]);
    const r = await ownerCaller(user, provider).import.analyze({ sampleRows: ['03.05.2026,-1,X'] });
    expect(r.mapping).toEqual(MAPPING_SIGN.mapping);
    expect(r).not.toHaveProperty('note'); // отброшено, а не проброшено на клиент
  });

  test('ответ прозой без tool-call → структурная ошибка (маппинг руками на клиенте)', async () => {
    const { user } = await freshOwner();
    const provider = new ScriptedProvider([
      {
        content: 'Первая колонка — дата, вторая — сумма',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'end_turn',
      },
    ]);
    const caller = ownerCaller(user, provider);

    const err = await trpcError(caller.import.analyze({ sampleRows: ['2026-05-03,ОБЕД'] }));
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(causeOf(err).code).toBe('LLM_UNAVAILABLE');
  });

  test('сбой провайдера → LLM_UNAVAILABLE (503, §7.9)', async () => {
    const { user } = await freshOwner();
    const provider: LLMProvider = {
      async chat() {
        throw new Error('econnreset');
      },
    };
    const caller = ownerCaller(user, provider);

    // console.error здесь — заявленное продакшен-поведение (лог оригинала сбоя, как в
    // ai/send-message); мокаем на время ЭТОГО теста, чтобы зелёный прогон был тихим,
    // и восстанавливаем в finally — даже если ассерты упали (образец — trpc.test.ts)
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const err = await trpcError(caller.import.analyze({ sampleRows: ['2026-05-03,ОБЕД'] }));
      expect(err.code).toBe('SERVICE_UNAVAILABLE');
      expect(causeOf(err).code).toBe('LLM_UNAVAILABLE');
      // Продакшен-лог не удалён: оригинал сбоя ушёл в console.error
      expect(spy.mock.calls.flat().map(String).join(' ')).toContain('econnreset');
    } finally {
      spy.mockRestore();
    }
  });

  test('успешный вызов метрится в ai_usage (§4.7)', async () => {
    const { user } = await freshOwner();
    const provider = new ScriptedProvider([toolUse(MAPPING_SIGN)]);
    await ownerCaller(user, provider).import.analyze({ sampleRows: ['2026-05-03,ОБЕД'] });

    const rows = await withIdentity(db, user, (tx) =>
      tx.select().from(aiUsage).where(eq(aiUsage.ownerId, user)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe(MODEL);
    expect(rows[0]?.requestCount).toBe(1);
    expect(rows[0]?.inputTokens).toBe(120);
    expect(rows[0]?.outputTokens).toBe(40);
  });

  test('образцы обрезаются по длине и числу строк (§3.4 шаг 1: приватность)', async () => {
    const { user } = await freshOwner();
    const provider = new ScriptedProvider([toolUse(MAPPING_SIGN)]);
    const caller = ownerCaller(user, provider);

    await caller.import.analyze({ sampleRows: [`2026-05-03,${'ы'.repeat(3000)}`] });
    const prompt = provider.requests[0]?.messages[0]?.content ?? '';
    expect(prompt.length).toBe(MAX_ANALYZE_ROW_CHARS);

    const err = await trpcError(
      caller.import.analyze({ sampleRows: Array.from({ length: 11 }, () => 'a,b,c') }),
    );
    expect(err.code).toBe('BAD_REQUEST');
  });

  test('обрезание не режет суррогатную пару на границе лимита (кодовые точки, не юниты)', async () => {
    const { user } = await freshOwner();
    const provider = new ScriptedProvider([toolUse(MAPPING_SIGN)]);
    const caller = ownerCaller(user, provider);

    // 999 ASCII + эмодзи (суррогатная пара) РОВНО на границе + хвост: послайсовое
    // row.slice(0, 1000) отрезало бы пару посередине и оставило одинокий \uD83D
    const row = `${'a'.repeat(MAX_ANALYZE_ROW_CHARS - 1)}💰${'хвост'.repeat(10)}`;
    await caller.import.analyze({ sampleRows: [row] });

    const prompt = provider.requests[0]?.messages[0]?.content ?? '';
    expect([...prompt].length).toBe(MAX_ANALYZE_ROW_CHARS); // лимит — в кодовых точках
    expect(prompt.endsWith('💰')).toBe(true); // пара цела: одинокого суррогата в промпте нет
  });
});

// ---------------------------------------------------------------------------
// Гейт §9.3: импорт — путь владельца
// ---------------------------------------------------------------------------

describe('роутер import: ownerOnly (§9.3)', () => {
  test('PAT-агент получает FORBIDDEN до какой-либо работы', async () => {
    const agent = createCaller({
      actorUserId: freshUserId(),
      actorKind: 'agent',
      db: null as unknown as ReturnType<typeof appDb>['db'],
      clientVersion: null,
    });
    const row = makeRow({ occurredOn: '2026-05-03', amount: '10.00', counterparty: 'X' });
    for (const call of [
      () => agent.import.analyze({ sampleRows: ['a,b'] }),
      () => agent.import.review({ rows: [row], fileHash: FILE_A, namespace: NS }),
      () =>
        agent.import.confirm({
          batchId: newId(),
          namespace: NS,
          fileHash: FILE_A,
          items: [{ row, action: 'skip' }],
        }),
    ]) {
      const err = await trpcError(call());
      expect(err.code).toBe('FORBIDDEN');
    }
  });
});

// ---------------------------------------------------------------------------
// Гейт §8: entitlement 'import.csv' на всех трёх процедурах (комментарий у
// entity_origin_* в executor.ts опирается на этот гейт как на внешнюю границу)
// ---------------------------------------------------------------------------

describe('роутер import: гейт §8 import.csv (LIMIT → 429)', () => {
  /** Резолвер-отказник: запрещает ТОЛЬКО import.csv, остальные ключи не трогает. */
  const denyImportCsv: EntitlementResolver = (_user, key) =>
    key === IMPORT_CSV_KEY ? { allowed: false, limit: 0 } : { allowed: true, limit: null };

  test('analyze: отказ резолвера → LIMIT (429), LLM-провайдер не вызывается', async () => {
    const { user } = await freshOwner();
    const provider = new ScriptedProvider([toolUse(MAPPING_SIGN)]);
    const err = await trpcError(
      ownerCaller(user, provider, denyImportCsv).import.analyze({ sampleRows: ['a,b,c'] }),
    );
    expect(err.code).toBe('TOO_MANY_REQUESTS');
    expect(causeOf(err).code).toBe('LIMIT');
    expect(causeOf(err).details?.key).toBe(IMPORT_CSV_KEY);
    expect(provider.requests).toHaveLength(0); // гейт ДО обращения к провайдеру
    // …и до метеринга: строк ai_usage нет
    const usage = await withIdentity(db, user, (tx) =>
      tx.select().from(aiUsage).where(eq(aiUsage.ownerId, user)),
    );
    expect(usage).toHaveLength(0);
  });

  test('analyze: отказ по AI-ключу §8 → LIMIT (429): analyze не обходит бюджет ai.*', async () => {
    // import.analyze зовёт провайдера и списывает в ТОТ ЖЕ дневной счётчик ai_usage,
    // что ai.sendMessage, — значит гейт ai.requests_per_day/ai.tokens_per_day
    // обязателен и здесь (иначе импорт был бы неограниченным LLM-путём).
    const denyAiRequests: EntitlementResolver = (_user, key) =>
      key === 'ai.requests_per_day' ? { allowed: false, limit: 0 } : { allowed: true, limit: null };
    const { user } = await freshOwner();
    const provider = new ScriptedProvider([toolUse(MAPPING_SIGN)]);
    const err = await trpcError(
      ownerCaller(user, provider, denyAiRequests).import.analyze({ sampleRows: ['a,b,c'] }),
    );
    expect(err.code).toBe('TOO_MANY_REQUESTS');
    expect(causeOf(err).code).toBe('LIMIT');
    expect(causeOf(err).details?.key).toBe('ai.requests_per_day');
    expect(provider.requests).toHaveLength(0); // гейт ДО обращения к провайдеру
    const usage = await withIdentity(db, user, (tx) =>
      tx.select().from(aiUsage).where(eq(aiUsage.ownerId, user)),
    );
    expect(usage).toHaveLength(0);
  });

  test('analyze: дневной лимит ai.tokens_per_day исчерпан прошлыми вызовами → LIMIT (429)', async () => {
    // Лимит-ветка (не отказ резолвера): счётчики ai_usage за день сравниваются с limit.
    // Первый вызов проходит и метрится (160 токенов), второй упирается в лимит.
    const capTokens: EntitlementResolver = (_user, key) =>
      key === 'ai.tokens_per_day' ? { allowed: true, limit: 100 } : { allowed: true, limit: null };
    const { user } = await freshOwner();
    const provider = new ScriptedProvider([toolUse(MAPPING_SIGN), toolUse(MAPPING_SIGN)]);
    const caller = ownerCaller(user, provider, capTokens);
    await caller.import.analyze({ sampleRows: ['a,b,c'] }); // 120+40 токенов в ai_usage
    const err = await trpcError(caller.import.analyze({ sampleRows: ['a,b,c'] }));
    expect(err.code).toBe('TOO_MANY_REQUESTS');
    expect(causeOf(err).details?.key).toBe('ai.tokens_per_day');
    expect(provider.requests).toHaveLength(1); // второй раз провайдера не звали
  });

  test('review: отказ резолвера → LIMIT (429) до какой-либо работы', async () => {
    const { user } = await freshOwner();
    const row = makeRow({ occurredOn: '2026-05-03', amount: '10.00', counterparty: 'ОБЕД' });
    // ScriptedProvider с пустым скриптом: review провайдера не касается — вызов упал бы
    const err = await trpcError(
      ownerCaller(user, new ScriptedProvider([]), denyImportCsv).import.review({
        rows: [row],
        fileHash: FILE_A,
        namespace: NS,
      }),
    );
    expect(err.code).toBe('TOO_MANY_REQUESTS');
    expect(causeOf(err).code).toBe('LIMIT');
    expect(causeOf(err).details?.key).toBe(IMPORT_CSV_KEY);
  });

  test('confirm: отказ резолвера → LIMIT (429); ни сущностей, ни origins не создано', async () => {
    const { user, foodId } = await freshOwner();
    const row = makeRow({ occurredOn: '2026-05-03', amount: '340.00', counterparty: 'ОБЕД' });
    const err = await trpcError(
      ownerCaller(user, new ScriptedProvider([]), denyImportCsv).import.confirm({
        batchId: newId(),
        namespace: NS,
        fileHash: FILE_A,
        items: [{ row, action: 'create', categoryRef: foodId }],
      }),
    );
    expect(err.code).toBe('TOO_MANY_REQUESTS');
    expect(causeOf(err).code).toBe('LIMIT');
    expect(causeOf(err).details?.key).toBe(IMPORT_CSV_KEY);
    // Работа не началась — СЫРЫМ админ-соединением (мимо RLS и кода C2):
    // ни финансовых сущностей, ни строк entity_origins
    expect(await rawFinancialCount(user)).toBe(0);
    expect(await rawOrigins(user)).toEqual([]);
  });

  test('дефолтный резолвер (план dev) пропускает: review без инъекции работает', async () => {
    const { user } = await freshOwner();
    const row = makeRow({ occurredOn: '2026-05-03', amount: '10.00', counterparty: 'X' });
    const r = await ownerCaller(user).import.review({
      rows: [row],
      fileHash: FILE_A,
      namespace: NS,
    });
    expect(r.rows[0]?.status).toBe('new');
  });
});

// Валюта выписки (уборочная фаза, E11 — Important бэклога фазы C). До этого выписка
// в чужой валюте молча ложилась в валюту владельца: ключа currency в аспекте не было
// вовсе, а его отсутствие и селектор конвертов (§2.3), и агрегаты (§2.2) трактуют как
// валюту по умолчанию. Валюта — свойство ФАЙЛА (у CanonicalRow её нет и не заводится).
describe('import.confirm: валюта выписки (§5 «Чужая валюта»)', () => {
  test('currency=USD пишется в аспект каждой созданной транзакции', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const rows = [
      makeRow({ occurredOn: '2026-06-01', amount: '12.00', counterparty: 'STARBUCKS' }),
      makeRow({ occurredOn: '2026-06-02', amount: '30.00', counterparty: 'UBER', rowIndex: 1 }),
    ];
    const confirmed = await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: rows.map((row) => ({ row, action: 'create' as const, categoryRef: foodId })),
      currency: 'USD',
    });
    expect(confirmed.created).toBe(2);
    for (const id of confirmed.entityIds) {
      const e = await caller.entity.get({ id });
      expect((e.entity.aspects['orbis/financial'] as Record<string, unknown>).currency).toBe('USD');
    }
  });

  test('без currency (старый клиент) ключ не пишется — прежнее поведение', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const row = makeRow({ occurredOn: '2026-06-03', amount: '340.00', counterparty: 'Кафе' });
    const confirmed = await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_A,
      items: [{ row, action: 'create', categoryRef: foodId }],
    });
    const e = await caller.entity.get({ id: confirmed.entityIds[0] as string });
    expect(
      (e.entity.aspects['orbis/financial'] as Record<string, unknown>).currency,
    ).toBeUndefined();
  });

  test('валюта участвует в выборе конверта: USD-строка не липнет к рублёвому конверту', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    // Рублёвый конверт на период — единственный конверт этой категории.
    await caller.entity.create({
      input: {
        title: 'Еда — июнь',
        tags: [],
        aspects: {
          'orbis/budget': {
            category_ref: foodId,
            limit: '30000.00',
            currency: 'RUB',
            period_start: '2026-06-01',
            period_end: '2026-06-30',
          },
        },
      },
      source: 'ui',
    });
    const confirmed = await caller.import.confirm({
      batchId: newId(),
      namespace: NS,
      fileHash: FILE_B,
      items: [
        {
          row: makeRow({ occurredOn: '2026-06-10', amount: '12.00', counterparty: 'STARBUCKS' }),
          action: 'create',
          categoryRef: foodId,
        },
      ],
      currency: 'USD',
    });
    // Комбинация селектора §2.3 — точная (категория+валюта+период): рублёвый конверт
    // валютной операции не родитель, строка честно остаётся Unbudgeted.
    expect(confirmed.unbudgeted.length).toBe(1);
  });
});

// Механизм измерения метрики 00-product §8 (уборочная фаза, E13): «покрытие транзакций»
// объявлено в PRD, но считать его было НЕЧЕМ — skipped-строки (выписка уже была в Orbis)
// в графе следа не оставляют, сущностей по ним не создаётся. Сводка кладётся в журнал.
describe('import.confirm: сводка импорта в журнале (метрика §8)', () => {
  async function summaries(user: string): Promise<Array<Record<string, unknown>>> {
    const { db: admin, client: adminClient } = adminDb();
    try {
      const rows = (await admin.execute(sql`
        SELECT metadata -> 'cards' AS cards FROM chat_messages
        WHERE metadata @> '{"cards":[{"kind":"import_summary"}]}'::jsonb
          AND thread_id = ${globalThreadId(user)}
        ORDER BY created_at
      `)) as unknown as Array<{ cards: Array<Record<string, unknown>> }>;
      return [...rows].flatMap((r) => r.cards).filter((c) => c.kind === 'import_summary');
    } finally {
      await adminClient.end();
    }
  }

  test('сводка несёт все четыре счётчика и не удваивается при повторе confirm', async () => {
    const { user, foodId } = await freshOwner();
    const caller = ownerCaller(user);
    const rows = [
      makeRow({ occurredOn: '2026-07-01', amount: '100.00', counterparty: 'Кафе' }),
      makeRow({ occurredOn: '2026-07-02', amount: '200.00', counterparty: 'Аптека', rowIndex: 1 }),
      makeRow({ occurredOn: '2026-07-03', amount: '300.00', counterparty: 'Метро', rowIndex: 2 }),
    ];
    const batchId = newId();
    const payload = {
      batchId,
      namespace: NS,
      fileHash: FILE_A,
      items: [
        { row: rows[0] as CanonicalRow, action: 'create' as const, categoryRef: foodId },
        { row: rows[1] as CanonicalRow, action: 'create' as const, categoryRef: foodId },
        { row: rows[2] as CanonicalRow, action: 'skip' as const },
      ],
    };
    await caller.import.confirm(payload);

    const first = await summaries(user);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: 'import_summary',
      namespace: NS,
      total: 3,
      created: 2,
      adopted: 0,
      skipped: 1,
    });

    // Идемпотентный повтор того же batchId статистику не удваивает — иначе один файл
    // считался бы дважды и метрика покрытия врала бы в свою пользу.
    await caller.import.confirm(payload);
    expect(await summaries(user)).toHaveLength(1);
  });
});
