import { useOpenRecord } from '../../../app/useOpenRecord';
import { EntityRow } from '../../browser/EntityRow';
import type { BlockRow } from './types';

/**
 * `list` — строки как в Browser (спека страниц 1а §7.2): `EntityRow` в кнопке по образцу
 * `EntityList`. Чекбокса статуса нет по построению (Р-13): у `EntityRow` это глиф-индикатор, а не
 * контрол, — отметка со страницы придёт действием в срезе 2. `closed` — записи из `closedIds` сервера
 * (п. 42): набор «закрыто», заданный условием, проекция строки не вычисляет.
 */
export function ListForm({
  rows,
  closed,
}: {
  rows: readonly BlockRow[];
  closed: ReadonlySet<string>;
}) {
  const openEntity = useOpenRecord();
  return (
    <ul className="flex flex-col gap-px">
      {rows.map((e) => (
        <li key={e.id} data-testid="qb-item">
          <button
            type="button"
            onClick={() => openEntity(e.id)}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left text-sm transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <EntityRow entity={e} closed={closed.has(e.id)} />
          </button>
        </li>
      ))}
    </ul>
  );
}
