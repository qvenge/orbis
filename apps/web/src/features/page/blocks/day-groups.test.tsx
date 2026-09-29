/**
 * Лента по дням (спека 1в §5.2, С1в-5 web): блок `group=day:<адрес>` получает от сервера готовые
 * группы и верх пачки (`today`, `timeZone`) и только рисует — заголовки дней, «свободно», колонку
 * времени слева от строки, подавление даты строки, совпадающей с днём, зачёркивание по `closedIds`,
 * «ещё N» после последней группы. Лента — ленивым чанком (`DayGroupsSlot` → `DayGroups`, РП-18).
 *
 * Пояс процесса — `UTC` (закреплён ниже и сверен), пояс ответа — `Asia/Novosibirsk` (+07) обвязки
 * (`BLOCKS_TIME_ZONE`): Фокус ревью п. 1 — подписи и подавление даты считаются в поясе ОТВЕТА. Машина
 * разработчика сама в +07 (Asia/Barnaul): без явного `TZ` порча «пояс браузера» была бы зелёной.
 */
import type { BlockDayGroup, BlockResult } from '@orbis/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { BodyKindProvider } from '../../../lib/query-blocks/body-kind';
import { resetNavForTests } from '../../../state/navigation';
import {
  BLOCKS_TIME_ZONE,
  BLOCKS_TODAY,
  blocksReply,
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  wireEntity,
} from '../../../test/harness';
import { recordAddress, topAddress } from '../../../test/nav';
import { registryReply } from '../../../test/registry';
import { DataBlock } from './DataBlock';
import { resetDayGroupsForTests } from './DayGroupsSlot';

/** «Сеть» чанка ленты: `gate` — медленный чанк; по умолчанию приезжает сразу. */
const chunk = vi.hoisted(() => ({ attempts: 0, gate: Promise.resolve() as Promise<void> }));

installCrashTrap();

const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

beforeEach(() => {
  resetNavForTests();
  resetDayGroupsForTests();
  vi.doMock('./DayGroups', async (importOriginal) => {
    chunk.attempts += 1;
    await chunk.gate;
    return importOriginal();
  });
});

afterEach(() => {
  vi.doUnmock('./DayGroups');
  chunk.attempts = 0;
  chunk.gate = Promise.resolve();
});

const TEXT = 'orbis/when=next_7d, group=day:orbis/when, display=list';
const COMPACT = 'orbis/when=next_7d, group=day:orbis/when';

const id = (n: number) => `00000000-0000-4000-8000-0000000007${String(n).padStart(2, '0')}`;
const ID = { meet: id(1), report: id(2), t9: id(3), t7: id(4), idea: id(5) };

// Встреча в 00:30 по Новосибирску 27.09 — в UTC-браузере это ещё 26.09.
const meet = wireEntity({
  id: ID.meet,
  title: 'Встреча',
  aspects: ['orbis/schedule'],
  props: { 'orbis/start_at': '2026-09-26T17:30:00.000Z' },
});
// Проекция: не закрыта (`inbox`) — зачёркивает сервер (`closedIds`).
const report = wireEntity({
  id: ID.report,
  title: 'Отчёт',
  aspects: ['orbis/task'],
  props: { 'orbis/task_status': 'inbox', 'orbis/completed_at': '2026-09-27T16:40:00.000Z' },
});
// «Начать во вторник, срок в четверг» (спека §3.3): в дне начала, дата строки — срок.
const t9 = wireEntity({
  id: ID.t9,
  title: 'T9',
  aspects: ['orbis/task', 'orbis/schedule'],
  props: {
    'orbis/task_status': 'planned',
    'orbis/start_at': '2026-09-29T03:00:00.000Z',
    'orbis/due_date': '2026-10-01',
  },
});
// Срок в своём дне; проекция закрыта (`done`), сервер — нет: не зачёркивается.
const t7 = wireEntity({
  id: ID.t7,
  title: 'T7',
  aspects: ['orbis/task'],
  props: { 'orbis/task_status': 'done', 'orbis/due_date': '2026-09-29' },
});
const idea = wireEntity({ id: ID.idea, title: 'Идея', aspects: ['orbis/task'] });

const GROUPS: BlockDayGroup[] = [
  {
    day: '2026-09-27',
    rows: [
      {
        entity: meet as never,
        at: { slot: 'moment', value: '2026-09-26T17:30:00.000Z', end: null, allDay: false },
      },
      {
        entity: report as never,
        at: { slot: 'done', value: '2026-09-27T16:40:00.000Z', end: null, allDay: false },
      },
    ],
  },
  { day: '2026-09-28', rows: [] },
  {
    day: '2026-09-29',
    rows: [
      {
        entity: t7 as never,
        at: { slot: 'deadline', value: '2026-09-29', end: null, allDay: false },
      },
      {
        entity: t9 as never,
        at: { slot: 'moment', value: '2026-09-29T03:00:00.000Z', end: null, allDay: false },
      },
    ],
  },
  { day: null, rows: [{ entity: idea as never, at: null }] },
];

const groupsResult = (more = 0): BlockResult => ({
  ok: true,
  kind: 'groups',
  groups: GROUPS,
  more,
  closedIds: [ID.report],
});

const handler =
  (map: Parameters<typeof blocksReply>[0]): MockHandler =>
  (path, input) =>
    registryReply(path) ?? blocksReply(map)(path, input) ?? {};

function renderFeed(text: string, result: BlockResult) {
  return renderWithProviders(
    <BodyKindProvider kind="page">
      <DataBlock text={text} />
    </BodyKindProvider>,
    handler({ [text]: result }),
  );
}

const rowOf = (title: string) => {
  const item = screen.getByText(title).closest('[data-testid="qb-item"]');
  if (!(item instanceof HTMLElement)) throw new Error(`строки «${title}» нет`);
  return item;
};

test('обвязка отдаёт пояс ответа ≠ пояса процесса и ≠ запасного, пояс процесса — UTC', () => {
  expect(BLOCKS_TIME_ZONE).toBe('Asia/Novosibirsk');
  expect(BLOCKS_TODAY).toBe('2026-09-27');
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
});

test('заголовки дней в порядке ответа; пустой день — «свободно»; «Без даты» — последней', async () => {
  renderFeed(TEXT, groupsResult());
  const headers = await screen.findAllByTestId('day-group-header');
  expect(headers.map((h) => h.textContent)).toEqual([
    'Сегодня · вс, 27 сентября',
    'Завтра · пн, 28 сентября',
    'вт, 29 сентября',
    'Без даты',
  ]);
  const groups = screen.getAllByTestId('day-group');
  expect(within(groups[1] as HTMLElement).getByText('свободно')).toBeInTheDocument();
  expect(within(groups[1] as HTMLElement).queryAllByTestId('qb-item')).toHaveLength(0);
  expect(within(groups[0] as HTMLElement).queryByText('свободно')).toBeNull();
  // Счётчик блока — строки всех групп (пустые дни — не строки).
  expect(screen.getByTestId('qb-count')).toHaveTextContent('5');
});

test('колонка времени — слева от строки, в поясе ответа (Фокус ревью п. 1: «сделано 23:40»)', async () => {
  renderFeed(TEXT, groupsResult());
  await screen.findAllByTestId('day-group');
  const times = (title: string) => within(rowOf(title)).getByTestId('qb-time');
  expect(times('Встреча')).toHaveTextContent('00:30');
  expect(times('Отчёт')).toHaveTextContent('сделано 23:40');
  expect(times('T7')).toHaveTextContent('срок');
  expect(times('T9')).toHaveTextContent('10:00');
  expect(times('Идея')).toHaveTextContent('');
  // Слева: время — первый элемент кнопки строки, до заголовка.
  const button = within(rowOf('Встреча')).getByRole('button');
  expect(button.firstElementChild).toBe(times('Встреча'));
});

test('дата строки не повторяет день группы — в поясе ответа, не браузера', async () => {
  renderFeed(TEXT, groupsResult());
  await screen.findAllByTestId('day-group');
  // T9 в дне начала 29.09 — дата строки (срок 01.10) видна.
  await waitFor(() => expect(rowOf('T9')).toHaveTextContent('1 окт.'));
  // T7 — срок в своём дне: даты нет.
  expect(rowOf('T7')).not.toHaveTextContent('сент.');
  // Встреча в 00:30 +07 — день 27.09 по ответу (в браузере UTC — 26.09): даты нет.
  expect(rowOf('Встреча')).not.toHaveTextContent('сент.');
});

test('закрытые — по closedIds сервера, независимо от проекции', async () => {
  renderFeed(TEXT, groupsResult());
  await screen.findAllByTestId('day-group');
  // Проекция «inbox», сервер — закрыта: зачёркнута.
  expect(screen.getByText('Отчёт')).toHaveClass('line-through');
  // Проекция «done», сервера нет: не зачёркнута.
  expect(screen.getByText('T7')).not.toHaveClass('line-through');
  expect(screen.getByText('Встреча')).not.toHaveClass('line-through');
});

test('compact: время слева и зачёркивание — у заголовка; строка открывает запись', async () => {
  renderFeed(COMPACT, groupsResult());
  await screen.findAllByTestId('day-group');
  expect(within(rowOf('Отчёт')).getByTestId('qb-time')).toHaveTextContent('сделано 23:40');
  expect(screen.getByText('Отчёт')).toHaveClass('line-through');
  expect(screen.getByText('T7')).not.toHaveClass('line-through');
  fireEvent.click(within(rowOf('T9')).getByRole('button'));
  expect(topAddress()).toEqual(recordAddress(ID.t9));
});

test('«ещё N» — после последней группы; раскрытие поднимает limit блока', async () => {
  const seen: (number | undefined)[] = [];
  renderWithProviders(
    <BodyKindProvider kind="page">
      <DataBlock text={TEXT} />
    </BodyKindProvider>,
    handler({
      [TEXT]: (b) => {
        seen.push(b.limit);
        return groupsResult(b.limit === undefined ? 3 : 0);
      },
    }),
  );
  const groups = await screen.findAllByTestId('day-group');
  const more = screen.getByRole('button', { name: 'ещё 3' });
  const last = groups[groups.length - 1] as HTMLElement;
  expect(last.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(last.contains(more)).toBe(false);
  expect(screen.getByTestId('qb-count')).toHaveTextContent('8');
  fireEvent.click(more);
  await waitFor(() => expect(seen).toEqual([undefined, 8]));
  await waitFor(() => expect(screen.queryByRole('button', { name: /^ещё/ })).toBeNull());
});

test('первый кадр — скелетон чанка ленты, не пустота', async () => {
  let release = () => {};
  chunk.gate = new Promise<void>((r) => {
    release = r;
  });
  renderFeed(TEXT, groupsResult());
  // Данные приехали, чанк ленты ещё едет: на месте ленты — скелетон, карточка со счётчиком уже есть.
  expect(await screen.findByTestId('day-groups-loading')).toBeInTheDocument();
  expect(screen.getByTestId('qb-count')).toHaveTextContent('5');
  expect(screen.queryByTestId('day-group')).toBeNull();
  await waitFor(() => expect(chunk.attempts).toBe(1));
  await act(async () => release());
  expect(await screen.findAllByTestId('day-group')).toHaveLength(4);
  expect(screen.queryByTestId('day-groups-loading')).toBeNull();
});

test('hide_empty: группы без строк (только «свободно») — блок скрыт', async () => {
  const text = `${TEXT}, hide_empty`;
  const { container } = renderFeed(text, {
    ok: true,
    kind: 'groups',
    groups: [
      { day: '2026-09-27', rows: [] },
      { day: '2026-09-28', rows: [] },
    ],
    more: 0,
    closedIds: [],
  });
  await waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
  expect(screen.queryByTestId('day-group')).toBeNull();
});
