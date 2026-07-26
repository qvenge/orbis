import { useNav } from '../../state/navigation';
import type { RouterOutputs } from '../../trpc';

type Backlink = NonNullable<RouterOutputs['entity']['get']['backlinks']>[number];

// Пометка источника (02-core-os §3.5.7): явная related_to-связь или упоминание в теле.
const VIA_LABEL: Record<string, string> = { relation: 'связь', mention: 'упоминание' };

/**
 * Секция 7 «Связанное (backlinks)» — ОДНА секция из двух источников: сервер отдаёт их
 * готовым списком в entity.get(include:['backlinks']) с пометкой via, поэтому титулы
 * здесь не дочитываются (в отличие от блокировок). Пустая секция скрыта (§3.5).
 *
 * truncated — сервер упёрся в потолок выборки (DF п.4): счётчик показывается как «N+»,
 * иначе «Связанное (100)» читалось бы как точное число связей (урок C6).
 */
export function Backlinks({ items, truncated }: { items: Backlink[]; truncated: boolean }) {
  const push = useNav((s) => s.push);
  const activeTab = useNav((s) => s.activeTab);
  if (items.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <p className="text-2xs font-medium uppercase tracking-wide text-text-muted">
        Связанное ({items.length}
        {truncated ? '+' : ''})
      </p>
      <ul className="flex flex-col">
        {items.map(({ entity, via }) => (
          <li
            key={entity.id}
            data-testid="backlink"
            className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition hover:bg-surface-2/60"
          >
            {/* Открытие — push в АКТИВНЫЙ таб поверх текущего Detail (как у подзадач). */}
            <button
              type="button"
              onClick={() => push(activeTab, { kind: 'entity', id: entity.id })}
              className="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline"
            >
              {entity.title}
            </button>
            <span className="shrink-0 text-2xs text-text-muted">{VIA_LABEL[via] ?? via}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
