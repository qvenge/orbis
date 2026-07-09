import { trpc } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { firstQueryBlock } from './query';

// Закреплённые сущности (§3.2). Сам тянет user.getSettings; куда открывать — решает
// вызывающий через onOpen (SidebarNav: browser-стек + переключение таба; BrowserScreen:
// push в свой стек).

// null — настройки ещё грузятся (ничего не рендерим, скелетоны — этап 4).
function usePinnedIds(): string[] | null {
  const settings = trpc.user.getSettings.useQuery();
  if (!settings.data) return null;
  return [...(settings.data.pinnedEntities ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((p) => p.id);
}

// Заголовок + бейдж по первому {{query:...}}-блоку body закреплённой сущности (§3.2).
function usePinnedEntity(id: string) {
  const ent = trpc.entity.get.useQuery({ id, include: ['body'] });
  const body = ent.data?.entity.body ?? '';
  const block = firstQueryBlock(body);
  const count = trpc.entity.count.useQuery({ query: block ?? '' }, { enabled: !!block });
  const badge = count.data ? (count.data.count > 99 ? '99+' : String(count.data.count)) : null;
  return { title: ent.data?.entity.title ?? id, badge };
}

// Вертикальный список для SidebarNav (десктоп).
export function PinnedList({ onOpen }: { onOpen: (id: string) => void }) {
  const ids = usePinnedIds();
  if (!ids) return null;
  if (ids.length === 0)
    return <p className="px-2 py-1 text-2xs text-text-muted">Нет закреплённых</p>;
  return (
    <div className="flex flex-col gap-0.5">
      {ids.map((id) => (
        <PinnedRow key={id} id={id} onOpen={onOpen} />
      ))}
    </div>
  );
}

function PinnedRow({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const { title, badge } = usePinnedEntity(id);
  return (
    <button
      type="button"
      data-testid={`pinned-${id}`}
      onClick={() => onOpen(id)}
      className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-control px-2 py-1.5 text-left text-sm text-text-secondary transition hover:bg-surface-2/60 hover:text-text"
    >
      <span className="truncate">{title}</span>
      {badge && <Badge data-testid={`pin-badge-${id}`}>{badge}</Badge>}
    </button>
  );
}

// Горизонтальная лента чипов для BrowserScreen (мобила, md:hidden).
// Пустая лента не рендерится вовсе.
export function PinnedChips({ onOpen }: { onOpen: (id: string) => void }) {
  const ids = usePinnedIds();
  if (!ids || ids.length === 0) return null;
  return (
    <div className="flex shrink-0 gap-1.5 overflow-x-auto px-3 pt-2 md:hidden">
      {ids.map((id) => (
        <PinnedChip key={id} id={id} onOpen={onOpen} />
      ))}
    </div>
  );
}

function PinnedChip({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const { title, badge } = usePinnedEntity(id);
  return (
    <button
      type="button"
      data-testid={`pin-chip-${id}`}
      onClick={() => onOpen(id)}
      className="flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-text-secondary transition hover:bg-surface-2 hover:text-text"
    >
      <span className="max-w-32 truncate">{title}</span>
      {badge && <span className="text-2xs text-text-muted">{badge}</span>}
    </button>
  );
}
