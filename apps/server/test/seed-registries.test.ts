// apps/server/test/seed-registries.test.ts
// Приёмка сида ПЯТИ реестров (§А12-1 п.1, §Б1-1, §Б5-1) против ЖИВОЙ базы: состав system-строк,
// пустота действий и монотонность версии. Чистые проверки формы деклараций живут в
// packages/shared/src/registry/builtin.test.ts — здесь только то, что видно лишь в БД.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  BUILTIN_SUBSCRIPTION_DEFS,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { seedRegistries } from '../src/db/seed-registries';
import { withIdentity } from '../src/db/with-identity';
import { effectiveRegistry } from '../src/registry/cache';
import { adminDb, appDb, requireEnv } from './helpers';

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

describe('сид пяти реестров', () => {
  test('состав system-строк = ровно BUILTIN_* (77 свойств, 11 ролей, 13 аспектов, 6 контрактов)', async () => {
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
      expect(await ids(db, 'contract_definitions')).toEqual(
        [...BUILTIN_CONTRACT_DEFS.map((c) => c.id)].sort(),
      );
      // Счётчики названы числом отдельно от состава: подмена набора равной мощности
      // (переименовали свойство и забыли пересеять) прошла бы первую проверку молча.
      expect(BUILTIN_PROPERTY_META.length).toBe(77);
      expect(BUILTIN_RELATION_ROLE_META.length).toBe(11);
      expect(BUILTIN_ASPECT_DEFS.length).toBe(13);
      expect(BUILTIN_CONTRACT_DEFS.length).toBe(6);
    } finally {
      await client.end();
    }
  });

  test('сид подписок: ровно BUILTIN_SUBSCRIPTION_DEFS', async () => {
    const { db, client } = adminDb();
    try {
      expect(await ids(db, 'subscription_definitions')).toEqual(
        [...BUILTIN_SUBSCRIPTION_DEFS.map((s) => s.id)].sort(),
      );
      expect(BUILTIN_SUBSCRIPTION_DEFS.length).toBe(2); // число отдельно от состава
    } finally {
      await client.end();
    }
  });

  // Действия — §Б6, не в Б-1. До них любая system-строка здесь означает, что сид положили
  // раньше времени. Подписки из этого пина ушли: их сеет задача 6 (Agenda), см. тест выше.
  test('действия — БЕЗ system-строк', async () => {
    const { db, client } = adminDb();
    try {
      expect(await ids(db, 'action_definitions')).toEqual([]);
    } finally {
      await client.end();
    }
  });

  // Колонки `aspect_definitions.schema` больше НЕТ (contract-миграция 0017): JSON Schema
  // аспекта — генерируемая производная реестра свойств (§А3-1), а не хранимое значение.
  // Прежний тест сверял колонку с генератором байт-в-байт; сверять стало нечего, и это
  // проверяется каталогом — колонка обязана отсутствовать.
  test('колонки schema у aspect_definitions нет — JSON Schema аспекта производная (§А3-1)', async () => {
    const { db, client } = adminDb();
    try {
      const rows = (await db.execute(
        sql`SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'aspect_definitions'
               AND column_name = 'schema'`,
      )) as unknown as { column_name: string }[];
      expect(rows).toEqual([]);
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

  test('привязки аспектов резолвятся в контракты, их слоты и свойства реестра', async () => {
    const { db, client } = adminDb();
    try {
      // Счёт отдельно от состава: без него проверки «битых ссылок нет» проходят ВАКУУМНО на
      // непересеянной базе, где `implements` пуст у всех (довод счётчиков 77/11/13 на :51-53).
      const [count] = (await db.execute(
        sql`SELECT count(*)::int AS n FROM aspect_definitions a, jsonb_array_elements(a.implements) b
            WHERE a.owner_id IS NULL`,
      )) as unknown as { n: number }[];
      // Семь привязок §Б2-1: две у orbis/schedule, две у orbis/task, две у orbis/financial и
      // одна у orbis/budget. Число названо отдельно от состава (состав пинит снимок B2 в shared).
      expect(count?.n).toBe(7);
      // FK на jsonb не поставить, а `checkImplements` живёт в shared и базы не видит.
      const dangling = (await db.execute(
        sql`SELECT a.id AS aspect_id, b.value->>'contract' AS contract_id
            FROM aspect_definitions a, jsonb_array_elements(a.implements) b
            WHERE a.owner_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM contract_definitions c
                              WHERE c.owner_id IS NULL AND c.id = b.value->>'contract')`,
      )) as unknown as unknown[];
      expect(dangling).toEqual([]);
      const badSlots = (await db.execute(
        sql`SELECT a.id AS aspect_id, kv.slot_name
            FROM aspect_definitions a, jsonb_array_elements(a.implements) b,
                 jsonb_each_text(b.value->'bind') AS kv(slot_name, property_id)
            WHERE a.owner_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM contract_definitions c, jsonb_array_elements(c.slots) sl
                              WHERE c.owner_id IS NULL AND c.id = b.value->>'contract'
                                AND sl.value->>'name' = kv.slot_name)`,
      )) as unknown as unknown[];
      expect(badSlots).toEqual([]);
      const badProps = (await db.execute(
        sql`SELECT a.id AS aspect_id, kv.property_id
            FROM aspect_definitions a, jsonb_array_elements(a.implements) b,
                 jsonb_each_text(b.value->'bind') AS kv(slot_name, property_id)
            WHERE a.owner_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM property_definitions p
                              WHERE p.owner_id IS NULL AND p.id = kv.property_id)`,
      )) as unknown as unknown[];
      expect(badProps).toEqual([]);
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

  /**
   * СЛИЯНИЕ ОБЯЗАНО ОСТАВЛЯТЬ ДЕЛЬТУ ПРИМЕНИМОЙ (ре-ревью фикс-раунда 1, Important-A) —
   * проверяется единственным способом, который что-то значит: реестр владельца ЧИТАЕТСЯ
   * после пересева.
   *
   * Фикстура собрана на встроенных данных, дрейф не нужен: `orbis/task_status` несёт
   * варианты …/`done` «Сделана»/`cancelled` «Отменена», и дельта добавляет свой
   * `cancelled` с подписью «Сделана». При отставшем `base_version` новыми считаются ВСЕ
   * варианты, и поиск похожего по подписи находит `done` РАНЬШЕ, чем совпавший по ключу
   * `cancelled`. Пока проверка ключа шла внутри этого поиска, слияние оставляло дубль
   * ключа в дельте — и `applyDeltas` отказывал на каждом чтении реестра, а повторный
   * пересев молчал, потому что `base_version` уже переехал.
   */
  test('слитая дельта применима: реестр владельца читается, повторный пересев ничего не добавляет', async () => {
    const { db, client } = adminDb();
    const app = appDb();
    const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
    const owner = crypto.randomUUID();
    try {
      await db.execute(sql`TRUNCATE registry_deltas`);
      await db.execute(sql`
        INSERT INTO registry_deltas (id, owner_id, target_kind, target_id, base_version, delta)
        VALUES (gen_random_uuid(), ${owner}::uuid, 'aspect', 'orbis/task', 1,
                ${JSON.stringify({
                  selectOptions: {
                    'orbis/task_status': {
                      add: [{ key: 'cancelled', label: { ru: 'Сделана' }, rank: 99 }],
                    },
                  },
                })}::jsonb)`);

      const first = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);

      // ГЛАВНОЕ И ПЕРВЫМ: снимок эффективных определений собирается, а не отказывает.
      // Именно эта строка отличает «слияние сработало» от «слияние доложило конфликт и
      // оставило дельту неприменимой», и стоит она ДО проверок текста отчёта намеренно —
      // иначе мутация правила падала бы на формулировке, не дойдя до сути.
      const reg = await withIdentity(app.db, owner, (tx) => effectiveRegistry(tx, owner));
      const status = reg.properties.get('orbis/task_status');
      if (status?.type.kind !== 'select') throw new Error('orbis/task_status перестал быть select');
      expect(status.type.options.filter((o) => o.key === 'cancelled')).toHaveLength(1);
      expect(first.conflicts.map((c) => c.kind)).toEqual(['variant-merge']);
      expect(first.conflicts[0]?.detail).toContain('с тем же ключом');

      // Повторный пересев: дельта уже пуста, добавить ему нечего.
      const again = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      expect(again.conflicts).toEqual([]);
      const rows = (await db.execute(
        sql`SELECT delta FROM registry_deltas WHERE owner_id = ${owner}::uuid`,
      )) as unknown as { delta: unknown }[];
      expect(rows[0]?.delta).toEqual({});
    } finally {
      await db.execute(sql`DELETE FROM registry_deltas WHERE owner_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM chat_messages WHERE thread_id IN
        (SELECT id FROM chat_threads WHERE owner_id = ${owner}::uuid)`);
      await db.execute(sql`DELETE FROM chat_threads WHERE owner_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM user_settings WHERE owner_id = ${owner}::uuid`);
      await app.client.end();
      await raw.end();
      await client.end();
    }
  }, 30_000);

  // Версия проверяется ОТНОСИТЕЛЬНО: `truncateAll` строку registry_system не трогает
  // намеренно (одна строка, PK = 1), а `db:prepare` уже сеял до начала прогона — абсолютное
  // значение здесь зависело бы от того, сколько раз базу готовили.
  /**
   * ФОРМА ПОДПИСКИ ПОЕХАЛА ПОД ЖИВОЙ ДЕЛЬТОЙ (находка B1 I-2). Дельта подписки — полная копия
   * декларации под `.strict()`, а system-строку прошлого релиза сид разбирает ПЕРВОЙ строкой,
   * до всех upsert'ов. Строгий разбор в обоих местах означал бы сид, который падает уже ПОСЛЕ
   * бампа версии и на том самом, что сам же и чинит: повторный прогон падает так же, а владелец
   * заперт на каждом вызове MCP. Проба ставит обе половины разом — устаревшую system-строку и
   * дельту той же устаревшей формы.
   */
  test('устаревшая форма подписки: сид доезжает, строка починена, дельта сброшена на системную', async () => {
    const { db, client } = adminDb();
    const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
    const owner = crypto.randomUUID();
    try {
      await db.execute(sql`TRUNCATE registry_deltas`);
      const baseVersion = await systemVersion(db);
      // Форма ПРОШЛОГО релиза: поля, ставшего обязательным (`alerts.inclusive` — `z.literal(true)`),
      // в ней нет. Ставится и в system-строку, и в дельту владельца.
      await db.execute(sql`
        UPDATE subscription_definitions SET definition = definition #- '{alerts,inclusive}'
         WHERE id = 'orbis/budget-overview' AND owner_id IS NULL`);
      const stale = (
        (await db.execute(
          sql`SELECT definition FROM subscription_definitions
               WHERE id = 'orbis/budget-overview' AND owner_id IS NULL`,
        )) as unknown as { definition: unknown }[]
      )[0]?.definition;
      await db.execute(sql`
        INSERT INTO registry_deltas (id, owner_id, target_kind, target_id, base_version, delta)
        VALUES (gen_random_uuid(), ${owner}::uuid, 'subscription', 'orbis/budget-overview',
                ${baseVersion}, ${JSON.stringify({ definition: stale })}::jsonb)`);

      const result = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      expect(result.conflicts.map((c) => c.kind)).toEqual(['subscription-rebased']);
      // System-строка починена сидом — ровно тем прогоном, который прежде падал бы на ней.
      const fixed = (
        (await db.execute(
          sql`SELECT definition->'alerts'->>'inclusive' AS v FROM subscription_definitions
               WHERE id = 'orbis/budget-overview' AND owner_id IS NULL`,
        )) as unknown as { v: string | null }[]
      )[0]?.v;
      expect(fixed).toBe('true');
      // Дельта сброшена на системную декларацию — и реестр владельца ЧИТАЕТСЯ.
      const app = appDb();
      try {
        const reg = await withIdentity(app.db, owner, (tx) => effectiveRegistry(tx, owner));
        expect(reg.subscriptions.get('orbis/budget-overview')).toBeDefined();
      } finally {
        await app.client.end();
      }
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
        contracts: 6,
        subscriptions: 2,
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
