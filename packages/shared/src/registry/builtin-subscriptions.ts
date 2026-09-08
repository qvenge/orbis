// Встроенные подписки (§Б5-1): system-строки `subscription_definitions`. Дом — рядом с
// BUILTIN_ASPECT_DEFS/BUILTIN_CONTRACT_DEFS: у встроенного содержимого реестров один адрес.
// Задача 9 дописывает 'orbis/budget-overview'; порядок массива = `rank`.
import type { BuiltinSubscriptionDef } from './subscription-type';

export const BUILTIN_SUBSCRIPTION_DEFS: readonly BuiltinSubscriptionDef[] = [
  {
    id: 'orbis/agenda',
    surface: 'planner/agenda',
    module: 'planner',
    rank: 10,
    definition: {
      engine: 'agenda',
      // Горизонт — параметр вызова, а не константа декларации: «сегодня→+7» задаёт вкладка
      // (AGENDA_DAYS), обе границы подставляет движок (Р-К-4).
      params: ['window_from', 'window_to'],
      show: {
        contract: 'orbis/when',
        slot: 'moment',
        window: { from: { param: 'window_from' }, to: { param: 'window_to' } },
        prefer: [],
        sortBy: 'asc',
        limit: 200,
      },
      overdue: {
        // Два слота и минимум из них — ровно то, что сегодня склеивает клиент
        // (`useAgenda.ts:207-218`), и то, ради чего §А5-5 сводит три запроса в один.
        contract: 'orbis/when',
        slots: ['deadline', 'moment'],
        before: { ctx: '$today' },
        // `where`, а не `hide_when … in closed` (ревизия 3): у сущности без класса сравнение
        // с отсутствующим — false (§Б3-4), и чистое событие попадало бы в просроченное.
        where: { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: 'open' }] },
        prefer: [],
        limit: 200,
      },
      hide: { contract: 'orbis/recurrence', set: 'templates' },
    },
  },
];
