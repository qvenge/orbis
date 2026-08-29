// Список категорий Budget как СМАРТ-ЛИСТ: боевой текст §6.1 + маппинг wire-сущности в
// опцию показа. Делят экраны, которым нужны НАЗВАНИЯ категорий рядом со строками, —
// пилюли быстрой записи (§3.6), фильтр и бейджи «Транзакций» (§3.3), перенос остатков,
// сверка импорта. ВЫБОР категории живёт не здесь: пикер один на все ссылочные свойства
// (`lib/entity-ref/RefField.tsx`, §А6-1) и берёт множество из реестра, а не из текста.
import { useRefTitle } from '../../lib/entity-ref/RefField';
import { useRegistry } from '../../lib/registry/useRegistry';
import type { RouterOutputs } from '../../trpc';

type QueryEntity = RouterOutputs['entity']['query'][number];

// `orbis/title` — namespaced key core-свойства (§А1-3), а не голое `title`: голым словом
// грамматика называет ПАРАМЕТР ЗАГОЛОВКА выдачи, и `sortBy=title:asc` она отвергает как
// «слово грамматики» — переименованием полей аспекта такой адрес не чинится.
export const CATEGORIES_QUERY = 'aspect=orbis/category, sortBy=orbis/title:asc, limit=200';

/** Свойство-ссылка на категорию (§А8, В1: одно на операцию и на конверт). */
export const FINANCE_CATEGORY = 'orbis/finance_category';

export type CategoryOption = {
  id: string;
  title: string;
  icon: string | null;
  /** `orbis/color` (#RRGGBB, §А8) — подсветка бейджа §3.3. */
  color: string | null;
};

/**
 * Название категории по её id (D6c п.2): поверхности, где раньше печатался сырой
 * `category_ref` (шапка detail, сетка полей карточки чата).
 *
 * Своей реализации у неё БОЛЬШЕ НЕТ: это `useRefTitle` по свойству `orbis/finance_category`,
 * то есть тот же список, что показывает пикер (§А6-1) — и потому одно название у поля, у
 * бейджа и у выбора. Обёртка оставлена ради двух вызывающих (`NativeRow`, `EntityCard`):
 * им нужна ровно категория, и знать про реестр им незачем.
 *
 * Три состояния (`isPending`/`isError`) и правило запасного uuid — у `useRefTitle`.
 */
export function useCategoryTitle(categoryRef: string): {
  title: string;
  isPending: boolean;
  isError: boolean;
} {
  const registry = useRegistry();
  return useRefTitle(registry.property(FINANCE_CATEGORY), categoryRef);
}

export function toOption(e: QueryEntity): CategoryOption {
  // Значения — плоско по id свойства (§А1-1). Признак носителя (`aspects`) здесь НЕ
  // спрашивается намеренно: `orbis/icon` и `orbis/color` остаются на записи и после снятия
  // аспекта «Категория» (Р9), а пикер рисует то, что у записи есть.
  const icon = e.props['orbis/icon'];
  const color = e.props['orbis/color'];
  return {
    id: e.id,
    title: e.title,
    icon: typeof icon === 'string' && icon !== '' ? icon : null,
    color: typeof color === 'string' && color !== '' ? color : null,
  };
}
