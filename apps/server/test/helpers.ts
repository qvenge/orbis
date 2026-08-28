// apps/server/test/helpers.ts
import {
  type LegacyAspects,
  type LocalizedText,
  type PropertyType,
  propertyValueJsonSchema,
  X_ORBIS_DECIMAL,
  X_ORBIS_TYPE,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { makeDb } from '../src/db/client';
import type { entities } from '../src/db/schema';
import type { Tx } from '../src/db/with-identity';
import { type LegacyRow, rowFromLegacy } from '../src/executor/legacy-form';
import { loadRegistry } from '../src/registry/load';

export function requireEnv(): void {
  for (const k of ['DATABASE_URL', 'DATABASE_URL_ADMIN']) {
    if (!process.env[k]) {
      throw new Error(
        `Интеграционные тесты требуют ${k} (локально: bunx supabase start, см. apps/server/.env.example)`,
      );
    }
  }
}

export function appDb() {
  return makeDb({ max: 3 });
}

export function adminDb() {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.DATABASE_URL_ADMIN;
  try {
    return makeDb({ max: 1 });
  } finally {
    process.env.DATABASE_URL = prev;
  }
}

/** Случайный owner: FK на auth.users не объявлен (решение 1 плана), строка в auth не нужна. */
export function freshUserId(): string {
  return crypto.randomUUID();
}

/**
 * Шесть definition-таблиц реформы: у каждой встроенные строки (`owner_id IS NULL`)
 * переживают зачистку, пользовательские — нет. Список литералом, а не обходом схемы:
 * забытая таблица должна ловиться чтением этого файла, а не «почему-то течёт состояние».
 */
const DEFINITION_TABLES = [
  'property_definitions',
  'aspect_definitions',
  'relation_role_definitions',
  'contract_definitions',
  'subscription_definitions',
  'action_definitions',
] as const;

/** Полная зачистка данных между сьютами (админ-DSN, обходит RLS). */
export async function truncateAll(): Promise<void> {
  const { db, client } = adminDb();
  await db.execute(sql`TRUNCATE entities, relations, user_settings, chat_threads,
    chat_messages, ai_usage, entity_origins, entity_versions, agent_grants, oauth_clients
    RESTART IDENTITY CASCADE`);
  // Встроенные строки реестров сознательно переживают зачистку: их кладёт один раз
  // `bun run db:prepare`, и пересевать реестр между сьютами значило бы гонять сид сотни раз.
  for (const table of DEFINITION_TABLES) {
    await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE owner_id IS NOT NULL`);
  }
  // Дельты бывают только пользовательские (owner_id NOT NULL) — здесь чистится всё.
  await db.execute(sql`TRUNCATE registry_deltas`);
  // registry_system НЕ трогается НАМЕРЕННО: строка одна, PK = 1, и её удаление сломало бы
  // инкремент версии в сидере (UPDATE … WHERE id = 1 не нашёл бы строки). Поэтому тесты
  // версии сида пишутся ОТНОСИТЕЛЬНО — `after === before + 1`, а не абсолютом.
  await client.end();
}

/** Одно свойство кастомного аспекта: локальное имя поля + тип из словаря §А2-2. */
export interface CustomAspectProperty {
  /** Локальное имя поля БЕЗ namespace: оно же ключ в `data` тула `attach_*`. */
  key: string;
  type: PropertyType;
  required?: boolean;
}

export interface CustomAspectSpec {
  /** namespaced-ключ аспекта, он же его id: `user/sleep-log`. */
  key: string;
  label: LocalizedText;
  properties: CustomAspectProperty[];
  description?: LocalizedText;
  aiInstructions?: string;
  tagMappings?: string[];
}

/**
 * Аннотации реформы (`x-orbis-*`) снимаются перед записью в колонку `schema`: её читает
 * СТАРЫЙ путь валидации (`executor/aspects-validate.ts`), а его ajv собран без
 * `addKeyword` и в strict-режиме бросает на любом незнакомом ключе схемы. Встроенные
 * legacy-схемы (`legacyAspectJsonSchema`) этих ключей тоже не несут — фикстура остаётся с
 * ними в одной форме. Колонка уходит вместе со старым путём в миграции 0017 (Р-24).
 */
function legacyValueSchema(type: PropertyType): Record<string, unknown> {
  const schema = { ...propertyValueJsonSchema(type) };
  delete schema[X_ORBIS_TYPE];
  delete schema[X_ORBIS_DECIMAL];
  return schema;
}

/**
 * Кастомный аспект владельца В НОВОЙ ФОРМЕ: строки-свойства в `property_definitions` плюс
 * строка аспекта, которая на них ссылается.
 *
 * Зачем хелпер, а не `insert().values()` на месте: с реформой «завести кастомный аспект»
 * перестало быть одной вставкой — это N+1 строка в двух таблицах плюс производная старая
 * схема. Три сьюта, которым нужна такая фикстура, повторяли бы это трижды, и первый же
 * забытый `property_definitions` дал бы аспект, чьи свойства не резолвятся, — молча, потому
 * что старый путь валидации читает только колонку `schema`.
 *
 * `schema` заполняется ПОТОМУ ЖЕ, почему её заполняет сид встроенных: до миграции 0017 по
 * ней валидирует стадия 2 исполнителя и из неё собирается вход тула `attach_*` (Р-24).
 *
 * id свойства — `<namespace аспекта>/<имя поля>`: `user/sleep-log` + `hours` → `user/hours`.
 * Два кастомных аспекта одного владельца с одноимённым полем при этом ДЕЛЯТ одно свойство,
 * и это не коллизия, а ровно модель реформы (Р5): свойство — общее, аспект лишь ссылается
 * на него, добавляя обязательность и порядок. Оттуда же выводится старое имя поля для
 * карточек и старой валидации — локальная часть key (см. `keyFieldsByAspect` в
 * `tools/dispatch.ts`).
 */
export async function seedCustomAspect(ownerId: string, spec: CustomAspectSpec): Promise<void> {
  const namespace = spec.key.split('/')[0] ?? 'user';
  const propertyId = (field: string): string => `${namespace}/${field}`;

  const { db, client } = adminDb();
  try {
    for (const [index, p] of spec.properties.entries()) {
      await db.execute(sql`
        INSERT INTO property_definitions
          (id, owner_id, key, label, description, type, status, storage, rank, flags)
        VALUES (${propertyId(p.key)}, ${ownerId}, ${propertyId(p.key)},
                ${JSON.stringify({ ru: p.key })}::jsonb,
                ${JSON.stringify({ ru: `Поле ${p.key} (${spec.key})` })}::jsonb,
                ${JSON.stringify(p.type)}::jsonb, 'active', 'props', ${index + 1}, '{}'::jsonb)
        ON CONFLICT (owner_id, id) WHERE owner_id IS NOT NULL DO UPDATE SET
          key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
          type = EXCLUDED.type, rank = EXCLUDED.rank`);
    }

    const legacySchema = {
      type: 'object',
      properties: Object.fromEntries(
        spec.properties.map((p) => [p.key, legacyValueSchema(p.type)]),
      ),
      required: spec.properties.filter((p) => p.required).map((p) => p.key),
      additionalProperties: false,
    };
    const refs = spec.properties.map((p, index) => ({
      propertyId: propertyId(p.key),
      required: p.required ?? false,
      rank: index + 1,
    }));

    await db.execute(sql`
      INSERT INTO aspect_definitions
        (id, owner_id, key, label, description, properties, implements, schema,
         ai_instructions, tag_mappings, view_config, module, service, rank)
      VALUES (${spec.key}, ${ownerId}, ${spec.key},
              ${JSON.stringify(spec.label)}::jsonb,
              ${JSON.stringify(spec.description ?? spec.label)}::jsonb,
              ${JSON.stringify(refs)}::jsonb, '[]'::jsonb,
              ${JSON.stringify(legacySchema)}::jsonb,
              ${spec.aiInstructions ?? null},
              ${sql.raw(pgTextArray(spec.tagMappings ?? []))},
              ${JSON.stringify({ keyFields: refs.map((r) => r.propertyId) })}::jsonb,
              NULL, false, 0)
      ON CONFLICT (owner_id, id) WHERE owner_id IS NOT NULL DO UPDATE SET
        key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
        properties = EXCLUDED.properties, schema = EXCLUDED.schema,
        ai_instructions = EXCLUDED.ai_instructions, view_config = EXCLUDED.view_config`);
  } finally {
    await client.end();
  }
}

/**
 * Литерал text[] для `tag_mappings`. Через `sql.raw`, потому что drizzle-параметр массива
 * в `db.execute(sql``…``)` уезжает как строка и колонка text[] его не принимает; значения
 * здесь — ASCII-теги из фикстур, но кавычки всё равно экранируются.
 */
function pgTextArray(values: string[]): string {
  if (values.length === 0) return `'{}'::text[]`;
  return `ARRAY[${values.map((v) => `'${v.replaceAll("'", "''")}'`).join(',')}]::text[]`;
}

/**
 * Три колонки строки `entities` из старой карты аспектов — для фикстур с ПРЯМЫМ INSERT,
 * минуя исполнителя.
 *
 * Зачем помощник, а не переименование поля: после миграции 0015 имя `aspects` занял СПИСОК
 * аспектов новой формы, и фикстура, продолжающая писать в него карту, либо падает типом,
 * либо (там, где тип `unknown`) молча кладёт карту не в ту колонку. Проекция одна на
 * репозиторий — `executor/legacy-form.ts`, и фикстуры обязаны ходить через неё же, иначе
 * они разойдутся с писателем новой правды.
 *
 * Снимок реестра читается на каждый вызов: фикстур в сьюте единицы, а кеш здесь стоил бы
 * инвалидации после `seedCustomAspect`. Файл живёт до «Пересева мира» — вместе с проекцией.
 */
export async function legacyEntityColumns(
  tx: Tx,
  ownerId: string,
  aspectsLegacy: LegacyAspects,
): Promise<LegacyRow> {
  return rowFromLegacy(await loadRegistry(tx, ownerId), aspectsLegacy);
}

/** Строка `entities` с РАЗОШЕДШИМИСЯ колонками — вход `divergentEntityRow`. */
export interface DivergentRowSpec {
  ownerId: string;
  id: string;
  title: string;
  /** НОВАЯ правда (§А1-1): значения по id свойства. */
  props: Record<string, unknown>;
  /** НОВАЯ правда: список интерпретаций. */
  aspects: string[];
  /** СТАРАЯ карта — вторая, НАМЕРЕННО расходящаяся сторона пробы; по умолчанию пустая. */
  legacy?: LegacyAspects;
  archived?: boolean;
}

/**
 * Строка `entities`, у которой новая правда (`props`/`aspects[]`) и старая карта
 * (`aspects_legacy`) говорят РАЗНОЕ, — прямой INSERT мимо исполнителя.
 *
 * ЗАЧЕМ ТАКАЯ ФИКСТУРА ВООБЩЕ. На интервале дуальной записи (§А1-1) обе колонки пишет один
 * писатель (`projectLegacyAspects`), поэтому в проде они равны по построению. Пока они
 * равны, перевод читателя с одной колонки на другую НЕ НАБЛЮДАЕМ поведением: и старый, и
 * новый код дают одинаковый ответ, любой тест зелёный в обе стороны. Расхождение — это
 * вопрос «какую колонку ты читаешь», заданный так, что ответ виден; ничего другого этот
 * помощник не проверяет и проверять не может.
 *
 * Почему он живёт здесь, а не в сьюте: `legacyEntityColumns` (выше) — фикстура СОГЛАСОВАННОЙ
 * строки, и обе формы обязаны стоять рядом, чтобы «согласованная или разошедшаяся» был
 * выбор, а не случайность соседнего файла.
 */
export function divergentEntityRow(spec: DivergentRowSpec): typeof entities.$inferInsert {
  return {
    id: spec.id,
    ownerId: spec.ownerId,
    title: spec.title,
    props: spec.props,
    aspects: spec.aspects,
    aspectsLegacy: spec.legacy ?? {},
    ...(spec.archived === undefined ? {} : { archived: spec.archived }),
  };
}
