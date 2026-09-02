// apps/server/src/budget/binding.test.ts
// Интеграционные тесты Task A4 (03-budget §2.3, §2.1): селектор конверта с byte-точным
// tie-break, авто-привязка транзакции внутри того же action, ребиндинг при
// создании/правке/архивации конверта, уникальность конверта. Реальная БД под
// withIdentity (RLS enforced), без моков.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  entityColumns,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  seedRefTargetRows,
  truncateAll,
} from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
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

/** Конверт (orbis/budget) СВОЙСТВАМИ: произвольный период, limit фиксированный. */
function budgetProps(
  categoryRef: string,
  periodStart: string,
  periodEnd: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    'orbis/finance_category': categoryRef,
    'orbis/limit': '30000.00',
    'orbis/period_start': periodStart,
    'orbis/period_end': periodEnd,
    ...over,
  };
}

/** Транзакция (orbis/financial) СВОЙСТВАМИ. */
function finProps(
  categoryRef: string,
  occurredOn: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    'orbis/amount': '340.00',
    'orbis/direction': 'expense',
    'orbis/finance_category': categoryRef,
    'orbis/occurred_on': occurredOn,
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

/** Живые привязки транзакции к конвертам — истина в БД (админ-DSN, обходит RLS). */
async function budgetParents(txnId: string): Promise<string[]> {
  const rows = await adminRows(
    sql`SELECT r.source_id FROM relations r
        WHERE r.target_id = ${txnId} AND r.role = 'envelope-binding'
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
      props: budgetProps(cat, '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
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
      props: budgetProps(cat, '2026-07-10', '2026-07-20'),
      aspects: ['orbis/budget'],
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
      props: budgetProps(catB, '2026-07-01', '2026-07-10'),
      aspects: ['orbis/budget'],
    });
    const { entity: later } = await createEntity(user, {
      title: 'B',
      props: budgetProps(catB, '2026-07-05', '2026-07-14'),
      aspects: ['orbis/budget'],
    });
    const picked = await selector(user, {
      categoryRef: catB,
      currency: 'RUB',
      occurredOn: '2026-07-07',
    });
    expect(picked).toBe(later.id);
  });

  test('равная длина и равный старт (разные currency-формы) → меньший UUID', async () => {
    // Полное равенство комбинаций невозможно (уникальность §2.1), а нормализация
    // NULL→defaultCurrency (бэклог A7) закрыла и NULL-путь через executor. Пара
    // «legacy-конверт без currency + конверт с явной RUB» возможна только для строк,
    // записанных ДО нормализации, — сеем legacy-строку админ-DSN напрямую (мимо
    // executor'а): для RUB-транзакции оба кандидаты, решает третий ключ — меньший UUID.
    const catC = newId();
    const idSmall = '11111111-1111-4111-8111-111111111111';
    const idBig = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await createEntity(user, {
      id: idBig,
      title: 'явная RUB',
      props: budgetProps(catC, '2026-07-01', '2026-07-31', { 'orbis/currency': 'RUB' }),
      aspects: ['orbis/budget'],
    });
    // Прямая вставка мимо исполнителя (в этом и смысл: строка «как из прошлого», без
    // currency). Через drizzle, а не сырым SQL: строка обязана лечь во ВСЕ три колонки
    // формы (§А1-1), а имя `aspects` теперь занято списком аспектов.
    await withIdentity(db, user, async (tx) =>
      tx.insert(entities).values({
        id: idSmall,
        ownerId: user,
        title: 'legacy без currency (дефолт RUB)',
        ...(await entityColumns(tx, user, budgetProps(catC, '2026-07-01', '2026-07-31'), [
          'orbis/budget',
        ])),
      }),
    );
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
      props: budgetProps(catD, '2026-07-01', '2026-07-31', { 'orbis/currency': 'EUR' }),
      aspects: ['orbis/budget'],
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
      props: budgetProps(catE, '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
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
      props: budgetProps(catF, '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
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
      props: budgetProps(cat, '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
    });
    envId = env.id;

    const { entity: txn, actionId } = await createEntity(user, {
      title: 'Обед',
      props: finProps(cat, '2026-07-15'),
      aspects: ['orbis/financial'],
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
      props: finProps(newId(), '2026-07-15'),
      aspects: ['orbis/financial'],
    });
    expect(await budgetParents(txn.id)).toEqual([]);
    expect((await actionById(actionId)).operations.length).toBe(1);
  });

  test('5. planned=true привязывается так же (spent — забота A6)', async () => {
    const { entity: txn } = await createEntity(user, {
      title: 'Запланированная покупка',
      props: finProps(cat, '2026-07-20', { 'orbis/planned': true }),
      aspects: ['orbis/financial'],
    });
    expect(await budgetParents(txn.id)).toEqual([envId]);
  });

  test('income-транзакция привязывается тоже (§5: возврат средств)', async () => {
    const { entity: txn } = await createEntity(user, {
      title: 'Возврат',
      props: finProps(cat, '2026-07-21', { 'orbis/direction': 'income' }),
      aspects: ['orbis/financial'],
    });
    expect(await budgetParents(txn.id)).toEqual([envId]);
  });

  test('recurring-шаблон (без occurred_on) НЕ привязывается', async () => {
    const { entity: tpl, actionId } = await createEntity(user, {
      title: 'Подписка',
      props: {
        'orbis/start_at': '2026-07-01T09:00:00.000Z',
        'orbis/recurrence': { freq: 'monthly', interval: 1 },
        'orbis/amount': '500.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': cat,
        'orbis/recurring': true,
      },
      aspects: ['orbis/schedule', 'orbis/financial'],
    });
    expect(await budgetParents(tpl.id)).toEqual([]);
    expect((await actionById(actionId)).operations.length).toBe(1);
  });

  test('правка даты транзакции повторно запускает выбор конверта (delete старой + create новой)', async () => {
    const { entity: envAug } = await createEntity(user, {
      title: 'Еда — август',
      props: budgetProps(cat, '2026-08-01', '2026-08-31'),
      aspects: ['orbis/budget'],
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Переносимая',
      props: finProps(cat, '2026-07-10'),
      aspects: ['orbis/financial'],
    });
    expect(await budgetParents(txn.id)).toEqual([envId]);

    const upd = ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: txn.id,
          props: { 'orbis/occurred_on': '2026-08-10' },
          aspects: { attach: ['orbis/financial'] },
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
                props: budgetProps(catB, '2026-07-01', '2026-07-31'),
                aspects: ['orbis/budget'],
              },
            },
            {
              tool: 'entity_create',
              input: {
                id: txnId,
                title: 'Транзакция из batch',
                tags: [],
                props: finProps(catB, '2026-07-10'),
                aspects: ['orbis/financial'],
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
            props: finProps(cat, '2026-07-25'),
            aspects: ['orbis/financial'],
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
      props: budgetProps(cat, '2026-08-01', '2026-08-31'),
      aspects: ['orbis/budget'],
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Отель',
      props: finProps(cat, '2026-08-15'),
      aspects: ['orbis/financial'],
    });
    expect(await budgetParents(txn.id)).toEqual([monthly.id]);

    // (2) создание узкого конверта атомарно перехватывает транзакцию
    const { entity: narrow, actionId: narrowAction } = await createEntity(user, {
      title: 'Отпуск в Грузии',
      props: budgetProps(cat, '2026-08-10', '2026-08-24'),
      aspects: ['orbis/budget'],
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
      props: budgetProps(cat, '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
    });
    const { entity: julyTxn } = await createEntity(user, {
      title: 'Июльская',
      props: finProps(cat, '2026-07-10'),
      aspects: ['orbis/financial'],
    });
    const { entity: augTxn } = await createEntity(user, {
      title: 'Августовская',
      props: finProps(cat, '2026-08-10'),
      aspects: ['orbis/financial'],
    });
    expect(await budgetParents(julyTxn.id)).toEqual([env.id]);
    expect(await budgetParents(augTxn.id)).toEqual([]); // Unbudgeted

    // Период сдвинут на август: июльская уходит в Unbudgeted, августовская привязывается
    ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: env.id,
          props: { 'orbis/period_start': '2026-08-01', 'orbis/period_end': '2026-08-31' },
          aspects: { attach: ['orbis/budget'] },
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
      props: budgetProps(cat, '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Кофе',
      props: finProps(cat, '2026-07-05'),
      aspects: ['orbis/financial'],
    });
    expect(await budgetParents(txn.id)).toEqual([env.id]);

    // архивация освобождает комбинацию (§2.1: уникальность среди неархивных)
    ok(await execute(db, req(user, 'entity_update', { id: env.id, archived: true }), { sink }));
    expect(await budgetParents(txn.id)).toEqual([]);

    const { entity: env2 } = await createEntity(user, {
      title: 'Второй',
      props: budgetProps(cat, '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
    });
    expect(await budgetParents(txn.id)).toEqual([env2.id]);
  });

  test('6. приёмка 03-budget §7.3: порядок создания конвертов не влияет на итог', async () => {
    // Вариант А: транзакция → месячный → узкий
    const userA = freshUserId();
    const catA = newId();
    const { entity: txnA } = await createEntity(userA, {
      title: 'Ужин в отпуске',
      props: finProps(catA, '2026-08-15'),
      aspects: ['orbis/financial'],
    });
    const { entity: monthlyA } = await createEntity(userA, {
      title: 'Месячный',
      props: budgetProps(catA, '2026-08-01', '2026-08-31'),
      aspects: ['orbis/budget'],
    });
    const { entity: narrowA } = await createEntity(userA, {
      title: 'Отпускной',
      props: budgetProps(catA, '2026-08-10', '2026-08-24'),
      aspects: ['orbis/budget'],
    });

    // Вариант Б: транзакция → узкий → месячный
    const userB = freshUserId();
    const catB = newId();
    const { entity: txnB } = await createEntity(userB, {
      title: 'Ужин в отпуске',
      props: finProps(catB, '2026-08-15'),
      aspects: ['orbis/financial'],
    });
    const { entity: narrowB } = await createEntity(userB, {
      title: 'Отпускной',
      props: budgetProps(catB, '2026-08-10', '2026-08-24'),
      aspects: ['orbis/budget'],
    });
    const { entity: monthlyB } = await createEntity(userB, {
      title: 'Месячный',
      props: budgetProps(catB, '2026-08-01', '2026-08-31'),
      aspects: ['orbis/budget'],
    });

    // Итог зависит только от текущего набора конвертов: узкий, ровно один parent
    expect(await budgetParents(txnA.id)).toEqual([narrowA.id]);
    expect(await budgetParents(txnB.id)).toEqual([narrowB.id]);
    expect(monthlyA.id).not.toBe(narrowA.id);
    expect(monthlyB.id).not.toBe(narrowB.id);

    // Приёмка §7.3, вторая половина: «после его архивации АТОМАРНО возвращается
    // месячному» — тоже В ОБОИХ вариантах порядка. Атомарность: снятие старой связи и
    // создание новой лежат в ОДНОМ action архивации, а не в двух последовательных.
    const archiveA = ok(
      await execute(db, req(userA, 'entity_update', { id: narrowA.id, archived: true }), { sink }),
    );
    expect(await budgetParents(txnA.id)).toEqual([monthlyA.id]);
    expect((await actionById(archiveA.actionId)).operations.map((o) => o.op)).toEqual([
      'entity_update',
      'relation_delete',
      'relation_create',
    ]);

    const archiveB = ok(
      await execute(db, req(userB, 'entity_update', { id: narrowB.id, archived: true }), { sink }),
    );
    expect(await budgetParents(txnB.id)).toEqual([monthlyB.id]);
    expect((await actionById(archiveB.actionId)).operations.map((o) => o.op)).toEqual([
      'entity_update',
      'relation_delete',
      'relation_create',
    ]);
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
      props: budgetProps(cat, '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
    });
    const r = err(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Дубль',
          tags: [],
          props: budgetProps(cat, '2026-07-01', '2026-07-31'),
          aspects: ['orbis/budget'],
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
          props: budgetProps(cat, '2026-08-01', '2026-08-31'),
          aspects: ['orbis/budget'],
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
          props: budgetProps(cat, '2026-07-01', '2026-07-31', {
            'orbis/currency': 'EUR',
          }),
          aspects: ['orbis/budget'],
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
          data: budgetProps(cat, '2026-07-01', '2026-07-31'),
        }),
        { sink },
      ),
    );
    expect(ra.error.code).toBe('INVARIANT');
    expect(invariantOf(ra)).toBe('duplicate_envelope');

    // сущность с бюджетом на свободной комбинации → update в занятую отклоняется
    const { entity: sept } = await createEntity(user, {
      title: 'Сентябрь',
      props: budgetProps(cat, '2026-09-01', '2026-09-30'),
      aspects: ['orbis/budget'],
    });
    const ru = err(
      await execute(
        db,
        req(user, 'entity_update', {
          id: sept.id,
          props: { 'orbis/period_start': '2026-07-01', 'orbis/period_end': '2026-07-31' },
          aspects: { attach: ['orbis/budget'] },
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
          props: { 'orbis/limit': '999.00' },
          aspects: { attach: ['orbis/budget'] },
        }),
        { sink },
      ),
    );
  });

  test('batch: два create одной комбинации в одном batch → INVARIANT до первой записи', async () => {
    const catB = newId();
    // Категория заводится ДО снимка счётчика: обстановка ссылки (§А6-1) не должна попасть
    // в разницу «до/после», которой тест меряет откат batch.
    await seedRefTargetRows(user, [{ id: catB, aspect: 'orbis/category' }]);
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
                props: budgetProps(catB, '2026-07-01', '2026-07-31'),
                aspects: ['orbis/budget'],
              },
            },
            {
              tool: 'entity_create',
              input: {
                title: 'Дубль в batch',
                tags: [],
                props: budgetProps(catB, '2026-07-01', '2026-07-31'),
                aspects: ['orbis/budget'],
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

// ---------------------------------------------------------------------------
// Конверсия транзакции в recurring-шаблон и обратно (финальное ревью фазы A):
// шаблон — не операция (§3.1), существующая привязка обязана сняться тем же action,
// иначе spent конверта считал бы шаблон вместе с его инстансами (двойной счёт).
// ---------------------------------------------------------------------------
describe('конверсия транзакции в recurring-шаблон снимает привязку (§2.3, §3.1)', () => {
  const user = freshUserId();
  const cat = newId();
  let envId = '';
  let txnId = '';

  test('attach orbis/schedule.recurrence на привязанную факт-транзакцию → budget-parent снят тем же action', async () => {
    const { entity: env } = await createEntity(user, {
      title: 'Подписки — июль',
      props: budgetProps(cat, '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
    });
    envId = env.id;
    const { entity: txn } = await createEntity(user, {
      title: 'Оплата сервиса',
      props: finProps(cat, '2026-07-05'),
      aspects: ['orbis/financial'],
    });
    txnId = txn.id;
    expect(await budgetParents(txnId)).toEqual([envId]);

    const r = ok(
      await execute(
        db,
        req(user, 'attach_orbis_schedule', {
          entity_id: txnId,
          data: {
            'orbis/start_at': '2026-07-05T09:00:00.000Z',
            'orbis/recurrence': { freq: 'monthly', interval: 1 },
          },
        }),
        { sink },
      ),
    );
    expect(await budgetParents(txnId)).toEqual([]);
    // снятие привязки — в том же action (Undo откатывает конверсию целиком)
    const action = await actionById(r.actionId);
    expect(action.operations.map((o) => o.op)).toEqual([
      'attach_orbis_schedule',
      'relation_delete',
    ]);
  });

  test('обратная конверсия: detach orbis/schedule возвращает привязку', async () => {
    ok(
      await execute(
        db,
        req(user, 'entity_update', { id: txnId, aspects: { detach: ['orbis/schedule'] } }),
        { sink },
      ),
    );
    expect(await budgetParents(txnId)).toEqual([envId]);
  });
});

// ---------------------------------------------------------------------------
// Detach orbis/financial (уборочная фаза, E8): сущность перестала быть транзакцией —
// привязка к конверту обязана сняться тем же action. Зеркало конверсии в шаблон выше:
// там (а)-ветка хука отвязывает через bindingTargetOf → fin:null, а при detach аспекта
// её условие «в итоговых аспектах есть financial» не выполняется вовсе.
// ---------------------------------------------------------------------------
describe('detach orbis/financial снимает привязку к конверту (§2.3)', () => {
  const user = freshUserId();
  const cat = newId();

  test('detach → budget-parent снят тем же action', async () => {
    const { entity: env } = await createEntity(user, {
      title: 'Еда — июль',
      props: budgetProps(cat, '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Ошибочная запись',
      props: finProps(cat, '2026-07-06'),
      aspects: ['orbis/financial'],
    });
    expect(await budgetParents(txn.id)).toEqual([env.id]);

    const r = ok(
      await execute(
        db,
        req(user, 'entity_update', { id: txn.id, aspects: { detach: ['orbis/financial'] } }),
        { sink },
      ),
    );
    expect(await budgetParents(txn.id)).toEqual([]);
    // Снятие — в том же action: Undo возвращает и аспект, и связь одной отменой
    const action = await actionById(r.actionId);
    expect(action.operations.map((o) => o.op)).toEqual(['entity_update', 'relation_delete']);
  });

  test('undo detach ВОЗВРАЩАЕТ системное ребро: откат не упирается в ROLE_SYSTEM_ONLY', async () => {
    // Пин исключения `!ctx.undoReplay` у гейта `created_by: 'system'` (`executor/relations.ts`).
    // `envelope-binding` ставит хук, а откат проигрывает свой же inverse ЧЕРЕЗ `execute` БЕЗ
    // `mechanism` (`executor/undo.ts` → механизм `user`): без исключения восстановление
    // системного ребра падало бы `ROLE_SYSTEM_ONLY`, и законную запись владельца нельзя было
    // бы отменить. До этой пробы исключение не держал ни один из 88 тестов области.
    const { entity: env } = await createEntity(user, {
      title: 'Транспорт — август',
      props: budgetProps(cat, '2026-08-01', '2026-08-31'),
      aspects: ['orbis/budget'],
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Такси',
      props: finProps(cat, '2026-08-07'),
      aspects: ['orbis/financial'],
    });
    expect(await budgetParents(txn.id)).toEqual([env.id]);

    const detached = ok(
      await execute(
        db,
        req(user, 'entity_update', { id: txn.id, aspects: { detach: ['orbis/financial'] } }),
        { sink },
      ),
    );
    expect(await budgetParents(txn.id)).toEqual([]);

    const undone = await undoAction(db, { actorUserId: user, actionId: detached.actionId });
    // Отказ был бы ROLE_SYSTEM_ONLY — называем его, чтобы красный говорил, что именно сломано.
    expect(undone.ok ? 'ok' : undone.error.code).toBe('ok');
    expect(await budgetParents(txn.id)).toEqual([env.id]);
  });

  test('detach у НЕпривязанной сущности лишних операций не порождает', async () => {
    const { entity: note } = await createEntity(user, {
      title: 'Заметка',
      props: { 'orbis/content_type': 'plain' },
      aspects: ['orbis/note'],
    });
    const r = ok(
      await execute(
        db,
        req(user, 'entity_update', { id: note.id, aspects: { detach: ['orbis/note'] } }),
        { sink },
      ),
    );
    const action = await actionById(r.actionId);
    expect(action.operations.map((o) => o.op)).toEqual(['entity_update']);
  });
});

// ---------------------------------------------------------------------------
// Write-skew привязки (уборочная фаза, E9; Important бэклога фазы A): конкурентные
// «create транзакции ∥ create конверта» шли без общего замка — селектор §2.3 одной
// транзакции не видел незакоммиченный конверт другой, и запись оставалась Unbudgeted,
// хотя конверт «уже есть». Замок владельца общий с проверкой уникальности конвертов:
// оба инварианта про один и тот же набор строк.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Хук трогает ТОЛЬКО СВОЮ роль (§2.3)
// ---------------------------------------------------------------------------
describe('хук привязки трогает только роль envelope-binding', () => {
  /**
   * ДВЕ ПОЛОВИНЫ ПРЕДИКАТА «конверт-родитель» ПИНЯТСЯ ПО ОТДЕЛЬНОСТИ, и это не педантизм.
   *
   * `budgetParentsOfMany` (`binding.ts`) отбирает рёбра конъюнкцией: РОЛЬ
   * (`r.role = 'envelope-binding'`) И АСПЕКТ ИСТОЧНИКА (`'orbis/budget' = ANY(e.aspects)`).
   * Проба, где источник — сущность без аспектов, наблюдает только вторую половину: расширь
   * кто-нибудь роли обратно до `role IN (…)`, ребро всё равно отсеется аспектом, и тест
   * останется зелёным. Ровно это и намерил гейт на первой редакции этого сьюта.
   *
   * Поэтому источник ниже — КОНВЕРТ (с `orbis/budget`), а ребро — роли `subitem`. Тогда
   * аспектная половина предиката пропускает его, и отделяет привязку от не-привязки ТОЛЬКО
   * роль: расширение ролей делает чужое ребро «конверт-родителем», и хук снимает его при
   * первой же правке суммы — тихая потеря связи, которую владелец поставил руками.
   */
  test('ребро `subitem` ОТ ВТОРОГО КОНВЕРТА переживает ребиндинг: отделяет его только роль', async () => {
    const user = freshUserId();
    const cat = newId();
    const { entity: env } = await createEntity(user, {
      title: 'Конверт Ремонт',
      props: budgetProps(cat, '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Краска',
      props: finProps(cat, '2026-07-12'),
      aspects: ['orbis/financial'],
    });
    // ВТОРОЙ КОНВЕРТ — другой категории, чтобы селектор §2.3 не выбрал его сам: связь с
    // транзакцией у него появится только руками владельца и только ролью `subitem`.
    const { entity: other } = await createEntity(user, {
      title: 'Второй конверт (чужая категория)',
      props: budgetProps(newId(), '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
    });
    ok(
      await execute(
        db,
        req(user, 'relation_create', {
          source_id: other.id,
          target_id: txn.id,
          role: 'subitem',
        }),
        { sink },
      ),
    );
    // Привязку поставил хук при создании транзакции; ребро второго конверта — рядом и своей
    // ролью. Аспект `orbis/budget` есть у ОБОИХ источников — значит различает их роль.
    expect(await budgetParents(txn.id)).toEqual([env.id]);

    // Правка суммы гоняет хук: он обязан выйти в no-op и ничьих рёбер не тронуть.
    ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: txn.id,
          props: { 'orbis/amount': '777.00' },
          aspects: { attach: ['orbis/financial'] },
        }),
        { sink },
      ),
    );
    expect(await budgetParents(txn.id)).toEqual([env.id]);
    const own = await adminRows(
      sql`SELECT role FROM relations WHERE source_id = ${other.id} AND target_id = ${txn.id}`,
    );
    expect(own.map((r) => r.role as string)).toEqual(['subitem']);
  });

  test('ребро роли ПРИВЯЗКИ от НЕ-конверта родителем не делает: вторую половину держит аспект', async () => {
    // Зеркальная половина той же конъюнкции: источник без `orbis/budget` отсеивается
    // аспектным фильтром НЕЗАВИСИМО от роли. Обе пробы вместе означают «предикат —
    // конъюнкция», и мутация КАЖДОЙ половины по отдельности красит свой тест.
    //
    // Транзакция здесь категории, у которой конверта НЕТ: иначе хук привязал бы её сам, и
    // `target_max_incoming: 1` не дал бы поставить второе ребро той же роли — проба
    // уперлась бы в ограничение реестра, не дойдя до предиката.
    const user = freshUserId();
    const { entity: txn } = await createEntity(user, {
      title: 'Трата без конверта',
      props: finProps(newId(), '2026-08-12'),
      aspects: ['orbis/financial'],
    });

    // Роль `envelope-binding` системная (`created_by: 'system'`) — владелец её не ставит,
    // поэтому механизм у операции системный, как у самого хука.
    const { entity: project } = await createEntity(user, { title: 'Проект без бюджета' });
    ok(
      await execute(
        db,
        req(
          user,
          'relation_create',
          { source_id: project.id, target_id: txn.id, role: 'envelope-binding' },
          { source: 'system', mechanism: 'seed' },
        ),
        { sink },
      ),
    );
    // НАБЛЮДАЕМОЕ — ВЫЖИВАНИЕ РЕБРА, а не счёт родителей: помощник `budgetParents` выше
    // читает рёбра по одной РОЛИ и аспектной половины предиката не воспроизводит (он про
    // «что лежит в БД», а не «что считает хук»). Аспектная половина видна иначе: считай
    // хук этот источник конвертом-родителем, он снял бы его ребро как устаревшую привязку
    // (транзакция ни к какому конверту не относится — селектор её конверта не находит).
    ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: txn.id,
          props: { 'orbis/amount': '555.00' },
          aspects: { attach: ['orbis/financial'] },
        }),
        { sink },
      ),
    );
    const own = await adminRows(
      sql`SELECT role FROM relations WHERE source_id = ${project.id} AND target_id = ${txn.id}`,
    );
    expect(own.map((r) => r.role as string)).toEqual(['envelope-binding']);
  });
});

describe('гонка «create транзакции ∥ create конверта» (§2.3)', () => {
  test('после обеих операций транзакция привязана к конверту, а не Unbudgeted', async () => {
    const user = freshUserId();
    const iterations = 15;
    let unbudgeted = 0;
    for (let i = 0; i < iterations; i += 1) {
      // Своя категория и свой период на итерацию: конверты не конфликтуют между собой,
      // а «сегодня» тестом не подменяется — даты задаём явно.
      const cat = newId();
      const day = `2026-08-${String((i % 27) + 1).padStart(2, '0')}`;
      const txnId = newId();
      const [, envRes] = await Promise.all([
        execute(
          db,
          req(user, 'entity_create', {
            id: txnId,
            title: `Покупка ${i}`,
            tags: [],
            props: finProps(cat, day),
            aspects: ['orbis/financial'],
          }),
          { sink },
        ),
        execute(
          db,
          req(user, 'entity_create', {
            title: `Конверт ${i}`,
            tags: [],
            props: budgetProps(cat, '2026-08-01', '2026-08-31'),
            aspects: ['orbis/budget'],
          }),
          { sink },
        ),
      ]);
      const envId = (ok(envRes).results[0] as WireEntity).id;
      if (!(await budgetParents(txnId)).includes(envId)) unbudgeted += 1;
    }
    expect(unbudgeted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Порядок захвата замков (фикс-раунд уборочной фазы): «advisory → строки» на ОБОИХ
// путях. Пока замок бюджет-контура брался внутри applyBudgetFollowUps, правка транзакции
// держала FOR UPDATE своей строки и ЖДАЛА advisory, а создание конверта держало advisory
// (assertEnvelopeUnique на prepare) и ждало строки — цикл ожидания, который PostgreSQL
// разрывает отказом одной из транзакций по дедлоку.
// ---------------------------------------------------------------------------
describe('дедлок «правка транзакции ∥ запись конверта» (§2.3)', () => {
  test('20 конкурентных пар операций проходят без отказов по дедлоку', async () => {
    const user = freshUserId();
    const failures: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      // Своя категория на итерацию: конверты не конфликтуют между собой по §2.1
      const cat = newId();
      const day = `2026-09-${String((i % 27) + 1).padStart(2, '0')}`;
      const { entity: txn } = await createEntity(user, {
        title: `Покупка ${i}`,
        props: finProps(cat, day),
        aspects: ['orbis/financial'],
      });
      const [upd, env] = await Promise.all([
        // правка транзакции: FOR UPDATE строки → бюджет-хук
        execute(
          db,
          req(user, 'entity_update', {
            id: txn.id,
            props: finProps(cat, day, { 'orbis/amount': '999.00' }),
            aspects: { attach: ['orbis/financial'] },
          }),
          { sink },
        ),
        // запись конверта: advisory на prepare → строки на ребиндинге
        execute(
          db,
          req(user, 'entity_create', {
            title: `Конверт ${i}`,
            tags: [],
            props: budgetProps(cat, '2026-09-01', '2026-09-30'),
            aspects: ['orbis/budget'],
          }),
          { sink },
        ),
      ]);
      for (const r of [upd, env]) {
        if (!r.ok) failures.push(`${r.error.code}: ${r.error.message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Запись, которая одновременно транзакция и конверт (шов реформы)
// ---------------------------------------------------------------------------
//
// До реформы такое совпадение требовало ручного попадания категорией. С §А1-1 категория и
// валюта у транзакции и конверта — ОДНО свойство (В1), поэтому `attach_orbis_budget` на
// транзакции с подходящим периодом попадает в себя ДЕТЕРМИНИРОВАННО: селектор выбирает
// конвертом саму запись, а ребро в себя запрещено (`rel_no_self`). Владелец получал
// `INVARIANT self_relation` — отказ, по которому понять нечего.
describe('транзакция, ставшая конвертом: селектор не выбирает саму запись (§2.3)', () => {
  test('attach orbis/budget на транзакцию с накрывающим периодом проходит, а не падает self_relation', async () => {
    const user = freshUserId();
    const cat = newId();
    const { entity: txn } = await createEntity(user, {
      title: 'Транзакция, ставшая конвертом',
      props: finProps(cat, '2026-07-12'),
      aspects: ['orbis/financial'],
    });
    // Период накрывает occurred_on самой записи; категория и валюта совпадают по построению
    const r = ok(
      await execute(
        db,
        req(user, 'attach_orbis_budget', {
          entity_id: txn.id,
          data: budgetProps(cat, '2026-07-01', '2026-07-31'),
        }),
        { sink },
      ),
    );
    expect((r.results[0] as WireEntity).aspects).toContain('orbis/budget');
    // Сама себе конвертом запись не стала
    expect(await budgetParents(txn.id)).toEqual([]);
  });

  test('исключение себя не выбрасывает транзакцию из ЧУЖОГО конверта: она остаётся привязанной', async () => {
    const user = freshUserId();
    const cat = newId();
    // Широкий конверт месяца — он и должен считать транзакцию
    const { entity: wide } = await createEntity(user, {
      title: 'Конверт месяца',
      props: budgetProps(cat, '2026-07-01', '2026-07-31'),
      aspects: ['orbis/budget'],
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Транзакция в конверте месяца',
      props: finProps(cat, '2026-07-12'),
      aspects: ['orbis/financial'],
    });
    expect(await budgetParents(txn.id)).toEqual([wide.id]);

    // Запись помечают конвертом БОЛЕЕ УЗКОГО периода: по tie-break §2.3 победила бы она сама
    ok(
      await execute(
        db,
        req(user, 'attach_orbis_budget', {
          entity_id: txn.id,
          data: budgetProps(cat, '2026-07-10', '2026-07-14'),
        }),
        { sink },
      ),
    );
    // Себя она не считает, но и из чужого конверта не выпала: иначе «пометил конвертом»
    // тихо выкидывало бы сумму из бюджета месяца
    expect(await budgetParents(txn.id)).toEqual([wide.id]);
  });

  test('узкий конверт-транзакция считает ДРУГИЕ транзакции: исключение — только про себя', async () => {
    const user = freshUserId();
    const cat = newId();
    const { entity: txn } = await createEntity(user, {
      title: 'Транзакция-конверт',
      props: finProps(cat, '2026-07-12'),
      aspects: ['orbis/financial'],
    });
    ok(
      await execute(
        db,
        req(user, 'attach_orbis_budget', {
          entity_id: txn.id,
          data: budgetProps(cat, '2026-07-10', '2026-07-14'),
        }),
        { sink },
      ),
    );
    const { entity: other } = await createEntity(user, {
      title: 'Соседняя транзакция',
      props: finProps(cat, '2026-07-13'),
      aspects: ['orbis/financial'],
    });
    expect(await budgetParents(other.id)).toEqual([txn.id]);
  });
});

// ---------------------------------------------------------------------------
// Задача 10a: привязка и уникальность читают НОВУЮ правду строки (§А1-1)
// ---------------------------------------------------------------------------
