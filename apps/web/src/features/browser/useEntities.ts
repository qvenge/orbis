import { useState } from 'react';
import { trpc } from '../../trpc';
import { browserQuery } from './query';

const PAGE = 50;

export function useEntities(filters: string) {
  const [limit, setLimit] = useState(PAGE);
  const query = browserQuery({ limit, filters });
  const q = trpc.entity.query.useQuery({ query });
  const entities = q.data ?? [];
  const hasMore = entities.length >= limit;
  // isError наружу: без него отказ выборки неотличим от пустого результата — потребитель
  // рисует пустое состояние и врёт про содержимое графа (бэклог фазы D, MemoryScreen).
  return {
    entities,
    hasMore,
    loadMore: () => setLimit((l) => l + PAGE),
    isLoading: q.isLoading,
    isError: q.isError,
  };
}
