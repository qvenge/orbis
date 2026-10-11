import { afterAll, describe, expect, test } from 'bun:test';
import { type GraphId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { legacyAction, seedJournal1v } from '../../test/journal-1v-world';
import {
  journalEntitiesOf,
  journalOf,
  undoRecordOf,
  wholeJournalOf,
} from '../../test/journal-helpers';
import {
  legacyBatchMessageId,
  writeLegacyAction,
  writeLegacyUndo,
} from '../../test/legacy-journal';
import { findLastUndoable } from '../executor/journal-read';
import type { ActionRecord } from '../executor/types';
import { undoAction } from '../executor/undo';
import { threadPage } from '../journal/thread-page';
import { transferJournal } from '../journal/transfer';
import { rejectedReason } from '../policy/pending';
import { addSupplyRecord, listUpdates } from '../supply/mechanism';
import { supplyRecordId } from '../supply/records';
import {
  applyMigrateSpeedA,
  type MigrateSpeedAIo,
  migrateSpeedAIo,
  reportMigrateSpeedA,
  runMigrateSpeedA,
} from './migrate-speed-a';
import { withIdentity } from './with-identity';

requireEnv();
const { db, client } = appDb();
const { db: admin, client: pool } = adminDb();
afterAll(async () => {
  await client.end();
  await pool.end();
});
async function bodies(g: GraphId) {
  return pool`SELECT id::text, body, body_action_id::text, body_revision, body_changed_at::text,
    updated_at::text FROM entities WHERE graph_id = ${g} ORDER BY id`;
}
async function counts(g: GraphId) {
  return pool`SELECT (SELECT count(*) FROM action_journal WHERE graph_id = ${g})::int AS journal,
    (SELECT count(*) FROM action_journal_entities WHERE graph_id = ${g})::int AS sides,
    (SELECT count(*) FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE t.graph_id=${g})::int AS messages`;
}
async function messageIds(g: GraphId) {
  return (
    await pool`SELECT m.id::text FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id
    WHERE t.graph_id=${g} ORDER BY m.id`
  ).map((r) => r.id as string);
}
function ioFor(g: GraphId, patch: Partial<MigrateSpeedAIo> = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  const io: MigrateSpeedAIo = {
    readDsn: () => {
      throw new Error('Ключница не должна читаться');
    },
    rehearsalDsn: () => 'postgres://x@127.0.0.1:54322/postgres',
    open: () => ({ db: admin, sql: pool, close: async () => {} }),
    identities: async () => [personal(g)],
    log: (l) => lines.push(l),
    error: (l) => errors.push(l),
    ...patch,
  };
  return { io, lines, errors };
}
const apply = (g: GraphId, sweepMessages = false, beforeSweep?: () => Promise<void>) =>
  applyMigrateSpeedA(admin, pool, personal(g), { sweepMessages, beforeSweep });
async function oldWrite(g: GraphId, a: ActionRecord) {
  return withIdentity(db, personal(g), (tx) =>
    writeLegacyAction(tx, {
      graphId: g,
      action: a,
      card: { tool: 'entity_update', entity_id: a.entity_id, title: 'Допись старого кода' },
    }),
  );
}
describe('migrate-speed-a: перенос до плана А', () => {
  test('report считает прежний журнал и не пишет; неполные и повторные отмены дают STOP', async () => {
    const g = await freshGraph();
    const f = await seedJournal1v(g);
    const before = { counts: await counts(g), bodies: await bodies(g), ids: await messageIds(g) };
    expect(await reportMigrateSpeedA(pool, g)).toEqual({
      graph: g,
      legacyActions: 7,
      legacyUndo: 1,
      alreadyInTable: 0,
      seedable: 1,
      staleProposals: [f.pending],
      missingRequired: 0,
    });
    const { io } = ioFor(g);
    expect(await runMigrateSpeedA(['--report', '--rehearsal'], io)).toBe(0);
    expect({ counts: await counts(g), bodies: await bodies(g), ids: await messageIds(g) }).toEqual(
      before,
    );
    const { actor_kind: _kind, ...broken } = legacyAction(g);
    await oldWrite(g, broken as ActionRecord);
    expect((await reportMigrateSpeedA(pool, g)).missingRequired).toBe(1);
    const malformedBefore = await counts(g);
    expect(await runMigrateSpeedA(['--apply', '--i-understand', '--rehearsal'], io)).toBe(1);
    expect(await counts(g)).toEqual(malformedBefore);
    await oldWrite(g, { ...legacyAction(g), id: 'не-uuid' });
    await withIdentity(db, personal(g), (tx) =>
      writeLegacyUndo(tx, {
        threadId: f.threads.global,
        undoes: f.actions.undone.id,
        createdAt: new Date('2026-09-29T00:00:00Z'),
      }),
    );
    expect((await reportMigrateSpeedA(pool, g)).missingRequired).toBe(3);
    await expect(apply(g, true)).rejects.toThrow('непереносимых');
    expect((await counts(g))[0]?.journal).toBe(0);
  });
  test('первый apply сохраняет сообщения; засев не меняет текст/ревизию/время; старое предложение stale', async () => {
    const g = await freshGraph();
    const f = await seedJournal1v(g);
    const before = await bodies(g);
    const ids = await messageIds(g);
    const originalPending = await pool`SELECT metadata FROM chat_messages WHERE id=${f.pending}`;
    const first = await apply(g);
    expect((await messageIds(g)).filter((id) => ids.includes(id))).toEqual(ids);
    expect((await bodies(g)).find((r) => r.id === f.foreign)?.body_action_id).toBeNull();
    expect(first).toEqual({
      moved: 7,
      undo: 1,
      deletedMessages: 0,
      seeded: 1,
      closedProposals: [f.pending],
    });
    for (const a of Object.values(f.actions)) {
      const row = await journalOf(g, a.id);
      expect(row?.id).toBe(a.id);
      expect(row?.operations).toEqual(a.operations);
      expect(row?.bodyBefore).toBeNull();
    }
    expect((await journalOf(g, f.actions.equal.id))?.threadId).toBeNull();
    expect((await journalOf(g, f.actions.system.id))?.threadId).toBeNull();
    expect((await journalOf(g, f.actions.fast.id))?.threadId).toBe(f.threads.global);
    expect((await journalOf(g, f.actions.routine.id))?.threadId).toBe(f.threads.run);
    expect(f.messages).toContain(legacyBatchMessageId(g, f.actions.system.id));
    expect(await journalEntitiesOf(g, f.actions.equal.id)).toEqual([f.equal]);
    const undone = await undoRecordOf(g, f.actions.undone.id);
    expect([undone?.id, undone?.type, undone?.source, undone?.undoes, undone?.inverse]).toEqual([
      f.undoMessage,
      'undo',
      'ui',
      f.actions.undone.id,
      [],
    ]);
    const after = await bodies(g);
    expect(after.find((r) => r.id === f.equal)?.body_action_id).toBe(f.actions.equal.id);
    expect(after.find((r) => r.id === f.foreign)?.body_action_id).toBeNull();
    expect(after.map(({ body_action_id: _id, ...r }) => r)).toEqual(
      before.map(({ body_action_id: _id, ...r }) => r),
    );
    expect((await messageIds(g)).filter((id) => ids.includes(id))).toEqual(ids);
    expect(await withIdentity(db, personal(g), (tx) => rejectedReason(tx, f.pending))).toBe(
      'stale',
    );
    const currentPending = await pool`SELECT metadata FROM chat_messages WHERE id=${f.pending}`;
    expect(currentPending).toEqual(originalPending);
    const r = await reportMigrateSpeedA(pool, g);
    expect([r.alreadyInTable, r.seedable, r.staleProposals]).toEqual([8, 0, []]);
    expect(await apply(g)).toEqual({
      moved: 0,
      undo: 0,
      deletedMessages: 0,
      seeded: 0,
      closedProposals: [],
    });
  });
  test('перенесённое доступно отмене, карточке треда и повторному предложению поставки R-18', async () => {
    const g = await freshGraph();
    const f = await seedJournal1v(g);
    await apply(g);
    expect((await withIdentity(db, personal(g), (tx) => findLastUndoable(tx, g)))?.id).toBe(
      f.actions.routine.id,
    );
    const page = await withIdentity(db, personal(g), (tx) =>
      threadPage(tx, g, f.threads.global, { limit: 100 }),
    );
    expect(JSON.stringify(page)).toContain('Быстрый ввод');
    expect((await undoAction(db, { identity: personal(g), actionId: f.actions.equal.id })).ok).toBe(
      true,
    );
    expect((await bodies(g)).find((r) => r.id === f.equal)?.body).toBe('до');
    const refused = await undoAction(db, {
      identity: personal(g),
      actionId: f.actions.foreign.id,
      continuation: { kind: 'none' },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('UNDO_TEXT_CHANGED');
      expect(refused.error.details).toMatchObject({ continuation: { kind: 'none' } });
    }
    expect(
      (await undoAction(db, { identity: personal(g), actionId: f.actions.supply.id })).ok,
    ).toBe(true);
    expect(
      (await listUpdates({ db, identity: personal(g) })).some(
        (u) => u.key === 'records' && u.kind === 'new',
      ),
    ).toBe(true);
    await addSupplyRecord({ db, identity: personal(g) }, 'records');
    expect((await bodies(g)).filter((r) => r.id === supplyRecordId(g, 'records'))).toHaveLength(1);
  });
  test('sweep только перенесённое: допись между переносом и удалением переживает проход, третий нулевой', async () => {
    const g = await freshGraph();
    const f = await seedJournal1v(g);
    await apply(g);
    const extra = legacyAction(g);
    const extraMessage = await oldWrite(g, extra);
    const racing = legacyAction(g);
    let raceMessage = '';
    const second = await apply(g, true, async () => {
      raceMessage = await oldWrite(g, racing);
    });
    expect(await messageIds(g)).toContain(raceMessage);
    expect(second).toEqual({
      moved: 1,
      undo: 0,
      deletedMessages: 9,
      seeded: 0,
      closedProposals: [],
    });
    expect(await messageIds(g)).toContain(f.conversation);
    expect(await messageIds(g)).toContain(raceMessage);
    expect(await messageIds(g)).not.toContain(extraMessage);
    expect(await journalOf(g, racing.id)).toBeUndefined();
    expect(await apply(g, true)).toEqual({
      moved: 1,
      undo: 0,
      deletedMessages: 1,
      seeded: 0,
      closedProposals: [],
    });
    expect(await apply(g, true)).toEqual({
      moved: 0,
      undo: 0,
      deletedMessages: 0,
      seeded: 0,
      closedProposals: [],
    });
    expect((await reportMigrateSpeedA(pool, g)).legacyActions).toBe(0);
  });
  test('засев: последняя операция пачки, отменённая правка, ненулевая колонка и чужой граф', async () => {
    const g = await freshGraph();
    const f = await seedJournal1v(g);
    const batch = legacyAction(g, {
      type: 'batch',
      operations: [
        { op: 'entity_update', payload: { id: f.equal, body: 'не после' } },
        { op: 'entity_update', payload: { id: f.equal, body: 'после' } },
      ],
    });
    await oldWrite(g, batch);
    expect((await reportMigrateSpeedA(pool, g)).seedable).toBe(1);
    expect((await apply(g)).seeded).toBe(1);
    expect((await bodies(g)).find((r) => r.id === f.equal)?.body_action_id).toBe(batch.id);
    const fixed = newId();
    await admin.execute(
      sql`UPDATE entities SET body_action_id=${fixed}::uuid WHERE id=${f.equal}::uuid`,
    );
    expect((await apply(g)).seeded).toBe(0);
    expect((await bodies(g)).find((r) => r.id === f.equal)?.body_action_id).toBe(fixed);
    const other = await freshGraph();
    const of = await seedJournal1v(other);
    await admin.execute(sql`UPDATE entities SET body_action_id=NULL WHERE id=${f.equal}::uuid`);
    await withIdentity(db, personal(g), (tx) =>
      writeLegacyUndo(tx, { threadId: f.threads.global, undoes: batch.id }),
    );
    expect((await reportMigrateSpeedA(pool, g)).seedable).toBe(1);
    await apply(g);
    expect((await bodies(g)).find((r) => r.id === f.equal)?.body_action_id).toBe(
      f.actions.equal.id,
    );
    expect((await wholeJournalOf(other)).length).toBe(0);
    expect(
      await withIdentity(db, personal(other), (tx) => rejectedReason(tx, of.pending)),
    ).toBeUndefined();
  });
  test('отчёт не принимает чужой отказ того же pendingId; снятие под RLS идёт после admin commit', async () => {
    const g = await freshGraph();
    const f = await seedJournal1v(g);
    const other = await freshGraph();
    const foreign = await seedJournal1v(other);
    await pool`INSERT INTO chat_messages (id,thread_id,role,content,metadata)
      VALUES (${newId()},${foreign.threads.global},'system','чужой отказ',
        ${JSON.stringify({ type: 'confirmation_rejected', rejects: f.pending, reason: 'owner' })}::jsonb)`;
    expect((await reportMigrateSpeedA(pool, g)).staleProposals).toEqual([f.pending]);
    // Только вторую транзакцию блокируем: commit переноса остаётся и честно виден для повторного вызова.
    const failedDb = {
      transaction: async () => {
        throw new Error('отказ второго соединения');
      },
    } as unknown as typeof db;
    await expect(
      applyMigrateSpeedA(failedDb, pool, personal(g), { sweepMessages: false }),
    ).rejects.toThrow('отказ второго соединения');
    expect((await counts(g))[0]?.journal).toBe(8);
    expect(
      await withIdentity(db, personal(g), (tx) => rejectedReason(tx, f.pending)),
    ).toBeUndefined();
    expect(await apply(g)).toEqual({
      moved: 0,
      undo: 0,
      deletedMessages: 0,
      seeded: 0,
      closedProposals: [f.pending],
    });
    expect(await withIdentity(db, personal(other), (tx) => rejectedReason(tx, f.pending))).toBe(
      'owner',
    );
    expect(
      await withIdentity(db, personal(other), (tx) => rejectedReason(tx, foreign.pending)),
    ).toBeUndefined();
  });
  test('UUID в операциях без чувствительности к регистру; последняя запись отменена ещё до переноса', async () => {
    const g = await freshGraph();
    const f = await seedJournal1v(g);
    const upper = legacyAction(g, {
      type: 'batch',
      operations: [
        { op: 'entity_update', payload: { id: f.equal, body: 'не после' } },
        { op: 'entity_update', payload: { id: f.equal.toUpperCase(), body: 'после' } },
      ],
    });
    await oldWrite(g, upper);
    expect((await reportMigrateSpeedA(pool, g)).seedable).toBe(1);
    expect((await apply(g)).seeded).toBe(1);
    expect((await bodies(g)).find((r) => r.id === f.equal)?.body_action_id).toBe(upper.id);
    const untransferred = await freshGraph();
    const uf = await seedJournal1v(untransferred);
    const latest = legacyAction(untransferred, {
      operations: [{ op: 'entity_update', payload: { id: uf.equal, body: 'не после' } }],
    });
    await oldWrite(untransferred, latest);
    await withIdentity(db, personal(untransferred), (tx) =>
      writeLegacyUndo(tx, { threadId: uf.threads.global, undoes: latest.id }),
    );
    expect((await reportMigrateSpeedA(pool, untransferred)).seedable).toBe(1);
    expect((await apply(untransferred)).seeded).toBe(1);
    expect((await bodies(untransferred)).find((r) => r.id === uf.equal)?.body_action_id).toBe(
      uf.actions.equal.id,
    );
  });
  test.each([
    { type: 'batch' as const, undone: false, uppercase: false },
    { type: 'action' as const, undone: true, uppercase: true },
  ])('исполненное старым кодом предложение не планируется к снятию до переноса: %j', async ({
    type,
    undone,
    uppercase,
  }) => {
    const g = await freshGraph();
    const f = await seedJournal1v(g);
    await oldWrite(g, legacyAction(g, { id: f.pending, type, source: 'routine' }));
    if (undone)
      await withIdentity(db, personal(g), (tx) =>
        writeLegacyUndo(tx, { threadId: f.threads.run, undoes: f.pending }),
      );
    if (uppercase)
      await pool`UPDATE chat_messages
        SET metadata=jsonb_set(metadata,'{pending,id}',to_jsonb(${f.pending.toUpperCase()}::text)) WHERE id=${f.pending}`;
    const before = await counts(g);
    expect((await reportMigrateSpeedA(pool, g)).staleProposals).toEqual([]);
    expect(await counts(g)).toEqual(before);
    expect((await apply(g)).closedProposals).toEqual([]);
    expect(
      await withIdentity(db, personal(g), (tx) => rejectedReason(tx, f.pending)),
    ).toBeUndefined();
  });
  test('прогноз исполнения: текущий nonbatch сильнее legacybatch, чужой граф не исполняет own pending', async () => {
    const g = await freshGraph();
    const f = await seedJournal1v(g);
    const other = await freshGraph();
    await seedJournal1v(other);
    await oldWrite(other, legacyAction(other, { id: f.pending, type: 'batch' }));
    expect((await reportMigrateSpeedA(pool, g)).staleProposals).toEqual([f.pending]);
    await oldWrite(g, legacyAction(g, { id: f.pending, type: 'entity_updated' }));
    await withIdentity(db, personal(g), (tx) => transferJournal(tx, g));
    await oldWrite(g, legacyAction(g, { id: f.pending, type: 'batch' }));
    const before = await counts(g);
    expect((await reportMigrateSpeedA(pool, g)).staleProposals).toEqual([f.pending]);
    expect(await counts(g)).toEqual(before);
    expect((await apply(g)).closedProposals).toEqual([f.pending]);
    expect(await withIdentity(db, personal(g), (tx) => rejectedReason(tx, f.pending))).toBe(
      'stale',
    );
  });
  test('прогноз: первое legacy действие одного id; табличная строка сильнее дубля; partial transfer', async () => {
    const g = await freshGraph();
    const f = await seedJournal1v(g);
    const same = legacyAction(g, {
      operations: [{ op: 'entity_update', payload: { id: f.equal, body: 'не после' } }],
    });
    await oldWrite(g, same);
    await oldWrite(g, {
      ...same,
      operations: [{ op: 'entity_update', payload: { id: f.equal, body: 'после' } }],
    });
    expect((await reportMigrateSpeedA(pool, g)).seedable).toBe(0);
    expect((await apply(g)).seeded).toBe(0);
    await admin.execute(sql`UPDATE entities SET body='не после' WHERE id=${f.equal}::uuid`);
    expect((await reportMigrateSpeedA(pool, g)).seedable).toBe(1);
    expect((await apply(g)).seeded).toBe(1);
    expect((await bodies(g)).find((r) => r.id === f.equal)?.body_action_id).toBe(same.id);
    await oldWrite(g, legacyAction(g));
    expect((await reportMigrateSpeedA(pool, g)).alreadyInTable).toBe(9);
    expect((await apply(g)).moved).toBe(1);
  });
});
describe('CLI и боевой IO: подтверждение до DSN, только локальная репетиция', () => {
  test.each(
    [
      [],
      ['--rehearsal'],
      ['--apply'],
      ['--rehearsal', '--apply'],
      ['--report', '--apply'],
      ['--report', '--sweep-messages'],
      ['--report', '--i-understand'],
      ['--what'],
      ['--drop-agenda-rows', '--i-understand'],
      ['--undo', '00000000-0000-0000-0000-000000000001', '--i-understand'],
    ].map((args) => ({ args })),
  )('отказ до любого IO: %j', async ({ args }) => {
    let touched = 0;
    const errors: string[] = [];
    const forbidden = () => {
      touched += 1;
      throw new Error('IO запрещён');
    };
    const io = {
      readDsn: forbidden,
      rehearsalDsn: forbidden,
      open: forbidden,
      identities: forbidden,
      log: forbidden,
      error: (l: string) => errors.push(l),
    } as MigrateSpeedAIo;
    expect(await runMigrateSpeedA(args, io)).toBe(2);
    expect(touched).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
  });
  test('роль без BYPASSRLS отказывает до списка графов и любой записи', async () => {
    const g = await freshGraph();
    let listed = false;
    const before = await counts(g);
    const { io, errors } = ioFor(g, {
      open: () => ({ db, sql: client, close: async () => {} }),
      identities: async () => {
        listed = true;
        return [personal(g)];
      },
    });
    expect(await runMigrateSpeedA(['--rehearsal', '--apply', '--i-understand'], io)).toBe(1);
    expect(listed).toBe(false);
    expect(errors.join('')).toContain('BYPASSRLS');
    expect(await counts(g)).toEqual(before);
  });
  test('remote DSN и env без rehearsal не подключаются; localhost проходит боевую сборку', async () => {
    const g = await freshGraph();
    let opens = 0;
    let reads = 0;
    const a = ioFor(g, {
      readDsn: () => {
        reads++;
        throw new Error('prod запрещён');
      },
      rehearsalDsn: () => 'postgres://x@db.example.com/postgres',
      open: () => {
        opens++;
        return { db: admin, sql: pool, close: async () => {} };
      },
    });
    expect(await runMigrateSpeedA(['--rehearsal', '--report'], a.io)).toBe(2);
    expect(a.errors.join('\n')).toContain('репетиция — только локальная база');
    expect(await runMigrateSpeedA(['--report'], a.io)).toBe(2);
    expect([opens, reads]).toEqual([0, 0]);
    const logs: string[] = [];
    const actual = migrateSpeedAIo({
      readDsn: () => {
        reads++;
        throw new Error('prod запрещён');
      },
      env: { ORBIS_REHEARSAL_DSN: process.env.DATABASE_URL_ADMIN },
      openSql: () => {
        opens++;
        return pool;
      },
      log: (l) => logs.push(l),
      error: (l) => logs.push(l),
    });
    actual.open = ((open) => (dsn) => ({ ...open(dsn), close: async () => {} }))(actual.open);
    actual.identities = async () => [personal(g)];
    expect(await runMigrateSpeedA(['--rehearsal', '--report'], actual)).toBe(0);
    expect(
      await runMigrateSpeedA(
        ['--rehearsal', '--apply', '--i-understand', '--sweep-messages'],
        actual,
      ),
    ).toBe(0);
    expect([opens, reads]).toEqual([2, 0]);
  });
});
