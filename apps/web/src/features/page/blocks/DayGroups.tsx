import type { BlockDayGroup, BlockGroupRow } from '@orbis/shared';
import { useOpenRecord } from '../../../app/useOpenRecord';
import type { BlockData } from '../../../lib/query-blocks/batch';
import { useRowProjection } from '../../../lib/registry/row';
import { EntityRow } from '../../browser/EntityRow';
import { dayHeaderLabel, dayInTimeZone, rowTimeLabel } from './day-format';

export interface DayGroupsProps {
  /** Ответ блока вида `groups` с верхом пачки — «сегодня» и пояс владельца (`batch.tsx`). */
  result: Extract<BlockData, { kind: 'groups' }>;
  /** Форма строк блока: группы рисуются только у строк (`list`/`compact`, §5.2). */
  display: 'list' | 'compact';
}

/** Строки группы и то, что строке нужно от ответа: день группы, пояс, закрытые по серверу. */
interface RowCtx {
  day: string | null;
  timeZone: string;
  closed: ReadonlySet<string>;
}

const ROW_BUTTON =
  'flex w-full cursor-pointer items-center gap-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50';

/**
 * Колонка времени слева от строки (§5.2) — по дате, поставившей запись в день; у «Без даты» пустая
 * (ширина та же: заголовки строк стоят одной колонкой во всех группах).
 */
function TimeCell({ row, ctx }: { row: BlockGroupRow; ctx: RowCtx }) {
  return (
    <span data-testid="qb-time" className="w-24 shrink-0 text-xs tabular-nums text-text-muted">
      {row.at === null || ctx.day === null ? '' : rowTimeLabel(row.at, ctx.day, ctx.timeZone)}
    </span>
  );
}

/**
 * `list` — строка `EntityRow`, как у формы `ListForm`, с колонкой времени. Дата строки (элемент
 * строки фактов) не печатается, если её день В ПОЯСЕ ОТВЕТА совпадает с днём группы (§5.2, как
 * `showRowDate` прежнего экрана): «начать во вторник, срок в четверг» во вторнике показывает срок,
 * а встреча в 00:30 по времени владельца не получает вчерашнюю дату браузера в UTC.
 */
function ListRow({ row, ctx }: { row: BlockGroupRow; ctx: RowCtx }) {
  const openEntity = useOpenRecord();
  const date = useRowProjection(row.entity).date;
  const showDate = date === null || dayInTimeZone(date.value, ctx.timeZone) !== ctx.day;
  return (
    <li data-testid="qb-item">
      <button
        type="button"
        onClick={() => openEntity(row.entity.id)}
        className={`${ROW_BUTTON} rounded-lg px-1.5 py-1.5 transition hover:bg-surface-2`}
      >
        <TimeCell row={row} ctx={ctx} />
        <EntityRow entity={row.entity} showDate={showDate} closed={ctx.closed.has(row.entity.id)} />
      </button>
    </li>
  );
}

/** `compact` — только заголовок, как у `CompactForm`, с колонкой времени и зачёркиванием от сервера. */
function CompactRow({ row, ctx }: { row: BlockGroupRow; ctx: RowCtx }) {
  const openEntity = useOpenRecord();
  const closed = ctx.closed.has(row.entity.id);
  return (
    <li data-testid="qb-item">
      <button
        type="button"
        onClick={() => openEntity(row.entity.id)}
        className={`${ROW_BUTTON} py-1 hover:text-accent`}
      >
        <TimeCell row={row} ctx={ctx} />
        <span className={`flex-1 truncate ${closed ? 'text-text-muted line-through' : ''}`}>
          {row.entity.title}
        </span>
      </button>
    </li>
  );
}

function Group({
  group,
  today,
  display,
  ctx,
}: {
  group: BlockDayGroup;
  today: string;
  display: 'list' | 'compact';
  ctx: Omit<RowCtx, 'day'>;
}) {
  const rowCtx: RowCtx = { ...ctx, day: group.day };
  const Row = display === 'list' ? ListRow : CompactRow;
  return (
    <section data-testid="day-group" className="flex flex-col gap-1">
      <h3 data-testid="day-group-header" className="text-xs font-medium text-text-secondary">
        {group.day === null ? 'Без даты' : dayHeaderLabel(group.day, today)}
      </h3>
      {group.rows.length === 0 ? (
        <p className="text-xs text-text-muted">свободно</p>
      ) : (
        <ul
          className={
            display === 'list' ? 'flex flex-col gap-px' : 'flex flex-col divide-y divide-line'
          }
        >
          {group.rows.map((row) => (
            <Row key={row.entity.id} row={row} ctx={rowCtx} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Лента по дням (спека 1в §5.2): группы приходят от сервера готовыми — порядок дней, пустые дни
 * периода, «Без даты» последней, порядок строк внутри дня. Клиент только рисует: заголовки дней от
 * `today` ответа, колонку времени и подавление даты строки в поясе ответа, зачёркивание по
 * `closedIds`. Лента только показывает: тап открывает запись (§6.1); отметка и перенос — срез 2.
 *
 * «ещё N» рисует блок данных после ленты (`DataBlock`, общий с формами строк): кнопка в ленивом
 * чанке вынесла бы `MoreRows` отдельным общим чанком первого кадра записи (+≈240 Б gzip замыкания,
 * замерено сборкой задачи 7). При обрезке лимитом свободных дней после последней строки сервер не
 * выдаёт (R-16) — лента это не дорисовывает.
 */
export function DayGroups({ result, display }: DayGroupsProps) {
  const ctx = { timeZone: result.timeZone, closed: new Set(result.closedIds) };
  return (
    <div className="flex flex-col gap-3">
      {result.groups.map((g) => (
        <Group key={g.day ?? ''} group={g} today={result.today} display={display} ctx={ctx} />
      ))}
    </div>
  );
}
