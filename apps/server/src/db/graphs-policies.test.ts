import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { appDb, freshGraph, personal, truncateAll } from '../../test/helpers';
import { withIdentity } from './with-identity';

const { db, client } = appDb(); // { db, client } — как во всех сьютах (образец: db/with-identity.test.ts:10)
let a: GraphId;
let b: GraphId;
beforeAll(async () => {
  await truncateAll();
  a = await freshGraph();
  b = await freshGraph();
});
afterAll(async () => {
  await truncateAll();
  await client.end(); // незакрытый пул держит прогон
});

const pgCode = (e: unknown): string | undefined =>
  (e as { code?: string; cause?: { code?: string } }).code ??
  (e as { cause?: { code?: string } }).cause?.code;

test('orbis_app без идентичности читает пары членства (тик планировщика), но не пишет их', async () => {
  const rows = await db.execute(sql`SELECT graph_id::text AS g FROM graph_members
    WHERE grant_kind = 'owner' AND revoked_at IS NULL`);
  expect(rows.map((r) => r.g)).toEqual(expect.arrayContaining([a, b]));
  let code: string | undefined;
  try {
    await db.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
      VALUES (gen_random_uuid(), ${a}::uuid, ${b}::uuid, 'owner', ${a}::uuid)`);
  } catch (e) {
    code = pgCode(e);
  }
  expect(code).toBe('42501');
});

test('под идентичностью аккаунт видит только своё членство и свой граф', async () => {
  const seen = await withIdentity(db, personal(a), async (tx) => ({
    members: await tx.execute(sql`SELECT account_id::text AS a FROM graph_members`),
    graphs: await tx.execute(sql`SELECT id::text AS id FROM graphs`),
  }));
  expect(seen.members.map((r) => r.a)).toEqual([a]);
  expect(seen.graphs.map((r) => r.id)).toEqual([a]);
});
