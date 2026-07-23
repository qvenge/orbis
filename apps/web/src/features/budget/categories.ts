// Общий список категорий Budget: запрос §6.1 + маппинг wire-сущности в опцию выбора.
// Делят QuickAddBar (§3.6: пилюли/полный выбор) и TransactionsScreen (§3.3: фильтр
// категории + Sheet рекатегоризации) — один запрос, один кэш tRPC.
import type { RouterOutputs } from '../../trpc';

type QueryEntity = RouterOutputs['entity']['query'][number];

export const CATEGORIES_QUERY = 'aspect=orbis/category, sortBy=title:asc, limit=200';

export type CategoryOption = {
  id: string;
  title: string;
  icon: string | null;
  /** `orbis/category.color` (#RRGGBB, §3.6 реестра) — подсветка бейджа §3.3. */
  color: string | null;
};

export function toOption(e: QueryEntity): CategoryOption {
  const cat = (e.aspects as Record<string, { icon?: unknown; color?: unknown } | undefined>)[
    'orbis/category'
  ];
  return {
    id: e.id,
    title: e.title,
    icon: typeof cat?.icon === 'string' && cat.icon !== '' ? cat.icon : null,
    color: typeof cat?.color === 'string' && cat.color !== '' ? cat.color : null,
  };
}
