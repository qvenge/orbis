// apps/server/src/executor/relations.test.ts
// Интеграционные тесты Task 10: relation_create / relation_delete + доменные инварианты
// графа (§4.2): rel_uniq-повтор, rel_no_self, ацикличность blocks с путём цикла,
// один budget-parent (§13.7), derived_from-ветка financial-инварианта (§3.3).
// Реальная БД под withIdentity (RLS enforced), без моков.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
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
const userB = freshUserId();
const CATEGORY_REF = '019e4466-aaaa-7e07-b5d4-64be9721da51';
const T0 = new Date('2026-07-05T10:00:00.000Z');

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
  input: Record<string, unknown>,
  over: Partial<ExecuteRequest> = {},
): Promise<WireEntity> {
  const r = ok(await execute(db, req('entity_create', { tags: [], ...input }, over)));
  return r.results[0] as WireEntity;
}

async function createRelation(
  sourceId: string,
  targetId: string,
  relationType: string,
  over: Partial<ExecuteRequest> = {},
): Promise<ExecuteResult> {
  return execute(
    db,
    req(
      'relation_create',
      { source_id: sourceId, target_id: targetId, relation_type: relationType },
      over,
    ),
  );
}

function finData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amount: '1200.00',
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

/** Число строк relations по тройке — админ-DSN (обходит RLS: истина в БД). */
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

/** Число живых parent-связей к target — для проверки «ровно одна» (§13.7). */
async function parentCount(targetId: string): Promise<number> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(
      sql`SELECT count(*)::int AS n FROM relations
          WHERE target_id = ${targetId} AND relation_type = 'parent'`,
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

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('relation_create: базовая семантика (§4.2)', () => {
  test('1. happy path related_to: строка в БД, wire-форма, action relation_created с inverse relation_delete', async () => {
    const a = await createEntity({ title: 'Проект' });
    const b = await createEntity({ title: 'Заметка' });
    const sink = new InMemoryJournalSink();
    const r = ok(
      await execute(
        db,
        req('relation_create', { source_id: a.id, target_id: b.id, relation_type: 'related_to' }),
        { sink },
      ),
    );
    expect(r.idempotentReplay).toBe(false);
    const wire = r.results[0] as WireRelation;
    expect(wire.sourceId).toBe(a.id);
    expect(wire.targetId).toBe(b.id);
    expect(wire.relationType).toBe('related_to');
    expect(wire.createdAt).toBe(T0.toISOString());
    expect(await relCount(a.id, b.id, 'related_to')).toBe(1);

    // стадии 6–7: журнал §7.8 — relation_created, inverse — удаление связи
    expect(sink.entries.length).toBe(1);
    const entry = first(sink.entries);
    expect(entry.action.type).toBe('relation_created');
    expect(entry.action.inverse).toEqual([
      {
        op: 'relation_delete',
        payload: { source_id: a.id, target_id: b.id, relation_type: 'related_to' },
      },
    ]);
  });

  test('2. повтор той же тройки → структурированная INVARIANT duplicate_relation (23505 rel_uniq), не 500; строка одна', async () => {
    const a = await createEntity({ title: 'Дубль-источник' });
    const b = await createEntity({ title: 'Дубль-цель' });
    ok(await createRelation(a.id, b.id, 'related_to'));
    const r = err(await createRelation(a.id, b.id, 'related_to'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('duplicate_relation');
    expect(await relCount(a.id, b.id, 'related_to')).toBe(1);
  });

  test('3. самосвязь → структурированная ошибка (превентивная проверка вместо CHECK rel_no_self), строки нет', async () => {
    const a = await createEntity({ title: 'Нарцисс' });
    const r = err(await createRelation(a.id, a.id, 'related_to'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('self_relation');
    expect(await relCount(a.id, a.id, 'related_to')).toBe(0);
  });

  test('4. чужая сущность (RLS скрывает) → NOT_FOUND единообразно: и как source, и как target', async () => {
    const mine = await createEntity({ title: 'Своя' });
    const foreign = await createEntity({ title: 'Чужая' }, { actorUserId: userB });

    const asTarget = err(await createRelation(mine.id, foreign.id, 'related_to'));
    expect(asTarget.error.code).toBe('NOT_FOUND');

    const asSource = err(await createRelation(foreign.id, mine.id, 'related_to'));
    expect(asSource.error.code).toBe('NOT_FOUND');

    expect(await relCount(mine.id, foreign.id, 'related_to')).toBe(0);
    expect(await relCount(foreign.id, mine.id, 'related_to')).toBe(0);
  });

  test('5. несуществующая сущность → NOT_FOUND', async () => {
    const a = await createEntity({ title: 'Существующая' });
    const r = err(await createRelation(a.id, newId(), 'related_to'));
    expect(r.error.code).toBe('NOT_FOUND');
  });
});

describe('ацикличность blocks (§4.2)', () => {
  test('6. цикл A→B→C→A отклонён: INVARIANT, details.path в порядке цикла, титулы в сообщении', async () => {
    const a = await createEntity({ title: 'A-задача' });
    const b = await createEntity({ title: 'B-задача' });
    const c = await createEntity({ title: 'C-задача' });
    ok(await createRelation(b.id, c.id, 'blocks'));
    ok(await createRelation(c.id, a.id, 'blocks'));

    const r = err(await createRelation(a.id, b.id, 'blocks'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('blocks_cycle');
    // details.path = [$source, …найденный путь…]: «A → B → C → A»
    expect((r.error.details as { path?: string[] }).path).toEqual([a.id, b.id, c.id, a.id]);
    expect(r.error.message).toContain('A-задача');
    expect(r.error.message).toContain('B-задача');
    expect(r.error.message).toContain('C-задача');
    expect(await relCount(a.id, b.id, 'blocks')).toBe(0);
  });

  test('7. минимальный цикл из двух рёбер: при существующей B→A попытка A→B → path [A, B, A]', async () => {
    const a = await createEntity({ title: 'Взаимный-A' });
    const b = await createEntity({ title: 'Взаимный-B' });
    ok(await createRelation(b.id, a.id, 'blocks'));
    const r = err(await createRelation(a.id, b.id, 'blocks'));
    expect(r.error.code).toBe('INVARIANT');
    expect((r.error.details as { path?: string[] }).path).toEqual([a.id, b.id, a.id]);
  });

  // До фикса: FOR UPDATE брался только на концы нового ребра, а обход графа шёл в
  // READ COMMITTED — конкурентные вставки с непересекающимися вершинами не видели друг
  // друга и вместе замыкали цикл A→B→C→D→A. Теперь blocks-записи владельца сериализованы
  // advisory-lock'ом, и ровно одна из двух транзакций проходит.
  test('8. гонка A→B ∥ C→D при существующих B→C и D→A: цикл не замыкается', async () => {
    for (let i = 0; i < 10; i++) {
      const [a, b, c, d] = await Promise.all([
        createEntity({ title: `race-A-${i}` }),
        createEntity({ title: `race-B-${i}` }),
        createEntity({ title: `race-C-${i}` }),
        createEntity({ title: `race-D-${i}` }),
      ]);
      ok(await createRelation(b.id, c.id, 'blocks'));
      ok(await createRelation(d.id, a.id, 'blocks'));

      const [r1, r2] = await Promise.all([
        createRelation(a.id, b.id, 'blocks'),
        createRelation(c.id, d.id, 'blocks'),
      ]);

      const applied = [r1, r2].filter((r) => r.ok).length;
      expect(applied).toBe(1); // второе ребро замкнуло бы цикл — обязано быть отклонено
      const edges = (await relCount(a.id, b.id, 'blocks')) + (await relCount(c.id, d.id, 'blocks'));
      expect(edges).toBe(1);
    }
  });

  test('8. ромб (DAG без цикла) создаётся: сходящиеся пути — не цикл', async () => {
    const a = await createEntity({ title: 'Ромб-A' });
    const b = await createEntity({ title: 'Ромб-B' });
    const c = await createEntity({ title: 'Ромб-C' });
    const d = await createEntity({ title: 'Ромб-D' });
    ok(await createRelation(a.id, b.id, 'blocks'));
    ok(await createRelation(a.id, c.id, 'blocks'));
    ok(await createRelation(b.id, d.id, 'blocks'));
    ok(await createRelation(c.id, d.id, 'blocks'));
    expect(await relCount(c.id, d.id, 'blocks')).toBe(1);
  });
});

describe('один budget-parent (§4.2, §13.7)', () => {
  async function budgetFixture(): Promise<{ env1: WireEntity; env2: WireEntity; txn: WireEntity }> {
    const env1 = await createEntity({
      title: 'Конверт Еда',
      aspects: { 'orbis/budget': budgetData() },
    });
    const env2 = await createEntity({
      title: 'Конверт Развлечения',
      aspects: { 'orbis/budget': budgetData() },
    });
    const txn = await createEntity({
      title: 'Транзакция',
      aspects: { 'orbis/financial': finData() },
    });
    return { env1, env2, txn };
  }

  test('9. последовательно: вторая budget-parent связь к той же транзакции → INVARIANT single_budget_parent', async () => {
    const { env1, env2, txn } = await budgetFixture();
    ok(await createRelation(env1.id, txn.id, 'parent'));
    const r = err(await createRelation(env2.id, txn.id, 'parent'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('single_budget_parent');
    expect(await parentCount(txn.id)).toBe(1);
  });

  test('10. parent от небюджетного источника не ограничен: проект и конверт сосуществуют', async () => {
    const { env1, txn } = await budgetFixture();
    const project = await createEntity({ title: 'Проект-родитель' });
    ok(await createRelation(project.id, txn.id, 'parent'));
    ok(await createRelation(env1.id, txn.id, 'parent')); // parent проекта не мешает конверту
    expect(await parentCount(txn.id)).toBe(2); // проект + один конверт
  });

  test('11. конкурентные привязки к двум конвертам (Promise.all) → ровно одна живая budget-parent (§13.7)', async () => {
    // 5 прогонов: доказываем сериализацию row-lock'ом, а не удачное расписание
    for (let i = 0; i < 5; i++) {
      const { env1, env2, txn } = await budgetFixture();
      const [r1, r2] = await Promise.all([
        createRelation(env1.id, txn.id, 'parent'),
        createRelation(env2.id, txn.id, 'parent'),
      ]);
      const succeeded = [r1, r2].filter((r) => r.ok);
      const failed = [r1, r2].filter((r) => !r.ok) as ExecuteErr[];
      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);
      expect(first(failed).error.code).toBe('INVARIANT');
      expect(invariantOf(first(failed))).toBe('single_budget_parent');
      expect(await parentCount(txn.id)).toBe(1); // ровно одна живая связь
    }
  });
});

describe('relation_delete (§4.2)', () => {
  test('12. удаляет строку; action relation_deleted с inverse relation_create', async () => {
    const a = await createEntity({ title: 'Удаляемый-источник' });
    const b = await createEntity({ title: 'Удаляемая-цель' });
    ok(await createRelation(a.id, b.id, 'related_to'));

    const sink = new InMemoryJournalSink();
    const r = ok(
      await execute(
        db,
        req('relation_delete', { source_id: a.id, target_id: b.id, relation_type: 'related_to' }),
        { sink },
      ),
    );
    const wire = r.results[0] as WireRelation;
    expect(wire.sourceId).toBe(a.id);
    expect(await relCount(a.id, b.id, 'related_to')).toBe(0);

    const entry = first(sink.entries);
    expect(entry.action.type).toBe('relation_deleted');
    expect(entry.action.inverse).toEqual([
      {
        op: 'relation_create',
        payload: { source_id: a.id, target_id: b.id, relation_type: 'related_to', meta: {} },
      },
    ]);
  });

  test('13. пересоздание после удаления — новая строка с новым id', async () => {
    const a = await createEntity({ title: 'Пересоздание-A' });
    const b = await createEntity({ title: 'Пересоздание-B' });
    const created = ok(await createRelation(a.id, b.id, 'related_to'));
    const firstId = (created.results[0] as WireRelation).id;

    ok(
      await execute(
        db,
        req('relation_delete', { source_id: a.id, target_id: b.id, relation_type: 'related_to' }),
      ),
    );
    const recreated = ok(await createRelation(a.id, b.id, 'related_to'));
    const secondId = (recreated.results[0] as WireRelation).id;
    expect(secondId).not.toBe(firstId);
    expect(await relCount(a.id, b.id, 'related_to')).toBe(1);
  });

  test('14. несуществующая связь → NOT_FOUND', async () => {
    const a = await createEntity({ title: 'Без-связи-A' });
    const b = await createEntity({ title: 'Без-связи-B' });
    const r = err(
      await execute(
        db,
        req('relation_delete', { source_id: a.id, target_id: b.id, relation_type: 'blocks' }),
      ),
    );
    expect(r.error.code).toBe('NOT_FOUND');
  });
});

describe('financial-инвариант: ветка derived_from (§3.3)', () => {
  test('15. recurring=true без recurrence: с входящей derived_from — валиден, без — INVARIANT', async () => {
    const template = await createEntity({
      title: 'Шаблон аренды',
      aspects: {
        // шаблон: без occurred_on (§3.3), recurring=true легитимен благодаря recurrence
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
    });
    const instance = await createEntity({
      title: 'Аренда июль',
      aspects: { 'orbis/financial': finData({ amount: '50000.00' }) },
    });
    ok(await createRelation(template.id, instance.id, 'derived_from'));

    // инстанс с входящей derived_from: recurring=true валиден без recurrence
    const upd = await execute(
      db,
      req('entity_update', {
        id: instance.id,
        aspects: { 'orbis/financial': { recurring: true } },
      }),
    );
    ok(upd);

    // контроль: та же правка без derived_from → INVARIANT
    const orphan = await createEntity({
      title: 'Сирота',
      aspects: { 'orbis/financial': finData() },
    });
    const bad = err(
      await execute(
        db,
        req('entity_update', {
          id: orphan.id,
          aspects: { 'orbis/financial': { recurring: true } },
        }),
      ),
    );
    expect(bad.error.code).toBe('INVARIANT');
  });
});
