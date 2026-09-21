// apps/server/src/identity.ts
// Идентичность транзакции: аккаунт-актор и текущий граф (D44, спека §3.5).
//
// Пара рождается РОВНО в трёх резолверах этого файла; любое приведение GraphId ↔ AccountId вне
// него — дефект. Держит это СТОЯЧИЙ греп-маркер `brand-cast` (`scripts/check-legacy-form.ts`,
// прогон `bun run check:legacy-form --gate`) — не разовая команда шага задачи: прежняя редакция
// ссылалась на «греп-гейт в identity.test», которого никогда не было, и формы
// `who.actor as string as GraphId` / `parseGraphId(who.actor)` проходили и компилятор, и CI
// (измерено финальным ревью ветки). Allowlist маркера — только этот файл и сьют замка.
//
// Файл лежит в корне src, а не в db/: резолверы знают про гранты и членство, а db/with-identity.ts
// обязан оставаться листом — его тип Tx импортирует весь сервер (обязательство «изоляция auth от
// type-графа router»). Обратная зависимость `with-identity.ts → isIdentity` этого не нарушает и
// это ИЗМЕРЕНО, а не выведено: полный граф импортов `identity.ts` — {db/client, db/schema}, то
// есть строгое подмножество того, что у `with-identity.ts` уже есть через `import type { Identity }`;
// рантайм-граф `identity.ts` — один файл (из значений он импортирует только `sql` drizzle), цикла
// нет. Поэтому отдельный лист-модуль под бренд не заводился.
import type { AccountId, GraphId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './db/client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * РАНТАЙМ-БРЕНД пары. Неперечислимое поле с ключом-СИМВОЛОМ, которое ставит только конструктор.
 *
 * Почему именно неперечислимый символ — по перечню того, что подделку НЕ унесёт:
 *   • `Object.keys` / `JSON.stringify` / форма экспорта его не видят (ключ-символ + enumerable:false),
 *     поэтому пара осталась ДВУХКЛЮЧЕВОЙ — ровно то, что чинил `declare` у замка типа ниже;
 *   • `Object.assign` и спред копируют только ПЕРЕЧИСЛИМЫЕ собственные поля — бренд не уедет;
 *   • `structuredClone` символьные ключи теряет — клон брендом не будет;
 *   • `JSON.parse` символов не производит вовсе.
 * Значит, ни одна из форм «собрал объект той же формы и назвал его парой» рантайм-проверку
 * `isIdentity` не проходит.
 */
const IDENTITY_BRAND: unique symbol = Symbol('orbis.identity');

/**
 * ЗАМОК ПАРЫ — ТРИ БАРЬЕРА, и у каждого названо, что он держит и чего НЕ держит.
 *
 * БАРЬЕР 1 — ТИП (Р-ИГ-12). Пара — НЕ структурный тип, а класс с ПРИВАТНЫМ полем, и сам класс из
 * модуля не экспортируется: наружу уходит только псевдоним-тип `Identity`. Отсюда два следствия.
 *
 * 1. Собрать пару с нуля НИ ОДНОЙ ТИПИЗИРОВАННОЙ формой нельзя — ни однострочным литералом, ни
 *    многострочным, ни `satisfies`, ни своим классом, ни функцией с объявленным возвратом:
 *    приватное поле структурно не воспроизводится (`TS2741`), а конструктор наружу не виден.
 * 2. Нельзя и ПРОИЗВЕСТИ пару из готовой спредом — `{ ...who, graph: other }` даёт обычный
 *    объект, приватного поля у него нет, и он тоже `TS2741`. Именно эта форма и есть вероятная:
 *    `Identity` лежит в `ctx.identity` на каждом прод-пути, и «взять текущую пару и подменить
 *    граф» — первое, что напишет человек, которому понадобился другой граф.
 *
 * Слово ТИПИЗИРОВАННОЙ здесь несущее, и прежняя редакция его не говорила («нельзя ни в одной
 * форме» было обещанием сверх измеренного). Компилятор ПРОПУСКАЕТ всё, у чего источник — `any`
 * или приведение: `JSON.parse(...)`, `Object.create(null, {...})`, `new (Object.getPrototypeOf(who)
 * .constructor)(a, g)`, `Reflect.construct(...)`, `new Proxy(who, {...})`, `{...} as unknown as
 * Identity`, а также `Object.assign({}, who, {...})` (тип результата — пересечение аргументов,
 * приватное поле в нём сохраняется). Всё это измерено матрицей из 22 форм финального ревью ветки.
 *
 * БАРЬЕР 2 — ГРЕП-МАРКЕР `identity-pair` (`scripts/check-legacy-form.ts`): литерал пары, спред и
 * `Object.assign` в одной строке. Он краснеет раньше компилятора и переживёт попытку ослабить тип.
 * ЧЕГО НЕ ДЕРЖИТ: `git grep` построчен — многострочный литерал и `Object.assign`, перенесённый
 * форматтером на несколько строк, мимо него проходят.
 *
 * БАРЬЕР 3 — РАНТАЙМ (заведён финальным ревью ветки, Important-1). Конструктор ставит
 * неперечислимый бренд-символ и ЗАМОРАЖИВАЕТ экземпляр, а `withIdentity` первой строкой зовёт
 * `isIdentity`. Отсюда:
 *   • подделка любой формы (включая те, что тип пропустил) до базы не доходит — бренда у неё нет;
 *   • ЖИВУЮ пару больше не подменить на месте: `Object.assign(who, patch)` и
 *     `Object.defineProperty(who, 'graph', …)` в ESM (строгий режим) бросают `TypeError`.
 * ЧЕГО НЕ ДЕРЖИТ И ЭТО НАЗВАНО ВСЛУХ: `new (Object.getPrototypeOf(who).constructor)(a, g)` и
 * `Reflect.construct(...)` дают НАСТОЯЩИЙ экземпляр — с брендом и с любыми значениями. Против
 * такого барьера нет ни у кого; его цена — строка, которую нельзя написать не понимая, что делаешь.
 *
 * Прежняя редакция (Р-ИГ-11) держала замок фантомным полем с ключом-символом ЧИСТО ТИПОВО. Она
 * закрывала сборку с нуля, но НЕ спред: тип результата спреда символьных полей не несёт, а значит
 * и не требует их обратно. Класс это чинит — цена в том, что пара перестала быть простым объектом.
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
  ) {
    // Оба поля-параметра уже присвоены: их присваивание эмитится в НАЧАЛО тела конструктора,
    // до этой строки (проверено на прогоне — `who.actor`/`who.graph` читаются после заморозки).
    Object.defineProperty(this, IDENTITY_BRAND, { value: true, enumerable: false });
    // ЗАМОРОЗКА — против подмены пары НА МЕСТЕ. `readonly` живёт только в типах: до неё
    // `Object.assign(who, patch)` и `Object.defineProperty(who, 'graph', …)` молча меняли граф
    // у `ctx.identity` прод-пути и не краснели нигде (измерено финальным ревью ветки). Теперь
    // обе формы дают `TypeError` — модули ESM исполняются в строгом режиме.
    Object.freeze(this);
  }
}

/**
 * Пара «актор + текущий граф». Тип — псевдоним закрытого класса: назвать его снаружи можно,
 * построить — нет (класс не экспортируется, поле приватно).
 */
export type Identity = IdentityBox;

/**
 * РАНТАЙМ-СТРАЖ пары: «это сделал конструктор этого модуля, а не кто-то похожей формы».
 *
 * Зовётся первой строкой `withIdentity` — до всякой работы с базой, потому что мимо `withIdentity`
 * идентичность в транзакцию не попадает вовсе (один `set_config` на весь сервер). Проверка — по
 * бренду, а не по `instanceof`: `instanceof` ломается о второй экземпляр модуля (два деплоя, hmr,
 * пересборка), а бренд — собственное поле объекта.
 *
 * Предикат намеренно принимает `unknown`: его смысл в том, чтобы сработать ИМЕННО там, где тип
 * уже обманут — приведением, `any` из `JSON.parse`, или в `scripts/`, которые не входят ни в один
 * tsconfig и компилятором не проверяются вовсе.
 */
export function isIdentity(x: unknown): x is Identity {
  if (typeof x !== 'object' || x === null) return false;
  return (x as Record<symbol, unknown>)[IDENTITY_BRAND] === true;
}

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

/**
 * Граница внешнего мира → граф. Регистр — нижний, тот же, что у аккаунта.
 *
 * ПРИЧИНА НАЗВАНА ПО ЗАМЕРУ. Политикам регистр безразличен: и `current_graph_id()`, и `auth.uid()`
 * кастуют значение `::uuid` (0021:32, `scripts/setup-db.ts:18-21`), а uuid регистронезависим —
 * мутация «снять `.toLowerCase()`» не краснит ни одной RLS-проверки, и не должна. Нормализация
 * нужна СТРОКОВЫМ ключам, которые из этого id собираются: замки `hashtextextended('<граф>:registry')`
 * (`registry/ops.ts`, `budget/binding.ts`, `executor/relations.ts`), ключ кеша реестра
 * (`registry/cache.ts`) и сравнения `toBe` в сьютах. Там `A` и `a` — два разных ключа.
 */
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
