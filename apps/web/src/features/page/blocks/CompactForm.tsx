import { RecordLink } from '../../../lib/entity-ref/RecordLink';
import type { BlockRow } from './types';

/**
 * `compact` — форма по умолчанию (спека страниц 1а §5.4, §7.2): только заголовки записей, как у
 * прежнего смарт-листа. Новое — строка открывает запись: ссылкой, чтобы
 * её доставали клавиатура и скринридер, и чтобы клик по ней не поднимал редактор тела
 * (`isBodyGesture` пропускает ссылки мимо). Закрытые (`closedIds` сервера, п. 42) — зачёркнуты.
 */
export function CompactForm({
  rows,
  closed,
}: {
  rows: readonly BlockRow[];
  closed: ReadonlySet<string>;
}) {
  return (
    <ul className="flex flex-col divide-y divide-line">
      {rows.map((e) => (
        <li key={e.id} data-testid="qb-item" className="text-sm">
          <RecordLink
            id={e.id}
            className={`block w-full cursor-pointer py-1 text-left hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${closed.has(e.id) ? 'text-text-muted line-through' : ''}`}
          >
            {e.title}
          </RecordLink>
        </li>
      ))}
    </ul>
  );
}
