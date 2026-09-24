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
//  2. `tools/registry.ts` → `loadAspectToolRows`: запрос отдаёт ПЯТЬ колонок — `id`,
//     `description`, `ai_instructions`, `view_config` и `module` (последнюю завела задача 17).
//     Его единственный потребитель — секция «Инструкции активных аспектов» промпта
//     (`llm/context.ts`) — читает из них `id`, `ai_instructions` и `module` (маска §Б8-3), и
//     НИ ОДНУ из этих трёх дельта не меняет (`aspectDeltaSchema` их не содержит): расхождения
//     нет по построению. `description` и `view_config` дельта как раз меняет, и читателя у
//     них нет ни одного. Колонку `schema`, стоявшую в прежнем перечне «лишних», сняла
//     contract-миграция 0017 — перечень назвал её по инерции.
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
//
// ПОДПИСКИ РАЗБИРАЮТСЯ ТОЛЬКО ПО ФОРМЕ. Смысл (ссылки на контракты и наборы, типы выражений,
// сырые предикаты) проверяет `subscriptions/registry.ts` НА ЗАПИСИ: fail-closed по смыслу здесь
// означал бы, что пересев, изменивший контракт, запирает владельца снаружи графа, — а починить
// это ему нечем, потому что чинится оно тоже через реестр.
import {
  type ActionDefinition,
  type AspectDefinition,
  actionDefinitionSchema,
  aspectDefinitionSchema,
  type ContractDefinition,
  contractDefinitionSchema,
  type GraphId,
  type PropertyDefinition,
  propertyDefinitionSchema,
  type RelationRoleDefinition,
  relationRoleDefinitionSchema,
  type SubscriptionDefinition,
  subscriptionDefinitionSchema,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';
import type { RegistryDeltaRow, RegistryDeltaTargetKind } from './deltas';

/**
 * Строка реестра подписок КАК ОНА ЛЕЖИТ: колонки строки плюс РАЗОБРАННАЯ схемой декларация.
 * `surface` при этом остаётся свободным текстом — словарь поверхностей стережёт запись
 * (`SURFACE_UNKNOWN`), а не чтение: поверхность, снятая пересевом, обязана дать отказ у своей
 * подписки, а не уронить весь снимок реестра.
 */
export interface SubscriptionRow {
  id: string;
  graphId: string | null;
  surface: string;
  definition: SubscriptionDefinition;
  module: string | null;
  rank: number;
}

/** Шесть словарей реестра без версии — то, что даёт сырое чтение строк. */
export interface RegistryDictionaries {
  properties: Map<string, PropertyDefinition>;
  aspects: Map<string, AspectDefinition>;
  roles: Map<string, RelationRoleDefinition>;
  contracts: Map<string, ContractDefinition>;
  subscriptions: Map<string, SubscriptionRow>;
  /** §Б6-1: шестой род реестра — действия; колонки `over`/`rank`/`status` завела 0022. */
  actions: Map<string, ActionDefinition>;
}

export interface RegistrySnapshot extends RegistryDictionaries {
  /** `user_settings.registry_version`; 0 — у владельца ещё нет строки настроек. */
  ownerVersion: number;
  /** `registry_system.version` — её двигает сид (§А10-1). */
  systemVersion: number;
  /**
   * Словари ДО дельт владельца — строки, как их положил сид, и свои строки графа (§А3-2). Нет поля —
   * дельт нет, и снимок сам есть эта система (`applyDeltas` без дельт возвращает вход). Читателей ДВА:
   * идентичность конверта (`envelopeIdentityOf`, Ф-Б2-21, Ф-Б2-31) — «по чему конверт опознаётся» — факт
   * системной строки, и отключение владельцем (`rulesDisabled` вынимает правило из эффективного списка,
   * `effectiveRules`) его не отменяет; и запрет занять id системного правила своим (`refuseSystemRuleId`
   * в `ops.ts`) — отключённое системное правило свой id не освобождает. Движок, сторожа, валидатор и замки читают ЭФФЕКТИВНЫЕ словари
   * выше — отключённое правило здесь живо.
   */
  system?: RegistryDictionaries;
}

/** Строка любого реестра как её отдаёт SELECT: ключи — имена колонок (snake_case). */
interface Row {
  [column: string]: unknown;
}

/**
 * ORDER BY graph_id NULLS FIRST: при коллизии id собственное определение ПЕРЕКРЫВАЕТ
 * встроенное — так же, как это делал прежний реестр аспектов. Уникальность БД этого не
 * запрещает и не должна: частичные индексы разведены по `graph_id IS NULL` / `IS NOT NULL`
 * именно ради переопределения (на нём стоит и сегодняшний кастомный `orbis/note`).
 * Запрещена только ВТОРАЯ своя строка с тем же id — её ловит `*_custom_uniq`.
 *
 * RLS сама скоупит выдачу под `withIdentity`, но условие по `graph_id` стоит и в запросе:
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
export async function loadRegistryRows(tx: Tx, graphId: GraphId): Promise<RegistryDictionaries> {
  // Запросы идут ПОСЛЕДОВАТЕЛЬНО, а не Promise.all: транзакция живёт на одном соединении,
  // и параллельные запросы по нему сериализуются в лучшем случае, а в худшем — путают
  // порядок с `SET LOCAL`. Реестров шесть, каждый — один индексный проход.
  const propertyRows = (await tx.execute(sql`
    SELECT id, graph_id, key, label, description, type, status, storage,
           scope, merged_into, module, rank, flags, rules
    FROM property_definitions
    WHERE graph_id IS NULL OR graph_id = ${graphId}::uuid
    ORDER BY graph_id NULLS FIRST, id`)) as unknown as Row[];
  const aspectRows = (await tx.execute(sql`
    SELECT id, graph_id, key, label, description, properties, ai_instructions,
           tag_mappings, implements, aggregations, view_config, module, service, rank, rules
    FROM aspect_definitions
    WHERE graph_id IS NULL OR graph_id = ${graphId}::uuid
    ORDER BY graph_id NULLS FIRST, id`)) as unknown as Row[];
  const roleRows = (await tx.execute(sql`
    SELECT id, graph_id, key, label, description, source_label, target_label,
           hierarchical, constraints, "symmetric", module, rank, rules
    FROM relation_role_definitions
    WHERE graph_id IS NULL OR graph_id = ${graphId}::uuid
    ORDER BY graph_id NULLS FIRST, id`)) as unknown as Row[];
  const contractRows = (await tx.execute(sql`
    SELECT id, graph_id, key, label, description, kind, slots, classes, sets, facts, module, rank,
           exclusive_classes
    FROM contract_definitions
    WHERE graph_id IS NULL OR graph_id = ${graphId}::uuid
    ORDER BY graph_id NULLS FIRST, id`)) as unknown as Row[];
  const subscriptionRows = (await tx.execute(sql`
    SELECT id, graph_id, surface, definition, module, rank
    FROM subscription_definitions
    WHERE graph_id IS NULL OR graph_id = ${graphId}::uuid
    ORDER BY graph_id NULLS FIRST, id`)) as unknown as Row[];
  // `"over"` в кавычках: OVER оконных функций — зарезервированное слово SQL (тот же приём, что у
  // `"symmetric"` ролей выше).
  const actionRows = (await tx.execute(sql`
    SELECT id, graph_id, key, label, description, params, precondition, "over", steps,
           sensitivity, offered_by, module, batch_cap, status, rank
    FROM action_definitions
    WHERE graph_id IS NULL OR graph_id = ${graphId}::uuid
    ORDER BY graph_id NULLS FIRST, id`)) as unknown as Row[];
  // `, id` у всех шести словарей — порядок словаря в снимке детерминирован: без вторичного ключа он повторял
  // физический порядок строк и менялся после пересева/UPDATE (пин `load.test.ts` «словарь подписок несёт обе
  // засеянные» краснел в полном прогоне и был зелен поодиночке). Перекрытие «своя строка бьёт встроенную»
  // этим не трогается: `graph_id NULLS FIRST` остаётся ПЕРВЫМ ключом, `id` лишь упорядочивает внутри рода.

  const properties = new Map<string, PropertyDefinition>();
  for (const r of propertyRows) {
    properties.set(
      r.id as string,
      propertyDefinitionSchema.parse({
        id: r.id,
        graphId: r.graph_id,
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
        rules: r.rules,
      }),
    );
  }

  const aspects = new Map<string, AspectDefinition>();
  for (const r of aspectRows) {
    aspects.set(
      r.id as string,
      aspectDefinitionSchema.parse({
        id: r.id,
        graphId: r.graph_id,
        key: r.key,
        label: r.label,
        description: r.description,
        properties: r.properties,
        aiInstructions: r.ai_instructions,
        tagMappings: r.tag_mappings,
        implements: r.implements,
        // Колонка 0000 объявлена nullable с default `'{}'`: строка с явным NULL иначе уронила
        // бы разбор снимка НА ЧТЕНИИ, то есть заперла бы владельца снаружи его реестра.
        aggregations: r.aggregations ?? undefined,
        viewConfig: r.view_config,
        module: r.module,
        service: r.service,
        rank: r.rank,
        rules: r.rules,
      }),
    );
  }

  const roles = new Map<string, RelationRoleDefinition>();
  for (const r of roleRows) {
    roles.set(
      r.id as string,
      relationRoleDefinitionSchema.parse({
        id: r.id,
        graphId: r.graph_id,
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
        rules: r.rules,
      }),
    );
  }

  const contracts = new Map<string, ContractDefinition>();
  for (const r of contractRows) {
    contracts.set(
      r.id as string,
      contractDefinitionSchema.parse({
        id: r.id,
        graphId: r.graph_id,
        key: r.key,
        label: r.label,
        description: r.description,
        kind: r.kind,
        slots: r.slots,
        classes: r.classes,
        sets: r.sets,
        facts: r.facts,
        // snake_case, как колонка и декларация сида (§1.16): camelCase-полей у контракта нет вовсе.
        // Ветвления по `kind` нет — поле принимают обе ветки схемы (у facts оно `z.literal(false)`).
        exclusive_classes: r.exclusive_classes,
        module: r.module,
        rank: r.rank,
      }),
    );
  }

  const subscriptions = new Map<string, SubscriptionRow>();
  for (const r of subscriptionRows) {
    subscriptions.set(r.id as string, {
      id: r.id as string,
      graphId: r.graph_id as string | null,
      surface: r.surface as string,
      definition: subscriptionDefinitionSchema.parse(r.definition),
      module: r.module as string | null,
      rank: r.rank as number,
    });
  }

  // ДЕЙСТВИЯ РАЗБИРАЮТСЯ ТОЛЬКО ПО ФОРМЕ — по доводу подписок (шапка файла): смысл (шаги по
  // конверту тула, типы E, чувствительность) проверяет `assertAction` на записи.
  //
  // `params`/`sensitivity`/`offered_by` — колонки 0014 nullable БЕЗ default, а у схемы у них есть
  // умолчание `[]`. zod подставляет его только вместо `undefined`, и строка с явным NULL иначе
  // уронила бы разбор снимка НА ЧТЕНИИ, то есть заперла бы владельца снаружи его реестра, —
  // тот же приём, что у `aggregations` аспекта выше. `steps` так не выравнивается намеренно:
  // действие без шагов — не действие, и умолчания у него нет.
  const actions = new Map<string, ActionDefinition>();
  for (const r of actionRows) {
    actions.set(
      r.id as string,
      actionDefinitionSchema.parse({
        id: r.id,
        graphId: r.graph_id,
        key: r.key,
        label: r.label,
        description: r.description,
        params: r.params ?? undefined,
        precondition: r.precondition,
        over: r.over,
        steps: r.steps,
        sensitivity: r.sensitivity ?? undefined,
        offered_by: r.offered_by ?? undefined,
        module: r.module,
        batch_cap: r.batch_cap,
        status: r.status,
        rank: r.rank,
      }),
    );
  }

  return { properties, aspects, roles, contracts, subscriptions, actions };
}

/**
 * Дельты владельца (§А3-2). Отдельным чтением, а не соединением с реестрами: дельта
 * адресует строку целиком (`target_kind` + `target_id`), а не колонку, и складывать её с
 * определением умеет `applyDeltas` — в SQL это правило пришлось бы написать второй раз.
 *
 * Встроенных дельт не бывает по определению (`graph_id NOT NULL` в 0014), поэтому условие
 * по графу здесь ровно одно и совпадает с политикой RLS `current_graph_select` (0021) — у
 * `registry_deltas` форма обычной таблицы строк, а не реестровая `read_builtin_or_own`.
 */
export async function loadRegistryDeltas(tx: Tx, graphId: GraphId): Promise<RegistryDeltaRow[]> {
  const rows = (await tx.execute(sql`
    SELECT id, graph_id, target_kind, target_id, base_version, delta
    FROM registry_deltas
    WHERE graph_id = ${graphId}::uuid
    ORDER BY target_kind, target_id`)) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    graphId: r.graph_id as string,
    targetKind: r.target_kind as RegistryDeltaTargetKind,
    targetId: r.target_id as string,
    baseVersion: r.base_version as number,
    delta: r.delta,
  }));
}
