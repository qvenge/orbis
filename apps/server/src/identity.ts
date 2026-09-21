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
 * ЗАМОК ТИПА (Р-ИГ-12). Пара — НЕ структурный тип, а класс с ПРИВАТНЫМ полем, и сам класс из
 * модуля не экспортируется: наружу уходит только псевдоним-тип `Identity`. Отсюда два следствия.
 *
 * 1. Собрать пару С НУЛЯ снаружи нельзя ни в одной форме — ни однострочным литералом, ни
 *    многострочным, ни `satisfies`, ни своим классом, ни функцией с объявленным возвратом:
 *    приватное поле структурно не воспроизводится (`TS2741`), а конструктор наружу не виден.
 * 2. Нельзя и ПРОИЗВЕСТИ пару из готовой спредом — `{ ...who, graph: other }` даёт обычный
 *    объект, приватного поля у него нет, и он тоже `TS2741`. Именно эта форма и есть вероятная:
 *    `Identity` лежит в `ctx.identity` на каждом прод-пути, и «взять текущую пару и подменить
 *    граф» — первое, что напишет человек, которому понадобился другой граф.
 *
 * ЧЕГО ЗАМОК НЕ ДЕРЖИТ, И ЭТО НАЗВАНО ВСЛУХ. `Object.assign({}, who, { graph: other })`
 * возвращает пересечение типов аргументов, приватное поле в нём сохраняется — компилятор такую
 * подделку пропускает (измерено ре-ревью Г-3). Её ловит греп-маркер `identity-pair`
 * (`scripts/check-legacy-form.ts`, альтернатива на спред и `Object.assign`), и он же остаётся
 * вторым барьером на случай, если тип кто-нибудь ослабит. Абсолютной гарантии нет: барьеров два,
 * и каждый закрывает то, что упускает другой.
 *
 * Прежняя редакция (Р-ИГ-11) держала замок фантомным полем с ключом-символом. Она закрывала
 * сборку с нуля, но НЕ спред: тип результата спреда символьных полей не несёт, а значит и не
 * требует их обратно. Класс это чинит — цена в том, что пара перестала быть простым объектом.
 */
class IdentityBox {
  /**
   * Собственно замок. Приватное поле не воспроизводится снаружи и не переживает спред.
   *
   * `declare` — НЕ УКРАШЕНИЕ, а условие того, чтобы поле было ЧИСТО ТИПОВЫМ, и это измерено.
   * Без него (`private readonly lock!: never`) цель `ES2022` эмитит объявление поля в класс, и
   * замок МАТЕРИАЛИЗУЕТСЯ: `Object.keys(who)` даёт `["actor","graph","lock"]`, `Object.hasOwn`
   * подтверждает ключ. Пара переставала быть двухключевой — тот самый молчаливый дрейф, против
   * которого затеян весь срез (`JSON.stringify` его прятал: значение `undefined` не пишется).
   * С `declare` эмита нет вовсе: `Object.keys(who)` снова `["actor","graph"]`.
   *
   * Второе, что чинит `declare`, — ЛОВУШКА ИНСТРУМЕНТА. У эмитируемого поля biome находил
   * `lint/correctness/noUnusedPrivateClassMembers` (поле «не используется» по построению — в этом
   * весь смысл фантомного замка) и предлагал автоправку, которая его УДАЛЯЕТ: `biome check
   * --write --unsafe` печатал «Fixed 1 file», и защита Р-ИГ-12 исчезала. Удаление при этом ловит
   * `bun run typecheck` (три `TS2578` — директивы `@ts-expect-error` пинов становятся
   * неиспользуемыми), но НЕ ловит ни один тест: bun типы не проверяет, `bun run test` остаётся
   * зелёным. Объявление через `declare` правило не видит вовсе, поэтому ни подавления, ни
   * автоправки больше нет — и подавлять нечего (biome сам отмечает такой `biome-ignore` как
   * не имеющий эффекта).
   */
  private declare readonly lock: never;

  constructor(
    /** Аккаунт, от чьего имени идёт транзакция: `sub` claims, `actor_user_id` журнала. */
    readonly actor: AccountId,
    /** Граф, в котором идёт транзакция: ставит СЕРВЕР, не клиент и не политика. */
    readonly graph: GraphId,
  ) {}
}

/**
 * Пара «актор + текущий граф». Тип — псевдоним закрытого класса: назвать его снаружи можно,
 * построить — нет (класс не экспортируется, поле приватно).
 */
export type Identity = IdentityBox;

/**
 * ЕДИНСТВЕННОЕ место сборки пары, и теперь БЕЗ единого приведения: приватное поле не требует
 * инициализации, а конструктор виден только здесь. Три резолвера ниже зовут этого помощника,
 * и больше его не зовёт никто — он не экспортируется.
 */
function pair(actor: AccountId, graph: GraphId): Identity {
  return new IdentityBox(actor, graph);
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
