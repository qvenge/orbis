// apps/server/src/executor/relations.test.ts
// Интеграционные тесты relation_create / relation_delete и ГЕНЕРИК-ограничений реестра
// ролей (§А4-2/§А4-3): rel_uniq-повтор, rel_no_self, `acyclic` с путём цикла,
// `target_max_incoming` (замена «одного budget-parent», §13.7), гейт `created_by: system`,
// ветка `instance-of` financial-инварианта (§3.3) и ограничение интервала 7a→0017.
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
  role: string,
  over: Partial<ExecuteRequest> = {},
): Promise<ExecuteResult> {
  return execute(
    db,
    req('relation_create', { source_id: sourceId, target_id: targetId, role }, over),
  );
}

/**
 * Механизм для СИСТЕМНЫХ ролей (§А4-4): `envelope-binding`, `run` и `instance-of` объявлены
 * `created_by: system`, и прямое действие владельца их не ставит. В бою эти рёбра рождают
 * хук бюджета, глаголы исполнителя и материализация; фикстура играет их роль и обязана это
 * назвать вслух — иначе она проверяла бы недостижимое состояние.
 */
const AS_SYSTEM: Partial<ExecuteRequest> = { mechanism: 'seed' };

function finData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amount: '1200.00',
    direction: 'expense',
    category_ref: CATEGORY_REF,
    occurred_on: '2026-07-04',
    ...over,
  };
}

/**
 * Конверт со СВОЕЙ категорией (default — свежий uuid): тесты этого файла проверяют
 * инварианты графа на РУЧНЫХ parent-связях, а с A4 (03-budget §2.3) executor
 * авто-привязывает транзакции к конверту совпадающей категории/периода и энфорсит
 * уникальность комбинации (§2.1) — фикстуры не должны задевать этот контур.
 */
function budgetData(categoryRef: string = newId()): Record<string, unknown> {
  return {
    category_ref: categoryRef,
    limit: '30000.00',
    period_start: '2026-07-01',
    period_end: '2026-07-31',
  };
}

/** Число строк relations по паре концов и роли — админ-DSN (обходит RLS: истина в БД). */
async function relCount(sourceId: string, targetId: string, role: string): Promise<number> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(
      sql`SELECT count(*)::int AS n FROM relations
          WHERE source_id = ${sourceId} AND target_id = ${targetId} AND role = ${role}`,
    );
    return rows[0]?.n as number;
  } finally {
    await adminClient.end();
  }
}

/** Число живых входящих связей роли к target — для проверки `target_max_incoming`. */
async function incomingCount(targetId: string, role: string): Promise<number> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(
      sql`SELECT count(*)::int AS n FROM relations
          WHERE target_id = ${targetId} AND role = ${role}`,
    );
    return rows[0]?.n as number;
  } finally {
    await adminClient.end();
  }
}

/** Значение колонки-проекции у единственной связи пары — пин переходной колонки до 0017. */
async function legacyTypeOf(sourceId: string, targetId: string, role: string): Promise<string> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(
      sql`SELECT relation_type FROM relations
          WHERE source_id = ${sourceId} AND target_id = ${targetId} AND role = ${role}`,
    );
    return rows[0]?.relation_type as string;
  } finally {
    await adminClient.end();
  }
}

/**
 * Источники, которых АГРЕГАТЫ БЮДЖЕТА считают родителями-конвертами транзакции. Запрос
 * повторяет условие `spentByEnvelope` (`budget/aggregates.ts`) дословно: связь по
 * ПЕРЕХОДНОЙ колонке `relation_type='parent'`, источник несёт `orbis/budget`. Роль в этом
 * счёте не участвует — до 0017 агрегаты о ней не знают, и потому именно этот счёт, а не
 * счёт по роли, решает, увидит ли владелец свою тысячу дважды.
 */
async function legacyBudgetParents(targetId: string): Promise<string[]> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(
      sql`SELECT r.source_id FROM relations r
          JOIN entities e ON e.id = r.source_id
          WHERE r.target_id = ${targetId} AND r.relation_type = 'parent'
            AND 'orbis/budget' = ANY(e.aspects)
          ORDER BY r.source_id`,
    );
    return [...rows].map((r) => (r as { source_id: string }).source_id);
  } finally {
    await adminClient.end();
  }
}

/** Прямой вызов эвристики миграции 0016 на временных jsonb-значениях (перепрогон не нужен). */
async function heuristic(rt: string, src: string, tgt: string): Promise<string> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(
      sql`SELECT reform_role_heuristic(${rt}, ${src}::jsonb, ${tgt}::jsonb) AS role`,
    );
    return rows[0]?.role as string;
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
  test('1. happy path mention: строка в БД, wire-форма с ролью, action relation_created с inverse relation_delete', async () => {
    const a = await createEntity({ title: 'Проект' });
    const b = await createEntity({ title: 'Заметка' });
    const sink = new InMemoryJournalSink();
    const r = ok(
      await execute(
        db,
        req('relation_create', { source_id: a.id, target_id: b.id, role: 'mention' }),
        {
          sink,
        },
      ),
    );
    expect(r.idempotentReplay).toBe(false);
    const wire = r.results[0] as WireRelation;
    expect(wire.sourceId).toBe(a.id);
    expect(wire.targetId).toBe(b.id);
    expect(wire.role).toBe('mention');
    expect(wire.createdAt).toBe(T0.toISOString());
    expect(await relCount(a.id, b.id, 'mention')).toBe(1);

    // стадии 6–7: журнал §7.8 — relation_created, inverse — удаление связи
    expect(sink.entries.length).toBe(1);
    const entry = first(sink.entries);
    expect(entry.action.type).toBe('relation_created');
    // Подпись карточки берётся из реестра ролей (Ч10-С3), а не из строки кода
    expect(entry.card.title).toBe('Упоминание: «Проект» → «Заметка»');
    expect(entry.action.inverse).toEqual([
      { op: 'relation_delete', payload: { source_id: a.id, target_id: b.id, role: 'mention' } },
    ]);
  });

  test('2. повтор той же тройки → структурированная INVARIANT duplicate_relation (23505 rel_uniq), не 500; строка одна', async () => {
    const a = await createEntity({ title: 'Дубль-источник' });
    const b = await createEntity({ title: 'Дубль-цель' });
    ok(await createRelation(a.id, b.id, 'mention'));
    const r = err(await createRelation(a.id, b.id, 'mention'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('duplicate_relation');
    expect(await relCount(a.id, b.id, 'mention')).toBe(1);
  });

  test('3. самосвязь → структурированная ошибка (превентивная проверка вместо CHECK rel_no_self), строки нет', async () => {
    const a = await createEntity({ title: 'Нарцисс' });
    const r = err(await createRelation(a.id, a.id, 'mention'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('self_relation');
    expect(await relCount(a.id, a.id, 'mention')).toBe(0);
  });

  test('4. чужая сущность (RLS скрывает) → NOT_FOUND единообразно: и как source, и как target', async () => {
    const mine = await createEntity({ title: 'Своя' });
    const foreign = await createEntity({ title: 'Чужая' }, { actorUserId: userB });

    const asTarget = err(await createRelation(mine.id, foreign.id, 'mention'));
    expect(asTarget.error.code).toBe('NOT_FOUND');

    const asSource = err(await createRelation(foreign.id, mine.id, 'mention'));
    expect(asSource.error.code).toBe('NOT_FOUND');

    expect(await relCount(mine.id, foreign.id, 'mention')).toBe(0);
    expect(await relCount(foreign.id, mine.id, 'mention')).toBe(0);
  });

  test('5. несуществующая сущность → NOT_FOUND', async () => {
    const a = await createEntity({ title: 'Существующая' });
    const r = err(await createRelation(a.id, newId(), 'mention'));
    expect(r.error.code).toBe('NOT_FOUND');
  });
});

describe('ацикличность роли (§А4-2, constraints.acyclic)', () => {
  test('6. цикл A→B→C→A отклонён: INVARIANT, details.path в порядке цикла, титулы в сообщении', async () => {
    const a = await createEntity({ title: 'A-задача' });
    const b = await createEntity({ title: 'B-задача' });
    const c = await createEntity({ title: 'C-задача' });
    ok(await createRelation(b.id, c.id, 'dependency'));
    ok(await createRelation(c.id, a.id, 'dependency'));

    const r = err(await createRelation(a.id, b.id, 'dependency'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('relation_cycle');
    // details.path = [$source, …найденный путь…]: «A → B → C → A»
    expect((r.error.details as { path?: string[] }).path).toEqual([a.id, b.id, c.id, a.id]);
    expect(r.error.message).toContain('A-задача');
    expect(r.error.message).toContain('B-задача');
    expect(r.error.message).toContain('C-задача');
    expect(await relCount(a.id, b.id, 'dependency')).toBe(0);
  });

  test('7. минимальный цикл из двух рёбер: при существующей B→A попытка A→B → path [A, B, A]', async () => {
    const a = await createEntity({ title: 'Взаимный-A' });
    const b = await createEntity({ title: 'Взаимный-B' });
    ok(await createRelation(b.id, a.id, 'dependency'));
    const r = err(await createRelation(a.id, b.id, 'dependency'));
    expect(r.error.code).toBe('INVARIANT');
    expect((r.error.details as { path?: string[] }).path).toEqual([a.id, b.id, a.id]);
  });

  // До фикса: FOR UPDATE брался только на концы нового ребра, а обход графа шёл в
  // READ COMMITTED — конкурентные вставки с непересекающимися вершинами не видели друг
  // друга и вместе замыкали цикл A→B→C→D→A. Теперь записи владельца ПО ЭТОЙ РОЛИ
  // сериализованы advisory-lock'ом `<owner>:<role>`, и ровно одна из двух транзакций проходит.
  test('8. гонка A→B ∥ C→D при существующих B→C и D→A: цикл не замыкается', async () => {
    for (let i = 0; i < 10; i++) {
      const [a, b, c, d] = await Promise.all([
        createEntity({ title: `race-A-${i}` }),
        createEntity({ title: `race-B-${i}` }),
        createEntity({ title: `race-C-${i}` }),
        createEntity({ title: `race-D-${i}` }),
      ]);
      ok(await createRelation(b.id, c.id, 'dependency'));
      ok(await createRelation(d.id, a.id, 'dependency'));

      const [r1, r2] = await Promise.all([
        createRelation(a.id, b.id, 'dependency'),
        createRelation(c.id, d.id, 'dependency'),
      ]);

      const applied = [r1, r2].filter((r) => r.ok).length;
      expect(applied).toBe(1); // второе ребро замкнуло бы цикл — обязано быть отклонено
      const edges =
        (await relCount(a.id, b.id, 'dependency')) + (await relCount(c.id, d.id, 'dependency'));
      expect(edges).toBe(1);
    }
  });

  test('8b. слоёный ромб (~100 рёбер, ~2M простых путей): проверка ацикличности < 1 с — обход по множеству вершин, не по путям', async () => {
    // Экспоненциальный перебор путей (path-массивы) взрывался на сходящихся путях:
    // WIDTH^DEPTH простых путей при WIDTH*DEPTH*2 рёбрах. Множество достижимых
    // вершин (UNION дедупит посещённые) линейно по рёбрам.
    const WIDTH = 5;
    const DEPTH = 9;
    const anchors: WireEntity[] = [];
    for (let i = 0; i <= DEPTH; i++) {
      anchors.push(await createEntity({ title: `ромб-якорь-${i}` }));
    }
    // Слои строятся в порядке цепочки: у target каждого нового ребра ещё нет
    // исходящих рёбер, поэтому сама сборка графа дешева и на старом коде.
    for (let i = 0; i < DEPTH; i++) {
      const from = anchors[i];
      const to = anchors[i + 1];
      if (!from || !to) throw new Error('якоря ромба не собраны');
      const mids = await Promise.all(
        Array.from({ length: WIDTH }, (_, j) => createEntity({ title: `ромб-${i}-${j}` })),
      );
      for (const mid of mids) ok(await createRelation(from.id, mid.id, 'dependency'));
      for (const mid of mids) ok(await createRelation(mid.id, to.id, 'dependency'));
    }
    const head = first(anchors);
    const tail = anchors[DEPTH];
    if (!tail) throw new Error('хвост ромба не собран');

    // Ребро извне в голову ромба: обход стартует с головы и вынужден покрыть весь граф
    const outsider = await createEntity({ title: 'вне ромба' });
    const t0 = performance.now();
    ok(await createRelation(outsider.id, head.id, 'dependency'));
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(1000);

    // Замыкание хвост→голова — цикл: INVARIANT с восстановленным путём (кратчайшим)
    const r = err(await createRelation(tail.id, head.id, 'dependency'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('relation_cycle');
    const path = (r.error.details as { path?: string[] }).path ?? [];
    expect(path[0]).toBe(tail.id);
    expect(path[1]).toBe(head.id);
    expect(path[path.length - 1]).toBe(tail.id);
    expect(path.length).toBe(2 * DEPTH + 2); // кратчайший путь через слои + замыкающее ребро
  }, 240_000);

  test('8. ромб (DAG без цикла) создаётся: сходящиеся пути — не цикл', async () => {
    const a = await createEntity({ title: 'Ромб-A' });
    const b = await createEntity({ title: 'Ромб-B' });
    const c = await createEntity({ title: 'Ромб-C' });
    const d = await createEntity({ title: 'Ромб-D' });
    ok(await createRelation(a.id, b.id, 'dependency'));
    ok(await createRelation(a.id, c.id, 'dependency'));
    ok(await createRelation(b.id, d.id, 'dependency'));
    ok(await createRelation(c.id, d.id, 'dependency'));
    expect(await relCount(c.id, d.id, 'dependency')).toBe(1);
  });
});

describe('target_max_incoming роли envelope-binding (§А4-2; замена «одного budget-parent» §13.7)', () => {
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

  test('9. envelope-binding ×2 на одну транзакцию → INVARIANT target_max_incoming', async () => {
    const { env1, env2, txn } = await budgetFixture();
    ok(await createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM));
    const r = err(await createRelation(env2.id, txn.id, 'envelope-binding', AS_SYSTEM));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('target_max_incoming');
    expect((r.error.details as { role?: string }).role).toBe('envelope-binding');
    expect(await incomingCount(txn.id, 'envelope-binding')).toBe(1);
  });

  test('10. ограничение считает ТОЛЬКО свою роль: subitem проекта и конверт сосуществуют', async () => {
    const { env1, txn } = await budgetFixture();
    const project = await createEntity({ title: 'Проект-родитель' });
    ok(await createRelation(project.id, txn.id, 'subitem'));
    ok(await createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM));
    expect(await incomingCount(txn.id, 'subitem')).toBe(1);
    expect(await incomingCount(txn.id, 'envelope-binding')).toBe(1);
  });

  test('11a. РЕТРОСПЕКТИВНЫЙ путь: attach orbis/budget на источника subitem-ребра к чужому конверту → INVARIANT single_budget_parent (второй вход, §Б-2)', async () => {
    // Ограничение роли смотрит на рёбра ЦЕЛИ и срабатывает на создании ребра. Здесь ребро
    // не создаётся — меняется АСПЕКТ ИСТОЧНИКА, а старую колонку (её ещё читают агрегаты
    // бюджета до 0017) это ретроспективно делает вторым budget-parent'ом. attach обязан
    // быть отклонён — и отказ идёт ИНТЕРВАЛЬНОЙ половиной правила (`legacyInterval`),
    // потому что считает она по множеству старой колонки, а не по одной роли.
    const { env1, txn } = await budgetFixture();
    ok(await createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM));
    const x = await createEntity({ title: 'Будущий конверт' });
    ok(await createRelation(x.id, txn.id, 'subitem')); // роль владельца — легальна (тест 10)

    const r = err(
      await execute(db, req('attach_orbis_budget', { entity_id: x.id, data: budgetData() })),
    );
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('single_budget_parent');
    expect((r.error.details as { legacyInterval?: boolean }).legacyInterval).toBe(true);
    // Аспект не приклеился
    const rows = ok(
      await execute(db, req('entity_update', { id: x.id, title: 'Будущий конверт' })),
    );
    const entity = rows.results[0] as WireEntity;
    expect('orbis/budget' in entity.aspectsMap).toBe(false);
  });

  test('11c. entity_update.aspects с orbis/budget — тот же второй вход, что 11a: INVARIANT single_budget_parent', async () => {
    // Wire-контракт entity_update принимает aspects-патч: mergeAspects добавляет НОВЫЙ
    // ключ — второй путь ретроспективы помимо attach (fix round).
    const { env1, txn } = await budgetFixture();
    ok(await createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM));
    const x = await createEntity({ title: 'Будущий конверт (update)' });
    ok(await createRelation(x.id, txn.id, 'subitem'));

    const r = err(
      await execute(
        db,
        req('entity_update', { id: x.id, aspects: { 'orbis/budget': budgetData() } }),
      ),
    );
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('single_budget_parent');
    // Аспект не приклеился
    const rows = ok(await execute(db, req('entity_update', { id: x.id, title: 'X (update)' })));
    expect('orbis/budget' in (rows.results[0] as WireEntity).aspectsMap).toBe(false);
  });

  test('11d. entity_update.aspects с orbis/budget: детей с другим конвертом нет → разрешён; detach бюджета не проверяется', async () => {
    const txn = await createEntity({
      title: 'Транзакция без конверта (update)',
      aspects: { 'orbis/financial': finData() },
    });
    const x = await createEntity({ title: 'Единственный конверт (update)' });
    ok(await createRelation(x.id, txn.id, 'subitem'));

    const attached = ok(
      await execute(
        db,
        req('entity_update', { id: x.id, aspects: { 'orbis/budget': budgetData() } }),
      ),
    );
    expect('orbis/budget' in (attached.results[0] as WireEntity).aspectsMap).toBe(true);

    // detach (null) не создаёт второго budget-parent'а — инвариант не должен мешать
    const detached = ok(
      await execute(db, req('entity_update', { id: x.id, aspects: { 'orbis/budget': null } })),
    );
    expect('orbis/budget' in (detached.results[0] as WireEntity).aspectsMap).toBe(false);
  });

  test('11b. attach orbis/budget: financial-дети без другого конверта → attach разрешён', async () => {
    const txn = await createEntity({
      title: 'Транзакция без конверта',
      aspects: { 'orbis/financial': finData() },
    });
    const x = await createEntity({ title: 'Единственный конверт' });
    ok(await createRelation(x.id, txn.id, 'subitem'));

    const r = ok(
      await execute(db, req('attach_orbis_budget', { entity_id: x.id, data: budgetData() })),
    );
    const entity = r.results[0] as WireEntity;
    expect('orbis/budget' in entity.aspectsMap).toBe(true);
  });

  test('11. конкурентные привязки к двум конвертам (Promise.all) → ровно одна живая envelope-binding', async () => {
    // 5 прогонов: доказываем сериализацию row-lock'ом, а не удачное расписание
    for (let i = 0; i < 5; i++) {
      const { env1, env2, txn } = await budgetFixture();
      const [r1, r2] = await Promise.all([
        createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM),
        createRelation(env2.id, txn.id, 'envelope-binding', AS_SYSTEM),
      ]);
      const succeeded = [r1, r2].filter((r) => r.ok);
      const failed = [r1, r2].filter((r) => !r.ok) as ExecuteErr[];
      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);
      expect(first(failed).error.code).toBe('INVARIANT');
      expect(invariantOf(first(failed))).toBe('target_max_incoming');
      expect(await incomingCount(txn.id, 'envelope-binding')).toBe(1); // ровно одна связь
    }
  });
});

describe('relation_delete (§4.2)', () => {
  test('12. удаляет строку; action relation_deleted с inverse relation_create', async () => {
    const a = await createEntity({ title: 'Удаляемый-источник' });
    const b = await createEntity({ title: 'Удаляемая-цель' });
    ok(await createRelation(a.id, b.id, 'mention'));

    const sink = new InMemoryJournalSink();
    const r = ok(
      await execute(
        db,
        req('relation_delete', { source_id: a.id, target_id: b.id, role: 'mention' }),
        { sink },
      ),
    );
    const wire = r.results[0] as WireRelation;
    expect(wire.sourceId).toBe(a.id);
    expect(await relCount(a.id, b.id, 'mention')).toBe(0);

    const entry = first(sink.entries);
    expect(entry.action.type).toBe('relation_deleted');
    expect(entry.action.inverse).toEqual([
      {
        op: 'relation_create',
        payload: { source_id: a.id, target_id: b.id, role: 'mention', meta: {} },
      },
    ]);
  });

  test('13. пересоздание после удаления — новая строка с новым id', async () => {
    const a = await createEntity({ title: 'Пересоздание-A' });
    const b = await createEntity({ title: 'Пересоздание-B' });
    const created = ok(await createRelation(a.id, b.id, 'mention'));
    const firstId = (created.results[0] as WireRelation).id;

    ok(
      await execute(
        db,
        req('relation_delete', { source_id: a.id, target_id: b.id, role: 'mention' }),
      ),
    );
    const recreated = ok(await createRelation(a.id, b.id, 'mention'));
    const secondId = (recreated.results[0] as WireRelation).id;
    expect(secondId).not.toBe(firstId);
    expect(await relCount(a.id, b.id, 'mention')).toBe(1);
  });

  test('14. несуществующая связь → NOT_FOUND', async () => {
    const a = await createEntity({ title: 'Без-связи-A' });
    const b = await createEntity({ title: 'Без-связи-B' });
    const r = err(
      await execute(
        db,
        req('relation_delete', { source_id: a.id, target_id: b.id, role: 'dependency' }),
      ),
    );
    expect(r.error.code).toBe('NOT_FOUND');
  });
});

describe('financial-инвариант: ветка instance-of (§3.3)', () => {
  test('15. recurring=true без recurrence: с входящей instance-of — валиден, без — INVARIANT', async () => {
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
    ok(await createRelation(template.id, instance.id, 'instance-of', AS_SYSTEM));

    // инстанс с входящей instance-of: recurring=true валиден без recurrence
    const upd = await execute(
      db,
      req('entity_update', {
        id: instance.id,
        aspects: { 'orbis/financial': { recurring: true } },
      }),
    );
    ok(upd);

    // контроль: та же правка без instance-of → INVARIANT
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

describe('acyclic для category-parent — НОВОЕ поведение реформы (§А4-2, Р-6)', () => {
  function categoryData(): Record<string, unknown> {
    return { icon: '🍏', spend_class: 'discretionary' };
  }

  test('16. цикл в дереве категорий отклонён: до реформы такой связи ничто не мешало', async () => {
    const top = await createEntity({
      title: 'Еда',
      aspects: { 'orbis/category': categoryData() },
    });
    const mid = await createEntity({
      title: 'Продукты',
      aspects: { 'orbis/category': categoryData() },
    });
    ok(await createRelation(top.id, mid.id, 'category-parent'));
    const r = err(await createRelation(mid.id, top.id, 'category-parent'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('relation_cycle');
    expect((r.error.details as { role?: string }).role).toBe('category-parent');
    // Путь цикла — в тексте отказа, титулами, а не голыми id (остаток C: путь)
    expect(r.error.message).toContain('Продукты');
    expect(r.error.message).toContain('Еда');
    expect(await relCount(mid.id, top.id, 'category-parent')).toBe(0);
  });

  test('17. ацикличность считается ПО СВОЕЙ роли: обратное ребро другой роли на той же паре законно', async () => {
    // Достижимость обходит рёбра ТОЛЬКО проверяемой роли. Дерево категорий и граф
    // зависимостей ацикличны независимо, и ребро одной роли не замыкает цикл другой.
    // (Ключ advisory-lock'а тоже разведён по ролям — `<owner>:<role>`, см. `assertAcyclic`;
    // это свойство ПАРАЛЛЕЛИЗМА, а не результата: общий замок дал бы те же ответы, только
    // с лишним ожиданием, и отличить его тестом можно было бы лишь по времени.)
    const a = await createEntity({ title: 'Задача-A' });
    const b = await createEntity({ title: 'Задача-B' });
    ok(await createRelation(a.id, b.id, 'dependency'));
    const catA = await createEntity({
      title: 'Категория-A',
      aspects: { 'orbis/category': categoryData() },
    });
    const catB = await createEntity({
      title: 'Категория-B',
      aspects: { 'orbis/category': categoryData() },
    });
    // Те же две вершины по другой роли: обратное ребро запрещено как dependency, но у
    // категорий своё дерево и своя проверка
    ok(await createRelation(catA.id, catB.id, 'category-parent'));
    ok(await createRelation(catB.id, catA.id, 'dependency')); // обратное ребро ДРУГОЙ роли
    expect(await relCount(catB.id, catA.id, 'dependency')).toBe(1);
    expect(err(await createRelation(b.id, a.id, 'dependency')).error.code).toBe('INVARIANT');
  });
});

describe('гейт created_by: system (§А4-4, отказ ROLE_SYSTEM_ONLY)', () => {
  test('18. role=run из пользовательского вызова → ROLE_SYSTEM_ONLY; тот же вызов механизмом verb — ок', async () => {
    const ticket = await createEntity({ title: 'Тикет' });
    const run = await createEntity({ title: 'Прогон' });
    const denied = err(await createRelation(ticket.id, run.id, 'run'));
    expect(denied.error.code).toBe('ROLE_SYSTEM_ONLY');
    expect((denied.error.details as { role?: string }).role).toBe('run');
    expect(await relCount(ticket.id, run.id, 'run')).toBe(0);

    ok(await createRelation(ticket.id, run.id, 'run', { mechanism: 'verb' }));
    expect(await relCount(ticket.id, run.id, 'run')).toBe(1);
  });

  test('19. хук бюджета ставит envelope-binding САМ (mechanism hook), а тот же вызов владельцем — ROLE_SYSTEM_ONLY', async () => {
    // Хук не зовёт execute — он строит операции в том же контексте и без ЯВНОЙ простановки
    // механизма унаследовал бы `user`, то есть отказал бы системе в её собственной привязке.
    const category = newId();
    const envelope = await createEntity({
      title: 'Конверт хука',
      aspects: { 'orbis/budget': budgetData(category) },
    });
    const txn = await createEntity({
      title: 'Транзакция хука',
      aspects: { 'orbis/financial': finData({ category_ref: category }) },
    });
    // Привязку никто руками не создавал — её создал хук на создании транзакции
    expect(await relCount(envelope.id, txn.id, 'envelope-binding')).toBe(1);

    // …а руками ту же роль поставить нельзя: пусть даже на другой паре
    const other = await createEntity({
      title: 'Ещё транзакция',
      aspects: { 'orbis/financial': finData({ category_ref: newId() }) },
    });
    const denied = err(await createRelation(envelope.id, other.id, 'envelope-binding'));
    expect(denied.error.code).toBe('ROLE_SYSTEM_ONLY');
  });

  test('20. undo хуковой привязки восстанавливает её, хотя роль системная: откат проигрывает СВОЙ inverse', async () => {
    const category = newId();
    const envelope = await createEntity({
      title: 'Конверт отката',
      aspects: { 'orbis/budget': budgetData(category) },
    });
    const sink = new InMemoryJournalSink();
    const created = ok(
      await execute(
        db,
        req('entity_create', {
          title: 'Транзакция отката',
          tags: [],
          aspects: { 'orbis/financial': finData({ category_ref: category }) },
        }),
        { sink },
      ),
    );
    const txn = created.results[0] as WireEntity;
    expect(await relCount(envelope.id, txn.id, 'envelope-binding')).toBe(1);
    // inverse хуковой операции — удаление связи; обратный ей relation_create роли
    // `envelope-binding` гейт пропускать ОБЯЗАН, иначе законную запись нельзя отменить
    const inverse = first(sink.entries).action.inverse;
    expect(inverse.some((op) => op.op === 'relation_delete')).toBe(true);
  });
});

describe('интервал 7a→0017: rel_uniq ещё стоит на проекции роли (находка 55)', () => {
  test('21. subitem + ticket на одной паре → отказ уникальности (ОЖИДАЕМО: обе проецируются в parent)', async () => {
    const project = await createEntity({ title: 'Проект интервала' });
    const child = await createEntity({ title: 'Ребёнок интервала' });
    ok(await createRelation(project.id, child.id, 'subitem'));
    const r = err(await createRelation(project.id, child.id, 'ticket'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('duplicate_relation');
    // Отказ ЧЕСТНО называет причину интервалом, а не выдаёт «такая связь уже есть»
    expect((r.error.details as { legacyInterval?: boolean }).legacyInterval).toBe(true);
    expect((r.error.details as { legacyRelationType?: string }).legacyRelationType).toBe('parent');
    // `details` читает КОД: помешавшая роль — ID, как и соседнее `role`, а не подпись из
    // реестра (та локализована и меняется вместе с label)
    expect((r.error.details as { existingRole?: string }).existingRole).toBe('subitem');
    expect((r.error.details as { role?: string }).role).toBe('ticket');
    // …а человеку подпись достаётся из ТЕКСТА отказа
    expect(r.error.message).toContain('Подпункт');
    expect(await relCount(project.id, child.id, 'ticket')).toBe(0);
  });

  test('22. subitem + mention на одной паре — обе живут: проекции разные', async () => {
    const a = await createEntity({ title: 'Пара-A' });
    const b = await createEntity({ title: 'Пара-B' });
    ok(await createRelation(a.id, b.id, 'subitem'));
    ok(await createRelation(a.id, b.id, 'mention'));
    expect(await relCount(a.id, b.id, 'subitem')).toBe(1);
    expect(await relCount(a.id, b.id, 'mention')).toBe(1);
  });

  test('22a. СМЕНА РОЛИ ребра в интервале — только batch «удалить + создать»', async () => {
    // Единственный способ переименовать роль до 0017: пока `rel_uniq` стоит на проекции,
    // `subitem` и `ticket` на одной паре несовместимы, и создание обязано видеть удаление,
    // сделанное ПРЕДЫДУЩЕЙ операцией того же batch. Без этого пре-чек считал бы дублем
    // строку, которой к моменту вставки уже не будет.
    const a = await createEntity({ title: 'Смена роли — источник' });
    const b = await createEntity({ title: 'Смена роли — цель' });
    ok(await createRelation(a.id, b.id, 'subitem'));

    ok(
      await execute(db, {
        actorUserId: userA,
        actorKind: 'owner',
        source: 'chat',
        batchId: newId(),
        clock: () => T0,
        operations: [
          {
            tool: 'relation_delete',
            input: { source_id: a.id, target_id: b.id, role: 'subitem' },
          },
          {
            tool: 'relation_create',
            input: { source_id: a.id, target_id: b.id, role: 'ticket' },
          },
        ],
      }),
    );
    expect(await relCount(a.id, b.id, 'subitem')).toBe(0);
    expect(await relCount(a.id, b.id, 'ticket')).toBe(1);

    // Контроль: ОБРАТНЫЙ порядок в том же batch — отказ, и это не придирка. Создание идёт
    // до удаления, обе роли живы одновременно, и `rel_uniq` интервала их не вмещает.
    const c = await createEntity({ title: 'Обратный порядок — источник' });
    const d = await createEntity({ title: 'Обратный порядок — цель' });
    ok(await createRelation(c.id, d.id, 'subitem'));
    const r = err(
      await execute(db, {
        actorUserId: userA,
        actorKind: 'owner',
        source: 'chat',
        batchId: newId(),
        clock: () => T0,
        operations: [
          {
            tool: 'relation_create',
            input: { source_id: c.id, target_id: d.id, role: 'ticket' },
          },
          {
            tool: 'relation_delete',
            input: { source_id: c.id, target_id: d.id, role: 'subitem' },
          },
        ],
      }),
    );
    expect((r.error.details as { legacyInterval?: boolean }).legacyInterval).toBe(true);
    expect(await relCount(c.id, d.id, 'subitem')).toBe(1); // batch откатен целиком
  });

  test('23. повтор ТОЙ ЖЕ роли — обычный duplicate_relation, без пометки интервала', async () => {
    const a = await createEntity({ title: 'Повтор-A' });
    const b = await createEntity({ title: 'Повтор-B' });
    ok(await createRelation(a.id, b.id, 'subitem'));
    const r = err(await createRelation(a.id, b.id, 'subitem'));
    expect(invariantOf(r)).toBe('duplicate_relation');
    expect((r.error.details as { legacyInterval?: boolean }).legacyInterval).toBeUndefined();
  });
});

describe('переходная колонка и эвристика миграции 0016', () => {
  test('24. relation_type производится из role ТОТАЛЬНО (все 11 ролей) и даёт ПЯТЬ значений', async () => {
    // Проекция считается ОДНОЙ функцией (`projectLegacyRelationType`), и записывает колонку
    // единственный писатель — INSERT стадии 5. Каждая роль — на своей паре сущностей, иначе
    // роли одной проекции столкнулись бы на `rel_uniq` интервала.
    const cases: Array<[string, string]> = [
      ['subitem', 'parent'],
      ['ticket', 'parent'],
      ['run', 'parent'],
      ['envelope-binding', 'parent'],
      ['category-parent', 'parent'],
      ['dependency', 'blocks'],
      ['mention', 'related_to'],
      ['alternative-of', 'related_to'],
      ['supersedes', 'related_to'],
      ['instance-of', 'derived_from'],
      // `ref` — ОДИННАДЦАТАЯ роль, и её проекция даёт ПЯТОЕ значение колонки, которого в
      // старом закрытом списке из четырёх не было. Строка пишется живьём именно поэтому:
      // 0017 будет решать судьбу колонки по тому, что в ней РЕАЛЬНО лежит, и CHECK на
      // четыре значения такую строку не вместил бы.
      ['ref', 'ref'],
    ];
    for (const [role, legacy] of cases) {
      const a = await createEntity({ title: `Проекция-${role}-A` });
      const b = await createEntity({ title: `Проекция-${role}-B` });
      ok(await createRelation(a.id, b.id, role, AS_SYSTEM));
      expect(await legacyTypeOf(a.id, b.id, role)).toBe(legacy);
    }
    expect(cases.length).toBe(11); // тотальность: ни одна роль не пропущена
    expect([...new Set(cases.map(([, legacy]) => legacy))].sort()).toEqual([
      'blocks',
      'derived_from',
      'parent',
      'ref',
      'related_to',
    ]);
  });

  test('25. reform_role_heuristic: роль из схлопнутого типа — по ОБОИМ концам', async () => {
    // Типы вне `parent` роль определяют целиком, аспекты не спрашиваются
    expect(await heuristic('blocks', '{}', '{}')).toBe('dependency');
    expect(await heuristic('related_to', '{}', '{}')).toBe('mention');
    expect(await heuristic('derived_from', '{}', '{}')).toBe('instance-of');
    // `ref` колонка v1 не знает, но проекция роли `ref` даёт именно его — эвристика с
    // `projectLegacyRelationType` расходиться не вправе
    expect(await heuristic('ref', '{}', '{}')).toBe('ref');

    // Пять смыслов `parent`: КАЖДЫЙ опознаётся обоими концами
    expect(await heuristic('parent', '{}', '{}')).toBe('subitem');
    expect(await heuristic('parent', '{"orbis/budget":{}}', '{"orbis/financial":{}}')).toBe(
      'envelope-binding',
    );
    expect(await heuristic('parent', '{"orbis/category":{}}', '{"orbis/category":{}}')).toBe(
      'category-parent',
    );
    expect(await heuristic('parent', '{}', '{"orbis/agent-run":{}}')).toBe('run');
    expect(await heuristic('parent', '{"orbis/project":{}}', '{"orbis/assignment":{}}')).toBe(
      'ticket',
    );
  });

  test('25a. догадка по ОДНОМУ концу отвергнута: обычный ребёнок конверта остаётся подпунктом', async () => {
    // Ошибка в пользу СИСТЕМНОЙ роли невосстановима: `envelope-binding` владелец обратно
    // не поставит (`ROLE_SYSTEM_ONLY`), а из «Подзадач» такая запись пропадёт.
    expect(await heuristic('parent', '{"orbis/budget":{}}', '{"orbis/note":{}}')).toBe('subitem');
    expect(await heuristic('parent', '{"orbis/budget":{}}', '{"orbis/task":{}}')).toBe('subitem');
    // Дерево категорий требует категорию с ОБЕИХ сторон (как `categoryEdges` агрегатов):
    // задача внутри категории — подпункт, а не ребро дерева
    expect(await heuristic('parent', '{"orbis/task":{}}', '{"orbis/category":{}}')).toBe('subitem');
    // …и симметрично: категория как источник без категории-цели тоже не дерево
    expect(await heuristic('parent', '{"orbis/category":{}}', '{"orbis/note":{}}')).toBe('subitem');
  });

  test('25b. порядок веток значим: запись «и конверт, и категория» — прежде всего конверт', async () => {
    // Единственный образец, где ветки `envelope-binding` и `category-parent` конкурируют:
    // без порядка он вернул бы `category-parent`, и транзакция ушла бы в дерево категорий
    expect(
      await heuristic(
        'parent',
        '{"orbis/budget":{},"orbis/category":{}}',
        '{"orbis/financial":{},"orbis/category":{}}',
      ),
    ).toBe('envelope-binding');
  });

  test('25c. неизвестный relation_type РОНЯЕТ миграцию с именем типа в тексте, а не молчит', async () => {
    // Прежний `ELSE 'subitem'` глотал бы и опечатку, и значение, которого код не знает:
    // граф получил бы «подпункт» там, где смысл был другой, и разобрать это стало бы нечем
    // Drizzle заворачивает ошибку PG, поэтому текст ищется по всей цепочке `cause`:
    // проверять надо СООБЩЕНИЕ БАЗЫ, а не обёртку — обёртка одинакова у любого сбоя
    let chain = '';
    try {
      await heuristic('невиданный', '{}', '{}');
    } catch (e) {
      for (let cur: unknown = e; cur instanceof Error; cur = cur.cause) {
        chain += `${cur.message}\n`;
      }
    }
    expect(chain).toContain('неизвестный relation_type');
    expect(chain).toContain('невиданный');
  });

  test('26. неизвестная роль → VALIDATION «нет такой роли», а не молчаливый parent и не отказ интервала', async () => {
    const a = await createEntity({ title: 'Незнакомая-A' });
    const b = await createEntity({ title: 'Незнакомая-B' });
    const r = err(await createRelation(a.id, b.id, 'нет-такой-роли'));
    expect(r.error.code).toBe('VALIDATION');
    expect(r.error.message).toContain('неизвестная роль');
    expect((r.error.details as { role?: string }).role).toBe('нет-такой-роли');
    // Отказ идёт от РЕЕСТРА, а не от ограничения интервала 0017: у них разные причины и
    // разная судьба (интервальный уходит с contract-миграцией, реестровый остаётся)
    expect((r.error.details as { legacyInterval?: boolean }).legacyInterval).toBeUndefined();
    expect(await relCount(a.id, b.id, 'нет-такой-роли')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ИНТЕРВАЛ 7a→0017: «один budget-parent» на множестве СТАРОЙ колонки
// ---------------------------------------------------------------------------
//
// Роль `envelope-binding` системная — владелец её не ставит вовсе. Но агрегаты бюджета до
// contract-миграции считают детей конверта по ПЕРЕХОДНОЙ колонке (`relation_type='parent'`,
// `spentByEnvelope`), то есть считают и `subitem`, и `ticket`, и любую другую роль владельца,
// проецирующуюся в `parent`. Значит ограничение роли, считающее только свои рёбра, на
// интервале ЗАКРЫВАЕТ НЕ ВСЁ, и владелец видит одну трату в двух конвертах.
//
// Эти тесты держат инвариант на том же множестве, на котором работают агрегаты. Их срок
// жизни — до 0017: когда старая колонка уйдёт, уйдут и они (вместе с правилом Б-2).
describe('интервал 7a→0017: конверт-родитель по СТАРОЙ колонке (§4.2/§13.7)', () => {
  async function twoEnvelopesAndTxn(): Promise<{
    env1: WireEntity;
    env2: WireEntity;
    txn: WireEntity;
  }> {
    // Категории у конвертов РАЗНЫЕ (уникальность §2.1 запрещает две одинаковых комбинации),
    // и это не смягчает задачу: `spentByEnvelope` категорию ребёнка не спрашивает вовсе —
    // он суммирует ВСЕХ parent-детей конверта.
    const env1 = await createEntity({
      title: 'Конверт Еда',
      aspects: { 'orbis/budget': budgetData() },
    });
    const env2 = await createEntity({
      title: 'Конверт Развлечения',
      aspects: { 'orbis/budget': budgetData() },
    });
    const txn = await createEntity({
      title: 'Транзакция на 1200',
      aspects: { 'orbis/financial': finData() },
    });
    return { env1, env2, txn };
  }

  test('27. роль ВЛАДЕЛЬЦА от второго конверта к привязанной транзакции → INVARIANT: двойного счёта не будет', async () => {
    const { env1, env2, txn } = await twoEnvelopesAndTxn();
    ok(await createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM));
    // `subitem` — роль, которую владелец ставит своими руками, и она проецируется в `parent`
    const r = err(await createRelation(env2.id, txn.id, 'subitem'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('single_budget_parent');
    expect((r.error.details as { legacyInterval?: boolean }).legacyInterval).toBe(true);
    // Главное следствие: агрегаты видят РОВНО ОДИН конверт-родитель
    expect(await legacyBudgetParents(txn.id)).toEqual([env1.id]);
  });

  test('28. та же дыра ролью ticket (любая роль владельца, проецирующаяся в parent)', async () => {
    const { env1, env2, txn } = await twoEnvelopesAndTxn();
    ok(await createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM));
    const r = err(await createRelation(env2.id, txn.id, 'ticket'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('single_budget_parent');
    expect(await legacyBudgetParents(txn.id)).toEqual([env1.id]);
  });

  test('29. роль, НЕ проецирующаяся в parent, не ограничена: mention от второго конверта — ок', async () => {
    const { env1, env2, txn } = await twoEnvelopesAndTxn();
    ok(await createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM));
    ok(await createRelation(env2.id, txn.id, 'mention'));
    // `mention` проецируется в `related_to` — агрегаты её не видят, считать нечего
    expect(await legacyBudgetParents(txn.id)).toEqual([env1.id]);
  });

  test('30. источник БЕЗ бюджета не ограничен: subitem проекта к привязанной транзакции — ок', async () => {
    const { env1, txn } = await twoEnvelopesAndTxn();
    ok(await createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM));
    const project = await createEntity({ title: 'Проект-родитель' });
    ok(await createRelation(project.id, txn.id, 'subitem'));
    expect(await legacyBudgetParents(txn.id)).toEqual([env1.id]);
  });

  test('30a. mention-ребёнок конверта НЕ мешает attach: граница множества и сверху тоже', async () => {
    // Расширь кто-нибудь `LEGACY_PARENT_ROLES` — и `attach_orbis_budget` начал бы отказывать
    // владельцу из-за связи, которой агрегаты бюджета не считают вовсе.
    const { env1, txn } = await twoEnvelopesAndTxn();
    ok(await createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM));
    const x = await createEntity({ title: 'Будущий конверт с упоминанием' });
    ok(await createRelation(x.id, txn.id, 'mention'));

    const r = ok(
      await execute(db, req('attach_orbis_budget', { entity_id: x.id, data: budgetData() })),
    );
    expect('orbis/budget' in (r.results[0] as WireEntity).aspectsMap).toBe(true);
    expect(await legacyBudgetParents(txn.id)).toEqual([env1.id]);
  });

  test('31. batch: два subitem от РАЗНЫХ конвертов к одной транзакции → отказ на второй (виртуальный эффект)', async () => {
    const { env1, env2, txn } = await twoEnvelopesAndTxn();
    const r = err(
      await execute(db, {
        actorUserId: userA,
        actorKind: 'owner',
        source: 'chat',
        batchId: newId(),
        clock: () => T0,
        operations: [
          {
            tool: 'relation_create',
            input: { source_id: env1.id, target_id: txn.id, role: 'subitem' },
          },
          {
            tool: 'relation_create',
            input: { source_id: env2.id, target_id: txn.id, role: 'subitem' },
          },
        ],
      }),
    );
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('single_budget_parent');
    // batch атомарен: не записано НИ ОДНО ребро
    expect(await legacyBudgetParents(txn.id)).toEqual([]);
  });

  // Признак «источник — конверт» у ВИРТУАЛЬНОГО ребра batch: он обязан читаться на момент
  // ПРОВЕРКИ, а не на момент создания ребра. Заморозь его — и порядок «сначала связь, потом
  // бюджет» проносит мимо инварианта два конверта на одну транзакцию (тот же двойной счёт,
  // что и в остальных тестах этого describe, только через batch).
  test('31a. batch «сначала рёбра, потом бюджеты»: X и Y становятся конвертами ПОСЛЕ своих subitem → отказ', async () => {
    const { txn } = await twoEnvelopesAndTxn();
    const x = await createEntity({ title: 'X — будущий конверт' });
    const y = await createEntity({ title: 'Y — будущий конверт' });
    const r = err(
      await execute(db, {
        actorUserId: userA,
        actorKind: 'owner',
        source: 'chat',
        batchId: newId(),
        clock: () => T0,
        operations: [
          {
            tool: 'relation_create',
            input: { source_id: x.id, target_id: txn.id, role: 'subitem' },
          },
          {
            tool: 'relation_create',
            input: { source_id: y.id, target_id: txn.id, role: 'subitem' },
          },
          { tool: 'attach_orbis_budget', input: { entity_id: x.id, data: budgetData() } },
          { tool: 'attach_orbis_budget', input: { entity_id: y.id, data: budgetData() } },
        ],
      }),
    );
    // Отказ идёт ИМЕННО от интервальной половины правила, а не от дубля или самосвязи
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('single_budget_parent');
    expect((r.error.details as { legacyInterval?: boolean }).legacyInterval).toBe(true);
    // batch атомарен: ни рёбер, ни аспектов
    expect(await legacyBudgetParents(txn.id)).toEqual([]);
  });

  test('31b. обратный порядок «сначала бюджеты, потом рёбра» — тот же отказ (контроль-регресс)', async () => {
    const { txn } = await twoEnvelopesAndTxn();
    const x = await createEntity({ title: 'X — конверт сразу' });
    const y = await createEntity({ title: 'Y — конверт сразу' });
    const r = err(
      await execute(db, {
        actorUserId: userA,
        actorKind: 'owner',
        source: 'chat',
        batchId: newId(),
        clock: () => T0,
        operations: [
          { tool: 'attach_orbis_budget', input: { entity_id: x.id, data: budgetData() } },
          {
            tool: 'relation_create',
            input: { source_id: x.id, target_id: txn.id, role: 'subitem' },
          },
          { tool: 'attach_orbis_budget', input: { entity_id: y.id, data: budgetData() } },
          {
            tool: 'relation_create',
            input: { source_id: y.id, target_id: txn.id, role: 'subitem' },
          },
        ],
      }),
    );
    expect(invariantOf(r)).toBe('single_budget_parent');
    expect(await legacyBudgetParents(txn.id)).toEqual([]);
  });

  test('31c. ЗЕРКАЛЬНЫЙ случай: источник перестал быть конвертом тем же batch → его ребро не считается', async () => {
    // Признак читается на момент проверки в ОБЕ стороны. Замороженный он запрещал бы здесь
    // законное: у транзакции остаётся ровно один конверт-родитель — Y.
    const { txn } = await twoEnvelopesAndTxn();
    const x = await createEntity({
      title: 'X — конверт, который им быть перестанет',
      aspects: { 'orbis/budget': budgetData() },
    });
    const y = await createEntity({ title: 'Y — будущий конверт' });
    ok(
      await execute(db, {
        actorUserId: userA,
        actorKind: 'owner',
        source: 'chat',
        batchId: newId(),
        clock: () => T0,
        operations: [
          {
            tool: 'relation_create',
            input: { source_id: x.id, target_id: txn.id, role: 'subitem' },
          },
          { tool: 'entity_update', input: { id: x.id, aspects: { 'orbis/budget': null } } },
          {
            tool: 'relation_create',
            input: { source_id: y.id, target_id: txn.id, role: 'subitem' },
          },
          { tool: 'attach_orbis_budget', input: { entity_id: y.id, data: budgetData() } },
        ],
      }),
    );
    expect(await legacyBudgetParents(txn.id)).toEqual([y.id]);
  });

  test('31d. источник, которого batch НЕ трогал, считается по строке БД (фолбэк замороженного признака)', async () => {
    // У такого источника резолвить нечего: его нет в виртуальной карте сущностей batch, и
    // единственная правда о нём — признак, снятый при создании ребра с уже загруженной
    // строки. Снятие фолбэка открыло бы дыру ровно на этом пути.
    const { txn } = await twoEnvelopesAndTxn();
    const x = await createEntity({
      title: 'X — конверт ДО batch',
      aspects: { 'orbis/budget': budgetData() },
    });
    const y = await createEntity({ title: 'Y — будущий конверт' });
    const r = err(
      await execute(db, {
        actorUserId: userA,
        actorKind: 'owner',
        source: 'chat',
        batchId: newId(),
        clock: () => T0,
        operations: [
          {
            tool: 'relation_create',
            input: { source_id: x.id, target_id: txn.id, role: 'subitem' },
          },
          {
            tool: 'relation_create',
            input: { source_id: y.id, target_id: txn.id, role: 'subitem' },
          },
          { tool: 'attach_orbis_budget', input: { entity_id: y.id, data: budgetData() } },
        ],
      }),
    );
    expect(invariantOf(r)).toBe('single_budget_parent');
    expect(await legacyBudgetParents(txn.id)).toEqual([]);
  });

  test('32. ВТОРОЙ ВХОД: attach orbis/budget на источника subitem-ребра, когда у транзакции уже есть subitem от конверта', async () => {
    // Ни одного ребра роли `envelope-binding` в сценарии нет вовсе — ограничение роли здесь
    // молчит по построению, а агрегаты посчитали бы транзакцию дважды.
    const { env1, txn } = await twoEnvelopesAndTxn();
    ok(await createRelation(env1.id, txn.id, 'subitem'));
    const x = await createEntity({ title: 'Будущий конверт (второй вход)' });
    ok(await createRelation(x.id, txn.id, 'subitem'));

    const r = err(
      await execute(db, req('attach_orbis_budget', { entity_id: x.id, data: budgetData() })),
    );
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('single_budget_parent');
    expect(await legacyBudgetParents(txn.id)).toEqual([env1.id]);
  });
});
