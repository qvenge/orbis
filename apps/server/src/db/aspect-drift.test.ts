// apps/server/src/db/aspect-drift.test.ts
// Серверная половина стартовой проверки реестра (E1): чтение aspect_definitions под
// ролью приложения. Именно она ловит то, чего не видят unit'ы shared, — права роли:
// без SET LOCAL ROLE authenticated запрос падает «permission denied» на каждом старте
// (роль приложения NOINHERIT, гранты висят на authenticated).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { aspectJsonSchema, BUILTIN_ASPECT_META, hasAspectDrift } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, requireEnv, truncateAll } from '../../test/helpers';
import { checkAspectDrift, driftReport } from './aspect-drift';

requireEnv();

const { db, client } = appDb();
const admin = adminDb();

/**
 * Тот же идемпотентный upsert, что у `scripts/seed-aspects.ts`. Сеть безопасности файла:
 * тесты ниже намеренно ПОРТЯТ общий реестр, а по нему валидирует исполнитель во ВСЕХ
 * остальных серверных сьютах прогона — упавший на середине тест не имеет права оставить
 * локальную БД в состоянии «фича мертва», иначе следом посыплется весь прогон.
 */
async function reseedBuiltinAspects(): Promise<void> {
  for (const meta of BUILTIN_ASPECT_META) {
    await admin.db.execute(sql`
      INSERT INTO aspect_definitions
        (id, owner_id, name, namespace, description, icon, schema, ai_instructions,
         tag_mappings, view_config)
      VALUES (${meta.id}, NULL, ${meta.name}, ${meta.namespace}, ${meta.description},
        ${meta.icon}, ${JSON.stringify(aspectJsonSchema(meta.id))}::jsonb,
        ${meta.aiInstructions}, ${sql.raw(`ARRAY[${meta.tagMappings.map((t) => `'${t}'`).join(',')}]::text[]`)},
        ${JSON.stringify(meta.viewConfig)}::jsonb)
      ON CONFLICT (id) WHERE owner_id IS NULL DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, icon = EXCLUDED.icon,
        schema = EXCLUDED.schema, ai_instructions = EXCLUDED.ai_instructions,
        tag_mappings = EXCLUDED.tag_mappings, view_config = EXCLUDED.view_config`);
  }
}

beforeAll(async () => {
  await truncateAll();
  await reseedBuiltinAspects();
});

afterAll(async () => {
  await reseedBuiltinAspects();
  await admin.client.end();
  await client.end();
});

test('засеянный реестр: расхождений нет и запрос проходит под ролью приложения', async () => {
  const drift = await checkAspectDrift(db);
  expect(drift).toEqual({ missing: [], drifted: [] });
  expect(hasAspectDrift(drift)).toBe(false);
});

test('расхождение схемы в БД видно проверке и названо в отчёте', async () => {
  const before = await admin.db.execute(
    sql`SELECT schema FROM aspect_definitions WHERE id = 'orbis/financial' AND owner_id IS NULL`,
  );
  const original = (before as unknown as { schema: unknown }[])[0]?.schema;
  try {
    await admin.db.execute(
      sql`UPDATE aspect_definitions SET schema = ${sql.raw('\'{"type":"object"}\'::jsonb')}
          WHERE id = 'orbis/financial' AND owner_id IS NULL`,
    );
    const drift = await checkAspectDrift(db);
    expect(drift.drifted).toEqual([{ id: 'orbis/financial', what: ['schema'] }]);
    expect(driftReport(drift)[0]).toContain('orbis/financial');
  } finally {
    await admin.db.execute(
      sql`UPDATE aspect_definitions SET schema = ${JSON.stringify(original)}::jsonb
          WHERE id = 'orbis/financial' AND owner_id IS NULL`,
    );
  }
  expect(hasAspectDrift(await checkAspectDrift(db))).toBe(false);
});

test('аспект отсутствует в реестре: missing (релиз добавил аспект без пересева)', async () => {
  // Снимок строки целиком через to_jsonb и восстановление через jsonb_populate_record:
  // перечислять колонки руками — значит забыть новую при следующей миграции.
  const before = await admin.db.execute(
    sql`SELECT to_jsonb(a) AS row FROM aspect_definitions a
        WHERE id = 'orbis/memory' AND owner_id IS NULL`,
  );
  const snapshot = (before as unknown as { row: unknown }[])[0]?.row;
  expect(snapshot).toBeDefined();
  try {
    await admin.db.execute(
      sql`DELETE FROM aspect_definitions WHERE id = 'orbis/memory' AND owner_id IS NULL`,
    );
    const drift = await checkAspectDrift(db);
    expect(drift.missing).toEqual(['orbis/memory']);
  } finally {
    await admin.db.execute(
      sql`INSERT INTO aspect_definitions
          SELECT * FROM jsonb_populate_record(NULL::aspect_definitions,
            ${JSON.stringify(snapshot)}::jsonb)`,
    );
  }
  expect(hasAspectDrift(await checkAspectDrift(db))).toBe(false);
});
