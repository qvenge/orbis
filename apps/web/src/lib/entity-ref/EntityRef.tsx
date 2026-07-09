import { trpc } from '../../trpc';
import { Skeleton } from '../../ui/Skeleton';

/**
 * Человеко-читаемая ссылка на сущность по id (вместо сырого UUID в UI).
 * Per-id entity.get уже используется PinnedList — React Query кэширует и дедупит,
 * списки короткие, сервер не трогаем. Пока грузится — skeleton под короткий текст;
 * ошибка/нет данных — укороченный моноширинный id; успех — title.
 */
export function EntityRef({ id, onOpen }: { id: string; onOpen?: (id: string) => void }) {
  const q = trpc.entity.get.useQuery({ id });
  if (q.isLoading) return <Skeleton className="inline-block h-4 w-24 align-middle" />;
  const title = q.data?.entity.title;
  if (!title)
    return (
      <span className="font-mono text-xs text-text-muted" title={id}>
        {id.slice(0, 8)}…
      </span>
    );
  if (onOpen)
    return (
      <button
        type="button"
        onClick={() => onOpen(id)}
        className="cursor-pointer text-left hover:underline"
      >
        {title}
      </button>
    );
  return <span>{title}</span>;
}
