// apps/server/src/routers/aspect.ts
// Роутер aspect (§9.1): реестр аспектов, видимых актору — встроенные (owner_id IS NULL) +
// свои кастомные. RLS сама скоупит SELECT под withIdentity (§4.10, политика
// read_builtin_or_own). Сортировка по id. Только трансляция.
//
// Строки едут в НОВОЙ форме (§А3-1): `label`/`description` per-locale, `properties` —
// ссылки на реестр свойств. Колонка `schema` в выдаче остаётся (Р-24): её читает экран
// настроек (`AspectsList`), которому нужна старая форма значений, — до миграции 0017
// другого источника у него нет.
//
// Единственный читатель этой ручки — тот самый экран настроек. Всё остальное (каталог полей
// query-грамматики, разбор имён Q-AST, подписи полей и аспектов) ушло в `registry.effective`
// (§А9-2, Задача 13a): там три словаря приезжают одним ответом и с версией снимка, а здесь
// нет ни версии, ни свойств с ролями.
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
