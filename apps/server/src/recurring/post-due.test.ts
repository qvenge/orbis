// apps/server/src/recurring/post-due.test.ts
// Task A5: переход planned→fact recurring-инстансов (03-budget §2.8, 01 §3.3,
// приёмка 03-budget §7.2/§7.6). Интеграционные тесты против живой БД: системный
// идемпотентный batch с детерминированным batch_id = postFinancialBatchId(instance_id),
// авто-привязка к конверту — бюджет-хуком executor'а (A4) в том же action.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId, postFinancialBatchId, recurringInstanceId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type {
  ActionRecord,
  ExecuteOk,
  ExecuteRequest,
  ExecuteResult,
  WireEntity,
} from '../executor/types';
import { undoAction } from '../executor/undo';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { materializeInstances } from './materialize';
import { postDueInstances } from './post-due';

requireEnv();

const { db, client } = appDb();
const sink = makeChatJournalSink();
const createCaller = createCallerFactory(appRouter);

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

function req(
  user: string,
  tool: string,
  input: unknown,
  over: Partial<ExecuteRequest> = {},
): ExecuteRequest {
  return {
    actorUserId: user,
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool, input }],
    ...over,
  };
}

function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

async function createEntity(user: string, input: Record<string, unknown>): Promise<WireEntity> {
  const r = ok(await execute(db, req(user, 'entity_create', { tags: [], ...input }), { sink }));
  return r.results[0] as WireEntity;
}

/** Recurring-шаблон подписки: daily с 09:00 Москвы + orbis/financial (§2.8). */
async function createFinTemplate(
  user: string,
  categoryRef: string,
  startDate: string,
  amount = '500.00',
): Promise<string> {
  const e = await createEntity(user, {
    title: 'Подписка',
    aspects: {
      'orbis/schedule': {
        start_at: `${startDate}T09:00:00+03:00`,
        timezone: 'Europe/Moscow',
        recurrence: { freq: 'daily', interval: 1 },
      },
      'orbis/financial': {
        amount,
        currency: 'RUB',
        direction: 'expense',
        category_ref: categoryRef,
        recurring: true,
      },
    },
  });
  return e.id;
}

/** Конверт категории на июль 2026 (период включает даты инстансов тестов). */
async function createEnvelope(user: string, categoryRef: string): Promise<string> {
  const e = await createEntity(user, {
    title: 'Конверт',
    aspects: {
      'orbis/budget': {
        category_ref: categoryRef,
        limit: '30000.00',
        currency: 'RUB',
        period_start: '2026-07-01',
        period_end: '2026-07-31',
      },
    },
  });
  return e.id;
}

async function adminRows(query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    return [...(await admin.execute(query))];
  } finally {
    await adminClient.end();
  }
}

/** orbis/financial сущности — истина в БД (админ-DSN). */
async function finOf(id: string): Promise<Record<string, unknown>> {
  const rows = await adminRows(
    sql`SELECT aspects->'orbis/financial' AS fin FROM entities WHERE id = ${id}`,
  );
  if (rows.length === 0) throw new Error(`сущность ${id} не найдена`);
  return rows[0]?.fin as Record<string, unknown>;
}

/** Живые budget-parent'ы транзакции. */
async function budgetParents(txnId: string): Promise<string[]> {
  const rows = await adminRows(
    sql`SELECT r.source_id FROM relations r
        JOIN entities e ON e.id = r.source_id
        WHERE r.target_id = ${txnId} AND r.relation_type = 'parent'
          AND e.aspects ? 'orbis/budget'
        ORDER BY r.source_id`,
  );
  return rows.map((r) => r.source_id as string);
}

/**
 * spent конверта прямым SQL (01 §3.5: не хранится — вычисляется): сумма expense-операций
 * с parent=конверт, неархивных и НЕ planned (§2.3 «planned не входит в spent»).
 */
async function spentOf(envelopeId: string): Promise<string> {
  const rows = await adminRows(
    sql`SELECT COALESCE(SUM((e.aspects->'orbis/financial'->>'amount')::numeric), 0)::text AS spent
        FROM relations r
        JOIN entities e ON e.id = r.target_id
        WHERE r.source_id = ${envelopeId} AND r.relation_type = 'parent'
          AND NOT e.archived
          AND e.aspects->'orbis/financial'->>'direction' = 'expense'
          AND (e.aspects->'orbis/financial'->>'planned') IS DISTINCT FROM 'true'`,
  );
  return rows[0]?.spent as string;
}

/** Action из журнала по id (metadata.actions audit-сообщения); undefined — не записан. */
async function actionById(actionId: string): Promise<ActionRecord | undefined> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const rows = await adminRows(
    sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 2`,
  );
  const md = rows[0]?.metadata as { actions?: ActionRecord[] } | undefined;
  return md?.actions?.find((a) => a.id === actionId);
}

/** Число audit-сообщений, несущих action с этим id (гонка: обязано быть ≤ 1). */
async function actionMessageCount(actionId: string): Promise<number> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const rows = await adminRows(
    sql`SELECT count(*)::int AS n FROM chat_messages WHERE metadata @> ${probe}::jsonb`,
  );
  return rows[0]?.n as number;
}

/** Материализация одного дня startDate (окно в один день). */
async function materializeOne(user: string, templateId: string, date: string): Promise<string> {
  const r = await materializeInstances({ db, ownerId: user, from: date, to: date, today: date });
  if (r.created !== 1) throw new Error(`ожидался 1 инстанс, создано ${r.created}`);
  return recurringInstanceId(templateId, date);
}

describe('postDueInstances (03-budget §2.8): переход planned→fact', () => {
  test('due-инстанс (occurred_on=today): planned=false, привязан к конверту, входит в spent; batch системный с детерминированным id', async () => {
    const user = freshUserId();
    const cat = newId();
    const envelopeId = await createEnvelope(user, cat);
    const templateId = await createFinTemplate(user, cat, '2026-07-01');
    await materializeInstances({
      db,
      ownerId: user,
      from: '2026-07-01',
      to: '2026-07-01',
      today: '2026-07-01',
    });
    const instanceId = recurringInstanceId(templateId, '2026-07-01');

    // До перехода: инстанс planned и в spent НЕ входит (§2.8 «исключительно прогноз»)
    expect((await finOf(instanceId)).planned).toBe(true);
    expect(await spentOf(envelopeId)).toBe('0');

    const r = await postDueInstances({ db, ownerId: user, today: '2026-07-01' });
    expect(r.posted).toBe(1);

    // planned снят, остальные поля financial не тронуты (shallow-merge §9.2)
    const fin = await finOf(instanceId);
    expect(fin.planned).toBe(false);
    expect(fin.amount).toBe('500.00');
    expect(fin.occurred_on).toBe('2026-07-01');
    expect(fin.recurring).toBe(true);

    // привязан к конверту (A4: хук executor'а в том же action) и вошёл в spent
    expect(await budgetParents(instanceId)).toEqual([envelopeId]);
    expect(await spentOf(envelopeId)).toBe('500.00');

    // batch в журнале: action_id = uuidv5(NS, "post-financial:<instance_id>") (01 §3.3),
    // source='system' (скрыт из чата, но точечный undoAction доступен)
    const batchId = postFinancialBatchId(instanceId);
    const action = await actionById(batchId);
    expect(action).toBeDefined();
    expect(action?.source).toBe('system');
  });

  test('будущий инстанс, ручная planned-покупка и шаблон не тронуты; просроченный (occurred_on < today) постится', async () => {
    const user = freshUserId();
    const cat = newId();
    await createEnvelope(user, cat);
    const templateId = await createFinTemplate(user, cat, '2026-07-01');
    await materializeInstances({
      db,
      ownerId: user,
      from: '2026-07-01',
      to: '2026-07-03',
      today: '2026-07-01',
    });
    // Ручная planned-покупка (без derived_from) — переводится ТОЛЬКО явным флоу §2.7
    const manual = await createEntity(user, {
      title: 'Купить кроссовки',
      aspects: {
        'orbis/financial': {
          amount: '8000.00',
          currency: 'RUB',
          direction: 'expense',
          category_ref: cat,
          occurred_on: '2026-07-01',
          planned: true,
        },
      },
    });

    const r = await postDueInstances({ db, ownerId: user, today: '2026-07-02' });
    expect(r.posted).toBe(2); // 07-01 (просрочен) и 07-02 (сегодня)

    expect((await finOf(recurringInstanceId(templateId, '2026-07-01'))).planned).toBe(false);
    expect((await finOf(recurringInstanceId(templateId, '2026-07-02'))).planned).toBe(false);
    // будущий (07-03) остаётся прогнозом
    expect((await finOf(recurringInstanceId(templateId, '2026-07-03'))).planned).toBe(true);
    // ручная покупка не тронута, batch для неё не заводился
    expect((await finOf(manual.id)).planned).toBe(true);
    expect(await actionById(postFinancialBatchId(manual.id))).toBeUndefined();
    // шаблон не тронут: financial шаблона без occurred_on/planned
    const templFin = await finOf(templateId);
    expect(templFin.planned).toBeUndefined();
    expect(templFin.occurred_on).toBeUndefined();
  });

  test('повторный вызов идемпотентен: posted не растёт; после ручного возврата planned=true — replay по audit-PK, ничего не применяется', async () => {
    const user = freshUserId();
    const cat = newId();
    await createEnvelope(user, cat);
    const templateId = await createFinTemplate(user, cat, '2026-07-01');
    const instanceId = await materializeOne(user, templateId, '2026-07-01');

    const first = await postDueInstances({ db, ownerId: user, today: '2026-07-01' });
    expect(first.posted).toBe(1);

    // Повтор: planned уже false → нечего постить
    const second = await postDueInstances({ db, ownerId: user, today: '2026-07-01' });
    expect(second.posted).toBe(0);

    // Владелец вернул planned=true правкой; batch_id детерминирован → повторный вызов
    // сходится в idempotentReplay по audit-PK (§7.8): posted не растёт, правка живёт
    ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: instanceId,
          aspects: { 'orbis/financial': { planned: true } },
        }),
        { sink },
      ),
    );
    const third = await postDueInstances({ db, ownerId: user, today: '2026-07-01' });
    expect(third.posted).toBe(0);
    expect((await finOf(instanceId)).planned).toBe(true);
    expect(await actionMessageCount(postFinancialBatchId(instanceId))).toBe(1);
  });

  test('архивированный заранее инстанс не постится (приёмка 03-budget §7.2)', async () => {
    const user = freshUserId();
    const cat = newId();
    await createEnvelope(user, cat);
    const templateId = await createFinTemplate(user, cat, '2026-07-01');
    const instanceId = await materializeOne(user, templateId, '2026-07-01');

    // Пользователь пропускает ожидаемую операцию — архивирует инстанс до даты (§2.8)
    ok(await execute(db, req(user, 'entity_update', { id: instanceId, archived: true }), { sink }));

    const r = await postDueInstances({ db, ownerId: user, today: '2026-07-01' });
    expect(r.posted).toBe(0);
    expect((await finOf(instanceId)).planned).toBe(true);
    expect(await actionById(postFinancialBatchId(instanceId))).toBeUndefined();
  });

  test('Undo перехода: восстанавливает planned=true И прежнюю привязку одним undoAction; повтор postDue после Undo не пере-постит', async () => {
    const user = freshUserId();
    const cat = newId();
    const envelopeId = await createEnvelope(user, cat);
    const templateId = await createFinTemplate(user, cat, '2026-07-01');
    const instanceId = await materializeOne(user, templateId, '2026-07-01');

    // Прежнее состояние привязки — ПУСТОЕ: владелец отвязал инстанс от конверта
    ok(
      await execute(
        db,
        req(user, 'relation_delete', {
          source_id: envelopeId,
          target_id: instanceId,
          relation_type: 'parent',
        }),
        { sink },
      ),
    );
    expect(await budgetParents(instanceId)).toEqual([]);

    const r = await postDueInstances({ db, ownerId: user, today: '2026-07-01' });
    expect(r.posted).toBe(1);
    // transition снял planned И привязал к конверту (binding-операция дописана A4-хуком
    // в ТОТ ЖЕ action — виден relation_create в операциях batch)
    expect((await finOf(instanceId)).planned).toBe(false);
    expect(await budgetParents(instanceId)).toEqual([envelopeId]);
    const batchId = postFinancialBatchId(instanceId);
    const action = await actionById(batchId);
    expect(action?.operations.some((op) => op.op === 'relation_create')).toBe(true);

    // §2.8: «уже выполненный transition можно отменить обычным Undo» — точечный
    // undoAction по детерминированному action_id (undoLast системные пропускает)
    const u = await undoAction(db, { actorUserId: user, actionId: batchId });
    expect(u.ok).toBe(true);
    expect((await finOf(instanceId)).planned).toBe(true);
    expect(await budgetParents(instanceId)).toEqual([]); // прежняя (пустая) привязка

    // Undo «липкий»: batch_id детерминирован → повтор postDue реплеится по audit-PK
    const again = await postDueInstances({ db, ownerId: user, today: '2026-07-01' });
    expect(again.posted).toBe(0);
    expect((await finOf(instanceId)).planned).toBe(true);
  });

  test('гонка: два конкурентных вызова с двух «устройств» → ровно один action в журнале', async () => {
    const iterations = 8;
    for (let i = 0; i < iterations; i++) {
      const user = freshUserId();
      const cat = newId();
      const envelopeId = await createEnvelope(user, cat);
      const templateId = await createFinTemplate(user, cat, '2026-07-01');
      const instanceId = await materializeOne(user, templateId, '2026-07-01');

      const [a, b] = await Promise.all([
        postDueInstances({ db, ownerId: user, today: '2026-07-01' }),
        postDueInstances({ db, ownerId: user, today: '2026-07-01' }),
      ]);

      // Ровно один применил переход; второй сошёлся в replay по audit-PK (01 §3.3)
      expect(a.posted + b.posted).toBe(1);
      expect((await finOf(instanceId)).planned).toBe(false);
      expect(await budgetParents(instanceId)).toEqual([envelopeId]);
      expect(await actionMessageCount(postFinancialBatchId(instanceId))).toBe(1);
    }
  });
});

describe('tRPC budget.postDue (заготовка роутера, наполнение — A6)', () => {
  test('владелец: постит due-инстансы на локальное «сегодня» (user_settings.timezone); агенту — FORBIDDEN', async () => {
    const user = freshUserId();
    const cat = newId();
    // «Сегодня» в дефолтной таймзоне (user_settings нет → Europe/Moscow), как в A3
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(
      new Date(),
    );
    const envelope = await createEntity(user, {
      title: 'Конверт (сегодня)',
      aspects: {
        'orbis/budget': {
          category_ref: cat,
          limit: '30000.00',
          currency: 'RUB',
          period_start: today,
          period_end: today,
        },
      },
    });
    const templateId = await createFinTemplate(user, cat, today);
    const instanceId = await materializeOne(user, templateId, today);

    const caller = createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
    const r = await caller.budget.postDue();
    expect(r.posted).toBe(1);
    expect((await finOf(instanceId)).planned).toBe(false);
    expect(await budgetParents(instanceId)).toEqual([envelope.id]);

    // Мутационная поверхность tRPC — поверхность владельца (§9.3)
    const agent = createCaller({ actorUserId: user, actorKind: 'agent', db, clientVersion: null });
    await expect(agent.budget.postDue()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
