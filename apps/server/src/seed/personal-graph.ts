import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { graphMembers, graphs } from '../db/schema';
import type { Tx } from '../db/with-identity';

/**
 * Личный граф аккаунта: строка `graphs` (id = id аккаунта — тождество держит CHECK таблицы) и
 * грант `owner` самому себе. Идемпотентно: повторный заход ничего не вставляет.
 *
 * Идёт под ролью `authenticated` с `sub` = аккаунт: INSERT-политики 0020 пускают ровно эту
 * пару строк — личный граф самого себя. БЕЗ `RETURNING`: пока нет строки членства, только что
 * вставленный граф SELECT-политику не проходит (спека §3.6). Обе вставки — в ОДНОЙ транзакции:
 * отложенный триггер И-1 (`graphs_require_owner`) проверяет грант на коммите.
 *
 * У `graphs` — `ON CONFLICT DO NOTHING` БЕЗ указания арбитра, и это вынужденно, а не небрежно.
 * Указанный арбитр (`ON CONFLICT (id)`) требует права SELECT на целевую таблицу, а при требуемом
 * SELECT её SELECT-политики навешиваются на НОВУЮ строку как WITH CHECK самого INSERT — тот же
 * путь, которым падает `RETURNING`. Только что вставленный граф эту проверку не проходит (строки
 * членства ещё нет), и вставка отказывает `42501` ДО всякого конфликта. Проверено на живой базе
 * (psql, 21.09; контроль — `RETURNING id` даёт тот же `42501`). Смысл не меняется: уникальность у
 * `graphs` ровно одна — PK `id`, и «уже есть такой граф» — единственный возможный конфликт.
 * У `graph_members` арбитр указан: её SELECT-политика (`account_id = auth.uid()`) свою же строку
 * пропускает, а без арбитра частичный индекс не выбрался бы.
 */
export async function ensurePersonalGraph(tx: Tx, accountId: string): Promise<void> {
  await tx
    .insert(graphs)
    .values({ id: accountId, ownerKind: 'person', ownerRef: accountId })
    .onConflictDoNothing();
  await tx
    .insert(graphMembers)
    .values({
      id: newId(),
      graphId: accountId,
      accountId,
      grantKind: 'owner',
      issuedBy: accountId,
    })
    .onConflictDoNothing({
      target: [graphMembers.graphId, graphMembers.accountId],
      // сырым текстом: колонка drizzle отрендерилась бы квалифицированным именем, а предикату
      // ON CONFLICT нужен ровно предикат частичного индекса graph_members_active_uniq
      where: sql`revoked_at IS NULL`,
    });
}
