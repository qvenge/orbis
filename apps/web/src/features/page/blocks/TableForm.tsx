import { rowProjectionOf } from '@orbis/shared';
import type { QueryColumn } from '@orbis/shared/query';
import { formatMoney } from '../../../lib/format';
import { displayText, EMPTY_TEXT } from '../../../lib/registry/format';
import { classLabel } from '../../../lib/registry/labels';
import { rowRegistryOf } from '../../../lib/registry/row';
import { type RegistryView, useRegistry } from '../../../lib/registry/useRegistry';
import { openEntity } from '../../../state/navigation';
import { formatDay } from '../../browser/EntityRow';
import type { BlockRow } from './types';

const CELL = 'px-2 py-1 text-left align-top';

/** Название — кнопкой, как строка `compact`: таблица на странице — тоже вход в свои записи. */
function TitleCell({ row }: { row: BlockRow }) {
  return (
    <td className={CELL}>
      <button
        type="button"
        onClick={() => openEntity(row.id)}
        className="cursor-pointer text-left hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        {row.title}
      </button>
    </td>
  );
}

/**
 * Колонки без `columns` — элементы строки фактов по контрактам (Р-13, M14): те же дата, сумма и
 * отметки, что рисует `EntityRow`, только каждая в своей колонке. Колонка появляется, только если
 * хоть у одной строки есть её элемент: пустой столбец прочерков — шум, а не таблица.
 */
function FactsTable({ rows, registry }: { rows: readonly BlockRow[]; registry: RegistryView }) {
  const reg = rowRegistryOf(registry.data);
  const facts = rows.map((e) => ({ e, row: rowProjectionOf(e, reg) }));
  const hasDate = facts.some((f) => f.row.date !== null);
  const hasAmount = facts.some((f) => f.row.amount !== null);
  const hasBadges = facts.some((f) => f.row.badges.length > 0);
  return (
    <table className="w-full text-sm">
      <thead className="text-text-muted text-xs">
        <tr>
          <th className={CELL}>Название</th>
          {hasDate && <th className={CELL}>Дата</th>}
          {hasAmount && <th className={CELL}>Сумма</th>}
          {hasBadges && <th className={CELL}>Отметки</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {facts.map(({ e, row }) => (
          <tr key={e.id} data-testid="qb-item">
            <TitleCell row={e} />
            {hasDate && (
              <td className={CELL}>{row.date ? formatDay(row.date.value) : EMPTY_TEXT}</td>
            )}
            {hasAmount && (
              <td className={`${CELL} tabular-nums`}>
                {row.amount
                  ? formatMoney(
                      row.amount.amount,
                      row.amount.direction === 'inflow' ? 'income' : 'expense',
                    ).text
                  : EMPTY_TEXT}
              </td>
            )}
            {hasBadges && (
              <td className={CELL}>
                {row.badges
                  .map((b) =>
                    b.kind === 'priority'
                      ? displayText(registry.property('orbis/priority'), 'high')
                      : classLabel(registry, b.contract, b.cls),
                  )
                  .join(', ')}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * `table` (спека страниц 1а §5.4, §7.2): с `columns` — колонки названных свойств, подпись — из
 * реестра, значение — по ТИПУ свойства (`displayText`: подпись варианта, «да/нет», прочерк);
 * без `columns` — строка фактов (`FactsTable`). Первая колонка — название записи всегда: таблица
 * строк без имени строки не читается.
 */
export function TableForm({
  rows,
  columns,
}: {
  rows: readonly BlockRow[];
  columns: readonly QueryColumn[] | undefined;
}) {
  const registry = useRegistry();
  if (columns === undefined) return <FactsTable rows={rows} registry={registry} />;
  return (
    <table className="w-full text-sm">
      <thead className="text-text-muted text-xs">
        <tr>
          <th className={CELL}>Название</th>
          {columns.map((c) => (
            <th key={c.field} className={CELL}>
              {registry.label(c.field)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map((e) => (
          <tr key={e.id} data-testid="qb-item">
            <TitleCell row={e} />
            {columns.map((c) => (
              <td key={c.field} className={CELL}>
                {displayText(registry.property(c.field), e.props[c.field], registry)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
