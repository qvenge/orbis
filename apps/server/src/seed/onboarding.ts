// apps/server/src/seed/onboarding.ts
// Онбординг владельца (срез 1б §8.6): вход боевой ручки `user.seedOnboarding` и вход фикстур. Оба —
// тонкие обёртки над заведением графа (`seed/setup-graph.ts`): граф заводится ОДИН раз, при отсутствии
// оболочки хоста, и на каждом следующем входе онбординг не пишет ничего (С1б-5).
//
// Досевов безусловного пути здесь больше нет — сняты поимённо (§8.6): дописывание `orbis-budget` в
// `installedViews`; повторный сев недостающего мира; `backfillHorizons` и `backfillRoutinesList` (строки
// мимо исполнителя); `backfillRoutinesListBody` (прямой UPDATE тела «Рутин» мимо журнала и версий); оба
// `pinIfAbsent`; досев рутины «Перенос остатков»; досев садовника словаря.
import type { Db } from '../db/client';
import type { Identity } from '../identity';
import { type SetupGraphResult, setupGraph } from './setup-graph';

// Формулы seed-слагов живут в `seed/world.ts` — там же, где мир, который они адресуют.
// Реэкспорт сохранён: по этим именам их зовут сьюты.
export { seedCategoryId, seedSmartListId } from './world';

export type SeedResult = SetupGraphResult;

/**
 * Вход боевой ручки: завести граф владельца, если он не заведён, — с садовником и «Переносом остатков».
 * Граф старой формы — `ExecError('GRAPH_NEEDS_MIGRATION')` без записи.
 */
export async function seedOwner(
  db: Db,
  who: Identity,
  clock: () => Date = () => new Date(),
): Promise<SeedResult> {
  return setupGraph(db, who, { clock });
}

/**
 * Вход фикстур: граф заводится ТЕМ ЖЕ путём, что в бою, — с маской выключенных Финансов (РП-36), но
 * без рутин (садовника и «Переноса остатков»): в чужом сьюте они только шумят (перф-обвязка, гейт
 * бюджета, импорт), а числа этих сьютов от них не зависят. Финансовый сьют включает Финансы ЯВНО
 * помощником `enableFinanceForTest` (`apps/server/test/finance-on.ts`) — его слово, а не молчание фикстуры.
 */
export async function seedOwnerGraph(
  db: Db,
  who: Identity,
  clock: () => Date = () => new Date(),
): Promise<SeedResult> {
  return setupGraph(db, who, { routines: false, clock });
}
