// apps/server/src/registry/load.ts
//
// СЫРОЕ ЧТЕНИЕ реестров владельца: system-строки ⊕ его собственные, БЕЗ дельт и БЕЗ кеша.
// Единственный вызывающий — `registry/cache.ts`, который накладывает поверх этих строк
// дельты (§А3-2) и держит процессный кеш по версии (§А10-1).
//
// Почему функция названа `loadRegistryRows`, а не `loadRegistry`. Разница между «строки как
// они лежат» и «эффективное определение» наблюдаема: скрытое дельтой свойство здесь ЕСТЬ, а
// у читателя его быть не должно. Имя без слова `Rows` приглашало бы звать этот вход из
// нового кода — и половина приложения тихо перестала бы видеть настройки владельца.
//
// КТО ЧИТАЕТ ОПРЕДЕЛЕНИЯ МИМО СНИМКА — перечень ПОЛНЫЙ и проверяемый грепом
// (`grep -rn 'from(aspectDefinitions)\|from(propertyDefinitions)\|from(relationRoleDefinitions)\|effectiveRolesSql'
// apps/server/src --include='*.ts' | grep -v test`), их ДВА, и у каждого своя причина:
//  1. `registry/roles.ts` → `hierarchicalRolesSql` (круг исполнителя, `agent-loop/queries.ts`,
//     три места): эффективные строки нужны ВНУТРИ компилируемого SQL, снимком их туда не
//     подставить. Дельт не видит, и это безопасно — их форма флаги ролей не трогает
//     (см. докблок `roles.ts`);
//  2. `tools/registry.ts` → `loadAspectToolRows`: запрос отдаёт ПЯТЬ колонок, но его
//     единственный потребитель — секция «Инструкции активных аспектов» промпта
//     (`llm/context.ts`) — читает из них `id` и `ai_instructions`, а `ai_instructions`
//     дельта не меняет (`aspectDeltaSchema` его не содержит). То есть расхождения нет
//     У ТЕКУЩЕГО ПОТРЕБИТЕЛЯ, а не по построению: остальные три колонки (`description`,
//     `schema`, `view_config`) дельта как раз меняет, и читателя у них нет ни одного.
// Прежде читателей было пять. Подписи ролей и свойств в секции «Связанное»
// (`entity-read.ts`) переведены на снимок гейт-ревью Задачи 14 — там дельта меняла бы
// ровно то, что они показывают; ручка `aspect.list` снята его же ре-ревью — читателей у
// неё не было ни одного, а на её мнимой живости держалось объяснение всей этой развилки.
//
// В ПЕРЕЧНЕ ВЫШЕ ТОЛЬКО ЧИТАТЕЛИ. Сырым SQL в те же таблицы ходят ещё ТРИ файла, и все три —
// не читатели определений, а работа НАД строками; билдера drizzle в них нет, поэтому греп
// перечня их не видит, и вот их собственный:
//   grep -rn 'FROM property_definitions\|INTO property_definitions\|FROM registry_deltas'
//     apps/server/src --include='*.ts' | grep -v test | grep -v 'registry/load.ts'
//   → `db/seed-registries.ts` (кладёт system-строки), `db/registry-drift.ts` (сверяет их с
//     кодом под ролью приложения) и `registry/ops.ts` (операции владельца, Задача 15).
// Последний правит СВОИ строки и обязан видеть их такими, как они лежат: эффективное
// определение (система ⊕ дельта) для правки строки не годится вовсе, а снимок исполнителя
// снят ДО стадий и не показывает того, что записала предыдущая операция той же пачки.
// Условие, при котором этот абзац перестаёт быть верным: тот же сырой SQL появился в файле,
// который ЧИТАЕТ определения ради валидации или показа, — такому место в снимке.
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
import type { RegistryDeltaRow, RegistryDeltaTargetKind } from './deltas';

/** Три словаря реестра без версии — то, что даёт сырое чтение строк. */
export interface RegistryDictionaries {
  properties: Map<string, PropertyDefinition>;
  aspects: Map<string, AspectDefinition>;
  roles: Map<string, RelationRoleDefinition>;
}

export interface RegistrySnapshot extends RegistryDictionaries {
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
 * встроенное — так же, как это делал прежний реестр аспектов. Уникальность БД этого не
 * запрещает и не должна: частичные индексы разведены по `owner_id IS NULL` / `IS NOT NULL`
 * именно ради переопределения (на нём стоит и сегодняшний кастомный `orbis/note`).
 * Запрещена только ВТОРАЯ своя строка с тем же id — её ловит `*_custom_uniq`.
 *
 * RLS сама скоупит выдачу под `withIdentity`, но условие по `owner_id` стоит и в запросе:
 * снимок обязан быть одинаковым и под админским подключением (сиды, миграции, скрипты),
 * где политик нет вовсе.
 *
 * ВХОД-ДЕРЕВА 4 (МЕСТО РАЗБОРА): `type.target` и `scope` строки `property_definitions` —
 * это Q-AST, и `propertyDefinitionSchema` ниже разбирает их рекурсией `z.lazy`, то есть на
 * достаточно глубокой строке исчерпала бы стек ЗДЕСЬ — на каждом построении снимка реестра,
 * то есть на каждом вызове тула и каждом запросе.
 *
 * ГЕЙТ СТОИТ НЕ ЗДЕСЬ, А НА ЗАПИСИ (`registry/ops.ts`, `assertRegistryQuery`), и это
 * единственно возможное место: сюда строка приходит уже из базы, а «отказать на чтении»
 * значит запереть владельца снаружи собственного реестра. До Задачи 15 гейта не было вовсе,
 * потому что снаружи в реестр не писал никто; она завела писателей и в тот же день гейт —
 * разбор в шапке `queryFilterNodeSchema` (`@orbis/shared`, `query/ast.ts`), пункт 4.
 */
export async function loadRegistryRows(tx: Tx, ownerId: string): Promise<RegistryDictionaries> {
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

  return { properties, aspects, roles };
}

/**
 * Дельты владельца (§А3-2). Отдельным чтением, а не соединением с реестрами: дельта
 * адресует строку целиком (`target_kind` + `target_id`), а не колонку, и складывать её с
 * определением умеет `applyDeltas` — в SQL это правило пришлось бы написать второй раз.
 *
 * Встроенных дельт не бывает по определению (`owner_id NOT NULL` в 0014), поэтому условие
 * по владельцу здесь ровно одно и совпадает с политикой RLS `owner_owns_row`.
 */
export async function loadRegistryDeltas(tx: Tx, ownerId: string): Promise<RegistryDeltaRow[]> {
  const rows = (await tx.execute(sql`
    SELECT id, owner_id, target_kind, target_id, base_version, delta
    FROM registry_deltas
    WHERE owner_id = ${ownerId}::uuid
    ORDER BY target_kind, target_id`)) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    ownerId: r.owner_id as string,
    targetKind: r.target_kind as RegistryDeltaTargetKind,
    targetId: r.target_id as string,
    baseVersion: r.base_version as number,
    delta: r.delta,
  }));
}
