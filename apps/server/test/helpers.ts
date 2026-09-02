// apps/server/test/helpers.ts
import type { LocalizedText, PropertyType } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { type Db, makeDb } from '../src/db/client';
import { DEFINITION_TABLES } from '../src/db/reset-world';
import type { entities } from '../src/db/schema';
import type { Tx } from '../src/db/with-identity';
import { execute } from '../src/executor/executor';
import { resolvePropertyRef } from '../src/executor/props';
import type { ExecuteRequest, ExecuteResult, ExecutorDeps } from '../src/executor/types';
import { effectiveRegistry } from '../src/registry/cache';
import type { RegistrySnapshot } from '../src/registry/load';
import { bumpOwnerRegistryVersion } from '../src/registry/version';

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

// Шесть definition-таблиц реформы берутся ИЗ ПРОД-ОПЕРАЦИИ пересева (`db/reset-world.ts`), а
// не переписываются здесь: правило у обеих одно — «строки владельца вон, встроенные
// остаются», и седьмой реестр части Б, попавший только в один из двух списков, дал бы либо
// течь состояния между сьютами, либо переживший пересев мусор в проде.

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

/**
 * ФИКСТУРА ПРАВИТ РЕЕСТР — ЗНАЧИТ, ДВИГАЕТ ВЕРСИЮ (§А10-1).
 *
 * Прямой INSERT строки реестра из теста — такая же мутация реестра, как операция владельца,
 * и с Задачи 14 её видимость решает не база, а версия: снимок эффективных определений
 * кешируется процессом по ключу `(владелец, его версия, системная)` (`registry/cache.ts`).
 * Фикстура, забывшая позвать эту функцию, получит снимок БЕЗ своей строки — молча, и тест
 * будет проверять не то, что написано в его имени.
 *
 * Функция — та же самая, что зовёт боевой писатель (`bumpOwnerRegistryVersion`), а не
 * «сброс кеша для тестов»: сброс был бы вторым механизмом инвалидации, которого в бою нет,
 * и зелень на нём ничего не говорила бы о проде.
 *
 * Своё подключение админской ролью: у фикстур транзакции на руках нет, а строка настроек
 * владельца может ещё не существовать (UPSERT внутри её заводит).
 */
export async function bumpRegistryVersion(ownerId: string): Promise<number> {
  const { db, client } = adminDb();
  try {
    return await bumpOwnerRegistryVersion(db, ownerId);
  } finally {
    await client.end();
  }
}

/** Одно свойство кастомного аспекта: локальное имя поля + тип из словаря §А2-2. */
export interface CustomAspectProperty {
  /**
   * Локальное имя поля БЕЗ namespace: id и `key` свойства собираются из него и namespace'а
   * аспекта (`user/hours`). В `data` тула `attach_*` уезжает ИМЕННО ПОЛНЫЙ key (§А9-1,
   * Задача 12).
   */
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
 * Кастомный аспект владельца В НОВОЙ ФОРМЕ: строки-свойства в `property_definitions` плюс
 * строка аспекта, которая на них ссылается.
 *
 * Зачем хелпер, а не `insert().values()` на месте: с реформой «завести кастомный аспект»
 * перестало быть одной вставкой — это N+1 строка в двух таблицах. Три сьюта, которым нужна
 * такая фикстура, повторяли бы это трижды, и первый же забытый `property_definitions` дал
 * бы аспект, чьи свойства не резолвятся.
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

    const refs = spec.properties.map((p, index) => ({
      propertyId: propertyId(p.key),
      required: p.required ?? false,
      rank: index + 1,
    }));

    await db.execute(sql`
      INSERT INTO aspect_definitions
        (id, owner_id, key, label, description, properties, implements,
         ai_instructions, tag_mappings, view_config, module, service, rank)
      VALUES (${spec.key}, ${ownerId}, ${spec.key},
              ${JSON.stringify(spec.label)}::jsonb,
              ${JSON.stringify(spec.description ?? spec.label)}::jsonb,
              ${JSON.stringify(refs)}::jsonb, '[]'::jsonb,
              ${spec.aiInstructions ?? null},
              ${sql.raw(pgTextArray(spec.tagMappings ?? []))},
              ${JSON.stringify({ keyFields: refs.map((r) => r.propertyId) })}::jsonb,
              NULL, false, 0)
      ON CONFLICT (owner_id, id) WHERE owner_id IS NOT NULL DO UPDATE SET
        key = EXCLUDED.key, label = EXCLUDED.label, description = EXCLUDED.description,
        properties = EXCLUDED.properties,
        ai_instructions = EXCLUDED.ai_instructions, view_config = EXCLUDED.view_config`);

    // Реестр владельца изменился — версия обязана сдвинуться (§А10-1), иначе снимок в
    // кеше процесса останется без этого аспекта.
    //
    // ОГОВОРКА, чтобы фикстура не читалась как образец инварианта: §А10-1 требует
    // инкремент В ТОЙ ЖЕ ТРАНЗАКЦИИ, что мутация, а здесь три autocommit-стейтмента
    // подряд на одном подключении — транзакции у хелпера нет вовсе. Для фикстуры это
    // безразлично (никто не наблюдает её промежуточные состояния), но писателю реестра
    // так писать НЕЛЬЗЯ: образец транзакционного инкремента — `registry/cache.test.ts`,
    // где INSERT дельты и `bumpOwnerRegistryVersion` идут одним `withIdentity`.
    await bumpOwnerRegistryVersion(db, ownerId);
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

/** Колонки значений строки `entities` — то, чем фикстура с прямым INSERT говорит о свойствах. */
export interface EntityValueColumns {
  props: Record<string, unknown>;
  aspects: string[];
}

/**
 * Колонки значений из СВОЙСТВ по ГОТОВОМУ снимку реестра — ядро фикстуры с прямым INSERT.
 * Отдельно от `entityColumns` ниже ровно затем, чтобы сьюты, у которых снимок уже прочитан
 * (перф-датасет `compile.dataset.test.ts`), шли через ТУ ЖЕ проверку, а не собирали строку
 * литералом рядом.
 *
 * ЗАЧЕМ ХЕЛПЕР, ЕСЛИ КОЛОНОК ДВЕ И ОБЕ ЛОЖАТСЯ КАК ЕСТЬ. Ради ГРОМКОГО ОТКАЗА НА ЧУЖОЙ
 * АДРЕС. Прямой INSERT минует валидатор исполнителя, поэтому опечатка в id свойства
 * (`orbis/finance_cateogry`) уехала бы в базу молча: строка есть, значение под неизвестным
 * ключом лежит, а ни один читатель его не находит — тест падает не там, где ошибка, либо
 * не падает вовсе. В проде такой строки не бывает: исполнитель отвечает `UNKNOWN_PROPERTY`.
 *
 * Проверка идёт по РЕЕСТРУ, а не по перечисленным аспектам, и это не послабление. Свойство
 * без аспекта законно (§А1-2, свободное свойство), и значение аспекта, который сняли,
 * законно тоже (Р9: снятие аспекта значений не трогает) — обе формы обязаны заводиться
 * фикстурой. Незаконно ровно одно: адрес, которого в реестре владельца НЕТ.
 */
export function entityColumnsFrom(
  reg: RegistrySnapshot,
  props: Record<string, unknown>,
  aspects: string[],
): EntityValueColumns {
  for (const keyOrId of Object.keys(props)) {
    if (resolvePropertyRef(reg, keyOrId) !== undefined) continue;
    throw new Error(
      `entityColumns: неизвестное свойство «${keyOrId}» — в реестре владельца такого адреса ` +
        'нет, и ни один читатель значения не найдёт (исполнитель ответил бы ' +
        'UNKNOWN_PROPERTY). Опечатка в id либо аспект не засеян.',
    );
  }
  return { props, aspects };
}

/**
 * То же самое, но снимок реестра читается сам — обычная форма для сьютов.
 *
 * Снимок читается на каждый вызов: фикстур в сьюте единицы, а кеш здесь стоил бы
 * инвалидации после `seedCustomAspect`.
 */
export async function entityColumns(
  tx: Tx,
  ownerId: string,
  props: Record<string, unknown>,
  aspects: string[],
): Promise<EntityValueColumns> {
  return entityColumnsFrom(await effectiveRegistry(tx, ownerId), props, aspects);
}

/** Строка `entities`, записанная ПРЯМЫМ INSERT'ом мимо исполнителя, — вход `rawEntityRow`. */
export interface RawRowSpec {
  ownerId: string;
  id: string;
  title: string;
  /** Значения по id свойства (§А1-1). */
  props: Record<string, unknown>;
  /** Список интерпретаций. */
  aspects: string[];
  archived?: boolean;
}

/**
 * Строка `entities` прямым INSERT'ом мимо исполнителя.
 *
 * ЗАЧЕМ ОНА НУЖНА ПОСЛЕ РЕФОРМЫ. До «Пересева мира» этот помощник звался
 * `divergentEntityRow` и служил ровно одному: развести НОВУЮ правду (`props`/`aspects[]`) и
 * СТАРУЮ карту (`aspects_legacy`), чтобы вопрос «какую колонку ты читаешь» имел наблюдаемый
 * ответ. Второй колонки больше нет — разводить нечего, и этот класс проверок закрыт схемой,
 * а не тестом.
 *
 * Прямая запись всё же осталась нужной, и по другой причине: положить в граф значение,
 * которого исполнитель бы НЕ ПРОПУСТИЛ (null у свойства, состояние «до бэкфилла»,
 * сломанная форма) — иначе отказ читателя на таком значении нечем воспроизвести. Валидатор
 * здесь намеренно обойдён, поэтому и имя честное: не «строка», а «сырая строка».
 */
export function rawEntityRow(spec: RawRowSpec): typeof entities.$inferInsert {
  return {
    id: spec.id,
    ownerId: spec.ownerId,
    title: spec.title,
    props: spec.props,
    aspects: spec.aspects,
    ...(spec.archived === undefined ? {} : { archived: spec.archived }),
  };
}

/**
 * Цели ссылок с ЗАДАННЫМИ id — фикстура ссылочных свойств (§А6-1).
 *
 * До реформы `category_ref` в фикстурах был любым uuid: сервер его не проверял, и «категория»
 * существовала только как строка в jsonb. С Задачи 11 значение `orbis/finance_category`
 * проверяется компиляцией множества `target` (`aspect=orbis/category`) под RLS, и выдуманный
 * id — честный отказ `REF_TARGET`. Фикстуре при этом нужна не другая ссылка, а настоящая
 * цель: id остаётся тем же, что был, поэтому остальные утверждения сьютов не меняются.
 *
 * Прямой INSERT мимо исполнителя — намеренно (как у `divergentEntityRow`): категория здесь
 * ОБСТАНОВКА, а не предмет проверки, и гонять её через конвейер значило бы удваивать время
 * каждого сьюта ради строки из трёх колонок. `ON CONFLICT DO NOTHING` делает вызов
 * идемпотентным: сьюты зовут её и на общий id describe-блока, и повторно внутри тестов.
 */
export async function seedRefTargetRows(
  ownerId: string,
  targets: ReadonlyArray<{ id: string; aspect: string }>,
): Promise<void> {
  if (targets.length === 0) return;
  const { db, client } = adminDb();
  try {
    const seen = new Set<string>();
    for (const target of targets) {
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      await db.execute(sql`
        INSERT INTO entities (id, owner_id, title, tags, props, aspects)
        VALUES (${target.id}::uuid, ${ownerId}::uuid, ${`Цель ссылки (${target.aspect})`},
                '{}'::text[], '{}'::jsonb, ARRAY[${target.aspect}]::text[])
        ON CONFLICT (id) DO NOTHING`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Ссылочные свойства фикстур и АСПЕКТ, которым описано множество их цели (§А6-1). Старая
 * форма входа называет их полями аспект-ключа, новая — id свойства; фикстуры сьютов пишут и
 * так и так, поэтому оба имени перечислены здесь один раз.
 *
 * Список закрыт намеренно и держится РОВНО фикстурами: это не второй реестр, а перечень тех
 * ссылок, которые сьюты выдумывали до §А6-1. Свойство, которого здесь нет, обстановкой не
 * чинится — и это правильно: пусть падает и заводит себе цель осознанно.
 */
const FIXTURE_REF_TARGET_ASPECT: Readonly<Record<string, string>> = {
  category_ref: 'orbis/category',
  'orbis/finance_category': 'orbis/category',
  rule_target: 'orbis/category',
  'orbis/rule_target': 'orbis/category',
  routine_id: 'orbis/routine',
  'orbis/run_routine': 'orbis/routine',
};

/** uuid — та же форма, что у значения kind `ref` (`format: uuid` схемы значения). */
const FIXTURE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Завести цели под ВСЕ ссылочные свойства, названные во входе исполнителя (§А6-1).
 *
 * Ставится в фикстурный «воронкообразный» помощник сьюта — тот единственный, через который
 * тесты файла создают сущности. Так правка на файл ровно одна, а не по одной на каждый
 * выдуманный uuid; и так же она не задевает утверждений: id ссылки остаётся тем, что выбрала
 * фикстура, — меняется лишь то, что теперь у него есть настоящая цель.
 *
 * Обход рекурсивный, потому что вход бывает трёх форм: старая карта аспектов (ключ
 * `aspects` с объектом «id аспекта → поля»), новая (`props` со значением по id свойства,
 * например `orbis/finance_category`) и envelope батча (`operations[].input`). Разбирать их
 * порознь значило бы завести три фикстурных правила там, где правило одно: «названная
 * категория обязана существовать».
 *
 * Старая форма названа здесь СЛОВАМИ, а не образцом: образец старой карты в тексте — то,
 * что ищет страж `scripts/legacy-aspects-map.test.ts`, и докблок стоил бы ему записи в
 * allowlist на ровном месте.
 */
export async function seedCategoriesOfInput(ownerId: string, input: unknown): Promise<void> {
  const targets: Array<{ id: string; aspect: string }> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      const aspect = FIXTURE_REF_TARGET_ASPECT[key];
      if (aspect !== undefined && typeof value === 'string' && FIXTURE_UUID_RE.test(value)) {
        targets.push({ id: value, aspect });
      }
      walk(value);
    }
  };
  walk(input);
  await seedRefTargetRows(ownerId, targets);
}

/**
 * Исполнитель ДЛЯ ФИКСТУР: перед применением заводит категории, названные ссылочными
 * свойствами входа (`seedCategoriesOfInput`), и дальше зовёт настоящий `execute`.
 *
 * ЗАЧЕМ ОН ЕСТЬ. До §А6-1 сьюты писали `category_ref: newId()` — сервер ссылку не проверял, и
 * «категория» жила строкой в jsonb. Теперь ссылка обязана указывать на живую категорию
 * владельца, и у двух десятков сьютов обстановка перестала быть законной. Предмет их проверок
 * при этом не изменился ни в одном: им нужна транзакция В КАКОЙ-НИБУДЬ категории, а не
 * конкретная категория. Обёртка чинит обстановку одним импортом на файл вместо сотни правок
 * по месту — и оставляет id ссылок ровно теми, что выбрали сами фикстуры.
 *
 * ЧЕГО ОНА НЕ ДЕЛАЕТ И ГДЕ ЕЙ НЕ МЕСТО: она ГАСИТ отказ `REF_TARGET` по несуществующей
 * категории. Сьют, который проверяет САМ этот отказ, обязан звать `execute` напрямую —
 * так и сделано в `registry/ref.test.ts`, где обёртки нет вовсе.
 */
export function executeWithFixtureCategories(
  db: Db,
  req: ExecuteRequest,
  deps?: ExecutorDeps,
): Promise<ExecuteResult> {
  return seedCategoriesOfInput(req.actorUserId, req.operations).then(() => execute(db, req, deps));
}
