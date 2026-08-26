// apps/server/src/routers/aspect.ts
// Роутер aspect (§9.1): реестр аспектов, видимых актору — встроенные (owner_id IS NULL) +
// свои кастомные. RLS сама скоупит SELECT под withIdentity (§4.10, политика
// read_builtin_or_own). Сортировка по id. Только трансляция.
//
// Строки едут в НОВОЙ форме (§А3-1): `label`/`description` per-locale, `properties` —
// ссылки на реестр свойств. Колонка `schema` в выдаче остаётся (Р-24): по ней web строит
// каталог полей query-грамматики, и до миграции 0017 другого источника формы значений нет.
// Реестр СВОЙСТВ отдельным роутером не отдаётся — он приезжает вместе с экраном реестра
// (Задача 12), а сегодняшним потребителям (каталог полей, список аспектов) хватает этого.
import { asc } from 'drizzle-orm';
import { aspectDefinitions } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { protectedProcedure, router } from '../trpc';
import { toWireAspectDefinition, type WireAspectDefinition } from '../wire';

export const aspectRouter = router({
  list: protectedProcedure.query(
    ({ ctx }): Promise<WireAspectDefinition[]> =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const rows = await tx.select().from(aspectDefinitions).orderBy(asc(aspectDefinitions.id));
        return rows.map(toWireAspectDefinition);
      }),
  ),
});
