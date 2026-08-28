// apps/server/src/routers/aspect.ts
// Роутер aspect (§9.1): реестр аспектов, видимых актору — встроенные (owner_id IS NULL) +
// свои кастомные. RLS сама скоупит SELECT под withIdentity (§4.10, политика
// read_builtin_or_own). Сортировка по id. Только трансляция.
//
// Строки едут в НОВОЙ форме (§А3-1): `label`/`description` per-locale, `properties` —
// ссылки на реестр свойств. Колонка `schema` в выдаче остаётся (Р-24): её читают экраны,
// которым нужна старая форма значений, — до миграции 0017 другого источника у них нет.
// Каталог полей query-грамматики строится уже НЕ по ней, а по `aspect.properties` ниже.
import type { PropertyDefinition, RelationRoleDefinition } from '@orbis/shared';
import { asc } from 'drizzle-orm';
import { aspectDefinitions } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { loadRegistry } from '../registry/load';
import { protectedProcedure, router } from '../trpc';
import { toWireAspectDefinition, type WireAspectDefinition } from '../wire';

/** Реестры, которыми web резолвит имена Q-AST (§А5-3а): свойства и роли рёбер. */
export interface WireQueryRegistry {
  properties: PropertyDefinition[];
  roles: RelationRoleDefinition[];
}

/**
 * Порядок выдачи — нормативный `rank` реестра (§А2-2/§А4-2), при равенстве — id.
 * Порядок наблюдаем: по нему конструктор запросов рисует строки полей и наполняет
 * список выбора сортировки, и «как легло в Map» здесь означало бы «как вернул SELECT».
 */
function byRank<T extends { id: string; rank: number }>(rows: ReadonlyMap<string, T>): T[] {
  return [...rows.values()].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

export const aspectRouter = router({
  list: protectedProcedure.query(
    ({ ctx }): Promise<WireAspectDefinition[]> =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const rows = await tx.select().from(aspectDefinitions).orderBy(asc(aspectDefinitions.id));
        return rows.map(toWireAspectDefinition);
      }),
  ),

  /**
   * Реестры СВОЙСТВ и РОЛЕЙ владельца — источник каталога полей и разбора имён в web
   * (§А5-3а: имя свойства адресуется namespaced key, роль ребра — своим key).
   *
   * Почему не колонка `aspect_definitions.schema`, по которой каталог строился раньше: тип
   * поля выводился там эвристикой по тексту JSON-паттерна, и один символ в чужой схеме молча
   * менял тип (докблок `fieldTypeOfProperty`, `query/catalog.ts`). Здесь тип приходит
   * `PropertyType`'ом реестра — угадывать нечего.
   *
   * Почему ОДНА ручка на два реестра, а не две: у них один потребитель и одна причина
   * измениться — оба словаря нужны разбору ЦЕЛИКОМ и одновременно (роль резолвится в
   * `via=`, свойство — в имени поля), и раздельные запросы дали бы клиенту состояние
   * «свойства уже приехали, роли ещё нет», в котором разбор врёт `UNKNOWN_ROLE`.
   *
   * Живёт в роутере `aspect`, хотя аспектов не отдаёт: своего роутера реестру заводить
   * незачем — `registry.effective` (Задача 13a) приедет вместе с ВЕРСИЕЙ снимка и заменит
   * этот вызов целиком, а до него лишний роутер пришлось бы сносить отдельно.
   */
  properties: protectedProcedure.query(
    ({ ctx }): Promise<WireQueryRegistry> =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const reg = await loadRegistry(tx, ctx.actorUserId);
        return { properties: byRank(reg.properties), roles: byRank(reg.roles) };
      }),
  ),
});
