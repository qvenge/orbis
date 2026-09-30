// apps/server/src/executor/journal.test.ts
// Боевой синк журнала (§7.8, спека скорости §11.2): строка `action_journal` ТЕМ ЖЕ tx, что и правка, — формат
// действия (весь `ActionRecord` + атрибуция D11), тред строки, одна строка на пачку (id = batch_id), идемпотентный
// повтор без второй строки, гонка одинаковых пачек (арбитр — PK журнала), боковая таблица затронутых записей и
// отсутствие чего-либо в `chat_messages`. Журнал читается только помощниками (`test/journal-helpers.ts`).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import { globalThreadId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  accountOf,
  addMember,
  adminDb,
  appDb,
  freshGraph,
  personal,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { actionsOf, journalEntitiesOf, journalOf, threadJournal } from '../../test/journal-helpers';
import { ensureEntityThread } from '../chat/threads';
import { withIdentity } from '../db/with-identity';
import { resolveEntitlement } from '../entitlements';
import { ExecError } from '../errors';
import { identityOfGrant } from '../identity';
import { execute } from './executor';
import { makeJournalSink } from './journal';
import {
  type ActionRecord,
  type ExecuteOk,
  type ExecuteRequest,
  type ExecuteResult,
  InMemoryJournalSink,
  type JournalWrite,
  type WireEntity,
} from './types';

requireEnv();

const { db, client } = appDb();
const sink = makeJournalSink();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

function req(
  user: GraphId,
  tool: string,
  input: unknown,
  over: Partial<ExecuteRequest> = {},
): ExecuteRequest {
  return {
    identity: personal(user),
    actorKind: 'owner',
    source: 'fast_path',
    operations: [{ tool, input }],
    ...over,
  };
}

function batchReq(
  user: GraphId,
  operations: Array<{ tool: string; input: unknown }>,
  batchId: string,
): ExecuteRequest {
  return { identity: personal(user), actorKind: 'owner', source: 'chat', operations, batchId };
}

/** Запись журнала по id с внятным падением. */
async function mustJournal(user: GraphId, actionId: string) {
  const e = await journalOf(user, actionId);
  if (e === undefined) throw new Error(`действия ${actionId} нет в журнале`);
  return e;
}

async function adminCount(query: ReturnType<typeof sql>): Promise<number> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(query);
    return rows[0]?.n as number;
  } finally {
    await adminClient.end();
  }
}

/** Сообщений чата в тредах графа — журнал в них больше не пишется ничего (§11.1). */
function messagesOfGraph(user: GraphId): Promise<number> {
  return adminCount(
    sql`SELECT count(*)::int AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
        WHERE t.graph_id = ${user}::uuid`,
  );
}

/**
 * Пин «журнал разводит АКТОРА и ГРАФ» (D44).
 *
 * ПОЧЕМУ НЕ НА ПАРЕ С РАЗНЫМИ ЗНАЧЕНИЯМИ, как предполагал план Г-3. Когда этот пин писался,
 * политики были ещё старые (`graph_id = auth.uid()`), и запись под парой {actor: X, graph: Y}
 * не доходила до синка вовсе: WITH CHECK у `entities` отбивал её `42501` ДО стадии журнала —
 * in-memory синк «не ходит в базу», но исполнитель перед ним ходит. Поведенческая половина
 * этого пина живёт в `test/graph-vs-account.test.ts` и с миграции 0021 зелена без пометок:
 * там журнал пишется боевым синком, и строка ложится в граф ЧУЖОГО для актора графа.
 *
 * Что пинится ЗДЕСЬ и краснеет на мутации уже сегодня: разведение по ДВУМ ПОЛЯМ формы и
 * то, что поля несут РАЗНЫЕ бренды. Мутация `graphId: req.identity.actor` в
 * `executor.ts` (сборка JournalWrite) делает красным `bun run typecheck`, а не этот файл, —
 * директивы ниже держат ровно это и станут неиспользуемыми (TS2578), если бренды сольют.
 */
describe('журнал: actor_user_id — аккаунт, graphId записи — граф (D44)', () => {
  test('исполнитель раскладывает пару по двум полям записи — актор ЧУЖОЙ графу', async () => {
    // Фикстура НАМЕРЕННО «оператор в чужом графе», а не личный граф. В личном графе
    // `accountOf(graph)` и `graph` — одна и та же строка, и подмена полей местами
    // (`graphId: identity.actor`, `actor_user_id: identity.graph`) оставляла оба `toBe`
    // зелёными (Ф-Г-44). После 0021 `addMember` выдаёт второму аккаунту грант `operator` в
    // графе, и резолвер 2 даёт пару, у которой половины РАЗНЫЕ, — подмена красит обе строки.
    const graph = await freshGraph();
    const operator = accountOf(await freshGraph());
    await addMember(graph, operator, 'operator');
    const memory = new InMemoryJournalSink();
    ok(
      await execute(
        db,
        req(
          graph,
          'entity_create',
          { title: 'запись пары', tags: [] },
          {
            identity: identityOfGrant({ accountId: operator, graphId: graph }),
          },
        ),
        { sink: memory },
      ),
    );
    const entry = memory.entries[0];
    if (entry === undefined) throw new Error('синк не получил записи журнала');
    expect(entry.graphId).toBe(graph);
    expect(entry.action.actor_user_id).toBe(operator);
    // И половины действительно разные — иначе кейс опять ничего не различал бы.
    expect(entry.action.actor_user_id as string).not.toBe(entry.graphId as string);
  });

  test('сигнатура: граф записи и актор действия — разные типы (спека Ш-2)', async () => {
    const graph = await freshGraph();
    const account = accountOf(graph);
    // @ts-expect-error — аккаунт на месте графа записи: компилятор обязан отказать
    const wrong: JournalWrite['graphId'] = account;
    void wrong;
    // @ts-expect-error — граф на месте субъекта тарифа: тот же барьер с другой стороны
    void (() => resolveEntitlement(graph, 'entities.create'));
    expect(true).toBe(true);
  });
});

describe('боевой синк: строка action_journal (§7.8, §11.2)', () => {
  test('1. одиночное действие → ОДНА строка: id = actionId, граф, поля ActionRecord, entity_ids и боковые строки; в chat_messages — ничего', async () => {
    const user = await freshGraph();
    const r = ok(
      await execute(db, req(user, 'entity_create', { title: 'Кофе', tags: ['Кофе'] }), { sink }),
    );
    const e = r.results[0] as WireEntity;

    const all = await actionsOf(user);
    expect(all.map((a) => a.id)).toEqual([r.actionId]); // ровно одна запись — id действия
    const row = await mustJournal(user, r.actionId);
    expect(row.graphId).toBe(user);
    expect(row.type).toBe('entity_created');
    expect(row.entityId).toBe(e.id);
    expect(row.actorUserId).toBe(accountOf(user));
    expect(row.actorKind).toBe('owner');
    expect(row.source).toBe('fast_path');
    expect(row.mechanism).toBe('user'); // умолчание §А4-4: прямое действие владельца
    // Без гранта и прогона ключей нет вовсе (атрибуция D11 — по наличию, а не null)
    for (const k of ['actorGrantId', 'runId', 'actionId', 'module', 'editedFrom', 'results']) {
      expect([k, Object.hasOwn(row, k)]).toEqual([k, false]);
    }
    expect(row.operations).toEqual([
      {
        op: 'entity_create',
        payload: {
          id: e.id,
          title: 'Кофе',
          emoji: null,
          body: '',
          tags: ['кофе'],
          // Единица журнала — СВОЙСТВО (§А7-4): плоские `props` по id свойства и список аспектов.
          props: {},
          aspects: [],
        },
      },
    ]);
    // §7.8: создание → архивация
    expect(row.inverse).toEqual([{ op: 'entity_update', payload: { id: e.id, archived: true } }]);
    // Карточка — заголовок и тул; форма карточки ленты собирается на чтении (`journal/thread-page.ts`)
    expect([row.title, row.cardTool]).toEqual(['Кофе', 'entity_create']);
    // Тред без явного — глобальный (РП-10: до задачи 6 как сегодня)
    expect(row.threadId).toBe(globalThreadId(user));
    // Поля среза — умолчания, пока их не заполнят задачи 7 и 9
    expect([
      row.textSession,
      row.bodyBefore,
      row.undoes,
      row.pinnedVersionIds,
      row.cardInReply,
    ]).toEqual([false, null, null, [], false]);
    expect(row.entityIds).toEqual([e.id]);
    // Боковая таблица — по строке на каждую затронутую запись, той же транзакцией (РП-8)
    expect(await journalEntitiesOf(user, r.actionId)).toEqual([e.id]);
    // Журнал в сообщения чата не пишется ничего — ни audit, ни пустого треда с сообщением
    expect(await messagesOfGraph(user)).toBe(0);
  });

  test('1b. запись entity_update: props по id свойства, без meta и без карты аспектов; mechanism на месте (§А7-4)', async () => {
    const user = await freshGraph();
    const created = ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Тикет',
          tags: [],
          props: { 'orbis/task_status': 'inbox', 'orbis/priority': 'low' },
          aspects: ['orbis/task'],
        }),
        { sink },
      ),
    );
    const e = created.results[0] as WireEntity;

    const updated = ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: e.id,
          props: { 'orbis/priority': 'high', 'orbis/pinned': true },
          aspects: { attach: ['orbis/task', 'orbis/note'] },
        }),
        { sink },
      ),
    );

    expect((await mustJournal(user, created.actionId)).operations[0]?.payload).toEqual({
      id: e.id,
      title: 'Тикет',
      emoji: null,
      body: '',
      tags: [],
      props: { 'orbis/task_status': 'inbox', 'orbis/priority': 'low' },
      aspects: ['orbis/task'],
    });
    const action = await mustJournal(user, updated.actionId);
    expect(action.mechanism).toBe('user');
    expect(action.operations).toEqual([
      {
        op: 'entity_update',
        payload: {
          id: e.id,
          props: { 'orbis/pinned': true, 'orbis/priority': 'high' },
          aspects: { attach: ['orbis/note'] },
        },
      },
    ]);
    expect(action.inverse).toEqual([
      {
        op: 'entity_update',
        payload: {
          id: e.id,
          props: { 'orbis/priority': 'low' },
          unset: ['orbis/pinned'],
          aspects: { detach: ['orbis/note'] },
        },
      },
    ]);
    // Старой карты в полезной нагрузке нет ни в одной половине записи
    for (const op of [...action.operations, ...action.inverse]) {
      expect(Object.hasOwn(op.payload, 'meta')).toBe(false);
      const aspects = (op.payload.aspects ?? {}) as Record<string, unknown>;
      expect(Object.keys(aspects).filter((k) => k !== 'attach' && k !== 'detach')).toEqual([]);
    }
  });

  test('2. явный req.threadId: строка — в указанном треде, не в глобальном', async () => {
    const user = await freshGraph();
    const created = ok(
      await execute(db, req(user, 'entity_create', { title: 'Носитель', tags: [] }), { sink }),
    );
    const e = created.results[0] as WireEntity;
    const tid = await withIdentity(db, personal(user), (tx) => ensureEntityThread(tx, user, e.id));

    const upd = ok(
      await execute(
        db,
        req(user, 'entity_update', { id: e.id, title: 'Новее' }, { threadId: tid }),
        {
          sink,
        },
      ),
    );

    expect((await threadJournal(user, tid)).map((j) => j.id)).toEqual([upd.actionId]);
    // в глобальном — только создание
    expect((await threadJournal(user, globalThreadId(user))).map((j) => j.id)).toEqual([
      created.actionId,
    ]);
  });

  test('3. пачка: ОДНА строка, id = batch_id, type batch, results сохранены; повтор — idempotentReplay без второй строки', async () => {
    const user = await freshGraph();
    const batchId = newId();
    const ops = [
      { tool: 'entity_create', input: { title: 'Раз', tags: [] } },
      { tool: 'entity_create', input: { title: 'Два', tags: [] } },
    ];
    const r = ok(await execute(db, batchReq(user, ops, batchId), { sink }));
    expect(r.idempotentReplay).toBe(false);

    expect((await actionsOf(user)).map((a) => a.id)).toEqual([batchId]); // один action на пачку (§7.8)
    const action = await mustJournal(user, batchId);
    expect(action.type).toBe('batch');
    expect(action.operations.length).toBe(2);
    // results — источник ответа идемпотентного повтора
    expect(action.results).toEqual(r.results as unknown[]);
    expect([action.title, action.cardTool, action.entityId]).toEqual([
      'batch: операций — 2',
      'batch_execute',
      null,
    ]);
    // обе созданные записи — в боковой таблице
    const ids = (r.results as WireEntity[]).map((x) => x.id).sort();
    expect(await journalEntitiesOf(user, batchId)).toEqual(ids);

    // последовательный повтор того же batch_id: ничего не применяется, строка одна
    const replay = ok(await execute(db, batchReq(user, ops, batchId), { sink }));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.actionId).toBe(batchId);
    expect(replay.results).toEqual(r.results);
    expect((await actionsOf(user)).length).toBe(1);
    const n = await adminCount(
      sql`SELECT count(*)::int AS n FROM entities WHERE graph_id = ${user}`,
    );
    expect(n).toBe(2); // данные не задвоены
    // синк отдаёт сохранённую запись пачки той же формы, что писал исполнитель
    const saved = await withIdentity(db, personal(user), (tx) =>
      sink.findBatchWrite(tx, user, batchId),
    );
    expect(saved?.results).toEqual(r.results as unknown[]);
    expect(saved?.card).toEqual({
      tool: 'batch_execute',
      entity_id: null,
      title: 'batch: операций — 2',
    });
    expect(saved?.action.id).toBe(batchId);
  });

  // РП-12: в таблице id одиночного действия и batch_id пачки — ОДНО пространство ключей `(graph_id, id)`. Клиентский
  // batch_id, совпавший с id одиночного действия, не должен вернуть «повтор» чужой записи.
  test('3b. пачка с batch_id, равным id одиночного действия, — не повтор: чужая запись не отдана, пачка не исполнена', async () => {
    const user = await freshGraph();
    const single = ok(
      await execute(db, req(user, 'entity_create', { title: 'Одиночное', tags: [] }), { sink }),
    );
    const clash = await execute(
      db,
      batchReq(
        user,
        [{ tool: 'entity_create', input: { title: 'Пачка-двойник', tags: [] } }],
        single.actionId,
      ),
      { sink },
    );
    expect(clash.ok).toBe(false);
    if (clash.ok) throw new Error('недостижимо');
    expect(clash.error.code).toBe('CONFLICT');
    expect((clash.error.details as { reason?: string }).reason).toBe('id_conflict');
    // пачка не исполнена: записи-двойника нет; одиночное действие — прежнее
    const n = await adminCount(
      sql`SELECT count(*)::int AS n FROM entities WHERE graph_id = ${user} AND title = 'Пачка-двойник'`,
    );
    expect(n).toBe(0);
    expect((await mustJournal(user, single.actionId)).type).toBe('entity_created');
    const replay = await withIdentity(db, personal(user), (tx) =>
      sink.findBatchWrite(tx, user, single.actionId),
    );
    expect(replay).toBeUndefined();
  });

  test('4. идемпотентный replay одиночного entity_create по client-UUID не пишет второй строки (§5.3)', async () => {
    const user = await freshGraph();
    const id = newId();
    const input = { id, title: 'Идемпотент', tags: [] };
    ok(await execute(db, req(user, 'entity_create', input), { sink }));
    const again = ok(await execute(db, req(user, 'entity_create', input), { sink }));
    expect(again.idempotentReplay).toBe(true);
    expect((await actionsOf(user)).length).toBe(1);
  });

  test('5. КОНКУРЕНТНАЯ гонка одинаковых пачек: PK журнала — арбитр; один applied, другой idempotentReplay, эффекты одни', async () => {
    const user = await freshGraph();
    const batchId = newId();
    // Операции БЕЗ явных id: каждый вызов генерирует свои id сущностей, поэтому единственная точка
    // конфликта конкурентов — ключ журнала (graph_id, batch_id). Гонку разрешает сама БД (23505 →
    // AuditIdConflictError → сохранённый результат), а не тайминг теста.
    const ops = [
      { tool: 'entity_create', input: { title: 'Гонка-А', tags: [] } },
      { tool: 'entity_create', input: { title: 'Гонка-Б', tags: [] } },
    ];
    const [r1, r2] = await Promise.all([
      execute(db, batchReq(user, ops, batchId), { sink }),
      execute(db, batchReq(user, ops, batchId), { sink }),
    ]);
    const o1 = ok(r1);
    const o2 = ok(r2);

    expect([o1.idempotentReplay, o2.idempotentReplay].sort()).toEqual([false, true]);
    expect(o1.actionId).toBe(batchId);
    expect(o2.actionId).toBe(batchId);
    expect(o1.results).toEqual(o2.results);

    expect((await actionsOf(user)).map((a) => a.id)).toEqual([batchId]); // ровно одна строка
    const total = await adminCount(
      sql`SELECT count(*)::int AS n FROM entities WHERE graph_id = ${user}`,
    );
    expect(total).toBe(2);
    for (const title of ['Гонка-А', 'Гонка-Б']) {
      const n = await adminCount(
        sql`SELECT count(*)::int AS n FROM entities WHERE graph_id = ${user} AND title = ${title}`,
      );
      expect(n).toBe(1);
    }
  });

  test('6. write отклоняет entry с ≠1 action → VALIDATION до любой записи: инвариант «одна строка — одно действие» (§7.8)', async () => {
    const user = await freshGraph();
    const action: ActionRecord = {
      id: newId(),
      type: 'entity_updated',
      entity_id: null,
      actor_user_id: accountOf(user),
      actor_kind: 'owner',
      source: 'ui',
      mechanism: 'user',
      operations: [],
      inverse: [],
    };
    // Нарушение контракта: два action в одной записи — отмена взяла бы только первый, второй
    // молча потерялся бы. write обязан отклонить ДО любой записи.
    const bad = {
      graphId: user,
      action: [action, action],
      card: { tool: 'entity_update', entity_id: null, title: 'нарушение' },
    } as unknown as JournalWrite;

    let caught: unknown;
    try {
      await withIdentity(db, personal(user), (tx) => sink.write(tx, bad));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).code).toBe('VALIDATION');
    expect(await actionsOf(user)).toEqual([]);
  });

  // С2: актор — не анонимный «агент вообще»: видно, каким грантом и в каком прогоне сделано действие.
  // Ключи — по наличию: без гранта и прогона их нет вовсе, иначе пробы по прогонам ловили бы и
  // действия, сделанные руками владельца.
  test('7. actorGrantId/runId одиночного вызова: поля в строке, проба прогона находит; без них ключей НЕТ', async () => {
    const agentUser = await freshGraph();
    const grantId = newId();
    const runId = newId();
    const r = ok(
      await execute(
        db,
        req(
          agentUser,
          'entity_create',
          { title: 'Создано агентом', tags: [] },
          { actorKind: 'agent', source: 'mcp', actorGrantId: grantId, runId },
        ),
        { sink },
      ),
    );
    const action = await mustJournal(agentUser, r.actionId);
    expect(action.actorGrantId).toBe(grantId);
    expect(action.runId).toBe(runId);

    const ownerUser = await freshGraph();
    const own = ok(
      await execute(db, req(ownerUser, 'entity_create', { title: 'Своими руками', tags: [] }), {
        sink,
      }),
    );
    const ownAction = await mustJournal(ownerUser, own.actionId);
    expect(ownAction).not.toHaveProperty('actorGrantId');
    expect(ownAction).not.toHaveProperty('runId');
  });

  test('8. пачка: грант и прогон попадают в ОБЩУЮ строку пакета (§7.8 — одна строка на пачку)', async () => {
    const user = await freshGraph();
    const batchId = newId();
    const grantId = newId();
    const runId = newId();
    ok(
      await execute(
        db,
        {
          identity: personal(user),
          actorKind: 'agent',
          source: 'mcp',
          operations: [
            { tool: 'entity_create', input: { title: 'Пакет агента 1', tags: [] } },
            { tool: 'entity_create', input: { title: 'Пакет агента 2', tags: [] } },
          ],
          batchId,
          actorGrantId: grantId,
          runId,
        },
        { sink },
      ),
    );
    const action = await mustJournal(user, batchId);
    expect(action.type).toBe('batch');
    expect(action.actorGrantId).toBe(grantId);
    expect(action.runId).toBe(runId);
  });
});

/** Тредов графа (любых) — синк сам тред не заводит, если строке треда не положено (Р-12). */
function threadsOfGraph(user: GraphId): Promise<number> {
  return adminCount(
    sql`SELECT count(*)::int AS n FROM chat_threads WHERE graph_id = ${user}::uuid`,
  );
}

// Спека скорости §11.3–§11.4, Р-12: правки владельца в интерфейсе (`ui`, `quick_capture`) и системные записи
// (`system`) треда не получают — даже если вызывающий его передал; агент (`mcp`) треда не передаёт — глобальный
// тред владельца; быстрый ввод — тред ввода (РП-13).
describe('правило треда строки журнала (§11.3, Р-12)', () => {
  test('ui, quick_capture и system → тред NULL, глобальный тред не заводится', async () => {
    const user = await freshGraph();
    const ids: string[] = [];
    for (const source of ['ui', 'quick_capture', 'system'] as const) {
      const r = ok(
        await execute(
          db,
          req(user, 'entity_create', { title: `Без треда ${source}`, tags: [] }, { source }),
          { sink },
        ),
      );
      ids.push(r.actionId);
    }
    for (const id of ids) expect((await mustJournal(user, id)).threadId).toBeNull();
    // ensureGlobalThread не звался: ни одного треда у графа
    expect(await threadsOfGraph(user)).toBe(0);
  });

  test('ui с явным threadId — всё равно без треда: у правки владельца отмена в интерфейсе, тред молчит', async () => {
    const user = await freshGraph();
    const host = ok(
      await execute(db, req(user, 'entity_create', { title: 'Хост', tags: [] }, { source: 'ui' }), {
        sink,
      }),
    );
    const hostId = (host.results[0] as WireEntity).id;
    const tid = await withIdentity(db, personal(user), (tx) =>
      ensureEntityThread(tx, user, hostId),
    );
    const upd = ok(
      await execute(
        db,
        req(
          user,
          'entity_update',
          { id: hostId, title: 'Правка' },
          { source: 'ui', threadId: tid },
        ),
        { sink },
      ),
    );
    expect((await mustJournal(user, upd.actionId)).threadId).toBeNull();
    expect(await threadJournal(user, tid)).toEqual([]);
  });

  test('mcp без треда → глобальный тред владельца; fast_path с threadId → этот тред', async () => {
    const user = await freshGraph();
    const agent = ok(
      await execute(
        db,
        req(
          user,
          'entity_create',
          { title: 'Агент', tags: [] },
          { source: 'mcp', actorKind: 'agent' },
        ),
        { sink },
      ),
    );
    expect((await mustJournal(user, agent.actionId)).threadId).toBe(globalThreadId(user));
    const entityId = (agent.results[0] as WireEntity).id;
    const tid = await withIdentity(db, personal(user), (tx) =>
      ensureEntityThread(tx, user, entityId),
    );
    const fast = ok(
      await execute(
        db,
        req(user, 'entity_create', { title: 'Быстрый', tags: [] }, { threadId: tid }),
        { sink },
      ),
    );
    expect((await mustJournal(user, fast.actionId)).threadId).toBe(tid);
  });
});
