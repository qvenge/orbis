import { useNav } from '../../state/navigation';
import type { RouterOutputs } from '../../trpc';

type Backlink = NonNullable<RouterOutputs['entity']['get']['backlinks']>[number];

/**
 * Секция 8 «Связанное (backlinks)» — ОДНА секция из двух источников: сервер отдаёт их
 * готовым списком в entity.get(include:['backlinks']) с ГОТОВОЙ подписью направления,
 * поэтому титулы здесь не дочитываются (в отличие от блокировок). Пустая секция скрыта (§3.5).
 *
 * Своего словаря направлений у клиента больше нет (Ч10-С3): подпись даёт реестр ролей
 * (`source_label`/`target_label`), и своя роль владельца подписывается сама собой — а
 * словарь в клиенте показал бы у неё чужое слово или голый id.
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
        {items.map(({ entity, viaLabel }) => (
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
            <span className="shrink-0 text-2xs text-text-muted">{viaLabel}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
