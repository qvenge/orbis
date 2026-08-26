// apps/server/test/seed-registries.test.ts
// Приёмка сида трёх реестров (§А12-1 п.1) против ЖИВОЙ базы: состав system-строк, пустота
// трёх реестров части Б и монотонность версии. Чистые проверки формы деклараций живут в
// packages/shared/src/registry/builtin.test.ts — здесь только то, что видно лишь в БД.
import { describe, expect, test } from 'bun:test';
import {
  type AspectId,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  legacyAspectJsonSchema,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { seedRegistries } from '../src/db/seed-registries';
import { adminDb, requireEnv } from './helpers';

requireEnv();

async function ids(db: ReturnType<typeof adminDb>['db'], table: string): Promise<string[]> {
  const rows = (await db.execute(
    sql`SELECT id FROM ${sql.raw(table)} WHERE owner_id IS NULL ORDER BY id`,
  )) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

async function systemVersion(db: ReturnType<typeof adminDb>['db']): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT version FROM registry_system WHERE id = 1`,
  )) as unknown as { version: number }[];
  const row = rows[0];
  if (row === undefined) throw new Error('нет строки registry_system id=1');
  return row.version;
}

describe('сид трёх реестров', () => {
  test('состав system-строк = ровно BUILTIN_* (77 свойств, 11 ролей, 13 аспектов)', async () => {
    const { db, client } = adminDb();
    try {
      expect(await ids(db, 'property_definitions')).toEqual(
        [...BUILTIN_PROPERTY_META.map((p) => p.id)].sort(),
      );
      expect(await ids(db, 'relation_role_definitions')).toEqual(
        [...BUILTIN_RELATION_ROLE_META.map((r) => r.id)].sort(),
      );
      expect(await ids(db, 'aspect_definitions')).toEqual(
        [...BUILTIN_ASPECT_DEFS.map((a) => a.id)].sort(),
      );
      // Счётчики названы числом отдельно от состава: подмена набора равной мощности
      // (переименовали свойство и забыли пересеять) прошла бы первую проверку молча.
      expect(BUILTIN_PROPERTY_META.length).toBe(77);
      expect(BUILTIN_RELATION_ROLE_META.length).toBe(11);
      expect(BUILTIN_ASPECT_DEFS.length).toBe(13);
    } finally {
      await client.end();
    }
  });

  // §А12-1: их сиды — первый акт среза Б-1, после гейта П5. До него любая system-строка
  // здесь означает, что сид положили раньше времени.
  test('контракты, подписки и действия — БЕЗ system-строк (пусты в срезе А)', async () => {
    const { db, client } = adminDb();
    try {
      expect(await ids(db, 'contract_definitions')).toEqual([]);
      expect(await ids(db, 'subscription_definitions')).toEqual([]);
      expect(await ids(db, 'action_definitions')).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('колонка schema аспекта байт-в-байт равна legacyAspectJsonSchema (носитель старой формы, Р-24)', async () => {
    const { db, client } = adminDb();
    try {
      const rows = (await db.execute(
        sql`SELECT id, schema FROM aspect_definitions WHERE owner_id IS NULL ORDER BY id`,
      )) as unknown as { id: string; schema: unknown }[];
      for (const row of rows) {
        expect(row.schema).toEqual(legacyAspectJsonSchema(row.id as AspectId));
      }
    } finally {
      await client.end();
    }
  });

  test('ссылки аспектов на свойства резолвятся в существующие строки реестра', async () => {
    const { db, client } = adminDb();
    try {
      // Аспект в новой форме не владеет полями (Р5) — он ссылается. Битая ссылка ничем
      // не ловится: FK на partial-уникальность не поставить, а `attach_*` пока собирается
      // из старой колонки `schema` и промолчит.
      const rows = (await db.execute(
        sql`SELECT a.id, r.value->>'propertyId' AS property_id
            FROM aspect_definitions a, jsonb_array_elements(a.properties) r
            WHERE a.owner_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM property_definitions p
                              WHERE p.owner_id IS NULL AND p.id = r.value->>'propertyId')`,
      )) as unknown as { id: string; property_id: string }[];
      expect(rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  // Версия проверяется ОТНОСИТЕЛЬНО: `truncateAll` строку registry_system не трогает
  // намеренно (одна строка, PK = 1), а `db:prepare` уже сеял до начала прогона — абсолютное
  // значение здесь зависело бы от того, сколько раз базу готовили.
  test('версия system-реестров растёт на 1 за прогон и сид идемпотентен', async () => {
    const { db, client } = adminDb();
    const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
    try {
      const before = await systemVersion(db);

      const first = await seedRegistries(raw);
      expect(first).toEqual({ properties: 77, roles: 11, aspects: 13, version: before + 1 });
      expect(await systemVersion(db)).toBe(before + 1);
      const afterFirst = await ids(db, 'property_definitions');

      // Повторный прогон: строки те же (upsert), версия всё равно ещё +1 — «сид был»
      // обязано быть отличимо от «сида не было» даже когда он ничего не изменил.
      const second = await seedRegistries(raw);
      expect(second.version).toBe(before + 2);
      expect(await ids(db, 'property_definitions')).toEqual(afterFirst);
      expect(await ids(db, 'aspect_definitions')).toEqual(
        [...BUILTIN_ASPECT_DEFS.map((a) => a.id)].sort(),
      );
    } finally {
      await raw.end();
      await client.end();
    }
  });
});
