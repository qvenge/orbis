// apps/server/src/executor/relations.test.ts
// Интеграционные тесты relation_create / relation_delete и ГЕНЕРИК-ограничений реестра
// ролей (§А4-2/§А4-3): rel_uniq-повтор, rel_no_self, `acyclic` с путём цикла,
// `target_max_incoming` (замена «одного budget-parent», §13.7), гейт `created_by: system`,
// ветка `instance-of` financial-инварианта (§3.3) и ограничение интервала 7a→0017.
// Реальная БД под withIdentity (RLS enforced), без моков.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
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

function finProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'orbis/amount': '1200.00',
    'orbis/direction': 'expense',
    'orbis/finance_category': CATEGORY_REF,
    'orbis/occurred_on': '2026-07-04',
    ...over,
  };
}

/**
 * Конверт со СВОЕЙ категорией (default — свежий uuid): тесты этого файла проверяют
 * инварианты графа на РУЧНЫХ parent-связях, а с A4 (03-budget §2.3) executor
 * авто-привязывает транзакции к конверту совпадающей категории/периода и энфорсит
 * уникальность комбинации (§2.1) — фикстуры не должны задевать этот контур.
 */
/** Конверт СВОЙСТВАМИ — она же форма `data` у `attach_*` (§А9-1). */
function budgetProps(categoryRef: string = newId()): Record<string, unknown> {
  return {
    'orbis/finance_category': categoryRef,
    'orbis/limit': '30000.00',
    'orbis/period_start': '2026-07-01',
    'orbis/period_end': '2026-07-31',
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

/**
 * Источники, которых АГРЕГАТЫ БЮДЖЕТА считают родителями-конвертами транзакции. Запрос
 * повторяет условие `spentByEnvelope` (`budget/aggregates.ts`) дословно: связь по
 * ПЕРЕХОДНОЙ колонке `relation_type='parent'`, источник несёт `orbis/budget`. Роль в этом
 * счёте не участвует — до 0017 агрегаты о ней не знают, и потому именно этот счёт, а не
 * счёт по роли, решает, увидит ли владелец свою тысячу дважды.
 */
async function _legacyBudgetParents(targetId: string): Promise<string[]> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(
      sql`SELECT r.source_id FROM relations r
          JOIN entities e ON e.id = r.source_id
          WHERE r.target_id = ${targetId} AND r.role = 'envelope-binding'
            AND 'orbis/budget' = ANY(e.aspects)
          ORDER BY r.source_id`,
    );
    return [...rows].map((r) => (r as { source_id: string }).source_id);
  } finally {
    await adminClient.end();
  }
}

/** Прямой вызов эвристики миграции 0016 на временных jsonb-значениях (перепрогон не нужен). */
async function _heuristic(rt: string, src: string, tgt: string): Promise<string> {
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
      props: budgetProps(),
      aspects: ['orbis/budget'],
    });
    const env2 = await createEntity({
      title: 'Конверт Развлечения',
      props: budgetProps(),
      aspects: ['orbis/budget'],
    });
    const txn = await createEntity({
      title: 'Транзакция',
      props: finProps(),
      aspects: ['orbis/financial'],
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

  test('11a. attach orbis/budget на источника subitem-ребра — РАЗРЕШЁН (ретроспективы больше нет)', async () => {
    // СМЕНА НАБЛЮДАЕМОГО ПОВЕДЕНИЯ, и она названа вслух (обещание PRD 10).
    //
    // До 0017 «конверт-родитель» выражался не ролью, а расширенным множеством ролей с
    // источником-конвертом: навешивание `orbis/budget` ретроспективно превращало ЛЮБОЕ
    // исходящее ребро X (в том числе `subitem`) в привязку, и у транзакции их оказывалось
    // две. Отсюда и был второй, ретроспективный вход в инвариант.
    //
    // Теперь привязка — это роль `envelope-binding` и только она. Навешивание аспекта рёбер
    // не создаёт, а каждое ребро этой роли уже посчитано `target_max_incoming` в момент
    // своего создания: класс исчез вместе с причиной, и проверять на attach нечего.
    const { env1, txn } = await budgetFixture();
    ok(await createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM));
    const x = await createEntity({ title: 'Будущий конверт' });
    ok(await createRelation(x.id, txn.id, 'subitem')); // роль владельца — легальна (тест 10)

    const r = ok(
      await execute(db, req('attach_orbis_budget', { entity_id: x.id, data: budgetProps() })),
    );
    expect((r.results[0] as WireEntity).aspects.includes('orbis/budget')).toBe(true);
    // Привязка у транзакции по-прежнему ОДНА: `subitem` от нового конверта ею не является.
    expect(await incomingCount(txn.id, 'envelope-binding')).toBe(1);
  });

  test('11c. entity_update.aspects с orbis/budget — тем же доводом разрешён', async () => {
    const { env1, txn } = await budgetFixture();
    ok(await createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM));
    const x = await createEntity({ title: 'Будущий конверт (update)' });
    ok(await createRelation(x.id, txn.id, 'subitem'));

    const r = ok(
      await execute(
        db,
        req('entity_update', {
          id: x.id,
          props: budgetProps(),
          aspects: { attach: ['orbis/budget'] },
        }),
      ),
    );
    expect((r.results[0] as WireEntity).aspects.includes('orbis/budget')).toBe(true);
    expect(await incomingCount(txn.id, 'envelope-binding')).toBe(1);
  });

  test('11d. entity_update.aspects с orbis/budget: детей с другим конвертом нет → разрешён; detach бюджета не проверяется', async () => {
    const txn = await createEntity({
      title: 'Транзакция без конверта (update)',
      props: finProps(),
      aspects: ['orbis/financial'],
    });
    const x = await createEntity({ title: 'Единственный конверт (update)' });
    ok(await createRelation(x.id, txn.id, 'subitem'));

    const attached = ok(
      await execute(
        db,
        req('entity_update', {
          id: x.id,
          props: budgetProps(),
          aspects: { attach: ['orbis/budget'] },
        }),
      ),
    );
    expect((attached.results[0] as WireEntity).aspects.includes('orbis/budget')).toBe(true);

    // detach (null) не создаёт второго budget-parent'а — инвариант не должен мешать
    const detached = ok(
      await execute(db, req('entity_update', { id: x.id, aspects: { detach: ['orbis/budget'] } })),
    );
    expect((detached.results[0] as WireEntity).aspects.includes('orbis/budget')).toBe(false);
  });

  test('11b. attach orbis/budget: financial-дети без другого конверта → attach разрешён', async () => {
    const txn = await createEntity({
      title: 'Транзакция без конверта',
      props: finProps(),
      aspects: ['orbis/financial'],
    });
    const x = await createEntity({ title: 'Единственный конверт' });
    ok(await createRelation(x.id, txn.id, 'subitem'));

    const r = ok(
      await execute(db, req('attach_orbis_budget', { entity_id: x.id, data: budgetProps() })),
    );
    const entity = r.results[0] as WireEntity;
    expect(entity.aspects.includes('orbis/budget')).toBe(true);
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
      props: {
        'orbis/amount': '50000.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': CATEGORY_REF,
        'orbis/recurring': true,
        'orbis/start_at': '2026-07-01T10:00:00+03:00',
        'orbis/recurrence': { freq: 'monthly', interval: 1 },
      },
      aspects: ['orbis/financial', 'orbis/schedule'],
    });
    const instance = await createEntity({
      title: 'Аренда июль',
      props: finProps({ 'orbis/amount': '50000.00' }),
      aspects: ['orbis/financial'],
    });
    ok(await createRelation(template.id, instance.id, 'instance-of', AS_SYSTEM));

    // инстанс с входящей instance-of: recurring=true валиден без recurrence
    const upd = await execute(
      db,
      req('entity_update', {
        id: instance.id,
        props: { 'orbis/recurring': true },
        aspects: { attach: ['orbis/financial'] },
      }),
    );
    ok(upd);

    // контроль: та же правка без instance-of → INVARIANT
    const orphan = await createEntity({
      title: 'Сирота',
      props: finProps(),
      aspects: ['orbis/financial'],
    });
    const bad = err(
      await execute(
        db,
        req('entity_update', {
          id: orphan.id,
          props: { 'orbis/recurring': true },
          aspects: { attach: ['orbis/financial'] },
        }),
      ),
    );
    expect(bad.error.code).toBe('INVARIANT');
  });
});

describe('acyclic для category-parent — НОВОЕ поведение реформы (§А4-2, Р-6)', () => {
  function categoryProps(): Record<string, unknown> {
    return { 'orbis/icon': '🍏', 'orbis/spend_class': 'discretionary' };
  }

  test('16. цикл в дереве категорий отклонён: до реформы такой связи ничто не мешало', async () => {
    const top = await createEntity({
      title: 'Еда',
      props: categoryProps(),
      aspects: ['orbis/category'],
    });
    const mid = await createEntity({
      title: 'Продукты',
      props: categoryProps(),
      aspects: ['orbis/category'],
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
      props: categoryProps(),
      aspects: ['orbis/category'],
    });
    const catB = await createEntity({
      title: 'Категория-B',
      props: categoryProps(),
      aspects: ['orbis/category'],
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
      props: budgetProps(category),
      aspects: ['orbis/budget'],
    });
    const txn = await createEntity({
      title: 'Транзакция хука',
      props: finProps({ 'orbis/finance_category': category }),
      aspects: ['orbis/financial'],
    });
    // Привязку никто руками не создавал — её создал хук на создании транзакции
    expect(await relCount(envelope.id, txn.id, 'envelope-binding')).toBe(1);

    // …а руками ту же роль поставить нельзя: пусть даже на другой паре
    const other = await createEntity({
      title: 'Ещё транзакция',
      props: finProps({ 'orbis/finance_category': newId() }),
      aspects: ['orbis/financial'],
    });
    const denied = err(await createRelation(envelope.id, other.id, 'envelope-binding'));
    expect(denied.error.code).toBe('ROLE_SYSTEM_ONLY');
  });

  test('20. undo хуковой привязки восстанавливает её, хотя роль системная: откат проигрывает СВОЙ inverse', async () => {
    const category = newId();
    const envelope = await createEntity({
      title: 'Конверт отката',
      props: budgetProps(category),
      aspects: ['orbis/budget'],
    });
    const sink = new InMemoryJournalSink();
    const created = ok(
      await execute(
        db,
        req('entity_create', {
          title: 'Транзакция отката',
          tags: [],
          props: finProps({ 'orbis/finance_category': category }),
          aspects: ['orbis/financial'],
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

describe('уникальность связи — по РОЛИ (contract-миграция 0017)', () => {
  /**
   * Что изменила 0017 и почему это отдельные тесты, а не правка старых.
   *
   * До неё `rel_uniq` стоял на тройке (source, target, ПРОЕКЦИЯ роли в `relation_type`), и
   * две роли с одной проекцией — `subitem`+`ticket`, `subitem`+`envelope-binding`,
   * `mention`+`supersedes` — на одной паре сущностей были НЕВЫРАЗИМЫ. Отказ приходил с
   * пометкой интервала: «пока нельзя, реформа не доехала». Теперь ключ — сама роль, и обе
   * связи законны; дублем считается только повтор ТОЙ ЖЕ роли.
   */
  test('21. subitem + ticket на одной паре — ОБЕ законны (ключ уникальности — роль)', async () => {
    const project = await createEntity({ title: 'Проект' });
    const child = await createEntity({ title: 'Ребёнок' });
    ok(await createRelation(project.id, child.id, 'subitem'));
    ok(await createRelation(project.id, child.id, 'ticket'));
    expect(await relCount(project.id, child.id, 'subitem')).toBe(1);
    expect(await relCount(project.id, child.id, 'ticket')).toBe(1);
  });

  test('22. повтор ТОЙ ЖЕ роли — duplicate_relation без пометки интервала', async () => {
    const a = await createEntity({ title: 'A' });
    const b = await createEntity({ title: 'B' });
    ok(await createRelation(a.id, b.id, 'mention'));
    const r = err(await createRelation(a.id, b.id, 'mention'));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('duplicate_relation');
    // Пометки интервала больше нет ни у одного отказа: интервал кончился вместе с колонкой.
    expect((r.error.details as { legacyInterval?: boolean }).legacyInterval).toBeUndefined();
  });

  test('23. системная привязка встаёт РЯДОМ с ребром роли владельца на той же паре', async () => {
    // Ровно тот случай, ради которого агрегаты бюджета держали расширенное множество ролей:
    // раньше `envelope-binding` не вставал рядом с `subitem`, и хук был обязан считать чужое
    // ребро привязкой. Теперь встаёт — и «конверт-родитель» выражается одной ролью.
    const envelope = await createEntity({ title: 'Конверт', props: budgetProps() });
    const txn = await createEntity({ title: 'Трата' });
    ok(await createRelation(envelope.id, txn.id, 'subitem'));
    ok(await createRelation(envelope.id, txn.id, 'envelope-binding', AS_SYSTEM));
    expect(await relCount(envelope.id, txn.id, 'subitem')).toBe(1);
    expect(await relCount(envelope.id, txn.id, 'envelope-binding')).toBe(1);
  });
});

describe('конверт-родитель = роль envelope-binding (§4.2/§13.7 после 0017)', () => {
  /**
   * «Один budget-parent» держит ОДНО правило — `target_max_incoming: 1` роли
   * `envelope-binding` в реестре (`assertTargetMaxIncoming`). До 0017 этого было мало:
   * агрегаты считали детей конверта по расширенному множеству ролей, и ребро `subitem` от
   * второго конверта проходило все ролевые проверки, а владелец видел ОДНУ трату в ДВУХ
   * конвертах. Теперь и агрегаты, и хук, и инвариант говорят одной ролью — второго входа в
   * ограничение больше нет, и ретроспективной проверки на attach тоже.
   */
  async function twoEnvelopesAndTxn(): Promise<{
    env1: WireEntity;
    env2: WireEntity;
    txn: WireEntity;
  }> {
    const env1 = await createEntity({ title: 'Конверт 1', props: budgetProps() });
    const env2 = await createEntity({ title: 'Конверт 2', props: budgetProps() });
    const txn = await createEntity({ title: 'Транзакция', props: finProps() });
    return { env1, env2, txn };
  }

  test('второй envelope-binding к той же транзакции → INVARIANT target_max_incoming', async () => {
    const { env1, env2, txn } = await twoEnvelopesAndTxn();
    ok(await createRelation(env1.id, txn.id, 'envelope-binding', AS_SYSTEM));
    const r = err(await createRelation(env2.id, txn.id, 'envelope-binding', AS_SYSTEM));
    expect(r.error.code).toBe('INVARIANT');
    expect(invariantOf(r)).toBe('target_max_incoming');
  });

  test('ребро роли ВЛАДЕЛЬЦА от конверта привязкой НЕ считается и привязке не мешает', async () => {
    // Смена наблюдаемого поведения, названная вслух (обещание PRD 10): до 0017 такое ребро
    // было budget-parent'ом для агрегатов, теперь — обычная иерархия.
    const { env1, env2, txn } = await twoEnvelopesAndTxn();
    ok(await createRelation(env1.id, txn.id, 'subitem'));
    ok(await createRelation(env2.id, txn.id, 'envelope-binding', AS_SYSTEM));
    expect(await relCount(env2.id, txn.id, 'envelope-binding')).toBe(1);
  });
});
