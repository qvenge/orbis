import { useQuery } from '@tanstack/react-query';
import { QUERY_BLOCK_KEY, useBlockBatcher } from './batch';

/** Потолок числа на бейдже: больше — «99+», как у бейджей навигации телефонов. */
const BADGE_CAP = 99;

/**
 * Бейдж раздела навигации (спека 1б §9.3, РП-8): число из ПЕРВОГО блока данных страницы раздела.
 *
 * Просьба — элемент `badgeOf` в том же собирателе пачки, что и блоки страниц (`batch.tsx`): все
 * бейджи листа разделов уходят ОДНИМ `entity.blocks` — без `entity.get` на раздел и без
 * `entity.count` (второй путь данных 1а снят). Ключ — под префиксом блоков: инвалидация графа
 * (`invalidateQueryBlocks`) перечитывает и бейджи.
 *
 * `badge` — `null`, когда числа нет (у страницы нет блока данных — `kind:'none'`, ноль, отказ):
 * бейдж без числа хуже отсутствия бейджа.
 */
export function useBadgeData(entityId: string): { badge: string | null } {
  const batcher = useBlockBatcher('useBadgeData');
  const q = useQuery({
    queryKey: [QUERY_BLOCK_KEY, 'badge', entityId],
    queryFn: () => batcher.ask({ badgeOf: entityId }),
  });
  const r = q.data;
  if (r === undefined || !r.ok || r.kind !== 'count' || r.count <= 0) return { badge: null };
  return { badge: r.count > BADGE_CAP ? `${BADGE_CAP}+` : String(r.count) };
}
