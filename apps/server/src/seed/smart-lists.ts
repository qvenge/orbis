// apps/server/src/seed/smart-lists.ts
/**
 * Реэкспорт тел шести списков из `@orbis/shared/supply` (и тела Upcoming — эталона 1б снятого с поставки
 * ключа, срез 1в §6.3).
 *
 * Дом тел — shared (задача 11 среза 1б): с 1б они эталоны записей поставки, и их читают и сервер
 * (сев, механизм поставки), и web (сравнение «Обновлений», признак «как в поставке»). Реэкспорт держит
 * импорты тестов сервера и шести web-тестов (`@orbis/server/src/seed/smart-lists`): переписывать их ради
 * смены адреса незачем, а второй литерал тел рядом разъехался бы с эталоном при первой правке.
 */
export {
  AGENDA_BODY,
  ALL_TASKS_BODY,
  DAILY_PLANNING_BODY,
  HORIZON_LIFE_BODY,
  HORIZON_YEAR_BODY,
  ROUTINES_BATCH_QUERY,
  ROUTINES_LIST_BODY,
  SEED_HORIZON_LISTS,
  SEED_ROUTINES_LIST,
  SEED_SMART_LISTS,
  type SeedSmartList,
  UPCOMING_BODY,
} from '@orbis/shared/supply';
