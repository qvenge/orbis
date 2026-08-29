// apps/server/src/routers/registry.ts
// Роутер registry (§А9-2): ЭФФЕКТИВНЫЙ реестр владельца одним ответом — свойства, аспекты и
// роли рёбер плюс версия снимка. Это тот самый «реестровый ответ, кешируемый по
// registry_version», которым §А9-2 велит строить форму и подписи в web: подписи полей,
// подписи аспектов, каталог полей конструктора запросов и разбор имён Q-AST — всё из него.
//
// Что он заменил: `aspect.properties` (Задача 10c) отдавал два словаря из трёх и БЕЗ версии,
// то есть кеш было нечем инвалидировать, а аспекты приходилось брать из `aspect.list` вторым
// запросом — и клиент жил в состоянии «свойства уже приехали, аспекты ещё нет», в котором
// разбор врёт `UNKNOWN_ASPECT`. Здесь три словаря приезжают ОДНИМ ответом и одной версией:
// полснимка не бывает по построению. `aspect.list` со своей колонкой `schema` старой формы
// (Р-24) прожил после этого ещё один срез мёртвым — экран настроек (`AspectsList`) переехал
// сюда той же Задачей 13a — и снят гейт-ревью Задачи 14.
import type { AspectDefinition, PropertyDefinition, RelationRoleDefinition } from '@orbis/shared';
import { withIdentity } from '../db/with-identity';
import { effectiveRegistry } from '../registry/cache';
import { protectedProcedure, router } from '../trpc';
import { registryVersionOf } from '../wire';

/**
 * Эффективный реестр владельца: система ⊕ его собственные строки ⊕ его дельты (§А3-2).
 * Складывает их `registry/cache.ts` — роутер про дельты не знает и знать не должен: форма
 * ответа одна и та же, меняется только содержимое строк.
 *
 * `label`/`description` едут ПОЛНЫМИ per-locale картами, а не одной строкой: локаль выбирает
 * читатель (`effectiveLabel`), и свёртка на сервере означала бы новый запрос на каждую смену
 * языка — при том что вся разница между локалями уже лежит в той же строке jsonb.
 *
 * Форма ОБЩАЯ для встроенных и пользовательских строк — это `PropertyDefinition` реестра, а
 * не «встроенные + добавки»: пользовательское свойство приходит сюда ровно тем же полем
 * массива, что и `orbis/task_status`, и дельта меняет содержимое строк, а не форму ответа.
 */
export interface WireRegistry {
  /** `<системная>.<владельца>` — ключ кеша и единственный повод перечитать (§А10-1). */
  version: string;
  properties: PropertyDefinition[];
  aspects: AspectDefinition[];
  roles: RelationRoleDefinition[];
}

/**
 * Порядок выдачи — нормативный `rank` реестра (§А2-2/§А3-1/§А4-2), при равенстве — id.
 * Порядок наблюдаем: по нему конструктор запросов рисует строки полей и наполняет список
 * выбора сортировки, а карточки аспектов — порядок секций; «как легло в Map» здесь означало
 * бы «как вернул SELECT».
 */
function byRank<T extends { id: string; rank: number }>(rows: ReadonlyMap<string, T>): T[] {
  return [...rows.values()].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

export const registryRouter = router({
  effective: protectedProcedure.query(
    ({ ctx }): Promise<WireRegistry> =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const reg = await effectiveRegistry(tx, ctx.actorUserId);
        return {
          version: registryVersionOf(reg),
          properties: byRank(reg.properties),
          aspects: byRank(reg.aspects),
          roles: byRank(reg.roles),
        };
      }),
  ),
});
