// apps/server/src/journal/thread-page.test.ts
// Тред — объединение НА ЧТЕНИИ (спека скорости §11.3): сообщения треда и карточки журнала этого треда одной
// процедурой с общим курсором `(время, id)`. Элемент журнала — `metadata.journal` (сводка без тел, §9) и карточка
// ленты у быстрого ввода и рутины; какие действия в треде видны и с «Отменить» ли — таблица источников §11.3
// (Р-12, Р-16, К-29, К-36, К-42); запись отмены своей строки не имеет (К-45: «отменено» — признак отменённого).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { GraphId, JournalCardMeta } from '@orbis/shared';
import { globalThreadId, newId, processingMessageId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  accountOf,
  adminDb,
  appDb,
  freshGraph,
  personal,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { journalOf } from '../../test/journal-helpers';
import { appendMessage, type WireChatMessage } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import type { ExecuteOk, ExecuteRequest, MutationSource, WireEntity } from '../executor/types';
import { undoAction } from '../executor/undo';
import { approvePending } from '../policy/pending';
import { dispatchTool } from '../tools/dispatch';
import { threadPage } from './thread-page';

requireEnv();

const { db, client } = appDb();
const sink = makeJournalSink();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

async function run(g: GraphId, over: Partial<ExecuteRequest> & { tool: string; input: unknown }) {
  const { tool, input, ...rest } = over;
  const r = await execute(
    db,
    {
      identity: personal(g),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool, input }],
      ...rest,
    },
    { sink },
  );
  if (!r.ok) throw new Error(r.error.message);
  return r as ExecuteOk;
}

const create = (
  g: GraphId,
  title: string,
  source: MutationSource,
  extra: Partial<ExecuteRequest> = {},
) => run(g, { tool: 'entity_create', input: { title, tags: [] }, source, ...extra });

function page(g: GraphId, thread: string, p: { before?: string; limit: number }) {
  return withIdentity(db, personal(g), (tx) => threadPage(tx, g, thread, p));
}

const cursorOf = (m: WireChatMessage): string => `${m.createdAt}|${m.id}`;

const journalMeta = (m: WireChatMessage): JournalCardMeta | undefined =>
  m.metadata.journal as JournalCardMeta | undefined;

/** id действия строки журнала — из сводки (`metadata.journal.actionId`); у сообщения — его id. */
const keyOf = (m: WireChatMessage): string => journalMeta(m)?.actionId ?? m.id;

/** (createdAt DESC, id DESC) — порядок выдачи треда. */
function isDescending(items: readonly WireChatMessage[]): boolean {
  for (let i = 1; i < items.length; i += 1) {
    const a = items[i - 1] as WireChatMessage;
    const b = items[i] as WireChatMessage;
    if (a.createdAt < b.createdAt) return false;
    if (a.createdAt === b.createdAt && a.id <= b.id) return false;
  }
  return true;
}

/** Тел действия в проводе нет (§9): ни операций, ни inverse, ни результатов пачки, ни аккаунта актора. */
function expectNoBodies(items: readonly WireChatMessage[]): void {
  for (const m of items) {
    const text = JSON.stringify(m.metadata);
    for (const k of ['operations', 'inverse', 'results', 'actor_user_id', 'actorUserId']) {
      expect([k, text.includes(`"${k}"`)]).toEqual([k, false]);
    }
  }
}

describe('threadPage: сообщения и карточки журнала одной выдачей (§11.3)', () => {
  test('два сообщения и два действия: порядок по (время, id), курсор без пропусков и повторов на стыке таблиц, без тел; маркер, правка владельца, system и запись отмены скрыты', async () => {
    const g = await freshGraph();
    const thread = await withIdentity(db, personal(g), (tx) => ensureGlobalThread(tx, g));
    const say = (content: string, at?: Date) =>
      withIdentity(db, personal(g), async (tx) => {
        const id = newId();
        await tx.insert(chatMessages).values({
          id,
          threadId: thread,
          role: 'user',
          content,
          ...(at !== undefined && { createdAt: at }),
        });
        return id;
      });

    const first = await say('первое');
    const fast = await create(g, 'Быстрая', 'fast_path');
    const fastEntity = (fast.results[0] as WireEntity).id;
    // Сообщение РОВНО в миллисекунду записи журнала: стык двух таблиц с равным временем держит тай-брейк по id
    const fastAt = (await journalOf(g, fast.actionId))?.createdAt;
    if (fastAt === undefined) throw new Error('записи fast_path нет');
    const twin = await say('близнец по времени', fastAt);
    const agent = await run(g, {
      tool: 'entity_update',
      input: { id: fastEntity, title: 'Правка агента' },
      source: 'mcp',
      actorKind: 'agent',
    });
    // Правка владельца в интерфейсе и системная запись — даже с явным тредом в треде не видны (Р-12)
    const ui = await run(g, {
      tool: 'entity_update',
      input: { id: fastEntity, title: 'Правка в интерфейсе' },
      threadId: thread,
    });
    await create(g, 'Системное', 'system', { mechanism: 'materialize', threadId: thread });
    // Маркер «думает» ai.sendMessage — инфраструктура, не контент треда
    const userMsg = await say('запрос');
    await withIdentity(db, personal(g), (tx) =>
      appendMessage(tx, {
        id: processingMessageId(userMsg),
        threadId: thread,
        role: 'system',
        content: '',
        metadata: { type: 'processing', replyTo: userMsg },
      }),
    );
    // Отмена правки агента: запись отмены своей строки в треде не имеет (К-45) — отменённое помечено
    const undone = await undoAction(db, { identity: personal(g), actionId: agent.actionId });
    expect(undone.ok).toBe(true);

    const all = await page(g, thread, { limit: 50 });
    expect(new Set(all.map(keyOf))).toEqual(
      new Set([first, twin, fast.actionId, agent.actionId, userMsg]),
    );
    expect(all.some((m) => keyOf(m) === ui.actionId)).toBe(false);
    expect(isDescending(all)).toBe(true);
    // Постранично по одному — тот же список: ни пропуска, ни повтора, в том числе на стыке равного времени
    const paged: WireChatMessage[] = [];
    let before: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const p = await page(g, thread, { limit: 1, ...(before !== undefined && { before }) });
      if (p.length === 0) break;
      paged.push(...p);
      before = cursorOf(p[p.length - 1] as WireChatMessage);
    }
    expect(paged.map((m) => m.id)).toEqual(all.map((m) => m.id));

    const fastItem = all.find((m) => keyOf(m) === fast.actionId);
    const agentItem = all.find((m) => keyOf(m) === agent.actionId);
    if (fastItem === undefined || agentItem === undefined) throw new Error('карточек журнала нет');
    expect([fastItem.role, fastItem.content, fastItem.threadId]).toEqual([
      'system',
      'Быстрая',
      thread,
    ]);
    // id строки треда — производный (R-12), id действия — в сводке
    expect(fastItem.id).not.toBe(fast.actionId);
    expect(fastItem.metadata).toEqual({
      journal: {
        actionId: fast.actionId,
        source: 'fast_path',
        actorKind: 'owner',
        title: 'Быстрая',
        tool: 'entity_create',
        entityId: fastEntity,
        undoable: true,
        undone: false,
      },
      // fast_path — единственный носитель карточки (клиентская форма с «Отменить»)
      cards: [
        {
          kind: 'entity_card',
          entityId: fastEntity,
          title: 'Быстрая',
          aspects: [],
          keyFields: {},
          undoActionId: fast.actionId,
        },
      ],
    });
    // Агент вне прогона — строка-сводка с «Отменить» (Р-16); после отмены — признак на ней же
    expect(agentItem.metadata).toEqual({
      journal: {
        actionId: agent.actionId,
        source: 'mcp',
        actorKind: 'agent',
        title: 'Правка агента',
        tool: 'entity_update',
        entityId: fastEntity,
        undoable: true,
        undone: true,
      },
    });
    expectNoBodies(all);
    // Маркера «думает», system-действия и записи отмены в выдаче нет
    expect(all.some((m) => m.metadata.type === 'processing')).toBe(false);
    expect(all.some((m) => m.content === 'Системное')).toBe(false);
    expect(all.some((m) => m.content.startsWith('Отменено'))).toBe(false);
  });

  test('легаси-курсор `<iso>` без id — строго раньше по времени в обеих таблицах', async () => {
    const g = await freshGraph();
    const thread = await withIdentity(db, personal(g), (tx) => ensureGlobalThread(tx, g));
    const old = await create(g, 'Раньше', 'fast_path');
    const oldAt = (await journalOf(g, old.actionId))?.createdAt;
    if (oldAt === undefined) throw new Error('записи нет');
    await new Promise((r) => setTimeout(r, 5));
    await create(g, 'Позже', 'fast_path');
    const p = await page(g, thread, {
      limit: 10,
      before: new Date(oldAt.getTime() + 1).toISOString(),
    });
    expect(p.map(keyOf)).toEqual([old.actionId]);
  });
});

/**
 * Таблица источников §11.3 построчно: что каждое действие даёт в треде. «Ровно одна карточка на действие» (§13.1):
 * действие разговора с карточкой в ответе (`card_in_reply`, К-36) своей строки не имеет — карточку несёт ответ
 * ассистента; пачка разговора — строка журнала (К-29); быстрый ввод и рутина — клиентская карточка; агент вне прогона
 * — строка с «Отменить» (Р-16); глагол прогона агента — без «Отменить» (К-42); правки владельца в интерфейсе и
 * системные записи — без треда (Р-12).
 */
describe('таблица источников §11.3: что действие даёт в треде', () => {
  test('каждый источник — своя строка таблицы', async () => {
    const g = await freshGraph();
    const thread = globalThreadId(g);
    await withIdentity(db, personal(g), (tx) => ensureGlobalThread(tx, g));

    const chatInReply = await create(g, 'Карточка в ответе', 'chat', {
      actorKind: 'ai',
      threadId: thread,
      cardInReply: true,
    });
    const chatBatchId = newId();
    const chatBatch = await execute(
      db,
      {
        identity: personal(g),
        actorKind: 'ai',
        source: 'chat',
        threadId: thread,
        batchId: chatBatchId,
        operations: [
          { tool: 'entity_create', input: { title: 'п1', tags: [] } },
          { tool: 'entity_create', input: { title: 'п2', tags: [] } },
        ],
      },
      { sink },
    );
    expect(chatBatch.ok).toBe(true);
    const fast = await create(g, 'Быстрый ввод', 'fast_path', { threadId: thread });
    const runId = newId();
    const routine = await create(g, 'Создано рутиной', 'routine', {
      actorKind: 'ai',
      runId,
      threadId: thread,
    });
    const agent = await create(g, 'Агент вне прогона', 'mcp', { actorKind: 'agent' });
    const agentRunId = newId();
    const agentInRun = await create(g, 'Глагол прогона', 'mcp', {
      actorKind: 'agent',
      runId: agentRunId,
    });
    const owner = await create(g, 'Владелец в интерфейсе', 'ui', { threadId: thread });
    const capture = await create(g, 'Быстрая запись', 'quick_capture', { threadId: thread });
    const system = await create(g, 'Системная', 'system', {
      mechanism: 'materialize',
      threadId: thread,
    });

    const items = await page(g, thread, { limit: 50 });
    const byAction = new Map(items.map((m) => [keyOf(m), m]));
    const meta = (id: string) => journalMeta(byAction.get(id) as WireChatMessage);
    const cards = (id: string) => byAction.get(id)?.metadata.cards;

    // chat с карточкой в ответе — строки журнала нет (одна карточка — в ответе ассистента)
    expect(byAction.has(chatInReply.actionId)).toBe(false);
    // пачка разговора — строка журнала с «Отменить», без клиентской карточки
    expect(meta(chatBatchId)).toMatchObject({ source: 'chat', actorKind: 'ai', undoable: true });
    expect(cards(chatBatchId)).toBeUndefined();
    // быстрый ввод и рутина — клиентская карточка с «Отменить»
    for (const [r, title] of [
      [fast, 'Быстрый ввод'],
      [routine, 'Создано рутиной'],
    ] as const) {
      expect(meta(r.actionId)?.undoable).toBe(true);
      expect(cards(r.actionId)).toEqual([
        {
          kind: 'entity_card',
          entityId: (r.results[0] as WireEntity).id,
          title,
          aspects: [],
          keyFields: {},
          undoActionId: r.actionId,
        },
      ]);
    }
    // прогон рутины назван в сводке — по нему лента подписывает «рутина»
    expect(meta(routine.actionId)).toMatchObject({ source: 'routine', runId });
    // агент вне прогона — строка-сводка с «Отменить» (Р-16), без карточки
    expect(meta(agent.actionId)).toMatchObject({
      source: 'mcp',
      actorKind: 'agent',
      undoable: true,
      undone: false,
    });
    expect(cards(agent.actionId)).toBeUndefined();
    // глагол прогона агента — строка без «Отменить» (К-42)
    expect(meta(agentInRun.actionId)).toMatchObject({ runId: agentRunId, undoable: false });
    // правки владельца в интерфейсе и системные — в треде их нет (Р-12)
    for (const r of [owner, capture, system]) expect(byAction.has(r.actionId)).toBe(false);
    // ровно одна строка на действие, которое тред показывает
    expect(
      items
        .filter((m) => journalMeta(m) !== undefined)
        .map(keyOf)
        .sort(),
    ).toEqual(
      [chatBatchId, fast.actionId, routine.actionId, agent.actionId, agentInRun.actionId].sort(),
    );
    expectNoBodies(items);
  });

  test('после отмены: undone на строке отменённого, записи отмены отдельным элементом нет (К-45)', async () => {
    const g = await freshGraph();
    const thread = await withIdentity(db, personal(g), (tx) => ensureGlobalThread(tx, g));
    const fast = await create(g, 'Отменю', 'fast_path');
    const before = await page(g, thread, { limit: 50 });
    expect(journalMeta(before[0] as WireChatMessage)?.undone).toBe(false);
    expect((await undoAction(db, { identity: personal(g), actionId: fast.actionId })).ok).toBe(
      true,
    );
    const after = await page(g, thread, { limit: 50 });
    expect(after.map(keyOf)).toEqual([fast.actionId]);
    expect(journalMeta(after[0] as WireChatMessage)?.undone).toBe(true);
  });
});

/** Все страницы выдачи по `limit` строк, курсор — `createdAt|id` последней строки (как строит клиент). */
async function allPages(g: GraphId, thread: string, limit: number): Promise<WireChatMessage[]> {
  const out: WireChatMessage[] = [];
  let before: string | undefined;
  for (let i = 0; i < 50; i += 1) {
    const p = await page(g, thread, { limit, ...(before !== undefined && { before }) });
    if (p.length === 0) break;
    out.push(...p);
    before = cursorOf(p[p.length - 1] as WireChatMessage);
  }
  return out;
}

/**
 * Рулинг R-12: одобренная единица исполняется пачкой с `batchId = pendingId`, ключ записи журнала — сам `batch_id`, а
 * карточка-запрос — сообщение треда с PK `pendingId`. Выдача треда — один поток: id его элементов уникальны, а курсор
 * однозначен и на стыке «запрос/одобрение» с равным временем. Единица — из разговора (архивация инициативой AI,
 * §7.10): одобрение системной единицы — правка владельца без треда (К-29), и стыка у неё нет.
 */
describe('threadPage: одобренная единица и её карточка-запрос — разные id на проводе (R-12)', () => {
  async function approvedUnit(g: GraphId): Promise<{ pendingId: string; thread: string }> {
    const who = personal(g);
    const thread = await withIdentity(db, who, (tx) => ensureGlobalThread(tx, g));
    const target = await create(g, 'Кандидат на архив', 'fast_path');
    const r = await dispatchTool(
      {
        db,
        identity: who,
        actorKind: 'ai',
        source: 'chat',
        threadId: thread,
        explicitCommand: false,
      },
      'entity_update',
      { id: (target.results[0] as WireEntity).id, archived: true },
    );
    if (r.status !== 'pending_confirmation')
      throw new Error(`ожидался запрос, получено ${r.status}`);
    const approved = await approvePending(db, { identity: who, pendingId: r.pendingId });
    if (!approved.ok) throw new Error(JSON.stringify(approved.error));
    expect(approved.actionId).toBe(r.pendingId); // ключ записи пачки — сам pendingId (хранимые ключи не тронуты)
    return { pendingId: r.pendingId, thread };
  }

  test('запрос → «Принять» → выдача треда: оба элемента на месте, id не повторяются, id действия — в сводке', async () => {
    const g = await freshGraph();
    const { pendingId, thread } = await approvedUnit(g);
    const items = await page(g, thread, { limit: 50 });
    const ids = items.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const request = items.find((m) => m.id === pendingId);
    const executed = items.find((m) => journalMeta(m)?.actionId === pendingId);
    expect(request?.metadata.pending).toBeDefined();
    expect(executed?.role).toBe('system');
    expect(executed?.id).not.toBe(pendingId);
    // Одобренная единица разговора — строка журнала с «Отменить» (К-29: карточкой ответа она не названа)
    expect(journalMeta(executed as WireChatMessage)?.undoable).toBe(true);
    // Производный id детерминирован: перечитывание треда даёт те же id (дедуп и ключи клиента стабильны)
    expect((await page(g, thread, { limit: 50 })).map((m) => m.id)).toEqual(ids);
  });

  test('стык «запрос/одобрение» с равным временем: постранично по одному — каждый элемент ровно один раз', async () => {
    const g = await freshGraph();
    const { pendingId, thread } = await approvedUnit(g);
    const at = (await journalOf(g, pendingId))?.createdAt;
    if (at === undefined) throw new Error('записи одобрения нет');
    // Подделка хранилища админ-DSN: время карточки-запроса — ровно время записи одобрения, стык двух таблиц
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.execute(
        sql`UPDATE chat_messages SET created_at = ${at.toISOString()}::timestamptz WHERE id = ${pendingId}::uuid`,
      );
    } finally {
      await adminClient.end();
    }
    const all = await page(g, thread, { limit: 50 });
    expect(all.filter((m) => keyOf(m) === pendingId)).toHaveLength(2);
    expect((await allPages(g, thread, 1)).map((m) => m.id)).toEqual(all.map((m) => m.id));
  });
});

// Порядок и курсор выборки журнала — по производному id элемента, а не по id записи: у записей одной транзакции время
// одно, и выборка с `LIMIT` обязана брать их в том же порядке, в каком их режет курсор, — иначе строка теряется.
test('несколько записей журнала с одним временем (одна транзакция): постранично по одному — все ровно по разу', async () => {
  const g = await freshGraph();
  const thread = await withIdentity(db, personal(g), (tx) => ensureGlobalThread(tx, g));
  const ids = Array.from({ length: 6 }, () => newId());
  await withIdentity(db, personal(g), async (tx) => {
    for (const id of ids) {
      await sink.write(tx, {
        graphId: g,
        threadId: thread,
        action: {
          id,
          type: 'entity_updated',
          entity_id: null,
          actor_user_id: accountOf(g),
          actor_kind: 'agent',
          source: 'mcp',
          mechanism: 'user',
          operations: [],
          inverse: [],
        },
        card: { tool: 'entity_update', entity_id: null, title: `правка ${id}` },
      });
    }
  });
  const all = await page(g, thread, { limit: 50 });
  expect(new Set(all.map(keyOf))).toEqual(new Set(ids));
  expect(new Set(all.map((m) => m.createdAt)).size).toBe(1);
  expect((await allPages(g, thread, 1)).map((m) => m.id)).toEqual(all.map((m) => m.id));
});
