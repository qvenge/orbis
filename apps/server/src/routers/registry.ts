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
import { z } from 'zod';
import { withIdentity } from '../db/with-identity';
import { execErrorToTRPC } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { effectiveRegistry } from '../registry/cache';
import { dependantsOf, dependencyGraph } from '../registry/deps-graph';
import { reportMergeConflictUnit } from '../registry/merge-conflict';
import { collectPropertyHolders } from '../registry/ops';
import {
  aspectDeltaRemoveInput,
  aspectDeltaSetInput,
  propertyCreateInput,
  propertyMergeInput,
  propertyUpdateInput,
} from '../tools/registry-tools';
import { ownerOnlyProcedure, protectedProcedure, router } from '../trpc';
import { registryVersionOf } from '../wire';

// Боевой синк — один инстанс на модуль (без состояния, пишет тем же tx, §7.8)
const sink = makeChatJournalSink();

/**
 * Мутации реестра — ЗЕРКАЛА ТУЛОВ, а не вторая реализация (§А9-2, §А10-2).
 *
 * Ручка не знает ни правил §А2-4, ни капа `proposed`, ни порядка замков: она транслирует
 * вход в ту же операцию исполнителя, которую зовёт тул. Схема входа — та же самая
 * (`tools/registry-tools.ts`), а не «похожая»: разъехавшись, они дали бы владельцу и
 * модели разные правила на одну операцию — ровно то, ради недопущения чего реформа и
 * переносит устройство системы в данные.
 *
 * `source: 'ui'` — прямое действие владельца, как у остальных ручек-мутаций.
 */
function registryMutation(tool: string) {
  return async (
    ctx: { db: Parameters<typeof execute>[0]; actorUserId: string },
    input: unknown,
  ) => {
    const r = await execute(
      ctx.db,
      {
        actorUserId: ctx.actorUserId,
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool, input }],
      },
      { sink },
    );
    if (!r.ok) {
      // Та же половина, что у тула: конфликт слияния кладёт карточку разбора отдельной
      // транзакцией — слияние к этому моменту откачено целиком (§А10-2).
      await reportMergeConflictUnit(ctx.db, ctx.actorUserId, r.error);
      throw execErrorToTRPC(r.error);
    }
    return r.results[0];
  };
}

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
  /**
   * ЧЕСТНЫЕ ЗАВИСИМОСТИ свойства (§А3-5, §С1-3 п.10): «кто на нём стоит» — аспекты, чьи
   * определения его объявляют, свойства, чей `scope`/`ref.target` его называют, и
   * сохранённые запросы владельца, где он упомянут.
   *
   * Половина ответа — ЕГО данные (запросы в телах и источники прогресса целей), и рукописным
   * списком в коде она быть не может по построению. Экран, который это рисует, — срез Б-3;
   * ручка заведена сейчас, потому что тем же обходом пользуется слияние (§А10-2), и второй
   * обход разошёлся бы с первым молча.
   */
  dependants: protectedProcedure.input(z.object({ property: z.string().min(1) }).strict()).query(
    ({ ctx, input }): Promise<{ property: string; dependants: string[] }> =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const reg = await effectiveRegistry(tx, ctx.actorUserId);
        // В `queryRefs` едут ТОЛЬКО держатели-СУЩНОСТИ (источник прогресса и тело). Строки
        // реестра и дельты граф выводит из СНИМКА сам — рёбрами `scope`/`ref.target`/`aspect`
        // (дельта уже сложена в эффективное определение). Передай их сюда — и одна и та же
        // зависимость пришла бы дважды, вторым родом ребра и от узла-строки реестра.
        const holders = (await collectPropertyHolders(tx, ctx.actorUserId)).filter(
          (h) => h.kind === 'progress_source' || h.kind === 'body',
        );
        const graph = dependencyGraph(reg, {
          queryRefs: new Map(holders.map((h) => [h.id, h.properties])),
        });
        // Адрес резолвится тем же правилом, что на границе тулов: владелец спрашивает тем
        // именем, которым видел, — ключом в тексте запроса или id в дереве.
        const property =
          [...reg.properties.values()].find((d) => d.key === input.property)?.id ?? input.property;
        return { property, dependants: dependantsOf(graph, property) };
      }),
  ),

  createProperty: ownerOnlyProcedure
    .input(propertyCreateInput)
    .mutation(({ ctx, input }) => registryMutation('property_create')(ctx, input)),

  updateProperty: ownerOnlyProcedure
    .input(propertyUpdateInput)
    .mutation(({ ctx, input }) => registryMutation('property_update')(ctx, input)),

  mergeProperty: ownerOnlyProcedure
    .input(propertyMergeInput)
    .mutation(({ ctx, input }) => registryMutation('property_merge')(ctx, input)),

  setAspectDelta: ownerOnlyProcedure
    .input(aspectDeltaSetInput)
    .mutation(({ ctx, input }) => registryMutation('aspect_delta_set')(ctx, input)),

  removeAspectDelta: ownerOnlyProcedure
    .input(aspectDeltaRemoveInput)
    .mutation(({ ctx, input }) => registryMutation('aspect_delta_remove')(ctx, input)),

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
