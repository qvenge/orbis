/**
 * Намеренные отличия экрана записи среза 1б от эталона 1а — функциями над эталоном, а не правкой
 * файлов `golden/*.json` (РП-24: эталон снят со старого экрана и не перезаписывается никогда).
 *
 * `INTENDED_1A` (структура) — отличия 1а §8.2; здесь — то, что добавляет 1б. Каждое отличие —
 * поимённая функция, видимая ревью; вход не мутируется.
 */

import { INTENDED_1A } from './intended-1a';
import type { DetailStructure } from './structure-snapshot';

/**
 * 1б §6.4, РП-24: меню «⋯» — одно на экран и живёт в присутствии хоста (рамка), а не в шапке экрана
 * записи: ориентира `detail-menu` над вкладками больше нет. Пункты те же — они приходят в меню рамки
 * контекстом экрана (`ScreenMenuProvider`).
 */
export function menuInHostPresence(golden: DetailStructure): DetailStructure {
  return { ...golden, aboveTabs: golden.aboveTabs.filter((p) => p !== 'detail-menu') };
}

/** Снимок, который ОБЯЗАН дать экран записи 1б на фикстуре эталона: отличия 1а и переезд «⋯». */
export function INTENDED_1B(golden: DetailStructure): DetailStructure {
  return menuInHostPresence(INTENDED_1A(golden));
}

/** Ключи по алфавиту — форма счёта запросов `captureDetail`. */
const sorted = (counts: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));

const plusQueries = (golden: Record<string, number>, n: number): Record<string, number> =>
  sorted({ ...golden, 'entity.query': (golden['entity.query'] ?? 0) + n });

/**
 * 1а РП-11 (2), РП-14: ровно один запрос списка шаблонов владельца (`usePageTemplates`) — выбор
 * шаблона на каждом открытии записи.
 */
export function withTemplatesList(golden: Record<string, number>): Record<string, number> {
  return plusQueries(golden, 1);
}

/**
 * 1б §9.2, С1б-16: ровно один запрос записей поставки (`useSupplyRecords`, `aspect=orbis/supply`) —
 * запись шаблона хоста. Один на экран, а не на каждого читателя: экран, `RecordView` и меню читают
 * его одним ключом.
 */
export function withSupplyRecords(golden: Record<string, number>): Record<string, number> {
  return plusQueries(golden, 1);
}

/**
 * 1б §5.2, С1б-16: ровно один запрос записей-приложений (`useApps`, `APPS_QUERY`) — правило открытия
 * на каждом открытии записи. Идёт той же HTTP-пачкой, что `entity.get` (`httpBatchLink`), и не ждёт
 * её; экран, меню и плитки читают его одним ключом.
 */
export function withAppsList(golden: Record<string, number>): Record<string, number> {
  return plusQueries(golden, 1);
}

/** Запросы, которые ОБЯЗАН сделать экран записи 1б на фикстуре эталона: эталон 1а + три списка. */
export function INTENDED_1B_REQUESTS(golden: Record<string, number>): Record<string, number> {
  return withAppsList(withSupplyRecords(withTemplatesList(golden)));
}
