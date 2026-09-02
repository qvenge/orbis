// apps/server/src/registry/ops.test.ts
// Операции реестра через исполнителя (§А10-2, §А2-7, §А3-2, приёмка §С8-5) — против ЖИВОЙ
// базы: это первые писатели реестра снаружи сида, и всё, что здесь проверяется, — про то,
// как они ведут себя с ДАННЫМИ ВЛАДЕЛЬЦА, а не про форму входа.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { parseQueryAst, toParseRegistry } from '@orbis/shared/query';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { entities } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteRequest, ExecuteResult } from '../executor/types';
import { undoAction } from '../executor/undo';
import { approvePending } from '../policy/pending';
import { seedOwnerGraph, seedSmartListId } from '../seed/onboarding';
import { SEED_SMART_LISTS } from '../seed/smart-lists';
import { dispatchTool, type ToolDispatchResult } from '../tools/dispatch';
import { effectiveRegistry } from './cache';
import { collectPropertyHolders } from './ops';
import { readRegistryVersions } from './version';

requireEnv();

const { db, client } = appDb();
const sink = makeChatJournalSink();
const owner = freshUserId();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

/** Одиночная операция реестра владельческим путём — ровно так её зовёт и tRPC-ручка. */
function run(
  tool: string,
  input: unknown,
  over: Partial<ExecuteRequest> = {},
): Promise<ExecuteResult> {
  return execute(
    db,
    {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool, input }],
      ...over,
    },
    { sink },
  );
}

function ok(r: ExecuteResult): { actionId: string; results: unknown[] } {
  if (!r.ok) throw new Error(`ожидался успех, пришёл ${r.error.code}: ${r.error.message}`);
  return { actionId: r.actionId, results: r.results };
}

function err(r: ExecuteResult): { code: string; message: string; details?: unknown } {
  if (r.ok) throw new Error('ожидался отказ, пришёл успех');
  return r.error;
}

/** Строка свойства как она лежит — сверка идёт по КОЛОНКАМ, а не по снимку реестра. */
async function propertyRow(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = (await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT id, key, status, merged_into, scope, type, rank
                   FROM property_definitions WHERE owner_id = ${owner}::uuid AND id = ${id}`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0];
}

async function entityRow(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = (await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT id, props, body, body_doc FROM entities WHERE id = ${id}::uuid`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0];
}

// ---------------------------------------------------------------------------
// §А2-7: жизненный цикл proposed
// ---------------------------------------------------------------------------

describe('property_create / property_update: жизненный цикл proposed (§А2-7, §А10-3)', () => {
  const capOwner = freshUserId();

  function runAs(actor: string, tool: string, input: unknown): Promise<ExecuteResult> {
    return execute(
      db,
      { actorUserId: actor, actorKind: 'ai', source: 'chat', operations: [{ tool, input }] },
      { sink },
    );
  }

  test('proposed ×20 → ок, 21-е → REGISTRY_LIMIT «разберите пачку»', async () => {
    for (let i = 1; i <= 20; i += 1) {
      const r = await runAs(capOwner, 'property_create', {
        label: { en: `Guess ${i}` },
        description: { ru: `Догадка ${i}` },
        type: { kind: 'text' },
        status: 'proposed',
      });
      expect(r.ok).toBe(true);
    }
    const over = err(
      await runAs(capOwner, 'property_create', {
        label: { en: 'Guess 21' },
        description: { ru: 'Догадка 21' },
        type: { kind: 'text' },
        status: 'proposed',
      }),
    );
    expect(over.code).toBe('REGISTRY_LIMIT');
    expect(over.message).toContain('разберите пачку');
    // Кап считает ТОЛЬКО неразобранные: `active` мимо него проходит, иначе владелец,
    // принявший все двадцать, всё равно упирался бы в потолок.
    const active = await runAs(capOwner, 'property_create', {
      label: { en: 'Accepted' },
      description: { ru: 'Принятое' },
      type: { kind: 'text' },
      status: 'active',
    });
    expect(active.ok).toBe(true);
  });

  test('активация proposed → active; отклонение неиспользованного — строка удалена', async () => {
    const created = ok(
      await run('property_create', {
        key: 'user/guess-a',
        label: { ru: 'Догадка А' },
        description: { ru: 'Предложено моделью' },
        type: { kind: 'text' },
        status: 'proposed',
      }),
    );
    const id = (created.results[0] as { property: string }).property;
    expect((await propertyRow(id))?.status).toBe('proposed');

    ok(await run('property_update', { id, status: 'active' }));
    expect((await propertyRow(id))?.status).toBe('active');

    const rejected = ok(
      await run('property_create', {
        key: 'user/guess-b',
        label: { ru: 'Догадка Б' },
        description: { ru: 'Предложено моделью' },
        type: { kind: 'text' },
        status: 'proposed',
      }),
    );
    const rejectedId = (rejected.results[0] as { property: string }).property;
    ok(await run('property_update', { id: rejectedId, status: 'deprecated' }));
    // §А10-3: единственное исключение из «строки реестра не удаляются» — предложение,
    // которым ещё никто не пользовался. Иначе каталог копил бы мёртвые строки, а кап
    // `proposed` считался бы по тому, чего владелец в глаза не видел.
    expect(await propertyRow(rejectedId)).toBeUndefined();
  });

  test('отклонение ИСПОЛЬЗОВАННОГО proposed — deprecated, строка и значения на месте', async () => {
    const created = ok(
      await run('property_create', {
        key: 'user/guess-c',
        label: { ru: 'Догадка В' },
        description: { ru: 'Предложено моделью' },
        type: { kind: 'text' },
        status: 'proposed',
      }),
    );
    const id = (created.results[0] as { property: string }).property;
    const entityId = newId();
    ok(
      await run('entity_create', {
        id: entityId,
        title: 'Запись со значением догадки',
        tags: [],
        props: { [id]: 'что-то' },
      }),
    );
    ok(await run('property_update', { id, status: 'deprecated' }));
    const row = await propertyRow(id);
    expect(row?.status).toBe('deprecated');
    // Значение владельца переживает отклонение (Р9): свойство скрыто, данные целы.
    expect((await entityRow(entityId))?.props).toMatchObject({ [id]: 'что-то' });
  });

  test('deprecate при живых значениях НЕ запирает правку ДРУГИХ свойств записи (§А2-7/§А10-3)', async () => {
    // Канонический жест §А2-7: модель предложила свойство, записала значение, владелец
    // отклонил. «Значения остаются» (Р9) обязано значить, что запись живёт дальше, — иначе
    // они остаются ровно до первой правки: захват тикета исполнителем, `attach_*` и правка
    // любого другого поля упирались бы в `DEPRECATED` по свойству, которого патч не касался.
    const created = ok(
      await run('property_create', {
        key: 'user/guess-lock',
        label: { ru: 'Догадка-замок' },
        description: { ru: 'Предложено моделью' },
        type: { kind: 'text' },
        status: 'proposed',
      }),
    );
    const id = (created.results[0] as { property: string }).property;
    const entityId = newId();
    ok(
      await run('entity_create', {
        id: entityId,
        title: 'Тикет с догадкой',
        tags: [],
        aspects: ['orbis/task'],
        props: { [id]: 'что-то', 'orbis/task_status': 'planned' },
      }),
    );
    ok(await run('property_update', { id, status: 'deprecated' }));

    // 1. Правка ДРУГОГО свойства — тот самый шаг, которым исполнитель захватывает тикет.
    ok(await run('entity_update', { id: entityId, props: { 'orbis/task_status': 'in_progress' } }));
    expect((await entityRow(entityId))?.props).toMatchObject({
      [id]: 'что-то',
      'orbis/task_status': 'in_progress',
    });

    // 2. `attach_*` по ДРУГОМУ аспекту — свободное deprecated-значение ему не помеха.
    ok(
      await run('attach_orbis_note', {
        entity_id: entityId,
        data: { 'orbis/pinned': true },
      }),
    );

    // 3. Вторая половина правила в силе: НОВОЕ значение самого deprecated-свойства — отказ.
    const denied = err(await run('entity_update', { id: entityId, props: { [id]: 'ещё' } }));
    expect(denied.code).toBe('VALIDATION');
    expect(
      (denied.details as { violations: Array<{ code: string; propertyId?: string }> }).violations,
    ).toContainEqual({ code: 'DEPRECATED', propertyId: id });

    // 4. Выход-дверь открыта: снять значение можно.
    ok(await run('entity_update', { id: entityId, unset: [id] }));
  });

  test('слияние В deprecated-цель отвергается: живые значения не прячутся под скрытую строку', async () => {
    const src = ok(
      await run('property_create', {
        key: 'user/merge-src',
        label: { ru: 'Источник слияния' },
        description: { ru: 'Живая строка' },
        type: { kind: 'text' },
        status: 'active',
      }),
    );
    const dst = ok(
      await run('property_create', {
        key: 'user/merge-hidden',
        label: { ru: 'Скрытая цель' },
        description: { ru: 'Выведена из обращения' },
        type: { kind: 'text' },
        status: 'active',
      }),
    );
    const srcId = (src.results[0] as { property: string }).property;
    const dstId = (dst.results[0] as { property: string }).property;
    ok(await run('property_update', { id: dstId, status: 'deprecated' }));

    const e = err(await run('property_merge', { source: srcId, into: dstId }));
    expect(e.code).toBe('VALIDATION');
    expect((e.details as { reason?: string }).reason).toBe('MERGE_DEPRECATED_TARGET');
    // Обратное направление законно: спрятать строку и потом слить её — штатный жест.
    ok(await run('property_merge', { source: dstId, into: srcId }));
  });

  test('key: транслит подписи, коллизия среди ВИДИМОГО разводится суффиксом', async () => {
    const first = ok(
      await run('property_create', {
        label: { ru: 'Усилие' },
        description: { ru: 'Сколько сил' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    expect((first.results[0] as { key: string }).key).toBe('user/usilie');
    const second = ok(
      await run('property_create', {
        label: { ru: 'Усилие' },
        description: { ru: 'Другое усилие' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    expect((second.results[0] as { key: string }).key).toBe('user/usilie-2');
  });

  test('ЯВНЫЙ занятый key — отказ, а не тихий суффикс (адрес называет владелец)', async () => {
    ok(
      await run('property_create', {
        key: 'user/taken-probe',
        label: { ru: 'Занятое' },
        description: { ru: 'Первое с этим ключом' },
        type: { kind: 'text' },
        status: 'active',
      }),
    );
    const e = err(
      await run('property_create', {
        key: 'user/taken-probe',
        label: { ru: 'Дубль' },
        description: { ru: 'Второе с тем же ключом' },
        type: { kind: 'text' },
        status: 'active',
      }),
    );
    expect(e.code).toBe('VALIDATION');
    // Отказ ПРИЛОЖЕНИЯ, а не 23505 из индекса: владельцу нужно имя причины, а не номер
    // ограничения. Автослаг в этом же случае развёл бы суффиксом — разница намеренная.
    expect((e.details as { reason?: string }).reason).toBe('KEY_TAKEN');
  });

  test('reserved-слово грамматики в key РАЗРЕШЕНО (§А2-4: коллизия невозможна по построению)', async () => {
    const r = await run('property_create', {
      key: 'user/limit',
      label: { ru: 'Предел' },
      description: { ru: 'Свойство с зарезервированным словом в имени' },
      type: { kind: 'number' },
      status: 'active',
    });
    expect(r.ok).toBe(true);
  });

  test('правка ВСТРОЕННОГО свойства — отказ с указанием на дельту, а не тихая запись', async () => {
    const e = err(await run('property_update', { id: 'orbis/task_status', label: { ru: 'Моё' } }));
    expect(e.code).toBe('VALIDATION');
    expect((e.details as { reason?: string }).reason).toBe('BUILTIN_IMMUTABLE');
    // Тихая запись сюда означала бы вечный дрейф: `db/registry-drift.ts` сверяет колонку
    // `label` встроенной строки с кодом, а пересев её затирает.
  });
});

// ---------------------------------------------------------------------------
// Четвёртый вход дерева (номер пометкой НЕ ставится: греп в шапке `queryFilterNodeSchema`
// считает МЕСТА ГЕЙТОВ, а тест — не гейт): глубина и статичность на записи определения
// ---------------------------------------------------------------------------

describe('гейты записи определения — четвёртый вход дерева (§А2-1, §А2-2)', () => {
  /** Дерево из N вложенных `not` — ровно тот вход, ради которого гейт и стоит. */
  function deepFilter(levels: number): Record<string, unknown> {
    let node: Record<string, unknown> = { aspect: 'orbis/task' };
    for (let i = 0; i < levels; i += 1) node = { not: node };
    return node;
  }

  test('scope глубже капа — отказ ДО записи (кап один, QUERY_TREE_DEPTH_CAP)', async () => {
    const e = err(
      await run('property_create', {
        key: 'user/too-deep',
        label: { ru: 'Глубокое' },
        description: { ru: 'Слишком вложенный scope' },
        type: { kind: 'number' },
        status: 'active',
        scope: { filter: deepFilter(200) },
      }),
    );
    expect(e.code).toBe('VALIDATION');
    expect((e.details as { reason?: string }).reason).toBe('QUERY_TOO_DEEP');
    expect(await propertyRow('user/too-deep')).toBeUndefined();
  });

  test('ref.target глубже капа — тот же гейт: цель ссылки тоже разворачивается на чтении', async () => {
    const e = err(
      await run('property_create', {
        key: 'user/deep-ref',
        label: { ru: 'Глубокая ссылка' },
        description: { ru: 'target за капом' },
        type: { kind: 'ref', target: { filter: deepFilter(200) } },
        status: 'active',
      }),
    );
    expect((e.details as { reason?: string; where?: string }).where).toBe('ref.target');
  });

  test('scope с date-токеном — SCOPE_NOT_STATIC (первый боевой вызывающий assertStaticQuery)', async () => {
    const e = err(
      await run('property_create', {
        key: 'user/moving-scope',
        label: { ru: 'Подвижное' },
        description: { ru: 'Множество менялось бы каждый день' },
        type: { kind: 'number' },
        status: 'active',
        scope: {
          filter: {
            and: [
              { aspect: 'orbis/task' },
              { prop: 'orbis/due_date', op: 'eq', value: { token: 'today' } },
            ],
          },
        },
      }),
    );
    // Гейт обязан стоять НА ПУТИ ЗАПИСИ, а не рядом: строки в базе после отказа нет.
    expect(e.code).toBe('SCOPE_NOT_STATIC');
    expect(await propertyRow('user/moving-scope')).toBeUndefined();
  });

  test('scope формы «свойство=значение» — отказ SCOPE_SHAPE (№24: только aspect=/tags=)', async () => {
    const e = err(
      await run('property_create', {
        key: 'user/wrong-scope',
        label: { ru: 'Не та форма' },
        description: { ru: 'Условие, которого ни один читатель не проверяет' },
        type: { kind: 'number' },
        status: 'active',
        scope: { filter: { prop: 'orbis/task_status', op: 'eq', value: 'todo' } },
      }),
    );
    expect((e.details as { reason?: string }).reason).toBe('SCOPE_SHAPE');
  });

  test('scope формы aspect= — принимается и ложится в строку', async () => {
    ok(
      await run('property_create', {
        key: 'user/task-column',
        label: { ru: 'Колонка задач' },
        description: { ru: 'Показывается на задачах' },
        type: { kind: 'number' },
        status: 'active',
        scope: { filter: { aspect: 'orbis/task' } },
      }),
    );
    // Строка ищется ПО КЛЮЧУ: id пользовательского свойства — uuid (Р3), и адресовать
    // строку тем именем, которым её назвали, — единственный способ не соврать фикстурой.
    expect((await propertyRowByKey(owner, 'user/task-column'))?.scope).toMatchObject({
      filter: { aspect: 'orbis/task' },
    });
  });

  test('паттерн вне класса RE2 — PATTERN_NOT_REGULAR (§А2-2, причина strict:false D29)', async () => {
    const e = err(
      await run('property_create', {
        key: 'user/lookahead',
        label: { ru: 'С просмотром' },
        description: { ru: 'Паттерн, который не скомпилирует не-ECMA потребитель' },
        type: { kind: 'text', pattern: '^(?!0)\\d+$' },
        status: 'active',
      }),
    );
    expect(e.code).toBe('PATTERN_NOT_REGULAR');
  });
});

// ---------------------------------------------------------------------------
// §А3-2: дельты аспектов
// ---------------------------------------------------------------------------

describe('aspect_delta_set / aspect_delta_remove (§А3-2)', () => {
  const deltaOwner = freshUserId();

  function runDelta(tool: string, input: unknown): Promise<ExecuteResult> {
    return execute(
      db,
      {
        actorUserId: deltaOwner,
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool, input }],
      },
      { sink },
    );
  }

  test('дельта применяется и видна сквозь снимок реестра; повторная перезаписывает', async () => {
    ok(
      await runDelta('aspect_delta_set', {
        aspect: 'orbis/task',
        delta: { label: { ru: 'Дело' } },
      }),
    );
    const reg = await withIdentity(db, deltaOwner, (tx) => effectiveRegistry(tx, deltaOwner));
    expect(reg.aspects.get('orbis/task')?.label.ru).toBe('Дело');

    ok(
      await runDelta('aspect_delta_set', {
        aspect: 'orbis/task',
        delta: { label: { ru: 'Задание' } },
      }),
    );
    const reg2 = await withIdentity(db, deltaOwner, (tx) => effectiveRegistry(tx, deltaOwner));
    expect(reg2.aspects.get('orbis/task')?.label.ru).toBe('Задание');
  });

  test('НЕПРИМЕНИМАЯ дельта отвергается ДО записи — реестр остаётся читаемым', async () => {
    // `applyDeltas` отказывает fail-closed на КАЖДОМ чтении: записанная такая дельта
    // заперла бы владельца снаружи собственного графа до ручной правки базы.
    const e = err(
      await runDelta('aspect_delta_set', {
        aspect: 'orbis/task',
        delta: {
          properties: { relaxRequired: ['orbis/task_status'] },
        },
      }),
    );
    expect((e.details as { reason?: string }).reason).toBe('REQUIRED_NOT_RELAXABLE');
    // И главное: реестр после отказа ЧИТАЕТСЯ, а прежняя дельта на месте.
    const reg = await withIdentity(db, deltaOwner, (tx) => effectiveRegistry(tx, deltaOwner));
    expect(reg.aspects.get('orbis/task')?.label.ru).toBe('Задание');
  });

  test('дельта на несуществующий аспект — NOT_FOUND, строки не появилось', async () => {
    const e = err(
      await runDelta('aspect_delta_set', { aspect: 'user/net-takogo', delta: { icon: '🙂' } }),
    );
    expect(e.code).toBe('NOT_FOUND');
  });

  test('снятие дельты возвращает системное определение', async () => {
    ok(await runDelta('aspect_delta_remove', { aspect: 'orbis/task' }));
    const reg = await withIdentity(db, deltaOwner, (tx) => effectiveRegistry(tx, deltaOwner));
    expect(reg.aspects.get('orbis/task')?.label.ru).not.toBe('Задание');
  });

  test('undo дельты возвращает ПРЕЖНЮЮ настройку, а не снимает её', async () => {
    ok(await runDelta('aspect_delta_set', { aspect: 'orbis/note', delta: { icon: '📗' } }));
    const second = ok(
      await runDelta('aspect_delta_set', { aspect: 'orbis/note', delta: { icon: '📕' } }),
    );
    const undone = await undoAction(db, { actorUserId: deltaOwner, actionId: second.actionId });
    expect(undone.ok).toBe(true);
    const reg = await withIdentity(db, deltaOwner, (tx) => effectiveRegistry(tx, deltaOwner));
    expect(reg.aspects.get('orbis/note')?.viewConfig.icon).toBe('📗');
  });
});

// ---------------------------------------------------------------------------
// §А10-2: слияние
// ---------------------------------------------------------------------------

describe('property_merge (§А10-2, приёмка §С8-5)', () => {
  const mergeOwner = freshUserId();

  function runMerge(tool: string, input: unknown): Promise<ExecuteResult> {
    return execute(
      db,
      { actorUserId: mergeOwner, actorKind: 'owner', source: 'ui', operations: [{ tool, input }] },
      { sink },
    );
  }

  async function ownRow(id: string): Promise<Record<string, unknown> | undefined> {
    const rows = (await withIdentity(db, mergeOwner, (tx) =>
      tx.execute(sql`SELECT id, status, merged_into, type FROM property_definitions
                     WHERE owner_id = ${mergeOwner}::uuid AND id = ${id}`),
    )) as unknown as Array<Record<string, unknown>>;
    return rows[0];
  }

  async function ownEntity(id: string): Promise<Record<string, unknown>> {
    const rows = (await withIdentity(db, mergeOwner, (tx) =>
      tx.execute(sql`SELECT props, body, body_doc FROM entities WHERE id = ${id}::uuid`),
    )) as unknown as Array<Record<string, unknown>>;
    const row = rows[0];
    if (row === undefined) throw new Error(`сущности ${id} нет`);
    return row;
  }

  /** Та же строка, но с ОБОИМИ индексами имён: их пишет тот же UPDATE, что и тело. */
  async function ownEntityRefs(id: string): Promise<{
    body: string;
    body_doc: unknown;
    body_refs: string[];
    query_refs: string[];
  }> {
    const rows = (await withIdentity(db, mergeOwner, (tx) =>
      tx.execute(sql`SELECT body, body_doc, body_refs, query_refs FROM entities
                     WHERE id = ${id}::uuid`),
    )) as unknown as Array<Record<string, unknown>>;
    const row = rows[0];
    if (row === undefined) throw new Error(`сущности ${id} нет`);
    return {
      body: String(row.body ?? ''),
      body_doc: row.body_doc ?? null,
      body_refs: (row.body_refs ?? []) as string[],
      query_refs: (row.query_refs ?? []) as string[],
    };
  }

  /** Query-блоки документа по порядку: сверять надо АТРИБУТЫ, а не подстроку в JSON. */
  function queryBlocksOf(doc: unknown, expected: number): Array<{ ast: unknown; text: unknown }> {
    const found: Array<{ ast: unknown; text: unknown }> = [];
    const walk = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      const rec = node as Record<string, unknown>;
      if (rec.type === 'queryBlock') {
        const attrs = (rec.attrs ?? {}) as Record<string, unknown>;
        found.push({ ast: attrs.ast ?? null, text: attrs.text ?? null });
      }
      for (const child of (rec.content ?? []) as unknown[]) walk(child);
    };
    walk((doc as { doc?: unknown })?.doc);
    if (found.length !== expected) {
      throw new Error(`ожидалось ${expected} query-блоков, найдено ${found.length}`);
    }
    return found;
  }

  test('значения переписаны, merged_into проставлен, AST в progress_source/ref.target переписан; undo → байт-в-байт', async () => {
    // `scope` в этот перечень войти НЕ МОЖЕТ: форма №24 допускает в нём только `aspect=`
    // и `tags=`, то есть ссылки на СВОЙСТВО там не бывает. Реестровую сторону переписывания
    // держит `ref.target` — колонка `type`; обе идут одним `rewriteAst`, и ниже проверено,
    // что `scope` соседней строки слиянием не тронут.
    const source = ok(
      await runMerge('property_create', {
        key: 'user/effort',
        label: { ru: 'Усилие' },
        description: { ru: 'Старое поле' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    const into = ok(
      await runMerge('property_create', {
        key: 'user/energy',
        label: { ru: 'Энергия' },
        description: { ru: 'Новое поле' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    const sourceId = (source.results[0] as { property: string }).property;
    const intoId = (into.results[0] as { property: string }).property;
    const intoKey = (into.results[0] as { key: string }).key;

    // Ссылочное свойство, чья ЦЕЛЬ упоминает поглощаемое свойство.
    ok(
      await runMerge('property_create', {
        key: 'user/hard-task',
        label: { ru: 'Трудная задача' },
        description: { ru: 'Ссылка на задачу с усилием' },
        type: {
          kind: 'ref',
          target: {
            filter: {
              and: [{ aspect: 'orbis/task' }, { prop: sourceId, op: 'gt', value: 3 }],
            },
          },
        },
        status: 'active',
      }),
    );
    // Соседняя строка со `scope` — контроль: слияние её трогать не должно.
    ok(
      await runMerge('property_create', {
        key: 'user/untouched-scope',
        label: { ru: 'Не трогать' },
        description: { ru: 'scope называет только аспект' },
        type: { kind: 'number' },
        status: 'active',
        scope: { filter: { aspect: 'orbis/task' } },
      }),
    );

    const onlySource = newId();
    const bothSame = newId();
    const goal = newId();
    const withBody = newId();
    await execute(
      db,
      {
        actorUserId: mergeOwner,
        actorKind: 'owner',
        source: 'ui',
        batchId: newId(),
        operations: [
          {
            tool: 'entity_create',
            input: { id: onlySource, title: 'Только старое', tags: [], props: { [sourceId]: 5 } },
          },
          {
            tool: 'entity_create',
            input: {
              id: bothSame,
              title: 'Оба, но одинаково',
              tags: [],
              props: { [sourceId]: 7, [intoId]: 7 },
            },
          },
          {
            tool: 'entity_create',
            input: {
              id: goal,
              title: 'Цель по усилию',
              tags: [],
              props: {
                'orbis/progress_source': {
                  query: { filter: { prop: sourceId, op: 'gt', value: 0 } },
                  aggregate: 'count',
                },
              },
            },
          },
          {
            tool: 'entity_create',
            input: {
              id: withBody,
              title: 'Смарт-лист',
              tags: [],
              body: `Список\n\n{{query: aspect=orbis/task, user/effort=5}}\n\nупоминание user/effort в прозе`,
            },
          },
        ],
      },
      { sink },
    );

    const before = {
      onlySource: (await ownEntity(onlySource)).props,
      bothSame: (await ownEntity(bothSame)).props,
      goal: (await ownEntity(goal)).props,
      body: (await ownEntity(withBody)).body,
      bodyDoc: (await ownEntity(withBody)).body_doc,
      refType: (await propertyRowByKey(mergeOwner, 'user/hard-task'))?.type,
      sourceRow: await ownRow(sourceId),
    };

    const merged = ok(await runMerge('property_merge', { source: sourceId, into: intoId }));
    const result = merged.results[0] as { rewrittenEntities: number; rewrittenQueries: number };
    expect(result.rewrittenEntities).toBe(2);
    // Три держателя: строка `ref.target`, значение `progress_source`, тело со смарт-листом.
    expect(result.rewrittenQueries).toBe(3);

    // Значения переехали, старого ключа не осталось нигде.
    expect((await ownEntity(onlySource)).props).toMatchObject({ [intoId]: 5 });
    expect((await ownEntity(onlySource)).props).not.toHaveProperty(sourceId);
    expect((await ownEntity(bothSame)).props).toEqual({ [intoId]: 7 });
    // Указатель и статус поглощённого.
    expect(await ownRow(sourceId)).toMatchObject({ merged_into: intoId, status: 'deprecated' });
    // AST в реестре и в значении цели.
    expect(JSON.stringify((await propertyRowByKey(mergeOwner, 'user/hard-task'))?.type)).toContain(
      intoId,
    );
    expect(
      JSON.stringify((await propertyRowByKey(mergeOwner, 'user/hard-task'))?.type),
    ).not.toContain(sourceId);
    expect(JSON.stringify((await ownEntity(goal)).props)).toContain(intoId);
    // ТЕЛО: сверяется НЕ подстрокой, а РАЗБОРОМ — единственным потребителем этого текста.
    // Подстрочная сверка зеленела бы на форме, которую грамматика не читает: в текст блока
    // §А5-3а адресует свойство ТОЛЬКО ключом, и подставленный туда uuid дал бы
    // `UNKNOWN_FIELD` навсегда — смарт-лист владельца после «успешного» слияния перестал бы
    // разбираться, а отчёт операции говорил бы «успех».
    const bodyAfter = String((await ownEntity(withBody)).body);
    const block = /\{\{query:([\s\S]*?)\}\}/.exec(bodyAfter)?.[1];
    expect(block).toBeDefined();
    const parseReg = toParseRegistry(
      await withIdentity(db, mergeOwner, (tx) => effectiveRegistry(tx, mergeOwner)),
      'ru',
    );
    const parsed = parseQueryAst(block as string, parseReg);
    expect(parsed.ok).toBe(true);
    // И разобралось оно именно в ЦЕЛЬ, а не во что попало.
    expect(JSON.stringify(parsed.ok === true ? parsed.ast : {})).toContain(intoId);
    // Контроль осмысленности пробы: тот же текст с id вместо ключа разбор НЕ принимает —
    // значит зелень выше добыта формой, а не снисходительностью парсера.
    const withIdInstead = (block as string).replace(intoKey, intoId);
    expect(parseQueryAst(withIdInstead, parseReg).ok).toBe(false);
    // Переписан ТОЛЬКО блок запроса; то же слово в прозе — не ссылка.
    expect(bodyAfter).toContain('упоминание user/effort в прозе');
    // Соседняя строка со `scope` не тронута.
    expect((await propertyRowByKey(mergeOwner, 'user/untouched-scope'))?.scope).toMatchObject({
      filter: { aspect: 'orbis/task' },
    });

    // ОДИН inverse на всю операцию — и он возвращает всё сразу, байт-в-байт.
    const undone = await undoAction(db, { actorUserId: mergeOwner, actionId: merged.actionId });
    expect(undone.ok).toBe(true);
    expect((await ownEntity(onlySource)).props).toEqual(before.onlySource as never);
    expect((await ownEntity(bothSame)).props).toEqual(before.bothSame as never);
    expect((await ownEntity(goal)).props).toEqual(before.goal as never);
    expect((await ownEntity(withBody)).body).toBe(before.body as string);
    expect((await ownEntity(withBody)).body_doc).toEqual(before.bodyDoc as never);
    expect((await propertyRowByKey(mergeOwner, 'user/hard-task'))?.type).toEqual(
      before.refType as never,
    );
    expect(await ownRow(sourceId)).toMatchObject({ merged_into: null, status: 'active' });
  });

  test('merge свойства переписывает ast и text блока и обновляет query_refs — и в прямой ветке, и в откате', async () => {
    // Сторож ДВУХ дыр сразу, и обе тихие.
    //  1. `body_doc` — ПРАВДА тела (§А11-1), а колонка `body` лишь её проекция. Слияние,
    //     переписавшее проекцию и не тронувшее дерево, оставляет запись, у которой чтение
    //     с `include=bodyDoc` показывает СТАРОЕ свойство, а первое же сохранение из
    //     редактора возвращает старый `ast` и в `body` — то есть откатывает слияние.
    //  2. `body_refs`/`query_refs` — индексы имён, названных телом. Операция, которая эти
    //     имена и переписывает, обязана переписать индекс: иначе слияние делает колонку
    //     устаревшей ровно на тех записях, ради которых её и завели.
    const source = ok(
      await runMerge('property_create', {
        key: 'user/weight',
        label: { ru: 'Вес' },
        description: { ru: 'Поглощаемое' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    const into = ok(
      await runMerge('property_create', {
        key: 'user/mass',
        label: { ru: 'Масса' },
        description: { ru: 'Цель слияния' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    const sourceId = (source.results[0] as { property: string }).property;
    const intoId = (into.results[0] as { property: string }).property;
    const intoKey = (into.results[0] as { key: string }).key;

    const mentioned = newId();
    const listId = newId();
    ok(
      await execute(
        db,
        {
          actorUserId: mergeOwner,
          actorKind: 'owner',
          source: 'ui',
          batchId: newId(),
          operations: [
            { tool: 'entity_create', input: { id: mentioned, title: 'Упомянутая', tags: [] } },
            {
              tool: 'entity_create',
              input: {
                id: listId,
                title: 'Список с блоком',
                tags: [],
                // Упоминание в теле — чтобы `body_refs` был НЕпустым: пустой массив
                // «сохранился» бы и при полностью потерянном пересчёте.
                //
                // ВТОРОЙ блок НЕ разбирается (`display=мозаика` — не режим отображения) и
                // потому живёт ТЕКСТОМ. Он здесь не для полноты: у неразобранного блока
                // дерева нет, переписать имя в нём можно только по тексту, и без него
                // текстовая ветка переписывания осталась бы без сторожа (проверено
                // мутацией — снятие ветки не краснело).
                body:
                  `Заметка [[entity:${mentioned}]]\n\n` +
                  '{{query:aspect=orbis/task, user/weight=5}}\n\n' +
                  '{{query:user/weight=5, title="про user/weight", display=мозаика}}',
              },
            },
          ],
        },
        { sink },
      ),
    );

    const before = await ownEntityRefs(listId);
    // Предусловие: блок ПРИВЯЗАН и адресует именно источник — иначе всё ниже зеленело бы
    // на пустом месте.
    expect(JSON.stringify(before.body_doc)).toContain(sourceId);
    expect(before.query_refs).toContain(sourceId);
    expect(before.body_refs).toEqual([mentioned]);

    const merged = ok(await runMerge('property_merge', { source: sourceId, into: intoId }));

    const after = await ownEntityRefs(listId);
    const [block, unparsed] = queryBlocksOf(after.body_doc, 2) as [
      { ast: unknown; text: unknown },
      { ast: unknown; text: unknown },
    ];
    expect(JSON.stringify(block.ast)).toContain(intoId);
    expect(JSON.stringify(block.ast)).not.toContain(sourceId);
    // `text` блока — печать ЭТОГО дерева: цель у дерева id, у печати key (§А5-3а).
    expect(block.text).toBe(`aspect=orbis/task, ${intoKey}=5`);
    // Неразобранный блок: дерева нет, имя переписано ПО ТЕКСТУ — иначе после «успешного»
    // слияния в теле осталось бы висячее имя поглощённого свойства. Но переписано ТОЛЬКО
    // имя поля: то же имя в ЗАКАВЫЧЕННОМ значении — подпись, которую написал владелец, и
    // слияние её не трогает (тот же принцип, что у держателей: имя внутри значения — не
    // адрес; здесь он держится маской кавычек, потому что дерева нет).
    expect(unparsed.ast).toBeNull();
    expect(unparsed.text).toBe(`${intoKey}=5, title="про user/weight", display=мозаика`);
    expect(String(after.body)).toContain(`{{query:aspect=orbis/task, ${intoKey}=5}}`);
    expect(String(after.body)).toContain(
      `{{query:${intoKey}=5, title="про user/weight", display=мозаика}}`,
    );
    expect(after.query_refs).toContain(intoId);
    expect(after.query_refs).not.toContain(sourceId);
    // Упоминание тем же UPDATE не потеряно.
    expect(after.body_refs).toEqual([mentioned]);

    // ОТКАТ возвращает все четыре колонки, а не две: расхождение, пережившее транзакцию,
    // не отличалось бы от исходного состояния ничем, кроме индекса.
    const undone = await undoAction(db, {
      actorUserId: mergeOwner,
      actionId: merged.actionId,
    });
    expect(undone.ok).toBe(true);
    const back = await ownEntityRefs(listId);
    expect(back.body).toBe(before.body);
    expect(back.body_doc).toEqual(before.body_doc as never);
    expect(back.query_refs).toEqual(before.query_refs);
    expect(back.body_refs).toEqual(before.body_refs);
  });

  test('держатели тела берутся из query_refs: имя свойства ВНУТРИ ЗНАЧЕНИЯ — не адрес', async () => {
    // Держатели тела ищутся ПО ИНДЕКСУ `query_refs` (он собран из дерева), а не токенным
    // обходом текста блока. Обход не отличал адрес от строки: любое `a/b` внутри блока —
    // включая заголовок, который владелец написал про себя, — считалось ссылкой на
    // свойство. Такая запись попадала в держатели, ей двигали `updated_at`, её считали в
    // отчёте операции («переписано запросов: 2») и переписывали ей текст.
    const source = ok(
      await runMerge('property_create', {
        key: 'user/net-weight',
        label: { ru: 'Вес нетто' },
        description: { ru: 'Поглощаемое' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    const into = ok(
      await runMerge('property_create', {
        key: 'user/gross-weight',
        label: { ru: 'Вес брутто' },
        description: { ru: 'Цель слияния' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    const sourceId = (source.results[0] as { property: string }).property;
    const intoId = (into.results[0] as { property: string }).property;

    const holder = newId();
    const bystander = newId();
    ok(
      await execute(
        db,
        {
          actorUserId: mergeOwner,
          actorKind: 'owner',
          source: 'ui',
          batchId: newId(),
          operations: [
            {
              tool: 'entity_create',
              input: {
                id: holder,
                title: 'Настоящий держатель',
                tags: [],
                body: '{{query:aspect=orbis/task, user/net-weight=5}}',
              },
            },
            {
              tool: 'entity_create',
              input: {
                id: bystander,
                title: 'Просто похожий заголовок',
                tags: [],
                // Имя свойства стоит в ЗНАЧЕНИИ `title=`, а не в позиции поля.
                body: '{{query:aspect=orbis/task, title="Про user/net-weight"}}',
              },
            },
          ],
        },
        { sink },
      ),
    );
    const bystanderBefore = await ownEntityRefs(bystander);
    // Контроль осмысленности: имя действительно ЕСТЬ в тексте блока — и всё же не адрес.
    expect(bystanderBefore.body).toContain('user/net-weight');
    expect(bystanderBefore.query_refs).not.toContain(sourceId);

    const merged = ok(await runMerge('property_merge', { source: sourceId, into: intoId }));
    // Один держатель тела, а не два: соседняя запись в перечень не попала.
    expect((merged.results[0] as { rewrittenQueries: number }).rewrittenQueries).toBe(1);
    const bystanderAfter = await ownEntityRefs(bystander);
    expect(bystanderAfter.body).toBe(bystanderBefore.body);
    expect((await ownEntityRefs(holder)).query_refs).toContain(intoId);
  });

  test('строка с индексом, но БЕЗ документа: слияние собирает документ из body и не теряет тело', async () => {
    // СТРАХОВКА, А НЕ МЁРТВАЯ ВЕТКА, и решение записано здесь потому, что живыми писателями
    // это состояние (`query_refs` непусты при `body_doc IS NULL`) недостижимо: колонку
    // заполняют только те, кто тем же UPDATE пишет и документ. Оставлено оно по двум
    // причинам. Первая: `readBodyDoc` — общий вход чтения тела, и ветка «документа нет,
    // собери из markdown» — его штатное правило разрешения Р1, а не наша добавка; убрать её
    // можно было бы, только заменив общий вход на своё чтение. Вторая: писатель, который
    // заполнит индекс без документа, появится — `db/backfill-body-doc.ts` станет таким в тот
    // день, когда получит реестр, — и слияние обязано пережить его без потери тела.
    //
    // Состояние подсаживается АДМИН-DSN намеренно: воспроизвести его штатным путём нельзя,
    // а «названная цена» без проверки — это чтение кода вместо теста.
    const source = ok(
      await runMerge('property_create', {
        key: 'user/no-doc-src',
        label: { ru: 'Без документа' },
        description: { ru: 'Поглощаемое' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    const into = ok(
      await runMerge('property_create', {
        key: 'user/no-doc-dst',
        label: { ru: 'Цель' },
        description: { ru: 'Цель слияния' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    const sourceId = (source.results[0] as { property: string }).property;
    const intoId = (into.results[0] as { property: string }).property;
    const intoKey = (into.results[0] as { key: string }).key;

    const noDoc = newId();
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.execute(sql`
        INSERT INTO entities (id, owner_id, title, body, query_refs)
        VALUES (${noDoc}::uuid, ${mergeOwner}::uuid, 'Индекс без документа',
                ${`Проза\n\n{{query:aspect=orbis/task, user/no-doc-src=5}}`},
                ARRAY[${sourceId}]::text[])`);
    } finally {
      await adminClient.end();
    }
    // Предусловие: документа НЕТ, а индекс есть — то самое искусственное состояние.
    expect((await ownEntityRefs(noDoc)).body_doc).toBeNull();

    ok(await runMerge('property_merge', { source: sourceId, into: intoId }));

    const after = await ownEntityRefs(noDoc);
    // Тело переписано и НЕ потеряно: проза цела, блок адресует цель.
    expect(after.body).toBe(`Проза\n\n{{query:aspect=orbis/task, ${intoKey}=5}}`);
    // Документ МАТЕРИАЛИЗОВАН — та самая названная цена: операция, переписывающая имена,
    // которые документ и держит, не может оставить «ещё не сконвертировано».
    expect(after.body_doc).not.toBeNull();
    expect(after.query_refs).toContain(intoId);
    expect(after.query_refs).not.toContain(sourceId);
  });

  test('типы не совпадают — VALIDATION MERGE_TYPE, ничего не тронуто', async () => {
    const a = ok(
      await runMerge('property_create', {
        key: 'user/type-a',
        label: { ru: 'Число' },
        description: { ru: 'Число' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    const b = ok(
      await runMerge('property_create', {
        key: 'user/type-b',
        label: { ru: 'Текст' },
        description: { ru: 'Текст' },
        type: { kind: 'text' },
        status: 'active',
      }),
    );
    const e = err(
      await runMerge('property_merge', {
        source: (a.results[0] as { property: string }).property,
        into: (b.results[0] as { property: string }).property,
      }),
    );
    expect((e.details as { reason?: string }).reason).toBe('MERGE_TYPE');
  });

  test('встроенное свойство источником не бывает — иначе пересев затёр бы указатель', async () => {
    const own = ok(
      await runMerge('property_create', {
        key: 'user/my-status',
        label: { ru: 'Свой статус' },
        description: { ru: 'Свой статус' },
        type: { kind: 'text' },
        status: 'active',
      }),
    );
    const e = err(
      await runMerge('property_merge', {
        source: 'orbis/memory_kind',
        into: (own.results[0] as { property: string }).property,
      }),
    );
    expect((e.details as { reason?: string }).reason).toBe('MERGE_BUILTIN');
  });

  test('цепочка A→B, затем B→C: merged_into(A) = C (компактация §А10-2)', async () => {
    const mk = async (key: string): Promise<string> => {
      const r = ok(
        await runMerge('property_create', {
          key,
          label: { ru: key },
          description: { ru: key },
          type: { kind: 'decimal' },
          status: 'active',
        }),
      );
      return (r.results[0] as { property: string }).property;
    };
    const a = await mk('user/chain-a');
    const b = await mk('user/chain-b');
    const c = await mk('user/chain-c');
    ok(await runMerge('property_merge', { source: a, into: b }));
    expect(await ownRow(a)).toMatchObject({ merged_into: b });
    const second = ok(await runMerge('property_merge', { source: b, into: c }));
    // Резолвер идёт в ОДИН шаг (Р10): цепочки A→B→C существовать не должно.
    expect(await ownRow(a)).toMatchObject({ merged_into: c });
    expect(await ownRow(b)).toMatchObject({ merged_into: c });
    // И откат второго слияния возвращает указатель A на B, а не оставляет его на C.
    ok(
      (await undoAction(db, {
        actorUserId: mergeOwner,
        actionId: second.actionId,
      })) as ExecuteResult,
    );
    expect(await ownRow(a)).toMatchObject({ merged_into: b });
    expect(await ownRow(b)).toMatchObject({ merged_into: null, status: 'active' });
  });
});

/**
 * Строка свойства ПО КЛЮЧУ: id пользовательского свойства — uuid (Р3), а имя, которым его
 * заводили и адресуют, лежит в `key`. Сверять по нему — единственный честный способ.
 */
async function propertyRowByKey(
  ownerId: string,
  key: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = (await withIdentity(db, ownerId, (tx) =>
    tx.execute(sql`SELECT id, key, scope, status, merged_into, type FROM property_definitions
                   WHERE owner_id = ${ownerId}::uuid AND key = ${key}`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0];
}

// ---------------------------------------------------------------------------
// §А10-1: версия реестра в той же транзакции
// ---------------------------------------------------------------------------

describe('registry_version (§А10-1)', () => {
  const versionOwner = freshUserId();

  function runV(tool: string, input: unknown): Promise<ExecuteResult> {
    return execute(
      db,
      {
        actorUserId: versionOwner,
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool, input }],
      },
      { sink },
    );
  }

  const version = (): Promise<number> =>
    withIdentity(
      db,
      versionOwner,
      async (tx: Tx) => (await readRegistryVersions(tx, versionOwner)).ownerVersion,
    );

  test('версия растёт на КАЖДОЙ операции реестра, и кеш перечитывает снимок', async () => {
    const v0 = await version();
    const created = ok(
      await runV('property_create', {
        key: 'user/versioned',
        label: { ru: 'Версионируемое' },
        description: { ru: 'Проверка инвалидации' },
        type: { kind: 'text' },
        status: 'active',
      }),
    );
    const id = (created.results[0] as { property: string }).property;
    const v1 = await version();
    expect(v1).toBeGreaterThan(v0);
    // Кеш эффективных определений сбрасывать нечем — версия единственный механизм.
    // Читаем ЧЕРЕЗ кеш (не через сырое чтение): протухший снимок ловится только так.
    const reg1 = await withIdentity(db, versionOwner, (tx) => effectiveRegistry(tx, versionOwner));
    expect(reg1.properties.get(id)?.label.ru).toBe('Версионируемое');

    ok(await runV('property_update', { id, label: { ru: 'Переименованное' } }));
    expect(await version()).toBeGreaterThan(v1);
    const reg2 = await withIdentity(db, versionOwner, (tx) => effectiveRegistry(tx, versionOwner));
    expect(reg2.properties.get(id)?.label.ru).toBe('Переименованное');

    const v2 = await version();
    ok(await runV('aspect_delta_set', { aspect: 'orbis/task', delta: { icon: '🧩' } }));
    expect(await version()).toBeGreaterThan(v2);
    const v3 = await version();
    ok(await runV('aspect_delta_remove', { aspect: 'orbis/task' }));
    expect(await version()).toBeGreaterThan(v3);
  });

  test('undo реестровой операции ТОЖЕ двигает версию — иначе кеш отдал бы откаченное', async () => {
    const created = ok(
      await runV('property_create', {
        key: 'user/undone',
        label: { ru: 'Отменяемое' },
        description: { ru: 'Проверка версии на откате' },
        type: { kind: 'text' },
        status: 'active',
      }),
    );
    const id = (created.results[0] as { property: string }).property;
    const v = await version();
    await undoAction(db, { actorUserId: versionOwner, actionId: created.actionId });
    expect(await version()).toBeGreaterThan(v);
    const reg = await withIdentity(db, versionOwner, (tx) => effectiveRegistry(tx, versionOwner));
    expect(reg.properties.has(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Порядок замков (инвариант ветки)
// ---------------------------------------------------------------------------

describe('порядок замков: реестр ПЕРВЫМ, бюджет вторым', () => {
  const lockOwner = freshUserId();

  /**
   * SQL-лог транзакции исполнителя. Подмена `tx.execute` в `beforeStages` — единственный
   * шов, стоящий ДО первого чтения состояния: логгер drizzle пришлось бы заводить на
   * уровне клиента, то есть на весь процесс и на все параллельные сьюты сразу.
   */
  function sqlLog(log: string[]): (tx: Tx) => Promise<void> {
    return async (tx: Tx) => {
      const target = tx as unknown as {
        execute: (q: unknown) => Promise<unknown>;
        dialect: { sqlToQuery: (q: unknown) => { sql: string; params: unknown[] } };
      };
      const original = target.execute.bind(target);
      target.execute = (q: unknown) => {
        try {
          const { sql: text, params } = target.dialect.sqlToQuery(q);
          log.push(`${text} :: ${JSON.stringify(params)}`);
        } catch {
          log.push('<не разобрано>');
        }
        return original(q);
      };
    };
  }

  test('пачка «операция реестра + правка бюджет-контура»: замок реестра берётся раньше', async () => {
    const log: string[] = [];
    const r = await execute(
      db,
      {
        actorUserId: lockOwner,
        actorKind: 'owner',
        source: 'ui',
        batchId: newId(),
        operations: [
          {
            tool: 'property_create',
            input: {
              key: 'user/lock-probe',
              label: { ru: 'Проба замка' },
              description: { ru: 'Проба замка' },
              type: { kind: 'number' },
              status: 'active',
            },
          },
          {
            tool: 'entity_create',
            input: { title: 'Трата', tags: [], aspects: ['orbis/financial'] },
          },
        ],
      },
      { sink, beforeStages: sqlLog(log) },
    );
    // Сама пачка законно может отказать на инвариантах финансовой записи — вопрос теста
    // не в её исходе, а в ПОРЯДКЕ двух замков, взятых до стадий.
    expect(typeof r.ok).toBe('boolean');
    const registryAt = log.findIndex((line) => line.includes(':registry'));
    const budgetAt = log.findIndex((line) => line.includes(':envelope_unique'));
    expect(registryAt).toBeGreaterThanOrEqual(0);
    expect(budgetAt).toBeGreaterThanOrEqual(0);
    // Глобальный порядок «реестр → бюджет → строки»: обратный даёт цикл ожидания, которого
    // тесты не видят, а прод видит дедлоком под нагрузкой.
    expect(registryAt).toBeLessThan(budgetAt);
  });

  test('операция БЕЗ реестра замка реестра не берёт (иначе он сериализовал бы весь граф)', async () => {
    const log: string[] = [];
    await execute(
      db,
      {
        actorUserId: lockOwner,
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'entity_create', input: { title: 'Просто запись', tags: [] } }],
      },
      { sink, beforeStages: sqlLog(log) },
    );
    expect(log.some((line) => line.includes(':registry'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §А10-2: конфликт значений — ничего не применено, единица пачки владельцу
// ---------------------------------------------------------------------------

describe('property_merge при конфликте значений (§А10-2)', () => {
  const conflictOwner = freshUserId();

  /**
   * Путь ТУЛА, а не голый `execute`: карточка разбора кладётся ОТДЕЛЬНОЙ транзакцией
   * (`reportMergeConflictUnit`) — та, что нашла конфликт, откатывается целиком, и записанная
   * в ней карточка откатилась бы вместе с ней. Ставит её граница вызова, поэтому и проверять
   * её надо с границы: тест на `execute` зеленел бы на половине механизма.
   */
  function call(name: string, input: unknown): Promise<ToolDispatchResult> {
    return dispatchTool(
      {
        db,
        actorUserId: conflictOwner,
        actorKind: 'owner',
        source: 'chat',
        explicitCommand: false,
      },
      name,
      input,
    );
  }

  test('REGISTRY_CONFLICT, ничего не применено, единица пачки в глобальном треде', async () => {
    // Фикстура идёт ПРЯМЫМ `execute`, а не тулом: с Р-24-8 заведение строки СРАЗУ АКТИВНОЙ —
    // `behavior-delta`, то есть карточка подтверждения для любого актора, включая владельца.
    // Предмет этого теста — конфликт значений при СЛИЯНИИ, и он по-прежнему идёт границей
    // вызова (`call` ниже); гонять через подтверждение ещё и обстановку значило бы проверять
    // здесь чужое правило.
    const mk = async (key: string): Promise<string> => {
      const r = await execute(db, {
        actorUserId: conflictOwner,
        actorKind: 'owner',
        source: 'ui',
        operations: [
          {
            tool: 'property_create',
            input: {
              key,
              label: { ru: key },
              description: { ru: key },
              type: { kind: 'number' },
              status: 'active',
            },
          },
        ],
      });
      if (!r.ok) throw new Error(`создание ${key} не прошло: ${JSON.stringify(r.error)}`);
      return (r.results[0] as { property: string }).property;
    };
    const source = await mk('user/conflict-a');
    const into = await mk('user/conflict-b');

    const clean = newId();
    const clashing = newId();
    await execute(
      db,
      {
        actorUserId: conflictOwner,
        actorKind: 'owner',
        source: 'ui',
        batchId: newId(),
        operations: [
          {
            tool: 'entity_create',
            input: { id: clean, title: 'Только старое', tags: [], props: { [source]: 1 } },
          },
          {
            tool: 'entity_create',
            input: {
              id: clashing,
              title: 'Оба и по-разному',
              tags: [],
              props: { [source]: 2, [into]: 3 },
            },
          },
        ],
      },
      { sink },
    );

    // ПУТЬ ИЗМЕНИЛСЯ ЗАДАЧЕЙ 16, А ИСХОД — НЕТ. С §С2-1 мутация реестра ни для какого
    // актора не бывает молчаливой: слияние из чата поднимается до карточки-запроса и
    // исполняется на «Принять» (`approvePending`), а не в диспатче. Значит и конфликт
    // всплывает там же — вместе с единицей разбора, которую кладёт та же граница.
    // Прежде здесь стоял немедленный `error/REGISTRY_CONFLICT`; проверяется по-прежнему
    // одно и то же: отказ с тем же кодом, ничего не применено, карточка разбора в ленте.
    const asked = await call('property_merge', { source, into });
    expect(asked.status).toBe('pending_confirmation');
    if (asked.status !== 'pending_confirmation') throw new Error('ожидалась карточка-запрос');
    const r = await approvePending(db, { ownerId: conflictOwner, pendingId: asked.pendingId });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('REGISTRY_CONFLICT');

    // «НИЧЕГО НЕ ПРИМЕНЕНО» — проверяется именно «ничего»: частично слитое хуже отказа.
    // Запись БЕЗ конфликта соблазнительнее всего переписать «заодно», и вот она.
    const rows = (await withIdentity(db, conflictOwner, (tx) =>
      tx.execute(sql`SELECT id, props FROM entities WHERE id IN (${clean}::uuid, ${clashing}::uuid)
                     ORDER BY id`),
    )) as unknown as Array<{ id: string; props: Record<string, unknown> }>;
    const byId = new Map(rows.map((x) => [x.id, x.props]));
    expect(byId.get(clean)).toEqual({ [source]: 1 });
    expect(byId.get(clashing)).toEqual({ [source]: 2, [into]: 3 });
    // Указатель тоже не проставлен: строка реестра осталась активной.
    const srcRow = (await withIdentity(db, conflictOwner, (tx) =>
      tx.execute(sql`SELECT status, merged_into FROM property_definitions
                     WHERE owner_id = ${conflictOwner}::uuid AND id = ${source}`),
    )) as unknown as Array<Record<string, unknown>>;
    expect(srcRow[0]).toMatchObject({ status: 'active', merged_into: null });

    // Единица пачки — от СИСТЕМЫ (актора у конфликта нет), в глобальном треде, и несёт то же
    // самое слияние: разобрав значения, владелец жмёт «Принять», и оно идёт заново.
    // Отбор СУЖЕН Задачей 16 по актору: рядом теперь лежит и карточка-запрос §7.10 того же
    // тула (её попросил владелец через чат), а единица разбора — системная, её ставить
    // некому. Без сужения проба считала бы обе и молча зеленела бы на чужой записи.
    const pendings = (await withIdentity(db, conflictOwner, (tx) =>
      tx.execute(sql`SELECT id, content, metadata FROM chat_messages
                     WHERE metadata @> '{"pending":{"tool":"property_merge","actor_kind":"system"}}'::jsonb`),
    )) as unknown as Array<{ id: string; content: string; metadata: Record<string, unknown> }>;
    expect(pendings).toHaveLength(1);
    const pending = (pendings[0]?.metadata as { pending: Record<string, unknown> }).pending;
    expect(pending).toMatchObject({
      actor_kind: 'system',
      source: 'system',
      kind: 'action',
      tool: 'property_merge',
      input: { source, into },
    });
    expect(String(pendings[0]?.content)).toContain(clashing);

    // Повтор того же слияния возвращает ТУ ЖЕ карточку разбора, а не плодит вторую.
    const askedAgain = await call('property_merge', { source, into });
    expect(askedAgain.status).toBe('pending_confirmation');
    if (askedAgain.status !== 'pending_confirmation') throw new Error('ожидалась карточка');
    const again = await approvePending(db, {
      ownerId: conflictOwner,
      pendingId: askedAgain.pendingId,
    });
    expect(again.ok).toBe(false);
    const after = (await withIdentity(db, conflictOwner, (tx) =>
      tx.execute(sql`SELECT id FROM chat_messages
                     WHERE metadata @> '{"pending":{"tool":"property_merge","actor_kind":"system"}}'::jsonb`),
    )) as unknown as unknown[];
    expect(after).toHaveLength(1);

    // Разобрав конфликт, владелец подтверждает единицу — слияние проходит целиком.
    const approved = await approvePending(db, {
      ownerId: conflictOwner,
      pendingId: pending.id as string,
    });
    // Пока значения не разобраны, approve честно отказывает тем же кодом (ревалидация
    // §7.10 идёт по ТЕКУЩЕМУ состоянию, а не по тому, что было в момент постановки).
    expect(approved.ok).toBe(false);
    await execute(
      db,
      {
        actorUserId: conflictOwner,
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'entity_update', input: { id: clashing, unset: [into] } }],
      },
      { sink },
    );
    const approvedAgain = await approvePending(db, {
      ownerId: conflictOwner,
      pendingId: pending.id as string,
    });
    expect(approvedAgain.ok).toBe(true);
    const merged = (await withIdentity(db, conflictOwner, (tx) =>
      tx.execute(sql`SELECT props FROM entities WHERE id = ${clean}::uuid`),
    )) as unknown as Array<{ props: Record<string, unknown> }>;
    expect(merged[0]?.props).toEqual({ [into]: 1 });
  });
});

// ---------------------------------------------------------------------------
// §А3-4: двойное объявление «где показывается свойство» — обе двери (фикс-раунд 1)
// ---------------------------------------------------------------------------

describe('дельта и scope не могут объявить одно свойство на одном аспекте (§А3-4)', () => {
  const dupOwner = freshUserId();

  function runDup(tool: string, input: unknown): Promise<ExecuteResult> {
    return execute(
      db,
      { actorUserId: dupOwner, actorKind: 'owner', source: 'ui', operations: [{ tool, input }] },
      { sink },
    );
  }

  /** Читаемость реестра — вопрос, который задаёт КАЖДЫЙ вызов исполнителя, а не только тест. */
  async function registryReadable(): Promise<boolean> {
    const r = await runDup('entity_create', { title: 'проба читаемости', tags: [] });
    return r.ok;
  }

  test('сперва ДЕЛЬТА, потом scope: правка отвергнута — иначе реестр перестал бы читаться', async () => {
    const created = ok(
      await runDup('property_create', {
        key: 'user/dup-a',
        label: { ru: 'Двойное А' },
        description: { ru: 'Проба §А3-4' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    const id = (created.results[0] as { property: string }).property;
    ok(
      await runDup('aspect_delta_set', {
        aspect: 'orbis/note',
        delta: { properties: { add: [{ propertyId: id, required: false, rank: 50 }] } },
      }),
    );

    const e = err(
      await runDup('property_update', { id, scope: { filter: { aspect: 'orbis/note' } } }),
    );
    expect((e.details as { reason?: string }).reason).toBe('SCOPE_DUPLICATE');
    // ГЛАВНОЕ: реестр после отказа ЧИТАЕТСЯ. Проверяется не чтением снимка в тесте, а любым
    // вызовом исполнителя — он берёт снимок ПЕРВЫМ делом, и именно этот путь запирался бы.
    expect(await registryReadable()).toBe(true);
    // И обе починки на месте: снять дельту и поставить scope по-прежнему можно.
    ok(await runDup('aspect_delta_remove', { aspect: 'orbis/note' }));
    ok(await runDup('property_update', { id, scope: { filter: { aspect: 'orbis/note' } } }));
  });

  test('сперва scope, потом ДЕЛЬТА: отвергнута дельта (вторая дверь в ту же комнату)', async () => {
    const created = ok(
      await runDup('property_create', {
        key: 'user/dup-b',
        label: { ru: 'Двойное Б' },
        description: { ru: 'Проба §А3-4, обратный порядок' },
        type: { kind: 'number' },
        status: 'active',
        scope: { filter: { aspect: 'orbis/task' } },
      }),
    );
    const id = (created.results[0] as { property: string }).property;
    const e = err(
      await runDup('aspect_delta_set', {
        aspect: 'orbis/task',
        delta: { properties: { add: [{ propertyId: id, required: false, rank: 51 }] } },
      }),
    );
    expect((e.details as { reason?: string }).reason).toBe('SCOPE_DUPLICATE');
    expect(await registryReadable()).toBe(true);
  });

  test('ОТКАТ, ведущий в то же состояние, тоже отвергается — громко, а не замком', async () => {
    // Сценарий, до которого не доводит ни один прямой путь: scope сняли, освободившееся
    // место заняла дельта — и возврат scope откатом замкнул бы §А3-4.
    const created = ok(
      await runDup('property_create', {
        key: 'user/dup-c',
        label: { ru: 'Двойное В' },
        description: { ru: 'Проба отката' },
        type: { kind: 'number' },
        status: 'active',
        scope: { filter: { aspect: 'orbis/memory' } },
      }),
    );
    const id = (created.results[0] as { property: string }).property;
    const dropped = ok(await runDup('property_update', { id, scope: null }));
    ok(
      await runDup('aspect_delta_set', {
        aspect: 'orbis/memory',
        delta: { properties: { add: [{ propertyId: id, required: false, rank: 52 }] } },
      }),
    );
    const undone = await undoAction(db, { actorUserId: dupOwner, actionId: dropped.actionId });
    expect(undone.ok).toBe(false);
    expect(undone.ok === false && (undone.error.details as { reason?: string }).reason).toBe(
      'SCOPE_DUPLICATE',
    );
    // Отказ отката — исход, который владелец видит и разбирает; нечитаемый реестр — нет.
    expect(await registryReadable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §А10-2: чего слияние не делает (фикс-раунд 1)
// ---------------------------------------------------------------------------

describe('property_merge: границы операции (фикс-раунд 1)', () => {
  const edgeOwner = freshUserId();

  function runEdge(tool: string, input: unknown): Promise<ExecuteResult> {
    return execute(
      db,
      { actorUserId: edgeOwner, actorKind: 'owner', source: 'ui', operations: [{ tool, input }] },
      { sink },
    );
  }

  async function mk(key: string, type: unknown): Promise<string> {
    const r = ok(
      await runEdge('property_create', {
        key,
        label: { ru: key },
        description: { ru: key },
        type,
        status: 'active',
      }),
    );
    return (r.results[0] as { property: string }).property;
  }

  test('слияние в core-проекцию отвергнуто: значение уехало бы в props, где его никто не читает', async () => {
    // `orbis/title` — storage: 'core' (§А1-3): значение живёт в КОЛОНКЕ. Слияние переносит
    // значение внутри `props`, то есть положило бы его по адресу, который читателю неведом,
    // и у записи стало бы две несогласованные правды под одним реестровым именем.
    const source = await mk('user/my-title', { kind: 'text' });
    const entity = newId();
    ok(
      await runEdge('entity_create', {
        id: entity,
        title: 'настоящий заголовок',
        tags: [],
        props: { [source]: 'мой заголовок' },
      }),
    );
    const e = err(await runEdge('property_merge', { source, into: 'orbis/title' }));
    expect((e.details as { reason?: string; side?: string }).reason).toBe('MERGE_STORAGE');
    expect((e.details as { side?: string }).side).toBe('into');
    // Ничего не тронуто: колонка своя, props свой.
    const rows = (await withIdentity(db, edgeOwner, (tx) =>
      tx.execute(sql`SELECT title, props FROM entities WHERE id = ${entity}::uuid`),
    )) as unknown as Array<{ title: string; props: Record<string, unknown> }>;
    expect(rows[0]?.title).toBe('настоящий заголовок');
    expect(rows[0]?.props).toEqual({ [source]: 'мой заголовок' });
  });

  test('слияние В УЖЕ ПОГЛОЩЁННОЕ отвергнуто — цепочка не растёт вторым способом', async () => {
    const a = await mk('user/edge-a', { kind: 'number' });
    const b = await mk('user/edge-b', { kind: 'number' });
    const c = await mk('user/edge-c', { kind: 'number' });
    ok(await runEdge('property_merge', { source: b, into: c }));
    // Обратный компактации порядок: b уже поглощено, и слияние в него дало бы a → b → c.
    const e = err(await runEdge('property_merge', { source: a, into: b }));
    expect((e.details as { reason?: string; side?: string }).reason).toBe('MERGE_ALREADY_MERGED');
    expect((e.details as { side?: string; successor?: string }).side).toBe('into');
    expect((e.details as { successor?: string }).successor).toBe(c);
    // Указатель a не появился, глубина цепочки — по-прежнему один шаг.
    const rows = (await withIdentity(db, edgeOwner, (tx) =>
      tx.execute(sql`SELECT id, merged_into FROM property_definitions
                     WHERE owner_id = ${edgeOwner}::uuid AND id IN (${a}, ${b}, ${c})`),
    )) as unknown as Array<{ id: string; merged_into: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r.merged_into]));
    expect(byId.get(a)).toBeNull();
    expect(byId.get(b)).toBe(c);
    expect(byId.get(c)).toBeNull();
    // Сливать в преемника — можно: отказ адресован цепочке, а не операции.
    ok(await runEdge('property_merge', { source: a, into: c }));
  });

  test('ПОГЛОЩЁННОЕ не бывает и источником: значений у него нет, а указатель переставился бы', async () => {
    const x = await mk('user/edge-x', { kind: 'number' });
    const y = await mk('user/edge-y', { kind: 'number' });
    const z = await mk('user/edge-z', { kind: 'number' });
    ok(await runEdge('property_merge', { source: x, into: y }));
    const e = err(await runEdge('property_merge', { source: x, into: z }));
    expect((e.details as { reason?: string; side?: string }).reason).toBe('MERGE_ALREADY_MERGED');
    expect((e.details as { side?: string }).side).toBe('source');
  });
});

// ---------------------------------------------------------------------------
// Фикс-раунд 2: висячая ссылка, чужой namespace, воскрешение поглощённого
// ---------------------------------------------------------------------------

describe('границы записи определения (фикс-раунд 2)', () => {
  const edge2 = freshUserId();

  function run2(tool: string, input: unknown): Promise<ExecuteResult> {
    return execute(
      db,
      { actorUserId: edge2, actorKind: 'owner', source: 'ui', operations: [{ tool, input }] },
      { sink },
    );
  }

  test('отклонение proposed, на который ССЫЛАЕТСЯ ТЕЛО, строку не удаляет (§А10-3)', async () => {
    // Держатель-тело называет свойство КЛЮЧОМ, а не id (§А5-3а). Проба «на нём ничего не
    // держится», спрашивающая один id, такую ссылку не видит — и физическое удаление
    // оставило бы в теле вечный `UNKNOWN_FIELD`, то самое «висение», которое §А10-3
    // обещает невозможным.
    const created = ok(
      await run2('property_create', {
        key: 'user/half-baked',
        label: { ru: 'Недопечённое' },
        description: { ru: 'Предложение со ссылкой в теле' },
        type: { kind: 'number' },
        status: 'proposed',
      }),
    );
    const id = (created.results[0] as { property: string }).property;
    ok(
      await run2('entity_create', {
        title: 'Смарт-лист на предложение',
        tags: [],
        body: 'Список\n\n{{query: aspect=orbis/task, user/half-baked=1}}',
      }),
    );
    ok(await run2('property_update', { id, status: 'deprecated' }));
    const row = await propertyRowByKey(edge2, 'user/half-baked');
    expect(row).toBeDefined();
    expect(row?.status).toBe('deprecated');
  });

  test('отклонение proposed БЕЗ ссылок по-прежнему удаляет строку (проба не переусердствовала)', async () => {
    const created = ok(
      await run2('property_create', {
        key: 'user/really-unused',
        label: { ru: 'Совсем ненужное' },
        description: { ru: 'Ни значений, ни ссылок' },
        type: { kind: 'number' },
        status: 'proposed',
      }),
    );
    const id = (created.results[0] as { property: string }).property;
    ok(await run2('property_update', { id, status: 'deprecated' }));
    expect(await propertyRowByKey(edge2, 'user/really-unused')).toBeUndefined();
  });

  test('явный key вне namespace user/ отвергнут — иначе релиз молча перекрылся бы своей строкой', async () => {
    const e = err(
      await run2('property_create', {
        key: 'orbis/brand-new-prop',
        label: { ru: 'Как будто встроенное' },
        description: { ru: 'Захват чужого namespace' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    expect((e.details as { reason?: string }).reason).toBe('KEY_NAMESPACE');
    expect(await propertyRowByKey(edge2, 'orbis/brand-new-prop')).toBeUndefined();
    // Автослаг и так кладёт в `user/` — сужение тронуло только явную форму.
    const auto = ok(
      await run2('property_create', {
        label: { en: 'Auto Slug Prop' },
        description: { ru: 'Без явного ключа' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    expect((auto.results[0] as { key: string }).key).toBe('user/auto-slug-prop');
  });

  test('поглощённую строку нельзя воскресить правкой — отказ указывает на отмену слияния', async () => {
    const mk = async (key: string): Promise<string> => {
      const r = ok(
        await run2('property_create', {
          key,
          label: { ru: key },
          description: { ru: key },
          type: { kind: 'number' },
          status: 'active',
        }),
      );
      return (r.results[0] as { property: string }).property;
    };
    const a = await mk('user/revive-a');
    const b = await mk('user/revive-b');
    const merged = ok(await run2('property_merge', { source: a, into: b }));

    const e = err(await run2('property_update', { id: a, status: 'active' }));
    expect((e.details as { reason?: string }).reason).toBe('PROPERTY_MERGED');
    expect((e.details as { successor?: string }).successor).toBe(b);
    // Полусостояния не возникло: строка как была поглощённой, так и осталась.
    const row = (await withIdentity(db, edge2, (tx) =>
      tx.execute(sql`SELECT status, merged_into FROM property_definitions
                     WHERE owner_id = ${edge2}::uuid AND id = ${a}`),
    )) as unknown as Array<Record<string, unknown>>;
    expect(row[0]).toMatchObject({ status: 'deprecated', merged_into: b });
    // Путь назад, на который указывает отказ, РАБОТАЕТ — иначе это была бы ловушка.
    const undone = await undoAction(db, { actorUserId: edge2, actionId: merged.actionId });
    expect(undone.ok).toBe(true);
    ok(await run2('property_update', { id: a, label: { ru: 'Снова правится' } }));
  });

  test('адрес операции резолвится ВНУТРИ пачки: свойство, заведённое соседней операцией, видно по key', async () => {
    // Снимок реестра исполнитель снимает ДО стадий, и резолв по нему отвечал бы NOT_FOUND
    // на ключ, который владелец завёл предыдущей операцией той же пачки, — при том что
    // докблок `currentRegistry` обещает обратное.
    const r = await execute(
      db,
      {
        actorUserId: edge2,
        actorKind: 'owner',
        source: 'ui',
        batchId: newId(),
        operations: [
          {
            tool: 'property_create',
            input: {
              key: 'user/in-batch',
              label: { ru: 'В пачке' },
              description: { ru: 'Заведено и тут же поправлено' },
              type: { kind: 'number' },
              status: 'proposed',
            },
          },
          { tool: 'property_update', input: { id: 'user/in-batch', status: 'active' } },
        ],
      },
      { sink },
    );
    expect(r.ok).toBe(true);
    expect((await propertyRowByKey(edge2, 'user/in-batch'))?.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Фикс-раунд 3: дельта — ЧЕТВЁРТЫЙ род держателей (§А3-2 × §А10-2 × §А10-3)
// ---------------------------------------------------------------------------

describe('дельта аспекта как держатель свойства (фикс-раунд 3)', () => {
  const holderOwner = freshUserId();

  function runH(tool: string, input: unknown): Promise<ExecuteResult> {
    return execute(
      db,
      {
        actorUserId: holderOwner,
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool, input }],
      },
      { sink },
    );
  }

  async function mkProp(key: string): Promise<string> {
    const r = ok(
      await runH('property_create', {
        key,
        label: { ru: key },
        description: { ru: key },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    return (r.results[0] as { property: string }).property;
  }

  /** Состав аспекта КАК ЕГО ВИДИТ ЧИТАТЕЛЬ — через эффективный снимок, не через строку. */
  async function taskRefs(): Promise<Array<{ propertyId: string; required: boolean }>> {
    const reg = await withIdentity(db, holderOwner, (tx) => effectiveRegistry(tx, holderOwner));
    return (reg.aspects.get('orbis/task')?.properties ?? []).map((r) => ({
      propertyId: r.propertyId,
      required: r.required,
    }));
  }

  test('слияние переписывает адрес в ДЕЛЬТЕ: аспект называет цель, а не поглощённое', async () => {
    const p = await mkProp('user/holder-p');
    const q = await mkProp('user/holder-q');
    ok(
      await runH('aspect_delta_set', {
        aspect: 'orbis/task',
        delta: { properties: { add: [{ propertyId: p, required: false, rank: 70 }] } },
      }),
    );
    expect((await taskRefs()).map((r) => r.propertyId)).toContain(p);

    const merged = ok(await runH('property_merge', { source: p, into: q }));
    const refs = await taskRefs();
    // Аспект перестал называть поглощённое и назвал цель — иначе он стоял бы на строке со
    // статусом `deprecated`, а отчёт операции говорил бы «успех».
    expect(refs.map((r) => r.propertyId)).not.toContain(p);
    expect(refs.map((r) => r.propertyId)).toContain(q);
    // Дельта — держатель наравне с остальными, и она посчитана в отчёте операции.
    expect((merged.results[0] as { rewrittenQueries: number }).rewrittenQueries).toBe(1);

    // Откат возвращает дельту байт-в-байт вместе со всем остальным (ОДИН inverse).
    const undone = await undoAction(db, {
      actorUserId: holderOwner,
      actionId: merged.actionId,
    });
    expect(undone.ok).toBe(true);
    expect((await taskRefs()).map((r) => r.propertyId)).toContain(p);
  });

  test('required: true — после слияния аспект РАБОТАЕТ, а не запирается насмерть', async () => {
    // Самый дорогой из трёх сценариев. Со старым кодом выхода не было ни одного: назвать
    // поглощённое — `DEPRECATED`, не назвать — `REQUIRED`, назвать цель — снова `REQUIRED`
    // на поглощённом. Владелец не мог завести или поправить НИ ОДНОЙ задачи, пока сам не
    // догадается снять дельту.
    const p = await mkProp('user/req-p');
    const q = await mkProp('user/req-q');
    ok(
      await runH('aspect_delta_set', {
        aspect: 'orbis/task',
        delta: { properties: { add: [{ propertyId: p, required: true, rank: 71 }] } },
      }),
    );
    ok(await runH('property_merge', { source: p, into: q }));

    const refs = await taskRefs();
    expect(refs.find((r) => r.propertyId === q)).toEqual({ propertyId: q, required: true });
    expect(refs.some((r) => r.propertyId === p)).toBe(false);

    // ГЛАВНОЕ: запись по аспекту проходит. Проверяется боевым путём — тулом `attach_*`,
    // который собирается из того же эффективного определения и валидируется им же.
    const entity = newId();
    ok(await runH('entity_create', { id: entity, title: 'Задача после слияния', tags: [] }));
    const attached = await runH('attach_orbis_task', {
      entity_id: entity,
      data: { 'orbis/task_status': 'inbox', [q]: 3 },
    });
    // Отказ печатается ЦЕЛИКОМ: `toBe(true)` на исходе операции сказал бы «false» и ни
    // слова о том, почему аспект не принял запись, — а в этом тесте вопрос ровно в этом.
    if (!attached.ok) {
      throw new Error(`attach отказал: ${attached.error.code} ${attached.error.message}`);
    }
    const row = await withIdentity(db, holderOwner, (tx) =>
      tx.execute(sql`SELECT props FROM entities WHERE id = ${entity}::uuid`),
    );
    expect((row as unknown as Array<{ props: Record<string, unknown> }>)[0]?.props).toMatchObject({
      [q]: 3,
    });
  });

  test('отклонение proposed, на который ССЫЛАЕТСЯ ДЕЛЬТА, строку не удаляет (§А10-3)', async () => {
    // Второй, незакрытый вход в то же «висение», что чинилось для тел: `applyDeltas` на
    // несуществующий `propertyId` не падает — она молча пушит ссылку в состав аспекта, и
    // владелец видит поле, у которого нет определения.
    const created = ok(
      await runH('property_create', {
        key: 'user/delta-held',
        label: { ru: 'Под дельтой' },
        description: { ru: 'Предложение, названное дельтой' },
        type: { kind: 'number' },
        status: 'proposed',
      }),
    );
    const id = (created.results[0] as { property: string }).property;
    ok(
      await runH('aspect_delta_set', {
        aspect: 'orbis/note',
        delta: { properties: { add: [{ propertyId: id, required: false, rank: 72 }] } },
      }),
    );
    ok(await runH('property_update', { id, status: 'deprecated' }));
    const row = await propertyRowByKey(holderOwner, 'user/delta-held');
    expect(row).toBeDefined();
    expect(row?.status).toBe('deprecated');
  });

  test('дельта на НЕСУЩЕСТВУЮЩЕЕ свойство отвергнута; ключ нормализуется в id', async () => {
    const e = err(
      await runH('aspect_delta_set', {
        aspect: 'orbis/task',
        delta: {
          properties: { add: [{ propertyId: 'user/net-takogo', required: false, rank: 73 }] },
        },
      }),
    );
    expect((e.details as { reason?: string }).reason).toBe('DELTA_UNKNOWN_PROPERTY');

    // Адрес принимается и КЛЮЧОМ, но в строку ложится идентификатором: `applyDeltas` ищет
    // свойство в словаре по id, и записанный ключом адрес не резолвился бы никогда.
    const byKey = await mkProp('user/by-key-prop');
    ok(
      await runH('aspect_delta_set', {
        aspect: 'orbis/memory',
        delta: {
          properties: { add: [{ propertyId: 'user/by-key-prop', required: false, rank: 74 }] },
        },
      }),
    );
    const stored = (await withIdentity(db, holderOwner, (tx) =>
      tx.execute(sql`SELECT delta FROM registry_deltas
                     WHERE owner_id = ${holderOwner}::uuid AND target_id = 'orbis/memory'`),
    )) as unknown as Array<{ delta: { properties: { add: Array<{ propertyId: string }> } } }>;
    expect(stored[0]?.delta.properties.add[0]?.propertyId).toBe(byKey);
    const reg = await withIdentity(db, holderOwner, (tx) => effectiveRegistry(tx, holderOwner));
    expect((reg.aspects.get('orbis/memory')?.properties ?? []).map((r) => r.propertyId)).toContain(
      byKey,
    );
  });
});

// ---------------------------------------------------------------------------
// Фикс-раунд 4: слияние не запирает реестр молча (§А3-2 × §А3-4 × §А10-2)
// ---------------------------------------------------------------------------

describe('слияние отказывает громко, если после него реестр не читается', () => {
  const lockOwner2 = freshUserId();

  function runL(tool: string, input: unknown): Promise<ExecuteResult> {
    return execute(
      db,
      { actorUserId: lockOwner2, actorKind: 'owner', source: 'ui', operations: [{ tool, input }] },
      { sink },
    );
  }

  async function mkProp(key: string, over: Record<string, unknown> = {}): Promise<string> {
    const r = ok(
      await runL('property_create', {
        key,
        label: { ru: key },
        description: { ru: key },
        type: { kind: 'number' },
        status: 'active',
        ...over,
      }),
    );
    return (r.results[0] as { property: string }).property;
  }

  /** Читается ли реестр — вопросом, который задаёт КАЖДЫЙ вызов исполнителя. */
  async function registryReadable(): Promise<boolean> {
    return (await runL('entity_create', { title: 'проба читаемости', tags: [] })).ok;
  }

  test('ДВЕРЬ 1: дельта объявляет ОБА свойства — отказ, а не DELTA_PROPERTY_PRESENT навсегда', async () => {
    // По отдельности всё законно: одна дельта вправе добавить на аспект два своих свойства.
    // После переименования обе ссылки `add[]` указывали бы на одну цель, и `applyDeltas`
    // бросала бы `DELTA_PROPERTY_PRESENT` на КАЖДОМ чтении реестра — заперт не аспект, а
    // весь граф владельца, включая снятие дельты и откат самого слияния.
    const p = await mkProp('user/door1-p');
    const q = await mkProp('user/door1-q');
    ok(
      await runL('aspect_delta_set', {
        aspect: 'orbis/task',
        delta: {
          properties: {
            add: [
              { propertyId: p, required: false, rank: 80 },
              { propertyId: q, required: false, rank: 81 },
            ],
          },
        },
      }),
    );

    const e = err(await runL('property_merge', { source: p, into: q }));
    expect(e.code).toBe('REGISTRY_CONFLICT');
    expect((e.details as { reason?: string }).reason).toBe('MERGE_REGISTRY_UNREADABLE');
    // Причина исходного отказа доезжает целиком — иначе владельцу нечем понять, ЧТО
    // разбирать в настройке.
    expect(JSON.stringify((e.details as { cause?: unknown }).cause)).toContain(
      'DELTA_PROPERTY_PRESENT',
    );

    // Ничего не применено И реестр читается — обе половины, потому что вторая тут дороже.
    expect(await registryReadable()).toBe(true);
    const rows = (await withIdentity(db, lockOwner2, (tx) =>
      tx.execute(sql`SELECT id, status, merged_into FROM property_definitions
                     WHERE owner_id = ${lockOwner2}::uuid AND id IN (${p}, ${q})`),
    )) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) expect(row).toMatchObject({ status: 'active', merged_into: null });
    // И выход есть: разобрав настройку, владелец сливает как хотел.
    ok(
      await runL('aspect_delta_set', {
        aspect: 'orbis/task',
        delta: { properties: { add: [{ propertyId: q, required: false, rank: 81 }] } },
      }),
    );
    ok(await runL('property_merge', { source: p, into: q }));
  });

  test('ДВЕРЬ 2: одно через дельту, другое через scope — тот же громкий отказ (§А3-4)', async () => {
    // Третья дверь в §А3-4: две первые (правка и откат) закрыты пробой ДО записи, а слияние
    // въезжало в то же состояние мимо неё.
    const p = await mkProp('user/door2-p');
    const q = await mkProp('user/door2-q', { scope: { filter: { aspect: 'orbis/goal' } } });
    ok(
      await runL('aspect_delta_set', {
        aspect: 'orbis/goal',
        delta: { properties: { add: [{ propertyId: p, required: false, rank: 82 }] } },
      }),
    );

    const e = err(await runL('property_merge', { source: p, into: q }));
    expect(e.code).toBe('REGISTRY_CONFLICT');
    expect((e.details as { reason?: string }).reason).toBe('MERGE_REGISTRY_UNREADABLE');
    expect(JSON.stringify((e.details as { cause?: unknown }).cause)).toContain('SCOPE_DUPLICATE');
    expect(await registryReadable()).toBe(true);
    const row = (await withIdentity(db, lockOwner2, (tx) =>
      tx.execute(sql`SELECT status, merged_into FROM property_definitions
                     WHERE owner_id = ${lockOwner2}::uuid AND id = ${p}`),
    )) as unknown as Array<Record<string, unknown>>;
    expect(row[0]).toMatchObject({ status: 'active', merged_into: null });
  });

  test('обычное слияние под дельтой проба НЕ трогает (отказ адресный, а не «на всякий случай»)', async () => {
    const p = await mkProp('user/ok-p');
    const q = await mkProp('user/ok-q');
    ok(
      await runL('aspect_delta_set', {
        aspect: 'orbis/note',
        delta: { properties: { add: [{ propertyId: p, required: false, rank: 83 }] } },
      }),
    );
    ok(await runL('property_merge', { source: p, into: q }));
    const reg = await withIdentity(db, lockOwner2, (tx) => effectiveRegistry(tx, lockOwner2));
    expect((reg.aspects.get('orbis/note')?.properties ?? []).map((r) => r.propertyId)).toContain(q);
  });

  test('MERGE_TYPE называет то, что сравнивал, а не один kind', async () => {
    const a = await mkProp('user/type-num-a');
    const r = ok(
      await runL('property_create', {
        key: 'user/type-num-b',
        label: { ru: 'С границей' },
        description: { ru: 'Тот же kind, другой конфиг' },
        type: { kind: 'number', min: 0 },
        status: 'active',
      }),
    );
    const b = (r.results[0] as { property: string }).property;
    const e = err(await runL('property_merge', { source: a, into: b }));
    expect((e.details as { reason?: string }).reason).toBe('MERGE_TYPE');
    // Прежнее сообщение печатало «number и number» — по нему нельзя было понять, что
    // разошлось. Теперь в тексте видна сама разница.
    expect(e.message).toContain('"min":0');
    expect((e.details as { sourceType?: unknown }).sourceType).toEqual({ kind: 'number' });
  });
});

// ---------------------------------------------------------------------------
// Держатели свойства: перечень мест, адресующих свойство (§А3-5, §А10-2, §А10-3)
// ---------------------------------------------------------------------------

describe('collectPropertyHolders: род `body` — по индексу query_refs', () => {
  test('collectPropertyHolders на query_refs не теряет ни одного смарт-листа', async () => {
    // ГЛАВНЫЕ ДЕРЖАТЕЛИ ВЛАДЕЛЬЦА — сидированные смарт-листы: шесть тел, одиннадцать
    // блоков, и стоят они на встроенных свойствах, которые владелец как раз и сливает со
    // своими. Перевод перечня с обхода markdown на колонку `query_refs` потерял бы их все
    // разом, если бы сид колонку не заполнял: чтение документ собирает, но в БД не пишет,
    // и колонка осталась бы пустой навсегда. Потеря была бы ТИХОЙ — слияние отчиталось бы
    // «переписано запросов: 0», а проба §А10-3 разрешила бы удалить строку из-под живого
    // списка.
    const seedUser = freshUserId();
    await seedOwnerGraph(db, seedUser);

    const holders = await withIdentity(db, seedUser, (tx) => collectPropertyHolders(tx, seedUser));
    const bodies = new Map(
      holders.filter((h) => h.kind === 'body').map((h) => [h.id, h.properties]),
    );
    for (const list of SEED_SMART_LISTS) {
      const id = seedSmartListId(seedUser, list.slug);
      expect([list.slug, bodies.has(id)]).toEqual([list.slug, true]);
    }
    // …и это перечень АДРЕСОВ, а не «функция вернула массив»: у «Рутин» обязаны быть все
    // четыре свойства, которыми её блоки фильтруют и сортируют.
    const routines = bodies.get(seedSmartListId(seedUser, 'routines')) ?? [];
    expect([...routines].sort()).toEqual(
      expect.arrayContaining([
        'orbis/routine_stage',
        'orbis/run_outcome',
        'orbis/run_started_at',
        'orbis/undecided',
      ]),
    );
  });

  test('тело, записанное МИМО индекса, держателем не считается — вот чем оплачен перевод', async () => {
    // Обратная сторона перевода, названная вслух: перечень теперь ровно настолько полон,
    // насколько полна колонка. Писатель тела, который её не заполняет, делает свою запись
    // невидимой для слияния и для пробы §А10-3 — и это ровно та причина, по которой сид
    // (`smartListRow`) и слияние (`mergeProperty`) её теперь пишут.
    const dark = freshUserId();
    const hidden = newId();
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.insert(entities).values({
        id: hidden,
        ownerId: dark,
        title: 'Тело мимо индекса',
        body: '{{query:aspect=orbis/task, orbis/task_status=inbox}}',
        tags: [],
      });
    } finally {
      await adminClient.end();
    }
    const holders = await withIdentity(db, dark, (tx) => collectPropertyHolders(tx, dark));
    expect(holders.filter((h) => h.kind === 'body').map((h) => h.id)).not.toContain(hidden);
  });
});

// ---------------------------------------------------------------------------
// §А5-2: имена в дереве — id. Нормализация key → id на входе и перед записью
// ---------------------------------------------------------------------------

describe('нормализация имён в дереве Q-AST (§А5-2)', () => {
  const astOwner = freshUserId();

  function runAst(tool: string, input: unknown): Promise<ExecuteResult> {
    return execute(
      db,
      { actorUserId: astOwner, actorKind: 'owner', source: 'ui', operations: [{ tool, input }] },
      { sink },
    );
  }

  function call(name: string, input: unknown): Promise<ToolDispatchResult> {
    return dispatchTool(
      { db, actorUserId: astOwner, actorKind: 'owner', source: 'chat', explicitCommand: false },
      name,
      input,
    );
  }

  test('entity_query.ast по KEY своего свойства даёт то же, что тот же key ТЕКСТОМ', async () => {
    // Обещание промпта v5 («в дереве стоят те же key свойств и аспектов») против
    // компилятора, который резолвит строго по id. У встроенных `id == key`, поэтому
    // расхождение появляется на ПЕРВОЙ ЖЕ своей строке — и это головная фича среза.
    const created = ok(
      await runAst('property_create', {
        key: 'user/effort_points',
        label: { ru: 'Баллы усилия' },
        description: { ru: 'Своя оценка усилия' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    const propId = (created.results[0] as { property: string }).property;
    ok(
      await runAst('entity_create', {
        title: 'Тяжёлое дело',
        tags: [],
        props: { [propId]: 5 },
      }),
    );
    ok(await runAst('entity_create', { title: 'Лёгкое дело', tags: [], props: { [propId]: 1 } }));

    const byText = await call('entity_query', { query: 'user/effort_points>3' });
    const byTree = await call('entity_query', {
      ast: { filter: { prop: 'user/effort_points', op: 'gt', value: 3 } },
    });
    expect(byText.status).toBe('ok');
    // СЕГОДНЯ БЕЗ ФИКСА: VALIDATION/UNKNOWN_FIELD «такого id нет в реестре владельца».
    expect(byTree.status).toBe('ok');
    expect(JSON.stringify((byTree as { result?: unknown }).result)).toBe(
      JSON.stringify((byText as { result?: unknown }).result),
    );

    // Неизвестное имя по-прежнему отвергает КОМПИЛЯТОР, а не нормализация: второго мнения
    // о том, что есть в реестре, не заводится.
    const unknown = await call('entity_query', {
      ast: { filter: { prop: 'user/нет-такого', op: 'eq', value: 1 } },
    });
    expect(unknown.status).toBe('error');
  });

  test('ref.target по KEY своего свойства ложится в строку реестра идентификатором', async () => {
    // Дерево цели ХРАНИТСЯ, и key в нём — тихий отказ: пикер ссылочного свойства пуст,
    // а слияние ищет держателей по обоим именам, но переписывает в id.
    const base = ok(
      await runAst('property_create', {
        key: 'user/weight',
        label: { ru: 'Вес' },
        description: { ru: 'Числовое свойство-цель ссылки' },
        type: { kind: 'number' },
        status: 'active',
      }),
    );
    const baseId = (base.results[0] as { property: string }).property;

    const ref = ok(
      await runAst('property_create', {
        key: 'user/heavy-ref',
        label: { ru: 'Тяжёлая запись' },
        description: { ru: 'Ссылка на запись с большим весом' },
        type: {
          kind: 'ref',
          target: {
            filter: {
              and: [{ aspect: 'orbis/task' }, { prop: 'user/weight', op: 'gt', value: 3 }],
            },
          },
        },
        status: 'active',
      }),
    );
    const refId = (ref.results[0] as { property: string }).property;

    const rows = (await withIdentity(db, astOwner, (tx) =>
      tx.execute(sql`SELECT type FROM property_definitions
                     WHERE owner_id = ${astOwner}::uuid AND id = ${refId}`),
    )) as unknown as Array<{ type: { target: { filter: { and: Array<{ prop?: string }> } } } }>;
    const named = rows[0]?.type.target.filter.and.find((n) => n.prop !== undefined);
    expect(named?.prop).toBe(baseId);
  });
});
