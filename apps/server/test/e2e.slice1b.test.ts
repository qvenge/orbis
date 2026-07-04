// apps/server/test/e2e.slice1b.test.ts
// Сквозной e2e-сценарий слайса 1b (Task 12): «сценарий 9» из 02 §5 — внешний агент
// (Claude Code через MCP) ведёт проект «Orbis», владелец наблюдает, подтверждает и
// откатывает. Две поверхности сходятся на одной живой БД:
//   • владелец — tRPC-caller (createCallerFactory, actorKind:'owner'): его мутации графа
//     на ownerOnlyProcedure (Task 10b) — entity.create/update, chat.*, ai.undoLast/approve;
//   • агент — НАСТОЯЩИЙ MCP-клиент SDK (Client + StreamableHTTPClientTransport) с PAT
//     против реально поднятого Hono-приложения (makeMcpHandler) на свободном порту;
//   • внутренний чат владельца — ScriptedProvider (ни одного реального LLM-вызова).
// Не TDD — интеграция уже принятого ядра (Task 1–11 + MCP-адаптер Task 10/10b). Один
// describe, последовательные test-шаги (bun исполняет в порядке объявления), общий state
// в переменных describe-скоупа; truncateAll — один раз в beforeAll.
//
// Известный нюанс §9.3 (шаг 3): сообщение в тред НЕ трогает entities.updated_at, поэтому
// курсор entity_query(updated_at>курсор) не поймал бы задачу от одной лишь инструкции.
// Разрешение (для e2e и жизни): владелец, оставляя инструкцию, меняет статус задачи
// (entity.update → in_progress) — правка двигает updated_at, курсор ловит. Ниже это
// доказано явно: до правки статуса query по курсору задачу НЕ находит, после — находит.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { entityThreadId, globalThreadId, newId } from '@orbis/shared';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import type { WireChatMessage } from '../src/chat/messages';
import { aiUsage, chatMessages, entities } from '../src/db/schema';
import { withIdentity } from '../src/db/with-identity';
import { execute } from '../src/executor/executor';
import type { ActionRecord, WireEntity } from '../src/executor/types';
import { ScriptedProvider } from '../src/llm/scripted';
import { makeMcpHandler } from '../src/mcp/transport';
import { appRouter } from '../src/router';
import type { Card } from '../src/tools/registry';
import { createCallerFactory } from '../src/trpc';
import { appDb, freshUserId, requireEnv, truncateAll } from './helpers';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const createCaller = createCallerFactory(appRouter);

// Фиксированный «выданный» PAT формата issue-pat (префикс + 64 hex); hash — env-контракт Task 3
const TOKEN = `orbis_pat_${'a7'.repeat(32)}`;
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

// Фиксированное «сейчас» для метеринга ai_usage (§4.7): день UTC = 2026-07-05.
const T0 = new Date('2026-07-05T10:00:00.000Z');
const TODAY = '2026-07-05';
const MODEL = 'scripted-model';

const savedEnv = {
  ORBIS_PAT_HASH: process.env.ORBIS_PAT_HASH,
  ORBIS_PAT_OWNER_ID: process.env.ORBIS_PAT_OWNER_ID,
};

let mcp: ReturnType<typeof Bun.serve>;
const mcpUrl = () => `http://127.0.0.1:${mcp.port}/mcp`;

/** Владелец аккаунта — tRPC-caller (владельческая поверхность, не MCP). */
const ownerCaller = createCaller({
  actorUserId: owner,
  actorKind: 'owner',
  db,
  clientVersion: null,
});

beforeAll(async () => {
  await truncateAll();
  process.env.ORBIS_PAT_HASH = sha256hex(TOKEN);
  process.env.ORBIS_PAT_OWNER_ID = owner;

  const app = new Hono();
  app.all('/mcp', makeMcpHandler({ db }));
  mcp = Bun.serve({ port: 0, fetch: app.fetch });
});

afterAll(async () => {
  mcp?.stop(true);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await client.end();
});

// ---------------------------------------------------------------------------
// Хелперы (паттерны из mcp.test.ts — эталон MCP-части)
// ---------------------------------------------------------------------------

/** MCP-клиент SDK, подключённый к url с Bearer-PAT. */
async function connectAgent(url: string = mcpUrl(), token: string = TOKEN): Promise<Client> {
  const agent = new Client({ name: 'test-agent', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await agent.connect(transport);
  return agent;
}

/** tools/call + разбор единственного text-контента как JSON (контракт адаптера). */
async function callTool(
  agent: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const r = await agent.callTool({ name, arguments: args });
  const content = r.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe('text');
  return {
    isError: r.isError === true,
    payload: JSON.parse(content[0]?.text ?? '') as Record<string, unknown>,
  };
}

/** actions[0] всех audit-сообщений глобального треда владельца (§7.8). */
async function globalAuditActions(): Promise<ActionRecord[]> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, globalThreadId(owner)))
      .orderBy(chatMessages.createdAt, chatMessages.id),
  );
  return rows
    .filter((r) => r.role === 'system')
    .map((r) => (r.metadata as { actions?: ActionRecord[] }).actions?.[0])
    .filter((a): a is ActionRecord => a !== undefined);
}

/** Сид-сущность владельца через executor без синка — без audit-шума в тредах. */
async function seedEntity(input: Record<string, unknown>): Promise<WireEntity> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool: 'entity_create', input }],
  });
  if (!r.ok) throw new Error(`seedEntity: ${r.error.code} ${r.error.message}`);
  return r.results[0] as WireEntity;
}

async function entityRow(id: string) {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select().from(entities).where(eq(entities.id, id)),
  );
  return rows[0];
}

function taskStatus(row: { aspects: unknown } | undefined): string | undefined {
  const aspects = row?.aspects as Record<string, Record<string, unknown>> | undefined;
  return aspects?.['orbis/task']?.status as string | undefined;
}

function cardsOf(msg: { metadata: Record<string, unknown> }): Card[] {
  return (msg.metadata as { cards?: Card[] }).cards ?? [];
}

// ===========================================================================
// HTTP-смоук /mcp (шаг 2 брифа): tools/list — 200 с PAT, 401 без
// ===========================================================================

describe('/mcp HTTP-смоук: tools/list — 200 с PAT, 401 без (§9.3)', () => {
  const listBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const headers = (extra: Record<string, string>) => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  });

  test('без Authorization → 401 UNAUTHORIZED (auth ДО MCP-логики, fail-closed)', async () => {
    const res = await fetch(mcpUrl(), { method: 'POST', headers: headers({}), body: listBody });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });

  test('с валидным PAT → 200, tools/list отдаёт реестр (thread_post + entity_create в составе)', async () => {
    const res = await fetch(mcpUrl(), {
      method: 'POST',
      headers: headers({ authorization: `Bearer ${TOKEN}` }),
      body: listBody,
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    // enableJsonResponse: тело — JSON-RPC-ответ (может прийти как text/event-stream data-кадр)
    const json =
      raw.startsWith('event:') || raw.startsWith('data:') ? raw.slice(raw.indexOf('{')) : raw;
    const body = JSON.parse(json) as { result?: { tools?: Array<{ name: string }> } };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('thread_post');
    expect(names).toContain('entity_create');
    expect(names).not.toContain('user_query'); // internalOnly не публикуется
  });
});

// ===========================================================================
// Сценарий 9 (02 §5): агентная петля — 8 последовательных шагов
// ===========================================================================

describe('e2e слайс 1b: агент через MCP ведёт проект «Orbis» (02 §5, сценарий 9)', () => {
  // Общий state сценария — заполняется по шагам, читается последующими.
  let projectId = '';
  let task1Id = '';
  let task2Id = '';
  let noteId = '';
  let cursor0 = ''; // курсор «что нового», хранит агент (§9.3)
  let doneActionId = ''; // id агентского entity_update→done (для undoLast шага 5)
  const archiveIds: string[] = []; // цели bulk-архивации шага 6

  test('шаг 0: онбординг владельца (глобальный тред + настройки для экспорта)', async () => {
    expect(await ownerCaller.user.seedOnboarding()).toEqual({ seeded: true });
    // Глобальный тред создан сидом — в него executor кладёт audit агентских действий (§2.3)
    expect(await ownerCaller.chat.ensureThread({})).toEqual({ threadId: globalThreadId(owner) });
  });

  // ── Шаг 1: агент создаёт проект + 2 задачи (parent) + note-сущность ─────────
  test('шаг 1: агент через MCP создаёт проект «Orbis», 2 задачи (relation parent) и note; audit actor_kind=agent в глобальном треде', async () => {
    const agent = await connectAgent();
    try {
      const project = await callTool(agent, 'entity_create', {
        title: 'Orbis',
        tags: ['project'],
      });
      expect(project.isError).toBe(false);
      projectId = (project.payload.result as WireEntity).id;
      expect((project.payload.card as { kind: string }).kind).toBe('entity_card');

      const t1 = await callTool(agent, 'entity_create', {
        title: 'Серверное ядро',
        tags: ['task'],
        aspects: { 'orbis/task': { status: 'inbox' } },
      });
      expect(t1.isError).toBe(false);
      task1Id = (t1.payload.result as WireEntity).id;

      const t2 = await callTool(agent, 'entity_create', {
        title: 'MCP-адаптер',
        tags: ['task'],
        aspects: { 'orbis/task': { status: 'inbox' } },
      });
      expect(t2.isError).toBe(false);
      task2Id = (t2.payload.result as WireEntity).id;

      // Задачи внутри проекта: проект — родитель (§4.2)
      for (const childId of [task1Id, task2Id]) {
        const rel = await callTool(agent, 'relation_create', {
          source_id: projectId,
          target_id: childId,
          relation_type: 'parent',
        });
        expect(rel.isError).toBe(false);
      }

      // Документация переносится note-сущностью (§9 «переносит документацию note-сущностями»)
      const note = await callTool(agent, 'entity_create', {
        title: 'Архитектура Orbis',
        tags: ['note'],
        body: 'Ядро online-first + агентная петля.',
        aspects: { 'orbis/note': {} },
      });
      expect(note.isError).toBe(false);
      noteId = (note.payload.result as WireEntity).id;
    } finally {
      await agent.close();
    }

    // Все пять сущностей реально в графе владельца
    for (const id of [projectId, task1Id, task2Id, noteId]) {
      expect(await entityRow(id)).toBeDefined();
    }

    // Audit — системные сообщения в ГЛОБАЛЬНОМ треде владельца с actor_kind=agent,
    // source=mcp (02 §2.3, §7.8): действия агента видимы владельцу, атрибуция честная
    const actions = await globalAuditActions();
    const agentActions = actions.filter((a) => a.actor_kind === 'agent' && a.source === 'mcp');
    // 3 entity_created (проект+2 задачи+note = 4 create) + 2 relation_created
    expect(agentActions.filter((a) => a.type === 'entity_created')).toHaveLength(4);
    expect(agentActions.filter((a) => a.type === 'relation_created')).toHaveLength(2);
    for (const a of agentActions) expect(a.actor_user_id).toBe(owner);
    // Создание проекта отражено
    expect(agentActions.some((a) => a.entity_id === projectId && a.type === 'entity_created')).toBe(
      true,
    );
  });

  // ── Шаг 2: владелец пишет инструкцию в тред задачи 1 ───────────────────────
  test('шаг 2: владелец (tRPC) оставляет инструкцию в треде задачи 1', async () => {
    const { threadId } = await ownerCaller.chat.ensureThread({ entityId: task1Id });
    expect(threadId).toBe(entityThreadId(owner, task1Id));
    const msg = await ownerCaller.chat.appendUserMessage({
      id: newId(),
      threadId,
      content: 'Инструкция для агента: собери цифры и закрой задачу «Серверное ядро»',
    });
    expect(msg.role).toBe('user');
  });

  // ── Шаг 3: петля «что нового» + нюанс §9.3 ─────────────────────────────────
  test('шаг 3: сообщение в тред НЕ двигает курсор; правка статуса владельцем — двигает (нюанс §9.3)', async () => {
    // Курсор агента — момент прошлого опроса; берётся ПОСЛЕ инструкции шага 2, но ДО
    // правки статуса. Равен updated_at задачи, который сообщение в тред не сдвинуло.
    // +1ms поверх ms-огрублённого wire-updatedAt покрывает µs-хвост значения в БД.
    const agent = await connectAgent();
    try {
      const got0 = await callTool(agent, 'entity_get', { id: task1Id });
      const updatedAt = (got0.payload.result as { entity: WireEntity }).entity.updatedAt;
      cursor0 = new Date(Date.parse(updatedAt) + 1).toISOString();

      // До правки статуса: курсор задачу НЕ находит — инструкция в треде updated_at не двигала
      const before = await callTool(agent, 'entity_query', { query: `updated_at>${cursor0}` });
      expect(before.isError).toBe(false);
      expect((before.payload.result as WireEntity[]).map((e) => e.id)).not.toContain(task1Id);

      // Разрешение нюанса: владелец, оставив инструкцию, двигает статус (сигнал агенту)
      await ownerCaller.entity.update({
        id: task1Id,
        aspects: { 'orbis/task': { status: 'in_progress' } },
      });

      // Теперь тот же курсор ловит задачу — updated_at пересёк курсор
      const after = await callTool(agent, 'entity_query', { query: `updated_at>${cursor0}` });
      expect(after.isError).toBe(false);
      expect((after.payload.result as WireEntity[]).map((e) => e.id)).toContain(task1Id);
    } finally {
      await agent.close();
    }
  });

  // ── Шаг 4: агент читает тред, закрывает задачу, пишет заметку ───────────────
  test('шаг 4: агент entity_get(thread) читает инструкцию → entity_update→done → thread_post заметку', async () => {
    const agent = await connectAgent();
    try {
      // entity_get include:['thread'] отдаёт инструкцию владельца из треда задачи
      const got = await callTool(agent, 'entity_get', { id: task1Id, include: ['thread'] });
      expect(got.isError).toBe(false);
      const thread = (got.payload.result as { thread: { messages: WireChatMessage[] } }).thread;
      expect(
        thread.messages.some(
          (m) => m.role === 'user' && m.content.includes('Инструкция для агента'),
        ),
      ).toBe(true);

      // Работа сделана вне Orbis — агент закрывает задачу
      const done = await callTool(agent, 'entity_update', {
        id: task1Id,
        aspects: { 'orbis/task': { status: 'done' } },
      });
      expect(done.isError).toBe(false);

      // Заметка о результате — в тред задачи (§2.2), автор помечен как agent (§9.3)
      const note = await callTool(agent, 'thread_post', {
        entity_id: task1Id,
        content: 'Готово: цифры собраны, задача закрыта',
      });
      expect(note.isError).toBe(false);
    } finally {
      await agent.close();
    }

    // Статус в графе — done (shallow-merge аспекта); completed_at нормализован сервером
    const row = await entityRow(task1Id);
    expect(taskStatus(row)).toBe('done');

    // Агентский entity_update→done journaled в глобальный тред (actor 'agent'/'mcp')
    const doneAction = (await globalAuditActions()).find(
      (a) => a.actor_kind === 'agent' && a.type === 'entity_updated' && a.entity_id === task1Id,
    );
    expect(doneAction).toBeDefined();
    expect(doneAction?.source).toBe('mcp');
    doneActionId = doneAction?.id ?? '';
    expect(doneActionId).not.toBe('');

    // Заметка агента — в треде сущности, с честной пометкой author_kind=agent (§9.3)
    const threadRows = await withIdentity(db, owner, (tx) =>
      tx
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.threadId, entityThreadId(owner, task1Id))),
    );
    const agentNote = threadRows.find(
      (m) => (m.metadata as { author_kind?: string }).author_kind === 'agent',
    );
    expect(agentNote?.content).toContain('Готово');
  });

  // ── Шаг 5: владелец откатывает последнее действие агента, затем возвращает ──
  test('шаг 5: ai.undoLast гасит агентский done; повторный entity_update возвращает статус (Undo для агентов §7.8)', async () => {
    // Последнее journaled-действие — агентский entity_update→done (thread_post идёт мимо
    // журнала). undoLast гасит именно его — Undo распространяется на действия агентов.
    const undone = await ownerCaller.ai.undoLast();
    expect(undone.ok).toBe(true);
    expect(undone.actionId).toBe(doneActionId);

    // Статус откатился к in_progress (inverse восстановил ключ; completed_at снят)
    const reverted = await entityRow(task1Id);
    expect(taskStatus(reverted)).toBe('in_progress');
    expect(
      (reverted?.aspects as Record<string, Record<string, unknown>>)['orbis/task']?.completed_at,
    ).toBeUndefined();

    // Владелец повторным update возвращает статус в done
    await ownerCaller.entity.update({
      id: task1Id,
      aspects: { 'orbis/task': { status: 'done' } },
    });
    expect(taskStatus(await entityRow(task1Id))).toBe('done');
  });

  // ── Шаг 6: bulk-архивация агента → pending → approve владельца ──────────────
  test('шаг 6: batch_execute 11 архиваций → pending; ai.approve исполняет; повтор — идемпотентный replay (§7.10)', async () => {
    for (let i = 0; i < 11; i++) {
      archiveIds.push((await seedEntity({ title: `Черновик ${i}`, tags: [] })).id);
    }

    let pendingId = '';
    const agent = await connectAgent();
    try {
      const r = await callTool(agent, 'batch_execute', {
        batch_id: newId(),
        operations: archiveIds.map((id) => ({
          tool: 'entity_update',
          input: { id, archived: true },
        })),
      });
      // Ожидание подтверждения — не сбой: честный не-error ответ агенту (§9.3)
      expect(r.isError).toBe(false);
      expect(r.payload.status).toBe('pending_confirmation');
      pendingId = r.payload.pendingId as string;
      expect(pendingId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await agent.close();
    }

    // До approve владельца граф не тронут — ни одна сущность не заархивирована
    const before = await withIdentity(db, owner, (tx) =>
      tx
        .select({ archived: entities.archived })
        .from(entities)
        .where(inArray(entities.id, archiveIds)),
    );
    expect(before).toHaveLength(11);
    for (const row of before) expect(row.archived).toBe(false);

    // Владелец подтверждает — исполняется сохранённый payload полным конвейером
    const approved = await ownerCaller.ai.approve({ pendingId });
    expect(approved.ok).toBe(true);
    expect(approved.idempotentReplay).toBe(false);

    const after = await withIdentity(db, owner, (tx) =>
      tx
        .select({ archived: entities.archived })
        .from(entities)
        .where(inArray(entities.id, archiveIds)),
    );
    expect(after).toHaveLength(11);
    for (const row of after) expect(row.archived).toBe(true);

    // Повторный approve — идемпотентный replay по PK audit-сообщения (§7.8)
    const again = await ownerCaller.ai.approve({ pendingId });
    expect(again.idempotentReplay).toBe(true);
  });

  // ── Шаг 7: внутренний чат владельца (ScriptedProvider) — query_result + метеринг ─
  test('шаг 7: ai.sendMessage «что по задачам?» (ScriptedProvider) → query_result-карточка; ai_usage инкрементирован', async () => {
    const scripted = new ScriptedProvider([
      {
        content: '',
        toolCalls: [{ id: 'c0', name: 'entity_query', input: { query: 'aspect=orbis/task' } }],
        usage: { inputTokens: 120, outputTokens: 20 },
        stopReason: 'tool_use',
      },
      {
        content: 'Задача «Серверное ядро» закрыта, «MCP-адаптер» в работе.',
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 30 },
        stopReason: 'end_turn',
      },
    ]);
    const chatCaller = createCaller({
      actorUserId: owner,
      actorKind: 'owner',
      db,
      clientVersion: null,
      ai: { provider: scripted, model: MODEL, clock: () => T0 },
    });

    const r = await chatCaller.ai.sendMessage({
      id: newId(),
      threadId: globalThreadId(owner),
      content: 'что по задачам?',
    });
    expect(r.assistantMessage.role).toBe('assistant');
    expect(cardsOf(r.assistantMessage).some((c) => c.kind === 'query_result')).toBe(true);
    expect(scripted.requests).toHaveLength(2); // никакого реального LLM — только скрипт

    // Метеринг §4.7: строка за день UTC инкрементирована суммой обоих шагов
    const usage = await withIdentity(db, owner, (tx) =>
      tx.select().from(aiUsage).where(eq(aiUsage.date, TODAY)),
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      model: MODEL,
      inputTokens: 320,
      outputTokens: 50,
      requestCount: 2,
    });
  });

  // ── Шаг 8: экспорт владельца содержит весь результат агентной петли ────────
  test('шаг 8: exportData содержит проект/задачи/note и треды с сообщениями агента', async () => {
    const exp = await ownerCaller.user.exportData();
    expect(exp.format).toBe('orbis-export');

    // Проект, обе задачи и note присутствуют в дампе
    const ids = new Set(exp.entities.map((e) => e.id));
    for (const id of [projectId, task1Id, task2Id, noteId]) expect(ids.has(id)).toBe(true);
    for (const id of archiveIds) expect(ids.has(id)).toBe(true);

    // Связи проект→задача (parent) — обе в дампе
    const parents = exp.relations.filter(
      (r) => r.relationType === 'parent' && r.sourceId === projectId,
    );
    expect(parents.map((r) => r.targetId).sort()).toEqual([task1Id, task2Id].sort());

    // Тред задачи 1 присутствует с инструкцией владельца и заметкой агента
    const taskThreadId = entityThreadId(owner, task1Id);
    expect(exp.chatThreads.some((t) => t.id === taskThreadId && t.entityId === task1Id)).toBe(true);
    const taskMsgs = exp.chatMessages.filter((m) => m.threadId === taskThreadId);
    expect(
      taskMsgs.some((m) => m.role === 'user' && m.content.includes('Инструкция для агента')),
    ).toBe(true);
    expect(
      taskMsgs.some((m) => (m.metadata as { author_kind?: string }).author_kind === 'agent'),
    ).toBe(true);

    // Глобальный тред несёт audit агентских действий (actor_kind=agent)
    const globalMsgs = exp.chatMessages.filter((m) => m.threadId === globalThreadId(owner));
    expect(
      globalMsgs.some((m) =>
        ((m.metadata as { actions?: ActionRecord[] }).actions ?? []).some(
          (a) => a.actor_kind === 'agent',
        ),
      ),
    ).toBe(true);
  });
});
