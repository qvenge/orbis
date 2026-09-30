// apps/server/src/executor/undo-rule.test.ts
// Единое правило отмены текста (спека скорости §8.6, §7.5 п. 3, §13.1; К-12, К-18, К-20, К-21, К-30, К-37, К-45;
// Р-15; план А задача 10). Отмена, пишущая тело, проверяет по цепочке «действие тела до» (с раскруткой через отмены),
// что текст записи не менялся после отменяемого действия; иначе — отказ ВСЕГО действия с перечнем записей и
// продолжением «Всё равно отменить», которое закрепляет текущий текст версией первой операцией той же записи отмены.
// Отмена сеанса правки текста страхует текущий текст версией «перед возвратом к ЧЧ:ММ» любым путём.
//
// Владелец — роутером (`ai.undo`, `entity.update` с автосохранением, `entity.updateBatch`); агент — `execute` с
// `actorKind: 'agent'`, `source: 'mcp'` и грантом. Провод (`data.orbis`) — HTTP-обработчиком, как в бою: caller отдаёт
// ошибку до `errorFormatter`. Время для подписей — прямой установкой отметок журнала под админом (`placeAt`): время
// записи журнала ставит база, часов запроса она не знает (то же, что в `text-session.test.ts`).
import { afterAll, describe, expect, test } from 'bun:test';
import { type GraphId, newId } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { actionsOf, journalOf, undoRecordOf } from '../../test/journal-helpers';
import { withIdentity } from '../db/with-identity';
import { approvePending, createPending, rejectPending, rejectPendingTx } from '../policy/pending';
import { appRouter } from '../router';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';
import { execute } from './executor';
import { makeJournalSink } from './journal';
import type { JournalEntry } from './journal-read';
import type { ExecuteResult } from './types';
import { undoAction } from './undo';

requireEnv();

const { db, client } = appDb();
const admin = adminDb();
const sink = makeJournalSink();
const createCaller = createCallerFactory(appRouter);
/** Грант агента — только атрибуция записи журнала (внешнего ключа у колонки нет). */
const GRANT = newId();

afterAll(async () => {
  await client.end();
  await admin.client.end();
});

type Caller = ReturnType<typeof createCaller>;

function callerFor(g: GraphId): Caller {
  return createCaller({ identity: personal(g), actorKind: 'owner', db, clientVersion: null });
}

function ok(r: ExecuteResult): Extract<ExecuteResult, { ok: true }> {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

/** Исходная структурированная ошибка исполнителя — в `cause` TRPCError. */
const causeOf = (e: TRPCError) =>
  e.cause as unknown as { code: string; details?: Record<string, unknown> };

interface Row {
  title: string;
  body: string;
  rev: number;
  raw: string | null;
  changedAt: Date;
}

/** Запись и колонки тела — сырым SELECT'ом под админом: колонки пишет триггер, проверять их надо мимо кода чтения. */
async function rowOf(id: string): Promise<Row> {
  const rows = (await admin.db.execute(sql`
    SELECT title, body, body_revision, body_action_id::text AS raw, body_changed_at
      FROM entities WHERE id = ${id}::uuid`)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (row === undefined) throw new Error(`записи ${id} нет`);
  return {
    title: row.title as string,
    body: row.body as string,
    rev: row.body_revision as number,
    raw: (row.raw as string | null) ?? null,
    changedAt: new Date(String(row.body_changed_at)),
  };
}

/** Закреплённые версии записи по времени — id, подпись и снятый текст (тела в `version.list` нет). */
async function versionsOf(
  entityId: string,
): Promise<Array<{ id: string; label: string; body: string }>> {
  return (await admin.db.execute(sql`
    SELECT id::text AS id, label, body FROM entity_versions
     WHERE entity_id = ${entityId}::uuid ORDER BY created_at, id`)) as unknown as Array<{
    id: string;
    label: string;
    body: string;
  }>;
}

/** Запись без журнала (сев с пустым синком): колонка тела пуста (К-34), журнал графа чист. */
async function seedNote(g: GraphId, title: string, body: string): Promise<string> {
  const id = newId();
  ok(
    await execute(db, {
      identity: personal(g),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_create', input: { id, title, tags: [], body } }],
    }),
  );
  return id;
}

/** Правки агента одним действием (MCP): тело — с ревизией, прочитанной сейчас; больше одной — пачка с подписью. */
async function agentEdit(
  g: GraphId,
  edits: Array<{ id: string; body?: string; title?: string }>,
  label = 'Правка агента',
): Promise<string> {
  const operations = [];
  for (const e of edits) {
    operations.push({
      tool: 'entity_update',
      input: {
        id: e.id,
        ...(e.title !== undefined && { title: e.title }),
        ...(e.body !== undefined && {
          body: e.body,
          expectedBodyRevision: (await rowOf(e.id)).rev,
        }),
      },
    });
  }
  const r = ok(
    await execute(
      db,
      {
        identity: personal(g),
        actorKind: 'agent',
        source: 'mcp',
        actorGrantId: GRANT,
        operations,
        ...(operations.length > 1 && { batchId: newId(), batchLabel: label }),
      },
      { sink },
    ),
  );
  return r.actionId;
}

/** Правка тела владельцем отдельным действием (пачка интерфейса — отдаёт id записи журнала). */
async function ownerEdit(g: GraphId, id: string, body: string, label: string): Promise<string> {
  const r = await callerFor(g).entity.updateBatch({
    label,
    operations: [
      { tool: 'entity_update', input: { id, body, expectedBodyRevision: (await rowOf(id)).rev } },
    ],
  });
  return r.actionId;
}

/** Автосохранение редактора владельца — сеанс правки текста (§8.5). */
async function autosave(g: GraphId, id: string, body: string): Promise<void> {
  await callerFor(g).entity.update({
    id,
    body,
    expectedBodyRevision: (await rowOf(id)).rev,
    autosave: true,
  });
}

async function mustJournal(g: GraphId, actionId: string): Promise<JournalEntry> {
  const e = await journalOf(g, actionId);
  if (e === undefined) throw new Error(`действия ${actionId} нет в журнале`);
  return e;
}

async function mustUndoRecord(g: GraphId, actionId: string): Promise<JournalEntry> {
  const e = await undoRecordOf(g, actionId);
  if (e === undefined) throw new Error(`у действия ${actionId} нет записи отмены`);
  return e;
}

/** Записи сеансов графа по времени. */
async function sessionsOf(g: GraphId): Promise<JournalEntry[]> {
  return (await actionsOf(g)).filter((e) => e.textSession);
}

/** «Прошло N минут» — отметки графа сдвигаются назад (как в `text-session.test.ts`): новый сеанс после паузы ≥ 10 мин. */
async function elapse(g: GraphId, minutes: number): Promise<void> {
  const shift = sql`(${minutes * 60_000}::int * interval '1 millisecond')`;
  await admin.db.execute(
    sql`UPDATE entities SET body_changed_at = body_changed_at - ${shift} WHERE graph_id = ${g}::uuid`,
  );
  await admin.db.execute(
    sql`UPDATE action_journal SET created_at = created_at - ${shift} WHERE graph_id = ${g}::uuid`,
  );
  await admin.db.execute(
    sql`UPDATE action_journal_entities SET created_at = created_at - ${shift} WHERE graph_id = ${g}::uuid`,
  );
}

/** Время записи журнала — точно (подписи «ЧЧ:ММ» во времени владельца; зона по умолчанию — Москва, UTC+3). */
async function placeAt(g: GraphId, actionId: string, at: Date): Promise<void> {
  await admin.db.execute(
    sql`UPDATE action_journal SET created_at = ${at.toISOString()}::timestamptz
         WHERE graph_id = ${g}::uuid AND id = ${actionId}::uuid`,
  );
}

const AT = (hhmm: string) => new Date(`2026-07-04T${hhmm}:00.000Z`);

/**
 * Процедура через HTTP-обработчик, как в бою: `data.orbis` кладёт `errorFormatter`, а caller отдаёт ошибку ДО
 * форматирования формы (та же причина, что в `routers/entity.test.ts`).
 */
async function postMutation(
  g: GraphId,
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
      identity: personal(g),
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

function chatCtx(g: GraphId) {
  return {
    db,
    identity: personal(g),
    actorKind: 'ai' as const,
    source: 'chat' as const,
    explicitCommand: false,
  };
}

/** Карточка отката (`undo_of`, В-8) — как её ставит «отмени последнее» модели, ушедшее в подтверждение. */
async function undoCard(g: GraphId, action: JournalEntry): Promise<string> {
  const { pendingId } = await withIdentity(db, personal(g), (tx) =>
    createPending(tx, {
      actor: { graphId: g, kind: 'ai', source: 'chat' },
      tool: 'batch_execute',
      input: {
        batch_id: newId(),
        operations: action.inverse.map((iv) => ({ tool: iv.op, input: iv.payload })),
      },
      summary: `Откат: «${action.title}»`,
      undoOf: action.id,
      level: 'explicit-confirmation',
    }),
  );
  return pendingId;
}

/** Агент правит тело заметки и заголовок соседней записи одним действием; владелец затем дописывает текст. */
async function agentThenOwner(g: GraphId) {
  const note = await seedNote(g, 'Заметка', 'исходный');
  const other = await seedNote(g, 'Соседняя', 'сосед');
  const a = await agentEdit(g, [
    { id: note, body: 'агент' },
    { id: other, title: 'Соседняя (агент)' },
  ]);
  await autosave(g, note, 'агент + владелец');
  return { note, other, a, action: await mustJournal(g, a) };
}

describe('правило отмены текста (§8.6): отказ всего действия и продолжение (Р-15)', () => {
  test('(а) агент правит тело, владелец дописывает → отмена агента: CONFLICT UNDO_TEXT_CHANGED с перечнем; текст владельца цел, ничего не применено', async () => {
    const g = await freshGraph();
    const { note, other, a, action } = await agentThenOwner(g);
    const before = await rowOf(note);

    const res = await postMutation(g, 'ai.undo', { actionId: a });
    expect(res.status).toBe(409);
    const data = res.body.error?.data ?? {};
    expect(data.code).toBe('CONFLICT');
    expect(data.orbis).toEqual({
      code: 'UNDO_TEXT_CHANGED',
      details: {
        action: { id: a, title: 'Правка агента' },
        entries: [
          {
            entityId: note,
            title: 'Заметка',
            actorKind: 'owner',
            actorLabel: null,
            at: before.changedAt.toISOString(),
          },
        ],
        continuation: { kind: 'here' },
      },
    });
    // Текстов записей на проводе нет — только заголовки
    expect(JSON.stringify(res.body)).not.toContain('агент + владелец');
    expect(action.title).toBe('Правка агента');

    // Текст владельца цел, записи отмены нет, ВСЁ действие не применено (К-21): заголовок соседней — агента
    expect(await rowOf(note)).toEqual(before);
    expect(await undoRecordOf(g, a)).toBeUndefined();
    expect((await rowOf(other)).title).toBe('Соседняя (агент)');
    expect(await versionsOf(note)).toEqual([]);
  });

  test('(б) продолжение `force` возвращает текст как до агента и закрепляет текст владельца версией первой операцией записи отмены; (п) запись отмены — владелец, путь `ui`, тред отменённого', async () => {
    const g = await freshGraph();
    const { note, other, a, action } = await agentThenOwner(g);

    const r = await callerFor(g).ai.undo({ actionId: a, force: true });
    expect((await rowOf(note)).body).toBe('исходный');
    expect((await rowOf(other)).title).toBe('Соседняя'); // всё действие отменено

    const versions = await versionsOf(note);
    expect(versions).toEqual([
      { id: expect.any(String), label: 'перед отменой: Правка агента', body: 'агент + владелец' },
    ]);
    const v = versions[0]?.id as string;
    const rec = await mustUndoRecord(g, a);
    expect(rec.operations[0]).toEqual({
      op: 'entity_version_pin',
      payload: { id: v, entity_id: note, label: 'перед отменой: Правка агента' },
    });
    // Остальные операции записи отмены — применённый inverse отменённого (аудит, К-45)
    expect(rec.operations.slice(1)).toEqual(action.inverse);
    expect(rec.pinnedVersionIds).toEqual([v]);
    expect(r).toEqual({
      actionId: rec.id,
      undone: { id: a, title: 'Правка агента' },
      pinnedVersions: [{ entityId: note, versionId: v, label: 'перед отменой: Правка агента' }],
    });
    // Соседняя запись проверку прошла бы и без продолжения — версии у неё нет
    expect(await versionsOf(other)).toEqual([]);

    // (п) К-45: актор — владелец, источник — путь (`ui` у кнопки), тред — тред отменённого
    expect(rec.actorKind).toBe('owner');
    expect(rec.actorUserId).toBe(personal(g).actor);
    expect(rec.source).toBe('ui');
    expect(action.threadId).not.toBeNull();
    expect(rec.threadId).toBe(action.threadId);
    expect(rec.inverse).toEqual([]);
  });

  test('(в) отмена сеанса правки текста после чужой правки → отказ; страховки нет (отказ откатывает всё)', async () => {
    const g = await freshGraph();
    const note = await seedNote(g, 'Заметка', 'до сеанса');
    await autosave(g, note, 'владелец');
    const s = (await sessionsOf(g))[0] as JournalEntry;
    await agentEdit(g, [{ id: note, body: 'агент' }]);

    const e = await trpcError(callerFor(g).ai.undo({ actionId: s.id }));
    expect(e.code).toBe('CONFLICT');
    expect(causeOf(e).code).toBe('UNDO_TEXT_CHANGED');
    expect(causeOf(e).details?.entries).toEqual([
      expect.objectContaining({ entityId: note, actorKind: 'agent', actorLabel: null }),
    ]);
    expect((await rowOf(note)).body).toBe('агент');
    expect(await versionsOf(note)).toEqual([]);
    expect(await undoRecordOf(g, s.id)).toBeUndefined();
  });

  test('(г) две пачки с телом одной записи: отмена B2, затем B1 — обе проходят (раскрутка через запись отмены B2)', async () => {
    const g = await freshGraph();
    const note = await seedNote(g, 'Заметка', 'исходный');
    const b1 = await ownerEdit(g, note, 'один', 'Жест 1');
    const b2 = await ownerEdit(g, note, 'два', 'Жест 2');
    const caller = callerFor(g);

    await caller.ai.undo({ actionId: b2 });
    expect((await rowOf(note)).body).toBe('один');
    const u2 = await mustUndoRecord(g, b2);
    expect((await rowOf(note)).raw).toBe(u2.id);
    await caller.ai.undo({ actionId: b1 });
    expect((await rowOf(note)).body).toBe('исходный');
    expect(await versionsOf(note)).toEqual([]);
  });

  test('(д) чужая правка между пачками: отмена B2 проходит, отмена B1 — отказ (перечень называет агента)', async () => {
    const g = await freshGraph();
    const note = await seedNote(g, 'Заметка', 'исходный');
    const b1 = await ownerEdit(g, note, 'один', 'Жест 1');
    await agentEdit(g, [{ id: note, body: 'агент' }]);
    const b2 = await ownerEdit(g, note, 'два', 'Жест 2');
    const caller = callerFor(g);

    await caller.ai.undo({ actionId: b2 });
    expect((await rowOf(note)).body).toBe('агент');
    const e = await trpcError(caller.ai.undo({ actionId: b1 }));
    expect(causeOf(e).code).toBe('UNDO_TEXT_CHANGED');
    expect(causeOf(e).details?.entries).toEqual([
      expect.objectContaining({ entityId: note, actorKind: 'agent' }),
    ]);
    expect((await rowOf(note)).body).toBe('агент');
    expect(await undoRecordOf(g, b1)).toBeUndefined();
  });
});

describe('правило отмены текста (§8.6): слияние свойства — по каждому держателю (К-30)', () => {
  async function mergeWorld(g: GraphId) {
    const property = async (key: string): Promise<string> =>
      (
        ok(
          await execute(
            db,
            {
              identity: personal(g),
              actorKind: 'owner',
              source: 'ui',
              operations: [
                {
                  tool: 'property_create',
                  input: {
                    key,
                    label: { ru: key },
                    description: { ru: 'поле слияния' },
                    type: { kind: 'number' },
                    status: 'active',
                  },
                },
              ],
            },
            { sink },
          ),
        ).results[0] as { property: string }
      ).property;
    const source = await property('user/effort');
    const into = await property('user/energy');
    const holders: string[] = [];
    for (const n of [1, 2, 3]) {
      holders.push(
        await seedNote(
          g,
          `Смарт-лист ${n}`,
          `Список ${n}\n\n{{query: aspect=orbis/task, user/effort=5}}`,
        ),
      );
    }
    const merged = ok(
      await execute(
        db,
        {
          identity: personal(g),
          actorKind: 'owner',
          source: 'ui',
          operations: [{ tool: 'property_merge', input: { source, into } }],
        },
        { sink },
      ),
    );
    for (const h of holders) expect((await rowOf(h)).raw).toBe(merged.actionId);
    return { holders, merge: merged.actionId };
  }

  test('(е) отмена слияния проходит; после набора владельца в теле ОДНОГО держателя — отказ ровно по нему; продолжение закрепляет одну версию только у него', async () => {
    const clean = await freshGraph();
    const w = await mergeWorld(clean);
    await callerFor(clean).ai.undo({ actionId: w.merge });
    for (const h of w.holders) expect((await rowOf(h)).body).toContain('user/effort=5');
    for (const h of w.holders) expect(await versionsOf(h)).toEqual([]);

    const g = await freshGraph();
    const { holders, merge } = await mergeWorld(g);
    const [h1, h2, h3] = holders as [string, string, string];
    await autosave(g, h2, 'Список 2 владельца\n\n{{query: aspect=orbis/task, user/energy=5}}');

    const e = await trpcError(callerFor(g).ai.undo({ actionId: merge }));
    expect(causeOf(e).code).toBe('UNDO_TEXT_CHANGED');
    expect(causeOf(e).details?.entries).toEqual([
      expect.objectContaining({ entityId: h2, title: 'Смарт-лист 2', actorKind: 'owner' }),
    ]);
    expect((await rowOf(h1)).body).toContain('user/energy=5'); // ничего не применено

    const r = await callerFor(g).ai.undo({ actionId: merge, force: true });
    const pinned = await versionsOf(h2);
    expect(pinned).toEqual([
      {
        id: expect.any(String),
        label: expect.stringMatching(/^перед отменой: /),
        body: expect.stringContaining('Список 2 владельца'),
      },
    ]);
    expect(await versionsOf(h1)).toEqual([]);
    expect(await versionsOf(h3)).toEqual([]);
    expect((await mustUndoRecord(g, merge)).pinnedVersionIds).toEqual([pinned[0]?.id as string]);
    expect(r.pinnedVersions.map((p) => p.entityId)).toEqual([h2]);
    for (const h of holders) expect((await rowOf(h)).body).toContain('user/effort=5');
  });

  test('(е′) набор владельца в двух держателях — перечень называет оба (не останавливается на первом)', async () => {
    const g = await freshGraph();
    const { holders, merge } = await mergeWorld(g);
    const [h1, , h3] = holders as [string, string, string];
    await autosave(g, h1, 'Список 1 владельца');
    await autosave(g, h3, 'Список 3 владельца');

    const e = await trpcError(callerFor(g).ai.undo({ actionId: merge }));
    const entries = causeOf(e).details?.entries as Array<{ entityId: string }>;
    expect(entries.map((x) => x.entityId).sort()).toEqual([h1, h3].sort());

    await callerFor(g).ai.undo({ actionId: merge, force: true });
    expect((await versionsOf(h1)).length).toBe(1);
    expect((await versionsOf(h3)).length).toBe(1);
    expect((await mustUndoRecord(g, merge)).pinnedVersionIds).toHaveLength(2);
  });
});

describe('правило отмены текста (§8.6): кого не касается', () => {
  test('(ж) отмена создания (архив) правилу не подлежит — проходит при любом тексте', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const created = await caller.entity.create({
      input: { title: 'Создана', tags: [], body: 'первый текст' },
      source: 'ui',
    });
    await autosave(g, created.id, 'владелец дописал');
    await caller.ai.undo({ actionId: created.actionId as string });
    const row = await rowOf(created.id);
    expect(row.body).toBe('владелец дописал');
    expect((await caller.entity.get({ id: created.id })).entity.archived).toBe(true);
    expect(await versionsOf(created.id)).toEqual([]);
  });

  test('(н) закрепление версии — запись журнала; её отмена удаляет версию', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const note = await seedNote(g, 'Заметка', 'текст');
    const v = await caller.version.pin({ entityId: note, label: 'моя версия' });
    const pin = (await actionsOf(g)).find((e) => e.type === 'version_pinned') as JournalEntry;
    expect(pin.operations[0]?.payload.id).toBe(v.id);
    await autosave(g, note, 'владелец дописал'); // тело закрепление не пишет — правило его не касается
    await caller.ai.undo({ actionId: pin.id });
    expect(await versionsOf(note)).toEqual([]);
  });

  test('(м) восстановление версии отменяется: отмена удаляет страховку «перед восстановлением …» и возвращает текст', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const note = await seedNote(g, 'Заметка', 'первая');
    const v1 = await caller.version.pin({ entityId: note, label: 'первая' });
    await ownerEdit(g, note, 'вторая', 'Правка');
    await caller.version.restore({
      versionId: v1.id,
      expectedBodyRevision: (await rowOf(note)).rev,
    });
    expect((await rowOf(note)).body).toBe('первая');
    expect((await versionsOf(note)).map((v) => v.label)).toEqual([
      'первая',
      'перед восстановлением: первая',
    ]);
    const restore = (await actionsOf(g)).find(
      (e) => e.title === 'Восстановлена версия «первая»',
    ) as JournalEntry;
    expect(restore.bodyBefore).toEqual({ [note]: expect.any(String) });

    await caller.ai.undo({ actionId: restore.id });
    expect((await rowOf(note)).body).toBe('вторая');
    expect((await versionsOf(note)).map((v) => v.label)).toEqual(['первая']);
  });
});

describe('отмена сеанса правки текста (§7.5 п. 3, К-20): страховка версией любым путём', () => {
  test('(з) возврат сеанса `ai.undo` закрепляет «перед возвратом к ЧЧ:ММ» первой операцией; «отмени последнее» после — версию не удаляет; bodyAction называет предыдущий сеанс', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const note = await seedNote(g, 'Заметка', 'до сеансов');
    await autosave(g, note, 'сеанс 1');
    await elapse(g, 11);
    await autosave(g, note, 'сеанс 2');
    const [s1, s2] = (await sessionsOf(g)) as [JournalEntry, JournalEntry];
    await placeAt(g, s1.id, AT('11:02'));
    await placeAt(g, s2.id, AT('11:40'));

    const before = await caller.entity.get({ id: note });
    expect(before.bodyAction).toEqual({
      actionId: s2.id,
      textSession: true,
      mine: true,
      actorKind: 'owner',
      startedAt: AT('11:40').toISOString(),
      endedAt: (await rowOf(note)).changedAt.toISOString(),
    });

    const r = await caller.ai.undo({ actionId: s2.id });
    expect((await rowOf(note)).body).toBe('сеанс 1');
    const [v] = await versionsOf(note);
    expect(v).toEqual({
      id: expect.any(String),
      label: 'перед возвратом к 14:40',
      body: 'сеанс 2',
    });
    const rec = await mustUndoRecord(g, s2.id);
    expect(rec.operations[0]).toEqual({
      op: 'entity_version_pin',
      payload: { id: v?.id, entity_id: note, label: 'перед возвратом к 14:40' },
    });
    expect(rec.pinnedVersionIds).toEqual([v?.id as string]);
    expect(r.pinnedVersions).toEqual([
      { entityId: note, versionId: v?.id as string, label: 'перед возвратом к 14:40' },
    ]);

    // Действующее действие после возврата — предыдущий сеанс этого же владельца (раскрутка), конца у него нет
    expect((await caller.entity.get({ id: note })).bodyAction).toEqual({
      actionId: s1.id,
      textSession: true,
      mine: true,
      actorKind: 'owner',
      startedAt: AT('11:02').toISOString(),
      endedAt: null,
    });

    // «Отмени последнее» сразу после: у записи отмены нет inverse — страховку оно не находит и не удаляет; следующим
    // оно возвращает более ранний сеанс (раскрутка через запись отмены S2) — и страхует уже его текст
    const last = await caller.ai.undoLast();
    expect(last.undone.actionId).toBe(s1.id);
    expect((await rowOf(note)).body).toBe('до сеансов');
    expect((await versionsOf(note)).map((x) => [x.label, x.body])).toEqual([
      ['перед возвратом к 14:40', 'сеанс 2'],
      ['перед возвратом к 14:02', 'сеанс 1'],
    ]);
    expect((await caller.entity.get({ id: note })).bodyAction).toBeNull();
  });

  test('(з) «отмени последнее» сразу после возврата сеанса страховку не удаляет: закрепление — внутри записи отмены, а не отдельным действием', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const other = await seedNote(g, 'Соседняя', '');
    await caller.entity.update({ id: other, title: 'Соседняя, переименована' }); // более раннее действие
    const note = await seedNote(g, 'Заметка', 'до сеанса');
    await autosave(g, note, 'сеанс');
    const s = (await sessionsOf(g))[0] as JournalEntry;
    await caller.ai.undo({ actionId: s.id });
    const insurance = (await versionsOf(note))[0];
    if (insurance === undefined) throw new Error('страховки нет');
    expect(insurance.body).toBe('сеанс');

    const last = await caller.ai.undoLast();
    expect(last.undone.title).toBe('Соседняя, переименована');
    expect((await rowOf(other)).title).toBe('Соседняя');
    expect(await versionsOf(note)).toEqual([insurance]);
  });

  test('(з) тот же возврат словами в чате (`undo_last`) и «Принять» карточки отката (`undo_of`) — страховка первой операцией', async () => {
    // «отмени последнее» модели — путь `chat`
    const g1 = await freshGraph();
    const n1 = await seedNote(g1, 'Заметка', 'до сеанса');
    await autosave(g1, n1, 'сеанс');
    const s1 = (await sessionsOf(g1))[0] as JournalEntry;
    await placeAt(g1, s1.id, AT('11:02'));
    const said = await dispatchTool(chatCtx(g1), 'undo_last', {});
    expect(said.status).toBe('ok');
    const rec1 = await mustUndoRecord(g1, s1.id);
    expect(rec1.source).toBe('chat');
    expect(rec1.operations[0]).toMatchObject({
      op: 'entity_version_pin',
      payload: { entity_id: n1, label: 'перед возвратом к 14:02' },
    });
    expect(await versionsOf(n1)).toEqual([
      { id: rec1.pinnedVersionIds[0] as string, label: 'перед возвратом к 14:02', body: 'сеанс' },
    ]);
    expect((await rowOf(n1)).body).toBe('до сеанса');

    // Карточка отката `undo_of` — «Принять» исполняет её undo-путём, страховка та же
    const g2 = await freshGraph();
    const n2 = await seedNote(g2, 'Заметка', 'до сеанса');
    await autosave(g2, n2, 'сеанс');
    const s2 = (await sessionsOf(g2))[0] as JournalEntry;
    await placeAt(g2, s2.id, AT('11:05'));
    const pendingId = await undoCard(g2, await mustJournal(g2, s2.id));
    const applied = await approvePending(db, { identity: personal(g2), pendingId });
    expect(applied.ok).toBe(true);
    const rec2 = await mustUndoRecord(g2, s2.id);
    expect(rec2.source).toBe('chat');
    expect(rec2.operations[0]).toMatchObject({
      op: 'entity_version_pin',
      payload: { entity_id: n2, label: 'перед возвратом к 14:05' },
    });
    expect(rec2.pinnedVersionIds).toHaveLength(1);
    expect((await rowOf(n2)).body).toBe('до сеанса');
  });

  test('(и) продолжение при отмене сеанса после чужой правки — ОДНА версия на запись (страховка сеанса, без второй)', async () => {
    const g = await freshGraph();
    const note = await seedNote(g, 'Заметка', 'до сеанса');
    await autosave(g, note, 'владелец');
    const s = (await sessionsOf(g))[0] as JournalEntry;
    await placeAt(g, s.id, AT('11:02'));
    await agentEdit(g, [{ id: note, body: 'агент' }]);

    const r = await callerFor(g).ai.undo({ actionId: s.id, force: true });
    expect((await rowOf(note)).body).toBe('до сеанса');
    const versions = await versionsOf(note);
    expect(versions).toEqual([
      { id: expect.any(String), label: 'перед возвратом к 14:02', body: 'агент' },
    ]);
    expect((await mustUndoRecord(g, s.id)).pinnedVersionIds).toEqual([versions[0]?.id as string]);
    expect(r.pinnedVersions).toHaveLength(1);
  });

  test('ответ правки (`entity.update`) несёт действующее действие тела — экран после своей правки запись не перечитывает (§8.2)', async () => {
    const g = await freshGraph();
    const caller = callerFor(g);
    const note = await seedNote(g, 'Заметка', 'до сеанса');
    const saved = await caller.entity.update({
      id: note,
      body: 'набор',
      expectedBodyRevision: (await rowOf(note)).rev,
      autosave: true,
    });
    const s = (await sessionsOf(g))[0] as JournalEntry;
    expect(saved.bodyAction).toEqual({
      actionId: s.id,
      textSession: true,
      mine: true,
      actorKind: 'owner',
      startedAt: s.createdAt.toISOString(),
      endedAt: (await rowOf(note)).changedAt.toISOString(),
    });
    // Правка заголовка тела не трогает — действующее действие прежнее
    const renamed = await caller.entity.update({ id: note, title: 'Новое имя' });
    expect(renamed.bodyAction?.actionId).toBe(s.id);
  });

  test('(л) сеанс из нескольких автосохранений (колонка = S) отменяется без продолжения', async () => {
    const g = await freshGraph();
    const note = await seedNote(g, 'Заметка', 'до сеанса');
    for (const text of ['раз', 'два', 'три']) await autosave(g, note, text);
    const s = (await sessionsOf(g))[0] as JournalEntry;
    expect(await sessionsOf(g)).toHaveLength(1);
    expect((await rowOf(note)).raw).toBe(s.id);
    await callerFor(g).ai.undo({ actionId: s.id });
    expect((await rowOf(note)).body).toBe('до сеанса');
    expect((await versionsOf(note)).map((v) => v.body)).toEqual(['три']);
  });
});

describe('правило отмены текста (§8.6): цепочка после продолжения и перенесённые записи', () => {
  test('(к) после продолжения по X при чужой Y: отмена Y отказывает, «действие тела до» записи отмены X = Y; второе продолжение по Y — с новой версией', async () => {
    const g = await freshGraph();
    const note = await seedNote(g, 'Заметка', 'исходный');
    const x = await agentEdit(g, [{ id: note, body: 'агент' }]);
    const y = await ownerEdit(g, note, 'владелец', 'Правка владельца');
    const caller = callerFor(g);

    await caller.ai.undo({ actionId: x, force: true });
    expect((await rowOf(note)).body).toBe('исходный');
    expect((await mustUndoRecord(g, x)).bodyBefore).toEqual({ [note]: y });

    const e = await trpcError(caller.ai.undo({ actionId: y }));
    expect(causeOf(e).code).toBe('UNDO_TEXT_CHANGED');

    await caller.ai.undo({ actionId: y, force: true });
    expect((await rowOf(note)).body).toBe('агент'); // текст до Y — текст агента
    // Текст снова дал X (его вернула отмена Y): раскрутка в середине цепочки останавливается на X, хоть он и отменён, —
    // прыжок через отменённое X к его «до» назвал бы действующим то, что текст не давало
    expect((await caller.entity.get({ id: note })).bodyAction).toMatchObject({
      actionId: x,
      actorKind: 'agent',
      mine: false,
      endedAt: null,
    });
    expect((await versionsOf(note)).map((v) => [v.label, v.body])).toEqual([
      ['перед отменой: Заметка', 'владелец'],
      ['перед отменой: Правка владельца', 'исходный'],
    ]);
  });

  test('(о) перенесённая запись (`body_before` NULL): колонка = её id → проходит; иначе — отказ с продолжением', async () => {
    const g = await freshGraph();
    const nullBefore = (id: string) =>
      admin.db.execute(
        sql`UPDATE action_journal SET body_before = NULL WHERE graph_id = ${g}::uuid AND id = ${id}::uuid`,
      );
    const n1 = await seedNote(g, 'Заметка 1', 'исходный');
    const x1 = await agentEdit(g, [{ id: n1, body: 'агент' }]);
    await nullBefore(x1);
    expect((await mustJournal(g, x1)).bodyBefore).toBeNull();
    await callerFor(g).ai.undo({ actionId: x1 });
    expect((await rowOf(n1)).body).toBe('исходный');

    const n2 = await seedNote(g, 'Заметка 2', 'исходный');
    const x2 = await agentEdit(g, [{ id: n2, body: 'агент' }]);
    await nullBefore(x2);
    await autosave(g, n2, 'владелец');
    const e = await trpcError(callerFor(g).ai.undo({ actionId: x2 }));
    expect(causeOf(e).code).toBe('UNDO_TEXT_CHANGED');
    const r = await callerFor(g).ai.undo({ actionId: x2, force: true });
    expect((await rowOf(n2)).body).toBe('исходный');
    expect(r.pinnedVersions.map((p) => p.entityId)).toEqual([n2]);

    // Именно СЫРАЯ колонка, а не раскрутка: правка после X3, отменённая, возвращает колонку записью отмены, чья
    // раскрутка дала бы X3, — но у перенесённой записи цепочки нет, и совпадения колонки нет (§8.6 «Записи до плана А»)
    const n3 = await seedNote(g, 'Заметка 3', 'исходный');
    const x3 = await agentEdit(g, [{ id: n3, body: 'агент' }]);
    await nullBefore(x3);
    const b = await ownerEdit(g, n3, 'владелец', 'Правка владельца');
    await callerFor(g).ai.undo({ actionId: b });
    expect((await rowOf(n3)).body).toBe('агент');
    const refused = await trpcError(callerFor(g).ai.undo({ actionId: x3 }));
    expect(causeOf(refused).code).toBe('UNDO_TEXT_CHANGED');
  });
});

describe('продолжение (Р-15): гонка между предпроверкой и транзакцией отмены', () => {
  test('запись, провалившая проверку только к транзакции (её нет среди закреплённых), останавливает продолжение отказом с новым перечнем', async () => {
    const g = await freshGraph();
    const n1 = await seedNote(g, 'Заметка 1', 'исходный 1');
    const n2 = await seedNote(g, 'Заметка 2', 'исходный 2');
    const a = await agentEdit(g, [
      { id: n1, body: 'агент 1' },
      { id: n2, body: 'агент 2' },
    ]);
    await autosave(g, n1, 'владелец 1'); // предпроверка продолжения закрепит только n1

    // Между предпроверкой и правилом (шов `beforeStages` транзакции отмены) текст n2 правит писатель без журнала —
    // своим соединением, до того как транзакция отмены возьмёт строки
    const r = await undoAction(
      db,
      { identity: personal(g), actionId: a, force: true, continuation: { kind: 'here' } },
      {
        beforeStages: async () => {
          await admin.db.execute(
            sql`UPDATE entities SET body = 'вне приложения' WHERE id = ${n2}::uuid`,
          );
        },
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UNDO_TEXT_CHANGED');
    const entries = (
      r.error.details as { entries: Array<{ entityId: string; actorLabel: string | null }> }
    ).entries;
    expect(entries.map((x) => x.entityId).sort()).toEqual([n1, n2].sort());
    expect(entries.find((x) => x.entityId === n2)?.actorLabel).toBe('вне приложения');
    // Ничего не применено: версий нет, текст владельца цел, записи отмены нет
    expect(await versionsOf(n1)).toEqual([]);
    expect((await rowOf(n1)).body).toBe('владелец 1');
    expect(await undoRecordOf(g, a)).toBeUndefined();
  });
});

describe('отмена: повтор и карточка отката', () => {
  test('(р) повторная отмена → BAD_REQUEST, data.orbis = {code: VALIDATION, details: {reason: already_undone}}', async () => {
    const g = await freshGraph();
    const note = await seedNote(g, 'Заметка', 'исходный');
    const x = await agentEdit(g, [{ id: note, body: 'агент' }]);
    await callerFor(g).ai.undo({ actionId: x });
    const res = await postMutation(g, 'ai.undo', { actionId: x });
    expect(res.status).toBe(400);
    expect(res.body.error?.data?.code).toBe('BAD_REQUEST');
    expect(res.body.error?.data?.orbis).toEqual({
      code: 'VALIDATION',
      details: { reason: 'already_undone' },
    });
  });

  test('(с) «Принять» у ОТКЛОНЁННОЙ карточки `undo_of` при изменённом тексте → «отклонено», не UNDO_TEXT_CHANGED', async () => {
    const g = await freshGraph();
    const note = await seedNote(g, 'Заметка', 'исходный');
    const x = await agentEdit(g, [{ id: note, body: 'агент' }]);
    await autosave(g, note, 'владелец'); // правило отказало бы
    const action = await mustJournal(g, x);

    // Отклонена до «Принять»
    const early = await undoCard(g, action);
    await rejectPending(db, { identity: personal(g), pendingId: early });
    const refused = await approvePending(db, { identity: personal(g), pendingId: early });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('VALIDATION');
    expect(refused.error.message).toContain('отклонено');

    // Отклонение легло, пока «Принять» уже шло: судьбу решает шов `beforeStages` транзакции отмены — он раньше
    // правила текста. Держим замок единицы транзакцией с отказом и отпускаем её, когда отмена ждёт этот замок.
    const late = await undoCard(g, action);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withIdentity(db, personal(g), async (tx) => {
      await rejectPendingTx(tx, { identity: personal(g), pendingId: late });
      await gate;
    });
    let settled = false;
    const approving = approvePending(db, { identity: personal(g), pendingId: late }).finally(() => {
      settled = true;
    });
    const deadline = Date.now() + 10_000;
    while (!settled && Date.now() < deadline) {
      const waiting = (await admin.db.execute(
        sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
      )) as unknown as Array<{ n: number }>;
      if ((waiting[0]?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    release();
    await holder;
    const r = await approving;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('VALIDATION');
    expect(r.error.message).toContain('отклонено');
    expect((await rowOf(note)).body).toBe('владелец');
    expect(await undoRecordOf(g, x)).toBeUndefined();
  }, 30_000);
});
