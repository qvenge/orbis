// Нули корпуса под FORCE RLS значимы только вместе с фактом роли.
import { afterAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { adminDb, requireEnv } from '../../test/helpers';
import { describeRoleAccess } from './role-access';

requireEnv();
const { db, client } = adminDb();
afterAll(() => client.end());
test('authenticated не обходит RLS, postgres обходит; SET LOCAL не выходит из транзакции', async () => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE authenticated`);
    expect(await describeRoleAccess(tx)).toEqual({ role: 'authenticated', bypassRls: false });
  });
  expect(await describeRoleAccess(db)).toEqual({ role: 'postgres', bypassRls: true });
});
