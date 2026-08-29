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

  /**
   * ТРЁХСТОРОННЕЕ СЛИЯНИЕ НА ПЕРЕСЕВЕ (§А3-3) — против живой базы, целиком боевым путём.
   *
   * Дрейф здесь СОЗДАЁТСЯ намеренно: system-строки в БД правятся так, чтобы «до» отличалось
   * от кода в двух местах сразу — свойство, которое код требует, в базе необязательно, а
   * вариант `cancelled`, который код знает, из базы убран. Ровно это и есть ситуация «под
   * живой дельтой обновили систему»: дельта писалась против БАЗЫ, а пересев приносит КОД.
   *
   * Обе пробы бьют в РАЗНЫЕ правила §А3-3 и обе — конфликтные; молчаливое правило
   * (label/description) проверено юнитом (`registry/deltas.test.ts`).
   */
  test('пересев под живой дельтой: конфликты в отчёте, дельта переписана, заметка в треде', async () => {
    const { db, client } = adminDb();
    const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
    const owner = crypto.randomUUID();
    try {
      // Сид — операция ГЛОБАЛЬНАЯ: его отчёт считает дельты ВСЕХ владельцев базы, и
      // строки, оставленные соседними сьютами, сделали бы число зависимым от порядка
      // прогона. Тот же приём, что у `truncateAll` (test/helpers.ts): дельты бывают только
      // пользовательские, встроенных не бывает по определению.
      await db.execute(sql`TRUNCATE registry_deltas`);
      const baseVersion = await systemVersion(db);
      // Дельта владельца: прячет статус (в БАЗЕ он сейчас необязателен) и добавляет свой
      // вариант `cancelled` (в БАЗЕ такого варианта сейчас нет).
      await db.execute(sql`
        INSERT INTO registry_deltas (id, owner_id, target_kind, target_id, base_version, delta)
        VALUES (gen_random_uuid(), ${owner}::uuid, 'aspect', 'orbis/task', ${baseVersion},
                ${JSON.stringify({
                  label: { ru: 'Дело' },
                  properties: { hide: ['orbis/task_status'] },
                  selectOptions: {
                    'orbis/task_status': {
                      add: [{ key: 'cancelled', label: { ru: 'Отменена' }, rank: 6 }],
                    },
                  },
                })}::jsonb)`);
      // Дрейф «система была другой»: статус необязателен, варианта `cancelled` нет.
      await db.execute(sql`
        UPDATE aspect_definitions
           SET properties = (SELECT jsonb_agg(CASE WHEN e->>'propertyId' = 'orbis/task_status'
                                                   THEN jsonb_set(e, '{required}', 'false')
                                                   ELSE e END)
                               FROM jsonb_array_elements(properties) e)
         WHERE id = 'orbis/task' AND owner_id IS NULL`);
      await db.execute(sql`
        UPDATE property_definitions
           SET type = jsonb_set(type, '{options}',
                 (SELECT jsonb_agg(e) FROM jsonb_array_elements(type->'options') e
                   WHERE e->>'key' <> 'cancelled'))
         WHERE id = 'orbis/task_status' AND owner_id IS NULL`);

      const result = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      expect(result.mergedDeltas).toBe(1);
      expect(result.conflicts.map((c) => c.kind)).toEqual(['hidden-required', 'variant-merge']);
      expect(result.conflicts.map((c) => c.propertyId)).toEqual([
        'orbis/task_status',
        'orbis/task_status',
      ]);

      // Дельта ПЕРЕПИСАНА: обе конфликтные части сняты, молчаливая (label) осталась,
      // `base_version` переехал на новую системную версию.
      const rows = (await db.execute(
        sql`SELECT delta, base_version FROM registry_deltas WHERE owner_id = ${owner}::uuid`,
      )) as unknown as { delta: unknown; base_version: number }[];
      expect(rows[0]?.delta).toEqual({ label: { ru: 'Дело' } });
      expect(rows[0]?.base_version).toBe(result.version);

      // Версия ВЛАДЕЛЬЦА сдвинута тем же коммитом (§А10-1): его дельта изменилась, и кеш
      // эффективных определений обязан это заметить.
      const settings = (await db.execute(
        sql`SELECT registry_version FROM user_settings WHERE owner_id = ${owner}::uuid`,
      )) as unknown as { registry_version: number }[];
      expect(settings[0]?.registry_version).toBe(1);

      // Системная заметка в ГЛОБАЛЬНОМ треде владельца — единственный след, который увидит
      // человек (единицы пачки D42 — Задача 15).
      const notes = (await db.execute(
        sql`SELECT m.role, m.content, m.metadata
              FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
             WHERE t.owner_id = ${owner}::uuid AND t.entity_id IS NULL`,
      )) as unknown as { role: string; content: string; metadata: Record<string, unknown> }[];
      expect(notes).toHaveLength(1);
      expect(notes[0]?.role).toBe('system');
      expect(notes[0]?.metadata.type).toBe('registry-merge');
      expect(notes[0]?.content).toContain('hidden-required');
      expect(notes[0]?.content).toContain('variant-merge');

      // Заметка написана ТОЙ ЖЕ транзакцией, что переписала дельту: исхода «слито, но не
      // сказано» не бывает. Повторный пересев конфликтов уже не даёт (дельта слита) — и
      // второй заметки не появляется.
      const again = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      expect(again.conflicts).toEqual([]);
      expect(
        (
          (await db.execute(
            sql`SELECT count(*)::int AS n FROM chat_messages m
                  JOIN chat_threads t ON t.id = m.thread_id
                 WHERE t.owner_id = ${owner}::uuid`,
          )) as unknown as { n: number }[]
        )[0]?.n,
      ).toBe(1);
    } finally {
      await db.execute(sql`DELETE FROM registry_deltas WHERE owner_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM chat_messages WHERE thread_id IN
        (SELECT id FROM chat_threads WHERE owner_id = ${owner}::uuid)`);
      await db.execute(sql`DELETE FROM chat_threads WHERE owner_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM user_settings WHERE owner_id = ${owner}::uuid`);
      await raw.end();
      await client.end();
    }
  }, 30_000);

  /**
   * ОТСТАВШИЙ `base_version` — пропущенное прошлым прогоном слияние (Important-1
   * гейт-ревью). Дрейфа в базе НЕТ вовсе: system-строки совпадают с кодом, то есть
   * `prev == next`, и точная база не увидела бы никакого перехода. Но дельта писалась
   * против ДРУГОЙ, уже не сохранённой нигде версии — и молча слить её нельзя.
   *
   * Путь достижим ровно тем способом, который описан порядком восстановления: сид упал
   * или процесс убит посреди цикла, часть строк переехала на новую версию, часть осталась
   * на старой; следующий прогон встречает вторую половину.
   */
  test('дельта с отставшим base_version сливается по широкому правилу, а не вслепую', async () => {
    const { db, client } = adminDb();
    const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
    const owner = crypto.randomUUID();
    try {
      await db.execute(sql`TRUNCATE registry_deltas`);
      // base_version НАМЕРЕННО отстал на несколько прогонов; система при этом в порядке.
      await db.execute(sql`
        INSERT INTO registry_deltas (id, owner_id, target_kind, target_id, base_version, delta)
        VALUES (gen_random_uuid(), ${owner}::uuid, 'aspect', 'orbis/task', 1,
                ${JSON.stringify({ properties: { hide: ['orbis/task_status'] } })}::jsonb)`);

      const result = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      // Скрытие ОБЯЗАТЕЛЬНОГО свойства доложено конфликтом и снято — а не уехало молча.
      expect(result.conflicts.map((c) => c.kind)).toEqual(['hidden-required']);
      expect(result.conflicts[0]?.propertyId).toBe('orbis/task_status');
      const rows = (await db.execute(
        sql`SELECT delta, base_version FROM registry_deltas WHERE owner_id = ${owner}::uuid`,
      )) as unknown as { delta: unknown; base_version: number }[];
      expect(rows[0]?.delta).toEqual({});
      expect(rows[0]?.base_version).toBe(result.version);
      // Владельцу сказано той же транзакцией.
      const notes = (await db.execute(
        sql`SELECT m.metadata FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
             WHERE t.owner_id = ${owner}::uuid`,
      )) as unknown as { metadata: Record<string, unknown> }[];
      expect(notes).toHaveLength(1);
      expect(notes[0]?.metadata.type).toBe('registry-merge');
    } finally {
      await db.execute(sql`DELETE FROM registry_deltas WHERE owner_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM chat_messages WHERE thread_id IN
        (SELECT id FROM chat_threads WHERE owner_id = ${owner}::uuid)`);
      await db.execute(sql`DELETE FROM chat_threads WHERE owner_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM user_settings WHERE owner_id = ${owner}::uuid`);
      await raw.end();
      await client.end();
    }
  }, 30_000);

  // Версия проверяется ОТНОСИТЕЛЬНО: `truncateAll` строку registry_system не трогает
  // намеренно (одна строка, PK = 1), а `db:prepare` уже сеял до начала прогона — абсолютное
  // значение здесь зависело бы от того, сколько раз базу готовили.
  test('версия system-реестров растёт на 1 за прогон и сид идемпотентен', async () => {
    const { db, client } = adminDb();
    const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
    try {
      // Сид — операция ГЛОБАЛЬНАЯ: его отчёт считает дельты ВСЕХ владельцев базы, и
      // строки, оставленные соседними сьютами, сделали бы число зависимым от порядка
      // прогона. Тот же приём, что у `truncateAll` (test/helpers.ts): дельты бывают только
      // пользовательские, встроенных не бывает по определению.
      await db.execute(sql`TRUNCATE registry_deltas`);
      const before = await systemVersion(db);

      const first = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      expect(first).toEqual({
        properties: 77,
        roles: 11,
        aspects: 13,
        version: before + 1,
        mergedDeltas: 0,
        conflicts: [],
      });
      expect(await systemVersion(db)).toBe(before + 1);
      const afterFirst = await ids(db, 'property_definitions');

      // Повторный прогон: строки те же (upsert), версия всё равно ещё +1 — «сид был»
      // обязано быть отличимо от «сида не было» даже когда он ничего не изменил.
      const second = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
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
