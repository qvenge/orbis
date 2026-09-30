// apps/server/src/journal/thread-page.test.ts
// Тред — объединение НА ЧТЕНИИ (спека скорости §11.3): сообщения треда и карточки журнала этого треда одной
// процедурой с общим курсором `(время, id)`. Поведение для клиента прежнее (РП-10): карточки — прежней формы провода,
// но без тел действия (§9 приватность), system-действия и маркеры «думает» скрыты, записи отмены своей строки не
// имеют (К-45: «отменено» — признак строки отменённого, задача 6).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import { globalThreadId, newId, processingMessageId } from '@orbis/shared';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { journalOf } from '../../test/journal-helpers';
import { appendMessage, type WireChatMessage } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import type { ExecuteOk, ExecuteRequest, MutationSource, WireEntity } from '../executor/types';
import { undoAction } from '../executor/undo';
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

describe('threadPage: сообщения и карточки журнала одной выдачей (§11.3)', () => {
  test('два сообщения и три действия: порядок по (время, id), курсор без пропусков и повторов на стыке таблиц, без тел; system, маркер и запись отмены скрыты', async () => {
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
    const ui = await run(g, {
      tool: 'entity_update',
      input: { id: fastEntity, title: 'Правка в интерфейсе' },
    });
    await create(g, 'Системное', 'system', { mechanism: 'materialize' });
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
    // Отмена правки: запись отмены своей строки в треде не имеет (своей карточки у неё нет — К-45)
    const undone = await undoAction(db, { identity: personal(g), actionId: ui.actionId });
    expect(undone.ok).toBe(true);

    const all = await page(g, thread, { limit: 50 });
    expect(new Set(all.map((m) => m.id))).toEqual(
      new Set([first, twin, fast.actionId, ui.actionId, userMsg]),
    );
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

    const fastItem = all.find((m) => m.id === fast.actionId);
    const uiItem = all.find((m) => m.id === ui.actionId);
    if (fastItem === undefined || uiItem === undefined) throw new Error('карточек журнала нет');
    // Прежняя форма провода: system-строка с заголовком, сводка действия и карточка
    expect([fastItem.role, fastItem.content, fastItem.threadId]).toEqual([
      'system',
      'Быстрая',
      thread,
    ]);
    expect(fastItem.metadata).toEqual({
      actions: [
        {
          id: fast.actionId,
          type: 'entity_created',
          entity_id: fastEntity,
          actor_kind: 'owner',
          source: 'fast_path',
        },
      ],
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
    // ui — строка без клиентской карточки (прежняя ActionCard без kind), как сегодня
    expect(uiItem.metadata.cards).toEqual([
      { tool: 'entity_update', entity_id: fastEntity, title: 'Правка в интерфейсе' },
    ]);
    // Тел действия в проводе нет (§9): ни операций, ни inverse, ни результатов пачки
    for (const m of [fastItem, uiItem]) {
      const text = JSON.stringify(m.metadata);
      for (const k of ['operations', 'inverse', 'results', 'actor_user_id']) {
        expect([k, text.includes(`"${k}"`)]).toEqual([k, false]);
      }
    }
    // Маркера «думает», system-действия и записи отмены в выдаче нет
    expect(all.some((m) => m.metadata.type === 'processing')).toBe(false);
    expect(all.some((m) => m.content === 'Системное')).toBe(false);
    expect(all.some((m) => m.content.startsWith('Отменено'))).toBe(false);
  });

  test('карточки по источнику — прежние: routine — клиентская карточка, chat и пачка — ActionCard без kind', async () => {
    const g = await freshGraph();
    const thread = globalThreadId(g);
    const routine = await create(g, 'Создано рутиной', 'routine', {
      actorKind: 'ai',
      runId: newId(),
    });
    const chat = await create(g, 'Из чата', 'chat', { actorKind: 'ai' });
    const batchId = newId();
    const batch = await execute(
      db,
      {
        identity: personal(g),
        actorKind: 'owner',
        source: 'fast_path',
        batchId,
        operations: [
          { tool: 'entity_create', input: { title: 'п1', tags: [] } },
          { tool: 'entity_create', input: { title: 'п2', tags: [] } },
        ],
      },
      { sink },
    );
    expect(batch.ok).toBe(true);
    const items = await page(g, thread, { limit: 50 });
    const cardOf = (id: string) => items.find((m) => m.id === id)?.metadata.cards;
    const routineEntity = (routine.results[0] as WireEntity).id;
    expect(cardOf(routine.actionId)).toEqual([
      {
        kind: 'entity_card',
        entityId: routineEntity,
        title: 'Создано рутиной',
        aspects: [],
        keyFields: {},
        undoActionId: routine.actionId,
      },
    ]);
    // Сводка действия рутины несёт прогон — по нему лента подписывает «рутина»
    expect(
      (
        items.find((m) => m.id === routine.actionId)?.metadata.actions as Array<{ run_id?: string }>
      )[0]?.run_id,
    ).toBeDefined();
    // chat: карточку с «Отменить» несёт ответ ассистента — из журнала только прежняя ActionCard (без дубля)
    expect(cardOf(chat.actionId)).toEqual([
      { tool: 'entity_create', entity_id: (chat.results[0] as WireEntity).id, title: 'Из чата' },
    ]);
    // Пачка без записи-адреса — прежняя ActionCard (entityId клиентской карточки не может быть null)
    expect(cardOf(batchId)).toEqual([
      { tool: 'batch_execute', entity_id: null, title: 'batch: операций — 2' },
    ]);
  });

  test('легаси-курсор `<iso>` без id — строго раньше по времени в обеих таблицах', async () => {
    const g = await freshGraph();
    const thread = await withIdentity(db, personal(g), (tx) => ensureGlobalThread(tx, g));
    const old = await create(g, 'Раньше', 'ui');
    const oldAt = (await journalOf(g, old.actionId))?.createdAt;
    if (oldAt === undefined) throw new Error('записи нет');
    await new Promise((r) => setTimeout(r, 5));
    await create(g, 'Позже', 'ui');
    const p = await page(g, thread, {
      limit: 10,
      before: new Date(oldAt.getTime() + 1).toISOString(),
    });
    expect(p.map((m) => m.id)).toEqual([old.actionId]);
  });
});
