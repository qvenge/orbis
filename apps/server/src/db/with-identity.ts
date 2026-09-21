// apps/server/src/db/with-identity.ts
// Транзакционно-локальная identity (findings B7, SPIKE-01 доказан в 3 средах):
// set_config(..., is_local=true) умирает на commit И rollback; SET LOCAL ROLE
// authenticated даёт default-гранты Supabase и рабочий auth.uid() в политиках.
//
// У транзакции ДВА идентификатора (D44): `sub` — аккаунт-актор (кто действует), `graph` —
// текущий граф (в чьих данных идёт транзакция). Оба едут одними claims. С миграции 0021
// политики читают ОБА: `graph` — через `current_graph_id()`, `sub` — через `auth.uid()` внутри
// `actor_*_current_graph()`; предикат строк — «строка текущего графа ∧ актор держит в нём грант».
// Между Г-3 и Г-4 ключ `graph` политиками ещё игнорировался, и промежуточное состояние держалось
// на тождестве id личного графа (спека §8.1) — это прошлое, а не нынешнее поведение.
import { sql } from 'drizzle-orm';
// `isIdentity` — ЗНАЧЕНИЕ, а не тип, и лист этим не нарушен: ИЗМЕРЕНО (финальное ревью ветки) —
// полный граф импортов `identity.ts` это {db/client, db/schema}, то есть ровно то, что здесь уже
// есть через `import type { Identity }`; из значений `identity.ts` импортирует один `sql`, цикла нет.
import { type Identity, isIdentity } from '../identity';
import type { Db } from './client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function withIdentity<T>(
  db: Db,
  who: Identity,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  // РАНТАЙМ-БАРЬЕР — ПЕРВОЙ СТРОКОЙ, до всякой работы с базой. Тип пары закрыт компилятором, но
  // формы с источником `any` (`JSON.parse`, `Object.create`, `as unknown as Identity`,
  // `Object.assign({}, who, …)`), а также ЛЮБАЯ форма внутри `scripts/` — а те не входят ни в один
  // tsconfig и `bun run typecheck` их не видит вовсе — компилятором не отбиваются. Мимо
  // `withIdentity` идентичность в транзакцию не попадает, поэтому проверка тут и стоит: у подделки
  // нет бренда, который ставит конструктор `IdentityBox`, и до `set_config` она не доходит.
  if (!isIdentity(who)) {
    throw new Error(
      'withIdentity: получена не пара из резолверов identity.ts. Пару выдают только ' +
        'identityOfPerson / identityOfGrant / identitiesForScheduler; собранный руками объект ' +
        'той же формы пары не является (D44, спека §3.5).',
    );
  }
  if (!UUID_RE.test(who.actor)) {
    throw new Error(`withIdentity: actor не UUID: ${JSON.stringify(who.actor)}`);
  }
  if (!UUID_RE.test(who.graph)) {
    throw new Error(`withIdentity: graph не UUID: ${JSON.stringify(who.graph)}`);
  }
  return db.transaction(async (tx) => {
    // Текущий граф — ключом ВНУТРИ тех же claims (спека §3.5): один set_config, одно время жизни с
    // `sub` (is_local = true: умирает на commit И на rollback).
    //
    // Регистр — нижний, и ПРИЧИНА НАЗВАНА ПО ЗАМЕРУ. Политикам он безразличен: `current_graph_id()`
    // и `auth.uid()` кастуют значение `::uuid`, а uuid регистронезависим — мутация «снять
    // `.toLowerCase()`» не краснит ни одной RLS-проверки. Нормализация нужна СТРОКОВЫМ ключам,
    // которые из этих id собираются вне базы: замки `hashtextextended('<граф>:registry')`, ключ
    // кеша реестра, сравнения `toBe` в сьютах (подробнее — докблок `parseGraphId`). Здесь она
    // повторена, а не выброшена, потому что вход сюда приходит и из `scripts/`, где типов нет.
    const claims = JSON.stringify({
      sub: who.actor.toLowerCase(),
      role: 'authenticated',
      graph: who.graph.toLowerCase(),
    });
    await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`SET LOCAL ROLE authenticated`);
    return fn(tx);
  });
}
