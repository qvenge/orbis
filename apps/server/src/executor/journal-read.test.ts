// apps/server/src/executor/journal-read.test.ts
// API чтения журнала (задача 4 плана А, РП-9): один модуль читает журнал за всех читателей, и смена
// хранилища (задача 5) проходит одним местом. Записи — настоящим `execute` с боевым синком, как пишут
// боевые пути; отмены — настоящим `undoAction`. Этот тест — единственный, кроме тестов синка, кто знает,
// где лежит журнал: синтетические записи ниже держат правила API НЕЗАВИСИМО от формы хранилища.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphId } from '@orbis/shared';
import { batchAuditMessageId, globalThreadId, newId } from '@orbis/shared';
import {
  accountOf,
  appDb,
  executeWithFixtureCategories,
  freshGraph,
  personal,
  requireEnv,
} from '../../test/helpers';
import { appendMessage } from '../chat/messages';
import { withIdentity } from '../db/with-identity';
import { execute } from './executor';
import { makeChatJournalSink } from './journal';
import * as J from './journal-read';
import type { ActionRecord, MutationSource, WireEntity } from './types';
import { undoAction } from './undo';

requireEnv();
const { db, client } = appDb();
const sink = makeChatJournalSink();

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
    // РП-12: запись под ключом пачки, которая пачкой НЕ является (одиночное действие), — не «повтор».
    // Прежнее хранилище держит это разными пространствами PK (одиночное пишется под случайным id),
    // поэтому случай собран синком руками: проверка «пачка ли это» обязана жить в API, а не в форме —
    // в таблице (задача 5) ключ пачки и id одиночного действия — одно пространство.
    const lookalike = crypto.randomUUID();
    const forged: ActionRecord = {
      id: lookalike,
      type: 'entity_created',
      entity_id: null,
      actor_user_id: accountOf(g),
      actor_kind: 'owner',
      source: 'ui',
      mechanism: 'user',
      operations: [],
      inverse: [],
    };
    await withIdentity(db, personal(g), (tx) =>
      sink.write(tx, {
        id: batchAuditMessageId(g, lookalike),
        graphId: g,
        action: forged,
        card: { tool: 'entity_create', entity_id: null, title: 'одиночное под ключом пачки' },
      }),
    );
    await withIdentity(db, personal(g), async (tx) => {
      expect(await J.findBatch(tx, g, lookalike)).toBeUndefined();
      expect([...(await J.executedIds(tx, g, [lookalike]))]).toEqual([]);
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
    const a = await create(g, 'первое');
    const b = await create(g, 'второе');
    const c = await create(g, 'третье', 'mcp');
    await undoAction(db, { identity: personal(g), actionId: a.actionId });
    const thread = globalThreadId(g);
    await withIdentity(db, personal(g), async (tx) => {
      const all = await J.threadActions(tx, g, thread, { limit: 10 });
      // Запись отмены — элемент журнала треда (тот же тред, что у отменённого действия)
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
      // Правки владельца в интерфейсе: `mcp` — не его правка, запись отмены — не правка
      expect(recent.map((e) => e.id)).toEqual([b.actionId, a.actionId]);
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
    // Поля, которых в сообщении прежнего хранилища нет, — значения по умолчанию (бриф задачи 4)
    expect(created.textSession).toBe(false);
    expect(created.bodyBefore).toBeNull();
    expect(created.pinnedVersionIds).toEqual([]);
    expect(created.cardInReply).toBe(false);
    expect(created.undoes).toBeNull();
    expect(created.cardTool).toBe('entity_create');
    expect(created.actorUserId).toBe(accountOf(g));
  });

  // К-22: записи отмены исключаются из проб «действия» ЯВНО, а не формой хранилища. Сегодняшняя запись
  // отмены `actions` не несёт, и форма это держит сама, — но в таблице (задача 5) строка отмены несёт
  // операции (применённый inverse), и без явного исключения она всплыла бы «последним действием»,
  // чужой правкой отката прогона и исправлением категории. Здесь запись отмены собрана с `actions`
  // руками — она и держит явное правило на прежнем хранилище.
  test('запись отмены, несущая операции, — не «действие» ни для одной пробы (К-22)', async () => {
    const g = await freshGraph();
    const runId = newId();
    const created = await create(g, 'цель');
    const target = entityOf(created);
    const first = await update(
      g,
      { id: target, title: 'шаг прогона' },
      { source: 'routine', runId },
    );
    const category = newId();
    const forged: ActionRecord = {
      id: newId(),
      type: 'entity_updated',
      entity_id: target,
      actor_user_id: accountOf(g),
      actor_kind: 'owner',
      source: 'ui',
      mechanism: 'user',
      run_id: runId,
      operations: [
        {
          op: 'entity_update',
          payload: { id: target, props: { 'orbis/finance_category': category } },
        },
      ],
      inverse: [{ op: 'entity_update', payload: { id: target, title: 'шаг прогона' } }],
    };
    await withIdentity(db, personal(g), (tx) =>
      appendMessage(tx, {
        id: newId(),
        threadId: globalThreadId(g),
        role: 'system',
        content: 'Отменено действие',
        metadata: { type: 'undo', undoes: first.actionId, actions: [forged] },
      }),
    );
    await withIdentity(db, personal(g), async (tx) => {
      // Шаг прогона отменён записью отмены — последнее отменяемое действие — создание цели
      expect((await J.findLastUndoable(tx, g))?.id).toBe(created.actionId);
      expect(await J.findAction(tx, g, forged.id)).toBeUndefined();
      expect((await J.lastActionTouching(tx, g, target))?.id).toBe(first.actionId);
      expect((await J.runActions(tx, g, runId)).map((e) => e.id)).toEqual([first.actionId]);
      const run = await J.runActions(tx, g, runId);
      const cursor = must(run[0], 'действие прогона').cursor;
      expect(await J.actionsTouchingAfter(tx, g, cursor, [target])).toEqual([]);
      const since = new Date(Date.now() - 3600_000);
      expect(await J.financialUpdatesSince(tx, g, since, [category])).toEqual([]);
      // Правка владельца в интерфейсе — только создание цели (шаг прогона — `routine`)
      expect((await J.recentOwnerEdits(tx, g, since, 10)).map((e) => e.id)).toEqual([
        created.actionId,
      ]);
      // А как запись отмены она видна: отменённое — отменено, в экспорте — отменой с её операциями
      expect(await J.isUndone(tx, g, first.actionId)).toBe(true);
      const undos = (await J.exportJournal(tx, g)).filter((e) => e.type === 'undo');
      expect(undos.map((e) => [e.undoes, e.entityIds])).toEqual([[first.actionId, [target]]]);
    });
  });
  // M-1/M-2 фикс-круга 1: поля записи действия — как лежат. Подставленный актор или отброшенный `null` сделали бы
  // проверки атрибуции и «ключа нет вовсе» во всех тестах, читающих журнал, пустыми.
  test('поля записи — как лежат: актора нет — его нет, ключ со значением null — есть', async () => {
    const g = await freshGraph();
    const bare = crypto.randomUUID();
    const partial = {
      id: bare,
      type: 'batch',
      entity_id: null,
      actor_kind: 'owner',
      source: 'ui',
      mechanism: 'user',
      module: null,
      operations: [],
      inverse: [],
    } as unknown as ActionRecord; // запись без `actor_user_id` и с `module: null` — сломанный писатель
    await withIdentity(db, personal(g), (tx) =>
      sink.write(tx, {
        id: batchAuditMessageId(g, bare),
        graphId: g,
        action: partial,
        card: { tool: 'batch_execute', entity_id: null, title: 'без актора' },
      }),
    );
    const e = must(
      await withIdentity(db, personal(g), (tx) => J.findAction(tx, g, bare)),
      'запись без актора',
    );
    expect(e.actorUserId).toBeUndefined();
    expect(Object.hasOwn(e, 'module')).toBe(true);
    expect(e.module).toBeNull();
    expect(Object.hasOwn(e, 'runId')).toBe(false);
  });
});

// ─────────────────────────── сторож: журнал читает только этот модуль ───────────────────────────

/**
 * КОД-формы чтения журнала прежнего хранилища (фикс-круг 1, M-7: регэксп брифа видел только SQL-пробы по metadata):
 *  - SQL-проба по metadata (`@>`, `->`, `->>`, `?`) на ключ `actions`/`type`, доступ `.metadata.actions`, приведение
 *    `metadata as {… actions …}` — регэксп брифа;
 *  - проба ПЕРЕМЕННОЙ (`metadata @> ${probe}`) — через саму пробу: объект журнальной формы `{ actions: [` (в строку или
 *    построчно — `actions: [` в конце строки) и `type: 'undo'`;
 *  - PK-проба пачки и чтение синком: `batchAuditMessageId(` и `findByAuditId(`.
 * `[[:space:]]`, а не `\s`: ERE Apple Git `\s` не понимает. Прогон по BASE задачи 4 (`0fda57a0`) находит всех прежних
 * читателей — undo, rollback, mechanism, escalation, pending (три), setup-graph, aggregates, plan-to-fact, review,
 * migrate-1v (два) — отчёт фикс-круга 1.
 */
const JOURNAL_READ_PATTERN = [
  'metadata[[:space:]]*(@>|->>?|\\?)[[:space:]]*\'?\\{?"?(actions|type)',
  '\\.metadata\\.actions',
  'metadata as \\{[^}]*actions',
  '\\{[[:space:]]*actions:[[:space:]]*\\[',
  '^[[:space:]]*actions:[[:space:]]*\\[$',
  "type:[[:space:]]*'undo'",
  'batchAuditMessageId\\(',
  'findByAuditId\\(',
].join('|');

/**
 * Не читатели — поимённо, построчно (файл + фрагмент строки) и с причиной. Пишет журнал исполнитель и `undo.ts`
 * (глобальное ограничение плана); повтор пачки исполнитель берёт у СВОЕГО синка — это путь записи, задача 5 переименует
 * его в `findBatchWrite`.
 */
const NOT_READERS: ReadonlyArray<{ file: string; text: string; why: string }> = [
  {
    file: 'apps/server/src/executor/executor.ts',
    text: 'const auditId = batchAuditMessageId(req.identity.graph, batchId);',
    why: 'ключ записи пачки при записи',
  },
  {
    file: 'apps/server/src/executor/executor.ts',
    text: 'sink.findByAuditId(tx, auditId)',
    why: 'повтор пачки — у синка писателя (задача 5: findBatchWrite)',
  },
  {
    file: 'apps/server/src/executor/types.ts',
    text: 'findByAuditId(',
    why: 'интерфейс синка и синк в памяти',
  },
  {
    file: 'apps/server/src/executor/undo.ts',
    text: "metadata: { type: 'undo', undoes: action.id },",
    why: 'ЗАПИСЬ отмены — писатель журнала',
  },
  {
    file: 'apps/server/src/tools/dispatch.ts',
    text: 'findByAuditId: (tx, id) => inner.findByAuditId(tx, id),',
    why: 'синк захвата делегирует повтор пачки внутреннему синку исполнителя',
  },
  {
    file: 'apps/server/src/policy/pending.ts',
    text: 'const auditId = batchAuditMessageId(args.identity.graph, args.pendingId);',
    why: 'адрес исполненной пачки в деталях отказа «уже исполнено» — не чтение',
  },
];

const REPO_ROOT = `${import.meta.dir}/../../../..`;

/** Строка `git grep -n` — комментарий (`//`, `*`, `/**`)? Докблоки читателями не являются. */
const isComment = (line: string): boolean => /^[^:]+:\d+:\s*(\/\/|\/?\*)/.test(line);

describe('сторож РП-9: журнал читает только journal-read.ts', () => {
  test('регэксп сторожа ловит все формы чтения (положительный контроль тем же движком git grep)', () => {
    const samples = [
      '  const x = row.metadata as { actions?: ActionRecord[] };',
      "      sql`SELECT metadata -> 'actions' -> 0 ->> 'id' AS action_id",
      '        WHERE m.metadata @> \'{"actions": []}\'::jsonb',
      "        AND m.metadata->'actions'->0->>'source' IS DISTINCT FROM 'system'",
      '        WHERE u.metadata @> \'{"type":"undo"}\'::jsonb',
      "     WHERE m.role = 'system' AND m.metadata ? 'actions'",
      '  const a = msg.metadata.actions[0];',
      // формы BASE задачи 4, которых регэксп брифа не видел (M-7)
      '  const probe = JSON.stringify({ actions: [{ id: actionId }] });',
      "  const probe = JSON.stringify({ type: 'undo', undoes: actionId });",
      '    actions: [',
      '    .where(eq(chatMessages.id, batchAuditMessageId(graphId, pendingId)));',
      '    const replay = (await rolloverSink.findByAuditId(tx, auditId)) !== undefined;',
    ];
    const dir = mkdtempSync(join(tmpdir(), 'journal-guard-'));
    try {
      writeFileSync(join(dir, 'samples.ts'), `${samples.join('\n')}\n`);
      const out = Bun.spawnSync(
        ['git', 'grep', '--no-index', '-n', '-E', JOURNAL_READ_PATTERN, '--', 'samples.ts'],
        { cwd: dir },
      );
      const hits = out.stdout
        .toString()
        .trim()
        .split('\n')
        .filter((l) => l !== '');
      expect(hits.length).toBe(samples.length);
      // Отрицательный контроль: сводка ответа ассистента — не проба журнала
      writeFileSync(
        join(dir, 'samples.ts'),
        '    return { assistantMessage: pre.existingAnswer, actions: [], pending: [], replayed: true };\n',
      );
      const miss = Bun.spawnSync(
        ['git', 'grep', '--no-index', '-n', '-E', JOURNAL_READ_PATTERN, '--', 'samples.ts'],
        { cwd: dir },
      );
      expect(miss.stdout.toString().trim()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('вне journal-read.ts журнал в chat_messages никто не читает (РП-9)', () => {
    const out = Bun.spawnSync(
      [
        'git',
        'grep',
        '-n',
        '-E',
        JOURNAL_READ_PATTERN,
        '--',
        'apps/server/src',
        ':(exclude)apps/server/src/**/*.test.ts',
        ':(exclude)apps/server/src/test/',
        ':(exclude)apps/server/src/executor/journal-read.ts',
        // синк журнала — он пишет
        ':(exclude)apps/server/src/executor/journal.ts',
        // поимённо: фильтр выдачи треда снимает задача 6, сжатие строк контекста переводит задача 5 (threadPage)
        ':(exclude)apps/server/src/chat/messages.ts',
        ':(exclude)apps/server/src/llm/context.ts',
        // поимённо: `ops.ts perf` меряет САМО хранилище (байты строк, все графы, BYPASSRLS) и выбирает его по
        // каталогу — прежнее или таблицу (задача 2); это замер хранилища, а не чтение действий, и API журнала
        // (по графу, под идентичностью) его не выражает. Ветку прежнего хранилища снимает задача 5.
        ':(exclude)apps/server/src/db/perf-report.ts',
      ],
      { cwd: REPO_ROOT },
    );
    const lines = out.stdout
      .toString()
      .trim()
      .split('\n')
      .filter((l) => l !== '' && !isComment(l))
      .filter((l) => !NOT_READERS.some((n) => l.startsWith(`${n.file}:`) && l.includes(n.text)));
    expect(lines).toEqual([]);
  });
});
