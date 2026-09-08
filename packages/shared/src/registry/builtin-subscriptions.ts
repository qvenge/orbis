// Встроенные подписки (§Б5-1): system-строки `subscription_definitions`. Дом — рядом с
// BUILTIN_ASPECT_DEFS/BUILTIN_CONTRACT_DEFS: у встроенного содержимого реестров один адрес.
// Задача 9 дописывает 'orbis/budget-overview'; порядок массива = `rank`.
//
// ДЕКЛАРАЦИЯ НЕ ПИШЕТСЯ ЗДЕСЬ, а берётся из норматива `subscription-fixtures.ts` (Ф-Б1-27).
// Копия рядом означала бы ДВЕ «канонические» Agenda: форму и валидатор проверяют на нормативе,
// а в базу уезжала бы вторая запись — расхождение увидел бы не тест, а владелец, у которого
// повестка считается не тем окном, которое разбирают сьюты.
import { AGENDA_DEF } from './subscription-fixtures';
import type { BuiltinSubscriptionDef } from './subscription-type';

export const BUILTIN_SUBSCRIPTION_DEFS: readonly BuiltinSubscriptionDef[] = [
  {
    id: 'orbis/agenda',
    surface: 'planner/agenda',
    module: 'planner',
    rank: 10,
    definition: AGENDA_DEF,
  },
];
