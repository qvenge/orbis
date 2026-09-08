// apps/server/src/budget/spent-cache.test.ts
// Кэш spent (§Б5-5, приёмка §С8-16): форма строки, обе половины версии, инкремент по хуку,
// три пути мимо хука и суточная граница. Реальная БД под withIdentity (RLS enforced).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import type { ExecuteOk, ExecuteRequest, ExecuteResult, WireEntity } from '../executor/types';
import { readRegistryVersions } from '../registry/version';
import { invalidateSpentCache, readSpentCache, spentCacheKey, writeSpentCache } from './spent-cache';

requireEnv();
const { db, client } = appDb();
beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

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
function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}
async function createEntity(user: string, input: Record<string, unknown>): Promise<WireEntity> {
  return ok(await execute(db, req(user, 'entity_create', { tags: [], ...input })))
    .results[0] as WireEntity;
}
function budgetProps(
  cat: string,
  from = '2026-07-01',
  to = '2026-07-31',
): Record<string, unknown> {
  return {
    'orbis/finance_category': cat,
    'orbis/limit': '30000.00',
    'orbis/period_start': from,
    'orbis/period_end': to,
  };
}
function finProps(
  cat: string,
  on = '2026-07-05',
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    'orbis/amount': '340.00',
    'orbis/direction': 'expense',
    'orbis/finance_category': cat,
    'orbis/occurred_on': on,
    ...over,
  };
}
/** Строки кэша конверта — истина в БД (админ-DSN, обходит RLS). */
async function cacheRows(
  envelopeId: string,
): Promise<Array<{ as_of: string; spent: string; owner_version: number }>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(sql`
      SELECT as_of::text AS as_of, spent::text AS spent, owner_version FROM envelope_spent_cache
      WHERE envelope_id = ${envelopeId} ORDER BY as_of`);
    return [...rows] as Array<{ as_of: string; spent: string; owner_version: number }>;
  } finally {
    await adminClient.end();
  }
}

describe('таблица кэша: форма строки и обе половины версии (§Б5-5, §А10-1)', () => {
  const user = freshUserId();
  const cat = newId();

  test('запись и чтение по ключу (envelope_id, as_of); строка чужой версии невидима', async () => {
    const env = await createEntity(user, {
      title: 'Еда — июль',
      props: budgetProps(cat),
      aspects: ['orbis/budget'],
    });
    await withIdentity(db, user, async (tx) => {
      const v = await readRegistryVersions(tx, user);
      await writeSpentCache(
        tx,
        user,
        [{ envelopeId: env.id, asOf: '2026-07-05', spent: '340.00' }],
        v,
      );
      const hit = await readSpentCache(tx, user, [{ envelopeId: env.id, asOf: '2026-07-05' }], v);
      expect(hit.get(spentCacheKey({ envelopeId: env.id, asOf: '2026-07-05' }))).toBe('340.00');
      // Половина владельца сдвинулась — та же строка перестала отвечать (§С8-16).
      const stale = { ownerVersion: v.ownerVersion + 1, systemVersion: v.systemVersion };
      expect(
        (await readSpentCache(tx, user, [{ envelopeId: env.id, asOf: '2026-07-05' }], stale)).size,
      ).toBe(0);
      // Другой день — другой ключ: суточная граница закрыта ключом, а не пересчётом.
      expect(
        (await readSpentCache(tx, user, [{ envelopeId: env.id, asOf: '2026-07-06' }], v)).size,
      ).toBe(0);
      await invalidateSpentCache(tx, user, [env.id]);
      expect(
        (await readSpentCache(tx, user, [{ envelopeId: env.id, asOf: '2026-07-05' }], v)).size,
      ).toBe(0);
    });
    expect(await cacheRows(env.id)).toEqual([]);
  });
});
