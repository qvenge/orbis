// Общий список категорий Budget: запрос §6.1 + маппинг wire-сущности в опцию выбора.
// Делят QuickAddBar (§3.6: пилюли/полный выбор) и TransactionsScreen (§3.3: фильтр
// категории + Sheet рекатегоризации) — один запрос, один кэш tRPC.
import type { RouterOutputs } from '../../trpc';

type QueryEntity = RouterOutputs['entity']['query'][number];

export const CATEGORIES_QUERY = 'aspect=orbis/category, sortBy=title:asc, limit=200';

export type CategoryOption = { id: string; title: string; icon: string | null };

export function toOption(e: QueryEntity): CategoryOption {
  const icon = (e.aspects as Record<string, { icon?: unknown } | undefined>)['orbis/category']
    ?.icon;
  return { id: e.id, title: e.title, icon: typeof icon === 'string' && icon !== '' ? icon : null };
}
