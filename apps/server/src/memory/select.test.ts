// apps/server/src/memory/select.test.ts
// Единый отбор записей памяти (`memory/select.ts`) — и схождение его SQL-предиката с
// JS-предикатом клиента (`ruleAppliesTo` из @orbis/shared).
//
// ЗАЧЕМ СХОЖДЕНИЕ ПИННИТСЯ ОТДЕЛЬНО. Сторон у отбора области ровно две и они на разных
// языках: сервер спрашивает базу (`props ->> scope = $1 OR NOT props ? scope`), клиент —
// функцией (грамматика запросов дизъюнкцию «равно ИЛИ отсутствует» не выражает, скобок в
// v1 нет). Разойдясь, они дали бы правило, которое работает в импорте и молчит в быстром
// вводе, — молчаливое расхождение ровно того рода, ради которого селектор стал общим.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId, ruleAppliesTo } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  appDb,
  divergentEntityRow,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import type { ExecuteRequest, ExecuteResult, WireEntity } from '../executor/types';
import { CONTRACT_MONEY_MOVEMENT } from './rules';
import { memoryEntitiesWhere, memoryRulesWhere } from './select';

requireEnv();

const { db, client } = appDb();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

function ok(r: ExecuteResult): WireEntity {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r.results[0] as WireEntity;
}

function req(user: string, operations: ExecuteRequest['operations']): ExecuteRequest {
  return { actorUserId: user, actorKind: 'owner', source: 'ui', operations };
}

async function create(user: string, input: Record<string, unknown>): Promise<WireEntity> {
  return ok(await execute(db, req(user, [{ tool: 'entity_create', input }])));
}

async function titlesOf(user: string, where: ReturnType<typeof memoryRulesWhere>) {
  return withIdentity(db, user, async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT title FROM entities WHERE ${where} ORDER BY title`,
    )) as unknown as Array<{ title: string }>;
    return rows.map((r) => r.title);
  });
}

test('memoryRulesWhere отбирает правила своей области И глобальные; факты, архив и снятый носитель — нет', async () => {
  const user = freshUserId();
  const target = newId();
  await create(user, {
    title: 'КАТ',
    tags: [],
    props: { 'orbis/icon': '🍔' },
    aspects: ['orbis/category'],
  });
  const base = {
    'orbis/memory_kind': 'rule',
    'orbis/rule_pattern': 'пятерочка',
    'orbis/rule_target': target,
  };
  await create(user, {
    title: 'ДЕНЬГИ',
    tags: [],
    props: { ...base, 'orbis/rule_scope': CONTRACT_MONEY_MOVEMENT },
    aspects: ['orbis/memory'],
  });
  await create(user, { title: 'ГЛОБАЛЬНОЕ', tags: [], props: base, aspects: ['orbis/memory'] });
  await create(user, {
    title: 'ЧУЖАЯ-ОБЛАСТЬ',
    tags: [],
    props: { ...base, 'orbis/rule_scope': 'orbis/progress' },
    aspects: ['orbis/memory'],
  });
  await create(user, {
    title: 'ФАКТ',
    tags: [],
    props: { 'orbis/memory_kind': 'fact' },
    aspects: ['orbis/memory'],
  });
  const archived = await create(user, {
    title: 'АРХИВНОЕ',
    tags: [],
    props: { ...base, 'orbis/rule_scope': CONTRACT_MONEY_MOVEMENT },
    aspects: ['orbis/memory'],
  });
  await execute(
    db,
    req(user, [{ tool: 'entity_update', input: { id: archived.id, archived: true } }]),
  );
  // Р9: снятие аспекта НЕ уносит значения из props — и без признака носителя такая запись
  // продолжала бы править категории импорта после того, как владелец снял с неё «память».
  const detached = await create(user, {
    title: 'БЕЗ-НОСИТЕЛЯ',
    tags: [],
    props: { ...base, 'orbis/rule_scope': CONTRACT_MONEY_MOVEMENT },
    aspects: ['orbis/memory'],
  });
  await execute(
    db,
    req(user, [
      { tool: 'entity_update', input: { id: detached.id, aspects: { detach: ['orbis/memory'] } } },
    ]),
  );

  expect(await titlesOf(user, memoryRulesWhere(CONTRACT_MONEY_MOVEMENT))).toEqual([
    'ГЛОБАЛЬНОЕ',
    'ДЕНЬГИ',
  ]);
  // Слой памяти промпта берёт ВСЮ активную память — правила любых областей и факты.
  expect(await titlesOf(user, memoryEntitiesWhere())).toEqual([
    'ГЛОБАЛЬНОЕ',
    'ДЕНЬГИ',
    'ФАКТ',
    'ЧУЖАЯ-ОБЛАСТЬ',
  ]);
});

test('SQL-предикат области и клиентский ruleAppliesTo отвечают одинаково на одних строках', async () => {
  const user = freshUserId();
  const target = newId();
  await create(user, {
    title: 'КАТ',
    tags: [],
    props: { 'orbis/icon': '🍔' },
    aspects: ['orbis/category'],
  });
  const scopes: Array<[string, unknown]> = [
    ['СВОЯ', CONTRACT_MONEY_MOVEMENT],
    ['ЧУЖАЯ', 'orbis/progress'],
    ['НЕТ-КЛЮЧА', undefined],
  ];
  for (const [title, scope] of scopes) {
    await create(user, {
      title,
      tags: [],
      props: {
        'orbis/memory_kind': 'rule',
        'orbis/rule_pattern': 'пятерочка',
        'orbis/rule_target': target,
        ...(scope === undefined ? {} : { 'orbis/rule_scope': scope }),
      },
      aspects: ['orbis/memory'],
    });
  }
  // Ключ ЕСТЬ, значение null: через исполнителя такого не записать (тип свойства — ссылка),
  // но прямой SQL это может, и стороны обязаны совпасть и здесь: `NOT props ? key` ложно.
  await withIdentity(db, user, async (tx) =>
    tx.insert(entities).values(
      divergentEntityRow({
        ownerId: user,
        id: newId(),
        title: 'КЛЮЧ-NULL',
        props: {
          'orbis/memory_kind': 'rule',
          'orbis/rule_pattern': 'пятерочка',
          'orbis/rule_scope': null,
        },
        aspects: ['orbis/memory'],
      }),
    ),
  );

  const fromSql = await titlesOf(user, memoryRulesWhere(CONTRACT_MONEY_MOVEMENT));
  const allRules = await withIdentity(db, user, async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT title, props FROM entities WHERE ${memoryEntitiesWhere()} ORDER BY title`,
    )) as unknown as Array<{ title: string; props: Record<string, unknown> }>;
    return rows;
  });
  const fromJs = allRules
    .filter((r) => ruleAppliesTo(r.props['orbis/rule_scope'], CONTRACT_MONEY_MOVEMENT))
    .map((r) => r.title)
    .sort();
  expect(fromJs).toEqual(fromSql);
  // Проба ЗНАЧИМА только если в наборе есть и попавшие, и отсеянные строки.
  expect(fromSql).toEqual(['НЕТ-КЛЮЧА', 'СВОЯ']);
  expect(allRules.length).toBe(4);
});

/**
 * ГДЕ ЗАМЕР ПЛАНА, А ЕГО ЗДЕСЬ НЕТ.
 *
 * Первая редакция этого файла пиннила план: сеяла 20 000 строк и требовала, чтобы условие
 * по `aspects` стояло `Index Cond` у `entities_aspects_gin`. Пробу сняли — она отвечала не
 * на тот вопрос. EXPLAIN снимался под АДМИН-соединением с дописанным `owner_id = '…'`, то
 * есть RLS ИМИТИРОВАЛАСЬ обычным предикатом; а под ролью приложения тот же `owner_id`
 * приходит security qual'ом политики `owner_owns_row`, и containment (не leakproof)
 * индексным условием стать не может в принципе. Боевой путь — именно роль приложения:
 * все три потребителя селектора идут через `withIdentity`.
 *
 * Проба была зелёной навсегда на пути, которым бой не ходит, — то есть давала ложную
 * уверенность. Замер переехал в `perf/explain.test.ts`, где вердикт снимается под ОБЕИМИ
 * ролями и где рядом запиннена причина (`pg_proc.proleakproof`). Здесь остаётся то, что
 * этому файлу и положено проверять: КОГО селектор отбирает.
 */
