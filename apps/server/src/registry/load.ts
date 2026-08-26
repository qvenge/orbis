// apps/server/src/registry/load.ts
//
// Снимок эффективных реестров владельца: system-строки ⊕ его собственные. Один раз на
// транзакцию исполнителя — рядом с `loadAspectRegistry` (executor.ts:283/:385), которую он
// со временем заменит целиком.
//
// ДЕЛЬТ здесь ещё нет: `registry_deltas` заводит эта же миграция, но применяет их Задача 14
// (там же появится и кеш по ключу `(owner, version)`). Версии снимаются уже сейчас — обе,
// системная и владельца: без них кеш нечем будет инвалидировать, а снимать их задним
// числом значит второй раз обходить те же таблицы.
//
// Строки ПРОХОДЯТ через строгие схемы `@orbis/shared`: реестр, который сам не разбирается
// собственной схемой, до валидации данных доезжать не должен. Отказ здесь — fail-closed:
// лучше громкая ошибка на первом запросе, чем валидация записей по кривому определению.
import {
  type AspectDefinition,
  aspectDefinitionSchema,
  type PropertyDefinition,
  propertyDefinitionSchema,
  type RelationRoleDefinition,
  relationRoleDefinitionSchema,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';

export interface RegistrySnapshot {
  properties: Map<string, PropertyDefinition>;
  aspects: Map<string, AspectDefinition>;
  roles: Map<string, RelationRoleDefinition>;
  /** `user_settings.registry_version`; 0 — у владельца ещё нет строки настроек. */
  ownerVersion: number;
  /** `registry_system.version` — её двигает сид (§А10-1). */
  systemVersion: number;
}

/** Строка любого реестра как её отдаёт SELECT: ключи — имена колонок (snake_case). */
interface Row {
  [column: string]: unknown;
}

/**
 * ORDER BY owner_id NULLS FIRST: при коллизии id собственное определение ПЕРЕКРЫВАЕТ
 * встроенное — так же, как `loadAspectRegistry` сегодня. Уникальность БД этого не
 * запрещает и не должна: частичные индексы разведены по `owner_id IS NULL` / `IS NOT NULL`
 * именно ради переопределения (на нём стоит и сегодняшний кастомный `orbis/note`).
 * Запрещена только ВТОРАЯ своя строка с тем же id — её ловит `*_custom_uniq`.
 *
 * RLS сама скоупит выдачу под `withIdentity`, но условие по `owner_id` стоит и в запросе:
 * снимок обязан быть одинаковым и под админским подключением (сиды, миграции, скрипты),
 * где политик нет вовсе.
 */
export async function loadRegistry(tx: Tx, ownerId: string): Promise<RegistrySnapshot> {
  // Запросы идут ПОСЛЕДОВАТЕЛЬНО, а не Promise.all: транзакция живёт на одном соединении,
  // и параллельные запросы по нему сериализуются в лучшем случае, а в худшем — путают
  // порядок с `SET LOCAL`. Реестров три, каждый — один индексный проход.
  const propertyRows = (await tx.execute(sql`
    SELECT id, owner_id, key, label, description, type, status, storage,
           scope, merged_into, module, rank, flags
    FROM property_definitions
    WHERE owner_id IS NULL OR owner_id = ${ownerId}::uuid
    ORDER BY owner_id NULLS FIRST`)) as unknown as Row[];
  const aspectRows = (await tx.execute(sql`
    SELECT id, owner_id, key, label, description, properties, ai_instructions,
           tag_mappings, implements, view_config, module, service, rank
    FROM aspect_definitions
    WHERE owner_id IS NULL OR owner_id = ${ownerId}::uuid
    ORDER BY owner_id NULLS FIRST`)) as unknown as Row[];
  const roleRows = (await tx.execute(sql`
    SELECT id, owner_id, key, label, description, source_label, target_label,
           hierarchical, constraints, "symmetric", module, rank
    FROM relation_role_definitions
    WHERE owner_id IS NULL OR owner_id = ${ownerId}::uuid
    ORDER BY owner_id NULLS FIRST`)) as unknown as Row[];
  const ownerRows = (await tx.execute(
    sql`SELECT registry_version FROM user_settings WHERE owner_id = ${ownerId}::uuid`,
  )) as unknown as Row[];
  const systemRows = (await tx.execute(
    sql`SELECT version FROM registry_system WHERE id = 1`,
  )) as unknown as Row[];

  const properties = new Map<string, PropertyDefinition>();
  for (const r of propertyRows) {
    properties.set(
      r.id as string,
      propertyDefinitionSchema.parse({
        id: r.id,
        ownerId: r.owner_id,
        key: r.key,
        label: r.label,
        description: r.description,
        type: r.type,
        status: r.status,
        storage: r.storage,
        scope: r.scope,
        mergedInto: r.merged_into,
        module: r.module,
        rank: r.rank,
        flags: r.flags,
      }),
    );
  }

  const aspects = new Map<string, AspectDefinition>();
  for (const r of aspectRows) {
    aspects.set(
      r.id as string,
      aspectDefinitionSchema.parse({
        id: r.id,
        ownerId: r.owner_id,
        key: r.key,
        label: r.label,
        description: r.description,
        properties: r.properties,
        aiInstructions: r.ai_instructions,
        tagMappings: r.tag_mappings,
        implements: r.implements,
        viewConfig: r.view_config,
        module: r.module,
        service: r.service,
        rank: r.rank,
      }),
    );
  }

  const roles = new Map<string, RelationRoleDefinition>();
  for (const r of roleRows) {
    roles.set(
      r.id as string,
      relationRoleDefinitionSchema.parse({
        id: r.id,
        ownerId: r.owner_id,
        key: r.key,
        label: r.label,
        description: r.description,
        sourceLabel: r.source_label,
        targetLabel: r.target_label,
        hierarchical: r.hierarchical,
        constraints: r.constraints,
        symmetric: r.symmetric,
        module: r.module,
        rank: r.rank,
      }),
    );
  }

  const ownerRow = ownerRows[0];
  const systemRow = systemRows[0];
  return {
    properties,
    aspects,
    roles,
    // Строки настроек может не быть вовсе (владелец не проходил онбординг) — это законный
    // случай, а не отказ: реестр у него ровно системный, и версия его половины нулевая.
    ownerVersion: (ownerRow?.registry_version as number | undefined) ?? 0,
    // А вот системной строки не быть НЕ может: её кладёт миграция 0014. Молча подставить
    // ноль значило бы выдать «база без миграций» за «сида ещё не было».
    systemVersion: (() => {
      if (systemRow === undefined) {
        throw new Error('loadRegistry: в registry_system нет строки id=1 — база без миграции 0014');
      }
      return systemRow.version as number;
    })(),
  };
}
