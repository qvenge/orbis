import { afterAll, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import postgres from 'postgres';
import { makeDb } from '../src/db/client';
import { appRouter } from '../src/router';
import { freshGraph, personal } from './helpers';

for (const [key, user] of [['DATABASE_URL_ADMIN', 'supabase_admin'], ['DATABASE_URL', 'orbis_app']]) {
  const url = new URL(process.env[key] ?? '');
  if (url.hostname !== '127.0.0.1' || url.port !== '54342' || url.username !== user ||
      url.pathname !== '/postgres') throw new Error('fixture must use dedicated source');
}
const admin = postgres(process.env.DATABASE_URL_ADMIN!, { max: 1 });
const { db, client } = makeDb();
afterAll(async () => { await Promise.all([admin.end(), client.end()]); });

test('synthetic source business and old XID witness for logical restore', async () => {
  const [identity] = await admin<{ system_id: string }[]>`select system_identifier::text as system_id from pg_control_system()`;
  expect(identity?.system_id).toBe('7704502930497941539');
  const a = await freshGraph();
  const b = await freshGraph();
  const owner = (graph: typeof a) => appRouter.createCaller({
    identity: personal(graph), actorKind: 'owner', db, clientVersion: '0.7.0',
  });
  const ca = owner(a), cb = owner(b);
  await ca.user.seedOnboarding();
  await cb.user.seedOnboarding();
  const record = await ca.entity.create({ source: 'ui', input: { title: 'Restore A', tags: [], body: 'Synthetic source body' } });
  const sibling = await ca.entity.create({ source: 'ui', input: { title: 'Restore A sibling', tags: [] } });
  const foreign = await cb.entity.create({ source: 'ui', input: { title: 'Restore B', tags: [], body: 'Synthetic foreign graph' } });
  const relation = await ca.relation.create({ source_id: record.id, target_id: sibling.id, role: 'dependency' });
  const thread = await ca.chat.openThread({ entityId: record.id });
  const message = await ca.chat.appendUserMessage({ id: newId(), threadId: thread.threadId, content: 'Synthetic restored message' });
  const body = await ca.entity.update({ id: record.id, body: 'Synthetic updated body', expectedBodyRevision: record.bodyRevision, autosave: true });
  const version = await ca.version.pin({ entityId: record.id, label: 'Synthetic version' });
  expect(body.bodyRevision).toBe(record.bodyRevision + 1);
  for (let i = 0; i < 4096; i++) await admin`select pg_current_xact_id()`;

  const expiry = await ca.entity.update({ id: sibling.id, body: 'Synthetic expired event', expectedBodyRevision: sibling.bodyRevision, autosave: true });
  expect(expiry.txId).toMatch(/^\d+$/);
  const migration = await Bun.file(new URL('../src/db/migrations/0027_change_feed.sql', import.meta.url)).text();
  const command = migration.split('$job$')[1]?.trim();
  const jobs = await admin<{ command: string; username: string }[]>`select command, username from cron.job where jobname='orbis_change_feed_cleanup'`;
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.command.trim()).toBe(command);
  expect(jobs[0]?.username).toBe('supabase_admin');
  const aged = await admin`update public.change_feed set at=now()-interval '8 days' where tx_id=${expiry.txId!}::xid8 and kind='entity' and row_key=${sibling.id} returning id`;
  expect(aged).toHaveLength(1);
  await admin.unsafe(jobs[0]!.command);
  const [floor] = await admin<{ floor: string }[]>`select floor::text from public.change_feed_floor`;
  expect(BigInt(floor!.floor)).toBe(BigInt(expiry.txId!) + 1n);

  const recent = await ca.entity.update({ id: record.id, body: 'Synthetic recent body', expectedBodyRevision: body.bodyRevision, autosave: true });
  const latest = await ca.changes.reconcile({ from: floor!.floor });
  expect(latest.transactions.some(({ txId }) => txId === recent.txId)).toBe(true);
  expect(BigInt(latest.watermark)).toBeGreaterThan(BigInt(floor!.floor));
  console.log('RESTORE_WITNESS ' + JSON.stringify({
    a, b, record: record.id, sibling: sibling.id, foreign: foreign.id, relation: relation.id,
    thread: thread.threadId, message: message.id, bodyRevision: recent.bodyRevision,
    bodyActionId: recent.actionId, version: version.id, versionActionId: version.actionId,
    expiredXid: expiry.txId, recentXid: recent.txId, sourceFloor: floor!.floor, sourceCursor: latest.watermark,
  }));
}, 30_000);
