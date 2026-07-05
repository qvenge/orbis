import { useNav } from '../../state/navigation';
import { type RouterOutputs, trpc } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { firstQueryBlock } from './query';

type Settings = RouterOutputs['user']['getSettings'];

function PinnedRow({ id }: { id: string }) {
  const push = useNav((s) => s.push);
  const ent = trpc.entity.get.useQuery({ id, include: ['body'] });
  const body = ent.data?.entity.body ?? '';
  const block = firstQueryBlock(body);
  const count = trpc.entity.count.useQuery({ query: block ?? '' }, { enabled: !!block });
  const badge = count.data ? (count.data.count > 99 ? '99+' : String(count.data.count)) : null;
  return (
    <button
      type="button"
      onClick={() => push('browser', { kind: 'entity', id })}
      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2"
    >
      <span className="truncate">{ent.data?.entity.title ?? id}</span>
      {badge && <Badge data-testid={`pin-badge-${id}`}>{badge}</Badge>}
    </button>
  );
}

export function Sidebar({ settings }: { settings: Settings }) {
  const pinned = [...(settings.pinnedEntities ?? [])].sort((a, b) => a.order - b.order);
  return (
    <aside className="flex flex-col border-r border-line">
      <p className="px-3 py-2 text-xs uppercase text-text-muted">Закреплённые</p>
      {pinned.map((p) => (
        <PinnedRow key={p.id} id={p.id} />
      ))}
    </aside>
  );
}
