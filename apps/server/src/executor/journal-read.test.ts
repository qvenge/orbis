// apps/server/src/executor/journal-read.test.ts
// API чтения журнала (задача 4 плана А, РП-9; с задачи 5 — таблица `action_journal`): один модуль читает журнал за
// всех читателей. Записи — настоящим `execute` с боевым синком, как пишут боевые пути; отмены — настоящим `undoAction`
// (запись отмены — строка того же вида, что действие, с операциями — применённым inverse, К-22).
import { afterAll, describe, expect, test } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import { globalThreadId, newId } from '@orbis/shared';
import {
  accountOf,
  appDb,
  executeWithFixtureCategories,
  freshGraph,
  personal,
  requireEnv,
} from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { execute } from './executor';
import { makeJournalSink } from './journal';
import * as J from './journal-read';
import type { ActionRecord, MutationSource, WireEntity } from './types';
import { undoAction } from './undo';

requireEnv();
const { db, client } = appDb();
const sink = makeJournalSink();

afterAll(async () => {
  await client.end();
});

async function create(g: GraphId, title: string, source: MutationSource = 'ui') {
  const r = await execute(
    db,
    {
      identity: personal(g),
      actorKind: 'owner',
      source,
      operations: [{ tool: 'entity_create', input: { title, tags: [] } }],
    },
    { sink },
  );
  if (!r.ok) throw new Error(r.error.message);
  return r;
}

async function update(
  g: GraphId,
  input: Record<string, unknown>,
  over: { source?: MutationSource; runId?: string } = {},
) {
  const r = await executeWithFixtureCategories(
    db,
    {
      identity: personal(g),
      actorKind: over.source === 'routine' ? 'ai' : 'owner',
      source: over.source ?? 'ui',
      ...(over.runId !== undefined && { runId: over.runId }),
      operations: [{ tool: 'entity_update', input }],
    },
    { sink },
  );
  if (!r.ok) throw new Error(r.error.message);
  return r;
}

/** Значение, которое тест обязан найти: отсутствие — провал с именем, а не `undefined` дальше. */
function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`не найдено: ${what}`);
  return v;
}

function entityOf(r: { results: unknown[] }): string {
  return (r.results[0] as WireEntity).id;
}

describe('API чтения журнала (задача 4, РП-9)', () => {
  test('findAction находит действие по id, отмена — отдельной записью', async () => {
    const g = await freshGraph();
    const a = await create(g, 'альфа');
    await withIdentity(db, personal(g), async (tx) => {
      const e = await J.findAction(tx, g, a.actionId);
      expect(e?.id).toBe(a.actionId);
      expect(e?.type).toBe('entity_created');
      expect(e?.entityIds.length).toBe(1);
      expect(await J.isUndone(tx, g, a.actionId)).toBe(false);
    });
    await undoAction(db, { identity: personal(g), actionId: a.actionId });
    await withIdentity(db, personal(g), async (tx) => {
      expect(await J.isUndone(tx, g, a.actionId)).toBe(true);
      expect((await J.undoRecordOf(tx, g, a.actionId))?.undoes).toBe(a.actionId);
      // запись отмены не находится как «действие» (К-22)
      expect(await J.findLastUndoable(tx, g)).toBeUndefined();
    });
  });

  test('findLastUndoable пропускает system и отменённое; lastActionTouching — без записей отмены', async () => {
    const g = await freshGraph();
    const a = await create(g, 'один');
    const b = await create(g, 'два');
    await execute(
      db,
      {
        identity: personal(g),
        actorKind: 'owner',
        source: 'system',
        mechanism: 'materialize',
        operations: [{ tool: 'entity_create', input: { title: 'системное', tags: [] } }],
      },
      { sink },
    );
    await undoAction(db, { identity: personal(g), actionId: b.actionId });
    await withIdentity(db, personal(g), async (tx) => {
      expect((await J.findLastUndoable(tx, g))?.id).toBe(a.actionId);
      const entityB = (await J.findAction(tx, g, b.actionId))?.entityIds[0] as string;
      expect((await J.lastActionTouching(tx, g, entityB))?.id).toBe(b.actionId);
    });
  });

  test('findBatch отдаёт пачку по batch_id и не отдаёт одиночное действие', async () => {
    const g = await freshGraph();
    const batchId = crypto.randomUUID();
    const r = await execute(
      db,
      {
        identity: personal(g),
        actorKind: 'owner',
        source: 'ui',
        batchId,
        operations: [
          { tool: 'entity_create', input: { title: 'п1', tags: [] } },
          { tool: 'entity_create', input: { title: 'п2', tags: [] } },
        ],
      },
      { sink },
    );
    const single = await create(g, 'одиночное');
    await withIdentity(db, personal(g), async (tx) => {
      expect((await J.findBatch(tx, g, batchId))?.results?.length).toBe(2);
      expect(await J.findBatch(tx, g, single.actionId)).toBeUndefined();
      expect([...(await J.executedIds(tx, g, [batchId, crypto.randomUUID()]))]).toEqual([batchId]);
    });
    expect(r.ok).toBe(true);
    // РП-12: в таблице id одиночного действия и batch_id пачки — одно пространство ключей `(graph_id, id)`: запись
    // под ключом, которая пачкой НЕ является (одиночное действие), — не «повтор» и не «исполненная пачка».
    await withIdentity(db, personal(g), async (tx) => {
      expect([...(await J.executedIds(tx, g, [single.actionId]))]).toEqual([]);
    });
  });

  test('чужой граф не видит журнал (RLS держит и API)', async () => {
    const g = await freshGraph();
    const other = await freshGraph();
    const a = await create(g, 'моё');
    await withIdentity(db, personal(other), async (tx) => {
      expect(await J.findAction(tx, g, a.actionId)).toBeUndefined();
    });
  });

  test('runActions — действия прогона по порядку; actionsTouchingAfter — чужая правка той же записи после первого', async () => {
    const g = await freshGraph();
    const runId = newId();
    const target = entityOf(await create(g, 'цель прогона'));
    const bystander = entityOf(await create(g, 'посторонняя'));
    const first = await update(g, { id: target, title: 'шаг 1' }, { source: 'routine', runId });
    const foreign = await update(g, { id: target, title: 'правка владельца' });
    await update(g, { id: bystander, title: 'мимо' });
    const second = await update(g, { id: target, title: 'шаг 2' }, { source: 'routine', runId });
    await withIdentity(db, personal(g), async (tx) => {
      const run = await J.runActions(tx, g, runId);
      expect(run.map((e) => e.id)).toEqual([first.actionId, second.actionId]);
      expect(run.every((e) => e.runId === runId && e.source === 'routine')).toBe(true);
      const after = await J.actionsTouchingAfter(
        tx,
        g,
        must(run[0], 'первое действие прогона').cursor,
        [target],
      );
      // Своё второе действие прогона тоже «после первого» — отсеивает его вызывающий (политика отката),
      // API отдаёт всё, что тронуло запись; посторонняя правка другой записи не попадает.
      expect(after.map((e) => e.id)).toEqual([foreign.actionId, second.actionId]);
      expect(after.every((e) => e.entityIds.includes(target))).toBe(true);
    });
  });

  test('financialUpdatesSince — правка категории за окно; отменённая не попадает', async () => {
    const g = await freshGraph();
    const from = newId();
    const to = newId();
    const txn = await executeWithFixtureCategories(
      db,
      {
        identity: personal(g),
        actorKind: 'owner',
        source: 'ui',
        operations: [
          {
            tool: 'entity_create',
            input: {
              title: 'обед',
              tags: [],
              aspects: ['orbis/financial'],
              props: {
                'orbis/amount': '340.00',
                'orbis/direction': 'expense',
                'orbis/finance_category': from,
                'orbis/occurred_on': '2026-07-20',
              },
            },
          },
        ],
      },
      { sink },
    );
    if (!txn.ok) throw new Error(txn.error.message);
    const id = entityOf(txn);
    const kept = await update(g, { id, props: { 'orbis/finance_category': to } });
    await update(g, { id, props: { 'orbis/finance_category': from } });
    const undone = await update(g, { id, props: { 'orbis/finance_category': to } });
    await undoAction(db, { identity: personal(g), actionId: undone.actionId });
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await withIdentity(db, personal(g), async (tx) => {
      expect((await J.financialUpdatesSince(tx, g, since, [to])).map((e) => e.id)).toEqual([
        kept.actionId,
      ]);
      // Окно — строгая граница: «с этого момента» после всех правок пусто
      expect(await J.financialUpdatesSince(tx, g, new Date(Date.now() + 60_000), [to])).toEqual([]);
    });
  });

  test('ownerExtensionWord — слово владельца о расширении и его отмена', async () => {
    const g = await freshGraph();
    await withIdentity(db, personal(g), async (tx) => {
      expect(await J.ownerExtensionWord(tx, g, 'finance')).toBeUndefined();
    });
    const r = await execute(
      db,
      {
        identity: personal(g),
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'module_set', input: { module: 'finance', enabled: false } }],
      },
      { sink },
    );
    if (!r.ok) throw new Error(r.error.message);
    const said = await withIdentity(db, personal(g), (tx) =>
      J.ownerExtensionWord(tx, g, 'finance'),
    );
    expect(said?.enabled).toBe(false);
    await undoAction(db, { identity: personal(g), actionId: r.actionId });
    await withIdentity(db, personal(g), async (tx) => {
      // Отмена — тоже слово (финал 1б, М-9): расширение вернулось в прежнее состояние, и позже
      const word = await J.ownerExtensionWord(tx, g, 'finance');
      expect(word?.enabled).toBe(true);
      expect((word?.at.getTime() ?? 0) >= (said?.at.getTime() ?? Infinity)).toBe(true);
      // Слово о другом расширении Финансы не касается
      expect(await J.ownerExtensionWord(tx, g, 'fitness')).toBeUndefined();
    });
  });

  test('threadActions и recentOwnerEdits — по времени, новые первыми; курсор листает без пропусков', async () => {
    const g = await freshGraph();
    // В треде — быстрый ввод и агент; правки владельца в интерфейсе треда не получают (Р-12)
    const a = await create(g, 'первое', 'fast_path');
    const b = await create(g, 'второе', 'fast_path');
    const c = await create(g, 'третье', 'mcp');
    const ownA = await create(g, 'правка раз');
    const ownB = await create(g, 'правка два', 'quick_capture');
    await undoAction(db, { identity: personal(g), actionId: a.actionId });
    await undoAction(db, { identity: personal(g), actionId: ownA.actionId });
    const thread = globalThreadId(g);
    await withIdentity(db, personal(g), async (tx) => {
      const all = await J.threadActions(tx, g, thread, { limit: 10 });
      // Запись отмены — элемент журнала треда (тот же тред, что у отменённого действия); отмена правки владельца —
      // без треда, как сама правка
      expect(all.map((e) => (e.type === 'undo' ? `undo:${e.undoes}` : e.id))).toEqual([
        `undo:${a.actionId}`,
        c.actionId,
        b.actionId,
        a.actionId,
      ]);
      const page1 = await J.threadActions(tx, g, thread, { limit: 2 });
      const page2 = await J.threadActions(tx, g, thread, {
        limit: 2,
        before: must(page1[1], 'конец первой страницы').cursor,
      });
      expect([...page1, ...page2].map((e) => e.cursor.key)).toEqual(all.map((e) => e.cursor.key));
      const recent = await J.recentOwnerEdits(tx, g, new Date(Date.now() - 3600_000), 10);
      // Правки владельца в интерфейсе и быстрые записи: `mcp` и быстрый ввод — не они, запись отмены — не правка
      expect(recent.map((e) => e.id)).toEqual([ownB.actionId, ownA.actionId]);
      expect((await J.recentOwnerEdits(tx, g, new Date(Date.now() - 3600_000), 1)).length).toBe(1);
    });
  });

  test('exportJournal — все записи графа по времени, включая отмены', async () => {
    const g = await freshGraph();
    const a = await create(g, 'раз');
    const b = await create(g, 'два');
    await undoAction(db, { identity: personal(g), actionId: a.actionId });
    const all = await withIdentity(db, personal(g), (tx) => J.exportJournal(tx, g));
    expect(all.map((e) => (e.type === 'undo' ? `undo:${e.undoes}` : e.id))).toEqual([
      a.actionId,
      b.actionId,
      `undo:${a.actionId}`,
    ]);
    const undo = must(all[2], 'запись отмены');
    expect(undo.threadId).toBe(must(all[0], 'первое действие').threadId);
    expect(undo.actorKind).toBe('owner');
    expect(undo.actorUserId).toBe(accountOf(g));
    expect(undo.cardTool).toBe('undo');
    expect(undo.inverse).toEqual([]);
    const created = must(all[0], 'первое действие');
    // Поля среза, которые заполнят задачи 7 и 9, — умолчания колонок; «действие тела до» у новой записи — пустой
    // объект (NULL — только у перенесённых до плана А, рулинг R-21)
    expect(created.textSession).toBe(false);
    expect(created.bodyBefore).toEqual({});
    expect(created.pinnedVersionIds).toEqual([]);
    expect(created.cardInReply).toBe(false);
    expect(created.undoes).toBeNull();
    expect(created.cardTool).toBe('entity_create');
    expect(created.actorUserId).toBe(accountOf(g));
  });

  // К-22 на таблице: запись отмены — строка того же вида, что действие, и несёт операции (применённый inverse). Без
  // явного исключения она всплыла бы «последним действием по записи» (R-18), чужой правкой окна отката прогона и
  // исправлением категории у эскалации.
  test('запись отмены правки категории X→Y (её операции — Y→X) — не последнее по записи, не чужая правка окна отката, не исправление в X (К-22)', async () => {
    const g = await freshGraph();
    const runId = newId();
    const x = newId();
    const y = newId();
    const txn = await executeWithFixtureCategories(
      db,
      {
        identity: personal(g),
        actorKind: 'owner',
        source: 'ui',
        operations: [
          {
            tool: 'entity_create',
            input: {
              title: 'кофе',
              tags: [],
              aspects: ['orbis/financial'],
              props: {
                'orbis/amount': '250.00',
                'orbis/direction': 'expense',
                'orbis/finance_category': x,
                'orbis/occurred_on': '2026-07-20',
              },
            },
          },
        ],
      },
      { sink },
    );
    if (!txn.ok) throw new Error(txn.error.message);
    const id = entityOf(txn);
    // Шаг прогона рутины переносит X→Y; владелец его отменяет — запись отмены несёт Y→X
    const step = await update(
      g,
      { id, props: { 'orbis/finance_category': y } },
      { source: 'routine', runId },
    );
    const undone = await undoAction(db, { identity: personal(g), actionId: step.actionId });
    expect(undone.ok).toBe(true);
    const since = new Date(Date.now() - 3600_000);
    await withIdentity(db, personal(g), async (tx) => {
      const undo = must(await J.undoRecordOf(tx, g, step.actionId), 'запись отмены');
      expect(undo.operations.map((op) => op.payload.props)).toEqual([
        { 'orbis/finance_category': x },
      ]);
      // Последнее ДЕЙСТВИЕ по записи — шаг прогона (запись отмены действием не является)
      expect((await J.lastActionTouching(tx, g, id))?.id).toBe(step.actionId);
      expect((await J.actionsOnEntity(tx, g, id, 10)).map((e) => e.id)).toEqual([
        step.actionId,
        txn.actionId,
      ]);
      // Окно конфликтов отката: после шага прогона запись тронула только отмена владельца — это не чужая правка
      const run = await J.runActions(tx, g, runId);
      expect(run.map((e) => e.id)).toEqual([step.actionId]);
      expect(await J.actionsTouchingAfter(tx, g, must(run[0], 'шаг прогона').cursor, [id])).toEqual(
        [],
      );
      // Эскалация: отмена вернула запись в X, но исправлением «в X» она не является
      expect(await J.financialUpdatesSince(tx, g, since, [x])).toEqual([]);
      // И не «последнее отменяемое», не «действие» по id, не правка владельца в интерфейсе
      expect((await J.findLastUndoable(tx, g))?.id).toBe(txn.actionId);
      expect(await J.findAction(tx, g, undo.id)).toBeUndefined();
      expect((await J.recentOwnerEdits(tx, g, since, 10)).map((e) => e.id)).toEqual([txn.actionId]);
      // А как запись отмены она видна: отменённое — отменено, в экспорте — отменой с её записями
      expect(await J.isUndone(tx, g, step.actionId)).toBe(true);
      const undos = (await J.exportJournal(tx, g)).filter((e) => e.type === 'undo');
      expect(undos.map((e) => [e.undoes, e.entityIds])).toEqual([[step.actionId, [id]]]);
    });
  });

  // R-18 поставки (`supply/mechanism.ts`): «последнее по записи» — последнее действие, чьи ОПЕРАЦИИ правили саму запись
  // (`payload.id`), а не любая связь с ней. Связь, легшая после «добавить», ответа R-18 не меняет.
  test('lastActionTouching — по операциям над самой записью: связь после «добавить» ответа не меняет', async () => {
    const g = await freshGraph();
    const added = await create(g, 'добавлено');
    const a = entityOf(added);
    const b = entityOf(await create(g, 'сосед'));
    const rel = await execute(
      db,
      {
        identity: personal(g),
        actorKind: 'owner',
        source: 'ui',
        operations: [
          { tool: 'relation_create', input: { source_id: a, target_id: b, role: 'mention' } },
        ],
      },
      { sink },
    );
    if (!rel.ok) throw new Error(rel.error.message);
    await withIdentity(db, personal(g), async (tx) => {
      // Связь тронула запись (она в её записях журнала), но саму запись не правила
      expect((await J.findAction(tx, g, rel.actionId))?.entityIds).toContain(a);
      expect((await J.lastActionTouching(tx, g, a))?.id).toBe(added.actionId);
    });
  });

  test('поля записи — как лежат: необязательных ключей без значения нет', async () => {
    const g = await freshGraph();
    const bare = crypto.randomUUID();
    const partial: ActionRecord = {
      id: bare,
      type: 'batch',
      entity_id: null,
      actor_user_id: accountOf(g),
      actor_kind: 'owner',
      source: 'ui',
      mechanism: 'user',
      action_id: 'orbis/probe',
      operations: [],
      inverse: [],
    };
    await withIdentity(db, personal(g), (tx) =>
      sink.write(tx, {
        graphId: g,
        action: partial,
        card: { tool: 'batch_execute', entity_id: null, title: 'без модуля' },
      }),
    );
    const e = must(
      await withIdentity(db, personal(g), (tx) => J.findAction(tx, g, bare)),
      'запись без модуля',
    );
    expect(e.actionId).toBe('orbis/probe');
    for (const k of ['module', 'runId', 'actorGrantId', 'editedFrom', 'results']) {
      expect([k, Object.hasOwn(e, k)]).toEqual([k, false]);
    }
    // Правка владельца в интерфейсе — без треда (Р-12): NULL колонки читается как null, а не как отсутствие ключа
    expect(e.threadId).toBeNull();
  });
});
