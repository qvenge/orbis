import { Inbox } from 'lucide-react';
import {
  useCreateAwareOpen,
  useCreatePlacement,
  useCreateSurface,
} from '../../lib/optimistic/use-create-intent';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { EntityRow } from './EntityRow';
import { QuickCapture } from './QuickCapture';
import { useEntities } from './useEntities';

/**
 * Список «Записей». Куда открыть запись, решает место показа (`onOpen`), а не список: блок на
 * странице открывает её в рамке экрана, в текущем разделе (`useOpenRecord`). Жёсткий переход из
 * самого списка увёл бы запись со страницы любого раздела в чужую стопку.
 */
export function EntityList({
  filters = '',
  showPagesAndApps,
  onOpen,
  capture = false,
  captureSlot,
}: {
  filters?: string;
  showPagesAndApps: boolean;
  capture?: boolean;
  captureSlot?: string;
  onOpen: (id: string) => void;
}) {
  const { entities, queryKey, hasMore, loadMore, isLoading } = useEntities(
    filters,
    showPagesAndApps,
  );
  const origin = useCreateSurface('records-capture', captureSlot);
  const placement = { key: queryKey, ids: entities.map((entity) => entity.id) };
  const { hiddenCanonical } = useCreatePlacement(origin, capture ? placement : undefined);
  const open = useCreateAwareOpen(onOpen);
  return (
    <>
      <EntityListRows
        entities={capture ? entities.filter((entity) => !hiddenCanonical.has(entity.id)) : entities}
        onOpen={open}
        hasMore={hasMore}
        loadMore={loadMore}
        isLoading={isLoading}
      />
      {capture && (
        <QuickCapture
          context={{ kind: 'root' }}
          surface="records-capture"
          captureSlot={captureSlot}
          placement={placement}
        />
      )}
    </>
  );
}

function EntityListRows({
  entities,
  onOpen,
  hasMore,
  loadMore,
  isLoading,
}: Pick<ReturnType<typeof useEntities>, 'entities' | 'hasMore' | 'loadMore' | 'isLoading'> & {
  onOpen: (id: string) => void;
}) {
  if (isLoading)
    return (
      <div className="flex flex-col gap-2 p-3">
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: статичные placeholder-ряды
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  if (entities.length === 0)
    return (
      <EmptyState
        icon={<Inbox size={32} aria-hidden />}
        title="Здесь появятся ваши записи"
        hint="Добавьте первую через быструю запись ниже"
      />
    );
  return (
    <div className="flex flex-col">
      {/* Без разделительных линий (Notion): строка — скруглённый hover-ряд. */}
      <ul className="flex flex-col gap-px px-1">
        {entities.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              data-testid="entity-row"
              onClick={() => onOpen(e.id)}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <EntityRow entity={e} />
            </button>
          </li>
        ))}
      </ul>
      {hasMore && (
        <Button variant="ghost" onClick={loadMore} className="m-2 self-center">
          Показать ещё
        </Button>
      )}
    </div>
  );
}
