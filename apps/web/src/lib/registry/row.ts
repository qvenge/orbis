// Правило строки — общее (packages/shared/src/registry/row.ts). Здесь только переход от ФОРМЫ
// ОТВЕТА `registry.effective` (массивы) к форме чистой функции (словари) и хук над снимком.
import {
  type RowEntity,
  type RowProjection,
  type RowRegistry,
  rowCategoryRefOf,
  rowProjectionOf,
  rowStatusPropertyOf,
} from '@orbis/shared';
import type { EffectiveRegistry } from './labels';
import { useRegistry } from './useRegistry';

const EMPTY: RowRegistry = { aspects: new Map(), contracts: new Map() };
/**
 * Словари снимка. Кэш по ССЫЛКЕ: у списка Browser 50 строк, и без него каждая строила бы обе карты
 * заново. Снимок живёт одной ссылкой, пока новая версия его не перечитала (`useRegistry`: один ключ
 * `REGISTRY_QUERY_KEY`, `staleTime: Infinity`).
 */
const BY_SNAPSHOT = new WeakMap<object, RowRegistry>();
/**
 * Словарь по id. Список объявлен ДОПУСКАЮЩИМ `undefined`, хотя тип ответа его не допускает, — то
 * же правило, что у `lookupOf` (`data?.properties ?? []`): ответ без словаря (обвязка теста,
 * сорванная сериализация) обязан дать пустую строку, а не уронить экран на `.map` от `undefined`.
 */
function dictOf<T extends { id: string }>(rows: readonly T[] | undefined): Map<string, T> {
  return new Map((rows ?? []).map((r) => [r.id, r]));
}
export function rowRegistryOf(data: EffectiveRegistry | undefined): RowRegistry {
  if (data === undefined) return EMPTY;
  const hit = BY_SNAPSHOT.get(data);
  if (hit !== undefined) return hit;
  const built: RowRegistry = {
    aspects: dictOf(data.aspects),
    contracts: dictOf(data.contracts),
  };
  BY_SNAPSHOT.set(data, built);
  return built;
}
/**
 * Контракты, чьи агрегаты считает сервер (движок бюджета): «движение денег» — `spent`, списки
 * планов и фактов; «конверт» — лимиты и периоды. Оба — язык (`module: null`, Р-7 спеки 1б).
 */
const MONEY_CONTRACTS: readonly string[] = ['orbis/money-movement', 'orbis/envelope'];

/**
 * Трогает ли правка этих свойств деньги (спека 1б §8.4, Н-5): свойство связано слотом контракта
 * «движение денег» или «конверт» у какого-либо аспекта снимка. Признак — по привязкам, а не по
 * `module` свойства: сумма, валюта, направление и дата операции с 1б — язык (`module: null`), и
 * признак «свойство Финансов» перестал бы видеть правку суммы. Ни одно расширение здесь не названо:
 * код ядра не знает, кто реализует контракт (спека §8.4, С1б-10).
 *
 * Пустой снимок (реестр ещё едет) отвечает «нет»: привязок, по которым судить, ещё нет.
 */
export function touchesMoneyContract(propertyIds: readonly string[], reg: RowRegistry): boolean {
  if (propertyIds.length === 0) return false;
  const bound = new Set<string>();
  for (const aspect of reg.aspects.values()) {
    for (const impl of aspect.implements) {
      if (!MONEY_CONTRACTS.includes(impl.contract)) continue;
      for (const property of Object.values(impl.bind)) bound.add(property);
    }
  }
  return propertyIds.some((id) => bound.has(id));
}

/**
 * Пустой снимок (реестр ещё едет) даёт пустую проекцию: строка печатает заголовок и дорисовывает
 * элементы первым же ответом. Прятать строку до реестра нельзя — то же правило, что у `lookupOf`.
 */
export function useRowProjection(entity: RowEntity): RowProjection {
  return rowProjectionOf(entity, rowRegistryOf(useRegistry().data));
}

/**
 * Свойство статуса победившей привязки `orbis/completable` — для ГАРДА переключения чекбокса
 * (`NativeRow`): показать состояние можно у всякого реализатора контракта, а записать — только
 * туда, куда умеет писатель. `undefined` — реестр ещё едет, контракт не реализован либо слот
 * закрыт константой.
 */
export function useRowStatusProperty(entity: RowEntity): string | undefined {
  return rowStatusPropertyOf(entity, rowRegistryOf(useRegistry().data));
}

/**
 * Ссылка на категорию ДВИЖЕНИЯ (слот `category` контракта денег) — для бейджа категории в шапке.
 * `null` — реестр ещё едет либо запись движением не является: у конверта, несущего то же свойство
 * слотом СВОЕГО контракта, бейджа и запроса категорий быть не должно (B4 M-1).
 */
export function useRowCategoryRef(entity: RowEntity): string | null {
  return rowCategoryRefOf(entity, rowRegistryOf(useRegistry().data));
}
