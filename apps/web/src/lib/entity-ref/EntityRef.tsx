import { trpc } from '../../trpc';
import { Skeleton } from '../../ui/Skeleton';
import { useNoteRegistryVersion } from '../registry/useRegistry';

/**
 * Человеко-читаемая ссылка на сущность по id (вместо сырого UUID в UI).
 * Per-id entity.get уже используется PinnedList — React Query кэширует и дедупит,
 * списки короткие, сервер не трогаем. Пока грузится — skeleton под короткий текст;
 * ошибка/нет данных — укороченный моноширинный id; успех — title.
 */
export function EntityRef({ id, onOpen }: { id: string; onOpen?: (id: string) => void }) {
  const q = trpc.entity.get.useQuery({ id });
  /**
   * Версия реестра из этого же ответа (§А10-1) — повод перечитать снимок подписей.
   *
   * Место выбрано не случайно: чипы ссылок стоят ровно там, где подписи и показываются вне
   * экрана записи — в строках предложения, в карточках чата, в «Связанном». Экран записи
   * сообщает версию сам (`useEntityDetail`); без второй точки чат жил бы со снимком,
   * снятым при последнем открытии записи. Хук идемпотентен: та же строка не будит никого,
   * поэтому десяток чипов на экране стоит один раз.
   */
  useNoteRegistryVersion(q.data?.registryVersion);
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
