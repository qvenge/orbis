import type { AccountId, GraphId } from '@orbis/shared';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { graphMembers, graphs } from '../db/schema';
import type { Tx } from '../db/with-identity';
import type { Identity } from '../identity';

/**
 * Строка `graphs` личного графа. Отдельной функцией с ДВУМЯ брендированными параметрами, а не
 * литералом на месте: колонки drizzle — голый `uuid`, и в `owner_ref` (колонка АККАУНТА) id графа
 * уехал бы молча. Здесь перепутать их компилятор не даёт — это единственная защита, потому что
 * бренды на колонки не навешиваются (Р-КГ-5, YAGNI).
 */
function personalGraphRow(graph: GraphId, owner: AccountId): typeof graphs.$inferInsert {
  return { id: graph, ownerKind: 'person', ownerRef: owner };
}

/** Строка `graph_members`: грант `owner`, выписанный аккаунтом самому себе. Разведение — как выше. */
function ownerMemberRow(graph: GraphId, account: AccountId): typeof graphMembers.$inferInsert {
  return { id: newId(), graphId: graph, accountId: account, grantKind: 'owner', issuedBy: account };
}

/**
 * Личный граф аккаунта: строка `graphs` и грант `owner` самому себе. Идемпотентно: повторный
 * заход ничего не вставляет.
 *
 * Принимает ПАРУ, а не один id (D44): у графа и аккаунта здесь разные колонки — `id`/`graph_id`
 * против `owner_ref`/`account_id`/`issued_by`, — и склеить их значением можно только через
 * резолвер `identityOfPerson`. Тождество `id = owner_ref` приезжает ИЗ НЕГО, а держит его CHECK
 * `graphs_personal_identity`: пара с `graph ≠ actor` (Bearer, тик) отсюда даст `23514`, а не
 * молчаливый «личный граф» с чужим `owner_ref`. Второго места тождества id в коде нет.
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
export async function ensurePersonalGraph(tx: Tx, who: Identity): Promise<void> {
  await tx.insert(graphs).values(personalGraphRow(who.graph, who.actor)).onConflictDoNothing();
  await tx
    .insert(graphMembers)
    .values(ownerMemberRow(who.graph, who.actor))
    .onConflictDoNothing({
      target: [graphMembers.graphId, graphMembers.accountId],
      // сырым текстом: колонка drizzle отрендерилась бы квалифицированным именем, а предикату
      // ON CONFLICT нужен ровно предикат частичного индекса graph_members_active_uniq
      where: sql`revoked_at IS NULL`,
    });
}
