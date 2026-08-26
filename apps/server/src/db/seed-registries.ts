// apps/server/src/db/seed-registries.ts
//
// Сид ТРЁХ реестров: свойства (§А2-1), роли рёбер (§А4-2), аспекты (§А3-1). Контракты,
// подписки и действия срез А создаёт ПУСТЫМИ таблицами — их сид первый акт среза Б-1,
// после гейта П5 (§А12-1).
//
// Почему модуль, а не два скрипта: сид запускается двумя путями — `bun run db:prepare`
// (локально и в CI, через `scripts/seed-registries.ts`) и `bun scripts/ops.ts
// seed-registries` (прод, с секретом из Ключницы). До реформы эти два пути несли ДВЕ копии
// одного upsert'а (`scripts/seed-aspects.ts` и `ops.ts:166-185`), и разойтись им мешала
// только внимательность. Здесь копия одна.
//
// Мутация реестра ПРЯМОЙ записью в БД — названное планом исключение из правила «только
// через executor» (Р-1): system-строки (`owner_id IS NULL`) ничьи, актора у них нет, и
// executor, который весь построен на владельце и его RLS, писать их не может.
//
// Колонка `symmetric` пишется в кавычках: SYMMETRIC — зарезервированное слово SQL, и без
// кавычек PostgreSQL отвергает список колонок разбором (проверено пробоем).
//
// Идемпотентен: `ON CONFLICT (id) WHERE owner_id IS NULL DO UPDATE` (опора — partial unique
// index `*_builtin_uniq` каждой таблицы). Лишние system-строки НЕ удаляет: строка, которой
// нет в коде, — это дрейф (Р-23) и решение человека («свойство удалили» или «код откатили
// на старую версию»), а не то, что вправе решить сид. Отчёт `ops.ts check` называет такие
// строки поимённо.
import {
  type AspectId,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  legacyAspectJsonSchema,
} from '@orbis/shared';
import type { Sql } from 'postgres';

/**
 * `sql.json` типизирован под `JSONValue` postgres.js, а декларации реестров — обычные
 * доменные типы (у `ref.target`, например, поле объявлено `unknown` до канона Q-AST
 * Задачи 8). Каст один и здесь, а не по месту в двадцати интерполяциях: иначе `as never`
 * расползлось бы по запросам и однажды прикрыло бы настоящее расхождение типа.
 */
type Json = Parameters<Sql['json']>[0];
const j = (v: unknown): Json => v as Json;

export interface SeedRegistriesResult {
  properties: number;
  roles: number;
  aspects: number;
  /** Версия system-реестров ПОСЛЕ сида — она же ключ инвалидации кешей (§А10-1). */
  version: number;
}

/**
 * Пишет встроенные строки трёх реестров и двигает глобальную версию.
 *
 * `sql` — админское подключение: RLS запрещает запись строк с `owner_id IS NULL` любой
 * роли, кроме обходящей политики.
 */
export async function seedRegistries(sql: Sql): Promise<SeedRegistriesResult> {
  for (const p of BUILTIN_PROPERTY_META) {
    await sql`
      INSERT INTO property_definitions
        (id, owner_id, key, label, description, type, status, storage, scope,
         merged_into, module, rank, flags)
      VALUES
        (${p.id}, NULL, ${p.key}, ${sql.json(j(p.label))}, ${sql.json(j(p.description))},
         ${sql.json(j(p.type))}, ${p.status}, ${p.storage},
         ${p.scope === null ? null : sql.json(j(p.scope))},
         ${p.mergedInto}, ${p.module}, ${p.rank}, ${sql.json(j(p.flags))})
      ON CONFLICT (id) WHERE owner_id IS NULL DO UPDATE SET
        key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
        type = EXCLUDED.type, status = EXCLUDED.status, storage = EXCLUDED.storage,
        scope = EXCLUDED.scope, merged_into = EXCLUDED.merged_into,
        module = EXCLUDED.module, rank = EXCLUDED.rank, flags = EXCLUDED.flags`;
  }

  for (const r of BUILTIN_RELATION_ROLE_META) {
    await sql`
      INSERT INTO relation_role_definitions
        (id, owner_id, key, label, description, source_label, target_label,
         hierarchical, constraints, "symmetric", module, rank)
      VALUES
        (${r.id}, NULL, ${r.key}, ${sql.json(j(r.label))}, ${sql.json(j(r.description))},
         ${sql.json(j(r.sourceLabel))}, ${sql.json(j(r.targetLabel))},
         ${r.hierarchical}, ${sql.json(j(r.constraints))}, ${r.symmetric}, ${r.module}, ${r.rank})
      ON CONFLICT (id) WHERE owner_id IS NULL DO UPDATE SET
        key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
        source_label = EXCLUDED.source_label, target_label = EXCLUDED.target_label,
        hierarchical = EXCLUDED.hierarchical, constraints = EXCLUDED.constraints,
        "symmetric" = EXCLUDED."symmetric", module = EXCLUDED.module, rank = EXCLUDED.rank`;
  }

  for (const a of BUILTIN_ASPECT_DEFS) {
    await sql`
      INSERT INTO aspect_definitions
        (id, owner_id, key, label, description, properties, implements, schema,
         ai_instructions, tag_mappings, view_config, module, service, rank)
      VALUES
        (${a.id}, NULL, ${a.key}, ${sql.json(j(a.label))}, ${sql.json(j(a.description))},
         ${sql.json(j(a.properties))}, ${sql.json(j(a.implements))},
         -- Колонка schema — носитель СТАРОЙ формы до миграции 0017 (Р-24): по ней
         -- валидирует стадия 2 исполнителя и из неё собирается вход attach_*-тула.
         ${sql.json(j(legacyAspectJsonSchema(a.id as AspectId)))},
         ${a.aiInstructions}, ${a.tagMappings}, ${sql.json(j(a.viewConfig))},
         ${a.module}, ${a.service}, ${a.rank})
      ON CONFLICT (id) WHERE owner_id IS NULL DO UPDATE SET
        key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
        properties = EXCLUDED.properties, implements = EXCLUDED.implements,
        schema = EXCLUDED.schema, ai_instructions = EXCLUDED.ai_instructions,
        tag_mappings = EXCLUDED.tag_mappings, view_config = EXCLUDED.view_config,
        module = EXCLUDED.module, service = EXCLUDED.service, rank = EXCLUDED.rank`;
  }

  // Версия двигается ПОСЛЕ строк и всегда — даже когда ни одна строка фактически не
  // изменилась. Так «сид был» отличимо от «сида не было» одним числом, а кеши, ключуемые
  // версией, гарантированно переживают пересев (§А10-1); угадывать «а изменилось ли
  // что-то» по числу задетых строк — это как раз тот способ, которым кеш переживает
  // пересев и отдаёт старое определение.
  const [row] = await sql<{ version: number }[]>`
    UPDATE registry_system SET version = version + 1, seeded_at = now()
    WHERE id = 1 RETURNING version`;
  if (row === undefined) {
    // Строку кладёт миграция 0014. Её отсутствие означает базу без миграций — и молчать
    // об этом нельзя: инкремент «не нашёл» строку тихо, а кеши остались бы на нулевой версии.
    throw new Error('seed-registries: в registry_system нет строки id=1 — база без миграции 0014');
  }
  return {
    properties: BUILTIN_PROPERTY_META.length,
    roles: BUILTIN_RELATION_ROLE_META.length,
    aspects: BUILTIN_ASPECT_DEFS.length,
    version: row.version,
  };
}

/** Одна строка отчёта — одинаковая у `db:prepare` и у `ops.ts seed-registries`. */
export function seedRegistriesReport(r: SeedRegistriesResult): string {
  return `seed-registries: свойств ${r.properties}, ролей ${r.roles}, аспектов ${r.aspects}; версия system-реестров ${r.version}`;
}
