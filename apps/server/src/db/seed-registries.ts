// apps/server/src/db/seed-registries.ts
//
// Сид ШЕСТИ реестров: свойства (§А2-1), роли рёбер (§А4-2), аспекты (§А3-1), контракты
// (§Б1-1), подписки (§Б5-1: `orbis/agenda` — задача 6, `orbis/budget-overview` — задача 9) и
// действия (§Б6-5, срез Б-2: `finance/plan-to-fact`, `planner/postpone_overdue`). Пустых
// таблиц реестров больше нет.
//
// Почему модуль, а не два скрипта: сид запускается двумя путями — `bun run db:prepare`
// (локально и в CI, через `scripts/seed-registries.ts`) и `bun scripts/ops.ts
// seed-registries` (прод, с секретом из Ключницы). До реформы эти два пути несли ДВЕ копии
// одного upsert'а (`scripts/seed-aspects.ts` и `ops.ts:166-185`), и разойтись им мешала
// только внимательность. Здесь копия одна.
//
// Мутация реестра ПРЯМОЙ записью в БД — названное планом исключение из правила «только
// через executor» (Р-1): system-строки (`graph_id IS NULL`) ничьи, актора у них нет, и
// executor, который весь построен на владельце и его RLS, писать их не может.
//
// Колонка `symmetric` пишется в кавычках: SYMMETRIC — зарезервированное слово SQL, и без
// кавычек PostgreSQL отвергает список колонок разбором (проверено пробоем).
//
// Идемпотентен: `ON CONFLICT (id) WHERE graph_id IS NULL DO UPDATE` (опора — partial unique
// index `*_builtin_uniq` каждой таблицы). Лишние system-строки НЕ удаляет: строка, которой
// нет в коде, — это дрейф (Р-23) и решение человека («свойство удалили» или «код откатили
// на старую версию»), а не то, что вправе решить сид. Отчёт `ops.ts check` называет такие
// строки поимённо.
import {
  type AspectDefinition,
  aspectDefinitionSchema,
  BUILTIN_ACTION_DEFS,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  BUILTIN_SUBSCRIPTION_DEFS,
  type ContractDefinition,
  contractDefinitionSchema,
  type PropertyDefinition,
  propertyDefinitionSchema,
  registryMergeNoteId,
  subscriptionDefinitionSchema,
} from '@orbis/shared';
import { sql as drizzleSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type ISql, type Sql } from 'postgres';
import { appendMessageIdempotent } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import { parseGraphId } from '../identity';
import {
  baseSystemFor,
  type OwnRuleRow,
  ownRulesByGraphOf,
  type RegistryConflict,
  type RegistryDeltaRow,
  type RegistryDeltaTargetKind,
  registryConflictLine,
  ruleMergeContextOf,
  type SystemDefinitions,
  threeWayMerge,
} from '../registry/deltas';
import type { SubscriptionRow } from '../registry/load';
import { createDriftConflictUnits } from '../registry/merge-conflict';
import { bumpOwnerRegistryVersion } from '../registry/version';
import * as schema from './schema';

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
  /** §Б1-1: контракты сеются с Б-1. */
  contracts: number;
  /** §Б5-1: встроенные подписки — поверхности читают декларацию из реестра, не из кода. */
  subscriptions: number;
  /** §Б6-5: встроенные действия модулей — строка реестра, а не код. */
  actions: number;
  /** Версия system-реестров ПОСЛЕ сида — она же ключ инвалидации кешей (§А10-1). */
  version: number;
  /** Дельт, пересчитанных трёхсторонним слиянием под новую системную версию (§А3-3). */
  mergedDeltas: number;
  /** Конфликты слияния — они же содержимое системной заметки владельцу (§А3-3). */
  conflicts: RegistryConflict[];
}

/**
 * Пишет встроенные строки ШЕСТИ реестров (свойства, роли, аспекты, контракты, подписки,
 * действия) и двигает глобальную версию.
 *
 * `sql` — админское подключение: RLS запрещает запись строк с `graph_id IS NULL` любой
 * роли, кроме обходящей политики.
 *
 * Тип `ISql`, а не `Sql`, — то общее, что есть у пула и у ОТКРЫТОЙ ТРАНЗАКЦИИ (postgres.js
 * разводит их двумя интерфейсами: у транзакции нет `end`/`begin`/`listen`). Сид зовётся
 * обоими способами: `db:prepare` и `ops.ts seed-registries` дают пул, «Пересев мира»
 * (`reset-world.ts`) — свою транзакцию, потому что пересев обязан быть атомарен вместе со
 * сносом. Ничего сверх запросов сид от подключения и не требует.
 */
export async function seedRegistries(sql: ISql, adminDsn: string): Promise<SeedRegistriesResult> {
  // Системное определение ДО пересева — первая из трёх сторон слияния (§А3-3). Снимается
  // ДО upsert'ов и только оно: `nextSystem` берётся из кода (`BUILTIN_*`), а дельты живут
  // в своей таблице и пересевом не трогаются.
  const prevSystem = await readSystemDefinitions(sql);

  // `rules` (§Б4-1, 0022) — в списке колонок И в `DO UPDATE SET` у всех трёх носителей: колонка, которую
  // вход умеет задавать, обязана обновляться, иначе порча в базе или правило прошлого релиза
  // переживали бы пересев молча (тот же довод, что у `seedCustomAspect`).
  for (const p of BUILTIN_PROPERTY_META) {
    await sql`
      INSERT INTO property_definitions
        (id, graph_id, key, label, description, type, status, storage, scope,
         merged_into, module, rank, flags, rules)
      VALUES
        (${p.id}, NULL, ${p.key}, ${sql.json(j(p.label))}, ${sql.json(j(p.description))},
         ${sql.json(j(p.type))}, ${p.status}, ${p.storage},
         ${p.scope === null ? null : sql.json(j(p.scope))},
         ${p.mergedInto}, ${p.module}, ${p.rank}, ${sql.json(j(p.flags))},
         ${sql.json(j(p.rules))})
      ON CONFLICT (id) WHERE graph_id IS NULL DO UPDATE SET
        key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
        type = EXCLUDED.type, status = EXCLUDED.status, storage = EXCLUDED.storage,
        scope = EXCLUDED.scope, merged_into = EXCLUDED.merged_into,
        module = EXCLUDED.module, rank = EXCLUDED.rank, flags = EXCLUDED.flags,
        rules = EXCLUDED.rules`;
  }

  for (const r of BUILTIN_RELATION_ROLE_META) {
    await sql`
      INSERT INTO relation_role_definitions
        (id, graph_id, key, label, description, source_label, target_label,
         hierarchical, constraints, "symmetric", module, rank, rules)
      VALUES
        (${r.id}, NULL, ${r.key}, ${sql.json(j(r.label))}, ${sql.json(j(r.description))},
         ${sql.json(j(r.sourceLabel))}, ${sql.json(j(r.targetLabel))},
         ${r.hierarchical}, ${sql.json(j(r.constraints))}, ${r.symmetric}, ${r.module}, ${r.rank},
         ${sql.json(j(r.rules))})
      ON CONFLICT (id) WHERE graph_id IS NULL DO UPDATE SET
        key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
        source_label = EXCLUDED.source_label, target_label = EXCLUDED.target_label,
        hierarchical = EXCLUDED.hierarchical, constraints = EXCLUDED.constraints,
        "symmetric" = EXCLUDED."symmetric", module = EXCLUDED.module, rank = EXCLUDED.rank,
        rules = EXCLUDED.rules`;
  }

  for (const a of BUILTIN_ASPECT_DEFS) {
    await sql`
      INSERT INTO aspect_definitions
        (id, graph_id, key, label, description, properties, implements, aggregations,
         ai_instructions, tag_mappings, view_config, module, service, rank, rules)
      VALUES
        (${a.id}, NULL, ${a.key}, ${sql.json(j(a.label))}, ${sql.json(j(a.description))},
         ${sql.json(j(a.properties))}, ${sql.json(j(a.implements))},
         ${sql.json(j(a.aggregations))},
         ${a.aiInstructions}, ${a.tagMappings}, ${sql.json(j(a.viewConfig))},
         ${a.module}, ${a.service}, ${a.rank}, ${sql.json(j(a.rules))})
      ON CONFLICT (id) WHERE graph_id IS NULL DO UPDATE SET
        key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
        properties = EXCLUDED.properties, implements = EXCLUDED.implements,
        aggregations = EXCLUDED.aggregations,
        ai_instructions = EXCLUDED.ai_instructions,
        tag_mappings = EXCLUDED.tag_mappings, view_config = EXCLUDED.view_config,
        module = EXCLUDED.module, service = EXCLUDED.service, rank = EXCLUDED.rank,
        rules = EXCLUDED.rules`;
  }

  for (const c of BUILTIN_CONTRACT_DEFS) {
    // SQL NULL, а не `sql.json(null)`: колонки nullable, форму различает `kind` (CHECK schema.ts),
    // и jsonb-значение `null` сделало бы «слотов нет» неотличимым от «слоты — литеральный null».
    // Тот же приём, что у `scope` свойства выше.
    // `exclusive_classes` — плоский boolean, а не `sql.json`: колонка `boolean NOT NULL`, не jsonb.
    // В `DO UPDATE SET` он едет по правилу всех четырёх upsert'ов: колонка, которую вход умеет
    // задавать, обязана обновляться, иначе повторный сев сохранял бы значение прошлого релиза.
    await sql`
      INSERT INTO contract_definitions
        (id, graph_id, key, label, description, kind, slots, classes, sets, facts,
         exclusive_classes, module, rank)
      VALUES
        (${c.id}, NULL, ${c.key}, ${sql.json(j(c.label))}, ${sql.json(j(c.description))}, ${c.kind},
         ${c.slots === null ? null : sql.json(j(c.slots))},
         ${c.classes === null ? null : sql.json(j(c.classes))},
         ${c.sets === null ? null : sql.json(j(c.sets))},
         ${c.facts === null ? null : sql.json(j(c.facts))},
         ${c.exclusive_classes}, ${c.module}, ${c.rank})
      ON CONFLICT (id) WHERE graph_id IS NULL DO UPDATE SET
        key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
        kind = EXCLUDED.kind, slots = EXCLUDED.slots, classes = EXCLUDED.classes,
        sets = EXCLUDED.sets, facts = EXCLUDED.facts, exclusive_classes = EXCLUDED.exclusive_classes,
        module = EXCLUDED.module, rank = EXCLUDED.rank`;
  }

  // §Б5-1: декларация поверхности — СТРОКА РЕЕСТРА, а не литерал в коде движка. Дельта
  // владельца (`subscription_set`) кладётся отдельной строкой с его `graph_id`, поэтому
  // конфликт разрешается тем же частичным индексом, что у остальных четырёх сеемых реестров.
  for (const s of BUILTIN_SUBSCRIPTION_DEFS) {
    await sql`
      INSERT INTO subscription_definitions (id, graph_id, surface, definition, module, rank)
      VALUES (${s.id}, NULL, ${s.surface}, ${sql.json(j(s.definition))}, ${s.module}, ${s.rank})
      ON CONFLICT (id) WHERE graph_id IS NULL DO UPDATE SET
        surface = EXCLUDED.surface, definition = EXCLUDED.definition,
        module = EXCLUDED.module, rank = EXCLUDED.rank`;
  }

  // §Б6-5 «создание = запись»: действие модуля живёт строкой, и реестр тулов подхватывает
  // его без кода (§Б6-6, задача 7). Конфликт — тем же частичным индексом, что у пяти
  // остальных реестров. `precondition`/`over` — SQL NULL, а не `sql.json(null)`: тот же довод,
  // что у `slots` контракта выше — jsonb-значение `null` сделало бы «предусловия нет»
  // неотличимым от литерального null. `"over"` в кавычках — OVER зарезервировано, как SYMMETRIC.
  // Валидатор `assertAction` здесь НЕ зовётся — снимка реестра у сырого подключения нет;
  // гейт сида — тест `registry/actions.test.ts` (прецедент `assertSubscription`).
  for (const a of BUILTIN_ACTION_DEFS) {
    await sql`
      INSERT INTO action_definitions
        (id, graph_id, key, label, description, params, precondition, "over", steps,
         sensitivity, offered_by, module, batch_cap, status, rank)
      VALUES
        (${a.id}, NULL, ${a.key}, ${sql.json(j(a.label))}, ${sql.json(j(a.description))},
         ${sql.json(j(a.params))},
         ${a.precondition === null ? null : sql.json(j(a.precondition))},
         ${a.over === null ? null : sql.json(j(a.over))},
         ${sql.json(j(a.steps))}, ${sql.json(j(a.sensitivity))}, ${sql.json(j(a.offered_by))},
         ${a.module}, ${a.batch_cap}, ${a.status}, ${a.rank})
      ON CONFLICT (id) WHERE graph_id IS NULL DO UPDATE SET
        key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
        params = EXCLUDED.params, precondition = EXCLUDED.precondition, "over" = EXCLUDED."over",
        steps = EXCLUDED.steps, sensitivity = EXCLUDED.sensitivity,
        offered_by = EXCLUDED.offered_by, module = EXCLUDED.module,
        batch_cap = EXCLUDED.batch_cap, status = EXCLUDED.status, rank = EXCLUDED.rank`;
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

  const merge = await mergeRegistryDeltas(sql, adminDsn, prevSystem, row.version);
  return {
    properties: BUILTIN_PROPERTY_META.length,
    roles: BUILTIN_RELATION_ROLE_META.length,
    aspects: BUILTIN_ASPECT_DEFS.length,
    contracts: BUILTIN_CONTRACT_DEFS.length,
    subscriptions: BUILTIN_SUBSCRIPTION_DEFS.length,
    actions: BUILTIN_ACTION_DEFS.length,
    version: row.version,
    mergedDeltas: merge.merged,
    conflicts: merge.conflicts,
  };
}

/**
 * Системные определения из БД (`graph_id IS NULL`) — сторона «до» трёхстороннего слияния.
 *
 * РАЗБОР МЯГКИЙ, И ЭТО НЕСУЩЕЕ РЕШЕНИЕ. Функция зовётся ПЕРВОЙ строкой сида, до всех upsert'ов,
 * а разбирает она строки ПРОШЛОГО релиза новой схемой: строгий разбор означал бы сид, который
 * падает ровно на том, что сам же и чинит, — и починить это нечем (`reset-world` system-строк не
 * трогает и зовёт тот же сид, а белый список `ops.ts` ручного SQL не знает). Строка, не
 * разобравшаяся новой схемой, просто не кладётся в базу «до»: это эквивалент `UNKNOWN_PREV_SYSTEM`
 * для своего рода, а докблок §А3-3 прямо разрешает ошибаться «в сторону лишнего конфликта».
 * `registry/load.ts` при этом остаётся строгим: fail-closed на чтении — сознательный выбор, и
 * лечит его именно этот сид.
 *
 * Сторона «до» обязана быть ПОЛНОЙ строкой: `rules` свойств и аспектов и `exclusive_classes`
 * контрактов (0022) читаются здесь наравне с прочими колонками. Без `rules` слияние (задача 16)
 * видело бы «система добавила правило» на каждом пересеве, без флага — читало бы его как снятый.
 * Роли здесь не читаются: стороны слияния для ролей `SystemDefinitions` не несёт (`registry/deltas.ts`).
 */
export async function readSystemDefinitions(sql: ISql): Promise<SystemDefinitions> {
  const propertyRows = await sql<Record<string, unknown>[]>`
    SELECT id, graph_id, key, label, description, type, status, storage, scope,
           merged_into, module, rank, flags, rules
    FROM property_definitions WHERE graph_id IS NULL`;
  const aspectRows = await sql<Record<string, unknown>[]>`
    SELECT id, graph_id, key, label, description, properties, ai_instructions, tag_mappings,
           implements, aggregations, view_config, module, service, rank, rules
    FROM aspect_definitions WHERE graph_id IS NULL`;
  const contractRows = await sql<Record<string, unknown>[]>`
    SELECT id, graph_id, key, label, description, kind, slots, classes, sets, facts,
           exclusive_classes, module, rank
    FROM contract_definitions WHERE graph_id IS NULL`;
  const subscriptionRows = await sql<Record<string, unknown>[]>`
    SELECT id, graph_id, surface, definition, module, rank
    FROM subscription_definitions WHERE graph_id IS NULL`;
  const properties = new Map<string, PropertyDefinition>();
  for (const r of propertyRows) {
    const parsed = propertyDefinitionSchema.safeParse({
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
    });
    if (parsed.success) properties.set(r.id as string, parsed.data);
  }
  const aspects = new Map<string, AspectDefinition>();
  for (const r of aspectRows) {
    const parsed = aspectDefinitionSchema.safeParse({
      id: r.id,
      graphId: r.graph_id,
      key: r.key,
      label: r.label,
      description: r.description,
      properties: r.properties,
      aiInstructions: r.ai_instructions,
      tagMappings: r.tag_mappings,
      implements: r.implements,
      // См. `registry/load.ts`: явный NULL в колонке не должен ронять разбор снимка.
      aggregations: r.aggregations ?? undefined,
      viewConfig: r.view_config,
      module: r.module,
      service: r.service,
      rank: r.rank,
      rules: r.rules,
    });
    if (parsed.success) aspects.set(r.id as string, parsed.data);
  }
  const contracts = new Map<string, ContractDefinition>();
  for (const r of contractRows) {
    const parsed = contractDefinitionSchema.safeParse({
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
      exclusive_classes: r.exclusive_classes,
      module: r.module,
      rank: r.rank,
    });
    if (parsed.success) contracts.set(r.id as string, parsed.data);
  }
  const subscriptions = new Map<string, SubscriptionRow>();
  for (const r of subscriptionRows) {
    const parsed = subscriptionDefinitionSchema.safeParse(r.definition);
    if (!parsed.success) continue;
    subscriptions.set(r.id as string, {
      id: r.id as string,
      graphId: r.graph_id as string | null,
      surface: r.surface as string,
      definition: parsed.data,
      module: r.module as string | null,
      rank: r.rank as number,
    });
  }
  return { properties, aspects, contracts, subscriptions };
}

/** Системные определения ИЗ КОДА — сторона «после»; та самая, что упала в базу выше. */
export function codeSystemDefinitions(): SystemDefinitions {
  return {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
    // Роли — ради тождества id правил при пересеве (Ф-Б2-28, `ruleMergeContextOf`).
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
    // `graphId: null` проставляется здесь, а не берётся из `BuiltinSubscriptionDef`: у встроенной
    // декларации владельца нет по определению, и второе поле в списке кода означало бы, что
    // system-строку можно объявить чужой.
    subscriptions: new Map(
      BUILTIN_SUBSCRIPTION_DEFS.map((s) => [
        s.id,
        {
          id: s.id,
          graphId: null,
          surface: s.surface,
          definition: s.definition,
          module: s.module,
          rank: s.rank,
        },
      ]),
    ),
  };
}

/**
 * ТРЁХСТОРОННЕЕ СЛИЯНИЕ ЖИВЫХ ДЕЛЬТ ПОСЛЕ ПЕРЕСЕВА (§А3-3).
 *
 * Идёт ПОСЛЕ upsert'ов и инкремента системной версии, потому что новая версия — это и есть
 * новый `base_version` дельт: пока она не записана, «на что теперь опирается дельта»
 * ответить нечем.
 *
 * Каждая дельта переписывается СВОЕЙ транзакцией вместе с инкрементом версии владельца
 * (§А10-1) — иначе процесс приложения, поднятый на этой же базе, продолжил бы отдавать из
 * кеша снимок, собранный по старой дельте. Одна транзакция на дельту, а не одна на всё:
 * дельты разных владельцев независимы, и падение на чужой строке не должно откатывать уже
 * слитое.
 *
 * Конфликты НЕ становятся единицами пачки D42 — это Задача 15 (`createPending` требует
 * актора, а у деплойного слияния его нет, находка 46). Здесь они уезжают в отчёт вызывающему
 * и в системную заметку глобального треда владельца.
 *
 * НЕРАЗБИРАЕМАЯ ДЕЛЬТА РОНЯЕТ СИД, и это выбор, а не недосмотр: такая строка УЖЕ делает
 * реестр владельца нечитаемым (`applyDeltas` отказывает fail-closed на каждом чтении), и
 * тихо пропустить её значило бы спрятать факт ровно в тот момент, когда на него смотрит
 * человек. Уже слитые строки при этом остаются слитыми (транзакция на строку), а
 * недоделанные сохраняют `base_version < version` и доедут следующим прогоном — доедут
 * КОРРЕКТНО, а не как получится: у отставшей строки снимок БД перестал быть её стороной
 * «до», и `baseSystemFor` подставляет ей пустую базу вместо чужой (см. его докблок).
 * Без этого повторный прогон сливал бы пропущенную строку вслепую: `prev == next` для неё
 * значит «система не менялась», и скрытие ставшего обязательным свойства уехало бы
 * владельцу молча.
 */
export async function mergeRegistryDeltas(
  sql: ISql,
  adminDsn: string,
  prevSystem: SystemDefinitions,
  systemVersion: number,
): Promise<{ merged: number; conflicts: RegistryConflict[] }> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, graph_id, target_kind, target_id, base_version, delta
    FROM registry_deltas WHERE base_version < ${systemVersion}
    ORDER BY graph_id, target_kind, target_id`;
  if (rows.length === 0) return { merged: 0, conflicts: [] };

  const nextSystem = codeSystemDefinitions();
  // КОНТЕКСТ ПРАВИЛ ВЛАДЕЛЬЦА (Ф-Б2-28): конкурента правила ищут по ВСЕМУ снимку владельца — его прочим дельтам
  // (в том числе тем, что уже на текущей версии и сливаться не будут) и правилам его своих строк. Слитая в этом
  // прогоне дельта подменяет прежнюю в карте (`deltasByGraph`), и следующая дельта того же владельца видит
  // исход — например, уже отключённое правило.
  const graphs = [...new Set(rows.map((r) => r.graph_id as string))];
  const deltasByGraph = new Map<string, RegistryDeltaRow[]>();
  for (const r of await sql<Record<string, unknown>[]>`
    SELECT id, graph_id, target_kind, target_id, base_version, delta
    FROM registry_deltas WHERE graph_id IN ${sql(graphs)}`) {
    const g = r.graph_id as string;
    deltasByGraph.set(g, [
      ...(deltasByGraph.get(g) ?? []),
      {
        id: r.id as string,
        graphId: g,
        targetKind: r.target_kind as RegistryDeltaTargetKind,
        targetId: r.target_id as string,
        baseVersion: r.base_version as number,
        delta: r.delta,
      },
    ]);
  }
  // Свои строки — только графов этого прогона (прод не сканируется целиком); разборщик один с предпросмотром
  // (`ownRulesByGraphOf`), а форма запроса — та же, что у `OWN_RULE_ROWS_QUERY`, суженная до графов.
  const ownRuleRows: OwnRuleRow[] = [];
  for (const [kind, table] of [
    ['aspect', 'aspect_definitions'],
    ['property', 'property_definitions'],
    ['role', 'relation_role_definitions'],
  ] as const) {
    ownRuleRows.push(
      ...(await sql<OwnRuleRow[]>`
        SELECT graph_id, ${kind} AS kind, id, rules FROM ${sql(table)}
        WHERE graph_id IN ${sql(graphs)} AND rules <> '[]'::jsonb`),
    );
  }
  const ownRulesByGraph = ownRulesByGraphOf(ownRuleRows);
  // ВТОРОЕ ПОДКЛЮЧЕНИЕ ТОЙ ЖЕ АДМИНСКОЙ РОЛЬЮ, а не drizzle поверх `sql`, — и это не
  // аккуратность, а обход доказанного дефекта. `drizzle(client)` меняет сериализацию
  // параметров у САМОГО клиента postgres.js: первый же drizzle-запрос по нему ломает
  // следующий запрос сида с `sql.json(...)` — «The string argument must be of type string,
  // received an instance of Object» на закешированном prepared-statement (проверено пробоем:
  // upsert → drizzle SELECT 1 → тот же upsert падает; без drizzle между ними — не падает).
  // Держать в сиде ОДИН стиль запросов и писать заметку сырым SQL было бы вторым
  // экземпляром `appendMessageIdempotent`; дешевле второе соединение.
  const mergeClient = postgres(adminDsn, { max: 1 });
  const db = drizzle(mergeClient, { schema });
  const all: RegistryConflict[] = [];
  try {
    for (const r of rows) {
      const row: RegistryDeltaRow = {
        id: r.id as string,
        graphId: r.graph_id as string,
        targetKind: r.target_kind as RegistryDeltaTargetKind,
        targetId: r.target_id as string,
        baseVersion: r.base_version as number,
        delta: r.delta,
      };
      // База «до» — снимок БД, но ТОЛЬКО для дельты, которая на него и опиралась.
      // Отставший `base_version` (пропущенное слияние — упавший сид, убитый процесс)
      // означает, что состояния, против которого писали дельту, больше нет нигде;
      // `baseSystemFor` подставляет пустую базу, и правила §А3-3 срабатывают широко.
      const base = baseSystemFor(prevSystem, row, systemVersion - 1);
      const ownerDeltas = deltasByGraph.get(row.graphId) ?? [];
      const { merged, conflicts } = threeWayMerge(
        base,
        nextSystem,
        row,
        ruleMergeContextOf(nextSystem, ownerDeltas, ownRulesByGraph.get(row.graphId) ?? [], {
          kind: row.targetKind,
          id: row.targetId,
        }),
      );
      deltasByGraph.set(
        row.graphId,
        ownerDeltas.map((d) => (d.id === row.id ? { ...d, delta: merged } : d)),
      );
      await db.transaction(async (tx) => {
        await tx.execute(
          drizzleSql`UPDATE registry_deltas
                       SET delta = ${JSON.stringify(merged)}::jsonb, base_version = ${systemVersion}
                     WHERE id = ${row.id}::uuid`,
        );
        await bumpOwnerRegistryVersion(tx, parseGraphId(row.graphId));
        if (conflicts.length === 0) return;
        // Заметка — ТОЙ ЖЕ транзакцией, что переписывает дельту. Порознь возможен исход
        // «дельта слита, а владельцу не сказали»: следующий прогон её уже не найдёт
        // (`base_version` переехал на текущую версию) и промолчит навсегда.
        const threadId = await ensureGlobalThread(tx, parseGraphId(row.graphId));
        await appendMessageIdempotent(tx, {
          id: registryMergeNoteId(row.id, systemVersion),
          threadId,
          role: 'system',
          content: [
            `Обновление системных определений разошлось с вашими настройками (${conflicts.length}):`,
            ...conflicts.map(registryConflictLine),
          ].join('\n'),
          metadata: { type: 'registry-merge', systemVersion, target: row.targetId, conflicts },
        });
        // Заметка РАССКАЗЫВАЕТ обо всех конфликтах, единица пачки ПРЕДЛАГАЕТ решить те, где
        // выбор ещё остался (§А3-3, Задача 15). Тем же tx и по той же причине, что заметка:
        // порознь возможен исход «дельта слита, а разобрать её владельцу не предложили».
        await createDriftConflictUnits(tx, {
          graphId: parseGraphId(row.graphId),
          systemVersion,
          deltaRowId: row.id,
          merged,
          conflicts,
        });
      });
      all.push(...conflicts);
    }
  } finally {
    await mergeClient.end();
  }
  return { merged: rows.length, conflicts: all };
}

/** Одна строка отчёта — одинаковая у `db:prepare` и у `ops.ts seed-registries`. */
export function seedRegistriesReport(r: SeedRegistriesResult): string[] {
  return [
    `seed-registries: свойств ${r.properties}, ролей ${r.roles}, аспектов ${r.aspects}, ` +
      `контрактов ${r.contracts}, подписок ${r.subscriptions}, действий ${r.actions}; ` +
      `версия system-реестров ${r.version}; дельт слито ${r.mergedDeltas}`,
    ...(r.conflicts.length === 0
      ? []
      : [
          `КОНФЛИКТЫ СЛИЯНИЯ (${r.conflicts.length}) — владельцу отправлена системная заметка:`,
          ...r.conflicts.map(registryConflictLine),
        ]),
  ];
}
