import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { adminDb, freshGraph, mintGraph, truncateAll } from '../../test/helpers';

const pgCode = (e: unknown): string | undefined =>
  (e as { code?: string; cause?: { code?: string } }).code ??
  (e as { cause?: { code?: string } }).cause?.code;

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (e) {
    return pgCode(e);
  }
}

/**
 * Код И ИМЯ ограничения. Одного SQLSTATE мало: отложенный триггер И-1 бросает ТОТ ЖЕ `23514`,
 * что и CHECK таблицы, а `db.execute` вне транзакции — это неявная транзакция, на коммите
 * которой триггер и срабатывает. Проверка «вернулось 23514» поэтому зелена и при вовсе
 * снесённом CHECK: красит её триггер. Имя ограничения разводит два источника — у CHECK оно
 * есть (`ExecConstraints`), у `RAISE EXCEPTION` триггера его нет.
 */
async function failOf(
  run: () => Promise<unknown>,
): Promise<{ code: string | undefined; constraint: string | undefined }> {
  try {
    await run();
    return { code: undefined, constraint: undefined };
  } catch (e) {
    const cause = e as { cause?: { constraint_name?: string }; constraint_name?: string };
    return {
      code: pgCode(e),
      constraint: cause.cause?.constraint_name ?? cause.constraint_name,
    };
  }
}

describe('graphs / graph_members — инварианты схемы (спека §3.1–§3.3)', () => {
  const admin = adminDb();
  beforeAll(truncateAll);
  afterAll(async () => {
    await truncateAll();
    await admin.client.end();
  });

  /** Граф с грантом owner одной транзакцией — иначе отложенный триггер И-1 откажет на коммите. */
  async function graphWithOwners(graph: string, owners: string[]): Promise<void> {
    await admin.db.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (${graph}::uuid, 'person', ${graph}::uuid)`,
      );
      for (const account of owners) {
        await tx.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
          VALUES (gen_random_uuid(), ${graph}::uuid, ${account}::uuid, 'owner', ${graph}::uuid)`);
      }
    });
  }

  test('CHECK §3.1: у личного графа id = owner_ref; NULL в owner_ref — отказ, у organization — можно', async () => {
    const id = crypto.randomUUID();
    const other = crypto.randomUUID();
    expect(
      await failOf(() =>
        admin.db.execute(
          sql`INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (${id}::uuid, 'person', ${other}::uuid)`,
        ),
      ),
    ).toEqual({ code: '23514', constraint: 'graphs_personal_identity' });
    expect(
      await failOf(() =>
        admin.db.execute(
          sql`INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (${id}::uuid, 'person', NULL)`,
        ),
      ),
    ).toEqual({ code: '23514', constraint: 'graphs_personal_identity' });
    expect(
      await failOf(() =>
        admin.db.execute(sql`INSERT INTO graphs (id, owner_kind) VALUES (${id}::uuid, 'тенант')`),
      ),
    ).toEqual({ code: '23514', constraint: 'graphs_owner_kind' });
  });

  test('И-1: граф без действующего гранта owner не коммитится', async () => {
    const id = crypto.randomUUID();
    // Именно триггер, а не CHECK: имени ограничения у `RAISE EXCEPTION` нет.
    expect(
      await failOf(() =>
        admin.db.execute(
          sql`INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (${id}::uuid, 'person', ${id}::uuid)`,
        ),
      ),
    ).toEqual({ code: '23514', constraint: undefined });
  });

  test('И-1: отзыв единственного гранта owner — отказ; при втором владельце — проходит', async () => {
    const graph = crypto.randomUUID();
    const second = crypto.randomUUID();
    await graphWithOwners(graph, [graph]);
    const revoke = (account: string) =>
      admin.db.execute(sql`UPDATE graph_members SET revoked_at = now()
        WHERE graph_id = ${graph}::uuid AND account_id = ${account}::uuid AND revoked_at IS NULL`);
    expect(await codeOf(() => revoke(graph))).toBe('23514');
    await admin.db.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
      VALUES (gen_random_uuid(), ${graph}::uuid, ${second}::uuid, 'owner', ${graph}::uuid)`);
    expect(await codeOf(() => revoke(graph))).toBeUndefined();
    expect(await codeOf(() => revoke(second))).toBe('23514');
  });

  test('И-1, гонка: два параллельных отзыва двух владельцев — второй получает отказ, а не ноль владельцев', async () => {
    const graph = crypto.randomUUID();
    const second = crypto.randomUUID();
    await graphWithOwners(graph, [graph, second]);
    const other = adminDb(); // второе соединение: гонка — между транзакциями, не внутри одной
    let release!: () => void;
    const firstMayCommit = new Promise<void>((r) => {
      release = r;
    });
    let firstChecked!: () => void;
    const firstHoldsLock = new Promise<void>((r) => {
      firstChecked = r;
    });
    const revokeIn = (
      db: typeof admin.db,
      account: string,
      after?: Promise<void>,
      mark?: () => void,
    ) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE graph_members SET revoked_at = now()
          WHERE graph_id = ${graph}::uuid AND account_id = ${account}::uuid AND revoked_at IS NULL`);
        // IMMEDIATE исполняет отложенный триггер сейчас: он берёт замок строки графа и держит до коммита
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        mark?.();
        if (after) await after;
      });
    const first = revokeIn(admin.db, graph, firstMayCommit, firstChecked);
    await firstHoldsLock;
    const secondTx = codeOf(() => revokeIn(other.db, second)); // упрётся в замок FOR NO KEY UPDATE
    await new Promise((r) => setTimeout(r, 150));
    release();
    await first;
    expect(await secondTx).toBe('23514');
    const left = await admin.db.execute(sql`SELECT count(*)::int AS n FROM graph_members
      WHERE graph_id = ${graph}::uuid AND grant_kind = 'owner' AND revoked_at IS NULL`);
    expect(left[0]?.n).toBe(1);
    await other.client.end();
  });

  test('история отзывов не затирается: повторная выдача — новая строка; второй ДЕЙСТВУЮЩИЙ грант пары — отказ', async () => {
    const graph = crypto.randomUUID();
    const member = crypto.randomUUID();
    await graphWithOwners(graph, [graph]);
    const grantOperator = () =>
      admin.db.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
        VALUES (gen_random_uuid(), ${graph}::uuid, ${member}::uuid, 'operator', ${graph}::uuid)`);
    await grantOperator();
    expect(await codeOf(grantOperator)).toBe('23505');
    await admin.db.execute(sql`UPDATE graph_members SET revoked_at = now()
      WHERE graph_id = ${graph}::uuid AND account_id = ${member}::uuid`);
    await grantOperator();
    const rows = await admin.db.execute(sql`SELECT count(*)::int AS n FROM graph_members
      WHERE graph_id = ${graph}::uuid AND account_id = ${member}::uuid`);
    expect(rows[0]?.n).toBe(2);
  });

  test('truncateAll сносит чужие графы и членство, а личности процесса держит в базе', async () => {
    const stray = crypto.randomUUID(); // граф МИМО реестра хелпера — обязан исчезнуть
    const minted = mintGraph(); // ТОЛЬКО зарегистрированная личность — обязана появиться с грантом
    const already = await freshGraph(); // УЖЕ доведённая до базы — обязана уцелеть вместе с грантом
    await graphWithOwners(stray, [stray]);
    await truncateAll();
    const rows = await admin.db.execute(sql`SELECT g.id::text AS id,
        (SELECT count(*)::int FROM graph_members m
          WHERE m.graph_id = g.id AND m.grant_kind = 'owner' AND m.revoked_at IS NULL) AS owners
      FROM graphs g WHERE g.id IN (${stray}::uuid, ${minted}::uuid, ${already}::uuid)
      ORDER BY g.id`);
    expect(rows.map((r) => r.id).sort()).toEqual([minted, already].sort());
    expect(rows.map((r) => r.owners)).toEqual([1, 1]);
  });

  test('FK: строка с graph_id несуществующего графа — отказ', async () => {
    const ghost = crypto.randomUUID();
    expect(
      await codeOf(() =>
        admin.db.execute(sql`INSERT INTO entities (id, graph_id, title)
          VALUES (gen_random_uuid(), ${ghost}::uuid, 'сирота')`),
      ),
    ).toBe('23503');
  });
});

/** Текст бэкфилла — ровно тот, что в миграции: вторая копия разошлась бы с первой молча. */
function backfillStatements(): string[] {
  const file = join(import.meta.dir, 'migrations', '0020_graphs_members.sql');
  const text = readFileSync(file, 'utf8');
  const body = text.slice(text.indexOf('-- BACKFILL:BEGIN'), text.indexOf('-- BACKFILL:END'));
  return body
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
}

class Rollback extends Error {}

type BackfillTx = Parameters<Parameters<ReturnType<typeof adminDb>['db']['transaction']>[0]>[0];

async function seedOneRowPerTable(tx: BackfillTx, idOf: Record<string, string>): Promise<void> {
  const entity = crypto.randomUUID();
  const thread = crypto.randomUUID();
  const j = (o: unknown) => JSON.stringify(o);
  await tx.execute(sql`INSERT INTO entities (id, graph_id, title)
    VALUES (${entity}::uuid, ${idOf.entities}::uuid, 'бэкфилл')`);
  await tx.execute(
    sql`INSERT INTO chat_threads (id, graph_id) VALUES (${thread}::uuid, ${idOf.chat_threads}::uuid)`,
  );
  await tx.execute(sql`INSERT INTO entity_versions (id, graph_id, entity_id, label, body, actor_user_id, actor_kind)
    VALUES (gen_random_uuid(), ${idOf.entity_versions}::uuid, ${entity}::uuid, 'до', 'тело',
            ${idOf.entity_versions}::uuid, 'owner')`);
  await tx.execute(sql`INSERT INTO entity_origins (id, graph_id, entity_id, namespace, external_id)
    VALUES (gen_random_uuid(), ${idOf.entity_origins}::uuid, ${entity}::uuid, 'backfill', 'ext-1')`);
  await tx.execute(sql`INSERT INTO ai_usage (graph_id, date, model)
    VALUES (${idOf.ai_usage}::uuid, '2026-09-01', 'backfill-model')`);
  await tx.execute(sql`INSERT INTO user_settings (graph_id) VALUES (${idOf.user_settings}::uuid)`);
  await tx.execute(sql`INSERT INTO agent_grants (id, graph_id, kind, label, access_hash)
    VALUES (gen_random_uuid(), ${idOf.agent_grants}::uuid, 'pat', 'бэкфилл', ${`hash-${idOf.agent_grants}`})`);
  await tx.execute(sql`INSERT INTO envelope_spent_cache (envelope_id, graph_id, as_of, spent, owner_version, system_version)
    VALUES (${entity}::uuid, ${idOf.envelope_spent_cache}::uuid, '2026-09-01', 100, 0, 1)`);
  await tx.execute(sql`INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
    VALUES (gen_random_uuid(), ${idOf.registry_deltas}::uuid, 'property', 'orbis/priority', 1,
            ${j({ label: { ru: 'Своё' } })}::jsonb)`);
  const l = j({ ru: 'Б' });
  await tx.execute(sql`INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
    VALUES ('backfill/p', ${idOf.property_definitions}::uuid, 'backfill/p', ${l}::jsonb, ${l}::jsonb,
            ${j({ kind: 'text' })}::jsonb, 900)`);
  await tx.execute(sql`INSERT INTO aspect_definitions (id, graph_id, key, label, description)
    VALUES ('backfill/a', ${idOf.aspect_definitions}::uuid, 'backfill/a', ${l}::jsonb, ${l}::jsonb)`);
  await tx.execute(sql`INSERT INTO relation_role_definitions
    (id, graph_id, key, label, description, source_label, target_label, rank)
    VALUES ('backfill/r', ${idOf.relation_role_definitions}::uuid, 'backfill/r', ${l}::jsonb, ${l}::jsonb,
            ${l}::jsonb, ${l}::jsonb, 900)`);
  await tx.execute(sql`INSERT INTO contract_definitions (id, graph_id, key, label, description, kind, rank)
    VALUES ('backfill/c', ${idOf.contract_definitions}::uuid, 'backfill/c', ${l}::jsonb, ${l}::jsonb, 'slots', 900)`);
  await tx.execute(sql`INSERT INTO subscription_definitions (id, graph_id, surface, definition, rank)
    VALUES ('backfill/s', ${idOf.subscription_definitions}::uuid, 'agenda', '{}'::jsonb, 900)`);
  await tx.execute(sql`INSERT INTO action_definitions (id, graph_id, key, label, description)
    VALUES ('backfill/d', ${idOf.action_definitions}::uuid, 'backfill/d', ${l}::jsonb, ${l}::jsonb)`);
}

describe('бэкфилл 0020 на непустой базе (спека Ш-1б)', () => {
  test('каждая из 15 таблиц даёт свой граф; встроенные строки реестров (NULL) графа не дают', async () => {
    await truncateAll();
    const admin = adminDb();
    // ПРОСТРАНСТВО, а не выборка: у КАЖДОЙ из 15 таблиц — свой id, которого нет больше нигде;
    // выпавшая из UNION таблица оставит свой id без графа, и возврат FK на шаге (6) упадёт.
    const TABLES = [
      'entities',
      'chat_threads',
      'entity_versions',
      'entity_origins',
      'ai_usage',
      'user_settings',
      'agent_grants',
      'envelope_spent_cache',
      'registry_deltas',
      'property_definitions',
      'aspect_definitions',
      'relation_role_definitions',
      'contract_definitions',
      'subscription_definitions',
      'action_definitions',
    ] as const;
    const idOf = Object.fromEntries(TABLES.map((t) => [t, crypto.randomUUID()])) as Record<
      (typeof TABLES)[number],
      string
    >;
    try {
      await admin.db.transaction(async (tx) => {
        // (1) снять FK на graphs — имена из каталога, не из головы
        const fks = await tx.execute(sql`SELECT conrelid::regclass::text AS tbl, conname,
            pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype = 'f' AND confrelid = 'public.graphs'::regclass`);
        expect(fks.length).toBe(16); // 15 таблиц с ключом владения + graph_members
        for (const fk of fks) {
          await tx.execute(sql.raw(`ALTER TABLE ${fk.tbl} DROP CONSTRAINT "${fk.conname}"`));
        }
        // После миграции 0021 колонка NOT NULL, а строка «до 0020» выдавшего не несёт: ограничение
        // снимается на время теста (до 0021 — no-op) и возвращается сверкой после бэкфилла.
        await tx.execute(sql`ALTER TABLE agent_grants ALTER COLUMN issued_by DROP NOT NULL`);
        // (2) база «до 0020»: графов нет
        await tx.execute(sql`TRUNCATE graph_members`);
        await tx.execute(sql`DELETE FROM graphs`);
        // (3) по строке на таблицу — минимальные наборы колонок взяты из фикстур rls.pgtap.sql
        await seedOneRowPerTable(tx, idOf);
        // (4) ТЕКСТ бэкфилла из файла миграции
        for (const stmt of backfillStatements()) await tx.execute(sql.raw(stmt));
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`); // И-1 сейчас, и снять отложенные события перед ALTER
        // (5) сверка
        const graphsRows = await tx.execute(
          sql`SELECT id::text AS id, owner_kind, owner_ref::text AS ref FROM graphs`,
        );
        expect(graphsRows.map((r) => r.id).sort()).toEqual(Object.values(idOf).sort());
        expect(graphsRows.every((r) => r.owner_kind === 'person' && r.ref === r.id)).toBe(true);
        const members =
          await tx.execute(sql`SELECT graph_id::text AS g, account_id::text AS a, grant_kind,
            issued_by::text AS by FROM graph_members`);
        expect(members.length).toBe(15);
        expect(members.every((m) => m.a === m.g && m.by === m.g && m.grant_kind === 'owner')).toBe(
          true,
        );
        const grant = await tx.execute(sql`SELECT issued_by::text AS by FROM agent_grants
          WHERE graph_id = ${idOf.agent_grants}::uuid`);
        expect(grant[0]?.by).toBe(idOf.agent_grants);
        // бэкфилл закрыл КАЖДУЮ строку грантов — иначе NOT NULL не встанет
        await tx.execute(sql`ALTER TABLE agent_grants ALTER COLUMN issued_by SET NOT NULL`);
        // (6) FK возвращается — значит, у каждой строки каждой таблицы граф есть
        for (const fk of fks) {
          await tx.execute(
            sql.raw(`ALTER TABLE ${fk.tbl} ADD CONSTRAINT "${fk.conname}" ${fk.def}`),
          );
        }
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    } finally {
      await admin.client.end();
    }
  });
});
