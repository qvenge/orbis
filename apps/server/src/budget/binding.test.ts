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
      aspects: {
        'orbis/budget': budgetData(catC, '2026-07-01', '2026-07-31', { currency: 'RUB' }),
      },
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
      aspects: {
        'orbis/budget': budgetData(catD, '2026-07-01', '2026-07-31', { currency: 'EUR' }),
      },
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

// ---------------------------------------------------------------------------
// Шаг 2: интеграция в executor — привязка в том же action (§2.3)
// ---------------------------------------------------------------------------
describe('авто-привязка: entity_create транзакции (§2.3)', () => {
  const user = freshUserId();
  const cat = newId();
  let envId = '';

  test('1. транзакция при существующем конверте: один action, operations.length === 2; Undo откатывает обе', async () => {
    const { entity: env } = await createEntity(user, {
      title: 'Еда — июль',
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    envId = env.id;

    const { entity: txn, actionId } = await createEntity(user, {
      title: 'Обед',
      aspects: { 'orbis/financial': finData(cat, '2026-07-15') },
    });
    // relation parent (конверт → транзакция) создана тем же action
    expect(await budgetParents(txn.id)).toEqual([envId]);
    const action = await actionById(actionId);
    expect(action.operations.length).toBe(2);
    expect(action.operations.map((o) => o.op)).toEqual(['entity_create', 'relation_create']);

    // Undo откатывает целиком: relation удалена, сущность архивирована
    ok(await undoAction(db, { actorUserId: user, actionId }));
    expect(await budgetParents(txn.id)).toEqual([]);
    const rows = await adminRows(sql`SELECT archived FROM entities WHERE id = ${txn.id}`);
    expect(rows[0]?.archived).toBe(true);
  });

  test('4. транзакция без конверта — без parent (Unbudgeted), operations.length === 1', async () => {
    const { entity: txn, actionId } = await createEntity(user, {
      title: 'Без конверта',
      aspects: { 'orbis/financial': finData(newId(), '2026-07-15') },
    });
    expect(await budgetParents(txn.id)).toEqual([]);
    expect((await actionById(actionId)).operations.length).toBe(1);
  });

  test('5. planned=true привязывается так же (spent — забота A6)', async () => {
    const { entity: txn } = await createEntity(user, {
      title: 'Запланированная покупка',
      aspects: { 'orbis/financial': finData(cat, '2026-07-20', { planned: true }) },
    });
    expect(await budgetParents(txn.id)).toEqual([envId]);
  });

  test('income-транзакция привязывается тоже (§5: возврат средств)', async () => {
    const { entity: txn } = await createEntity(user, {
      title: 'Возврат',
      aspects: { 'orbis/financial': finData(cat, '2026-07-21', { direction: 'income' }) },
    });
    expect(await budgetParents(txn.id)).toEqual([envId]);
  });

  test('recurring-шаблон (без occurred_on) НЕ привязывается', async () => {
    const { entity: tpl, actionId } = await createEntity(user, {
      title: 'Подписка',
      aspects: {
        'orbis/schedule': {
          start_at: '2026-07-01T09:00:00.000Z',
          recurrence: { freq: 'monthly', interval: 1 },
        },
        'orbis/financial': {
          amount: '500.00',
          direction: 'expense',
          category_ref: cat,
          recurring: true,
        },
      },
    });
    expect(await budgetParents(tpl.id)).toEqual([]);
    expect((await actionById(actionId)).operations.length).toBe(1);
  });

  test('правка даты транзакции повторно запускает выбор конверта (delete старой + create новой)', async () => {
    const { entity: envAug } = await createEntity(user, {
      title: 'Еда — август',
      aspects: { 'orbis/budget': budgetData(cat, '2026-08-01', '2026-08-31') },
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Переносимая',
      aspects: { 'orbis/financial': finData(cat, '2026-07-10') },
    });
    expect(await budgetParents(txn.id)).toEqual([envId]);

    const upd = ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: txn.id,
          aspects: { 'orbis/financial': { occurred_on: '2026-08-10' } },
        }),
        { sink },
      ),
    );
    expect(await budgetParents(txn.id)).toEqual([envAug.id]);
    // порядок ops: сначала delete старой связи, затем create новой — в одном action
    const action = await actionById(upd.actionId);
    expect(action.operations.map((o) => o.op)).toEqual([
      'entity_update',
      'relation_delete',
      'relation_create',
    ]);
  });

  test('batch «конверт + транзакция» одним batch_execute: транзакция привязана к конверту того же batch', async () => {
    // Форма CSV-импорта/онбординга: групповая мутация — один batch_execute (01-arch §9.2)
    const userB = freshUserId();
    const catB = newId();
    const envelopeId = newId();
    const txnId = newId();
    const batchId = newId();
    const r = ok(
      await execute(
        db,
        {
          actorUserId: userB,
          actorKind: 'owner',
          source: 'chat',
          batchId,
          operations: [
            {
              tool: 'entity_create',
              input: {
                id: envelopeId,
                title: 'Конверт из batch',
                tags: [],
                aspects: { 'orbis/budget': budgetData(catB, '2026-07-01', '2026-07-31') },
              },
            },
            {
              tool: 'entity_create',
              input: {
                id: txnId,
                title: 'Транзакция из batch',
                tags: [],
                aspects: { 'orbis/financial': finData(catB, '2026-07-10') },
              },
            },
          ],
        },
        { sink },
      ),
    );
    expect(await budgetParents(txnId)).toEqual([envelopeId]);
    // results — только запрошенные операции; журнал несёт и дописанную привязку
    expect(r.results.length).toBe(2);
    const action = await actionById(batchId);
    expect(action.operations.map((o) => o.op)).toEqual([
      'entity_create',
      'entity_create',
      'relation_create',
    ]);
  });

  test('идемпотентность: повтор batch по batch_id не дублирует привязку', async () => {
    const batchId = newId();
    const txnId = newId();
    const request: ExecuteRequest = {
      actorUserId: user,
      actorKind: 'owner',
      source: 'mcp',
      batchId,
      operations: [
        {
          tool: 'entity_create',
          input: {
            id: txnId,
            title: 'Импортированная',
            tags: [],
            aspects: { 'orbis/financial': finData(cat, '2026-07-25') },
          },
        },
      ],
    };
    ok(await execute(db, request, { sink }));
    expect(await budgetParents(txnId)).toEqual([envId]);

    const replay = ok(await execute(db, request, { sink }));
    expect(replay.idempotentReplay).toBe(true);
    expect(await budgetParents(txnId)).toEqual([envId]); // ровно одна связь
  });
});

describe('ребиндинг при создании/правке/архивации конверта (§2.3)', () => {
  test('2+3. узкий конверт перехватывает у месячного; архивация узкого возвращает месячному', async () => {
    const user = freshUserId();
    const cat = newId();
    const { entity: monthly } = await createEntity(user, {
      title: 'Путешествия — август',
      aspects: { 'orbis/budget': budgetData(cat, '2026-08-01', '2026-08-31') },
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Отель',
      aspects: { 'orbis/financial': finData(cat, '2026-08-15') },
    });
    expect(await budgetParents(txn.id)).toEqual([monthly.id]);

    // (2) создание узкого конверта атомарно перехватывает транзакцию
    const { entity: narrow, actionId: narrowAction } = await createEntity(user, {
      title: 'Отпуск в Грузии',
      aspects: { 'orbis/budget': budgetData(cat, '2026-08-10', '2026-08-24') },
    });
    expect(await budgetParents(txn.id)).toEqual([narrow.id]);
    const action = await actionById(narrowAction);
    expect(action.operations.map((o) => o.op)).toEqual([
      'entity_create',
      'relation_delete',
      'relation_create',
    ]);

    // (3) архивация узкого возвращает транзакцию месячному
    ok(await execute(db, req(user, 'entity_update', { id: narrow.id, archived: true }), { sink }));
    expect(await budgetParents(txn.id)).toEqual([monthly.id]);
  });

  test('правка периода конверта: окно затронутых = старый ∪ новый период', async () => {
    const user = freshUserId();
    const cat = newId();
    const { entity: env } = await createEntity(user, {
      title: 'Плавающий',
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    const { entity: julyTxn } = await createEntity(user, {
      title: 'Июльская',
      aspects: { 'orbis/financial': finData(cat, '2026-07-10') },
    });
    const { entity: augTxn } = await createEntity(user, {
      title: 'Августовская',
      aspects: { 'orbis/financial': finData(cat, '2026-08-10') },
    });
    expect(await budgetParents(julyTxn.id)).toEqual([env.id]);
    expect(await budgetParents(augTxn.id)).toEqual([]); // Unbudgeted

    // Период сдвинут на август: июльская уходит в Unbudgeted, августовская привязывается
    ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: env.id,
          aspects: {
            'orbis/budget': { period_start: '2026-08-01', period_end: '2026-08-31' },
          },
        }),
        { sink },
      ),
    );
    expect(await budgetParents(julyTxn.id)).toEqual([]);
    expect(await budgetParents(augTxn.id)).toEqual([env.id]);
  });

  test('уникальность и ребиндинг вместе: повторное создание архивированной комбинации подхватывает транзакции', async () => {
    const user = freshUserId();
    const cat = newId();
    const { entity: env } = await createEntity(user, {
      title: 'Первый',
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Кофе',
      aspects: { 'orbis/financial': finData(cat, '2026-07-05') },
    });
    expect(await budgetParents(txn.id)).toEqual([env.id]);

    // архивация освобождает комбинацию (§2.1: уникальность среди неархивных)
    ok(await execute(db, req(user, 'entity_update', { id: env.id, archived: true }), { sink }));
    expect(await budgetParents(txn.id)).toEqual([]);

    const { entity: env2 } = await createEntity(user, {
      title: 'Второй',
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    expect(await budgetParents(txn.id)).toEqual([env2.id]);
  });

  test('6. приёмка 03-budget §7.3: порядок создания конвертов не влияет на итог', async () => {
    // Вариант А: транзакция → месячный → узкий
    const userA = freshUserId();
    const catA = newId();
    const { entity: txnA } = await createEntity(userA, {
      title: 'Ужин в отпуске',
      aspects: { 'orbis/financial': finData(catA, '2026-08-15') },
    });
    const { entity: monthlyA } = await createEntity(userA, {
      title: 'Месячный',
      aspects: { 'orbis/budget': budgetData(catA, '2026-08-01', '2026-08-31') },
    });
    const { entity: narrowA } = await createEntity(userA, {
      title: 'Отпускной',
      aspects: { 'orbis/budget': budgetData(catA, '2026-08-10', '2026-08-24') },
    });

    // Вариант Б: транзакция → узкий → месячный
    const userB = freshUserId();
    const catB = newId();
    const { entity: txnB } = await createEntity(userB, {
      title: 'Ужин в отпуске',
      aspects: { 'orbis/financial': finData(catB, '2026-08-15') },
    });
    const { entity: narrowB } = await createEntity(userB, {
      title: 'Отпускной',
      aspects: { 'orbis/budget': budgetData(catB, '2026-08-10', '2026-08-24') },
    });
    const { entity: monthlyB } = await createEntity(userB, {
      title: 'Месячный',
      aspects: { 'orbis/budget': budgetData(catB, '2026-08-01', '2026-08-31') },
    });

    // Итог зависит только от текущего набора конвертов: узкий, ровно один parent
    expect(await budgetParents(txnA.id)).toEqual([narrowA.id]);
    expect(await budgetParents(txnB.id)).toEqual([narrowB.id]);
    expect(monthlyA.id).not.toBe(narrowA.id);
    expect(monthlyB.id).not.toBe(narrowB.id);
  });
});

// ---------------------------------------------------------------------------
// Шаг 4: уникальность конверта (03-budget §2.1)
// ---------------------------------------------------------------------------
describe('уникальность конверта: (category_ref, currency, period_start, period_end) среди неархивных (§2.1)', () => {
  const user = freshUserId();
  const cat = newId();

  test('повторный create той же точной комбинации → INVARIANT duplicate_envelope', async () => {
    await createEntity(user, {
      title: 'Оригинал',
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    const r = err(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Дубль',
          tags: [],
          aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
        }),
        { sink },
      ),
    );
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('duplicate_envelope');
  });

  test('другая комбинация (иной период / иная явная currency) — разрешена', async () => {
    ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Другой период',
          tags: [],
          aspects: { 'orbis/budget': budgetData(cat, '2026-08-01', '2026-08-31') },
        }),
        { sink },
      ),
    );
    // «точная комбинация»: currency NULL и явная 'EUR' — разные комбинации
    ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'EUR-вариант',
          tags: [],
          aspects: {
            'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31', { currency: 'EUR' }),
          },
        }),
        { sink },
      ),
    );
  });

  test('attach-путь: дубль комбинации → INVARIANT; update-путь: перевод в занятую комбинацию → INVARIANT', async () => {
    const { entity: x } = await createEntity(user, { title: 'Кандидат в конверты' });
    const ra = err(
      await execute(
        db,
        req(user, 'attach_orbis_budget', {
          entity_id: x.id,
          data: budgetData(cat, '2026-07-01', '2026-07-31'),
        }),
        { sink },
      ),
    );
    expect(ra.error.code).toBe('INVARIANT');
    expect(invariantOf(ra)).toBe('duplicate_envelope');

    // сущность с бюджетом на свободной комбинации → update в занятую отклоняется
    const { entity: sept } = await createEntity(user, {
      title: 'Сентябрь',
      aspects: { 'orbis/budget': budgetData(cat, '2026-09-01', '2026-09-30') },
    });
    const ru = err(
      await execute(
        db,
        req(user, 'entity_update', {
          id: sept.id,
          aspects: {
            'orbis/budget': { period_start: '2026-07-01', period_end: '2026-07-31' },
          },
        }),
        { sink },
      ),
    );
    expect(ru.error.code).toBe('INVARIANT');
    expect(invariantOf(ru)).toBe('duplicate_envelope');
    // самообновление НЕ конфликтует с собственной строкой (id исключается)
    ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: sept.id,
          aspects: { 'orbis/budget': { limit: '999.00' } },
        }),
        { sink },
      ),
    );
  });

  test('batch: два create одной комбинации в одном batch → INVARIANT до первой записи', async () => {
    const catB = newId();
    const sinkEntriesBefore = await adminRows(
      sql`SELECT count(*)::int AS n FROM entities WHERE owner_id = ${user}`,
    );
    const r = err(
      await execute(
        db,
        {
          actorUserId: user,
          actorKind: 'owner',
          source: 'chat',
          batchId: newId(),
          operations: [
            {
              tool: 'entity_create',
              input: {
                title: 'Первый в batch',
                tags: [],
                aspects: { 'orbis/budget': budgetData(catB, '2026-07-01', '2026-07-31') },
              },
            },
            {
              tool: 'entity_create',
              input: {
                title: 'Дубль в batch',
                tags: [],
                aspects: { 'orbis/budget': budgetData(catB, '2026-07-01', '2026-07-31') },
              },
            },
          ],
        },
        { sink },
      ),
    );
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('duplicate_envelope');
    // откат целиком: ни одной новой сущности
    const after = await adminRows(
      sql`SELECT count(*)::int AS n FROM entities WHERE owner_id = ${user}`,
    );
    expect(after[0]?.n).toBe(sinkEntriesBefore[0]?.n);
  });
});
