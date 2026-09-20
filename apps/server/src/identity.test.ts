import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, truncateAll } from '../test/helpers';
import {
  identitiesForScheduler,
  identityOfGrant,
  identityOfPerson,
  parseAccountId,
  parseGraphId,
} from './identity';

const { db, client } = appDb(); // { db, client } — как во всех сьютах (db/with-identity.test.ts:10)
// Константы несут БРЕНД (а не голый string): иначе `toBe` сравнивал бы `AccountId` со
// `string` и сам тест не компилировался бы — те же значения, что в брифе.
const ACCOUNT = parseAccountId('0aa00000-0000-4000-8000-0000000000a1');
const GRAPH = parseGraphId('0bb00000-0000-4000-8000-0000000000b1'); // НЕ равен аккаунту намеренно

test('границы внешнего мира: не-UUID отклоняется, регистр нормализуется', () => {
  expect(() => parseAccountId('не uuid')).toThrow(/UUID/);
  expect(() => parseGraphId('')).toThrow(/UUID/);
  expect(parseAccountId(ACCOUNT.toUpperCase())).toBe(ACCOUNT);
  expect(parseGraphId(GRAPH.toUpperCase())).toBe(GRAPH);
});

test('резолвер 1 (JWT): граф человека — его личный граф; тождество id живёт только здесь', () => {
  const who = identityOfPerson(parseAccountId(ACCOUNT));
  expect(who.actor).toBe(ACCOUNT);
  expect(who.graph as string).toBe(ACCOUNT);
});

test('резолвер 2 (Bearer): оба id — из строки гранта, и они НЕ обязаны совпадать', () => {
  const who = identityOfGrant({ accountId: parseAccountId(ACCOUNT), graphId: parseGraphId(GRAPH) });
  expect(who).toEqual({ actor: ACCOUNT, graph: GRAPH });
});

beforeAll(truncateAll);
afterAll(async () => {
  await truncateAll();
  await client.end(); // незакрытый пул держит прогон
});

test('резолвер 3 (тик): пара берётся из graph_members, а не из равенства id', async () => {
  // Граф, у которого держатель гранта owner — ДРУГОЙ uuid: в бою такого в v1 нет (личный граф),
  // но только так видно, что актор приходит из строки членства, а не копируется из id графа.
  const admin = adminDb();
  await admin.db.transaction(async (tx) => {
    await tx.execute(
      sql`INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (${GRAPH}::uuid, 'organization', NULL)`,
    );
    await tx.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
      VALUES (gen_random_uuid(), ${GRAPH}::uuid, ${ACCOUNT}::uuid, 'owner', ${ACCOUNT}::uuid)`);
    await tx.execute(sql`INSERT INTO user_settings (graph_id) VALUES (${GRAPH}::uuid)`);
  });
  await admin.client.end();
  const pairs = await identitiesForScheduler(db); // под orbis_app, без идентичности
  expect(pairs).toContainEqual({ actor: ACCOUNT, graph: GRAPH });
  const graphs = pairs.map((p) => p.graph);
  expect(graphs).toEqual([...graphs].sort()); // порядок обхода детерминирован (два деплоя Render)
  expect(new Set(graphs).size).toBe(graphs.length); // один актор на граф
});

test('резолвер 3: граф без строки настроек (онбординг не пройден) тик не обходит', async () => {
  const pairs = await identitiesForScheduler(db);
  // truncateAll восстановил личности процесса как графы БЕЗ user_settings — их в обходе быть не должно
  expect(pairs.every((p) => p.graph === GRAPH)).toBe(true);
});
