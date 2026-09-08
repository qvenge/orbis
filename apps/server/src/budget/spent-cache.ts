// apps/server/src/budget/spent-cache.ts
// Кэш `spent` конверта (§Б5-5) — ДОСТУП К ТАБЛИЦЕ и ничего больше.
//
// ПОЧЕМУ ЗДЕСЬ НЕТ НИ ОДНОГО ПРЕДИКАТА «ЧТО СЧИТАЕТСЯ ТРАТОЙ». Правило траты живёт в
// декларации подписки (`counted_set: 'facts'`, `where`, `currency` — §Б5-4) и компилируется
// движком (`subscriptions/budget.ts`). Повтори мы его здесь SQL'ем — получилась бы вторая
// правда о деньгах, причём с жёстким `'orbis/financial'` внутри: аспект ВЛАДЕЛЬЦА объявляет
// тот же контракт `orbis/money-movement`, и второй текст выкинул бы его из кэша, оставив
// ведомость и кэш с разными множествами. Это ровно тот разъезд, которым меряется §С8-18.
//
// Модуль — ЛИСТ: он не знает ни об исполнителе, ни о движке, ни об агрегатах, и потому его
// одинаково законно зовут обе стороны — читатель (движок) и писатель (исполнитель).
//
// КТО ЕЩЁ ПИШЕТ В ГРАФ, ТО ЕСТЬ МОГ БЫ СДВИНУТЬ `spent` МИМО ЭТИХ ПИСАТЕЛЕЙ (греп шага 27,
// `UPDATE entities` / `update(entities)` по боевому коду сервера — пятого пути нет):
//  — `executor/executor.ts` (создание и правка сущности) — через бюджет-хук, а он зовёт
//    `applySpentCacheEffect`;
//  — `registry/ops.ts` (слияние свойств и его откат, плюс переписывание AST-ссылок той же
//    транзакцией) — снос кэша владельца целиком (`invalidateSpentCacheOfOwner`);
//  — `registry/ref.ts` — правит только `tags` зеркала ссылок; `executor/ancestors.ts` — только
//    вычисляемые `orbis/*_project`; `seed/onboarding.ts` и `db/backfill-body-doc.ts` — только
//    тело документа: денег не касается ни один;
//  — четыре писателя, идущих ЧЕРЕЗ `execute` и потому покрытых хуком: `import/review.ts`,
//    `recurring/post-due.ts`, `recurring/materialize.ts`, `budget/plan-to-fact.ts`.
// Пятый путь — суточная граница, и её закрывает не писатель, а КЛЮЧ `(envelope_id, as_of)`.
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';
import type { RegistryVersions } from '../registry/version';

export interface SpentCacheKey {
  /** id сущности-конверта. */
  envelopeId: string;
  /** День, ПО СОСТОЯНИЮ НА КОНЕЦ которого посчитан `spent` (ISO `YYYY-MM-DD`). */
  asOf: string;
}

/** Обе половины версии реестра (§А10-1); `RegistryVersions` подходит целиком. */
export type SpentCacheVersions = Pick<RegistryVersions, 'ownerVersion' | 'systemVersion'>;

/**
 * Ключ карты чтения. Составной, потому что один вызов законно спрашивает и разные дни
 * (тесты границы суток): ключ по одному `envelopeId` схлопнул бы их молча.
 */
export function spentCacheKey(key: SpentCacheKey): string {
  return `${key.envelopeId}@${key.asOf}`;
}

/**
 * Строки кэша под ключи. Строка ЧУЖОЙ версии не возвращается — это и есть «смена
 * registry_version инвалидирует» (§С8-16): её не сносят, она просто перестаёт отвечать и
 * будет переписана первым же промахом (PK — та же пара).
 */
export async function readSpentCache(
  tx: Tx,
  ownerId: string,
  keys: readonly SpentCacheKey[],
  versions: SpentCacheVersions,
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const pairs = sql.join(
    keys.map((k) => sql`(${k.envelopeId}::uuid, ${k.asOf}::date)`),
    sql`, `,
  );
  const rows = (await tx.execute(sql`
    SELECT envelope_id, as_of::text AS as_of, spent::text AS spent
    FROM envelope_spent_cache
    WHERE owner_id = ${ownerId}
      AND owner_version = ${versions.ownerVersion}
      AND system_version = ${versions.systemVersion}
      AND (envelope_id, as_of) IN (${pairs})
  `)) as unknown as Array<{ envelope_id: string; as_of: string; spent: string }>;
  return new Map(
    rows.map((r) => [spentCacheKey({ envelopeId: r.envelope_id, asOf: r.as_of }), r.spent]),
  );
}

/**
 * Положить посчитанное. UPSERT, а не INSERT: два параллельных чтения одного владельца
 * законно промахиваются об один и тот же ключ, и проигравший обязан не падать, а обновить.
 */
export async function writeSpentCache(
  tx: Tx,
  ownerId: string,
  rows: readonly (SpentCacheKey & { spent: string })[],
  versions: SpentCacheVersions,
): Promise<void> {
  if (rows.length === 0) return;
  const values = sql.join(
    rows.map(
      (r) => sql`(${r.envelopeId}::uuid, ${ownerId}::uuid, ${r.asOf}::date, ${r.spent}::numeric,
                  ${versions.ownerVersion}, ${versions.systemVersion}, now())`,
    ),
    sql`, `,
  );
  await tx.execute(sql`
    INSERT INTO envelope_spent_cache
      (envelope_id, owner_id, as_of, spent, owner_version, system_version, updated_at)
    VALUES ${values}
    ON CONFLICT (envelope_id, as_of) DO UPDATE SET
      spent = EXCLUDED.spent, owner_version = EXCLUDED.owner_version,
      system_version = EXCLUDED.system_version, updated_at = now()`);
}

/** Снос ВСЕХ дней перечисленных конвертов: пересчёт ленивый — посчитает первый читатель. */
export async function invalidateSpentCache(
  tx: Tx,
  ownerId: string,
  envelopeIds: readonly string[],
): Promise<void> {
  if (envelopeIds.length === 0) return;
  const ids = sql.join(
    envelopeIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`
    DELETE FROM envelope_spent_cache WHERE owner_id = ${ownerId} AND envelope_id IN (${ids})`);
}

/**
 * Снос ВСЕГО кэша владельца — для операций, которые правят `props` неизвестного заранее
 * множества сущностей: `property_merge` (одним UPDATE в CTE, `registry/ops.ts`), его откат и
 * undo произвольного действия. Перечислить «задетые конверты» там означало бы завести вторую,
 * неполную модель того, что операция сделала; снос владельца стоит одного ленивого пересчёта
 * (сорок конвертов месяца — один SQL).
 */
export async function invalidateSpentCacheOfOwner(tx: Tx, ownerId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM envelope_spent_cache WHERE owner_id = ${ownerId}`);
}

/**
 * Инкремент (§Б5-5, §С8-16): прибавить вклад ОДНОГО нового движения к строкам конверта.
 *
 * `asOf` — день, С КОТОРОГО движение попадает в ведомость (значение его слота `date`), а НЕ
 * «сегодня»: набор `facts` отбирает движения условием `date <= $today`, поэтому строка более
 * раннего дня этого движения не видела и видеть не должна, а все дни `>= asOf` обязаны его
 * получить.
 *
 * Строки нет — UPDATE трогает ноль строк, и это правильный ответ: непрогретый конверт
 * посчитает первый же читатель. Версии здесь не спрашиваются (их нет и в сигнатуре реестра):
 * строка чужой версии всё равно невидима читателю и будет переписана его промахом.
 */
export async function bumpSpentCache(
  tx: Tx,
  ownerId: string,
  envelopeId: string,
  delta: string,
  asOf: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE envelope_spent_cache
       SET spent = spent + ${delta}::numeric, updated_at = now()
     WHERE owner_id = ${ownerId} AND envelope_id = ${envelopeId} AND as_of >= ${asOf}::date`);
}
