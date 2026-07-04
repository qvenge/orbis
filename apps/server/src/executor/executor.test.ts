// Интеграционные тесты executor'а (Task 9): реальная БД под withIdentity, без моков.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { resolveEntitlement } from '../entitlements';
import { execute } from './executor';
import type { ExecuteOk, ExecuteRequest, WireEntity } from './types';
import { InMemoryJournalSink } from './types';

requireEnv();

const { db, client } = appDb();
const userA = freshUserId();
const userB = freshUserId();
const CATEGORY_REF = '019e4466-aaaa-7e07-b5d4-64be9721da51';
const T0 = new Date('2026-07-04T10:00:00.000Z');
const T1 = new Date('2026-07-04T11:30:00.000Z');

/** Одиночный вызов executor'а с дефолтами теста. */
function req(tool: string, input: unknown, over: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    actorUserId: userA,
    actorKind: 'owner',
    source: 'fast_path',
    operations: [{ tool, input }],
    clock: () => T0,
    ...over,
  };
}

function firstEntity(r: { ok: boolean }): WireEntity {
  expect(r.ok).toBe(true);
  return (r as ExecuteOk).results[0] as WireEntity;
}

/** Первый элемент массива с внятным падением (вместо non-null assertion). */
function first<T>(items: readonly T[]): T {
  const v = items[0];
  if (v === undefined) throw new Error('ожидался хотя бы один элемент');
  return v;
}

/** Данные аспекта с внятным падением, если аспекта нет. */
function aspectOf(source: { aspects: Record<string, Record<string, unknown>> }, id: string) {
  const a = source.aspects[id];
  if (a === undefined) throw new Error(`ожидался аспект ${id}`);
  return a;
}

async function countEntities(id: string): Promise<number> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`);
    return rows[0]?.n as number;
  } finally {
    await adminClient.end();
  }
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('entitlements (стадия 4, план dev)', () => {
  test('resolveEntitlement: dev → всё разрешено без лимитов (§8, субъект параметром)', () => {
    const r = resolveEntitlement(userA, 'entities.create');
    expect(r).toEqual({ allowed: true, limit: null });
  });
});

describe('executor: entity_create', () => {
  test('1. happy path: строка в БД, tags lowercase+dedupe, body_refs извлечены, createdAt от clock', async () => {
    const sink = new InMemoryJournalSink();
    const refId = '019e4466-1000-7e07-b5d4-64be9721da51';
    const r = await execute(
      db,
      req('entity_create', {
        title: 'Кроссовки',
        tags: ['Shopping', 'shopping', 'БЕГ'],
        body: `Модель выбрана в [[entity:${refId}|Wishlist: бег]] и ещё раз [[entity:${refId.toUpperCase()}]]`,
        aspects: { 'orbis/task': { status: 'inbox' } },
      }),
      { sink },
    );
    const e = firstEntity(r);
    expect((r as ExecuteOk).idempotentReplay).toBe(false);
    expect(e.tags).toEqual(['shopping', 'бег']);
    expect(e.bodyRefs).toEqual([refId]); // dedupe + lowercase
    expect(e.createdAt).toBe(T0.toISOString());
    expect(e.updatedAt).toBe(T0.toISOString());
    expect(e.ownerId).toBe(userA);

    // строка реально в БД (под RLS владельца)
    const rows = await withIdentity(db, userA, (tx) =>
      tx.execute(sql`SELECT title, tags, body_refs FROM entities WHERE id = ${e.id}`),
    );
    expect(rows[0]?.title).toBe('Кроссовки');
    expect(rows[0]?.tags).toEqual(['shopping', 'бег']);
    expect(rows[0]?.body_refs).toEqual([refId]);

    // стадии 6–7: sink получил action с inverse-архивацией
    expect(sink.entries.length).toBe(1);
    const entry = first(sink.entries);
    expect(entry.ownerId).toBe(userA);
    expect(entry.action.type).toBe('entity_created');
    expect(entry.action.actor_user_id).toBe(userA);
    expect(entry.action.actor_kind).toBe('owner');
    expect(entry.action.source).toBe('fast_path');
    expect(entry.action.inverse).toEqual([
      { op: 'entity_update', payload: { id: e.id, archived: true } },
    ]);
    expect(entry.card.entity_id).toBe(e.id);
  });

  test('2. невалидный аспект (amount числом) → VALIDATION, строки в БД нет', async () => {
    const id = newId();
    const r = await execute(
      db,
      req('entity_create', {
        id,
        title: 'Кофе',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: 340,
            direction: 'expense',
            category_ref: CATEGORY_REF,
            occurred_on: '2026-07-04',
          },
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION');
    expect(await countEntities(id)).toBe(0);
  });

  test('3a. financial без occurred_on и без recurring → INVARIANT (§3.3)', async () => {
    const id = newId();
    const r = await execute(
      db,
      req('entity_create', {
        id,
        title: 'Кофе',
        tags: [],
        aspects: {
          'orbis/financial': { amount: '340.00', direction: 'expense', category_ref: CATEGORY_REF },
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVARIANT');
    expect(await countEntities(id)).toBe(0);
  });

  test('3b. recurring=true без orbis/schedule.recurrence → INVARIANT; с recurrence → успех', async () => {
    const bad = await execute(
      db,
      req('entity_create', {
        title: 'Аренда',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: '50000.00',
            direction: 'expense',
            category_ref: CATEGORY_REF,
            recurring: true,
          },
        },
      }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('INVARIANT');

    const good = await execute(
      db,
      req('entity_create', {
        title: 'Аренда',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: '50000.00',
            direction: 'expense',
            category_ref: CATEGORY_REF,
            recurring: true,
          },
          'orbis/schedule': {
            start_at: '2026-07-01T10:00:00+03:00',
            recurrence: { freq: 'monthly', interval: 1 },
          },
        },
      }),
    );
    expect(good.ok).toBe(true); // шаблон: occurred_on не нужен
  });

  test('4. идемпотентность: повтор с тем же id → idempotentReplay, 1 строка, тот же результат, без audit (§5.3, §13.2)', async () => {
    const id = newId();
    const sink = new InMemoryJournalSink();
    const input = { id, title: 'Молоко', tags: ['Еда'] };
    const initial = await execute(db, req('entity_create', input), { sink });
    const firstEnt = firstEntity(initial);
    expect(sink.entries.length).toBe(1);

    const second = await execute(db, req('entity_create', input), { sink });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.idempotentReplay).toBe(true);
      expect(second.results[0]).toEqual(firstEnt); // результат равен первому
    }
    expect(await countEntities(id)).toBe(1);
    expect(sink.entries.length).toBe(1); // стадии 6–7 пропущены
  });

  test('4b. конфликт id с ЧУЖОЙ сущностью → структурированная ошибка, не replay', async () => {
    const id = newId();
    const mine = await execute(db, req('entity_create', { id, title: 'Своя', tags: [] }));
    expect(mine.ok).toBe(true);

    const foreign = await execute(
      db,
      req('entity_create', { id, title: 'Чужая', tags: [] }, { actorUserId: userB }),
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe('VALIDATION');
    expect(await countEntities(id)).toBe(1); // строка userA нетронута, дубля нет
  });

  test('неизвестный тул → VALIDATION; неизвестный аспект → VALIDATION; >1 операции без batch → VALIDATION', async () => {
    const unknownTool = await execute(db, req('entity_destroy', { id: newId() }));
    expect(unknownTool.ok).toBe(false);
    if (!unknownTool.ok) expect(unknownTool.error.code).toBe('VALIDATION');

    const unknownAspect = await execute(
      db,
      req('entity_create', { title: 'x', tags: [], aspects: { 'orbis/unknown': {} } }),
    );
    expect(unknownAspect.ok).toBe(false);
    if (!unknownAspect.ok) expect(unknownAspect.error.code).toBe('VALIDATION');

    const multi = await execute(db, {
      ...req('entity_create', { title: 'x', tags: [] }),
      operations: [
        { tool: 'entity_create', input: { title: 'a', tags: [] } },
        { tool: 'entity_create', input: { title: 'b', tags: [] } },
      ],
    });
    expect(multi.ok).toBe(false);
    if (!multi.ok) expect(multi.error.code).toBe('VALIDATION');
  });
});

describe('executor: entity_update — merge аспектов §9.2', () => {
  async function createTask(): Promise<WireEntity> {
    const r = await execute(
      db,
      req('entity_create', {
        title: 'Задача',
        tags: [],
        aspects: { 'orbis/task': { status: 'inbox', priority: 'high' } },
      }),
    );
    return firstEntity(r);
  }

  test('5. shallow merge: {status:done} сохраняет priority и проставляет completed_at; уход из done чистит его', async () => {
    const e = await createTask();
    const done = await execute(
      db,
      req('entity_update', { id: e.id, aspects: { 'orbis/task': { status: 'done' } } }),
    );
    const eDone = firstEntity(done);
    const task = aspectOf(eDone, 'orbis/task');
    expect(task.status).toBe('done');
    expect(task.priority).toBe('high'); // сохранился
    expect(task.completed_at).toBe(T0.toISOString()); // проставлен clock() (§3.2)

    // откат из done → completed_at очищен
    const back = await execute(
      db,
      req('entity_update', { id: e.id, aspects: { 'orbis/task': { status: 'planned' } } }),
    );
    const eBack = firstEntity(back);
    expect(aspectOf(eBack, 'orbis/task').status).toBe('planned');
    expect('completed_at' in aspectOf(eBack, 'orbis/task')).toBe(false);
  });

  test('5b. поле null внутри аспекта → удалено; аспект null → detach', async () => {
    const e = await createTask();
    const noPriority = await execute(
      db,
      req('entity_update', { id: e.id, aspects: { 'orbis/task': { priority: null } } }),
    );
    const e1 = firstEntity(noPriority);
    expect('priority' in aspectOf(e1, 'orbis/task')).toBe(false);
    expect(aspectOf(e1, 'orbis/task').status).toBe('inbox'); // остальное не тронуто

    const detached = await execute(
      db,
      req('entity_update', { id: e.id, aspects: { 'orbis/task': null } }),
    );
    const e2 = firstEntity(detached);
    expect('orbis/task' in e2.aspects).toBe(false);
  });

  test('5c. результат merge валидируется ajv: удаление обязательного поля → VALIDATION', async () => {
    const created = await execute(
      db,
      req('entity_create', {
        title: 'Транзакция',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: '100.00',
            direction: 'expense',
            category_ref: CATEGORY_REF,
            occurred_on: '2026-07-04',
          },
        },
      }),
    );
    const e = firstEntity(created);
    const r = await execute(
      db,
      req('entity_update', { id: e.id, aspects: { 'orbis/financial': { amount: null } } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION');
  });

  test('5d. detach orbis/schedule у recurring-шаблона → INVARIANT (финальное состояние, §3.3)', async () => {
    const created = await execute(
      db,
      req('entity_create', {
        title: 'Аренда',
        tags: [],
        aspects: {
          'orbis/financial': {
            amount: '50000.00',
            direction: 'expense',
            category_ref: CATEGORY_REF,
            recurring: true,
          },
          'orbis/schedule': {
            start_at: '2026-07-01T10:00:00+03:00',
            recurrence: { freq: 'monthly', interval: 1 },
          },
        },
      }),
    );
    const e = firstEntity(created);
    const r = await execute(
      db,
      req('entity_update', { id: e.id, aspects: { 'orbis/schedule': null } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVARIANT');
  });

  test('updated_at проставляется сервером на каждый update; wire-формат симметричен toISOString', async () => {
    const e = await createTask();
    const r = await execute(
      db,
      req('entity_update', { id: e.id, title: 'Переименована' }, { clock: () => T1 }),
    );
    const e1 = firstEntity(r);
    expect(e1.updatedAt).toBe(T1.toISOString());
    expect(e1.createdAt).toBe(e.createdAt); // created_at не трогается
  });

  test('9. конкурентный merge разных полей одного аспекта: обе правки выживают (FOR UPDATE)', async () => {
    const created = await execute(
      db,
      req('entity_create', {
        title: 'Конкурентная',
        tags: [],
        aspects: { 'orbis/task': { status: 'inbox', priority: 'low' } },
      }),
    );
    const e = firstEntity(created);
    const [a, b] = await Promise.all([
      execute(
        db,
        req('entity_update', { id: e.id, aspects: { 'orbis/task': { status: 'in_progress' } } }),
      ),
      execute(
        db,
        req('entity_update', { id: e.id, aspects: { 'orbis/task': { due_date: '2026-07-05' } } }),
      ),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const rows = await withIdentity(db, userA, (tx) =>
      tx.execute(sql`SELECT aspects FROM entities WHERE id = ${e.id}`),
    );
    const stored = rows[0]?.aspects as Record<string, Record<string, unknown>>;
    const task = aspectOf({ aspects: stored }, 'orbis/task');
    expect(task.status).toBe('in_progress'); // правка A не потеряна
    expect(task.due_date).toBe('2026-07-05'); // правка B не потеряна
    expect(task.priority).toBe('low'); // исходное поле цело
  });
});

describe('executor: optimistic-check body (§5.2, §13.1)', () => {
  async function createNote(): Promise<WireEntity> {
    const r = await execute(db, req('entity_create', { title: 'Заметка', tags: [], body: 'v1' }));
    return firstEntity(r);
  }

  test('6a. body без expectedUpdatedAt → VALIDATION', async () => {
    const e = await createNote();
    const r = await execute(db, req('entity_update', { id: e.id, body: 'v2' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION');
  });

  test('6b. stale expectedUpdatedAt → STALE_VERSION; после перечитывания — успех; body_refs пересчитаны', async () => {
    const e = await createNote();
    const stale = await execute(
      db,
      req('entity_update', {
        id: e.id,
        body: 'v2',
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('STALE_VERSION');

    // «перечитали» — актуальный updatedAt из wire-формы
    const refId = '019e4466-2000-7e07-b5d4-64be9721da52';
    const fresh = await execute(
      db,
      req('entity_update', {
        id: e.id,
        body: `v2 со ссылкой [[entity:${refId}]]`,
        expectedUpdatedAt: e.updatedAt,
      }),
    );
    const e1 = firstEntity(fresh);
    expect(e1.body).toContain('v2');
    expect(e1.bodyRefs).toEqual([refId]); // body_refs пересчитан при update body
  });

  test('6c. патч без body (tags) со stale-версией — проходит (LWW)', async () => {
    const e = await createNote();
    const r = await execute(
      db,
      req('entity_update', {
        id: e.id,
        tags: ['LWW', 'lww'],
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    const e1 = firstEntity(r);
    expect(e1.tags).toEqual(['lww']); // и нормализация тегов на update
  });
});

describe('executor: RLS и attach', () => {
  test('7. чужая сущность (userB) → NOT_FOUND', async () => {
    const created = await execute(db, req('entity_create', { title: 'Приватная', tags: [] }));
    const e = firstEntity(created);
    const r = await execute(
      db,
      req('entity_update', { id: e.id, title: 'Взлом' }, { actorUserId: userB }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  test('8. attach_orbis_task на сущность без аспекта → аспект появился; невалидные data → VALIDATION', async () => {
    const created = await execute(db, req('entity_create', { title: 'Идея', tags: [] }));
    const e = firstEntity(created);

    const bad = await execute(
      db,
      req('attach_orbis_task', { entity_id: e.id, data: { status: 'not-a-status' } }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('VALIDATION');

    const sink = new InMemoryJournalSink();
    const good = await execute(
      db,
      req('attach_orbis_task', { entity_id: e.id, data: { status: 'done' } }),
      { sink },
    );
    const e1 = firstEntity(good);
    expect(aspectOf(e1, 'orbis/task').status).toBe('done');
    expect(aspectOf(e1, 'orbis/task').completed_at).toBe(T0.toISOString()); // done при attach
    // inverse: прежнее значение аспект-ключа (null — аспекта не было)
    expect(first(sink.entries).action.inverse).toEqual([
      { op: 'entity_update', payload: { id: e.id, aspects: { 'orbis/task': null } } },
    ]);
  });

  test('8b. attach financial без occurred_on → INVARIANT (инвариант работает и для attach)', async () => {
    const created = await execute(db, req('entity_create', { title: 'Покупка', tags: [] }));
    const e = firstEntity(created);
    const r = await execute(
      db,
      req('attach_orbis_financial', {
        entity_id: e.id,
        data: { amount: '10.00', direction: 'expense', category_ref: CATEGORY_REF },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVARIANT');
  });
});
