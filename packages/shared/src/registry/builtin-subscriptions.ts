// Встроенные подписки (§Б5-1): system-строки `subscription_definitions`. Дом — рядом с
// BUILTIN_ASPECT_DEFS/BUILTIN_CONTRACT_DEFS: у встроенного содержимого реестров один адрес.
// Порядок массива = `rank`.
//
// ДЕКЛАРАЦИИ НЕ ПИШУТСЯ ЗДЕСЬ, а берутся из норматива `subscription-fixtures.ts` (Ф-Б1-27).
// Копия рядом означала бы ДВЕ «канонические» Agenda: форму и валидатор проверяют на нормативе,
// а в базу уезжала бы вторая запись — расхождение увидел бы не тест, а владелец, у которого
// повестка считается не тем окном, которое разбирают сьюты. Для Budget цена ошибки та же, но в
// деньгах: карточка конверта и бейдж §6.1 считались бы по разным порогам.
import { AGENDA_DEF, BUDGET_DEF } from './subscription-fixtures';
import type { BuiltinSubscriptionDef } from './subscription-type';

/** Обзор бюджета §Б5-4 — названа отдельно: на неё ссылаются сьюты сида и наборов контракта,
 *  а поиск по массиву в каждом из них означал бы три места, знающих её id. */
export const BUDGET_OVERVIEW_SUBSCRIPTION: BuiltinSubscriptionDef = {
  id: 'orbis/budget-overview',
  surface: 'finance/budget-overview',
  module: 'finance',
  rank: 20,
  definition: BUDGET_DEF,
};

export const BUILTIN_SUBSCRIPTION_DEFS: readonly BuiltinSubscriptionDef[] = [
  {
    id: 'orbis/agenda',
    surface: 'planner/agenda',
    module: 'planner',
    rank: 10,
    definition: AGENDA_DEF,
  },
  BUDGET_OVERVIEW_SUBSCRIPTION,
];
