import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { withIdentity } from '../src/db/with-identity';
import { execute } from '../src/executor/executor';
import { identityOfGrant } from '../src/identity';
import { accountOf, addMember, adminDb, appDb, freshGraph, personal, truncateAll } from './helpers';

const { db, client } = appDb();

/** Код ошибки Postgres — у drizzle он лежит либо в `code`, либо в `cause.code`. */
const pgCode = (e: unknown): string =>
  (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code ?? 'THROW';

/**
 * До миграции 0021 старые политики отвечают на пару {actor: Б, graph: А} ИСКЛЮЧЕНИЕМ 42501, а не
 * структурированным отказом: исполнитель превращает в `{ ok: false }` только `ExecError`
 * (executor.ts:563-567), а `ensureThread` бросает обычный `Error` (chat/threads.ts:25-28). Каждый
 * сюжет снимается СВОИМ перехватом — иначе упавший первый съел бы три остальных, и два сюжета,
 * обязанных быть зелёными уже в Г-3, покраснели бы вместе с помеченными.
 */
async function capture<T>(run: () => Promise<T>, onThrow: (code: string) => T): Promise<T> {
  try {
    return await run();
  } catch (e) {
    return onThrow(`throw:${pgCode(e)}`);
  }
}
const seen = {
  graphA: '',
  accountB: '',
  bReadsA: -1,
  bWriteInA: 'не запускалось',
  journalActor: '',
  journalGraph: '',
  bInOwnGraphSeesA: -1,
  bUpdatesAById: 'не запускалось',
  withoutGraph: -1,
};

beforeAll(async () => {
  await truncateAll();
  const A = await freshGraph();
  const B = await freshGraph();
  await addMember(A, accountOf(B), 'operator'); // аккаунт Б — оператор в личном графе А
  seen.graphA = A;
  seen.accountB = accountOf(B);
  const created = await execute(db, {
    identity: personal(A),
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool: 'entity_create', input: { title: 'запись графа А', tags: [] } }],
  });
  if (!created.ok) throw new Error(`фикстура не создана: ${created.error.message}`);
  const rowOfA = (created.results[0] as { id: string }).id;
  const bInA = identityOfGrant({ accountId: accountOf(B), graphId: A });

  // (1) Б в графе А: чтение, запись, журнал
  seen.bReadsA = await capture(
    async () =>
      Number(
        (
          await withIdentity(db, bInA, (tx) =>
            tx.execute(sql`SELECT count(*)::int AS n FROM entities`),
          )
        )[0]?.n,
      ),
    () => -1,
  );
  seen.bWriteInA = await capture(
    async () => {
      const written = await execute(db, {
        identity: bInA,
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'entity_create', input: { title: 'запись Б в графе А', tags: [] } }],
      });
      return written.ok ? 'ok' : written.error.code;
    },
    (code) => code,
  );
  const admin = adminDb();
  const journal = await admin.db.execute(sql`
    SELECT m.metadata -> 'actions' -> 0 ->> 'actor_user_id' AS actor, t.graph_id::text AS graph
    FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
    WHERE m.metadata -> 'actions' -> 0 ->> 'actor_user_id' = ${accountOf(B)}`);
  seen.journalActor = String(journal[0]?.actor ?? '');
  seen.journalGraph = String(journal[0]?.graph ?? '');
  // (2) Б в СВОЁМ графе строк А не видит
  seen.bInOwnGraphSeesA = await capture(
    async () =>
      Number(
        (
          await withIdentity(db, personal(B), (tx) =>
            tx.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${rowOfA}::uuid`),
          )
        )[0]?.n,
      ),
    () => -1,
  );
  // (3) мутация строки по id в НЕТЕКУЩЕМ графе
  seen.bUpdatesAById = await capture(
    async () => {
      const foreign = await execute(db, {
        identity: personal(B),
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'entity_update', input: { id: rowOfA, title: 'перехват' } }],
      });
      return foreign.ok ? 'ok' : foreign.error.code;
    },
    (code) => code,
  );
  // (4) чтение БЕЗ текущего графа: claims с `sub`, но без ключа `graph`
  seen.withoutGraph = await capture(
    async () =>
      Number(
        (
          await db.transaction(async (tx) => {
            const claims = JSON.stringify({ sub: accountOf(A), role: 'authenticated' });
            await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims}, true)`);
            await tx.execute(sql`SET LOCAL ROLE authenticated`);
            return tx.execute(sql`SELECT count(*)::int AS n FROM entities`);
          })
        )[0]?.n,
      ),
    () => -1,
  );
  await admin.client.end();
});

afterAll(async () => {
  await client.end();
});

describe('граф ≠ аккаунт (спека §3.5; гейт миграции 0021)', () => {
  // ПОМЕТКА Г-3 → Г-4: под старыми политиками `graph_id = auth.uid()` пара {actor: Б, graph: А}
  // упирается в RLS. Зелёным сюжет становится с миграцией 0021 — тогда пометка снимается.
  test.failing('под {actor: Б, graph: А} чтение и запись проходят, журнал пишет актора Б в треде графа А', () => {
    expect(seen.bReadsA).toBe(1);
    expect(seen.bWriteInA).toBe('ok');
    expect(seen.journalActor).toBe(seen.accountB);
    expect(seen.journalGraph).toBe(seen.graphA);
  });
  test('под {actor: Б, graph: Б} строки А не видны', () => {
    expect(seen.bInOwnGraphSeesA).toBe(0);
  });
  test('мутация строки по id в нетекущем графе — отказ', () => {
    expect(seen.bUpdatesAById).toBe('NOT_FOUND');
  });
  // ПОМЕТКА Г-3 → Г-4: старые политики читают только `sub` и отдают строки без текущего графа.
  test.failing('чтение без текущего графа — пусто (fail-closed)', () => {
    expect(seen.withoutGraph).toBe(0);
  });
});
