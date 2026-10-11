// apps/server/src/journal/transfer.test.ts
// Перенос прежнего журнала (системные сообщения чата) в таблицу (спека скорости §11.4, план А задача 5). Прежняя форма
// пишется копией удалённого синка (`test/legacy-journal.ts`) — ровно то, что лежит в проде до переноса. Перенос
// идемпотентен, сообщения не трогает (их снос — прод-операция задачи 21 после проверки).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import { newId } from '@orbis/shared';
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
import {
  journalEntitiesOf,
  journalOf,
  undoRecordOf,
  wholeJournalOf,
} from '../../test/journal-helpers';
import {
  legacyBatchMessageId,
  writeLegacyAction,
  writeLegacyAssistantReply,
  writeLegacyUndo,
} from '../../test/legacy-journal';
import { ensureEntityThread, ensureGlobalThread } from '../chat/threads';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { touchedEntityIds } from '../executor/journal-read';
import type { ActionRecord, MutationSource } from '../executor/types';
import { threadPage } from './thread-page';
import { legacyJournalReport, transferJournal, transferredLegacyMessageIds } from './transfer';

requireEnv();

const { db, client } = appDb();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

async function messagesOfGraph(g: GraphId): Promise<number> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(
      sql`SELECT count(*)::int AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
          WHERE t.graph_id = ${g}::uuid`,
    );
    return rows[0]?.n as number;
  } finally {
    await adminClient.end();
  }
}

function action(
  g: GraphId,
  over: Partial<ActionRecord> & Pick<ActionRecord, 'type' | 'source'>,
): ActionRecord {
  return {
    id: newId(),
    entity_id: null,
    actor_user_id: accountOf(g),
    actor_kind: 'owner',
    mechanism: 'user',
    operations: [],
    inverse: [],
    ...over,
  };
}

const createOf = (g: GraphId, entity: string, source: MutationSource, title: string) =>
  action(g, {
    type: 'entity_created',
    source,
    entity_id: entity,
    operations: [
      { op: 'entity_create', payload: { id: entity, title, tags: [], props: {}, aspects: [] } },
    ],
    inverse: [{ op: 'entity_update', payload: { id: entity, archived: true } }],
  });

describe('transferJournal: сообщения прежней формы → строки action_journal (§11.4)', () => {
  test('одиночное ui, пачка с uuidv5-PK, fast_path с карточкой, system, chat с карточкой в ответе, отмены — поля, треды, повтор', async () => {
    const g = await freshGraph();
    const base = Date.UTC(2026, 8, 1, 9, 0, 0);
    const at = (i: number) => new Date(base + i * 1000);
    const x = newId();
    const y = newId();
    const z = newId();
    const w = newId();
    // Носитель треда записи — настоящая запись (тред записи ссылается на неё); журнала у её создания нет (синка нет)
    const holder = await execute(db, {
      identity: personal(g),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_create', input: { id: x, title: 'Икс', tags: [] } }],
    });
    if (!holder.ok) throw new Error(holder.error.message);
    const { global, entityThread } = await withIdentity(db, personal(g), async (tx) => ({
      global: await ensureGlobalThread(tx, g),
      entityThread: await ensureEntityThread(tx, g, x),
    }));

    const ui = createOf(g, x, 'ui', 'Икс');
    const batch = action(g, {
      type: 'batch',
      source: 'mcp',
      actor_kind: 'agent',
      actor_grant_id: newId(),
      run_id: newId(),
      operations: [
        { op: 'entity_create', payload: { id: y, title: 'Игрек' } },
        { op: 'relation_create', payload: { source_id: x, target_id: y, role: 'mention' } },
      ],
      inverse: [
        { op: 'relation_delete', payload: { source_id: x, target_id: y, role: 'mention' } },
        { op: 'entity_update', payload: { id: y, archived: true } },
      ],
    });
    const fast = createOf(g, z, 'fast_path', 'Зет');
    const system = action(g, {
      type: 'batch',
      source: 'system',
      mechanism: 'materialize',
      operations: [{ op: 'entity_create', payload: { id: newId(), title: 'инстанс' } }],
      inverse: [],
    });
    // Запись до появления поля `mechanism` (§А4-4) — единственное умолчание переноса
    const { mechanism: _dropped, ...noMechanism } = createOf(g, w, 'chat', 'Дабл-ю');
    const chatReplied = noMechanism as ActionRecord;
    const chatBare = action(g, {
      type: 'entity_updated',
      source: 'chat',
      actor_kind: 'ai',
      entity_id: x,
      operations: [{ op: 'entity_update', payload: { id: x, title: 'Икс 2' } }],
      inverse: [{ op: 'entity_update', payload: { id: x, title: 'Икс' } }],
    });
    // Сломанный писатель: нет обязательного `actor_user_id` — не умолчание, а пропуск (счёт missingRequired у задачи 21)
    const { actor_user_id: _no, ...broken } = createOf(g, newId(), 'ui', 'Без актора');
    // Действие реестра (§Б6-4) с автором-приложением и правленым предложением — все поля атрибуции без потерь (Э-А-1)
    const registryAction = action(g, {
      type: 'action',
      source: 'chat',
      actor_kind: 'ai',
      action_id: 'planner/postpone_overdue',
      module: 'planner',
      edited_from: newId(),
      operations: [
        { op: 'entity_update', payload: { id: z, props: { 'orbis/due_date': '2026-09-01' } } },
      ],
      inverse: [
        { op: 'entity_update', payload: { id: z, props: { 'orbis/due_date': '2026-08-01' } } },
      ],
    });
    // «＋» владельца — тред при переносе не присваивается (§11.4), как у ui и system
    const quick = createOf(g, newId(), 'quick_capture', 'Быстрый ввод');

    const msg = await withIdentity(db, personal(g), async (tx) => {
      const out = {} as Record<
        | 'ui'
        | 'batch'
        | 'fast'
        | 'system'
        | 'chatReplied'
        | 'chatBare'
        | 'broken'
        | 'undoUi'
        | 'undoChat'
        | 'registryAction'
        | 'quick',
        string
      >;
      out.ui = await writeLegacyAction(tx, {
        graphId: g,
        threadId: global,
        action: ui,
        card: { tool: 'entity_create', entity_id: x, title: 'Икс' },
        createdAt: at(1),
      });
      out.batch = await writeLegacyAction(tx, {
        graphId: g,
        threadId: global,
        action: batch,
        card: { tool: 'batch_execute', entity_id: null, title: 'batch: операций — 2' },
        results: [{ id: y }, { ok: true }],
        createdAt: at(2),
      });
      out.fast = await writeLegacyAction(tx, {
        graphId: g,
        threadId: global,
        action: fast,
        card: { tool: 'entity_create', entity_id: z, title: 'Зет' },
        createdAt: at(3),
      });
      out.system = await writeLegacyAction(tx, {
        graphId: g,
        threadId: global,
        action: system,
        card: { tool: 'batch_execute', entity_id: null, title: 'batch: операций — 1' },
        createdAt: at(4),
      });
      out.chatReplied = await writeLegacyAction(tx, {
        graphId: g,
        threadId: entityThread,
        action: chatReplied,
        card: { tool: 'entity_create', entity_id: w, title: 'Дабл-ю' },
        createdAt: at(5),
      });
      await writeLegacyAssistantReply(tx, {
        threadId: entityThread,
        undoActionId: chatReplied.id,
        entityId: w,
        title: 'Дабл-ю',
        createdAt: at(6),
      });
      out.chatBare = await writeLegacyAction(tx, {
        graphId: g,
        threadId: entityThread,
        action: chatBare,
        card: { tool: 'entity_update', entity_id: x, title: 'Икс 2' },
        createdAt: at(7),
      });
      out.broken = await writeLegacyAction(tx, {
        graphId: g,
        threadId: global,
        action: broken as ActionRecord,
        card: { tool: 'entity_create', entity_id: null, title: 'Без актора' },
        createdAt: at(8),
      });
      out.undoUi = await writeLegacyUndo(tx, { threadId: global, undoes: ui.id, createdAt: at(9) });
      out.undoChat = await writeLegacyUndo(tx, {
        threadId: entityThread,
        undoes: chatBare.id,
        createdAt: at(10),
      });
      out.registryAction = await writeLegacyAction(tx, {
        graphId: g,
        threadId: global,
        action: registryAction,
        card: { tool: 'batch_execute', entity_id: null, title: 'Действие «Отложить просроченные»' },
        results: [{ ok: true }],
        createdAt: at(11),
      });
      out.quick = await writeLegacyAction(tx, {
        graphId: g,
        threadId: global,
        action: quick,
        card: { tool: 'entity_create', entity_id: quick.entity_id, title: 'Быстрый ввод' },
        createdAt: at(12),
      });
      return out;
    });
    expect(msg.batch).toBe(legacyBatchMessageId(g, batch.id));
    const messagesBefore = await messagesOfGraph(g);

    // Отчёт до переноса (задача 21, `missingRequired`) — тем же предикатом, что перенос: оставит ровно сломанную запись
    const reportOf = () => withIdentity(db, personal(g), (tx) => legacyJournalReport(tx, g));
    expect(await reportOf()).toEqual({ legacyActions: 9, legacyUndo: 2, untransferable: 1 });
    const first = await withIdentity(db, personal(g), (tx) => transferJournal(tx, g));
    expect(first).toEqual({ moved: 8, undo: 2, skipped: 1 });
    expect(await reportOf()).toEqual({ legacyActions: 9, legacyUndo: 2, untransferable: 1 });

    // id строки — id ДЕЙСТВИЯ, а не сообщения (Д-4); у пачки — batch_id, а не uuidv5-PK сообщения
    const row = async (id: string) => {
      const e = await journalOf(g, id);
      if (e === undefined) throw new Error(`действия ${id} нет в таблице`);
      return e;
    };
    const uiRow = await row(ui.id);
    expect(uiRow.id).not.toBe(msg.ui);
    expect([uiRow.type, uiRow.source, uiRow.actorUserId, uiRow.title, uiRow.cardTool]).toEqual([
      'entity_created',
      'ui',
      accountOf(g),
      'Икс',
      'entity_create',
    ]);
    expect(uiRow.createdAt.toISOString()).toBe(at(1).toISOString());
    expect(uiRow.operations).toEqual(ui.operations);
    expect(uiRow.inverse).toEqual(ui.inverse);
    // Тред не присваивается ui, quick_capture и system (§11.4); прочим — тред сообщения
    expect(uiRow.threadId).toBeNull();
    expect((await row(system.id)).threadId).toBeNull();
    const batchRow = await row(batch.id);
    expect(batchRow.threadId).toBe(global);
    expect([batchRow.type, batchRow.cardTool, batchRow.actorGrantId, batchRow.runId]).toEqual([
      'batch',
      'batch_execute',
      batch.actor_grant_id,
      batch.run_id,
    ]);
    expect(batchRow.results).toEqual([{ id: y }, { ok: true }]);
    // У fast_path карточка клиентской формы — без поля tool: тул восстанавливается по типу действия
    const fastRow = await row(fast.id);
    expect([fastRow.threadId, fastRow.cardTool, fastRow.title]).toEqual([
      global,
      'entity_create',
      'Зет',
    ]);
    // Поля среза, которых у прежних записей не было, — пусты: «действия тела до» перенос не выдумывает (§11.4)
    expect([uiRow.bodyBefore, uiRow.textSession, uiRow.pinnedVersionIds]).toEqual([
      null,
      false,
      [],
    ]);
    // Затронутые записи — те же, что посчитал бы синк, и в боковой таблице по строке на каждую
    for (const a of [ui, batch, fast, chatBare]) {
      expect((await row(a.id)).entityIds.sort()).toEqual(touchedEntityIds(a).sort());
      expect(await journalEntitiesOf(g, a.id)).toEqual(touchedEntityIds(a).sort());
    }
    // Умолчание одно — механизм у записей до появления поля
    const replied = await row(chatReplied.id);
    expect(replied.mechanism).toBe('user');
    expect(replied.threadId).toBe(entityThread);
    // Карточка действия chat уже есть в ответе ассистента того же треда — признак «карточка в ответе» (§11.3)
    expect(replied.cardInReply).toBe(true);
    expect((await row(chatBare.id)).cardInReply).toBe(false);
    // Запись без обязательного поля не перенесена
    expect(await journalOf(g, broken.id as string)).toBeUndefined();

    // Отмена → строка type undo: id — id сообщения отмены, источник ui (В-3), актор — владелец графа, тред — тред
    // ПЕРЕНЕСЁННОЙ строки отменённого (у ui — нет), операции — копия inverse отменённого, свой inverse пуст
    const undoUi = await undoRecordOf(g, ui.id);
    expect(undoUi?.id).toBe(msg.undoUi);
    expect([undoUi?.type, undoUi?.source, undoUi?.actorKind, undoUi?.actorUserId]).toEqual([
      'undo',
      'ui',
      'owner',
      accountOf(g),
    ]);
    expect([undoUi?.title, undoUi?.cardTool, undoUi?.threadId]).toEqual([
      'Отменено: Икс',
      'undo',
      null,
    ]);
    expect(undoUi?.operations).toEqual(ui.inverse);
    expect(undoUi?.inverse).toEqual([]);
    expect(undoUi?.createdAt.toISOString()).toBe(at(9).toISOString());
    const undoChat = await undoRecordOf(g, chatBare.id);
    expect(undoChat?.threadId).toBe(entityThread);
    expect(undoChat?.entityIds).toEqual(touchedEntityIds(chatBare));

    // Действие реестра — автор-приложение и правленое предложение перенесены без потерь, тред сохранён (chat)
    const registryRow = await row(registryAction.id);
    expect([
      registryRow.type,
      registryRow.actionId,
      registryRow.module,
      registryRow.editedFrom,
      registryRow.threadId,
      registryRow.cardTool,
    ]).toEqual([
      'action',
      'planner/postpone_overdue',
      'planner',
      registryAction.edited_from,
      global,
      'batch_execute',
    ]);
    expect(registryRow.results).toEqual([{ ok: true }]);
    // «＋» (quick_capture) — без треда (§11.4)
    const quickRow = await row(quick.id);
    expect([quickRow.source, quickRow.threadId]).toEqual(['quick_capture', null]);

    // Порядок журнала — прежнее время сообщений
    const all = await wholeJournalOf(g);
    expect(all.map((e) => (e.type === 'undo' ? `undo:${e.undoes}` : e.id))).toEqual([
      ui.id,
      batch.id,
      fast.id,
      system.id,
      chatReplied.id,
      chatBare.id,
      `undo:${ui.id}`,
      `undo:${chatBare.id}`,
      registryAction.id,
      quick.id,
    ]);

    // Снос второго прохода (задача 21) — ровно перенесённые сообщения: всё, кроме сломанной записи
    expect(await withIdentity(db, personal(g), (tx) => transferredLegacyMessageIds(tx, g))).toEqual(
      [
        msg.ui,
        msg.batch,
        msg.fast,
        msg.system,
        msg.chatReplied,
        msg.chatBare,
        msg.undoUi,
        msg.undoChat,
        msg.registryAction,
        msg.quick,
      ],
    );

    // Идемпотентно: второй вызов ничего не переносит; сообщения на месте (их снос — задача 21)
    const again = await withIdentity(db, personal(g), (tx) => transferJournal(tx, g));
    expect(again).toEqual({ moved: 0, undo: 0, skipped: 1 });
    expect(await messagesOfGraph(g)).toBe(messagesBefore);
    expect((await wholeJournalOf(g)).length).toBe(10);
  });

  test('чужой граф переносом не задет', async () => {
    const g = await freshGraph();
    const other = await freshGraph();
    const a = createOf(other, newId(), 'ui', 'Чужое');
    await withIdentity(db, personal(other), (tx) =>
      writeLegacyAction(tx, {
        graphId: other,
        action: a,
        card: { tool: 'entity_create', entity_id: a.entity_id, title: 'Чужое' },
      }),
    );
    expect(await withIdentity(db, personal(g), (tx) => transferJournal(tx, g))).toEqual({
      moved: 0,
      undo: 0,
      skipped: 0,
    });
    expect(await journalOf(other, a.id)).toBeUndefined();
  });

  // Fable I-1: прежняя запись с не-uuid id (или отмена с мусором в `undoes`) — не 22P02 ни в переносе, ни в отчёте, ни
  // в выборке сноса: отчёт называет её, перенос пропускает, снос оставляет в сообщениях.
  test('не-uuid id прежней записи: перенос, отчёт и выборка сноса не падают; запись названа и оставлена', async () => {
    const g = await freshGraph();
    const good = createOf(g, newId(), 'mcp', 'Годная');
    const badId = { ...createOf(g, newId(), 'mcp', 'Кривой id'), id: 'не-uuid-id' } as ActionRecord;
    const messages = await withIdentity(db, personal(g), async (tx) => {
      const thread = await ensureGlobalThread(tx, g);
      return {
        good: await writeLegacyAction(tx, {
          graphId: g,
          action: good,
          card: { tool: 'entity_create', entity_id: good.entity_id, title: 'Годная' },
        }),
        bad: await writeLegacyAction(tx, {
          graphId: g,
          action: badId,
          card: { tool: 'entity_create', entity_id: badId.entity_id, title: 'Кривой id' },
        }),
        undoBad: await writeLegacyUndo(tx, { threadId: thread, undoes: 'мусор' }),
        undoOfBad: await writeLegacyUndo(tx, { threadId: thread, undoes: 'не-uuid-id' }),
      };
    });
    const report = await withIdentity(db, personal(g), (tx) => legacyJournalReport(tx, g));
    expect(report).toEqual({ legacyActions: 2, legacyUndo: 2, untransferable: 3 });
    expect(await withIdentity(db, personal(g), (tx) => transferJournal(tx, g))).toEqual({
      moved: 1,
      undo: 0,
      skipped: 3,
    });
    expect(await withIdentity(db, personal(g), (tx) => transferredLegacyMessageIds(tx, g))).toEqual(
      [messages.good],
    );
    expect(messages.bad).not.toBe(messages.good);
  });

  // Рулинг R-12 на перенесённых записях: у прежней записи одобрения id действия = batch_id = pendingId — тот же, что PK
  // карточки-запроса в треде. После переноса и сноса перенесённого выдача треда обязана давать разные id и однозначный
  // курсор на стыке с равным временем.
  test('перенесённое одобрение и его карточка-запрос: разные id в выдаче треда, курсор однозначен при равном времени', async () => {
    const g = await freshGraph();
    const pendingId = newId();
    const at = new Date(Date.UTC(2026, 8, 2, 10, 0, 0));
    const approval = action(g, {
      id: pendingId,
      type: 'batch',
      source: 'chat',
      actor_kind: 'ai',
      operations: [{ op: 'entity_create', payload: { id: newId(), title: 'Одобрено' } }],
      inverse: [],
    });
    const thread = await withIdentity(db, personal(g), async (tx) => {
      const t = await ensureGlobalThread(tx, g);
      // Карточка-запрос прежней формы: сообщение с PK = pendingId (`createPending`)
      await tx.insert(chatMessages).values({
        id: pendingId,
        threadId: t,
        role: 'system',
        content: 'Требуется подтверждение: проба',
        metadata: { pending: { id: pendingId, tool: 'batch_execute' }, cards: [] },
        createdAt: at,
      });
      await writeLegacyAction(tx, {
        graphId: g,
        threadId: t,
        action: approval,
        card: { tool: 'batch_execute', entity_id: null, title: 'batch: операций — 1' },
        createdAt: at,
      });
      return t;
    });
    await withIdentity(db, personal(g), (tx) => transferJournal(tx, g));
    // Снос перенесённого (второй проход задачи 21) — как он будет: ровно выборка сноса
    const swept = await withIdentity(db, personal(g), (tx) => transferredLegacyMessageIds(tx, g));
    expect(swept).toEqual([legacyBatchMessageId(g, pendingId)]);
    const { db: admin, client: adminClient } = adminDb();
    try {
      for (const id of swept)
        await admin.execute(sql`DELETE FROM chat_messages WHERE id = ${id}::uuid`);
    } finally {
      await adminClient.end();
    }
    const page = (before?: string) =>
      withIdentity(db, personal(g), (tx) =>
        threadPage(tx, g, thread, { limit: 1, ...(before !== undefined && { before }) }),
      );
    const all = await withIdentity(db, personal(g), (tx) =>
      threadPage(tx, g, thread, { limit: 50 }),
    );
    const ids = all.map((m) => m.id);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(pendingId);
    const p1 = await page();
    const p2 = await page(`${p1[0]?.createdAt}|${p1[0]?.id}`);
    const p3 = await page(`${p2[0]?.createdAt}|${p2[0]?.id}`);
    expect([...p1, ...p2, ...p3].map((m) => m.id)).toEqual(ids);
  });
});
