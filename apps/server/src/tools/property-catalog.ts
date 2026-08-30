// apps/server/src/tools/property-catalog.ts
// `property_catalog` (§А9-3) — ЕДИНСТВЕННЫЙ путь модели к свойствам, у которых нет
// `attach_*`-тула: к свободным (не объявленным ни одним аспектом) и к `proposed` (§А2-7 —
// в промпт они не входят). Плюс уточнение по любому свойству: тип, варианты, носители.
//
// Почему отдельным тулом, а не разделом промпта: полный каталог не масштабируется (§Б7-2 —
// 28,5 токена на свойство, порог 1.5× пробивается на +33 свойствах), а промпт-индекс даёт
// аспекты, но не поля. Тул платит токенами только когда модели действительно надо уточнить.
//
// Тул ЧИТАЮЩИЙ и при этом `fullScopeOnly` (§А9-4): каталог свойств — карта поверхности
// владельца целиком, и фоновому исполнителю (`worker`) она не адресована — его периметр это
// назначенные тикеты, а не устройство графа. Гейт стоит дважды: список (`mcp/server.ts`) и
// вызов (`tools/dispatch.ts`) — список подсказка, доступ решает сервер.
import { effectiveLabel, type PropertyDefinition } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/with-identity';
import { carrierAspects } from '../executor/props';
import type { RegistrySnapshot } from '../registry/load';

/**
 * Вход тула. `contract` ИНЕРТЕН в срезе А и это сказано вслух: привязки к контрактам
 * (`aspect.implements`) заводит §Б2 части Б, и в срезе А поле строки реестра пустует у всех
 * тринадцати аспектов. Параметр объявлен уже сейчас, потому что форму результата и входа
 * этот тул фиксирует один раз (Задача 17 добавит только `orphans`/`olderThanDays`), а
 * фильтр, который сегодня ничего не сужает, честнее фильтра, который сегодня всё обнуляет:
 * лишние строки модель отбросит сама, пустой ответ она прочитает как «таких свойств нет».
 */
export const propertyCatalogInput = z
  .object({
    q: z.string().min(1).optional(),
    aspect: z.string().min(1).optional(),
    module: z.string().min(1).optional(),
    status: z.enum(['active', 'proposed', 'deprecated']).optional(),
    contract: z.string().min(1).optional(),
    /**
     * Сироты (§А2-7, отчёт садовника): свойство, которого не объявляет НИ ОДИН аспект и у
     * которого нет НИ ОДНОГО значения. Оба условия обязательны вместе — по одному они
     * отвечают на другие вопросы (свойство без носителя, но со значениями — след переезда;
     * свойство с носителем и нулём значений — просто незаполненное поле, см. `PropertyUsage`).
     *
     * Булев флаг, а не `orphans: 'only' | 'exclude'`: обратный отбор («покажи неосиротевшие»)
     * — это каталог без фильтра, и второе имя того же ответа модель толковала бы как третий
     * режим. `false` поэтому значит ровно то же, что отсутствие ключа.
     */
    orphans: z.boolean().optional(),
    /**
     * Возраст СТРОКИ реестра в днях: старше — попадает в выдачу. Ради отчёта садовника о
     * `proposed` старше 14 дней (§А2-7), но фильтр намеренно не привязан к статусу: «когда
     * это завели» — вопрос о любой строке, и связка со статусом делается вторым ключом
     * (`status: 'proposed', olderThanDays: 14`), а не зашита в имя.
     *
     * `created_at` НЕ входит в `PropertyDefinition` (§А2-1 её не несёт) и читается отдельным
     * запросом к `property_definitions`: это единственное поле каталога, которого нет в
     * снимке реестра, и добавлять его в снимок ради одного фильтра значило бы платить
     * лишней колонкой на каждом вызове любого тула.
     */
    olderThanDays: z.number().int().min(0).optional(),
  })
  .strict();
export type PropertyCatalogInput = z.infer<typeof propertyCatalogInput>;

/**
 * Где свойство используется: аспекты-НОСИТЕЛИ (кто его объявляет) и число сущностей, у
 * которых оно ЗАПОЛНЕНО.
 *
 * Пара нужна целиком: свойство без носителей, но со значениями — след переезда, а свойство
 * с носителем и нулём значений — кандидат в сироты (§А2-7, отчёт садовника). По одной
 * половине эти два случая неразличимы.
 *
 * Носители названы `key`, а не id: модель адресует аспект тем же именем, каким видит его в
 * `entity_query` и в имени `attach_*`-тула (§А9-2, Р12 «key для машин»).
 */
export interface PropertyUsage {
  aspects: string[];
  /** Считаются ВСЕ видимые сущности, включая архивные: значение архивной — тоже значение. */
  entities: number;
}

/**
 * Строка каталога. `label`/`description` — уже РАЗРЕШЁННЫЕ в локаль читателя (§А2-1), а не
 * объекты `{ru, en}`: тул читает модель, и второй язык в ответе — только лишние токены.
 *
 * `type` едет ОБЪЕКТОМ словаря (§А2-2), а не именем kind: варианты `select`, границы
 * `decimal` и цель `ref` — это ровно то, ради чего модель в каталог и пришла.
 */
export interface PropertyCatalogRow {
  id: string;
  /** Адрес, которым модель пишет и читает это свойство (`props`, `entity_query`, `unset`). */
  key: string;
  label: string;
  description: string;
  type: PropertyDefinition['type'];
  status: PropertyDefinition['status'];
  module: string | null;
  usage: PropertyUsage;
}

export interface PropertyCatalogResult {
  properties: PropertyCatalogRow[];
}

/** Совпадение по слову: key, подпись и смысл, во ВСЕХ локалях строки, регистронезависимо. */
function matchesQuery(def: PropertyDefinition, needle: string): boolean {
  const haystack = [def.key, ...Object.values(def.label), ...Object.values(def.description)];
  return haystack.some((text) => text.toLowerCase().includes(needle));
}

/**
 * Число сущностей с ЗАПОЛНЕННЫМ свойством — одним запросом на все свойства выдачи.
 *
 * `props ?| <массив>` отбирает строки индексом `entities_props_gin` (проверено EXPLAIN:
 * `Bitmap Index Scan on entities_props_gin`), а `jsonb_object_keys` разворачивает уже
 * отобранное: обратный порядок (развернуть всё, потом отфильтровать) читал бы таблицу
 * целиком. Ключи вне выдачи отсеиваются в `WHERE`, иначе GROUP BY считал бы все свойства
 * графа ради десятка нужных.
 *
 * Список едет ОДНИМ параметром-jsonb и разворачивается в `text[]` внутри запроса. Массив
 * JS в шаблоне `sql` drizzle разворачивает в кортеж `($1,…,$N)`, а `record` к `text[]` не
 * приводится — та же ловушка, из-за которой в репозитории вместо сырого `= ANY($1::uuid[])`
 * стоит `inArray` (`routers/entity.ts`); здесь `inArray` не подходит — оператор `?|`
 * билдером не выражается.
 *
 * Под RLS того же `tx`: каталог — поверхность ВЛАДЕЛЬЦА, и чужие значения в счётчик попасть
 * не могут по построению.
 */
async function usageCounts(tx: Tx, propertyIds: string[]): Promise<Map<string, number>> {
  if (propertyIds.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    WITH ids AS (
      SELECT array_agg(k)::text[] AS arr
      FROM jsonb_array_elements_text(${JSON.stringify(propertyIds)}::jsonb) AS t(k)
    )
    SELECT k AS property, count(*)::int AS n
    FROM ids, entities e, LATERAL jsonb_object_keys(e.props) AS k
    WHERE e.props ?| ids.arr AND k = ANY(ids.arr)
    GROUP BY k`)) as unknown as Array<{ property: string; n: number }>;
  return new Map(rows.map((r) => [r.property, Number(r.n)]));
}

/**
 * Строки реестра, заведённые ДО указанного момента — одним запросом на всю выдачу.
 *
 * Отдельный поход в `property_definitions` тут не «второе мнение о том, что в реестре есть»
 * (в шапке ветки каталога сказано, что второго мнения быть не должно): состав выдачи по-
 * прежнему решает СНИМОК, а этот запрос отвечает на вопрос, которого в снимке нет вовсе —
 * когда строку завели. Поэтому и фильтрует он по УЖЕ отобранным id, а не по таблице целиком:
 * строка, которой нет в снимке (скрытая дельтой), из-за возраста в выдаче не появится.
 *
 * `owner_id IS NULL OR owner_id = …` — тот же предикат, что у `loadRegistryRows`: у
 * встроенных строк `created_at` тоже есть (его ставит сид), и молча выкинуть их значило бы
 * отвечать «встроенных свойств старше двух недель не бывает».
 *
 * Граница приходит ГОТОВОЙ датой, а не считается здесь из `now()` БД: часы вызова — те же,
 * что у прогона рутины и у метеринга (`ToolCallCtx.clock`), и второй источник времени сделал
 * бы фильтр непроверяемым тестом с инъецированными часами.
 */
async function createdBefore(
  tx: Tx,
  ownerId: string,
  propertyIds: string[],
  boundary: Date,
): Promise<Set<string>> {
  if (propertyIds.length === 0) return new Set();
  const rows = (await tx.execute(sql`
    WITH ids AS (
      SELECT array_agg(k)::text[] AS arr
      FROM jsonb_array_elements_text(${JSON.stringify(propertyIds)}::jsonb) AS t(k)
    )
    SELECT id
    FROM ids, property_definitions d
    WHERE d.id = ANY(ids.arr)
      AND (d.owner_id IS NULL OR d.owner_id = ${ownerId}::uuid)
      AND d.created_at < ${boundary.toISOString()}::timestamptz`)) as unknown as Array<{
    id: string;
  }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * Каталог свойств владельца (§А9-3): системные ∪ свои, отфильтрованные и с `usage`.
 *
 * Порядок выдачи — `rank` СЛОВАРЯ свойств (§А2-1), то есть порядок объявления в реестре.
 * Он НЕ совпадает с порядком полей в `attach_*`: там порядок задаёт `rank` ССЫЛКИ аспекта
 * (§А3-1, §Б7-3), и одно свойство у двух носителей стоит на разных местах. Каталог — выдача
 * по всему словарю, у неё носителя может не быть вовсе (свободные свойства), поэтому
 * порядок здесь один на любой фильтр: два разных порядка в одном ответе, зависящие от того,
 * задан ли `aspect`, читались бы как случайность.
 *
 * При равных `rank` (системное и своё свойство ранжируются независимо) порядок
 * доопределяется ключом — иначе выдача плавала бы между вызовами на ровном месте.
 */
export async function runPropertyCatalog(
  tx: Tx,
  reg: RegistrySnapshot,
  input: PropertyCatalogInput,
  locale: string,
  args: { ownerId: string; now: Date },
): Promise<PropertyCatalogResult> {
  // Носители — общей `carrierAspects` (она же держит запрет по объекту в предложении):
  // второй обход тех же ссылок разошёлся бы с первым молча. Она отдаёт id аспекта, а
  // каталог показывает модели `key` — у встроенных они совпадают, у своего аспекта нет.
  const aspectKeyById = new Map([...reg.aspects.values()].map((a) => [a.id, a.key]));
  const carriersOf = (propertyId: string): string[] =>
    carrierAspects(reg, propertyId).map((id) => aspectKeyById.get(id) ?? id);

  const needle = input.q?.toLowerCase();
  const selected: PropertyDefinition[] = [];
  for (const def of reg.properties.values()) {
    if (needle !== undefined && !matchesQuery(def, needle)) continue;
    if (input.status !== undefined && def.status !== input.status) continue;
    if (input.module !== undefined && def.module !== input.module) continue;
    if (input.aspect !== undefined) {
      // Аспект адресуется и key, и id (у встроенных они совпадают) — тем же правилом, что
      // свойство на границе тулов: модель пишет тем именем, которым видела.
      const carrier = reg.aspects.get(input.aspect);
      const wanted = carrier?.properties.some((r) => r.propertyId === def.id) === true;
      const byKey = carriersOf(def.id).includes(input.aspect);
      if (!wanted && !byKey) continue;
    }
    selected.push(def);
  }
  selected.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));

  const counts = await usageCounts(
    tx,
    selected.map((d) => d.id),
  );

  // ДВА ФИЛЬТРА ПОСЛЕ ЗАПРОСОВ, А НЕ В ЦИКЛЕ ВЫШЕ, и порядок здесь вынужденный: `orphans`
  // спрашивает про `usage`, а его половину (`entities`) знает только `usageCounts`; поставь
  // фильтр раньше — и считать пришлось бы по одному свойству за запрос. `olderThanDays` идёт
  // тем же путём по другой причине: возраст лежит в таблице, а не в снимке, и его тоже
  // спрашивают одним запросом на всю выдачу.
  const aged =
    input.olderThanDays === undefined
      ? undefined
      : await createdBefore(
          tx,
          args.ownerId,
          selected.map((d) => d.id),
          new Date(args.now.getTime() - input.olderThanDays * 86_400_000),
        );

  const shown = selected.filter((def) => {
    if (input.orphans === true) {
      if ((counts.get(def.id) ?? 0) !== 0) return false;
      if (carriersOf(def.id).length !== 0) return false;
    }
    if (aged !== undefined && !aged.has(def.id)) return false;
    return true;
  });

  return {
    properties: shown.map((def) => ({
      id: def.id,
      key: def.key,
      label: effectiveLabel(def.label, locale),
      description: effectiveLabel(def.description, locale),
      type: def.type,
      status: def.status,
      module: def.module,
      usage: {
        aspects: carriersOf(def.id),
        entities: counts.get(def.id) ?? 0,
      },
    })),
  };
}
