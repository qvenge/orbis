// apps/server/src/routers/entity.test.ts
// Интеграционные тесты Task 12: роутеры entity/relation через createCallerFactory
// против живой БД. Роутеры — только трансляция: вход → executor/компилятор,
// результат → wire, ошибки executor'а → TRPCError (§9.1, §5.2, §6.4).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import { entitySchema, entityThreadId, entityUpdateInput, globalThreadId } from '@orbis/shared';
import { PAGE_ONLY_HINT, QUERY_TREE_DEPTH_CAP } from '@orbis/shared/query';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { actionsOf, journalOf } from '../../test/journal-helpers';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import { appRouter } from '../router';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

/** Caller от лица владельца: ctx как в бою — actorUserId + db (§9.1). */
function callerFor(user: GraphId) {
  return createCaller({ identity: personal(user), actorKind: 'owner', db, clientVersion: null });
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

/** Ошибка вызова процедуры — TRPCError с внятным падением при успехе. */
async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

describe('entity.create / entity.get (§9.2)', () => {
  test('create→get круговой: аспекты сохранены, wire-форма проходит entitySchema', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: {
        title: 'Разобрать входящие',
        tags: ['Task', 'task'],
        body: 'Текст задачи',
        props: {
          'orbis/task_status': 'inbox',
        },
        aspects: ['orbis/task'],
      },
      source: 'fast_path',
    });
    expect(() => entitySchema.parse(created)).not.toThrow();
    expect(created.graphId).toBe(user);
    expect(created.tags).toEqual(['task']); // нормализация executor'а, не роутера
    expect(created.createdAt.endsWith('Z')).toBe(true);
    // actionId — аддитивное поле поверх wire-сущности (Undo из UI-форм, 03-budget §3.6)
    const { actionId, consequences, ...createdEntity } = created;
    expect(typeof consequences).toBe('boolean');
    expect(typeof actionId).toBe('string');

    const got = await caller.entity.get({ id: created.id });
    expect(got.entity).toEqual(createdEntity);
    expect(got.entity.props['orbis/task_status']).toBe('inbox');
    expect(got.entity.aspects).toEqual(['orbis/task']);
    // include default — body+relations; backlinks/thread не запрошены (§9.2)
    expect(got.relations).toEqual([]);
    expect(got.backlinks).toBeUndefined();
    expect(got.thread).toBeUndefined();
  });

  test('невалидный source create отклоняется на входе (zod роутера) → BAD_REQUEST', async () => {
    const caller = callerFor(await freshGraph());
    const e = await trpcError(
      caller.entity.create({
        input: { title: 'X', tags: [] },
        // @ts-expect-error: 'chat' не входит в enum клиентских источников create
        source: 'chat',
      }),
    );
    expect(e.code).toBe('BAD_REQUEST');
  });

  test('create с client-UUID, занятым чужой сущностью → CONFLICT (409), id_conflict в cause', async () => {
    // Единый wire-контракт id_conflict (финальное ревью): entity_create маппится
    // на тот же CONFLICT/409, что и chat.appendMessage — 1b MCP и 1c retry-буфер
    // ключуются на кодах, а не на текстах.
    const owner = callerFor(await freshGraph());
    const created = await owner.entity.create({
      input: { title: 'Своя', tags: [] },
      source: 'fast_path',
    });
    const e = await trpcError(
      callerFor(await freshGraph()).entity.create({
        input: { id: created.id, title: 'Чужая', tags: [] },
        source: 'fast_path',
      }),
    );
    expect(e.code).toBe('CONFLICT');
    const cause = e.cause as unknown as { code: string; details?: { reason?: string } };
    expect(cause.code).toBe('CONFLICT');
    expect(cause.details?.reason).toBe('id_conflict');
  });

  test('actionId из create пригоден для ai.undo; идемпотентный replay actionId не отдаёт (03 §3.6)', async () => {
    const caller = callerFor(await freshGraph());
    const id = crypto.randomUUID();
    const created = await caller.entity.create({
      input: { id, title: 'Обед 340', tags: [] },
      source: 'quick_capture',
    });
    expect(typeof created.actionId).toBe('string');

    // Повтор того же client-UUID владельцем — идемпотентный replay (§5.3): журнал
    // не писался, actionId под этим запросом не существует → поле отсутствует.
    const replayed = await caller.entity.create({
      input: { id, title: 'Обед 340', tags: [] },
      source: 'quick_capture',
    });
    expect(replayed.id).toBe(id);
    expect(replayed.actionId).toBeUndefined();

    // Undo по actionId откатывает создание (инверсия — архивация, §7.8)
    const r = await caller.ai.undo({ actionId: created.actionId as string });
    expect(r.undone.id).toBe(created.actionId as string);
    const got = await caller.entity.get({ id });
    expect(got.entity.archived).toBe(true);
  });

  test('get несуществующей (или чужой под RLS) сущности → NOT_FOUND', async () => {
    const caller = callerFor(await freshGraph());
    const e = await trpcError(caller.entity.get({ id: crypto.randomUUID() }));
    expect(e.code).toBe('NOT_FOUND');
  });

  // Форма секции — { entity, via } с Task D5 (§3.5.8): объединяет related_to и body_refs.
  // Полное покрытие — routers/entity-backlinks.test.ts.
  test('get include=backlinks: упоминание через body_refs → via mention', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const target = await caller.entity.create({
      input: { title: 'Цель ссылки', tags: [] },
      source: 'fast_path',
    });
    const referrer = await caller.entity.create({
      input: { title: 'Ссылающаяся', tags: [], body: `см. [[entity:${target.id}]]` },
      source: 'fast_path',
    });
    const got = await caller.entity.get({ id: target.id, include: ['backlinks'] });
    expect(got.backlinks?.map((b) => b.entity.id)).toEqual([referrer.id]);
    expect(got.backlinks?.[0]?.via).toBe('mention');
    expect(got.relations).toBeUndefined(); // include явный — relations не запрошены
  });

  test('get include=thread: детерминированный entityThreadId, лениво НЕ создаёт', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const e = await caller.entity.create({
      input: { title: 'С тредом', tags: [] },
      source: 'quick_capture',
    });
    const got = await caller.entity.get({ id: e.id, include: ['thread'] });
    expect(got.thread).toEqual({ threadId: entityThreadId(user, e.id), messages: [] });

    // тред НЕ создан (лениво): в chat_threads строки нет
    const { db: admin, client: adminClient } = adminDb();
    try {
      const rows = await admin.execute(
        sql`SELECT count(*)::int AS n FROM chat_threads WHERE id = ${entityThreadId(user, e.id)}`,
      );
      expect(rows[0]?.n).toBe(0);
    } finally {
      await adminClient.end();
    }
  });

  // Д-7: тред в entity.get отдавался целиком и без фильтра — маркеры «думает» и журнал с телами уходили клиенту и агентам.
  // Теперь это та же выдача, что chat.listMessages (`journal/thread-page.ts`): страница 50, без маркеров, карточки журнала
  // треда — без тел действия.
  test('get include=thread: страница 50 новых первыми тем же читателем, что listMessages; маркер «думает» скрыт; журнал — без тел', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const e = await caller.entity.create({
      input: { title: 'Длинный тред', tags: [] },
      source: 'ui',
    });
    const { threadId } = await caller.chat.ensureThread({ entityId: e.id });
    const base = Date.UTC(2026, 8, 1, 9, 0, 0);
    const { db: admin, client: adminClient } = adminDb();
    try {
      for (let i = 0; i < 55; i += 1) {
        await admin.execute(
          sql`INSERT INTO chat_messages (id, thread_id, role, content, created_at)
              VALUES (gen_random_uuid(), ${threadId}::uuid, 'user', ${`сообщение ${i}`},
                      ${new Date(base + i * 1000).toISOString()}::timestamptz)`,
        );
      }
      await admin.execute(
        sql`INSERT INTO chat_messages (id, thread_id, role, content, metadata, created_at)
            VALUES (gen_random_uuid(), ${threadId}::uuid, 'system', '', '{"type":"processing"}'::jsonb,
                    ${new Date(base + 60_000).toISOString()}::timestamptz)`,
      );
    } finally {
      await adminClient.end();
    }
    // Правка из разговора в треде записи — карточка журнала этого треда (время — сейчас, новее всех сообщений)
    const upd = await execute(
      db,
      {
        identity: personal(user),
        actorKind: 'ai',
        source: 'chat',
        threadId,
        operations: [{ tool: 'entity_update', input: { id: e.id, title: 'Длинный тред 2' } }],
      },
      { sink: makeJournalSink() },
    );
    expect(upd.ok).toBe(true);

    const got = await caller.entity.get({ id: e.id, include: ['thread'] });
    const messages = got.thread?.messages ?? [];
    expect(messages.length).toBe(50);
    expect(messages.some((m) => m.metadata.type === 'processing')).toBe(false);
    expect(messages[0]?.role).toBe('system'); // карточка правки — самая новая
    expect(JSON.stringify(messages[0]?.metadata)).not.toContain('"operations"');
    expect(messages[1]?.content).toBe('сообщение 54');
    expect(messages[49]?.content).toBe('сообщение 6');
  });
});

/**
 * Процедура через HTTP-обработчик, как в бою: `data.orbis` кладёт `errorFormatter`, а caller (`createCallerFactory`)
 * отдаёт ошибку ДО форматирования формы — проверять провод им нельзя (та же причина, что в `trpc.test.ts`).
 */
async function postMutation(
  user: GraphId,
  path: string,
  input: unknown,
): Promise<{ status: number; body: { error?: { data?: Record<string, unknown> } } }> {
  const res = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request(`http://localhost/trpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    router: appRouter,
    createContext: () => ({
      identity: personal(user),
      actorKind: 'owner' as const,
      db,
      clientVersion: null,
    }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { error?: { data?: Record<string, unknown> } },
  };
}

describe('замок заголовка владельца через интерфейс (§8.2)', () => {
  test('MCP переименовывает без замка; устаревший expectedTitle от UI даёт структурный отказ, совпавший — успех', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: { title: 'прежнее', tags: [] },
      source: 'ui',
    });
    const agent = await dispatchTool(
      { db, identity: personal(user), actorKind: 'agent', source: 'mcp', explicitCommand: false },
      'entity_update',
      { id: created.id, title: 'агентское' },
    );
    expect(agent.status).toBe('ok');
    expect(entityUpdateInput.shape).not.toHaveProperty('expectedTitle');
    expect(
      entityUpdateInput.safeParse({ id: created.id, title: 'x', expectedTitle: 'агентское' })
        .success,
    ).toBe(false);
    const res = await postMutation(user, 'entity.update', {
      id: created.id,
      title: 'новое',
      expectedTitle: 'прежнее',
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.data?.orbis).toEqual({
      code: 'CONFLICT',
      details: {
        reason: 'precondition_failed',
        mismatches: [{ property: 'orbis/title', expected: ['прежнее'], actual: 'агентское' }],
      },
    });
    expect((await caller.entity.get({ id: created.id })).entity.title).toBe('агентское');
    const ok = await postMutation(user, 'entity.update', {
      id: created.id,
      title: 'новое',
      expectedTitle: 'агентское',
    });
    expect(ok.status).toBe(200);
    expect((await caller.entity.get({ id: created.id })).entity.title).toBe('новое');
  });

  test('пачка переводит expectedTitle каждого элемента: отказ атомарен, совпавший замок проходит', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const a = await caller.entity.create({ input: { title: 'А', tags: [] }, source: 'ui' });
    const b = await caller.entity.create({ input: { title: 'Б', tags: [] }, source: 'ui' });
    const res = await postMutation(user, 'entity.updateBatch', {
      operations: [
        { tool: 'entity_update', input: { id: a.id, title: 'А2', expectedTitle: 'А' } },
        { tool: 'entity_update', input: { id: b.id, title: 'Б2', expectedTitle: 'прежнее' } },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.data?.orbis).toEqual({
      code: 'CONFLICT',
      details: {
        reason: 'precondition_failed',
        mismatches: [{ property: 'orbis/title', expected: ['прежнее'], actual: 'Б' }],
      },
    });
    expect((await caller.entity.get({ id: a.id })).entity.title).toBe('А');
    const ok = await postMutation(user, 'entity.updateBatch', {
      operations: [{ tool: 'entity_update', input: { id: b.id, title: 'Б2', expectedTitle: 'Б' } }],
    });
    expect(ok.status).toBe(200);
    expect((await caller.entity.get({ id: b.id })).entity.title).toBe('Б2');
  });
});

describe('entity.update: замок текста по ревизии тела (спека скорости §8.1–§8.2)', () => {
  test('стухшая ревизия → CONFLICT; повтор с ревизией из ответа — успех; tags — LWW без проверки', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: { title: 'Документ', tags: [], body: 'v1' },
      source: 'fast_path',
    });
    expect(created.bodyRevision).toBe(1);

    // Конкурентная правка тела сдвигает ревизию
    const fresh = await caller.entity.update({
      id: created.id,
      body: 'v2',
      expectedBodyRevision: created.bodyRevision,
    });
    expect([fresh.body, fresh.bodyRevision]).toEqual(['v2', 2]);

    // Правка со стухшей ревизией — 409 CONFLICT, исходная ошибка в cause
    const e = await trpcError(
      caller.entity.update({
        id: created.id,
        body: 'v3',
        expectedBodyRevision: created.bodyRevision,
      }),
    );
    expect(e.code).toBe('CONFLICT');
    expect((e.cause as unknown as { code: string }).code).toBe('STALE_VERSION');

    // Повтор с ревизией из ответа — успех
    const v3 = await caller.entity.update({
      id: created.id,
      body: 'v3',
      expectedBodyRevision: fresh.bodyRevision,
    });
    expect(v3.body).toBe('v3');

    // tags — LWW: без ревизии применяется поверх любых версий
    const tagged = await caller.entity.update({ id: created.id, tags: ['Приоритет'] });
    expect(tagged.tags).toEqual(['приоритет']);
    expect(tagged.body).toBe('v3'); // body не тронут

    // body без ревизии — VALIDATION → BAD_REQUEST (§8.1)
    const noCheck = await trpcError(caller.entity.update({ id: created.id, body: 'v4' }));
    expect(noCheck.code).toBe('BAD_REQUEST');

    // Прежнее поле провода — отказ разбора: переходного слоя нет (§8.2)
    const legacy = await trpcError(
      caller.entity.update({
        id: created.id,
        body: 'v4',
        expectedUpdatedAt: tagged.updatedAt,
      } as unknown as Parameters<typeof caller.entity.update>[0]),
    );
    expect(legacy.code).toBe('BAD_REQUEST');
  });

  test('провод: 409 несёт data.orbis = {code: STALE_VERSION, details: {id, expected, current}} — и ни слова тела (РП-5)', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const secret = 'ТЕКСТ-ЗАПИСИ-НЕ-ДЛЯ-ПРОВОДА';
    const created = await caller.entity.create({
      input: { title: 'Провод', tags: [], body: secret },
      source: 'ui',
    });
    await caller.entity.update({ id: created.id, body: `${secret} 2`, expectedBodyRevision: 1 });

    const res = await postMutation(user, 'entity.update', {
      id: created.id,
      body: `${secret} 3`,
      expectedBodyRevision: 1,
    });
    expect(res.status).toBe(409);
    const data = res.body.error?.data ?? {};
    expect(data.code).toBe('CONFLICT');
    expect(data.orbis).toEqual({
      code: 'STALE_VERSION',
      details: { id: created.id, expected: 1, current: 2 },
    });
    expect(JSON.stringify(res.body)).not.toContain(secret);

    // VALIDATION в закрытом списке с задачи 10 (повторная отмена) — но несёт ТОЛЬКО причину: id записи не уходит
    const bad = await postMutation(user, 'entity.update', { id: created.id, body: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.data?.orbis).toEqual({ code: 'VALIDATION', details: {} });

    // Отказ вне закрытого списка кодов поля orbis не несёт: канал — только для перечисленных отказов
    const missing = await postMutation(user, 'entity.update', {
      id: crypto.randomUUID(),
      title: 'нет такой',
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error?.data?.orbis).toBeUndefined();
  });

  test('audit-сообщение update атрибутировано source=ui (прямое действие владельца в UI, не fast_path)', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: { title: 'Атрибуция', tags: [] },
      source: 'fast_path',
    });
    await caller.entity.update({ id: created.id, title: 'Атрибуция 2' });

    const journal = await actionsOf(user);
    const action = journal.find((e) => e.type === 'entity_updated');
    expect(action?.source).toBe('ui');
    // Правка владельца в интерфейсе — без треда (Р-12); быстрый ввод без threadId — глобальный тред
    expect(action?.threadId).toBeNull();
    // create по-прежнему несёт клиентский source (fast_path), не 'ui'
    const create = journal.find((e) => e.type === 'entity_created');
    expect(create?.source).toBe('fast_path');
    expect(create?.threadId).toBe(globalThreadId(user));
  });

  // РП-13: быстрый ввод ложится в тред ввода — карточка, которую клиент положил в этот тред оптимистично, после
  // перечитывания треда приходит с сервера туда же. Тред — только у быстрого ввода: правке в интерфейсе треда не
  // положено (Р-12), и принимать его молча значило бы делать вид, что он что-то значит.
  test('threadId во входе create: fast_path → запись журнала в этом треде; ui с threadId → VALIDATION; чужой тред → NOT_FOUND', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const host = await caller.entity.create({ input: { title: 'Хост', tags: [] }, source: 'ui' });
    const { threadId } = await caller.chat.ensureThread({ entityId: host.id });
    const fast = await caller.entity.create({
      input: { title: 'В тред ввода', tags: [] },
      source: 'fast_path',
      threadId,
    });
    if (fast.actionId === undefined) throw new Error('нет actionId');
    expect((await journalOf(user, fast.actionId))?.threadId).toBe(threadId);

    const wrongSource = await trpcError(
      caller.entity.create({ input: { title: 'Не туда', tags: [] }, source: 'ui', threadId }),
    );
    expect(wrongSource.code).toBe('BAD_REQUEST');
    expect((wrongSource.cause as unknown as { code: string }).code).toBe('VALIDATION');

    // Чужой тред под RLS не виден — тот же отказ, что у несуществующего; записи нет
    const other = await freshGraph();
    const foreign = await callerFor(other).chat.ensureThread({});
    const before = (await actionsOf(user)).length;
    const hidden = await trpcError(
      caller.entity.create({
        input: { title: 'В чужой тред', tags: [] },
        source: 'fast_path',
        threadId: foreign.threadId,
      }),
    );
    expect(hidden.code).toBe('NOT_FOUND');
    expect((await actionsOf(user)).length).toBe(before);
  });
});

describe('entity.query / entity.count (§6.3–6.4)', () => {
  test('query блока Inbox (02 §3.3) находит созданную задачу', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: {
        title: 'Входящая задача',
        tags: [],
        props: {
          'orbis/task_status': 'inbox',
        },
        aspects: ['orbis/task'],
      },
      source: 'fast_path',
    });
    const rows = await caller.entity.query({
      query:
        'aspect=orbis/task, orbis/task_status=inbox, sortBy=orbis/created_at:desc, display=list, title=Inbox',
    });
    expect(rows.map((r) => r.id)).toEqual([created.id]);
    expect(() => entitySchema.parse(rows[0])).not.toThrow(); // wire-форма и у query-выдачи
  });

  /**
   * ВТОРОЙ ВХОД чтения — готовое дерево (§А5-4). Его завела Задача 13c ради пикера
   * ссылочных свойств: цель `ref` объявлена в реестре ДЕРЕВОМ (§А6-1), а плоский текст
   * §А5-3 дерева не выражает — печать `or`/`not` даёт скобочную форму, которую разбор
   * честно отвергает. Печатать цель в текст, чтобы сервер разобрал её обратно, значило бы
   * пропускать её через форму, в которую она не помещается.
   */
  test('entity.query со входом `ast`: то же дерево, что разобрал бы текст, — та же выдача', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: {
        title: 'Задача деревом',
        tags: [],
        props: { 'orbis/task_status': 'inbox' },
        aspects: ['orbis/task'],
      },
      source: 'ui',
    });
    await caller.entity.create({ input: { title: 'Просто заметка', tags: [] }, source: 'ui' });

    const byText = await caller.entity.query({ query: 'aspect=orbis/task' });
    const byAst = await caller.entity.query({ ast: { filter: { aspect: 'orbis/task' } } });
    expect(byAst.map((r) => r.id)).toEqual([created.id]);
    // Формы РАЗНЫЕ, путь ОДИН: расхождение выдач означало бы два компилятора.
    expect(byAst.map((r) => r.id)).toEqual(byText.map((r) => r.id));
    // …и то же у счётчика: сигнатура у обоих чтений общая.
    expect(await caller.entity.count({ ast: { filter: { aspect: 'orbis/task' } } })).toEqual({
      count: 1,
    });
  });

  /**
   * Настройки показа блока данных (спека страниц §5.4, §11.3) — ПРОЕКЦИЯ, а не предикаты:
   * компилятор их не читает, и запрос с плиткой или колонками исполняется как обычный.
   * Иначе блок данных страницы и `entity_query` модели разошлись бы в выдаче на одном тексте.
   */
  test('ключи проекции §5.4 (tile, aggregate, columns, hide_empty) — запрос исполняется как обычный', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: {
        title: 'Задача под плиткой',
        tags: [],
        props: { 'orbis/task_status': 'inbox' },
        aspects: ['orbis/task'],
      },
      source: 'ui',
    });
    const plain = await caller.entity.query({ query: 'aspect=orbis/task' });
    expect(plain.map((r) => r.id)).toEqual([created.id]);

    const tile = await caller.entity.query({
      query: 'aspect=orbis/task, display=tile, aggregate=count, hide_empty',
    });
    expect(tile.map((r) => r.id)).toEqual([created.id]);
    const table = await caller.entity.query({
      query: 'aspect=orbis/task, display=table, columns=orbis/due_date|orbis/priority',
    });
    expect(table.map((r) => r.id)).toEqual([created.id]);
    // Тот же путь у дерева и у счётчика.
    const byAst = await caller.entity.query({
      ast: {
        filter: { aspect: 'orbis/task' },
        display: 'tile',
        aggregate: { fn: 'sum', field: 'orbis/effort_min' },
      },
    });
    expect(byAst.map((r) => r.id)).toEqual([created.id]);
    expect(
      await caller.entity.count({ query: 'aspect=orbis/task, display=tile, aggregate=count' }),
    ).toEqual({ count: 1 });
    // Согласованность проекции держит и схема входа `ast:` (мимо разбора текста).
    const bad = await trpcError(
      caller.entity.query({ ast: { filter: { aspect: 'orbis/task' }, display: 'tile' } }),
    );
    expect(bad.code).toBe('BAD_REQUEST');
  });

  test('$-ссылка вне страницы — отказ с подсказкой и деревом, и текстом (1в §3.8)', async () => {
    const caller = callerFor(await freshGraph());
    const byAst = await trpcError(
      caller.entity.query({
        ast: { filter: { prop: 'orbis/due_date', op: 'eq', value: { param: 'period' } } } as never,
      }),
    );
    expect(byAst.code).toBe('BAD_REQUEST');
    expect(byAst.message).toContain(PAGE_ONLY_HINT);
    const byText = await trpcError(
      caller.entity.query({ query: 'aspect=orbis/task, orbis/due_date=$period' }),
    );
    expect(byText.code).toBe('BAD_REQUEST');
    expect(byText.message).toContain(PAGE_ONLY_HINT);
  });

  test('group вне страницы — отказ с подсказкой и деревом, и текстом (1в §3.8, задача 6)', async () => {
    const caller = callerFor(await freshGraph());
    const byAst = await trpcError(
      caller.entity.query({
        ast: { filter: null, group: { by: 'day', field: { contract: 'orbis/when' } } } as never,
      }),
    );
    expect(byAst.code).toBe('BAD_REQUEST');
    expect(byAst.message).toContain(PAGE_ONLY_HINT);
    const byText = await trpcError(
      caller.entity.query({ query: 'aspect=orbis/task, group=day:orbis/due_date' }),
    );
    expect(byText.code).toBe('BAD_REQUEST');
    expect(byText.message).toContain(PAGE_ONLY_HINT);
  });

  test('РОВНО одно из двух: и текст, и дерево — отказ; ни одного — тоже', async () => {
    const caller = callerFor(await freshGraph());
    // Два непустых входа — это два РАЗНЫХ запроса в одном вызове, и молчаливый выбор
    // победителя был бы невидимым отбором «не того» (§С8-3).
    const both = await trpcError(
      caller.entity.query({ query: 'aspect=orbis/task', ast: { filter: null } }),
    );
    expect(both.code).toBe('BAD_REQUEST');
    const neither = await trpcError(caller.entity.query({}));
    expect(neither.code).toBe('BAD_REQUEST');
  });

  /**
   * Кап глубины — ГРАНИЦА ЯЗЫКА, а не страховка от падения, и мутация это показала:
   * со снятым гейтом дерево в 128 уровней проходит и zod, и компилятор, и Postgres —
   * отказ приходит только от нас. Ниже по конвейеру пороги на порядки выше (докблок
   * `QUERY_TREE_DEPTH_CAP`), и запас между ними — то, ради чего кап и стоит первым.
   */
  test('дерево глубже капа — структурный отказ с НАЗВАННЫМ числом (§А5-7)', async () => {
    const caller = callerFor(await freshGraph());
    // Кап меряется по ДЕРЕВУ; строим вдвое глубже него, чтобы проба не зависела от того,
    // считает ли конверт сам код.
    let deep: unknown = { tag: 'дом' };
    for (let i = 0; i < QUERY_TREE_DEPTH_CAP * 2; i++) deep = { not: deep };
    const e = await trpcError(caller.entity.query({ ast: { filter: deep } as never }));
    expect(e.code).toBe('BAD_REQUEST');
    // Названо ИМЕННО то число, которое код и меряет.
    expect(e.message).toContain(String(QUERY_TREE_DEPTH_CAP));
  });

  test('count игнорирует limit (бейджи 02 §3.2), query — нет', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    for (const title of ['Одна', 'Две', 'Три']) {
      await caller.entity.create({
        input: {
          title,
          tags: [],
          props: {
            'orbis/task_status': 'inbox',
          },
          aspects: ['orbis/task'],
        },
        source: 'fast_path',
      });
    }
    const q = 'aspect=orbis/task, orbis/task_status=inbox, limit=1';
    expect((await caller.entity.query({ query: q })).length).toBe(1);
    expect(await caller.entity.count({ query: q })).toEqual({ count: 3 });
  });

  test('невалидный запрос → BAD_REQUEST с {message, position} в cause (§6.4)', async () => {
    const caller = callerFor(await freshGraph());
    const e = await trpcError(caller.entity.query({ query: 'nosuchfield=42' }));
    expect(e.code).toBe('BAD_REQUEST');
    const cause = e.cause as unknown as { message: string; position: number };
    expect(typeof cause.message).toBe('string');
    expect(cause.position).toBe(0); // неизвестное поле — позиция его начала
    // count — тот же контракт ошибок
    const e2 = await trpcError(caller.entity.count({ query: 'nosuchfield=42' }));
    expect(e2.code).toBe('BAD_REQUEST');
  });
});

describe('relation.create / relation.delete / relation.listFor (§4.2)', () => {
  test('listFor видит обе стороны; delete → { ok: true }; самосвязь → UNPROCESSABLE_CONTENT', async () => {
    const user = await freshGraph();
    const caller = callerFor(user);
    const a = await caller.entity.create({ input: { title: 'A', tags: [] }, source: 'fast_path' });
    const b = await caller.entity.create({ input: { title: 'B', tags: [] }, source: 'fast_path' });
    const c = await caller.entity.create({ input: { title: 'C', tags: [] }, source: 'fast_path' });

    const ab = await caller.relation.create({
      source_id: a.id,
      target_id: b.id,
      role: 'mention',
    });
    expect(ab.sourceId).toBe(a.id);
    expect(ab.createdAt.endsWith('Z')).toBe(true);
    const ca = await caller.relation.create({
      source_id: c.id,
      target_id: a.id,
      role: 'subitem',
    });

    // обе стороны: A — source в ab и target в ca
    const forA = await caller.relation.listFor({ entityId: a.id });
    expect(forA.map((r) => r.id).sort()).toEqual([ab.id, ca.id].sort());
    // у get default include relations — те же обе стороны
    const got = await caller.entity.get({ id: a.id });
    expect(got.relations?.map((r) => r.id).sort()).toEqual([ab.id, ca.id].sort());

    // самосвязь — INVARIANT → UNPROCESSABLE_CONTENT
    const self = await trpcError(
      caller.relation.create({ source_id: a.id, target_id: a.id, role: 'mention' }),
    );
    expect(self.code).toBe('UNPROCESSABLE_CONTENT');
    expect((self.cause as unknown as { code: string }).code).toBe('INVARIANT');

    // удаление
    expect(
      await caller.relation.delete({
        source_id: a.id,
        target_id: b.id,
        role: 'mention',
      }),
    ).toMatchObject({ ok: true });
    expect((await caller.relation.listFor({ entityId: a.id })).map((r) => r.id)).toEqual([ca.id]);

    // повторное удаление — NOT_FOUND
    const gone = await trpcError(
      caller.relation.delete({ source_id: a.id, target_id: b.id, role: 'mention' }),
    );
    expect(gone.code).toBe('NOT_FOUND');
  });
});

describe('CAS-предусловие не протекает в tRPC (entity.update)', () => {
  test('precondition во входе entity.update → BAD_REQUEST, правка не применена', async () => {
    // Предусловие — параметр серверных путей (С7): его знает exec-схема executor'а,
    // а вход роутера (entityUpdateUiInput) — strict-надмножество тул-контракта БЕЗ него.
    // Клиент не должен получать CAS-рычаг вместе с обычной правкой карточки.
    const user = await freshGraph();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: {
        title: 'Тикет',
        tags: [],
        props: {
          'orbis/task_status': 'planned',
        },
        aspects: ['orbis/task'],
      },
      source: 'fast_path',
    });

    const e = await trpcError(
      caller.entity.update({
        id: created.id,
        // @ts-expect-error: precondition — параметр exec-схемы, вход роутера его не знает
        precondition: [{ property: 'orbis/task_status', in: ['planned'] }],
        props: {
          'orbis/task_status': 'in_progress',
        },
        aspects: { attach: ['orbis/task'] },
      }),
    );
    expect(e.code).toBe('BAD_REQUEST');

    const after = await caller.entity.get({ id: created.id });
    expect(after.entity.props['orbis/task_status']).toBe('planned');
  });
});
