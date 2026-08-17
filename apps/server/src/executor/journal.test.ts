// apps/server/src/executor/journal.test.ts
// Интеграционные тесты Task 11: боевой JournalSink над chat_messages (§7.8) —
// формат action (дословно + атрибуция D11), целевой тред, один audit на batch
// (PK = batchAuditMessageId), идемпотентный повтор без второго сообщения,
// конкурентная PK-гонка одинаковых batch'ей (перенесённое обязательство Task 10).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { batchAuditMessageId, globalThreadId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { ensureEntityThread } from '../chat/threads';
import { withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { execute } from './executor';
import { makeChatJournalSink } from './journal';
import type {
  ActionRecord,
  ExecuteOk,
  ExecuteRequest,
  ExecuteResult,
  JournalWrite,
  WireEntity,
} from './types';

requireEnv();

const { db, client } = appDb();
const sink = makeChatJournalSink();

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
  user: string,
  tool: string,
  input: unknown,
  over: Partial<ExecuteRequest> = {},
): ExecuteRequest {
  return {
    actorUserId: user,
    actorKind: 'owner',
    source: 'fast_path',
    operations: [{ tool, input }],
    ...over,
  };
}

function batchReq(
  user: string,
  operations: Array<{ tool: string; input: unknown }>,
  batchId: string,
): ExecuteRequest {
  return { actorUserId: user, actorKind: 'owner', source: 'chat', operations, batchId };
}

/** Первый элемент массива с внятным падением (вместо non-null assertion). */
function first<T>(items: readonly T[]): T {
  const v = items[0];
  if (v === undefined) throw new Error('ожидался хотя бы один элемент');
  return v;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
}

/** Сообщения треда по created_at (админ-DSN — RLS обходится). */
async function messagesInThread(threadId: string): Promise<MessageRow[]> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(
      sql`SELECT id, thread_id, role, content, metadata FROM chat_messages
          WHERE thread_id = ${threadId} ORDER BY created_at, id`,
    );
    return [...rows] as unknown as MessageRow[];
  } finally {
    await adminClient.end();
  }
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

function actionsOf(msg: MessageRow): ActionRecord[] {
  return (msg.metadata as { actions?: ActionRecord[] }).actions ?? [];
}

describe('боевой JournalSink: audit-сообщение в chat_messages (§7.8)', () => {
  test('1. execute(entity_create, fast_path) без threadId → системное сообщение в глобальном треде; формат action дословно §7.8 + атрибуция', async () => {
    const user = freshUserId();
    const r = ok(
      await execute(db, req(user, 'entity_create', { title: 'Кофе', tags: ['Кофе'] }), { sink }),
    );
    const e = r.results[0] as WireEntity;

    const msgs = await messagesInThread(globalThreadId(user));
    expect(msgs.length).toBe(1); // глобальный тред создан тем же tx, сообщение — в нём
    const msg = first(msgs);
    expect(msg.role).toBe('system');

    const actions = actionsOf(msg);
    expect(actions.length).toBe(1);
    const action = first(actions);
    // все поля формата — и ничего сверх формата
    expect(Object.keys(action).sort()).toEqual([
      'actor_kind',
      'actor_user_id',
      'entity_id',
      'id',
      'inverse',
      'operations',
      'source',
      'type',
    ]);
    expect(action.id).toBe(r.actionId);
    expect(action.type).toBe('entity_created');
    expect(action.entity_id).toBe(e.id);
    expect(action.actor_user_id).toBe(user);
    expect(action.actor_kind).toBe('owner');
    expect(action.source).toBe('fast_path');
    expect(action.operations).toEqual([
      {
        op: 'entity_create',
        payload: {
          id: e.id,
          title: 'Кофе',
          emoji: null,
          body: '',
          tags: ['кофе'],
          meta: {},
          aspects: {},
        },
      },
    ]);
    // §7.8: создание → архивация
    expect(action.inverse).toEqual([
      { op: 'entity_update', payload: { id: e.id, archived: true } },
    ]);
    // Карточка действия. fast_path — единственный источник, чья карточка живёт только
    // в кэше клиента (useFastPath) и пропадает при первом же перечитывании треда,
    // поэтому в ленту пишется форма клиентского union'а (02-core-os §2.3): с kind,
    // иначе renderCards уходит в default и от карточки остаётся голая строка.
    // aspects/keyFields пусты: реестра аспектов у синка нет (см. journal.ts).
    expect((msg.metadata as { cards?: unknown[] }).cards).toEqual([
      {
        kind: 'entity_card',
        entityId: e.id,
        title: 'Кофе',
        aspects: [],
        keyFields: {},
        undoActionId: r.actionId, // тот же id, что уходит в ai.undo({actionId})
      },
    ]);
  });

  test('2. явный req.threadId: audit-сообщение попадает в указанный тред, не в глобальный', async () => {
    const user = freshUserId();
    const created = ok(
      await execute(db, req(user, 'entity_create', { title: 'Носитель', tags: [] }), { sink }),
    );
    const e = created.results[0] as WireEntity;
    const tid = await withIdentity(db, user, (tx) => ensureEntityThread(tx, user, e.id));

    ok(
      await execute(
        db,
        req(user, 'entity_update', { id: e.id, title: 'Новее' }, { threadId: tid }),
        {
          sink,
        },
      ),
    );

    const inEntityThread = await messagesInThread(tid);
    expect(inEntityThread.length).toBe(1);
    expect(first(actionsOf(first(inEntityThread))).type).toBe('entity_updated');
    // в глобальном — только audit создания
    const inGlobal = await messagesInThread(globalThreadId(user));
    expect(inGlobal.length).toBe(1);
    expect(first(actionsOf(first(inGlobal))).type).toBe('entity_created');
  });

  test('3. batch: ровно одно сообщение с PK = batchAuditMessageId, action.id = batch_id, results сохранены; повтор — idempotentReplay без второго сообщения', async () => {
    const user = freshUserId();
    const batchId = newId();
    const ops = [
      { tool: 'entity_create', input: { title: 'Раз', tags: [] } },
      { tool: 'entity_create', input: { title: 'Два', tags: [] } },
    ];
    const r = ok(await execute(db, batchReq(user, ops, batchId), { sink }));
    expect(r.idempotentReplay).toBe(false);

    const msgs = await messagesInThread(globalThreadId(user));
    expect(msgs.length).toBe(1); // один action на весь batch (§7.8)
    const msg = first(msgs);
    expect(msg.id).toBe(batchAuditMessageId(user, batchId)); // детерминированный PK
    const action = first(actionsOf(msg));
    expect(action.id).toBe(batchId);
    expect(action.type).toBe('batch');
    expect(action.operations.length).toBe(2);
    // results — источник ответа идемпотентного повтора
    expect((msg.metadata as { results?: unknown[] }).results).toEqual(r.results as unknown[]);

    // последовательный повтор того же batch_id: ничего не применяется, сообщение одно
    const replay = ok(await execute(db, batchReq(user, ops, batchId), { sink }));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.actionId).toBe(batchId);
    expect(replay.results).toEqual(r.results);
    expect((await messagesInThread(globalThreadId(user))).length).toBe(1);
    const n = await adminCount(
      sql`SELECT count(*)::int AS n FROM entities WHERE owner_id = ${user}`,
    );
    expect(n).toBe(2); // данные не задвоены
  });

  test('4. идемпотентный replay одиночного entity_create по client-UUID не пишет второго сообщения (§5.3)', async () => {
    const user = freshUserId();
    const id = newId();
    const input = { id, title: 'Идемпотент', tags: [] };
    ok(await execute(db, req(user, 'entity_create', input), { sink }));
    const again = ok(await execute(db, req(user, 'entity_create', input), { sink }));
    expect(again.idempotentReplay).toBe(true);
    expect((await messagesInThread(globalThreadId(user))).length).toBe(1);
  });

  test('5. КОНКУРЕНТНАЯ гонка одинаковых batch: PK chat_messages — арбитр; один applied, другой idempotentReplay, эффекты одни', async () => {
    const user = freshUserId();
    const batchId = newId();
    // Операции БЕЗ явных id: каждый вызов генерирует свои id сущностей, поэтому
    // единственная точка конфликта конкурентов — PK audit-сообщения
    // (batchAuditMessageId). Гонку разрешает сама БД (23505 → AuditIdConflictError →
    // сохранённый результат), а не тайминг теста: при любом интерливинге вставить
    // audit-строку может ровно одна транзакция.
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

    // ровно один applied, другой — idempotentReplay (оба applied невозможны по PK)
    expect([o1.idempotentReplay, o2.idempotentReplay].sort()).toEqual([false, true]);
    expect(o1.actionId).toBe(batchId);
    expect(o2.actionId).toBe(batchId);
    // оба вызова получили консистентный (один и тот же сохранённый) результат
    expect(o1.results).toEqual(o2.results);

    // ровно одно audit-сообщение
    const audits = await adminCount(
      sql`SELECT count(*)::int AS n FROM chat_messages WHERE id = ${batchAuditMessageId(user, batchId)}`,
    );
    expect(audits).toBe(1);
    // ровно один набор эффектов: по одной сущности каждого титула, всего две
    const total = await adminCount(
      sql`SELECT count(*)::int AS n FROM entities WHERE owner_id = ${user}`,
    );
    expect(total).toBe(2);
    for (const title of ['Гонка-А', 'Гонка-Б']) {
      const n = await adminCount(
        sql`SELECT count(*)::int AS n FROM entities WHERE owner_id = ${user} AND title = ${title}`,
      );
      expect(n).toBe(1);
    }
  });

  test('6. write отклоняет entry с ≠1 action → VALIDATION: инвариант «один action на сообщение» (§7.8), на metadata.actions[0] опирается findLastUndoable (undo.ts)', async () => {
    const user = freshUserId();
    const action: ActionRecord = {
      id: newId(),
      type: 'entity_updated',
      entity_id: null,
      actor_user_id: user,
      actor_kind: 'owner',
      source: 'ui',
      operations: [],
      inverse: [],
    };
    // Нарушение контракта: два action в одном audit-сообщении — undo взял бы только
    // actions[0], второй молча потерялся бы. write обязан отклонить ДО любой записи.
    const bad = {
      ownerId: user,
      action: [action, action],
      card: { tool: 'entity_update', entity_id: null, title: 'нарушение' },
    } as unknown as JournalWrite;

    let caught: unknown;
    try {
      await withIdentity(db, user, (tx) => sink.write(tx, bad));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).code).toBe('VALIDATION');
    // ничего не записано: guard срабатывает до ensureGlobalThread/appendMessage
    expect((await messagesInThread(globalThreadId(user))).length).toBe(0);
  });

  test('7. source=chat: карточка БЕЗ kind — сторож против дубля в ленте (карточку чат-пути уже пишет ответ ассистента)', async () => {
    const user = freshUserId();
    const fromChat = req(
      user,
      'entity_create',
      { title: 'Из чата', tags: [] },
      {
        source: 'chat',
      },
    );
    const r = ok(await execute(db, fromChat, { sink }));
    const e = r.results[0] as WireEntity;

    const msg = first(await messagesInThread(globalThreadId(user)));
    // ai/send-message.ts кладёт СВОЮ, более богатую карточку (aspects/keyFields из
    // реестра) с ТЕМ ЖЕ undoActionId в assistant-сообщение того же треда. Дай audit
    // форму клиентского union'а — в ленте окажутся две одинаковые карточки и две
    // кнопки «Отменить», причём вторая беднее первой.
    expect((msg.metadata as { cards?: unknown[] }).cards).toEqual([
      { tool: 'entity_create', entity_id: e.id, title: 'Из чата' },
    ]);
  });

  test('8. batch (entity_id = null): карточка прежней формы и НЕ пустая — на cards[0] стоит findByAuditId (идемпотентный replay §7.8)', async () => {
    const user = freshUserId();
    const batchId = newId();
    const r = ok(
      await execute(
        db,
        batchReq(
          user,
          [
            { tool: 'entity_create', input: { title: 'Пакет-1', tags: [] } },
            { tool: 'entity_create', input: { title: 'Пакет-2', tags: [] } },
          ],
          batchId,
        ),
        { sink },
      ),
    );
    expect(r.idempotentReplay).toBe(false);

    const msg = first(await messagesInThread(globalThreadId(user)));
    expect((msg.metadata as { cards?: unknown[] }).cards).toEqual([
      { tool: 'batch_execute', entity_id: null, title: 'batch: операций — 2' },
    ]);
    // Пустой cards обрушил бы replay: findByAuditId возвращает undefined без cards[0]
    const saved = await withIdentity(db, user, (tx) =>
      sink.findByAuditId(tx, batchAuditMessageId(user, batchId)),
    );
    expect(saved?.results).toEqual(r.results as unknown[]);
  });

  test('9. entity_id = null у источника из белого списка: карточка всё равно прежней формы (entityId клиента — строка, не null)', async () => {
    const user = freshUserId();
    const auditId = newId();
    const action: ActionRecord = {
      id: newId(),
      type: 'relation_created',
      entity_id: null, // не только batch: одиночные relation-мутации тоже без сущности
      actor_user_id: user,
      actor_kind: 'owner',
      source: 'fast_path',
      operations: [],
      inverse: [],
    };
    await withIdentity(db, user, (tx) =>
      sink.write(tx, {
        id: auditId,
        ownerId: user,
        action,
        card: { tool: 'relation_create', entity_id: null, title: 'связь' },
      }),
    );

    const msg = first(await messagesInThread(globalThreadId(user)));
    expect((msg.metadata as { cards?: unknown[] }).cards).toEqual([
      { tool: 'relation_create', entity_id: null, title: 'связь' },
    ]);
    const saved = await withIdentity(db, user, (tx) => sink.findByAuditId(tx, auditId));
    expect(saved?.card).toEqual({ tool: 'relation_create', entity_id: null, title: 'связь' });
  });

  // С2: в записи журнала актор перестаёт быть анонимным «агентом вообще» — видно, каким
  // грантом и в каком прогоне сделано действие.
  //
  // Поля опциональны ПО ОТСУТСТВИЮ КЛЮЧА, а не по null: искать действия прогона придётся
  // контейнмент-пробой `metadata @> {"actions":[{"run_id": …}]}` (единственный предикат,
  // который берёт jsonb-индекс). Запись `"run_id": null` у владельческих действий сделала
  // бы такую пробу ложно-положительной для проб вида `{"run_id": null}` и раздула бы
  // каждую строку журнала двумя пустыми ключами.
  test('10. actorGrantId/runId одиночного вызова: поля в action, контейнмент-проба находит; без них ключей НЕТ', async () => {
    const agentUser = freshUserId();
    const grantId = newId();
    const runId = newId();
    ok(
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

    const agentThread = globalThreadId(agentUser);
    const action = first(actionsOf(first(await messagesInThread(agentThread))));
    expect(action.actor_grant_id).toBe(grantId);
    expect(action.run_id).toBe(runId);

    // ровно та проба, которой действия прогона ищутся по журналу
    const byRun = await adminCount(
      sql`SELECT count(*)::int AS n FROM chat_messages
          WHERE thread_id = ${agentThread}
            AND metadata @> ${JSON.stringify({ actions: [{ run_id: runId }] })}::jsonb`,
    );
    expect(byRun).toBe(1);

    // владельческий путь: ключей нет вовсе — иначе пробы по грантам/прогонам ловили бы
    // и действия, сделанные руками владельца
    const ownerUser = freshUserId();
    ok(
      await execute(db, req(ownerUser, 'entity_create', { title: 'Своими руками', tags: [] }), {
        sink,
      }),
    );
    const ownAction = first(actionsOf(first(await messagesInThread(globalThreadId(ownerUser)))));
    expect(ownAction).not.toHaveProperty('actor_grant_id');
    expect(ownAction).not.toHaveProperty('run_id');
  });

  test('11. batch: грант и прогон попадают в ОБЩИЙ action пакета (§7.8 — один action на batch)', async () => {
    const user = freshUserId();
    const batchId = newId();
    const grantId = newId();
    const runId = newId();
    ok(
      await execute(
        db,
        {
          actorUserId: user,
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
    const action = first(actionsOf(first(await messagesInThread(globalThreadId(user)))));
    expect(action.type).toBe('batch');
    expect(action.actor_grant_id).toBe(grantId);
    expect(action.run_id).toBe(runId);
  });
});
