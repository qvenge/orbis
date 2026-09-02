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
  type AspectDefinition,
  aspectDefinitionSchema,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  type PropertyDefinition,
  propertyDefinitionSchema,
  registryMergeNoteId,
} from '@orbis/shared';
import { sql as drizzleSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { appendMessageIdempotent } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import {
  baseSystemFor,
  type RegistryConflict,
  type RegistryDeltaRow,
  type RegistryDeltaTargetKind,
  registryConflictLine,
  type SystemDefinitions,
  threeWayMerge,
} from '../registry/deltas';
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
  /** Версия system-реестров ПОСЛЕ сида — она же ключ инвалидации кешей (§А10-1). */
  version: number;
  /** Дельт, пересчитанных трёхсторонним слиянием под новую системную версию (§А3-3). */
  mergedDeltas: number;
  /** Конфликты слияния — они же содержимое системной заметки владельцу (§А3-3). */
  conflicts: RegistryConflict[];
}

/**
 * Пишет встроенные строки трёх реестров и двигает глобальную версию.
 *
 * `sql` — админское подключение: RLS запрещает запись строк с `owner_id IS NULL` любой
 * роли, кроме обходящей политики.
 */
export async function seedRegistries(sql: Sql, adminDsn: string): Promise<SeedRegistriesResult> {
  // Системное определение ДО пересева — первая из трёх сторон слияния (§А3-3). Снимается
  // ДО upsert'ов и только оно: `nextSystem` берётся из кода (`BUILTIN_*`), а дельты живут
  // в своей таблице и пересевом не трогаются.
  const prevSystem = await readSystemDefinitions(sql);

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
        (id, owner_id, key, label, description, properties, implements,
         ai_instructions, tag_mappings, view_config, module, service, rank)
      VALUES
        (${a.id}, NULL, ${a.key}, ${sql.json(j(a.label))}, ${sql.json(j(a.description))},
         ${sql.json(j(a.properties))}, ${sql.json(j(a.implements))},
         ${a.aiInstructions}, ${a.tagMappings}, ${sql.json(j(a.viewConfig))},
         ${a.module}, ${a.service}, ${a.rank})
      ON CONFLICT (id) WHERE owner_id IS NULL DO UPDATE SET
        key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
        properties = EXCLUDED.properties, implements = EXCLUDED.implements,
        ai_instructions = EXCLUDED.ai_instructions,
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

  const merge = await mergeRegistryDeltas(sql, adminDsn, prevSystem, row.version);
  return {
    properties: BUILTIN_PROPERTY_META.length,
    roles: BUILTIN_RELATION_ROLE_META.length,
    aspects: BUILTIN_ASPECT_DEFS.length,
    version: row.version,
    mergedDeltas: merge.merged,
    conflicts: merge.conflicts,
  };
}

/** Системные определения из БД (`owner_id IS NULL`) — сторона «до» трёхстороннего слияния. */
export async function readSystemDefinitions(sql: Sql): Promise<SystemDefinitions> {
  const propertyRows = await sql<Record<string, unknown>[]>`
    SELECT id, owner_id, key, label, description, type, status, storage, scope,
           merged_into, module, rank, flags
    FROM property_definitions WHERE owner_id IS NULL`;
  const aspectRows = await sql<Record<string, unknown>[]>`
    SELECT id, owner_id, key, label, description, properties, ai_instructions, tag_mappings,
           implements, view_config, module, service, rank
    FROM aspect_definitions WHERE owner_id IS NULL`;
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
  return { properties, aspects };
}

/** Системные определения ИЗ КОДА — сторона «после»; та самая, что упала в базу выше. */
export function codeSystemDefinitions(): SystemDefinitions {
  return {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
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
  sql: Sql,
  adminDsn: string,
  prevSystem: SystemDefinitions,
  systemVersion: number,
): Promise<{ merged: number; conflicts: RegistryConflict[] }> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, owner_id, target_kind, target_id, base_version, delta
    FROM registry_deltas WHERE base_version < ${systemVersion}
    ORDER BY owner_id, target_kind, target_id`;
  if (rows.length === 0) return { merged: 0, conflicts: [] };

  const nextSystem = codeSystemDefinitions();
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
        ownerId: r.owner_id as string,
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
      const { merged, conflicts } = threeWayMerge(base, nextSystem, row);
      await db.transaction(async (tx) => {
        await tx.execute(
          drizzleSql`UPDATE registry_deltas
                       SET delta = ${JSON.stringify(merged)}::jsonb, base_version = ${systemVersion}
                     WHERE id = ${row.id}::uuid`,
        );
        await bumpOwnerRegistryVersion(tx, row.ownerId);
        if (conflicts.length === 0) return;
        // Заметка — ТОЙ ЖЕ транзакцией, что переписывает дельту. Порознь возможен исход
        // «дельта слита, а владельцу не сказали»: следующий прогон её уже не найдёт
        // (`base_version` переехал на текущую версию) и промолчит навсегда.
        const threadId = await ensureGlobalThread(tx, row.ownerId);
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
          ownerId: row.ownerId,
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
    `seed-registries: свойств ${r.properties}, ролей ${r.roles}, аспектов ${r.aspects}; ` +
      `версия system-реестров ${r.version}; дельт слито ${r.mergedDeltas}`,
    ...(r.conflicts.length === 0
      ? []
      : [
          `КОНФЛИКТЫ СЛИЯНИЯ (${r.conflicts.length}) — владельцу отправлена системная заметка:`,
          ...r.conflicts.map(registryConflictLine),
        ]),
  ];
}
