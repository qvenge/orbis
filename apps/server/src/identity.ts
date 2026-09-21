// apps/server/src/identity.ts
// Идентичность транзакции: аккаунт-актор и текущий граф (D44, спека §3.5).
//
// Пара рождается РОВНО в трёх резолверах этого файла; любое приведение GraphId ↔ AccountId вне
// него — дефект (греп-гейт — identity.test / шаг 12 задачи Г-3). Файл лежит в корне src, а не в
// db/: резолверы знают про гранты и членство, а db/with-identity.ts обязан оставаться листом —
// его тип Tx импортирует весь сервер (обязательство «изоляция auth от type-графа router»).
import type { AccountId, GraphId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './db/client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ЗАМОК ТИПА (Р-ИГ-11). Символ объявлен в этом модуле и НЕ экспортируется, поэтому назвать
 * поле с таким ключом снаружи нельзя вовсе — и объектный литерал `{ actor, graph }`, где бы он
 * ни стоял, перестаёт быть `Identity`. Это и делает утверждение спеки §3.5 «пара рождается
 * ровно в трёх резолверах» механизмом, а не соглашением.
 *
 * Почему одних брендов полей мало: `{ actor: a, graph: g }` с ВЕРНЫМИ `AccountId`/`GraphId` —
 * не приведение, компилятор его пропускал, а греп-гейт `identity-pair` построчен и на
 * многострочной записи слеп (Ф-Г-50; biome её не схлопывает — измерено ре-ревью). Гейт остаётся
 * ВТОРЫМ барьером: он краснеет раньше компилятора и переживёт попытку ослабить тип.
 */
declare const identityBrand: unique symbol;

export interface Identity {
  /** Аккаунт, от чьего имени идёт транзакция: `sub` claims, `actor_user_id` журнала. */
  readonly actor: AccountId;
  /** Граф, в котором идёт транзакция: ставит СЕРВЕР, не клиент и не политика. */
  readonly graph: GraphId;
  /** Замок: поле фантомное, в рантайме его нет — см. докблок `identityBrand`. */
  readonly [identityBrand]: true;
}

/**
 * ЕДИНСТВЕННОЕ место сборки пары. Приведение здесь — не поблажка себе, а сам замок: снаружи
 * поле-бренд не назвать, значит другого пути к `Identity` нет ни у кого. Три резолвера ниже
 * зовут этого помощника, и больше его не зовёт никто — он не экспортируется.
 */
function pair(actor: AccountId, graph: GraphId): Identity {
  return { actor, graph } as Identity;
}

/** Граница внешнего мира (JWT `sub`, строка БД, аргумент CLI) → аккаунт. Регистр — нижний, как у `sub`. */
export function parseAccountId(raw: string): AccountId {
  if (!UUID_RE.test(raw)) throw new Error(`parseAccountId: не UUID: ${JSON.stringify(raw)}`);
  return raw.toLowerCase() as AccountId;
}

/** Граница внешнего мира → граф. Тот же регистр, что у аккаунта: иначе GUC графа и `auth.uid()` разойдутся. */
export function parseGraphId(raw: string): GraphId {
  if (!UUID_RE.test(raw)) throw new Error(`parseGraphId: не UUID: ${JSON.stringify(raw)}`);
  return raw.toLowerCase() as GraphId;
}

/**
 * Личный граф аккаунта. ЕДИНСТВЕННОЕ место в коде, где живёт тождество id: его держит CHECK
 * `graphs_personal_identity` (id = owner_ref), а «один личный граф на аккаунт» следует из PK.
 */
function personalGraphOf(account: AccountId): GraphId {
  return account as string as GraphId;
}

/** Резолвер 1 — JWT человека: актор — `sub`, граф — его личный граф. */
export function identityOfPerson(sub: AccountId): Identity {
  return pair(sub, personalGraphOf(sub));
}

/** Резолвер 2 — Bearer агента: актор — аккаунт, выдавший грант (`issued_by`), граф — `graph_id` гранта. */
export function identityOfGrant(grant: { accountId: AccountId; graphId: GraphId }): Identity {
  return pair(grant.accountId, grant.graphId);
}

/**
 * Резолвер 3 — тик планировщика: пары «граф, держатель гранта owner».
 *
 * Идёт под `orbis_app` БЕЗ идентичности (0013). Список графов — по-прежнему `user_settings`
 * («онбординг пройден»; политика `scheduler_reads_owner_list`), актор — из `graph_members`
 * (политика `scheduler_reads_members`, 0020). В v1 владелец у графа один; при нескольких берётся
 * самый ранний грант — кто актор рутины в графе с несколькими владельцами, решает ступень 2.
 * Порядок по графу фиксирован намеренно: два сосуществующих деплоя Render обходят одинаково.
 */
export async function identitiesForScheduler(db: Db): Promise<Identity[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (us.graph_id) us.graph_id::text AS graph, gm.account_id::text AS actor
    FROM user_settings us
    JOIN graph_members gm
      ON gm.graph_id = us.graph_id AND gm.grant_kind = 'owner' AND gm.revoked_at IS NULL
    ORDER BY us.graph_id, gm.issued_at, gm.id`);
  return rows.map((r) => pair(parseAccountId(String(r.actor)), parseGraphId(String(r.graph))));
}
