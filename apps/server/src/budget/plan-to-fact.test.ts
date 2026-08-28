// apps/server/src/budget/plan-to-fact.test.ts
// Task A8: перевод planned-покупки в факт одним batch (03-budget §2.7, приёмка §7.6).
// Интеграционные тесты против живой БД: подтверждение ставит planned=false, обновляет
// occurred_on на фактическую дату и заново выбирает конверт (A4-хук — по НОВОЙ дате);
// Undo восстанавливает план и прежнюю привязку целиком; отказ INVARIANT, если сущность
// не ручная planned-покупка (уже факт / нет financial / шаблон recurring / инстанс с
// derived_from). Идемпотентность повтора по batchId (§7.8).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId, recurringInstanceId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  divergentEntityRow,
  freshUserId,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteRequest, WireEntity } from '../executor/types';
import { undoAction } from '../executor/undo';
import { materializeInstances } from '../recurring/materialize';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

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

// Фиксированные периоды: перевод сдвигает occurred_on из июля в август — доказывает
// «конверт по фактической дате, не по прежней». today-независимы (admin-SQL spent
// не фильтрует по сегодня).
const JULY = { start: '2026-07-01', end: '2026-07-31' };
const AUG = { start: '2026-08-01', end: '2026-08-31' };
const PLANNED_ON = '2026-07-15';
const ACTUAL_ON = '2026-08-10';

function ownerCaller(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

async function exec(user: string, tool: string, input: unknown): Promise<WireEntity> {
  const req: ExecuteRequest = {
    actorUserId: user,
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool, input }],
  };
  const r = await execute(db, req, { sink });
  if (!r.ok) throw new Error(`${tool}: ${r.error.code} — ${r.error.message}`);
  return r.results[0] as WireEntity;
}

async function createEnvelope(
  user: string,
  categoryRef: string,
  period: { start: string; end: string },
): Promise<string> {
  const e = await exec(user, 'entity_create', {
    title: `Конверт ${period.start}`,
    tags: [],
    aspects: {
      'orbis/budget': {
        category_ref: categoryRef,
        limit: '30000.00',
        currency: 'RUB',
        period_start: period.start,
        period_end: period.end,
      },
    },
  });
  return e.id;
}

/** Ручная planned-покупка (§2.7): financial БЕЗ derived_from, planned=true. */
async function createPlanned(
  user: string,
  categoryRef: string,
  occurredOn: string,
  amount = '8000.00',
): Promise<string> {
  const e = await exec(user, 'entity_create', {
    title: 'Купить кроссовки',
    tags: [],
    aspects: {
      'orbis/financial': {
        amount,
        currency: 'RUB',
        direction: 'expense',
        category_ref: categoryRef,
        occurred_on: occurredOn,
        planned: true,
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

/** Свойства сущности — истина в БД (админ-DSN). */
async function propsOf(id: string): Promise<Record<string, unknown>> {
  const rows = await adminRows(sql`SELECT props FROM entities WHERE id = ${id}`);
  if (rows.length === 0) throw new Error(`сущность ${id} не найдена`);
  return rows[0]?.props as Record<string, unknown>;
}

/** Живые budget-parent'ы транзакции. */
async function budgetParents(txnId: string): Promise<string[]> {
  const rows = await adminRows(
    sql`SELECT r.source_id FROM relations r
        JOIN entities e ON e.id = r.source_id
        WHERE r.target_id = ${txnId} AND r.relation_type = 'parent'
          AND 'orbis/budget' = ANY(e.aspects)
        ORDER BY r.source_id`,
  );
  return rows.map((r) => r.source_id as string);
}

/** spent конверта прямым SQL (01 §3.5): факт-расходы (planned≠true), без today-фильтра. */
async function spentOf(envelopeId: string): Promise<string> {
  const rows = await adminRows(
    sql`SELECT COALESCE(SUM((e.props->>'orbis/amount')::numeric), 0)::text AS spent
        FROM relations r
        JOIN entities e ON e.id = r.target_id
        WHERE r.source_id = ${envelopeId} AND r.relation_type = 'parent'
          AND NOT e.archived
          AND e.props->>'orbis/direction' = 'expense'
          AND (e.props->>'orbis/planned') IS DISTINCT FROM 'true'`,
  );
  return rows[0]?.spent as string;
}

/** Число audit-сообщений, несущих action с этим id (идемпотентность: ровно один). */
async function actionMessageCount(actionId: string): Promise<number> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const rows = await adminRows(
    sql`SELECT count(*)::int AS n FROM chat_messages WHERE metadata @> ${probe}::jsonb`,
  );
  return rows[0]?.n as number;
}

describe('budget.confirmPurchase (03-budget §2.7): перевод planned→fact', () => {
  test('перевод ставит факт и конверт по ФАКТИЧЕСКОЙ дате (не по прежней); расход входит в spent', async () => {
    const user = freshUserId();
    const cat = newId();
    const julyEnv = await createEnvelope(user, cat, JULY);
    const augEnv = await createEnvelope(user, cat, AUG);
    const purchase = await createPlanned(user, cat, PLANNED_ON);

    // Прекондиция: planned привязан к июльскому конверту (дата плана), в spent НЕ входит
    expect(await budgetParents(purchase)).toEqual([julyEnv]);
    expect(await spentOf(julyEnv)).toBe('0');

    const batchId = newId();
    const r = await ownerCaller(user).budget.confirmPurchase({
      entityId: purchase,
      occurredOn: ACTUAL_ON,
      batchId,
    });
    expect(r.idempotentReplay).toBe(false);
    expect(r.actionId).toBe(batchId);

    // planned снят, occurred_on = фактическая дата, прочие поля financial сохранены (§9.2)
    const fin = await propsOf(purchase);
    expect(fin['orbis/planned']).toBe(false);
    expect(fin['orbis/occurred_on']).toBe(ACTUAL_ON);
    expect(fin['orbis/amount']).toBe('8000.00');
    expect(fin['orbis/finance_category']).toBe(cat);

    // конверт переселектён по НОВОЙ дате: августовский, не июльский; расход вошёл в spent
    expect(await budgetParents(purchase)).toEqual([augEnv]);
    expect(await spentOf(augEnv)).toBe('8000.00');
    expect(await spentOf(julyEnv)).toBe('0');

    // ровно один action на весь batch (§7.8)
    expect(await actionMessageCount(batchId)).toBe(1);
  });

  test('Undo восстанавливает planned=true, прежний occurred_on и прежнюю привязку целиком (§7.6)', async () => {
    const user = freshUserId();
    const cat = newId();
    const julyEnv = await createEnvelope(user, cat, JULY);
    const augEnv = await createEnvelope(user, cat, AUG);
    const purchase = await createPlanned(user, cat, PLANNED_ON);

    const batchId = newId();
    await ownerCaller(user).budget.confirmPurchase({
      entityId: purchase,
      occurredOn: ACTUAL_ON,
      batchId,
    });
    expect((await propsOf(purchase))['orbis/planned']).toBe(false);
    expect(await budgetParents(purchase)).toEqual([augEnv]);

    // Undo целиком: план + прежняя дата + прежний конверт (§2.7 «обратимо целиком»)
    const u = await undoAction(db, { actorUserId: user, actionId: batchId });
    expect(u.ok).toBe(true);
    const fin = await propsOf(purchase);
    expect(fin['orbis/planned']).toBe(true);
    expect(fin['orbis/occurred_on']).toBe(PLANNED_ON);
    expect(await budgetParents(purchase)).toEqual([julyEnv]);
    expect(await spentOf(augEnv)).toBe('0');
  });

  test('повтор того же batchId → idempotentReplay: состояние не меняется, action один', async () => {
    const user = freshUserId();
    const cat = newId();
    const augEnv = await createEnvelope(user, cat, AUG);
    const purchase = await createPlanned(user, cat, PLANNED_ON);

    const batchId = newId();
    const input = { entityId: purchase, occurredOn: ACTUAL_ON, batchId };
    const first = await ownerCaller(user).budget.confirmPurchase(input);
    expect(first.idempotentReplay).toBe(false);

    const second = await ownerCaller(user).budget.confirmPurchase(input);
    expect(second.idempotentReplay).toBe(true);
    expect(second.actionId).toBe(batchId);

    expect((await propsOf(purchase))['orbis/planned']).toBe(false);
    expect(await budgetParents(purchase)).toEqual([augEnv]);
    expect(await actionMessageCount(batchId)).toBe(1);
  });

  test('уже-факт → INVARIANT (переводить нечего)', async () => {
    const user = freshUserId();
    const cat = newId();
    await createEnvelope(user, cat, AUG);
    // Уже факт: planned=false с самого создания
    const fact = await exec(user, 'entity_create', {
      title: 'Уже куплено',
      tags: [],
      aspects: {
        'orbis/financial': {
          amount: '8000.00',
          currency: 'RUB',
          direction: 'expense',
          category_ref: cat,
          occurred_on: ACTUAL_ON,
          planned: false,
        },
      },
    });
    await expect(
      ownerCaller(user).budget.confirmPurchase({
        entityId: fact.id,
        occurredOn: ACTUAL_ON,
        batchId: newId(),
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
  });

  test('архивная planned-покупка → INVARIANT (сначала разархивировать); состояние не тронуто', async () => {
    const user = freshUserId();
    const cat = newId();
    await createEnvelope(user, cat, JULY);
    const planned = await exec(user, 'entity_create', {
      title: 'Отложенная покупка',
      tags: [],
      aspects: {
        'orbis/financial': {
          amount: '8000.00',
          currency: 'RUB',
          direction: 'expense',
          category_ref: cat,
          occurred_on: PLANNED_ON,
          planned: true,
        },
      },
    });
    await exec(user, 'entity_update', { id: planned.id, archived: true });

    await expect(
      ownerCaller(user).budget.confirmPurchase({
        entityId: planned.id,
        occurredOn: ACTUAL_ON,
        batchId: newId(),
      }),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      message: expect.stringContaining('разархивируйте'),
    });
    // не тронута: осталась архивным планом
    expect((await propsOf(planned.id))['orbis/planned']).toBe(true);
  });

  test('recurring-инстанс (derived_from) → INVARIANT (его переводит postDue, §2.8)', async () => {
    const user = freshUserId();
    const cat = newId();
    await createEnvelope(user, cat, JULY);
    // Шаблон подписки + материализованный инстанс на 2026-07-15
    const template = await exec(user, 'entity_create', {
      title: 'Подписка',
      tags: [],
      aspects: {
        'orbis/schedule': {
          start_at: `${PLANNED_ON}T09:00:00+03:00`,
          timezone: 'Europe/Moscow',
          recurrence: { freq: 'daily', interval: 1 },
        },
        'orbis/financial': {
          amount: '500.00',
          currency: 'RUB',
          direction: 'expense',
          category_ref: cat,
          recurring: true,
        },
      },
    });
    await materializeInstances({
      db,
      ownerId: user,
      from: PLANNED_ON,
      to: PLANNED_ON,
      today: PLANNED_ON,
    });
    const instanceId = recurringInstanceId(template.id, PLANNED_ON);
    expect((await propsOf(instanceId))['orbis/planned']).toBe(true);

    await expect(
      ownerCaller(user).budget.confirmPurchase({
        entityId: instanceId,
        occurredOn: ACTUAL_ON,
        batchId: newId(),
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
    // не тронут: остался planned-прогнозом
    expect((await propsOf(instanceId))['orbis/planned']).toBe(true);
  });

  test('шаблон recurring → INVARIANT', async () => {
    const user = freshUserId();
    const cat = newId();
    const template = await exec(user, 'entity_create', {
      title: 'Аренда',
      tags: [],
      aspects: {
        'orbis/schedule': {
          start_at: `${PLANNED_ON}T09:00:00+03:00`,
          timezone: 'Europe/Moscow',
          recurrence: { freq: 'monthly', interval: 1 },
        },
        'orbis/financial': {
          amount: '40000.00',
          currency: 'RUB',
          direction: 'expense',
          category_ref: cat,
          recurring: true,
        },
      },
    });
    await expect(
      ownerCaller(user).budget.confirmPurchase({
        entityId: template.id,
        occurredOn: ACTUAL_ON,
        batchId: newId(),
      }),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      // ссылка на §2.8 (recurring-конвейер), а не §2.9 (фазы конверта) — опечатка ревью
      message: expect.stringContaining('(§2.8)'),
    });
  });

  test('не-financial сущность → INVARIANT', async () => {
    const user = freshUserId();
    // Сущность без orbis/financial (только заголовок) — переводить нечего
    const note = await exec(user, 'entity_create', { title: 'Заметка', tags: [] });
    await expect(
      ownerCaller(user).budget.confirmPurchase({
        entityId: note.id,
        occurredOn: ACTUAL_ON,
        batchId: newId(),
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
  });

  test('чужая сущность (RLS) → INVARIANT', async () => {
    const owner = freshUserId();
    const other = freshUserId();
    const cat = newId();
    await createEnvelope(owner, cat, AUG);
    const purchase = await createPlanned(owner, cat, PLANNED_ON);
    // Другой пользователь не видит сущность под RLS → отказ (не перевод чужого плана)
    await expect(
      ownerCaller(other).budget.confirmPurchase({
        entityId: purchase,
        occurredOn: ACTUAL_ON,
        batchId: newId(),
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
    expect((await propsOf(purchase))['orbis/planned']).toBe(true);
  });

  test('мутация — поверхность владельца: агенту FORBIDDEN (§9.3)', async () => {
    const user = freshUserId();
    const cat = newId();
    const purchase = await createPlanned(user, cat, PLANNED_ON);
    const agent = createCaller({ actorUserId: user, actorKind: 'agent', db, clientVersion: null });
    await expect(
      agent.budget.confirmPurchase({
        entityId: purchase,
        occurredOn: ACTUAL_ON,
        batchId: newId(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ---------------------------------------------------------------------------
// Задача 10a: пречек §2.7 читает НОВУЮ правду строки (§А1-1)
// ---------------------------------------------------------------------------
/**
 * ПРОБА РАСХОЖДЕНИЕМ КОЛОНОК (тот же приём, что в `aggregates.test.ts`/`binding.test.ts`):
 * строка кладётся прямым INSERT'ом так, что `props` и старая карта говорят про `planned`
 * ПРОТИВОПОЛОЖНОЕ, и тест спрашивает, чей ответ даёт пречек. Обе стороны границы: план по
 * props переводится, факт по props — отвергается.
 */
describe('пречек §2.7 читает planned из props (§А1-1, РП-9, Задача 10a)', () => {
  function divergentRow(
    user: string,
    id: string,
    props: Record<string, unknown>,
    legacyFin: Record<string, unknown>,
  ): typeof entities.$inferInsert {
    return divergentEntityRow({
      ownerId: user,
      id,
      title: 'Покупка расхождения',
      props,
      aspects: ['orbis/financial'],
      legacy: { 'orbis/financial': legacyFin },
    });
  }

  const finProps = (over: Record<string, unknown>) => ({
    'orbis/amount': '1000.00',
    'orbis/direction': 'expense',
    'orbis/finance_category': newId(),
    'orbis/occurred_on': PLANNED_ON,
    ...over,
  });

  test('план по props переводится в факт, хотя старая карта зовёт его фактом', async () => {
    const user = freshUserId();
    const id = newId();
    await withIdentity(db, user, (tx) =>
      tx.insert(entities).values(
        divergentRow(user, id, finProps({ 'orbis/planned': true }), {
          amount: '1000.00',
          direction: 'expense',
          occurred_on: PLANNED_ON,
          planned: false,
        }),
      ),
    );

    await ownerCaller(user).budget.confirmPurchase({
      entityId: id,
      occurredOn: ACTUAL_ON,
      batchId: newId(),
    });
    expect((await propsOf(id))['orbis/planned']).toBe(false);
    expect((await propsOf(id))['orbis/occurred_on']).toBe(ACTUAL_ON);
  });

  test('факт по props (свойства нет — РП-9) отвергается, хотя старая карта зовёт его планом', async () => {
    const user = freshUserId();
    const id = newId();
    await withIdentity(db, user, (tx) =>
      tx.insert(entities).values(
        divergentRow(user, id, finProps({}), {
          amount: '1000.00',
          direction: 'expense',
          occurred_on: PLANNED_ON,
          planned: true,
        }),
      ),
    );

    await expect(
      ownerCaller(user).budget.confirmPurchase({
        entityId: id,
        occurredOn: ACTUAL_ON,
        batchId: newId(),
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
  });
});
