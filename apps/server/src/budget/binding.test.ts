// apps/server/src/budget/binding.test.ts
// Интеграционные тесты Task A4 (03-budget §2.3, §2.1): селектор конверта с byte-точным
// tie-break, авто-привязка транзакции внутри того же action, ребиндинг при
// создании/правке/архивации конверта, уникальность конверта. Реальная БД под
// withIdentity (RLS enforced), без моков.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type {
  ActionRecord,
  ExecuteErr,
  ExecuteOk,
  ExecuteRequest,
  ExecuteResult,
  WireEntity,
} from '../executor/types';
import { undoAction } from '../executor/undo';
import { selectEnvelope } from './binding';

requireEnv();

const { db, client } = appDb();
const sink = makeChatJournalSink();

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
    source: 'fast_path',
    operations: [{ tool, input }],
    ...over,
  };
}

function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

function err(r: ExecuteResult): ExecuteErr {
  if (r.ok) throw new Error('ожидался структурированный отказ, получен успех');
  return r;
}

function invariantOf(r: ExecuteErr): string | undefined {
  return (r.error.details as { invariant?: string } | undefined)?.invariant;
}

async function createEntity(
  user: string,
  input: Record<string, unknown>,
): Promise<{ entity: WireEntity; actionId: string }> {
  const r = ok(await execute(db, req(user, 'entity_create', { tags: [], ...input }), { sink }));
  return { entity: r.results[0] as WireEntity, actionId: r.actionId };
}

/** Конверт (orbis/budget): произвольный период, limit фиксированный (деньги тут не считаются). */
function budgetData(
  categoryRef: string,
  periodStart: string,
  periodEnd: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    category_ref: categoryRef,
    limit: '30000.00',
    period_start: periodStart,
    period_end: periodEnd,
    ...over,
  };
}

/** Транзакция (orbis/financial). */
function finData(
  categoryRef: string,
  occurredOn: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    amount: '340.00',
    direction: 'expense',
    category_ref: categoryRef,
    occurred_on: occurredOn,
    ...over,
  };
}

async function adminRows(query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    return [...(await admin.execute(query))];
  } finally {
    await adminClient.end();
  }
}

/** Живые budget-parent'ы транзакции — истина в БД (админ-DSN, обходит RLS). */
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

/** Action из журнала по id (metadata.actions[0] audit-сообщения). */
async function actionById(actionId: string): Promise<ActionRecord> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const rows = await adminRows(
    sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`,
  );
  const md = rows[0]?.metadata as { actions?: ActionRecord[] } | undefined;
  const action = md?.actions?.find((a) => a.id === actionId);
  if (!action) throw new Error(`action ${actionId} не найден в журнале`);
  return action;
}

function selector(
  user: string,
  args: { categoryRef: string; currency: string; occurredOn: string },
): Promise<string | null> {
  return withIdentity(db, user, (tx) => selectEnvelope(tx, { ownerId: user, ...args }));
}

// ---------------------------------------------------------------------------
// Шаг 1: селектор §2.3
// ---------------------------------------------------------------------------
describe('selectEnvelope: селектор конверта §2.3', () => {
  const user = freshUserId();
  const cat = newId();

  test('месячный конверт, период включает дату → выбран', async () => {
    const { entity: env } = await createEntity(user, {
      title: 'Еда — июль',
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    const picked = await selector(user, {
      categoryRef: cat,
      currency: 'RUB',
      occurredOn: '2026-07-15',
    });
    expect(picked).toBe(env.id);
  });

  test('дата вне периода → null; чужая категория → null', async () => {
    expect(
      await selector(user, { categoryRef: cat, currency: 'RUB', occurredOn: '2026-08-01' }),
    ).toBeNull();
    expect(
      await selector(user, { categoryRef: newId(), currency: 'RUB', occurredOn: '2026-07-15' }),
    ).toBeNull();
  });

  test('два кандидата (месячный + узкий) → узкий (минимум календарных дней)', async () => {
    const { entity: narrow } = await createEntity(user, {
      title: 'Еда — отпуск',
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-10', '2026-07-20') },
    });
    const picked = await selector(user, {
      categoryRef: cat,
      currency: 'RUB',
      occurredOn: '2026-07-15',
    });
    expect(picked).toBe(narrow.id);
  });

  test('равная длина периодов → более поздний period_start', async () => {
    const catB = newId();
    await createEntity(user, {
      title: 'A',
      aspects: { 'orbis/budget': budgetData(catB, '2026-07-01', '2026-07-10') },
    });
    const { entity: later } = await createEntity(user, {
      title: 'B',
      aspects: { 'orbis/budget': budgetData(catB, '2026-07-05', '2026-07-14') },
    });
    const picked = await selector(user, {
      categoryRef: catB,
      currency: 'RUB',
      occurredOn: '2026-07-07',
    });
    expect(picked).toBe(later.id);
  });

  test('равная длина и равный старт (разные currency-формы) → меньший UUID', async () => {
    // Полное равенство комбинаций невозможно (уникальность §2.1), но конверт без
    // currency (дефолт RUB) и конверт с явной 'RUB' — разные комбинации, а для
    // RUB-транзакции оба кандидаты: решает третий ключ tie-break — меньший UUID.
    const catC = newId();
    const idSmall = '11111111-1111-4111-8111-111111111111';
    const idBig = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await createEntity(user, {
      id: idBig,
      title: 'явная RUB',
      aspects: { 'orbis/budget': budgetData(catC, '2026-07-01', '2026-07-31', { currency: 'RUB' }) },
    });
    await createEntity(user, {
      id: idSmall,
      title: 'без currency (дефолт RUB)',
      aspects: { 'orbis/budget': budgetData(catC, '2026-07-01', '2026-07-31') },
    });
    const picked = await selector(user, {
      categoryRef: catC,
      currency: 'RUB',
      occurredOn: '2026-07-15',
    });
    expect(picked).toBe(idSmall);
  });

  test('чужая валюта → null; явная валюта конверта матчится', async () => {
    const catD = newId();
    const { entity: eur } = await createEntity(user, {
      title: 'EUR-конверт',
      aspects: { 'orbis/budget': budgetData(catD, '2026-07-01', '2026-07-31', { currency: 'EUR' }) },
    });
    expect(
      await selector(user, { categoryRef: catD, currency: 'RUB', occurredOn: '2026-07-15' }),
    ).toBeNull();
    expect(
      await selector(user, { categoryRef: catD, currency: 'EUR', occurredOn: '2026-07-15' }),
    ).toBe(eur.id);
  });

  test('дефолтная валюта из user_settings: конверт без currency матчится по defaultCurrency', async () => {
    const userEur = freshUserId();
    const catE = newId();
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.execute(
        sql`INSERT INTO user_settings (owner_id, "defaultCurrency") VALUES (${userEur}, 'EUR')`,
      );
    } finally {
      await adminClient.end();
    }
    const { entity: env } = await createEntity(userEur, {
      title: 'конверт без currency',
      aspects: { 'orbis/budget': budgetData(catE, '2026-07-01', '2026-07-31') },
    });
    // coalesce(NULL, 'EUR') = 'EUR' → EUR-транзакция матчится, RUB — нет
    expect(
      await selector(userEur, { categoryRef: catE, currency: 'EUR', occurredOn: '2026-07-15' }),
    ).toBe(env.id);
    expect(
      await selector(userEur, { categoryRef: catE, currency: 'RUB', occurredOn: '2026-07-15' }),
    ).toBeNull();
  });

  test('архивный конверт кандидатом не является', async () => {
    const catF = newId();
    const { entity: env } = await createEntity(user, {
      title: 'архивируемый',
      aspects: { 'orbis/budget': budgetData(catF, '2026-07-01', '2026-07-31') },
    });
    ok(await execute(db, req(user, 'entity_update', { id: env.id, archived: true }), { sink }));
    expect(
      await selector(user, { categoryRef: catF, currency: 'RUB', occurredOn: '2026-07-15' }),
    ).toBeNull();
  });
});
