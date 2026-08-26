// Интеграционные тесты executor'а (Task 9): реальная БД под withIdentity, без моков.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { canonicalizeBody, DOC_SCHEMA_VERSION } from '@orbis/shared/doc';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { resolveEntitlement } from '../entitlements';
import { readEntity } from '../entity-read';
import { issuePatGrant, revokeGrant, verifyBearer } from '../oauth/grants';
import { projectBodyTemplate } from '../seed/project-body';
import { execute } from './executor';
import { makeChatJournalSink } from './journal';
import type {
  ActionRecord,
  ExecuteOk,
  ExecuteRequest,
  WireEntity,
  WireEntityVersion,
} from './types';
import { InMemoryJournalSink } from './types';
import { undoAction } from './undo';

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
function aspectOf(source: { aspectsMap: Record<string, Record<string, unknown>> }, id: string) {
  const a = source.aspectsMap[id];
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

  test('4b. конфликт id с ЧУЖОЙ сущностью → CONFLICT id_conflict, не replay', async () => {
    const id = newId();
    const mine = await execute(db, req('entity_create', { id, title: 'Своя', tags: [] }));
    expect(mine.ok).toBe(true);

    const foreign = await execute(
      db,
      req('entity_create', { id, title: 'Чужая', tags: [] }, { actorUserId: userB }),
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      // Единый wire-контракт id_conflict (финальное ревью): CONFLICT → 409, как в chat
      expect(foreign.error.code).toBe('CONFLICT');
      expect((foreign.error.details as { reason?: string }).reason).toBe('id_conflict');
      // Текст нейтрален — не подтверждает занятость чужого UUID (оракул)
      expect(foreign.error.message).not.toContain('занят');
    }
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
    expect('orbis/task' in e2.aspectsMap).toBe(false);
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
      tx.execute(sql`SELECT aspects_legacy FROM entities WHERE id = ${e.id}`),
    );
    const stored = rows[0]?.aspects_legacy as Record<string, Record<string, unknown>>;
    const task = aspectOf({ aspectsMap: stored }, 'orbis/task');
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

  test('6d. монотонный updated_at: два апдейта в один тик clock → updated_at строго растёт (§5.2)', async () => {
    // updatedAt = clock() не монотонен: два апдейта в одну миллисекунду оставляли
    // updated_at прежним, и stale-правка body проходила optimistic-check. Теперь
    // updatedAt = max(clock(), prev + 1ms).
    const e = await createNote(); // createdAt/updatedAt = T0
    const u1 = firstEntity(
      await execute(db, req('entity_update', { id: e.id, title: 'v1' })), // clock = T0
    ).updatedAt;
    const u2 = firstEntity(
      await execute(db, req('entity_update', { id: e.id, title: 'v2' })), // clock = T0
    ).updatedAt;
    expect(new Date(u1).getTime()).toBeGreaterThan(T0.getTime());
    expect(new Date(u2).getTime()).toBeGreaterThan(new Date(u1).getTime());

    // Поведенческое следствие: правка body по версии u1 после апдейта u2 — STALE_VERSION,
    // а не тихая победа (раньше u1 === u2 и stale-правка проходила)
    const stale = await execute(
      db,
      req('entity_update', { id: e.id, body: 'stale', expectedUpdatedAt: u1 }),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('STALE_VERSION');
  });

  test('6e. монотонный updated_at и для attach_<aspect> в один тик clock', async () => {
    const e = await createNote(); // T0
    const a1 = firstEntity(
      await execute(db, req('attach_orbis_task', { entity_id: e.id, data: { status: 'inbox' } })),
    ).updatedAt;
    const a2 = firstEntity(
      await execute(db, req('attach_orbis_task', { entity_id: e.id, data: { status: 'planned' } })),
    ).updatedAt;
    expect(new Date(a1).getTime()).toBeGreaterThan(T0.getTime());
    expect(new Date(a2).getTime()).toBeGreaterThan(new Date(a1).getTime());
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

// ─────────────── ADE-срез 1: назначение и заготовка проекта (С4, С7, С10) ───────────────
describe('ADE-срез 1: инварианты назначения и засев проекта', () => {
  /** Тело, реально легшее в БД (а не то, что вернул executor): засев проверяется на чтении. */
  async function bodyOf(id: string): Promise<string> {
    const r = await withIdentity(db, userA, (tx) =>
      readEntity(tx, userA, { id, include: ['body'] }),
    );
    return r.entity.body;
  }

  /** Обе формы тела: строка и документ — засев обязан заполнить ОБЕ. */
  async function bothFormsOf(id: string): Promise<{ body: string; bodyDoc: unknown }> {
    const r = await withIdentity(db, userA, (tx) =>
      readEntity(tx, userA, { id, include: ['body', 'bodyDoc'] }),
    );
    return { body: r.entity.body, bodyDoc: r.entity.bodyDoc ?? null };
  }

  test('20. executor=agent без grant_id → VALIDATION; с чужим/отозванным грантом → NOT_FOUND', async () => {
    const id = newId();
    const bad = await execute(
      db,
      req('entity_create', {
        id,
        title: 'Т',
        tags: [],
        aspects: { 'orbis/task': { status: 'inbox' }, 'orbis/assignment': { executor: 'agent' } },
      }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('VALIDATION');

    const foreign = await execute(
      db,
      req('entity_create', {
        id,
        title: 'Т',
        tags: [],
        aspects: {
          'orbis/task': { status: 'inbox' },
          'orbis/assignment': { executor: 'agent', grant_id: newId() },
        },
      }),
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe('NOT_FOUND');
    expect(await countEntities(id)).toBe(0); // отказ стадии 4 — до первой записи
  });

  test('21. executor=agent с живым грантом владельца — ок; executor=human с grant_id → VALIDATION; отзыв гранта закрывает назначение', async () => {
    const token = await issuePatGrant(db, { ownerId: userA, label: 'исполнитель' });
    const identity = await verifyBearer(db, token);
    expect(identity).not.toBeNull();
    const grantId = identity?.grantId ?? '';

    const ok = await execute(
      db,
      req('entity_create', {
        id: newId(),
        title: 'Т',
        tags: [],
        aspects: {
          'orbis/task': { status: 'inbox' },
          'orbis/assignment': { executor: 'agent', grant_id: grantId },
        },
      }),
    );
    expect(ok.ok).toBe(true);

    const human = await execute(
      db,
      req('entity_create', {
        id: newId(),
        title: 'Т',
        tags: [],
        aspects: {
          'orbis/task': { status: 'inbox' },
          'orbis/assignment': { executor: 'human', grant_id: grantId },
        },
      }),
    );
    expect(human.ok).toBe(false);
    if (!human.ok) expect(human.error.code).toBe('VALIDATION');

    // Тот же инвариант на update-пути: чужой грант в merge аспектов отклоняется
    const plain = firstEntity(
      await execute(db, req('entity_create', { title: 'Тикет', tags: [] })),
    );
    const upd = await execute(
      db,
      req('entity_update', {
        id: plain.id,
        aspects: { 'orbis/assignment': { executor: 'agent', grant_id: newId() } },
      }),
    );
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.error.code).toBe('NOT_FOUND');

    // …и на attach-пути
    const att = await execute(
      db,
      req('attach_orbis_assignment', {
        entity_id: plain.id,
        data: { executor: 'agent', grant_id: newId() },
      }),
    );
    expect(att.ok).toBe(false);
    if (!att.ok) expect(att.error.code).toBe('NOT_FOUND');

    // Живой грант проходит обоими путями
    const attOk = await execute(
      db,
      req('attach_orbis_assignment', {
        entity_id: plain.id,
        data: { executor: 'agent', grant_id: grantId },
      }),
    );
    expect(attOk.ok).toBe(true);

    // Отозванный грант — тот же NOT_FOUND, что и чужой
    await revokeGrant(db, { ownerId: userA, grantId });
    const revoked = await execute(
      db,
      req('entity_update', {
        id: plain.id,
        aspects: { 'orbis/assignment': { executor: 'agent', grant_id: grantId } },
      }),
    );
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error.code).toBe('NOT_FOUND');

    // Правка НЕ трогающая назначение проходит и при отозванном гранте: отзыв закрывает
    // доступ, а не замораживает сущность (иначе тикет становится неправимым)
    const other = await execute(db, req('entity_update', { id: plain.id, title: 'Тикет 2' }));
    expect(other.ok).toBe(true);
  });

  test('22. создание сущности с orbis/project и пустым телом засевает заготовку с блоками; непустое тело не трогается', async () => {
    const id = newId();
    const r = await execute(
      db,
      req('entity_create', {
        id,
        title: 'Проект',
        tags: [],
        aspects: { 'orbis/project': { stage: 'active' } },
      }),
    );
    expect(r.ok).toBe(true);
    const body = await bodyOf(id);
    expect(body).toContain(`{{query: aspect=orbis/agent-run, project_id=${id}`);
    // Тикеты — по uuid проекта, а не по `this`: блок должен читаться и вне тела проекта
    // (закреплённый список, Browser), где контекст записи не передаётся (см. project-body.ts).
    expect(body).toContain(`children_of=${id}, aspect=orbis/task, status=waiting`);
    expect(body).toBe(projectBodyTemplate(id));
    // канон: повторная канонизация не меняет тело
    expect(canonicalizeBody(body).body).toBe(body);
    // тело разобрано в документ, а не легло сырой строкой мимо конверсии: спрашиваем сам
    // документ (пустые bodyRefs доказательством не были — у заготовки ссылок нет в принципе)
    const forms = await bothFormsOf(id);
    expect(forms.bodyDoc).not.toBeNull();
    expect((forms.bodyDoc as { doc: { content: unknown[] } }).doc.content.length).toBeGreaterThan(
      0,
    );
    expect(firstEntity(r).bodyRefs).toEqual([]);

    // Своё тело автора заготовкой не затирается
    const own = newId();
    const r2 = await execute(
      db,
      req('entity_create', {
        id: own,
        title: 'Проект со своим телом',
        tags: [],
        body: 'Мой процесс.',
        aspects: { 'orbis/project': { stage: 'active' } },
      }),
    );
    expect(r2.ok).toBe(true);
    expect(await bodyOf(own)).toBe('Мой процесс.');

    // Сущность без orbis/project заготовку не получает
    const plain = firstEntity(
      await execute(db, req('entity_create', { title: 'Заметка', tags: [] })),
    );
    expect(await bodyOf(plain.id)).toBe('');
  });

  test('23. attach_orbis_project на заметку с пустым телом засевает; с телом — нет; повторный attach не перезасевает', async () => {
    const empty = firstEntity(
      await execute(db, req('entity_create', { title: 'Пусто', tags: [] })),
    );
    const a = await execute(
      db,
      req('attach_orbis_project', { entity_id: empty.id, data: { stage: 'active' } }),
    );
    expect(a.ok).toBe(true);
    expect(await bodyOf(empty.id)).toBe(projectBodyTemplate(empty.id));

    // Повторный attach уже проектной сущности тело не переписывает
    const again = await execute(
      db,
      req('attach_orbis_project', { entity_id: empty.id, data: { stage: 'paused' } }),
    );
    expect(again.ok).toBe(true);
    expect(await bodyOf(empty.id)).toBe(projectBodyTemplate(empty.id));

    // Непустое тело — не трогаем
    const filled = firstEntity(
      await execute(db, req('entity_create', { title: 'С телом', tags: [], body: 'Заметки.' })),
    );
    const b = await execute(
      db,
      req('attach_orbis_project', { entity_id: filled.id, data: { stage: 'active' } }),
    );
    expect(b.ok).toBe(true);
    expect(await bodyOf(filled.id)).toBe('Заметки.');
  });

  test('25. пустая строка во входе телом не считается: body="" и пробельное тело засеваются, своё — нет', async () => {
    // Приёмка 1: проект заводится чатом через entity_create, и модель штатно шлёт body: ''.
    // Пустая строка — «ничего не написали», а не «автор оставил тело пустым» (С10).
    const blank = newId();
    expect(
      (
        await execute(
          db,
          req('entity_create', {
            id: blank,
            title: 'Проект пустой строкой',
            tags: [],
            body: '',
            aspects: { 'orbis/project': { stage: 'active' } },
          }),
        )
      ).ok,
    ).toBe(true);
    expect(await bodyOf(blank)).toBe(projectBodyTemplate(blank));

    const spaces = newId();
    expect(
      (
        await execute(
          db,
          req('entity_create', {
            id: spaces,
            title: 'Проект пробелами',
            tags: [],
            body: '   \n',
            aspects: { 'orbis/project': { stage: 'active' } },
          }),
        )
      ).ok,
    ).toBe(true);
    expect(await bodyOf(spaces)).toBe(projectBodyTemplate(spaces));

    // Регресс: непустое тело по-прежнему побеждает заготовку
    const own = newId();
    expect(
      (
        await execute(
          db,
          req('entity_create', {
            id: own,
            title: 'Своё',
            tags: [],
            body: '# Своё',
            aspects: { 'orbis/project': { stage: 'active' } },
          }),
        )
      ).ok,
    ).toBe(true);
    expect(await bodyOf(own)).toBe('# Своё');

    // …и на update-пути: body: '' с добавлением проекта тоже засевает
    const e = firstEntity(await execute(db, req('entity_create', { title: 'Станет', tags: [] })));
    const upd = await execute(
      db,
      req('entity_update', {
        id: e.id,
        body: '',
        expectedUpdatedAt: e.updatedAt,
        aspects: { 'orbis/project': { stage: 'active' } },
      }),
    );
    expect(upd.ok).toBe(true);
    expect(await bodyOf(e.id)).toBe(projectBodyTemplate(e.id));
  });

  test('26. ПУСТОЙ ДОКУМЕНТ во входе — это тело: bodyDoc побеждает заготовку (порядок веток)', async () => {
    // Документ шлёт редактор, и пустой документ там — результат осознанной правки («стёр всё»),
    // а не отсутствие ввода. Подменять её заготовкой значило бы затирать действие автора.
    const e = firstEntity(
      await execute(db, req('entity_create', { title: 'Из редактора', tags: [] })),
    );
    const r = await execute(
      db,
      req('entity_update', {
        id: e.id,
        bodyDoc: { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [{ type: 'paragraph' }] } },
        expectedUpdatedAt: e.updatedAt,
        aspects: { 'orbis/project': { stage: 'active' } },
      }),
    );
    expect(r.ok).toBe(true);
    expect(await bodyOf(e.id)).not.toBe(projectBodyTemplate(e.id));
    expect((await bodyOf(e.id)).trim()).toBe('');
  });

  test("27. undo attach'а, который засеял тело: аспект снят И тело снова пустое", async () => {
    // Засев — часть эффекта attach, поэтому и откатывается вместе с ним: иначе на заметке,
    // которая проектом быть перестала, осталась бы заготовка с живыми query-блоками.
    const sink = makeChatJournalSink(); // undo ищет action в журнале — NOOP_SINK ему не годится
    const e = firstEntity(
      await execute(db, req('entity_create', { title: 'Заметка под откат', tags: [] }), { sink }),
    );
    const attached = await execute(
      db,
      req('attach_orbis_project', { entity_id: e.id, data: { stage: 'active' } }),
      { sink },
    );
    expect(attached.ok).toBe(true);
    expect(await bodyOf(e.id)).toBe(projectBodyTemplate(e.id));

    const actionId = (attached as ExecuteOk).actionId;
    const undone = await undoAction(db, { actorUserId: userA, actionId });
    expect(undone.ok).toBe(true);
    const after = firstEntity(undone);
    expect(after.aspectsMap['orbis/project']).toBeUndefined(); // аспект снят
    expect(await bodyOf(e.id)).toBe(''); // и заготовка вместе с ним
  });

  test('24. entity_update, добавляющий orbis/project пустой заметке, засевает заготовку без expectedUpdatedAt', async () => {
    const e = firstEntity(
      await execute(db, req('entity_create', { title: 'Станет проектом', tags: [] })),
    );
    const r = await execute(
      db,
      req('entity_update', { id: e.id, aspects: { 'orbis/project': { stage: 'active' } } }),
    );
    expect(r.ok).toBe(true);
    expect(await bodyOf(e.id)).toBe(projectBodyTemplate(e.id));

    // Явное тело в том же патче побеждает заготовку (её вообще не засеваем)
    const e2 = firstEntity(
      await execute(db, req('entity_create', { title: 'Тоже проект', tags: [] })),
    );
    const r2 = await execute(
      db,
      req('entity_update', {
        id: e2.id,
        body: 'Своё.',
        expectedUpdatedAt: e2.updatedAt,
        aspects: { 'orbis/project': { stage: 'active' } },
      }),
    );
    expect(r2.ok).toBe(true);
    expect(await bodyOf(e2.id)).toBe('Своё.');
  });
});

describe('ADE-срез 1: закреплённые версии тела (С11)', () => {
  /** id снимков сущности, свежие сверху — под identity владельца (RLS §4.10). */
  async function versionIdsOf(entityId: string): Promise<string[]> {
    return withIdentity(db, userA, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT id FROM entity_versions WHERE entity_id = ${entityId}
            ORDER BY created_at DESC, id DESC`,
      );
      return [...rows].map((r) => r.id as string);
    });
  }

  /** Action по id из журнала (§4.6): containment по GIN-индексу, как в undo.ts. */
  async function actionOf(actionId: string): Promise<ActionRecord> {
    const probe = JSON.stringify({ actions: [{ id: actionId }] });
    return withIdentity(db, userA, async (tx) => {
      const rows = await tx.execute(
        sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`,
      );
      const meta = rows[0]?.metadata as { actions?: ActionRecord[] } | undefined;
      const action = meta?.actions?.find((a) => a.id === actionId);
      if (!action) throw new Error(`action ${actionId} не найден в журнале`);
      return action;
    });
  }

  test('28. entity_version_pin: снимок тела в журнале, undo удаляет строку физически', async () => {
    const sink = makeChatJournalSink(); // undo ищет action в журнале — NOOP_SINK ему не годится
    const e = firstEntity(
      await execute(
        db,
        req('entity_create', { title: 'Под закрепление', tags: [], body: 'тело' }),
        {
          sink,
        },
      ),
    );
    const pinned = await execute(
      db,
      req('entity_version_pin', { entity_id: e.id, label: 'до правки' }),
      { sink },
    );
    expect(pinned.ok).toBe(true);
    const v = (pinned as ExecuteOk).results[0] as WireEntityVersion;
    expect(v.entityId).toBe(e.id);
    expect(v.label).toBe('до правки');
    expect(v.hasDoc).toBe(true); // тело писал executor — документ у сущности есть
    expect(v.actorKind).toBe('owner');
    expect(await versionIdsOf(e.id)).toEqual([v.id]);

    // Журнал §7.8: свой тип действия и inverse, физически снимающий закрепление
    const actionId = (pinned as ExecuteOk).actionId;
    const action = await actionOf(actionId);
    expect(action.type).toBe('version_pinned');
    expect(action.entity_id).toBe(e.id);
    expect(action.inverse).toEqual([{ op: 'entity_version_delete', payload: { id: v.id } }]);

    const undone = await undoAction(db, { actorUserId: userA, actionId });
    expect(undone.ok).toBe(true);
    expect(await versionIdsOf(e.id)).toEqual([]);
  });

  test('пробельная подпись версии → VALIDATION, строка не появляется', async () => {
    // Подпись — единственное, чем владелец отличает снимки в списке: строка из пробелов
    // рисуется пустотой, а в журнале даёт карточку «Закреплена версия «   »». `min(1)`
    // без trim пропускал бы её, поэтому режем на схеме, а не на экране.
    const e = firstEntity(
      await execute(db, req('entity_create', { title: 'Под пробельную подпись', tags: [] })),
    );
    const r = await execute(db, req('entity_version_pin', { entity_id: e.id, label: '   ' }));
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe('VALIDATION');
    expect(await versionIdsOf(e.id)).toEqual([]);
  });

  test('30. закрепление в batch: снимок берётся из виртуального состояния того же batch', async () => {
    // Сущности на стадии prepare в БД ещё нет — её создаёт ПРЕДЫДУЩАЯ операция batch (§7.8),
    // и тело снимка обязано быть её телом, а не отказом «сущность не найдена».
    const id = newId();
    const r = await execute(db, {
      actorUserId: userA,
      actorKind: 'owner',
      source: 'fast_path',
      clock: () => T0,
      batchId: newId(),
      operations: [
        {
          tool: 'entity_create',
          input: { id, title: 'Создана и закреплена', tags: [], body: 'тело' },
        },
        { tool: 'entity_version_pin', input: { entity_id: id, label: 'сразу' } },
      ],
    });
    expect(r.ok).toBe(true);
    const v = (r as ExecuteOk).results[1] as WireEntityVersion;
    expect(v.entityId).toBe(id);
    expect(await versionIdsOf(id)).toEqual([v.id]);
    const body = await withIdentity(db, userA, async (tx) => {
      const rows = await tx.execute(sql`SELECT body FROM entity_versions WHERE id = ${v.id}`);
      return rows[0]?.body as string;
    });
    expect(body).toBe('тело');
  });

  test('29. закрепление чужой сущности → NOT_FOUND (RLS §4.10), строка не появляется', async () => {
    const e = firstEntity(await execute(db, req('entity_create', { title: 'Моё', tags: [] })));
    const r = await execute(
      db,
      req('entity_version_pin', { entity_id: e.id, label: 'чужая' }, { actorUserId: userB }),
    );
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect(await versionIdsOf(e.id)).toEqual([]);
  });
});

describe('ADE-срез 1: CAS-предусловие entity_update (С7, инвариант 1)', () => {
  /** Сид под предусловие: id задаётся явно — гонка обязана ссылаться на ОДНУ строку. */
  async function create(
    id: string,
    aspects: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    const r = await execute(db, req('entity_create', { id, title: 'Тикет', tags: [], aspects }));
    expect(r.ok).toBe(true);
  }

  /** Захват тикета: planned/inbox → in_progress под предусловием (форма Задачи 10). */
  const capture = (id: string): ExecuteRequest =>
    req('entity_update', {
      id,
      precondition: [{ aspect: 'orbis/task', field: 'status', in: ['inbox', 'planned'] }],
      aspects: { 'orbis/task': { status: 'in_progress' } },
    });

  test('предусловие выполнено → запись; не выполнено → CONFLICT с details {precondition, actual}', async () => {
    const id = newId();
    await create(id, { 'orbis/task': { status: 'planned', priority: 'high' } });

    const ok = await execute(db, capture(id));
    expect(ok.ok).toBe(true);
    const task = aspectOf(firstEntity(ok), 'orbis/task');
    expect(task.status).toBe('in_progress');
    expect(task.priority).toBe('high'); // предусловие не подменяет merge §9.2

    // Повтор: тикет уже захвачен — честный CONFLICT, а не STALE_VERSION и не молчаливая запись.
    const again = await execute(db, capture(id));
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe('CONFLICT');
      expect(again.error.message).toBe('предусловие не выполнено: orbis/task.status');
      // `precondition`/`actual` — ПЕРВЫЙ провалившийся элемент, а не весь массив: CAS-шаг
      // по step_count читает details.precondition.field, чтобы решить, повторять ли попытку.
      // Полный разбор — в mismatches (V1.7): по нему владельцу показывают, что разошлось.
      expect(again.error.details).toEqual({
        reason: 'precondition_failed',
        precondition: { aspect: 'orbis/task', field: 'status', in: ['inbox', 'planned'] },
        actual: 'in_progress',
        mismatches: [
          {
            aspect: 'orbis/task',
            field: 'status',
            expected: ['inbox', 'planned'],
            actual: 'in_progress',
          },
        ],
      });
    }
  });

  test('гонка: два конкурентных перехода planned→in_progress с одним предусловием — ровно один ok', async () => {
    // Пять раундов подряд: одиночный зелёный раунд ничего не доказывает про CAS.
    for (let round = 0; round < 5; round++) {
      const id = newId();
      await create(id, { 'orbis/task': { status: 'planned' } });
      const op = () => execute(db, capture(id));
      const [a, b] = await Promise.all([op(), op()]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const loser = a.ok ? b : a;
      if (!loser.ok) {
        expect(loser.error.code).toBe('CONFLICT');
        expect(loser.error.details).toMatchObject({ reason: 'precondition_failed' });
      }
      // Проигравший не записал ничего: статус ровно один переход от исходного.
      const rows = await withIdentity(db, userA, (tx) =>
        tx.execute(sql`SELECT aspects_legacy FROM entities WHERE id = ${id}`),
      );
      const stored = rows[0]?.aspects_legacy as Record<string, Record<string, unknown>>;
      expect(aspectOf({ aspectsMap: stored }, 'orbis/task').status).toBe('in_progress');
    }
  });

  /** Batch тех же операций: предусловие обязано смотреть в ту же строку, что и merge. */
  function batchReq(operations: Array<{ tool: string; input: unknown }>): ExecuteRequest {
    return {
      actorUserId: userA,
      actorKind: 'owner',
      source: 'fast_path',
      operations,
      batchId: newId(),
      clock: () => T0,
    };
  }

  const capturedThen = (id: string, allowed: string[]) => [
    { tool: 'entity_update', input: { id, aspects: { 'orbis/task': { status: 'in_progress' } } } },
    {
      tool: 'entity_update',
      input: {
        id,
        precondition: [{ aspect: 'orbis/task', field: 'status', in: allowed }],
        aspects: { 'orbis/task': { priority: 'high' } },
      },
    },
  ];

  test('в batch предусловие сверяется по ВИРТУАЛЬНОЙ строке: эффект операции N виден операции N+1', async () => {
    // Строка в БД во время подготовки batch ещё 'planned' (запись — на стадии apply),
    // поэтому эти два случая различают ровно одно: читает ли предусловие ту же строку,
    // что и merge, или делает свой SELECT мимо виртуального состояния.
    const seen = newId();
    await create(seen, { 'orbis/task': { status: 'planned' } });
    const applied = await execute(db, batchReq(capturedThen(seen, ['in_progress'])));
    expect(applied.ok).toBe(true);
    const second = (applied as ExecuteOk).results[1] as WireEntity;
    const after = aspectOf(second, 'orbis/task');
    expect(after.status).toBe('in_progress');
    expect(after.priority).toBe('high');

    // Зеркало: предусловие на ДОБАТЧЕВОЕ значение не выполняется, и batch атомарно откатан.
    const stale = newId();
    await create(stale, { 'orbis/task': { status: 'planned' } });
    const r = await execute(db, batchReq(capturedThen(stale, ['planned'])));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONFLICT');
    const rows = await withIdentity(db, userA, (tx) =>
      tx.execute(sql`SELECT aspects_legacy FROM entities WHERE id = ${stale}`),
    );
    const stored = rows[0]?.aspects_legacy as Record<string, Record<string, unknown>>;
    expect(aspectOf({ aspectsMap: stored }, 'orbis/task').status).toBe('planned');
  });

  test('предусловие по отсутствующему аспекту → CONFLICT (actual undefined)', async () => {
    const id = newId();
    await create(id, { 'orbis/note': {} });

    const r = await execute(db, capture(id));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('CONFLICT');
      expect(r.error.message).toBe('предусловие не выполнено: orbis/task.status');
      const details = r.error.details as { reason: string; actual: unknown };
      expect(details.reason).toBe('precondition_failed');
      // Отсутствующее поле не совпадает ни с чем: захват несуществующего тикета невозможен.
      expect(details.actual).toBeUndefined();
    }
    // Аспект не появился: отказ случился ДО merge.
    const rows = await withIdentity(db, userA, (tx) =>
      tx.execute(sql`SELECT aspects_legacy FROM entities WHERE id = ${id}`),
    );
    expect(Object.keys((rows[0]?.aspects_legacy as Record<string, unknown>) ?? {})).not.toContain(
      'orbis/task',
    );
  });

  test('undefined в списке `in` не делает отсутствующее поле совпадением → CONFLICT', async () => {
    // «Отсутствующее поле не совпадает ни с чем» — обещание докблока assertPrecondition,
    // и до этой страховки оно было условным: сравнение шло через JSON.stringify, а он
    // отображает undefined в undefined, поэтому `in: [undefined]` совпадал с ОТСУТСТВИЕМ
    // поля. Захват «тикета», у которого нужного аспекта нет вовсе, проходил бы по одной
    // опечатке в предусловии — молча и ровно там, где вся конструкция и нужна.
    const id = newId();
    await create(id, { 'orbis/note': {} });
    const r = await execute(
      db,
      req('entity_update', {
        id,
        precondition: [{ aspect: 'orbis/task', field: 'status', in: [undefined] }],
        aspects: { 'orbis/task': { status: 'in_progress' } },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONFLICT');
    const rows = await withIdentity(db, userA, (tx) =>
      tx.execute(sql`SELECT aspects_legacy FROM entities WHERE id = ${id}`),
    );
    expect(Object.keys((rows[0]?.aspects_legacy as Record<string, unknown>) ?? {})).not.toContain(
      'orbis/task',
    );
  });

  test('форма absent (V1.7): поля нет → запись; поле появилось → CONFLICT с expected "absent"', async () => {
    const id = newId();
    await create(id, { 'orbis/task': { status: 'planned' } });

    /** «Проставить срок, пока его не проставили» — ровно та правка, что не должна затирать чужую. */
    const setDue = () =>
      execute(
        db,
        req('entity_update', {
          id,
          precondition: [{ aspect: 'orbis/task', field: 'due_date', absent: true }],
          aspects: { 'orbis/task': { due_date: '2026-08-20' } },
        }),
      );

    const ok = await setDue();
    expect(ok.ok).toBe(true);
    expect(aspectOf(firstEntity(ok), 'orbis/task').due_date).toBe('2026-08-20');

    // Повтор: поле уже есть — предусловие «пока его НЕТ» больше не выполнено.
    const again = await setDue();
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe('CONFLICT');
      expect(again.error.message).toBe('предусловие не выполнено: orbis/task.due_date');
      expect(again.error.details).toEqual({
        reason: 'precondition_failed',
        precondition: { aspect: 'orbis/task', field: 'due_date', absent: true },
        actual: '2026-08-20',
        mismatches: [
          {
            aspect: 'orbis/task',
            field: 'due_date',
            expected: 'absent',
            actual: '2026-08-20',
          },
        ],
      });
    }

    // Отсутствующий аспект — тоже «поля нет»: иначе первую же запись аспекта под absent
    // (её главный случай) нельзя было бы защитить от гонки.
    const bare = newId();
    await create(bare, { 'orbis/note': {} });
    const attached = await execute(
      db,
      req('entity_update', {
        id: bare,
        precondition: [{ aspect: 'orbis/task', field: 'status', absent: true }],
        aspects: { 'orbis/task': { status: 'planned' } },
      }),
    );
    expect(attached.ok).toBe(true);
    expect(aspectOf(firstEntity(attached), 'orbis/task').status).toBe('planned');
  });

  test('mismatches содержит ВСЕ провалившиеся пункты, precondition/actual — первый', async () => {
    // Владельцу показывают, ЧТО разошлось, а не только первое расхождение: предложение
    // рутины применяется «всё или ничего», и «поправь и перезапусти» без полного списка
    // превращается в угадайку. Бросок при этом один — предусловие не выполнено целиком.
    const id = newId();
    await create(id, {
      'orbis/task': { status: 'in_progress', priority: 'high', due_date: '2026-08-20' },
    });

    const r = await execute(
      db,
      req('entity_update', {
        id,
        precondition: [
          { aspect: 'orbis/task', field: 'status', in: ['planned'] }, // провал
          { aspect: 'orbis/task', field: 'priority', in: ['high'] }, // выполнено
          { aspect: 'orbis/task', field: 'due_date', absent: true }, // провал
        ],
        aspects: { 'orbis/task': { status: 'done' } },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('CONFLICT');
      // Сообщение — по первому, но с числом остальных: иначе текст врал бы, что расхождение одно.
      expect(r.error.message).toBe('предусловие не выполнено: orbis/task.status (и ещё 1)');
      const details = r.error.details as {
        precondition: unknown;
        actual: unknown;
        mismatches: unknown[];
      };
      // Совместимость с verbs.ts: preconditionField читает details.precondition.field.
      expect(details.precondition).toEqual({
        aspect: 'orbis/task',
        field: 'status',
        in: ['planned'],
      });
      expect(details.actual).toBe('in_progress');
      expect(details.mismatches).toEqual([
        { aspect: 'orbis/task', field: 'status', expected: ['planned'], actual: 'in_progress' },
        { aspect: 'orbis/task', field: 'due_date', expected: 'absent', actual: '2026-08-20' },
      ]);
    }

    // Отказ на предусловии — до merge: не записано ничего.
    const rows = await withIdentity(db, userA, (tx) =>
      tx.execute(sql`SELECT aspects_legacy FROM entities WHERE id = ${id}`),
    );
    const stored = rows[0]?.aspects_legacy as Record<string, Record<string, unknown>>;
    expect(aspectOf({ aspectsMap: stored }, 'orbis/task').status).toBe('in_progress');
  });
});

describe('D42 ОЧ.13: псевдо-аспект orbis/entity — предусловие по колонке archived', () => {
  /** Сид с явным id: предусловие обязано ссылаться на ОДНУ конкретную строку. */
  async function create(
    id: string,
    aspects: Record<string, Record<string, unknown>> = { 'orbis/note': {} },
  ): Promise<void> {
    const r = await execute(
      db,
      req('entity_create', { id, title: 'Цель отложки', tags: [], aspects }),
    );
    expect(r.ok).toBe(true);
  }

  /** Отложенная архивация в форме Р0-7: «применимо, пока запись НЕ в архиве». */
  const archiveIfLive = (id: string): ExecuteRequest =>
    req('entity_update', {
      id,
      precondition: [{ aspect: 'orbis/entity', field: 'archived', in: [false] }],
      archived: true,
    });

  async function archivedOf(id: string): Promise<boolean> {
    const rows = await withIdentity(db, userA, (tx) =>
      tx.execute(sql`SELECT archived FROM entities WHERE id = ${id}`),
    );
    return rows[0]?.archived as boolean;
  }

  test('archived=false → архивация проходит; повтор по уже архивированной → CONFLICT с mismatch по колонке', async () => {
    const id = newId();
    await create(id);

    const ok = await execute(db, archiveIfLive(id));
    expect(ok.ok).toBe(true);
    expect(await archivedOf(id)).toBe(true);

    // Повтор — ровно тот случай, ради которого предусловие и снимается при постановке
    // отложки: цель успели заархивировать руками, и отложенное действие обязано протухнуть
    // честным CONFLICT, а не молча архивировать второй раз.
    const again = await execute(db, archiveIfLive(id));
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe('CONFLICT');
      expect(again.error.message).toBe('предусловие не выполнено: orbis/entity.archived');
      // Форма расхождения — ПРЕЖНЯЯ (контракт не двигался): псевдо-аспект отличается от
      // настоящего только источником значения, а не формой PreconditionMismatch.
      expect(again.error.details).toEqual({
        reason: 'precondition_failed',
        precondition: { aspect: 'orbis/entity', field: 'archived', in: [false] },
        actual: true,
        mismatches: [
          { aspect: 'orbis/entity', field: 'archived', expected: [false], actual: true },
        ],
      });
    }
  });

  test('неизвестное поле под псевдо-аспектом → CONFLICT (fail-closed), а не молчаливый пропуск', async () => {
    // Поддержана РОВНО одна колонка — archived. Опечатка в имени поля обязана отказать:
    // «предусловие, которое ничего не проверяет» разрешило бы правку ровно там, где его и
    // поставили её запретить (то же правило, что у отсутствующего поля настоящего аспекта).
    const id = newId();
    await create(id);
    const r = await execute(
      db,
      req('entity_update', {
        id,
        precondition: [{ aspect: 'orbis/entity', field: 'нетакого', in: [1] }],
        title: 'Переименована мимо предусловия',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('CONFLICT');
      expect(r.error.message).toBe('предусловие не выполнено: orbis/entity.нетакого');
      expect(r.error.details).toMatchObject({
        reason: 'precondition_failed',
        mismatches: [{ aspect: 'orbis/entity', field: 'нетакого', expected: [1] }],
      });
    }
    // Отказ — до записи: заголовок не поменялся.
    const rows = await withIdentity(db, userA, (tx) =>
      tx.execute(sql`SELECT title FROM entities WHERE id = ${id}`),
    );
    expect(rows[0]?.title).toBe('Цель отложки');
  });

  test('batch: предусловие читает ВИРТУАЛЬНУЮ строку — эффекты предыдущих операций видны', async () => {
    // Стадии 1–4 всех операций batch идут до первой записи, поэтому источником archived
    // обязана быть виртуальная строка BatchState, а не БД: иначе отложка в пачке сверялась бы
    // с состоянием «до пачки».
    const born = newId();
    const okBatch = await execute(db, {
      actorUserId: userA,
      actorKind: 'owner',
      source: 'fast_path',
      clock: () => T0,
      batchId: newId(),
      operations: [
        { tool: 'entity_create', input: { id: born, title: 'Создана в пачке', tags: [] } },
        // В БД строки на этой стадии ещё нет — archived берётся из виртуальной строки create.
        {
          tool: 'entity_update',
          input: {
            id: born,
            precondition: [{ aspect: 'orbis/entity', field: 'archived', in: [false] }],
            archived: true,
          },
        },
      ],
    });
    expect(okBatch.ok).toBe(true);
    expect(await archivedOf(born)).toBe(true);

    const id = newId();
    await create(id);
    const conflict = await execute(db, {
      actorUserId: userA,
      actorKind: 'owner',
      source: 'fast_path',
      clock: () => T0,
      batchId: newId(),
      operations: [
        { tool: 'entity_update', input: { id, archived: true } },
        // Вторая операция обязана УВИДЕТЬ архивацию первой — иначе предусловие в пачке
        // проверяло бы состояние «до пачки» и пропускало бы то, что должно отсекать.
        {
          tool: 'entity_update',
          input: {
            id,
            precondition: [{ aspect: 'orbis/entity', field: 'archived', in: [false] }],
            title: 'Не должна примениться',
          },
        },
      ],
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe('CONFLICT');
      expect(conflict.error.details).toMatchObject({
        reason: 'precondition_failed',
        mismatches: [
          { aspect: 'orbis/entity', field: 'archived', expected: [false], actual: true },
        ],
      });
    }
    // Пачка «всё или ничего»: откатилась и первая операция.
    expect(await archivedOf(id)).toBe(false);
  });

  test('обычные предусловия не изменились: колонка не протекает в НАСТОЯЩИЙ аспект', async () => {
    // Псевдо-аспект — отдельная ветка по точному id, а не «сначала колонки, потом аспекты».
    // Проверяется старое поведение, а не новое: предусловие по полю `archived` НАСТОЯЩЕГО
    // аспекта обязано видеть отсутствие поля в карте аспектов, а не значение колонки строки.
    const id = newId();
    await create(id, { 'orbis/task': { status: 'planned' } });

    // `in: [false]` по несуществующему полю аспекта — расхождение (actual undefined),
    // хотя колонка строки как раз равна false.
    const viaIn = await execute(
      db,
      req('entity_update', {
        id,
        precondition: [{ aspect: 'orbis/task', field: 'archived', in: [false] }],
        title: 'Мимо',
      }),
    );
    expect(viaIn.ok).toBe(false);
    if (!viaIn.ok) {
      expect(viaIn.error.code).toBe('CONFLICT');
      expect(viaIn.error.message).toBe('предусловие не выполнено: orbis/task.archived');
    }

    // Зеркало: `absent` по тому же полю ВЫПОЛНЕНО — в аспекте поля нет, и колонка его не «создаёт».
    const viaAbsent = await execute(
      db,
      req('entity_update', {
        id,
        precondition: [{ aspect: 'orbis/task', field: 'archived', absent: true }],
        title: 'Переименована',
      }),
    );
    expect(viaAbsent.ok).toBe(true);
    expect(firstEntity(viaAbsent).title).toBe('Переименована');
  });

  test('смешанный список: псевдо-аспект и настоящий в одном предусловии, mismatches полный', async () => {
    // Порядок и полнота списка расхождений — прежние: псевдо-аспект встраивается в тот же
    // цикл, а не обрабатывается отдельным проходом.
    const id = newId();
    await create(id, { 'orbis/task': { status: 'in_progress' } });
    const r = await execute(
      db,
      req('entity_update', {
        id,
        precondition: [
          { aspect: 'orbis/task', field: 'status', in: ['planned'] }, // провал
          { aspect: 'orbis/entity', field: 'archived', in: [false] }, // выполнено
          { aspect: 'orbis/entity', field: 'archived', absent: true }, // провал: колонка есть всегда
        ],
        archived: true,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe('предусловие не выполнено: orbis/task.status (и ещё 1)');
      expect((r.error.details as { mismatches: unknown[] }).mismatches).toEqual([
        { aspect: 'orbis/task', field: 'status', expected: ['planned'], actual: 'in_progress' },
        { aspect: 'orbis/entity', field: 'archived', expected: 'absent', actual: false },
      ]);
    }
  });

  test('коллизия невозможна: orbis/entity нельзя завести настоящим аспектом', async () => {
    // Безопасность зарезервированного имени стоит на закрытом реестре ASPECT_SCHEMAS
    // (пин в packages/shared/src/schemas/aspects.test.ts). Здесь проверяется вторая половина:
    // такой аспект нельзя записать в сущность, значит подменить источник значения нечем.
    const id = newId();
    const r = await execute(
      db,
      req('entity_create', {
        id,
        title: 'Подмена псевдо-аспекта',
        tags: [],
        aspects: { 'orbis/entity': { archived: false } },
      }),
    );
    expect(r.ok).toBe(false);
    expect(await countEntities(id)).toBe(0);
  });
});

describe('V1: инвариант субъекта прогона (V1.4)', () => {
  /**
   * Прогон пишет ГЛАГОЛ исполнителя (§А4-4): все его свойства `system_writable` (§А2-5),
   * и без механизма фикстура получала бы `COMPUTED_WRITE` вместо проверяемого инварианта.
   */
  const asVerb = { mechanism: 'verb' } as const;

  /** Прогон в минимальной валидной форме — субъект дописывает тест. */
  const run = (subject: Record<string, unknown>) => ({
    outcome: 'running',
    started_at: '2026-08-18T07:00:00.000Z',
    last_step_at: '2026-08-18T07:00:00.000Z',
    step_count: 0,
    steps: [],
    ...subject,
  });

  test('agent-run с routine_id и без grant_id — принимается; с обоими или без обоих — VALIDATION reason run_subject', async () => {
    const ok = await execute(
      db,
      req(
        'entity_create',
        {
          title: 'Прогон рутины',
          tags: [],
          aspects: { 'orbis/agent-run': run({ routine_id: newId(), bucket: '2026-08-18T07:00' }) },
        },
        asVerb,
      ),
    );
    expect(ok.ok).toBe(true);

    // Два субъекта — не «лишнее поле»: прогон читался бы как тикетный одним кодом
    // (rollback по гранту) и как рутинный другим (бухгалтерия бакета).
    const both = await execute(
      db,
      req(
        'entity_create',
        {
          title: 'Прогон',
          tags: [],
          aspects: { 'orbis/agent-run': run({ grant_id: newId(), routine_id: newId() }) },
        },
        asVerb,
      ),
    );
    expect(both.ok).toBe(false);
    if (!both.ok) {
      expect(both.error.code).toBe('VALIDATION');
      expect((both.error.details as { reason?: string }).reason).toBe('run_subject');
    }

    const none = await execute(
      db,
      req(
        'entity_create',
        { title: 'Прогон', tags: [], aspects: { 'orbis/agent-run': run({}) } },
        asVerb,
      ),
    );
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.error.code).toBe('VALIDATION');
      expect((none.error.details as { reason?: string }).reason).toBe('run_subject');
    }
  });

  test('инвариант держится и на update-, и на attach-пути; правка прогона мимо субъекта проходит', async () => {
    const created = firstEntity(
      await execute(
        db,
        req(
          'entity_create',
          {
            title: 'Прогон рутины',
            tags: [],
            aspects: { 'orbis/agent-run': run({ routine_id: newId() }) },
          },
          asVerb,
        ),
      ),
    );

    // merge аспектов: дописать grant_id живому рутинному прогону — второй субъект
    const upd = await execute(
      db,
      req(
        'entity_update',
        { id: created.id, aspects: { 'orbis/agent-run': { grant_id: newId() } } },
        asVerb,
      ),
    );
    expect(upd.ok).toBe(false);
    if (!upd.ok) {
      expect(upd.error.code).toBe('VALIDATION');
      expect((upd.error.details as { reason?: string }).reason).toBe('run_subject');
    }

    // attach — третий путь появления аспекта: замена целиком, субъекта не осталось.
    // Имя тула — с дефисом: resolveAttachAspect executor'а заменяет в id только «/»
    // (публичное имя реестра `attach_orbis_agent_run` тут неприменимо — прогон служебный
    // и attach-тула не публикует вовсе).
    const att = await execute(
      db,
      req('attach_orbis_agent-run', { entity_id: created.id, data: run({}) }, asVerb),
    );
    expect(att.ok).toBe(false);
    if (!att.ok) {
      expect(att.error.code).toBe('VALIDATION');
      expect((att.error.details as { reason?: string }).reason).toBe('run_subject');
    }

    // Правка, не трогающая субъект, идёт как раньше: шаги прогона пишутся именно так
    const step = await execute(
      db,
      req(
        'entity_update',
        { id: created.id, aspects: { 'orbis/agent-run': { step_count: 1 } } },
        asVerb,
      ),
    );
    expect(step.ok).toBe(true);
  });
});

describe('V1: источник routine не трогает рутины и назначения (V1.10, инвариант 6)', () => {
  /** Рутина в минимальной валидной форме (V1.1); «что делать» живёт в теле. */
  const routine = (over: Record<string, unknown> = {}) => ({
    stage: 'active',
    at: '07:00',
    mode: 'propose',
    ...over,
  });

  /** Прогон рутины в минимальной валидной форме (V1.4) — субъектом routine_id. */
  const run = (routineId: string) => ({
    outcome: 'running',
    started_at: '2026-08-18T07:00:00.000Z',
    last_step_at: '2026-08-18T07:00:00.000Z',
    step_count: 0,
    steps: [],
    routine_id: routineId,
  });

  /** Мутация от лица прогона рутины: source — единственный вход инварианта. */
  const asRoutine = { source: 'routine', actorKind: 'ai' } as const;

  /**
   * Бухгалтерия прогона (Р-7): канал `system`, механизм — глагол исполнителя (§А4-4).
   * Механизм здесь обязателен: свойства прогона `system_writable` (§А2-5), и без него
   * «та же бухгалтерия системой проходит» перестало бы проходить.
   */
  const asAccounting = { source: 'system', actorKind: 'ai', mechanism: 'verb' } as const;

  /** Отказ по объекту — код и причина одни на всех пяти точках проверки. */
  function expectUntouchable(r: Awaited<ReturnType<typeof execute>>): void {
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('FORBIDDEN_LEVEL');
    expect((r.error.details as { reason?: string }).reason).toBe('routine_untouchable');
  }

  test('шесть пар «source routine — отказ / тот же вход из чата и системы — проходит»', async () => {
    // Пара 1: entity_update рутины. Запрет по ОБЪЕКТУ, а не по глаголу: правка одного
    // титула рутины — тоже правка рутины, аспектов патч не трогает вовсе.
    const target = firstEntity(
      await execute(
        db,
        req('entity_create', {
          title: 'Утренний обзор',
          tags: [],
          aspects: { 'orbis/routine': routine() },
        }),
      ),
    );
    expectUntouchable(
      await execute(
        db,
        req('entity_update', { id: target.id, title: 'Переименовал себя' }, asRoutine),
      ),
    );
    const byChat = await execute(
      db,
      req('entity_update', { id: target.id, title: 'Переименовал владелец' }, { source: 'chat' }),
    );
    expect(byChat.ok).toBe(true);

    // Пара 2: attach_orbis_routine — третий путь появления аспекта, им рутина
    // заводится на уже существующей сущности.
    const plain = firstEntity(
      await execute(db, req('entity_create', { title: 'Заметка', tags: [] })),
    );
    expectUntouchable(
      await execute(
        db,
        req('attach_orbis_routine', { entity_id: plain.id, data: routine() }, asRoutine),
      ),
    );
    const attachByChat = await execute(
      db,
      req('attach_orbis_routine', { entity_id: plain.id, data: routine() }, { source: 'chat' }),
    );
    expect(attachByChat.ok).toBe(true);

    // Пара 3: entity_create с orbis/routine — рутина не плодит рутин.
    expectUntouchable(
      await execute(
        db,
        req(
          'entity_create',
          { title: 'Рутина от рутины', tags: [], aspects: { 'orbis/routine': routine() } },
          asRoutine,
        ),
      ),
    );
    const createByChat = await execute(
      db,
      req(
        'entity_create',
        { title: 'Рутина от владельца', tags: [], aspects: { 'orbis/routine': routine() } },
        { source: 'chat' },
      ),
    );
    expect(createByChat.ok).toBe(true);

    // Пара 4: orbis/assignment — второй запрещённый объект: рутина не раздаёт работу
    // исполнителям. Сущность обычная, запрещает именно затронутый аспект.
    const ticket = firstEntity(
      await execute(db, req('entity_create', { title: 'Тикет', tags: [] })),
    );
    expectUntouchable(
      await execute(
        db,
        req(
          'entity_update',
          { id: ticket.id, aspects: { 'orbis/assignment': { executor: 'human', assignee: 'Я' } } },
          asRoutine,
        ),
      ),
    );
    const assignBySystem = await execute(
      db,
      req(
        'entity_update',
        { id: ticket.id, aspects: { 'orbis/assignment': { executor: 'human', assignee: 'Я' } } },
        { source: 'system' },
      ),
    );
    expect(assignBySystem.ok).toBe(true);

    // Пара 5: relation_create с рутиной на конце. Прогон рутины (orbis/agent-run с
    // routine_id) рутиной НЕ является: его создание и связь parent рутина→прогон —
    // бухгалтерия источником system (Р-7), инвариант на них молчит.
    const runEntity = firstEntity(
      await execute(
        db,
        req(
          'entity_create',
          { title: 'Прогон рутины', tags: [], aspects: { 'orbis/agent-run': run(target.id) } },
          asAccounting,
        ),
      ),
    );
    expectUntouchable(
      await execute(
        db,
        req(
          'relation_create',
          { source_id: target.id, target_id: runEntity.id, relation_type: 'parent' },
          asRoutine,
        ),
      ),
    );
    const linkBySystem = await execute(
      db,
      req(
        'relation_create',
        { source_id: target.id, target_id: runEntity.id, relation_type: 'parent' },
        asAccounting,
      ),
    );
    expect(linkBySystem.ok).toBe(true);

    // Пара 6: relation_delete той же связи — «удалить» тоже глагол, объект тот же.
    expectUntouchable(
      await execute(
        db,
        req(
          'relation_delete',
          { source_id: target.id, target_id: runEntity.id, relation_type: 'parent' },
          asRoutine,
        ),
      ),
    );
    const unlinkBySystem = await execute(
      db,
      req(
        'relation_delete',
        { source_id: target.id, target_id: runEntity.id, relation_type: 'parent' },
        asAccounting,
      ),
    );
    expect(unlinkBySystem.ok).toBe(true);
  });

  test('в batch источника routine один запрещённый op валит весь batch ДО записи', async () => {
    const target = firstEntity(
      await execute(
        db,
        req('entity_create', {
          title: 'Рутина под batch',
          tags: [],
          aspects: { 'orbis/routine': routine() },
        }),
      ),
    );
    const newEntityId = newId();

    // Разрешённая операция стоит ПЕРВОЙ: batch валидируется целиком на стадиях 1–4
    // (prepareOp по всем операциям) до первого apply — значит и разрешённая не пишется.
    const r = await execute(db, {
      actorUserId: userA,
      actorKind: 'ai',
      source: 'routine',
      batchId: newId(),
      clock: () => T0,
      operations: [
        { tool: 'entity_create', input: { id: newEntityId, title: 'Итог обзора', tags: [] } },
        { tool: 'entity_update', input: { id: target.id, title: 'Тронул рутину' } },
      ],
    });
    expectUntouchable(r);
    expect(await countEntities(newEntityId)).toBe(0);
  });

  test('архивация рутины источником routine — отказ; та же архивация системой проходит', async () => {
    // Архивация — правка БЕЗ аспектов вовсе: она видна только по `before` уже прочитанной
    // строки. Ветка, ради которой проверка вынесена за гейт `input.aspects`.
    const target = firstEntity(
      await execute(
        db,
        req('entity_create', {
          title: 'Рутина на архивацию',
          tags: [],
          aspects: { 'orbis/routine': routine() },
        }),
      ),
    );
    expectUntouchable(
      await execute(db, req('entity_update', { id: target.id, archived: true }, asRoutine)),
    );
    const bySystem = await execute(
      db,
      req('entity_update', { id: target.id, archived: true }, { source: 'system' }),
    );
    expect(bySystem.ok).toBe(true);
  });

  test('attach ЧУЖОГО аспекта к сущности-рутине источником routine — отказ (запрет по объекту, не по аспекту)', async () => {
    const target = firstEntity(
      await execute(
        db,
        req('entity_create', {
          title: 'Рутина под чужой аспект',
          tags: [],
          aspects: { 'orbis/routine': routine() },
        }),
      ),
    );
    // orbis/note аспектом рутины не является — запрещает сам ОБЪЕКТ (`before` несёт
    // orbis/routine), иначе рутина дописывала бы себе поля мимо запрета
    expectUntouchable(
      await execute(
        db,
        req('attach_orbis_note', { entity_id: target.id, data: { pinned: true } }, asRoutine),
      ),
    );
    const byChat = await execute(
      db,
      req(
        'attach_orbis_note',
        { entity_id: target.id, data: { pinned: true } },
        { source: 'chat' },
      ),
    );
    expect(byChat.ok).toBe(true);
  });

  test('attach_orbis_assignment источником routine — отказ (ветка touched-назначения на attach-пути)', async () => {
    const ticket = firstEntity(
      await execute(db, req('entity_create', { title: 'Тикет под attach', tags: [] })),
    );
    expectUntouchable(
      await execute(
        db,
        req(
          'attach_orbis_assignment',
          { entity_id: ticket.id, data: { executor: 'human', assignee: 'Я' } },
          asRoutine,
        ),
      ),
    );
    const byChat = await execute(
      db,
      req(
        'attach_orbis_assignment',
        { entity_id: ticket.id, data: { executor: 'human', assignee: 'Я' } },
        { source: 'chat' },
      ),
    );
    expect(byChat.ok).toBe(true);
  });

  test('прогоны (orbis/agent-run) для источника routine тоже неприкосновенны: правка/закрытие/создание/связь — отказ; та же бухгалтерия системой проходит', async () => {
    // Рутина в act с entity_update в белом списке знает свой run_id и могла бы подделать
    // «ответ владельца» (reply), закрыть чужие failed-прогоны (обход стоп-крана) или
    // завести фальшивый вопрос другой рутине. Все три — запрет по ОБЪЕКТУ, как и рутина.
    const routineEntity = firstEntity(
      await execute(
        db,
        req('entity_create', {
          title: 'Рутина-хозяйка',
          tags: [],
          aspects: { 'orbis/routine': routine() },
        }),
      ),
    );
    const runEntity = firstEntity(
      await execute(
        db,
        req(
          'entity_create',
          {
            title: 'Прогон под правку',
            tags: [],
            aspects: { 'orbis/agent-run': run(routineEntity.id) },
          },
          asAccounting,
        ),
      ),
    );

    // Правка аспекта прогона (подделка ответа владельца)
    expectUntouchable(
      await execute(
        db,
        req(
          'entity_update',
          {
            id: runEntity.id,
            aspects: {
              'orbis/agent-run': { reply: { text: 'да', at: '2026-08-18T08:00:00.000Z' } },
            },
          },
          asRoutine,
        ),
      ),
    );
    // Правка прогона мимо аспекта (заголовок) — объект тот же
    expectUntouchable(
      await execute(
        db,
        req('entity_update', { id: runEntity.id, title: 'Переписал прогон' }, asRoutine),
      ),
    );
    // Создание прогона (фальшивый вопрос)
    expectUntouchable(
      await execute(
        db,
        req(
          'entity_create',
          {
            title: 'Фальшивый прогон',
            tags: [],
            aspects: { 'orbis/agent-run': { ...run(routineEntity.id), outcome: 'checkpoint' } },
          },
          asRoutine,
        ),
      ),
    );
    // Связь с прогоном на любом конце
    const note = firstEntity(
      await execute(db, req('entity_create', { title: 'Заметка', tags: [] })),
    );
    expectUntouchable(
      await execute(
        db,
        req(
          'relation_create',
          { source_id: note.id, target_id: runEntity.id, relation_type: 'related_to' },
          asRoutine,
        ),
      ),
    );

    // Бухгалтерия прогона источником system проходит как раньше (Р-7)
    const bySystem = await execute(
      db,
      req(
        'entity_update',
        { id: runEntity.id, aspects: { 'orbis/agent-run': { step_count: 1 } } },
        asAccounting,
      ),
    );
    expect(bySystem.ok).toBe(true);
    // Ответ владельца — канал `ui`, механизм `verb`: оси разные и обе значимы. Канал
    // говорит «это рука владельца» (лента и undo смотрят сюда), механизм — «пишется
    // служебное свойство прогона» (§А2-5). Ровно так этот путь и устроен в проде
    // (routers/agent-run.ts): будь механизм умолчательным, ответ владельца получил бы
    // COMPUTED_WRITE.
    const byUi = await execute(
      db,
      req(
        'entity_update',
        {
          id: runEntity.id,
          aspects: { 'orbis/agent-run': { reply: { text: 'да', at: '2026-08-18T08:00:00.000Z' } } },
        },
        { source: 'ui', actorKind: 'owner', mechanism: 'verb' },
      ),
    );
    expect(byUi.ok).toBe(true);
  });
});
