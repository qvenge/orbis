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
  divergentEntityRow,
  executeWithFixtureCategories as execute,
  freshUserId,
  legacyEntityColumns,
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
import { assertEnvelopeUnique, selectEnvelope } from './binding';

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

/**
 * Тот же конверт СВОЙСТВАМИ — форма `data` у `attach_*` (§А9-1). Старая карта выше осталась
 * у фикстур `entity_create`/`entity_update` через `execute`: exec-надмножество принимает обе.
 */
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
      aspects: {
        'orbis/budget': budgetData(catC, '2026-07-01', '2026-07-31', { currency: 'RUB' }),
      },
    });
    // Прямая вставка мимо исполнителя (в этом и смысл: строка «как из прошлого», без
    // currency). Через drizzle, а не сырым SQL: строка обязана лечь во ВСЕ три колонки
    // формы (§А1-1), а имя `aspects` теперь занято списком аспектов.
    await withIdentity(db, user, async (tx) =>
      tx.insert(entities).values({
        id: idSmall,
        ownerId: user,
        title: 'legacy без currency (дефолт RUB)',
        ...(await legacyEntityColumns(tx, user, {
          'orbis/budget': budgetData(catC, '2026-07-01', '2026-07-31'),
        })),
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
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    envId = env.id;
    const { entity: txn } = await createEntity(user, {
      title: 'Оплата сервиса',
      aspects: { 'orbis/financial': finData(cat, '2026-07-05') },
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
        req(user, 'entity_update', { id: txnId, aspects: { 'orbis/schedule': null } }),
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
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Ошибочная запись',
      aspects: { 'orbis/financial': finData(cat, '2026-07-06') },
    });
    expect(await budgetParents(txn.id)).toEqual([env.id]);

    const r = ok(
      await execute(
        db,
        req(user, 'entity_update', { id: txn.id, aspects: { 'orbis/financial': null } }),
        { sink },
      ),
    );
    expect(await budgetParents(txn.id)).toEqual([]);
    // Снятие — в том же action: Undo возвращает и аспект, и связь одной отменой
    const action = await actionById(r.actionId);
    expect(action.operations.map((o) => o.op)).toEqual(['entity_update', 'relation_delete']);
  });

  test('detach у НЕпривязанной сущности лишних операций не порождает', async () => {
    const { entity: note } = await createEntity(user, {
      title: 'Заметка',
      aspects: { 'orbis/note': { content_type: 'plain' } },
    });
    const r = ok(
      await execute(
        db,
        req(user, 'entity_update', { id: note.id, aspects: { 'orbis/note': null } }),
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
            aspects: { 'orbis/financial': finData(cat, day) },
          }),
          { sink },
        ),
        execute(
          db,
          req(user, 'entity_create', {
            title: `Конверт ${i}`,
            tags: [],
            aspects: { 'orbis/budget': budgetData(cat, '2026-08-01', '2026-08-31') },
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
        aspects: { 'orbis/financial': finData(cat, day) },
      });
      const [upd, env] = await Promise.all([
        // правка транзакции: FOR UPDATE строки → бюджет-хук
        execute(
          db,
          req(user, 'entity_update', {
            id: txn.id,
            aspects: { 'orbis/financial': finData(cat, day, { amount: '999.00' }) },
          }),
          { sink },
        ),
        // запись конверта: advisory на prepare → строки на ребиндинге
        execute(
          db,
          req(user, 'entity_create', {
            title: `Конверт ${i}`,
            tags: [],
            aspects: { 'orbis/budget': budgetData(cat, '2026-09-01', '2026-09-30') },
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
      aspects: { 'orbis/financial': finData(cat, '2026-07-12') },
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
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Транзакция в конверте месяца',
      aspects: { 'orbis/financial': finData(cat, '2026-07-12') },
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
      aspects: { 'orbis/financial': finData(cat, '2026-07-12') },
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
      aspects: { 'orbis/financial': finData(cat, '2026-07-13') },
    });
    expect(await budgetParents(other.id)).toEqual([txn.id]);
  });
});

// ---------------------------------------------------------------------------
// Хук привязки против интервальной уникальности (7a→0017)
// ---------------------------------------------------------------------------
//
// До 0017 `rel_uniq` стоит на ПРОЕКЦИИ роли, поэтому `subitem` и `envelope-binding` на одной
// паре несовместимы. А ребро роли владельца от конверта к транзакции система создать
// РАЗРЕШАЕТ. Значит хук обязан считать такое ребро привязкой — иначе он раз за разом пытается
// поставить рядом своё `envelope-binding`, бьётся об уникальность и валит ЧУЖУЮ операцию
// владельца (правку категории, суммы, даты — что угодно), причём НАВСЕГДА.
//
// Ровно так это и работало до реформы: `budgetParentsOfMany` читал `relation_type='parent'` с
// источником-конвертом, ручное ребро само было привязкой, и хук выходил в no-op.
describe('хук привязки и живое parent-ребро той же пары (интервал 7a→0017)', () => {
  /** Источники, которых АГРЕГАТЫ считают конвертами-родителями (условие `spentByEnvelope`). */
  async function legacyBudgetParents(txnId: string): Promise<string[]> {
    const rows = await adminRows(
      sql`SELECT r.source_id FROM relations r
          JOIN entities e ON e.id = r.source_id
          WHERE r.target_id = ${txnId} AND r.relation_type = 'parent'
            AND 'orbis/budget' = ANY(e.aspects)
          ORDER BY r.source_id`,
    );
    return rows.map((r) => r.source_id as string);
  }

  test('1. правка категории транзакции в категорию конверта, у которого уже есть subitem-ребро к ней', async () => {
    const user = freshUserId();
    const catEnvelope = newId();
    const catOther = newId();
    const { entity: env } = await createEntity(user, {
      title: 'Конверт Еда',
      aspects: { 'orbis/budget': budgetData(catEnvelope, '2026-07-01', '2026-07-31') },
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Трата другой категории',
      aspects: { 'orbis/financial': finData(catOther, '2026-07-12') },
    });
    // Ребро роли ВЛАДЕЛЬЦА от конверта к транзакции — система его разрешает
    ok(
      await execute(
        db,
        req(user, 'relation_create', {
          source_id: env.id,
          target_id: txn.id,
          role: 'subitem',
        }),
        { sink },
      ),
    );

    // …и правка категории на категорию конверта обязана пройти
    ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: txn.id,
          aspects: { 'orbis/financial': { category_ref: catEnvelope } },
        }),
        { sink },
      ),
    );
    // Конверт-родитель по счёту агрегатов — РОВНО ОДИН (двойного счёта нет)
    expect(await legacyBudgetParents(txn.id)).toEqual([env.id]);
  });

  test('2. attach orbis/budget на сущность с subitem-ребёнком-транзакцией той же категории', async () => {
    const user = freshUserId();
    const cat = newId();
    const { entity: txn } = await createEntity(user, {
      title: 'Трата проекта',
      aspects: { 'orbis/financial': finData(cat, '2026-07-12') },
    });
    const { entity: x } = await createEntity(user, { title: 'Проект, ставший конвертом' });
    ok(
      await execute(
        db,
        req(user, 'relation_create', { source_id: x.id, target_id: txn.id, role: 'subitem' }),
        { sink },
      ),
    );

    // «Сделать проект конвертом» обязано пройти
    ok(
      await execute(
        db,
        req(user, 'attach_orbis_budget', {
          entity_id: x.id,
          data: budgetProps(cat, '2026-07-01', '2026-07-31'),
        }),
        { sink },
      ),
    );
    expect(await legacyBudgetParents(txn.id)).toEqual([x.id]);
  });

  test('3. владелец заменил привязку своим ребром: правки financial продолжают проходить', async () => {
    const user = freshUserId();
    const cat = newId();
    const { entity: env } = await createEntity(user, {
      title: 'Конверт Развлечения',
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Кино',
      aspects: { 'orbis/financial': finData(cat, '2026-07-12') },
    });
    expect(await budgetParents(txn.id)).toEqual([env.id]); // привязал хук

    // Снятие привязки и своё ребро — обе операции система разрешает
    ok(
      await execute(
        db,
        req(user, 'relation_delete', {
          source_id: env.id,
          target_id: txn.id,
          role: 'envelope-binding',
        }),
        { sink },
      ),
    );
    ok(
      await execute(
        db,
        req(user, 'relation_create', { source_id: env.id, target_id: txn.id, role: 'subitem' }),
        { sink },
      ),
    );

    // …и после этого ЛЮБАЯ правка транзакции обязана проходить, а не отказывать навсегда
    for (const patch of [
      { amount: '999.00' },
      { occurred_on: '2026-07-13' },
      { category_ref: cat },
    ]) {
      ok(
        await execute(
          db,
          req(user, 'entity_update', { id: txn.id, aspects: { 'orbis/financial': patch } }),
          { sink },
        ),
      );
    }
    expect(await legacyBudgetParents(txn.id)).toEqual([env.id]);
  });

  test('4a. ребро от НЕ-конверта хук не трогает: subitem проекта переживает привязку и ребиндинг', async () => {
    // Граница множества с другой стороны: «конверт-родитель» — это ребро от сущности с
    // `orbis/budget`. Считай хук привязкой любое parent-ребро, он удалял бы связь
    // «проект → задача» на каждой правке суммы — тихая потеря данных владельца.
    const user = freshUserId();
    const cat = newId();
    const { entity: env } = await createEntity(user, {
      title: 'Конверт Ремонт',
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Краска',
      aspects: { 'orbis/financial': finData(cat, '2026-07-12') },
    });
    const { entity: project } = await createEntity(user, { title: 'Проект без бюджета' });
    ok(
      await execute(
        db,
        req(user, 'relation_create', {
          source_id: project.id,
          target_id: txn.id,
          role: 'subitem',
        }),
        { sink },
      ),
    );
    expect(await budgetParents(txn.id)).toEqual([env.id]);

    // Правка суммы гоняет хук: он обязан выйти в no-op и ничьих рёбер не тронуть
    ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: txn.id,
          aspects: { 'orbis/financial': { amount: '777.00' } },
        }),
        { sink },
      ),
    );
    expect(await budgetParents(txn.id)).toEqual([env.id]);
    const own = await adminRows(
      sql`SELECT role FROM relations WHERE source_id = ${project.id} AND target_id = ${txn.id}`,
    );
    expect(own.map((r) => r.role as string)).toEqual(['subitem']);
  });

  test('4b. смена конверта снимает ребро ТОЙ РОЛИ, что есть: subitem владельца, а не envelope-binding', async () => {
    // Удаляя привязку, хук обязан назвать роль существующей строки. Зашей он свою
    // `envelope-binding` — `relation_delete` не нашёл бы строку и уронил бы правку владельца.
    const user = freshUserId();
    const catA = newId();
    const catB = newId();
    const { entity: envA } = await createEntity(user, {
      title: 'Конверт A',
      aspects: { 'orbis/budget': budgetData(catA, '2026-07-01', '2026-07-31') },
    });
    const { entity: envB } = await createEntity(user, {
      title: 'Конверт B',
      aspects: { 'orbis/budget': budgetData(catB, '2026-07-01', '2026-07-31') },
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Переезжающая трата',
      aspects: { 'orbis/financial': finData(catA, '2026-07-12') },
    });
    // Заменяем системную привязку своим ребром той же пары
    ok(
      await execute(
        db,
        req(user, 'relation_delete', {
          source_id: envA.id,
          target_id: txn.id,
          role: 'envelope-binding',
        }),
        { sink },
      ),
    );
    ok(
      await execute(
        db,
        req(user, 'relation_create', { source_id: envA.id, target_id: txn.id, role: 'subitem' }),
        { sink },
      ),
    );

    // Смена категории: конверт A обязан отпустить транзакцию, конверт B — принять
    ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: txn.id,
          aspects: { 'orbis/financial': { category_ref: catB } },
        }),
        { sink },
      ),
    );
    expect(await legacyBudgetParents(txn.id)).toEqual([envB.id]);
    const leftover = await adminRows(
      sql`SELECT role FROM relations WHERE source_id = ${envA.id} AND target_id = ${txn.id}`,
    );
    expect(leftover).toEqual([]);
  });

  test('4c. отвязка шаблона снимает ребро ТОЙ РОЛИ, что есть (ветка fin=null)', async () => {
    const user = freshUserId();
    const cat = newId();
    const { entity: env } = await createEntity(user, {
      title: 'Конверт подписок',
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Подписка',
      aspects: { 'orbis/financial': finData(cat, '2026-07-12') },
    });
    ok(
      await execute(
        db,
        req(user, 'relation_delete', {
          source_id: env.id,
          target_id: txn.id,
          role: 'envelope-binding',
        }),
        { sink },
      ),
    );
    ok(
      await execute(
        db,
        req(user, 'relation_create', { source_id: env.id, target_id: txn.id, role: 'subitem' }),
        { sink },
      ),
    );

    // Конверсия в шаблон повторения — безусловная отвязка ВСЕХ конвертов-родителей
    ok(
      await execute(
        db,
        req(user, 'attach_orbis_schedule', {
          entity_id: txn.id,
          data: {
            'orbis/start_at': '2026-07-12T10:00:00+03:00',
            'orbis/recurrence': { freq: 'monthly', interval: 1 },
          },
        }),
        { sink },
      ),
    );
    expect(await legacyBudgetParents(txn.id)).toEqual([]);
  });

  test('4. хук СЧИТАЕТ ребро роли владельца привязкой: своего envelope-binding он не добавляет', async () => {
    // Тест, которого не хватало: без него дыра дожила до гейта. Проверяется не «отказа нет»,
    // а причина — хук видит существующее ребро и выходит в no-op.
    const user = freshUserId();
    const cat = newId();
    const { entity: env } = await createEntity(user, {
      title: 'Конверт Транспорт',
      aspects: { 'orbis/budget': budgetData(cat, '2026-07-01', '2026-07-31') },
    });
    const { entity: txn } = await createEntity(user, {
      title: 'Такси',
      aspects: { 'orbis/financial': finData(cat, '2026-07-12') },
    });
    ok(
      await execute(
        db,
        req(user, 'relation_delete', {
          source_id: env.id,
          target_id: txn.id,
          role: 'envelope-binding',
        }),
        { sink },
      ),
    );
    ok(
      await execute(
        db,
        req(user, 'relation_create', { source_id: env.id, target_id: txn.id, role: 'ticket' }),
        { sink },
      ),
    );

    // Правка ФИНАНСОВОГО аспекта — иначе хук не запускается вовсе и тест был бы вакуумным
    const r = ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: txn.id,
          aspects: { 'orbis/financial': { amount: '450.00' } },
        }),
        { sink },
      ),
    );
    // Хук ничего не дописал: в action ровно одна операция — сама правка
    const action = await actionById(r.actionId);
    expect(action.operations.filter((o) => o.op.startsWith('relation_'))).toEqual([]);
    // Ребро владельца на месте, второго ребра нет
    expect(await budgetParents(txn.id)).toEqual([]); // роли envelope-binding нет
    expect(await legacyBudgetParents(txn.id)).toEqual([env.id]); // но конверт-родитель есть
  });
});

// ---------------------------------------------------------------------------
// Задача 10a: привязка и уникальность читают НОВУЮ правду строки (§А1-1)
// ---------------------------------------------------------------------------
/**
 * ПРОБА РАСХОЖДЕНИЕМ КОЛОНОК — тот же приём, что в `aggregates.test.ts`: строки кладутся
 * прямым INSERT'ом так, что `props` и старая карта аспектов говорят РАЗНОЕ, и тест
 * спрашивает, чей ответ даёт селектор, ребиндинг и проверка уникальности. Прод такого
 * состояния не производит (обе колонки пишет один писатель), поэтому иначе «переведено» от
 * «не переведено» поведением не отличить.
 */
describe('привязка читает props/aspects[], а не старую карту (§А1-1, Задача 10a)', () => {
  const catProps = newId();
  const catLegacy = newId();

  /** Строка с расхождением: props — левая колонка пробы, `legacy` — правая. */
  function divergentRow(
    user: string,
    id: string,
    title: string,
    props: Record<string, unknown>,
    aspects: string[],
    legacy: Record<string, Record<string, unknown>>,
  ): typeof entities.$inferInsert {
    return divergentEntityRow({ ownerId: user, id, title, props, aspects, legacy });
  }

  test('селектор §2.3 выбирает конверт по категории, валюте и периоду из props', async () => {
    const user = freshUserId();
    const envId = newId();
    await withIdentity(db, user, (tx) =>
      tx.insert(entities).values(
        divergentRow(
          user,
          envId,
          'Конверт расхождения',
          {
            'orbis/finance_category': catProps,
            'orbis/limit': '30000.00',
            'orbis/currency': 'RUB',
            'orbis/period_start': '2026-07-01',
            'orbis/period_end': '2026-07-31',
          },
          ['orbis/budget'],
          {
            'orbis/budget': {
              category_ref: catLegacy,
              limit: '30000.00',
              currency: 'USD',
              period_start: '2030-01-01',
              period_end: '2030-01-31',
            },
          },
        ),
      ),
    );

    // Комбинация из props попадает в конверт…
    expect(
      await selector(user, { categoryRef: catProps, currency: 'RUB', occurredOn: '2026-07-12' }),
    ).toBe(envId);
    // …а комбинация из старой карты — нет: обе стороны границы, а не одна.
    expect(
      await selector(user, { categoryRef: catLegacy, currency: 'USD', occurredOn: '2030-01-12' }),
    ).toBeNull();
  });

  test('ребиндинг при создании конверта находит транзакции по категории и дате из props', async () => {
    const user = freshUserId();
    const txnId = newId();
    await withIdentity(db, user, (tx) =>
      tx.insert(entities).values(
        divergentRow(
          user,
          txnId,
          'Транзакция расхождения',
          {
            'orbis/amount': '340.00',
            'orbis/direction': 'expense',
            'orbis/finance_category': catProps,
            'orbis/occurred_on': '2026-07-12',
          },
          ['orbis/financial'],
          {
            'orbis/financial': {
              amount: '340.00',
              direction: 'expense',
              category_ref: catLegacy,
              occurred_on: '2030-01-12',
            },
          },
        ),
      ),
    );

    // Конверт создаётся ПОСЛЕ транзакции — привязку дописывает ребиндинг (§2.3), а не
    // хук создания транзакции: путь, который переводит эта задача.
    const { entity: env } = await createEntity(user, {
      title: 'Конверт июля',
      aspects: { 'orbis/budget': budgetData(catProps, '2026-07-01', '2026-07-31') },
    });
    expect(await budgetParents(txnId)).toEqual([env.id]);
  });

  test('уникальность §2.1 сравнивает комбинацию из props', async () => {
    const user = freshUserId();
    await withIdentity(db, user, (tx) =>
      tx.insert(entities).values(
        divergentRow(
          user,
          newId(),
          'Занятая комбинация',
          {
            'orbis/finance_category': catProps,
            'orbis/limit': '30000.00',
            'orbis/currency': 'RUB',
            'orbis/period_start': '2026-07-01',
            'orbis/period_end': '2026-07-31',
          },
          ['orbis/budget'],
          {
            'orbis/budget': {
              category_ref: catLegacy,
              limit: '30000.00',
              currency: 'USD',
              period_start: '2030-01-01',
              period_end: '2030-01-31',
            },
          },
        ),
      ),
    );

    // Та же комбинация, что в props занятой строки, — отказ…
    const clash = err(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Дубль',
          tags: [],
          aspects: { 'orbis/budget': budgetData(catProps, '2026-07-01', '2026-07-31') },
        }),
        { sink },
      ),
    );
    expect(invariantOf(clash)).toBe('duplicate_envelope');
    // …а комбинация из старой карты занятой не считается: проверка смотрит одну колонку.
    ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Не дубль',
          tags: [],
          aspects: {
            'orbis/budget': budgetData(catLegacy, '2030-01-01', '2030-01-31', { currency: 'USD' }),
          },
        }),
        { sink },
      ),
    );
  });

  /**
   * Р-30: `IS NOT DISTINCT FROM` в сравнении валюты. NULL-валюта обязана совпасть сама с
   * собой — с обычным `=` сравнение дало бы NULL, дубль не нашёлся бы, и у владельца
   * появилась бы вторая строка на ту же комбинацию.
   *
   * Через исполнитель эту ветку не достать: `normalizeEnvelopeCurrency` подставляет явную
   * валюту ДО проверки, и NULL остаётся только у до-реформенных строк. Поэтому проверка
   * зовётся напрямую — обе стороны границы, NULL против NULL и NULL против явной валюты.
   */
  test('уникальность §2.1: NULL-валюта совпадает сама с собой, но не с явной (Р-30)', async () => {
    const user = freshUserId();
    const legacyEnvId = newId();
    await withIdentity(db, user, (tx) =>
      tx.insert(entities).values(
        divergentRow(
          user,
          legacyEnvId,
          'Конверт без валюты',
          {
            'orbis/finance_category': catProps,
            'orbis/limit': '30000.00',
            'orbis/period_start': '2026-09-01',
            'orbis/period_end': '2026-09-30',
          },
          ['orbis/budget'],
          {},
        ),
      ),
    );

    const props = {
      'orbis/finance_category': catProps,
      'orbis/limit': '30000.00',
      'orbis/period_start': '2026-09-01',
      'orbis/period_end': '2026-09-30',
    };
    await expect(
      withIdentity(db, user, (tx) =>
        assertEnvelopeUnique(tx, { ownerId: user, entityId: newId(), props }),
      ),
    ).rejects.toMatchObject({ details: { invariant: 'duplicate_envelope' } });

    // Явная валюта — ДРУГАЯ комбинация (§2.1 сравнивает точно): отказа нет.
    await withIdentity(db, user, (tx) =>
      assertEnvelopeUnique(tx, {
        ownerId: user,
        entityId: newId(),
        props: { ...props, 'orbis/currency': 'RUB' },
      }),
    );
  });
});
