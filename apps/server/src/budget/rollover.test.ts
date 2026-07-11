// apps/server/src/budget/rollover.test.ts
// Task A7: Rollover — превью carryover (03-budget §2.6, §3.5) и атомарное создание
// конвертов нового периода одним batch_execute. Интеграционные тесты против живой БД:
// carryover = remaining(прошлый) включая отрицательный; suggestedLimit — limit прошлого
// конверта, а для категории с тратами без конверта — spent, округлённый ВВЕРХ до 100;
// произвольные периоды (§2.9) не участвуют ни как источник, ни как преемник-блокер;
// needsSetup — «первый месяц без истории» (§3.5); мутация rollover — идемпотентна по
// batchId, атомарна (INVARIANT всего batch), Undo сносит все конверты одним action.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteRequest, WireEntity } from '../executor/types';
import { undoAction } from '../executor/undo';
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

// «Сегодня» — как считает сервер: локальная дата в дефолтной таймзоне (Europe/Moscow)
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// Целевой месяц rollover — текущий; источник carryover — прошлый (закрытый) месяц
const target = today.slice(0, 7);
const prev = shiftMonth(target, -1);
const prevStart = `${prev}-01`;
const prevEnd = lastDayOf(prev);
const targetStart = `${target}-01`;
const targetEnd = lastDayOf(target);

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

async function createCategory(user: string, title: string, icon = '🍔'): Promise<string> {
  const e = await exec(user, 'entity_create', {
    title,
    tags: [],
    aspects: { 'orbis/category': { icon } },
  });
  return e.id;
}

async function createEnvelope(
  user: string,
  categoryRef: string,
  periodStart: string,
  periodEnd: string,
  limit: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const e = await exec(user, 'entity_create', {
    title: `Конверт ${periodStart}`,
    tags: [],
    aspects: {
      'orbis/budget': {
        category_ref: categoryRef,
        limit,
        period_start: periodStart,
        period_end: periodEnd,
        ...over,
      },
    },
  });
  return e.id;
}

async function createTxn(
  user: string,
  categoryRef: string,
  amount: string,
  occurredOn: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const e = await exec(user, 'entity_create', {
    title: `Трата ${amount}`,
    tags: [],
    aspects: {
      'orbis/financial': {
        amount,
        direction: 'expense',
        category_ref: categoryRef,
        occurred_on: occurredOn,
        ...over,
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

/** Все конверты владельца (включая архивные) — истина в БД (админ-DSN). */
async function envelopesOf(
  user: string,
): Promise<Array<{ id: string; archived: boolean; budget: Record<string, unknown> }>> {
  const rows = await adminRows(
    sql`SELECT id, archived, aspects->'orbis/budget' AS budget FROM entities
        WHERE owner_id = ${user} AND aspects ? 'orbis/budget' ORDER BY id`,
  );
  return rows.map((r) => ({
    id: r.id as string,
    archived: r.archived as boolean,
    budget: r.budget as Record<string, unknown>,
  }));
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

/** Число audit-сообщений, несущих action с этим id (атомарность: ровно один на batch). */
async function actionMessageCount(actionId: string): Promise<number> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const rows = await adminRows(
    sql`SELECT count(*)::int AS n FROM chat_messages WHERE metadata @> ${probe}::jsonb`,
  );
  return rows[0]?.n as number;
}

describe('budget.rolloverPreview (03-budget §2.6, §3.5)', () => {
  test('профицит → положительный carryover; carryover прошлого конверта входит в remaining; suggestedLimit = limit прошлого', async () => {
    const user = freshUserId();
    const catFood = await createCategory(user, 'Еда', '🍔');
    const catFun = await createCategory(user, 'Развлечения', '🎉');
    // Еда: limit 30000, трат 28800 → carryover +1200
    await createEnvelope(user, catFood, prevStart, prevEnd, '30000.00');
    await createTxn(user, catFood, '28800.00', `${prev}-05`);
    // Развлечения: limit 10000 + carryover 500 (перенос прошлых месяцев), трат 400
    // → remaining = 10000 + 500 − 400 = 10100 (§2.4: effective_limit = limit + carryover)
    await createEnvelope(user, catFun, prevStart, prevEnd, '10000.00', { carryover: '500.00' });
    await createTxn(user, catFun, '400.00', `${prev}-10`);

    const p = await ownerCaller(user).budget.rolloverPreview({ month: target });
    expect(p.month).toBe(target);
    expect(p.needsSetup).toBe(false);
    expect(p.rows).toHaveLength(2);

    const food = p.rows.find((r) => r.categoryId === catFood);
    expect(food).toMatchObject({
      categoryTitle: 'Еда',
      categoryIcon: '🍔',
      prevSpent: '28800.00',
      carryover: '1200.00',
      suggestedLimit: '30000.00',
    });
    const fun = p.rows.find((r) => r.categoryId === catFun);
    expect(fun).toMatchObject({
      prevSpent: '400.00',
      carryover: '10100.00',
      suggestedLimit: '10000.00',
    });
  });

  test('дефицит → отрицательный carryover (перерасход урезает следующий период)', async () => {
    const user = freshUserId();
    const cat = await createCategory(user, 'Транспорт', '🚕');
    await createEnvelope(user, cat, prevStart, prevEnd, '9000.00');
    await createTxn(user, cat, '10100.00', `${prev}-15`);

    const p = await ownerCaller(user).budget.rolloverPreview({ month: target });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({
      categoryId: cat,
      prevSpent: '10100.00',
      carryover: '-1100.00',
      suggestedLimit: '9000.00',
    });
  });

  test('категория с уже созданным конвертом-преемником целевого месяца — не в rows', async () => {
    const user = freshUserId();
    const catA = await createCategory(user, 'Еда');
    const catB = await createCategory(user, 'Жильё', '🏠');
    await createEnvelope(user, catA, prevStart, prevEnd, '30000.00');
    await createEnvelope(user, catB, prevStart, prevEnd, '45000.00');
    // Преемник для catB уже создан вручную
    await createEnvelope(user, catB, targetStart, targetEnd, '45000.00');

    const p = await ownerCaller(user).budget.rolloverPreview({ month: target });
    expect(p.rows.map((r) => r.categoryId)).toEqual([catA]);
  });

  test('произвольные периоды (§2.9): не источник carryover; пересекающий целевой месяц — не преемник-блокер', async () => {
    const user = freshUserId();
    const catTravel = await createCategory(user, 'Путешествия', '✈️');
    const catFood = await createCategory(user, 'Еда');
    // Произвольный конверт прошлого месяца (не календарный месяц) с тратами:
    // в rollover не участвует — ни как источник, ни через spending-ветку (конверт есть)
    await createEnvelope(user, catTravel, `${prev}-10`, `${prev}-24`, '50000.00');
    await createTxn(user, catTravel, '42000.00', `${prev}-12`);
    // Месячный конверт прошлого месяца + произвольный конверт, пересекающий целевой
    // месяц: произвольный преемником НЕ считается — категория остаётся кандидатом
    await createEnvelope(user, catFood, prevStart, prevEnd, '30000.00');
    await createEnvelope(user, catFood, `${target}-05`, `${target}-15`, '5000.00');

    const p = await ownerCaller(user).budget.rolloverPreview({ month: target });
    expect(p.rows.map((r) => r.categoryId)).toEqual([catFood]);
  });

  test('категория с тратами без конверта (история есть): carryover 0, suggestedLimit = spent вверх до 100', async () => {
    const user = freshUserId();
    const catFood = await createCategory(user, 'Еда');
    const catNew = await createCategory(user, 'Кофейни', '☕');
    const catExact = await createCategory(user, 'Аптека', '💊');
    await createEnvelope(user, catFood, prevStart, prevEnd, '30000.00');
    await createTxn(user, catNew, '3841.50', `${prev}-07`);
    await createTxn(user, catExact, '200.00', `${prev}-08`);

    const p = await ownerCaller(user).budget.rolloverPreview({ month: target });
    const noEnv = p.rows.find((r) => r.categoryId === catNew);
    expect(noEnv).toMatchObject({
      prevSpent: '3841.50',
      carryover: '0.00',
      suggestedLimit: '3900.00', // вверх до 100, decimal без float
    });
    // Ровно кратная 100 сумма не завышается
    const exact = p.rows.find((r) => r.categoryId === catExact);
    expect(exact).toMatchObject({ prevSpent: '200.00', suggestedLimit: '200.00' });
    expect(p.needsSetup).toBe(false);
  });

  test('валютная граница: конверт прошлого месяца в чужой валюте не участвует (как categoryTrend, §5)', async () => {
    const user = freshUserId();
    const cat = await createCategory(user, 'Подписки', '📺');
    await createEnvelope(user, cat, prevStart, prevEnd, '50.00', { currency: 'USD' });
    await createTxn(user, cat, '30.00', `${prev}-03`, { currency: 'USD' });

    const p = await ownerCaller(user).budget.rolloverPreview({ month: target });
    expect(p.rows).toEqual([]);
    // Траты в чужой валюте не делают needsSetup: defaultCurrency-агрегат их не видит
    expect(p.needsSetup).toBe(false);
  });

  test('needsSetup=true: траты прошлого месяца без единого конверта — первый месяц без истории (§3.5)', async () => {
    const user = freshUserId();
    const cat = await createCategory(user, 'Еда');
    await createTxn(user, cat, '12500.00', `${prev}-20`);

    const p = await ownerCaller(user).budget.rolloverPreview({ month: target });
    expect(p.rows).toEqual([]);
    expect(p.needsSetup).toBe(true);

    // Без трат и без конвертов needsSetup=false (нечего настраивать по факту)
    const empty = freshUserId();
    const pe = await ownerCaller(empty).budget.rolloverPreview({ month: target });
    expect(pe.rows).toEqual([]);
    expect(pe.needsSetup).toBe(false);
  });
});

describe('budget.rollover (03-budget §3.5): атомарное создание конвертов', () => {
  test('создаёт N конвертов одним batch: период = целевой месяц, валюта = defaultCurrency; авто-перехват транзакций (A4); превью пустеет', async () => {
    const user = freshUserId();
    const catFood = await createCategory(user, 'Еда');
    const catFun = await createCategory(user, 'Развлечения');
    await createEnvelope(user, catFood, prevStart, prevEnd, '30000.00');
    await createEnvelope(user, catFun, prevStart, prevEnd, '10000.00');
    // Накопленная факт-транзакция целевого месяца — будет перехвачена новым конвертом
    const txnId = await createTxn(user, catFood, '340.00', targetStart);
    expect(await budgetParents(txnId)).toEqual([]);

    const batchId = newId();
    const r = await ownerCaller(user).budget.rollover({
      month: target,
      batchId,
      rows: [
        { categoryId: catFood, limit: '30000.00', carryover: '1200.00' },
        { categoryId: catFun, limit: '10000.00', carryover: '0' },
      ],
    });
    expect(r.idempotentReplay).toBe(false);
    expect(r.actionId).toBe(batchId);
    expect(r.envelopeIds).toHaveLength(2);

    // Конверты в БД: точный календарный месяц, явная defaultCurrency, лимит/carryover входа
    const envs = await envelopesOf(user);
    const created = envs.filter((e) => r.envelopeIds.includes(e.id));
    expect(created).toHaveLength(2);
    for (const e of created) {
      expect(e.archived).toBe(false);
      expect(e.budget.period_start).toBe(targetStart);
      expect(e.budget.period_end).toBe(targetEnd);
      expect(e.budget.currency).toBe('RUB');
    }
    const foodEnv = created.find((e) => e.budget.category_ref === catFood);
    expect(foodEnv?.budget.limit).toBe('30000.00');
    expect(foodEnv?.budget.carryover).toBe('1200.00');

    // Один action на весь batch (атомарность журнала) и авто-перехват A4-хуком
    expect(await actionMessageCount(batchId)).toBe(1);
    expect(await budgetParents(txnId)).toEqual([foodEnv?.id as string]);

    // Преемники созданы → кандидатов больше нет; история есть → needsSetup=false
    const p = await ownerCaller(user).budget.rolloverPreview({ month: target });
    expect(p.rows).toEqual([]);
    expect(p.needsSetup).toBe(false);
  });

  test('повтор batchId → idempotentReplay: те же envelopeIds, конверты не дублируются', async () => {
    const user = freshUserId();
    const cat = await createCategory(user, 'Еда');
    await createEnvelope(user, cat, prevStart, prevEnd, '30000.00');

    const batchId = newId();
    const input = {
      month: target,
      batchId,
      rows: [{ categoryId: cat, limit: '31000.00', carryover: '500.00' }],
    };
    const first = await ownerCaller(user).budget.rollover(input);
    expect(first.idempotentReplay).toBe(false);

    const second = await ownerCaller(user).budget.rollover(input);
    expect(second.idempotentReplay).toBe(true);
    expect(second.envelopeIds).toEqual(first.envelopeIds);
    expect(second.actionId).toBe(batchId);

    const envs = await envelopesOf(user);
    expect(envs.filter((e) => e.budget.period_start === targetStart)).toHaveLength(1);
    expect(await actionMessageCount(batchId)).toBe(1);
  });

  test('дубль категории во входе → INVARIANT, ни один конверт не создан (атомарность)', async () => {
    const user = freshUserId();
    const cat = await createCategory(user, 'Еда');
    const other = await createCategory(user, 'Транспорт');

    await expect(
      ownerCaller(user).budget.rollover({
        month: target,
        batchId: newId(),
        rows: [
          { categoryId: other, limit: '9000.00', carryover: '0' },
          { categoryId: cat, limit: '30000.00', carryover: '0' },
          { categoryId: cat, limit: '31000.00', carryover: '0' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
    expect(await envelopesOf(user)).toEqual([]);
  });

  test('уже существующий преемник (в т.ч. без явной currency) → INVARIANT всего batch', async () => {
    const user = freshUserId();
    const catA = await createCategory(user, 'Еда');
    const catB = await createCategory(user, 'Жильё');
    // Преемник catB создан без явной currency (NULL коалесится в defaultCurrency)
    const existing = await createEnvelope(user, catB, targetStart, targetEnd, '45000.00');

    await expect(
      ownerCaller(user).budget.rollover({
        month: target,
        batchId: newId(),
        rows: [
          { categoryId: catA, limit: '30000.00', carryover: '0' },
          { categoryId: catB, limit: '45000.00', carryover: '0' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE_CONTENT' });
    // Атомарность: не создан НИ один — даже бесконфликтный catA
    const envs = await envelopesOf(user);
    expect(envs.map((e) => e.id)).toEqual([existing]);
  });

  test('Undo сносит все конверты группы одним action; перехваченная транзакция освобождается', async () => {
    const user = freshUserId();
    const catA = await createCategory(user, 'Еда');
    const catB = await createCategory(user, 'Транспорт');
    const txnId = await createTxn(user, catA, '500.00', targetStart);

    const batchId = newId();
    const r = await ownerCaller(user).budget.rollover({
      month: target,
      batchId,
      rows: [
        { categoryId: catA, limit: '30000.00', carryover: '0' },
        { categoryId: catB, limit: '9000.00', carryover: '-1100.00' },
      ],
    });
    expect(await budgetParents(txnId)).toHaveLength(1);

    const u = await undoAction(db, { actorUserId: user, actionId: batchId });
    expect(u.ok).toBe(true);

    // Все конверты группы архивированы (§7.8: создание → архивация), привязка снята
    const envs = await envelopesOf(user);
    for (const id of r.envelopeIds) {
      expect(envs.find((e) => e.id === id)?.archived).toBe(true);
    }
    expect(await budgetParents(txnId)).toEqual([]);
  });

  test('мутация — поверхность владельца: агенту FORBIDDEN (§9.3)', async () => {
    const user = freshUserId();
    const cat = await createCategory(user, 'Еда');
    const agent = createCaller({ actorUserId: user, actorKind: 'agent', db, clientVersion: null });
    await expect(
      agent.budget.rollover({
        month: target,
        batchId: newId(),
        rows: [{ categoryId: cat, limit: '1000.00', carryover: '0' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
