import { openEntity } from '../../../state/navigation';
import type { BlockRow } from './types';

/**
 * `compact` — форма по умолчанию (спека страниц 1а §5.4, §7.2): только заголовки записей, как у
 * прежнего смарт-листа. Новое — строка открывает запись: кнопкой, а не кликом по `<li>`, чтобы
 * её доставали клавиатура и скринридер, и чтобы клик по ней не поднимал редактор тела
 * (`isBodyGesture` пропускает кнопки мимо).
 */
export function CompactForm({ rows }: { rows: readonly BlockRow[] }) {
  return (
    <ul className="flex flex-col divide-y divide-line">
      {rows.map((e) => (
        <li key={e.id} data-testid="qb-item" className="text-sm">
          <button
            type="button"
            onClick={() => openEntity(e.id)}
            className="w-full cursor-pointer py-1 text-left hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {e.title}
          </button>
        </li>
      ))}
    </ul>
  );
}
