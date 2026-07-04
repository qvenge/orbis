// apps/server/src/executor/batch.test.ts
// Интеграционные тесты Task 10: batch_execute (§7.8, §9.2, §13.4) — атомарность,
// идемпотентность по PK audit-сообщения batchAuditMessageId, «виртуальное» состояние
// (create операции N виден проверкам операции N+1), значимый порядок операций,
// запрет вложенного batch, перенос budget-parent батчем «удалить + создать».
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { batchAuditMessageId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { execute } from './executor';
import type {
  ExecuteErr,
  ExecuteOk,
  ExecuteRequest,
  ExecuteResult,
  WireEntity,
  WireRelation,
} from './types';
import { InMemoryJournalSink } from './types';

requireEnv();

const { db, client } = appDb();
const userA = freshUserId();
const CATEGORY_REF = '019e4466-aaaa-7e07-b5d4-64be9721da51';
const T0 = new Date('2026-07-05T12:00:00.000Z');

function batchReq(
  operations: Array<{ tool: string; input: unknown }>,
  batchId: string,
  over: Partial<ExecuteRequest> = {},
): ExecuteRequest {
  return {
    actorUserId: userA,
    actorKind: 'owner',
    source: 'chat',
    operations,
    batchId,
    clock: () => T0,
    ...over,
  };
}

function singleReq(tool: string, input: unknown): ExecuteRequest {
  return {
    actorUserId: userA,
    actorKind: 'owner',
    source: 'chat',
    operations: [{ tool, input }],
    clock: () => T0,
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

function finData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amount: '340.00',
    direction: 'expense',
    category_ref: CATEGORY_REF,
    occurred_on: '2026-07-04',
    ...over,
  };
}

function budgetData(): Record<string, unknown> {
  return {
    category_ref: CATEGORY_REF,
    limit: '30000.00',
    period_start: '2026-07-01',
    period_end: '2026-07-31',
  };
}

async function entityCount(id: string): Promise<number> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`);
    return rows[0]?.n as number;
  } finally {
    await adminClient.end();
  }
}

async function relCount(sourceId: string, targetId: string, relationType: string): Promise<number> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(
      sql`SELECT count(*)::int AS n FROM relations
          WHERE source_id = ${sourceId} AND target_id = ${targetId} AND relation_type = ${relationType}`,
    );
    return rows[0]?.n as number;
  } finally {
    await adminClient.end();
  }
}

/** Первый элемент массива с внятным падением (вместо non-null assertion). */
function first<T>(items: readonly T[]): T {
  const v = items[0];
  if (v === undefined) throw new Error('ожидался хотя бы один элемент');
  return v;
}

async function createEntity(input: Record<string, unknown>): Promise<WireEntity> {
  const r = ok(await execute(db, singleReq('entity_create', { tags: [], ...input })));
  return r.results[0] as WireEntity;
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('batch_execute: атомарность (§7.8, §13.4)', () => {
  test('1. невалидная вторая операция откатывает все три: ни строк, ни audit-записи', async () => {
    const idA = newId();
    const idB = newId();
    const sink = new InMemoryJournalSink();
    const r = err(
      await execute(
        db,
        batchReq(
          [
            { tool: 'entity_create', input: { id: idA, title: 'Первая', tags: [] } },
            {
              tool: 'entity_create',
              // невалидный аспект: amount числом (§13.4 — вторая операция не проходит валидацию)
              input: {
                id: idB,
                title: 'Вторая',
                tags: [],
                aspects: { 'orbis/financial': { amount: 340 } },
              },
            },
            {
              tool: 'relation_create',
              input: { source_id: idA, target_id: idB, relation_type: 'related_to' },
            },
          ],
          newId(),
        ),
        { sink },
      ),
    );
    expect(r.error.code).toBe('VALIDATION');
    expect(await entityCount(idA)).toBe(0);
    expect(await entityCount(idB)).toBe(0);
    expect(await relCount(idA, idB, 'related_to')).toBe(0);
    expect(sink.entries.length).toBe(0); // action не создан (§13.4)
  });

  test('2. порядок операций значим: relation_create ДО entity_create → NOT_FOUND, откат целиком', async () => {
    const idX = newId();
    const idY = newId();
    const r = err(
      await execute(
        db,
        batchReq(
          [
            {
              tool: 'relation_create',
              input: { source_id: idX, target_id: idY, relation_type: 'related_to' },
            },
            { tool: 'entity_create', input: { id: idX, title: 'X', tags: [] } },
            { tool: 'entity_create', input: { id: idY, title: 'Y', tags: [] } },
          ],
          newId(),
        ),
      ),
    );
    expect(r.error.code).toBe('NOT_FOUND');
    expect(await entityCount(idX)).toBe(0);
    expect(await entityCount(idY)).toBe(0);
  });
});

describe('batch_execute: успех, виртуальное состояние и идемпотентность (§7.8, §9.2)', () => {
  test('3. create+create+attach+relation: один action id=batch_id, audit с PK batchAuditMessageId, inverse в обратном порядке; relation видит созданные тем же batch сущности', async () => {
    const envId = newId();
    const txnId = newId();
    const batchId = newId();
    const sink = new InMemoryJournalSink();
    const operations = [
      {
        tool: 'entity_create',
        input: {
          id: envId,
          title: 'Конверт Еда',
          tags: [],
          aspects: { 'orbis/budget': budgetData() },
        },
      },
      { tool: 'entity_create', input: { id: txnId, title: 'Кофе', tags: [] } },
      { tool: 'attach_orbis_financial', input: { entity_id: txnId, data: finData() } },
      {
        tool: 'relation_create',
        input: { source_id: envId, target_id: txnId, relation_type: 'parent' },
      },
    ];
    const r = ok(await execute(db, batchReq(operations, batchId), { sink }));
    expect(r.actionId).toBe(batchId); // action получает id = batch_id (§7.8)
    expect(r.idempotentReplay).toBe(false);
    expect(r.results.length).toBe(4);
    expect((r.results[3] as WireRelation).relationType).toBe('parent');

    expect(await entityCount(envId)).toBe(1);
    expect(await entityCount(txnId)).toBe(1);
    expect(await relCount(envId, txnId, 'parent')).toBe(1);

    // стадии 6–7: ОДИН action на весь batch
    expect(sink.entries.length).toBe(1);
    const entry = first(sink.entries);
    expect(entry.id).toBe(batchAuditMessageId(userA, batchId)); // детерминированный PK (§7.8)
    expect(entry.action.id).toBe(batchId);
    expect(entry.action.type).toBe('batch');
    expect(entry.action.operations.length).toBe(4);
    expect(entry.action.inverse.length).toBe(4);
    // inverse — в обратном порядке исполнения: первым откатывается relation
    expect(first(entry.action.inverse).op).toBe('relation_delete');
    expect(entry.results).toEqual(r.results); // сохранённый результат для идемпотентного повтора

    // повтор успешного batch с тем же batch_id (§13.4): данные не задвоены
    const replay = ok(await execute(db, batchReq(operations, batchId), { sink }));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.actionId).toBe(batchId);
    expect(replay.results).toEqual(r.results); // исходный результат
    expect(sink.entries.length).toBe(1); // второй audit не записан
    expect(await entityCount(envId)).toBe(1);
    expect(await relCount(envId, txnId, 'parent')).toBe(1);
  });

  test('4. форма-тул batch_execute (§9.2): единственная операция с envelope {batch_id, operations}', async () => {
    const id = newId();
    const batchId = newId();
    const sink = new InMemoryJournalSink();
    const r = ok(
      await execute(
        db,
        singleReq('batch_execute', {
          batch_id: batchId,
          operations: [{ tool: 'entity_create', input: { id, title: 'Через тул', tags: [] } }],
        }),
        { sink },
      ),
    );
    expect(r.actionId).toBe(batchId);
    expect(await entityCount(id)).toBe(1);
    expect(first(sink.entries).id).toBe(batchAuditMessageId(userA, batchId));
  });

  test('5. перенос budget-parent батчем «удалить старую + создать новую» (§4.2): ровно одна живая связь', async () => {
    const env1 = await createEntity({
      title: 'Конверт-старый',
      aspects: { 'orbis/budget': budgetData() },
    });
    const env2 = await createEntity({
      title: 'Конверт-новый',
      aspects: { 'orbis/budget': budgetData() },
    });
    const txn = await createEntity({
      title: 'Переносимая',
      aspects: { 'orbis/financial': finData() },
    });
    ok(
      await execute(
        db,
        singleReq('relation_create', {
          source_id: env1.id,
          target_id: txn.id,
          relation_type: 'parent',
        }),
      ),
    );

    const r = ok(
      await execute(
        db,
        batchReq(
          [
            {
              tool: 'relation_delete',
              input: { source_id: env1.id, target_id: txn.id, relation_type: 'parent' },
            },
            {
              tool: 'relation_create',
              input: { source_id: env2.id, target_id: txn.id, relation_type: 'parent' },
            },
          ],
          newId(),
        ),
      ),
    );
    expect(r.results.length).toBe(2);
    expect(await relCount(env1.id, txn.id, 'parent')).toBe(0);
    expect(await relCount(env2.id, txn.id, 'parent')).toBe(1);
  });

  test('6. derived_from, создаваемая тем же batch, легитимизирует recurring=true без recurrence (§3.3)', async () => {
    const template = await createEntity({
      title: 'Шаблон подписки',
      aspects: {
        'orbis/financial': {
          amount: '500.00',
          direction: 'expense',
          category_ref: CATEGORY_REF,
          recurring: true,
        },
        'orbis/schedule': {
          start_at: '2026-07-01T10:00:00+03:00',
          recurrence: { freq: 'monthly', interval: 1 },
        },
      },
    });
    const instId = newId();
    const r = ok(
      await execute(
        db,
        batchReq(
          [
            {
              tool: 'entity_create',
              input: {
                id: instId,
                title: 'Подписка июль',
                tags: [],
                // recurring=true без recurrence: валиден ТОЛЬКО благодаря derived_from ниже
                aspects: { 'orbis/financial': finData({ amount: '500.00', recurring: true }) },
              },
            },
            {
              tool: 'relation_create',
              input: { source_id: template.id, target_id: instId, relation_type: 'derived_from' },
            },
          ],
          newId(),
        ),
      ),
    );
    expect(r.results.length).toBe(2);
    expect(await relCount(template.id, instId, 'derived_from')).toBe(1);

    // контроль: тот же create одиночным вызовом (без derived_from) → INVARIANT
    const alone = err(
      await execute(
        db,
        singleReq('entity_create', {
          title: 'Сирота',
          tags: [],
          aspects: { 'orbis/financial': finData({ amount: '500.00', recurring: true }) },
        }),
      ),
    );
    expect(alone.error.code).toBe('INVARIANT');
  });
});

describe('batch_execute: границы протокола (§9.2)', () => {
  test('7. вложенный batch_execute внутри batch → VALIDATION, откат', async () => {
    const id = newId();
    const r = err(
      await execute(
        db,
        batchReq(
          [
            { tool: 'entity_create', input: { id, title: 'До вложенного', tags: [] } },
            {
              tool: 'batch_execute',
              input: {
                batch_id: newId(),
                operations: [{ tool: 'entity_create', input: { title: 'x', tags: [] } }],
              },
            },
          ],
          newId(),
        ),
      ),
    );
    expect(r.error.code).toBe('VALIDATION');
    expect(await entityCount(id)).toBe(0);
  });

  test('8. operations.length > 1 без batchId → VALIDATION', async () => {
    const r = err(
      await execute(db, {
        actorUserId: userA,
        actorKind: 'owner',
        source: 'chat',
        operations: [
          { tool: 'entity_create', input: { title: 'a', tags: [] } },
          { tool: 'entity_create', input: { title: 'b', tags: [] } },
        ],
      }),
    );
    expect(r.error.code).toBe('VALIDATION');
  });

  test('9. немутирующий тул (entity_query) в batch → VALIDATION', async () => {
    const r = err(
      await execute(
        db,
        batchReq(
          [
            { tool: 'entity_create', input: { title: 'ок', tags: [] } },
            { tool: 'entity_query', input: { query: 'aspect=orbis/task' } },
          ],
          newId(),
        ),
      ),
    );
    expect(r.error.code).toBe('VALIDATION');
  });
});
