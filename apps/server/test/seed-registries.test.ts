// apps/server/test/seed-registries.test.ts
// Приёмка сида ШЕСТИ реестров (§А12-1 п.1, §Б1-1, §Б5-1, §Б6-5) против ЖИВОЙ базы: состав
// system-строк и монотонность версии. Чистые проверки формы деклараций живут в
// packages/shared/src/registry/builtin.test.ts — здесь только то, что видно лишь в БД.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ACTION_DEFS,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  BUILTIN_SUBSCRIPTION_DEFS,
  type RuleDefinition,
  ruleDefinitionSchema,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { readSystemDefinitions, seedRegistries } from '../src/db/seed-registries';
import { withIdentity } from '../src/db/with-identity';
import { execute } from '../src/executor/executor';
import { approvePending } from '../src/policy/pending';
import { effectiveRegistry } from '../src/registry/cache';
import { adminDb, appDb, freshGraph, personal, requireEnv, seedCustomAspect } from './helpers';

requireEnv();

async function ids(db: ReturnType<typeof adminDb>['db'], table: string): Promise<string[]> {
  const rows = (await db.execute(
    sql`SELECT id FROM ${sql.raw(table)} WHERE graph_id IS NULL ORDER BY id`,
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

describe('сид шести реестров', () => {
  test('состав system-строк = ровно BUILTIN_* (77 свойств, 11 ролей, 13 аспектов, 7 контрактов)', async () => {
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
      expect(BUILTIN_CONTRACT_DEFS.length).toBe(7);
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

  // Действия сеются с Б-2 (§Б6-5). Счётчик отдельно от состава — подмена набора равной
  // мощности прошла бы проверку состава молча (тот же довод, что у свойств выше).
  test('сид действий: ровно BUILTIN_ACTION_DEFS', async () => {
    const { db, client } = adminDb();
    try {
      expect(await ids(db, 'action_definitions')).toEqual(
        [...BUILTIN_ACTION_DEFS.map((a) => a.id)].sort(),
      );
      expect(BUILTIN_ACTION_DEFS.length).toBe(2);
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
            WHERE a.graph_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM property_definitions p
                              WHERE p.graph_id IS NULL AND p.id = r.value->>'propertyId')`,
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
            WHERE a.graph_id IS NULL`,
      )) as unknown as { n: number }[];
      // Восемь привязок §Б2-1: две у orbis/schedule, три у orbis/task (третья — делегируемость,
      // задача 14а), две у orbis/financial и одна у orbis/budget. Число названо отдельно от состава
      // (состав пинит снимок B2 в shared).
      expect(count?.n).toBe(8);
      // FK на jsonb не поставить, а `checkImplements` живёт в shared и базы не видит.
      const dangling = (await db.execute(
        sql`SELECT a.id AS aspect_id, b.value->>'contract' AS contract_id
            FROM aspect_definitions a, jsonb_array_elements(a.implements) b
            WHERE a.graph_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM contract_definitions c
                              WHERE c.graph_id IS NULL AND c.id = b.value->>'contract')`,
      )) as unknown as unknown[];
      expect(dangling).toEqual([]);
      const badSlots = (await db.execute(
        sql`SELECT a.id AS aspect_id, kv.slot_name
            FROM aspect_definitions a, jsonb_array_elements(a.implements) b,
                 jsonb_each_text(b.value->'bind') AS kv(slot_name, property_id)
            WHERE a.graph_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM contract_definitions c, jsonb_array_elements(c.slots) sl
                              WHERE c.graph_id IS NULL AND c.id = b.value->>'contract'
                                AND sl.value->>'name' = kv.slot_name)`,
      )) as unknown as unknown[];
      expect(badSlots).toEqual([]);
      const badProps = (await db.execute(
        sql`SELECT a.id AS aspect_id, kv.property_id
            FROM aspect_definitions a, jsonb_array_elements(a.implements) b,
                 jsonb_each_text(b.value->'bind') AS kv(slot_name, property_id)
            WHERE a.graph_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM property_definitions p
                              WHERE p.graph_id IS NULL AND p.id = kv.property_id)`,
      )) as unknown as unknown[];
      expect(badProps).toEqual([]);
    } finally {
      await client.end();
    }
  });

  /** По системной строке на таблицу-носитель: таблица, id и правила этой строки В КОДЕ (эталон пересева). */
  const SPOILED = [
    [
      'property_definitions',
      'orbis/occurred_on',
      BUILTIN_PROPERTY_META.find((p) => p.id === 'orbis/occurred_on')?.rules ?? [],
    ],
    [
      'relation_role_definitions',
      'ref',
      BUILTIN_RELATION_ROLE_META.find((r) => r.id === 'ref')?.rules ?? [],
    ],
    [
      'aspect_definitions',
      'orbis/task',
      BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/task')?.rules ?? [],
    ],
  ] as const;

  test('сид кладёт rules всех трёх носителей: колонка ПИШЕТСЯ и её содержимое — правила каталога', async () => {
    const { db, client } = adminDb();
    try {
      // Пин БЕЗ СЧЁТА: «строк с непустым `rules` ноль» верно ровно до задачи 4 и краснело бы у неё, у 12,
      // 13 и 14 — то есть был бы пином календаря, а не инварианта. Инвариант же держится на всём срезе:
      // у каждой системной строки колонка — МАССИВ, и каждый его элемент разбирается формой правила.
      for (const table of [
        'property_definitions',
        'aspect_definitions',
        'relation_role_definitions',
      ]) {
        const rows = (await db.execute(sql`SELECT id, rules FROM ${sql.raw(table)}
          WHERE graph_id IS NULL ORDER BY id`)) as unknown as { id: string; rules: unknown }[];
        for (const r of rows) {
          expect([table, r.id, Array.isArray(r.rules)]).toEqual([table, r.id, true]);
          for (const rule of r.rules as unknown[]) {
            const parsed = ruleDefinitionSchema.safeParse(rule);
            expect(`${r.id}: ${parsed.success}`).toBe(`${r.id}: true`);
          }
        }
      }
      // Ручная порча перетирается пересевом — иначе «сид положил» и «в базе лежит» разошлись бы молча.
      // Порча — по строке в КАЖДОЙ таблице-носителе: у каждой свой upsert и свой `DO UPDATE SET`, и строка
      // `rules = EXCLUDED.rules`, потерянная у одного из трёх, иначе не краснила бы ничего (ревью задачи 2).
      // Сверка — с КОДОМ, а не с литералом `[]`: после задачи 4 у `orbis/task` появится правило, и литерал
      // пришлось бы пересдавать четырежды за срез. `graph_id IS NULL` — чтобы не задеть свою строку-
      // перекрытие владельца с тем же id, если её оставил соседний сьют (сид её не чинит).
      for (const [table, id] of SPOILED) {
        await db.execute(
          sql`UPDATE ${sql.raw(table)} SET rules = '[{"id":"x"}]'::jsonb
              WHERE id = ${id} AND graph_id IS NULL`,
        );
      }
      // Подключение — по образцу пересева под живой дельтой (ниже в этом describe).
      const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
      try {
        await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      } finally {
        await raw.end();
      }
      for (const [table, id, code] of SPOILED) {
        const after = (await db.execute(
          sql`SELECT rules FROM ${sql.raw(table)} WHERE id = ${id} AND graph_id IS NULL`,
        )) as unknown as { rules: unknown }[];
        expect([table, id, after[0]?.rules]).toEqual([table, id, code]);
      }
    } finally {
      // Сеть безопасности (как `restoreRegistries` в registry-drift.test.ts): если пересев порчу НЕ
      // перетёр, тест уже красен, но `[{"id":"x"}]` в system-строке уронил бы строгий разбор снимка
      // (`registry/load.ts`) у ВСЕХ следующих сьютов прогона — отказ обязан остаться локальным.
      for (const [table, id, code] of SPOILED) {
        await db.execute(
          sql`UPDATE ${sql.raw(table)} SET rules = ${JSON.stringify(code)}::jsonb
              WHERE id = ${id} AND graph_id IS NULL`,
        );
      }
      await client.end();
    }
  });

  test('сид кладёт exclusive_classes контрактов — значением из кода, а не умолчанием колонки (Р-К-92)', async () => {
    const { db, client } = adminDb();
    try {
      // Сверка построчная и С КОДОМ: `orbis/delegable` задачи 14а приедет с `true`, и пин «у всех false»
      // покраснел бы у неё — при том что ловить он обязан ровно обратное: расхождение базы с кодом.
      const rows = (await db.execute(sql`SELECT id, exclusive_classes FROM contract_definitions
        WHERE graph_id IS NULL ORDER BY id`)) as unknown as {
        id: string;
        // `unknown`, а не `boolean`: значение из базы и есть предмет проверки, а ожидание — `Map.get`.
        exclusive_classes: unknown;
      }[];
      const inCode = new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c.exclusive_classes]));
      for (const r of rows) expect([r.id, r.exclusive_classes]).toEqual([r.id, inCode.get(r.id)]);
      // Ручная порча перетирается пересевом — иначе флаг из кода терялся бы молча.
      await db.execute(
        sql`UPDATE contract_definitions SET exclusive_classes = true
            WHERE id = 'orbis/completable' AND graph_id IS NULL`,
      );
      const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
      try {
        await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      } finally {
        await raw.end();
      }
      const after = (await db.execute(
        sql`SELECT exclusive_classes FROM contract_definitions
            WHERE id = 'orbis/completable' AND graph_id IS NULL`,
      )) as unknown as { exclusive_classes: unknown }[];
      expect(after[0]?.exclusive_classes).toBe(inCode.get('orbis/completable'));
    } finally {
      // Сеть безопасности: поднятый флаг, не перетёртый пересевом, иначе пережил бы этот тест и
      // дал бы дрейф `exclusive_classes` каждому следующему сьюту прогона.
      const code = BUILTIN_CONTRACT_DEFS.find(
        (c) => c.id === 'orbis/completable',
      )?.exclusive_classes;
      await db.execute(
        sql`UPDATE contract_definitions SET exclusive_classes = ${code ?? false}
            WHERE id = 'orbis/completable' AND graph_id IS NULL`,
      );
      await client.end();
    }
  });

  // Сторона «до» слияния — ПОЛНАЯ строка (§А3-3): без `rules` задача 16 видела бы «система добавила правило» на
  // каждом пересеве, без флага — читала бы его как снятый. Сегодня системных правил нет и флаг у всех `false`,
  // поэтому снятая из SELECT колонка дала бы ровно умолчания схемы — значения здесь те, которых умолчание не даёт.
  test('сторона «до» слияния читает rules и exclusive_classes из базы, а не умолчанием схемы', async () => {
    const { db, client } = adminDb();
    const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
    const rule: RuleDefinition = {
      id: 'before_probe',
      template: 'requires_when',
      enabled: true,
      undo: 'check',
      params: { property: 'orbis/occurred_on' },
    };
    try {
      await db.execute(sql`UPDATE aspect_definitions SET rules = ${JSON.stringify([rule])}::jsonb
        WHERE id = 'orbis/task' AND graph_id IS NULL`);
      await db.execute(sql`UPDATE property_definitions SET rules = ${JSON.stringify([rule])}::jsonb
        WHERE id = 'orbis/occurred_on' AND graph_id IS NULL`);
      await db.execute(sql`UPDATE contract_definitions SET exclusive_classes = true
        WHERE id = 'orbis/completable' AND graph_id IS NULL`);
      const before = await readSystemDefinitions(raw);
      expect(before.aspects.get('orbis/task')?.rules).toEqual([rule]);
      expect(before.properties.get('orbis/occurred_on')?.rules).toEqual([rule]);
      expect(before.contracts.get('orbis/completable')?.exclusive_classes).toBe(true);
    } finally {
      // Возврат к КОДУ прямыми UPDATE, а не пересевом: пересев слил бы чужие дельты против этой порчи.
      const code = (id: string) => BUILTIN_ASPECT_DEFS.find((a) => a.id === id)?.rules ?? [];
      const propCode = BUILTIN_PROPERTY_META.find((p) => p.id === 'orbis/occurred_on')?.rules ?? [];
      const flag = BUILTIN_CONTRACT_DEFS.find(
        (c) => c.id === 'orbis/completable',
      )?.exclusive_classes;
      await db.execute(sql`UPDATE aspect_definitions SET rules = ${JSON.stringify(code('orbis/task'))}::jsonb
        WHERE id = 'orbis/task' AND graph_id IS NULL`);
      await db.execute(sql`UPDATE property_definitions SET rules = ${JSON.stringify(propCode)}::jsonb
        WHERE id = 'orbis/occurred_on' AND graph_id IS NULL`);
      await db.execute(sql`UPDATE contract_definitions SET exclusive_classes = ${flag ?? false}
        WHERE id = 'orbis/completable' AND graph_id IS NULL`);
      await raw.end();
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
    const owner = await freshGraph();
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
        INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
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
         WHERE id = 'orbis/task' AND graph_id IS NULL`);
      await db.execute(sql`
        UPDATE property_definitions
           SET type = jsonb_set(type, '{options}',
                 (SELECT jsonb_agg(e) FROM jsonb_array_elements(type->'options') e
                   WHERE e->>'key' <> 'cancelled'))
         WHERE id = 'orbis/task_status' AND graph_id IS NULL`);

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
        sql`SELECT delta, base_version FROM registry_deltas WHERE graph_id = ${owner}::uuid`,
      )) as unknown as { delta: unknown; base_version: number }[];
      expect(rows[0]?.delta).toEqual({ label: { ru: 'Дело' } });
      expect(rows[0]?.base_version).toBe(result.version);

      // Версия ВЛАДЕЛЬЦА сдвинута тем же коммитом (§А10-1): его дельта изменилась, и кеш
      // эффективных определений обязан это заметить.
      const settings = (await db.execute(
        sql`SELECT registry_version FROM user_settings WHERE graph_id = ${owner}::uuid`,
      )) as unknown as { registry_version: number }[];
      expect(settings[0]?.registry_version).toBe(1);

      // Системная заметка в ГЛОБАЛЬНОМ треде владельца — единственный след, который увидит
      // человек (единицы пачки D42 — Задача 15).
      const notes = (await db.execute(
        sql`SELECT m.role, m.content, m.metadata
              FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
             WHERE t.graph_id = ${owner}::uuid AND t.entity_id IS NULL`,
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
                 WHERE t.graph_id = ${owner}::uuid`,
          )) as unknown as { n: number }[]
        )[0]?.n,
      ).toBe(1);
    } finally {
      await db.execute(sql`DELETE FROM registry_deltas WHERE graph_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM chat_messages WHERE thread_id IN
        (SELECT id FROM chat_threads WHERE graph_id = ${owner}::uuid)`);
      await db.execute(sql`DELETE FROM chat_threads WHERE graph_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM user_settings WHERE graph_id = ${owner}::uuid`);
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
    const owner = await freshGraph();
    try {
      await db.execute(sql`TRUNCATE registry_deltas`);
      // base_version НАМЕРЕННО отстал на несколько прогонов; система при этом в порядке.
      await db.execute(sql`
        INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
        VALUES (gen_random_uuid(), ${owner}::uuid, 'aspect', 'orbis/task', 1,
                ${JSON.stringify({ properties: { hide: ['orbis/task_status'] } })}::jsonb)`);

      const result = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      // Скрытие ОБЯЗАТЕЛЬНОГО свойства доложено конфликтом и снято — а не уехало молча.
      expect(result.conflicts.map((c) => c.kind)).toEqual(['hidden-required']);
      expect(result.conflicts[0]?.propertyId).toBe('orbis/task_status');
      const rows = (await db.execute(
        sql`SELECT delta, base_version FROM registry_deltas WHERE graph_id = ${owner}::uuid`,
      )) as unknown as { delta: unknown; base_version: number }[];
      expect(rows[0]?.delta).toEqual({});
      expect(rows[0]?.base_version).toBe(result.version);
      // Владельцу сказано той же транзакцией.
      const notes = (await db.execute(
        sql`SELECT m.metadata FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
             WHERE t.graph_id = ${owner}::uuid`,
      )) as unknown as { metadata: Record<string, unknown> }[];
      expect(notes).toHaveLength(1);
      expect(notes[0]?.metadata.type).toBe('registry-merge');
    } finally {
      await db.execute(sql`DELETE FROM registry_deltas WHERE graph_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM chat_messages WHERE thread_id IN
        (SELECT id FROM chat_threads WHERE graph_id = ${owner}::uuid)`);
      await db.execute(sql`DELETE FROM chat_threads WHERE graph_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM user_settings WHERE graph_id = ${owner}::uuid`);
      await raw.end();
      await client.end();
    }
  }, 30_000);

  /**
   * ПРАВИЛА ВЛАДЕЛЬЦА ПЕРЕЖИВАЮТ ПЕРЕСЕВ (задача 16, §А3-3, Р-И-35) — боевым путём сида. Своё правило
   * дельты и отключение системного едут через слияние как есть; `base_version` переезжает на новую
   * системную версию, а эффективный снимок владельца после пересева их по-прежнему несёт.
   */
  test('правила владельца переживают пересев: своё правило и отключение системного на месте', async () => {
    const { db, client } = adminDb();
    const app = appDb();
    const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
    const owner = await freshGraph();
    const mine = {
      id: 'my_task_needs_due',
      template: 'requires_when',
      params: { property: 'orbis/due_date' },
      when: { op: '=', args: [{ prop: 'orbis/priority' }, { const: 'high' }] },
      enabled: true,
      undo: 'check',
    };
    try {
      await db.execute(sql`TRUNCATE registry_deltas`);
      const baseVersion = await systemVersion(db);
      await db.execute(sql`
        INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
        VALUES (gen_random_uuid(), ${owner}::uuid, 'aspect', 'orbis/task', ${baseVersion},
                ${JSON.stringify({ rules: [mine], rulesDisabled: ['task_completed_at'] })}::jsonb)`);
      const result = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      expect(result.mergedDeltas).toBe(1);
      expect(result.conflicts).toEqual([]);
      const rows = (await db.execute(
        sql`SELECT delta, base_version FROM registry_deltas WHERE graph_id = ${owner}::uuid`,
      )) as unknown as { delta: unknown; base_version: number }[];
      expect(rows[0]?.delta).toEqual({ rules: [mine], rulesDisabled: ['task_completed_at'] });
      expect(rows[0]?.base_version).toBe(result.version);
      const reg = await withIdentity(app.db, personal(owner), (tx) => effectiveRegistry(tx, owner));
      const ids = reg.aspects.get('orbis/task')?.rules.map((r) => r.id) ?? [];
      expect(ids).toContain('my_task_needs_due');
      expect(ids).not.toContain('task_completed_at');
    } finally {
      await db.execute(sql`DELETE FROM registry_deltas WHERE graph_id = ${owner}::uuid`);
      await raw.end();
      await app.client.end();
      await client.end();
    }
  }, 30_000);

  /**
   * НОВОЕ СИСТЕМНОЕ ПРАВИЛО-КОНКУРЕНТ НА ПЕРЕСЕВЕ (Р-И-35) — боевым путём целиком: дрейф «до» (в базе у
   * `orbis/task` нет `task_completed_at`), своё правило пишет то же (`orbis/completed_at` при входе в
   * `done`), пересев приносит системное из кода. Своё ОТКЛЮЧАЕТСЯ (не снимается), владелец получает
   * заметку и единицу пачки; «Принять» меняет отключения местами обычным конвейером.
   */
  test('пересев завёл системное правило-конкурента: своё отключено, единица пачки, «Принять» меняет местами', async () => {
    const { db, client } = adminDb();
    const app = appDb();
    const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
    const owner = await freshGraph();
    const mine = {
      id: 'my_completed_at',
      template: 'on_enter_class',
      params: {
        enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
        set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
      },
      enabled: true,
      undo: 'check',
    };
    try {
      await db.execute(sql`TRUNCATE registry_deltas`);
      await db.execute(sql`
        UPDATE aspect_definitions
           SET rules = (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(rules) e
                         WHERE e->>'id' <> 'task_completed_at')
         WHERE id = 'orbis/task' AND graph_id IS NULL`);
      const baseVersion = await systemVersion(db);
      await db.execute(sql`
        INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
        VALUES (gen_random_uuid(), ${owner}::uuid, 'aspect', 'orbis/task', ${baseVersion},
                ${JSON.stringify({ rules: [mine] })}::jsonb)`);
      const result = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      expect(result.conflicts.map((c) => [c.kind, c.rule])).toEqual([
        ['rule-conflict', { mine: 'my_completed_at', theirs: 'task_completed_at' }],
      ]);
      const rows = (await db.execute(
        sql`SELECT delta FROM registry_deltas WHERE graph_id = ${owner}::uuid`,
      )) as unknown as { delta: unknown }[];
      // Декларация осталась, исполнение выключено: «отключить», а не «стереть» (§С3).
      expect(rows[0]?.delta).toEqual({ rules: [mine], rulesDisabled: ['my_completed_at'] });
      const pending = (await db.execute(
        sql`SELECT id, metadata FROM chat_messages m
             WHERE m.thread_id IN (SELECT id FROM chat_threads WHERE graph_id = ${owner}::uuid)
               AND metadata ? 'pending'`,
      )) as unknown as { id: string; metadata: { pending: { tool: string } } }[];
      // Пачка двух тулов правил: отключить конкурента там, где он живёт, и завести своё заново.
      expect(pending.map((p) => p.metadata.pending.tool)).toEqual(['batch_execute']);
      const approved = await approvePending(app.db, {
        identity: personal(owner),
        pendingId: pending[0]?.id as string,
      });
      expect(approved.ok).toBe(true);
      const reg = await withIdentity(app.db, personal(owner), (tx) => effectiveRegistry(tx, owner));
      const ids = reg.aspects.get('orbis/task')?.rules.map((r) => r.id) ?? [];
      expect(ids).toContain('my_completed_at');
      expect(ids).not.toContain('task_completed_at');
    } finally {
      await db.execute(sql`DELETE FROM registry_deltas WHERE graph_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM chat_messages WHERE thread_id IN
        (SELECT id FROM chat_threads WHERE graph_id = ${owner}::uuid)`);
      await db.execute(sql`DELETE FROM chat_threads WHERE graph_id = ${owner}::uuid`);
      // Системная строка обязана вернуться к коду при любом исходе теста (сид выше её уже починил;
      // упавший ДО сида тест оставил бы дрейф — чинится повтором сида).
      await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      await raw.end();
      await app.client.end();
      await client.end();
    }
  }, 60_000);

  /**
   * КЛЮЧ КОНФЛИКТА ГЛОБАЛЕН (Ф-Б2-28, проба P1 гейта 16) — боевым путём сида: своё правило лежит в дельте
   * ЗАМЕТКИ, системный конкурент приходит на ЗАДАЧУ. Прежний пересев искал конкурента только в строке-цели и
   * оставлял движку двух писателей; теперь своё отключено, единица отключает конкурента на его носителе, а
   * слияние свойств после этого не принимает чужой конфликт за свой.
   */
  test('пересев: конкурент на ДРУГОМ носителе — своё отключено, единица, «Принять»; слияние свойств не отказывает ложно', async () => {
    const { db, client } = adminDb();
    const app = appDb();
    const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
    const owner = await freshGraph();
    const mine = {
      id: 'note_completed_at',
      template: 'on_enter_class',
      params: {
        enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
        set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
      },
      enabled: true,
      undo: 'check',
    };
    try {
      await db.execute(sql`TRUNCATE registry_deltas`);
      await db.execute(sql`
        UPDATE aspect_definitions
           SET rules = (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(rules) e
                         WHERE e->>'id' <> 'task_completed_at')
         WHERE id = 'orbis/task' AND graph_id IS NULL`);
      const baseVersion = await systemVersion(db);
      await db.execute(sql`
        INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
        VALUES (gen_random_uuid(), ${owner}::uuid, 'aspect', 'orbis/note', ${baseVersion},
                ${JSON.stringify({ rules: [mine] })}::jsonb)`);
      const result = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      expect(result.conflicts.map((c) => [c.kind, c.targetId, c.rule])).toEqual([
        [
          'rule-conflict',
          'orbis/note',
          {
            mine: 'note_completed_at',
            theirs: 'task_completed_at',
            theirsAt: { kind: 'aspect', id: 'orbis/task' },
          },
        ],
      ]);
      const pending = (await db.execute(
        sql`SELECT id, metadata FROM chat_messages m
             WHERE m.thread_id IN (SELECT id FROM chat_threads WHERE graph_id = ${owner}::uuid)
               AND metadata ? 'pending'`,
      )) as unknown as {
        id: string;
        metadata: { pending: { input: { operations: unknown[] } } };
      }[];
      expect(pending[0]?.metadata.pending.input.operations).toEqual([
        {
          tool: 'rule_remove',
          input: { target: { aspect: 'orbis/task' }, rule: 'task_completed_at' },
        },
        { tool: 'rule_set', input: { target: { aspect: 'orbis/note' }, rule: mine } },
      ]);
      // До «Принять» — у движка ровно один писатель: своё выключено.
      const regOf = () =>
        withIdentity(app.db, personal(owner), (tx) => effectiveRegistry(tx, owner));
      expect((await regOf()).aspects.get('orbis/note')?.rules.map((r) => r.id)).toEqual([]);
      // Слияние своих свойств не принимает чужого конфликта за свой (мерка — прирост).
      const prop = async (key: string) => {
        const r = await execute(app.db, {
          identity: personal(owner),
          actorKind: 'owner',
          source: 'ui',
          operations: [
            {
              tool: 'property_create',
              input: {
                key,
                label: { ru: key },
                description: { ru: key },
                type: { kind: 'number' },
                status: 'active',
              },
            },
          ],
        });
        if (!r.ok) throw new Error(r.error.message);
        return (r.results[0] as { property: string }).property;
      };
      const [a, b] = [await prop('user/merge-a'), await prop('user/merge-b')];
      const merged = await execute(app.db, {
        identity: personal(owner),
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'property_merge', input: { source: a, into: b } }],
      });
      expect(merged.ok).toBe(true);
      const approved = await approvePending(app.db, {
        identity: personal(owner),
        pendingId: pending[0]?.id as string,
      });
      expect(approved.ok).toBe(true);
      const reg = await regOf();
      expect(reg.aspects.get('orbis/note')?.rules.map((r) => r.id)).toEqual(['note_completed_at']);
      expect(reg.aspects.get('orbis/task')?.rules.map((r) => r.id)).not.toContain(
        'task_completed_at',
      );
    } finally {
      await db.execute(sql`DELETE FROM registry_deltas WHERE graph_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM chat_messages WHERE thread_id IN
        (SELECT id FROM chat_threads WHERE graph_id = ${owner}::uuid)`);
      await db.execute(sql`DELETE FROM chat_threads WHERE graph_id = ${owner}::uuid`);
      await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      await raw.end();
      await app.client.end();
      await client.end();
    }
  }, 60_000);

  /**
   * ГРАНИЦА «СВОЯ СТРОКА × НОВОЕ СИСТЕМНОЕ» (m-A фикс-раунда 2, Ф-Б2-28): сид строк владельца не пишет, и правило
   * своей строки он не выключает — но и не молчит. Новый конфликт писателей и совпавший id уходят заметкой в
   * глобальный тред владельца, единиц нет, строка владельца не тронута; повторный пересев той же системы
   * заметку не повторяет (сверка с прежней системой).
   */
  test('пересев против правил СВОЕЙ строки: заметка о конфликте и о совпавшем id, без единиц и без правки строки', async () => {
    const { db, client } = adminDb();
    const raw = postgres(process.env.DATABASE_URL_ADMIN as string, { max: 1 });
    const owner = await freshGraph();
    const ownRules = [
      {
        id: 'legacy_completed_at',
        template: 'on_enter_class' as const,
        params: {
          enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
          set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
        },
      },
      {
        id: 'task_completed_at',
        template: 'requires_when' as const,
        params: { property: 'orbis/due_date' },
      },
    ];
    try {
      await db.execute(sql`
        UPDATE aspect_definitions
           SET rules = (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(rules) e
                         WHERE e->>'id' <> 'task_completed_at')
         WHERE id = 'orbis/task' AND graph_id IS NULL`);
      await seedCustomAspect(owner, {
        key: 'user/own-writer',
        label: { ru: 'Свой писатель' },
        properties: [{ key: 'ow-mark', type: { kind: 'boolean' } }],
        rules: ownRules,
      });
      const result = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      const mine = result.ownRowConflicts.filter((c) => c.targetId === 'user/own-writer');
      expect(mine.map((c) => [c.kind, c.targetKind, c.rule])).toEqual([
        ['rule-conflict', 'aspect', undefined],
        ['rule-conflict', 'aspect', undefined],
      ]);
      expect(mine.map((c) => c.detail).join('\n')).toContain('«legacy_completed_at»');
      expect(mine.map((c) => c.detail).join('\n')).toContain('с тем же именем «task_completed_at»');
      const notes = (await db.execute(
        sql`SELECT m.metadata FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
             WHERE t.graph_id = ${owner}::uuid`,
      )) as unknown as { metadata: Record<string, unknown> }[];
      expect(notes.map((n) => n.metadata.type)).toEqual(['registry-own-rules']);
      // Строка владельца не тронута: сид её не пишет.
      const row = (await db.execute(
        sql`SELECT rules FROM aspect_definitions WHERE graph_id = ${owner}::uuid AND id = 'user/own-writer'`,
      )) as unknown as { rules: Array<{ id: string; enabled?: boolean }> }[];
      expect(row[0]?.rules.map((r) => r.id)).toEqual(['legacy_completed_at', 'task_completed_at']);
      // Повторный пересев той же системы — без новой заметки.
      const again = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      expect(again.ownRowConflicts.filter((c) => c.targetId === 'user/own-writer')).toEqual([]);
    } finally {
      await db.execute(sql`DELETE FROM chat_messages WHERE thread_id IN
        (SELECT id FROM chat_threads WHERE graph_id = ${owner}::uuid)`);
      await db.execute(sql`DELETE FROM chat_threads WHERE graph_id = ${owner}::uuid`);
      await db.execute(
        sql`UPDATE aspect_definitions SET rules = '[]'::jsonb WHERE graph_id = ${owner}::uuid`,
      );
      await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      await raw.end();
      await client.end();
    }
  }, 60_000);

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
    const owner = await freshGraph();
    try {
      await db.execute(sql`TRUNCATE registry_deltas`);
      await db.execute(sql`
        INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
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
      const reg = await withIdentity(app.db, personal(owner), (tx) => effectiveRegistry(tx, owner));
      const status = reg.properties.get('orbis/task_status');
      if (status?.type.kind !== 'select') throw new Error('orbis/task_status перестал быть select');
      expect(status.type.options.filter((o) => o.key === 'cancelled')).toHaveLength(1);
      expect(first.conflicts.map((c) => c.kind)).toEqual(['variant-merge']);
      expect(first.conflicts[0]?.detail).toContain('с тем же ключом');

      // Повторный пересев: дельта уже пуста, добавить ему нечего.
      const again = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      expect(again.conflicts).toEqual([]);
      const rows = (await db.execute(
        sql`SELECT delta FROM registry_deltas WHERE graph_id = ${owner}::uuid`,
      )) as unknown as { delta: unknown }[];
      expect(rows[0]?.delta).toEqual({});
    } finally {
      await db.execute(sql`DELETE FROM registry_deltas WHERE graph_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM chat_messages WHERE thread_id IN
        (SELECT id FROM chat_threads WHERE graph_id = ${owner}::uuid)`);
      await db.execute(sql`DELETE FROM chat_threads WHERE graph_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM user_settings WHERE graph_id = ${owner}::uuid`);
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
    const owner = await freshGraph();
    try {
      await db.execute(sql`TRUNCATE registry_deltas`);
      const baseVersion = await systemVersion(db);
      // Форма ПРОШЛОГО релиза: поля, ставшего обязательным (`alerts.inclusive` — `z.literal(true)`),
      // в ней нет. Ставится и в system-строку, и в дельту владельца.
      await db.execute(sql`
        UPDATE subscription_definitions SET definition = definition #- '{alerts,inclusive}'
         WHERE id = 'orbis/budget-overview' AND graph_id IS NULL`);
      const stale = (
        (await db.execute(
          sql`SELECT definition FROM subscription_definitions
               WHERE id = 'orbis/budget-overview' AND graph_id IS NULL`,
        )) as unknown as { definition: unknown }[]
      )[0]?.definition;
      await db.execute(sql`
        INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
        VALUES (gen_random_uuid(), ${owner}::uuid, 'subscription', 'orbis/budget-overview',
                ${baseVersion}, ${JSON.stringify({ definition: stale })}::jsonb)`);

      const result = await seedRegistries(raw, process.env.DATABASE_URL_ADMIN as string);
      expect(result.conflicts.map((c) => c.kind)).toEqual(['subscription-rebased']);
      // System-строка починена сидом — ровно тем прогоном, который прежде падал бы на ней.
      const fixed = (
        (await db.execute(
          sql`SELECT definition->'alerts'->>'inclusive' AS v FROM subscription_definitions
               WHERE id = 'orbis/budget-overview' AND graph_id IS NULL`,
        )) as unknown as { v: string | null }[]
      )[0]?.v;
      expect(fixed).toBe('true');
      // Дельта сброшена на системную декларацию — и реестр владельца ЧИТАЕТСЯ.
      const app = appDb();
      try {
        const reg = await withIdentity(app.db, personal(owner), (tx) =>
          effectiveRegistry(tx, owner),
        );
        expect(reg.subscriptions.get('orbis/budget-overview')).toBeDefined();
      } finally {
        await app.client.end();
      }
    } finally {
      await db.execute(sql`DELETE FROM registry_deltas WHERE graph_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM chat_messages WHERE thread_id IN
        (SELECT id FROM chat_threads WHERE graph_id = ${owner}::uuid)`);
      await db.execute(sql`DELETE FROM chat_threads WHERE graph_id = ${owner}::uuid`);
      await db.execute(sql`DELETE FROM user_settings WHERE graph_id = ${owner}::uuid`);
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
        contracts: 7,
        subscriptions: 2,
        actions: 2,
        version: before + 1,
        mergedDeltas: 0,
        conflicts: [],
        ownRowConflicts: [],
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
