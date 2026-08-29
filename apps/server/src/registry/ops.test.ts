// apps/server/src/registry/ops.test.ts
// Операции реестра через исполнителя (§А10-2, §А2-7, §А3-2, приёмка §С8-5) — против ЖИВОЙ
// базы: это первые писатели реестра снаружи сида, и всё, что здесь проверяется, — про то,
// как они ведут себя с ДАННЫМИ ВЛАДЕЛЬЦА, а не про форму входа.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import type { Tx } from '../db/with-identity';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteRequest, ExecuteResult } from '../executor/types';
import { undoAction } from '../executor/undo';
import { approvePending } from '../policy/pending';
import { dispatchTool, type ToolDispatchResult } from '../tools/dispatch';
import { effectiveRegistry } from './cache';
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
    const e = err(
      await run('property_create', {
        // Занят встроенным: уникальность БД разведена по `owner_id IS NULL`, и своя строка
        // с этим ключом легла бы молча, а `resolvePropertyRef` начал бы отдавать два разных
        // свойства по одному имени.
        key: 'orbis/task_status',
        label: { ru: 'Свой статус' },
        description: { ru: 'Дубль' },
        type: { kind: 'text' },
        status: 'active',
      }),
    );
    expect(e.code).toBe('VALIDATION');
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
    // Тело: переписан ТОЛЬКО блок запроса; то же слово в прозе — не ссылка.
    const bodyAfter = String((await ownEntity(withBody)).body);
    expect(bodyAfter).toContain(`{{query: aspect=orbis/task, ${intoId}=5}}`);
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
    const mk = async (key: string): Promise<string> => {
      const r = await call('property_create', {
        key,
        label: { ru: key },
        description: { ru: key },
        type: { kind: 'number' },
        status: 'active',
      });
      if (r.status !== 'ok') throw new Error(`создание ${key} не прошло: ${JSON.stringify(r)}`);
      return (r.result as { property: string }).property;
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

    const r = await call('property_merge', { source, into });
    expect(r.status).toBe('error');
    expect(r.status === 'error' && r.error.code).toBe('REGISTRY_CONFLICT');

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
    const pendings = (await withIdentity(db, conflictOwner, (tx) =>
      tx.execute(sql`SELECT id, content, metadata FROM chat_messages
                     WHERE metadata @> '{"pending":{"tool":"property_merge"}}'::jsonb`),
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

    // Повтор того же слияния возвращает ТУ ЖЕ карточку, а не плодит вторую.
    const again = await call('property_merge', { source, into });
    expect(again.status).toBe('error');
    const after = (await withIdentity(db, conflictOwner, (tx) =>
      tx.execute(sql`SELECT id FROM chat_messages
                     WHERE metadata @> '{"pending":{"tool":"property_merge"}}'::jsonb`),
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
