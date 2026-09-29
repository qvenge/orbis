/**
 * Повестка с НАСТОЯЩИМ эталоном (срез 1в §6.1; Fable M-1 задачи 9): тело `etalonOf('agenda').text` —
 * параметр горизонта и три блока (`{{param}}` и `group=day` в одном теле) — открывается экраном записи
 * так, как её откроет человек: переключатель на месте параметра, «Просрочено», лента по дням, «Дальше»;
 * все три блока — одной пачкой с умолчанием параметра; «14 дней» — вторая пачка с новым значением.
 */

import type { BlockResult } from '@orbis/shared';
import { PAGE_ASPECT, SUPPLY_ASPECT, SUPPLY_KEY } from '@orbis/shared';
import { parsePageText } from '@orbis/shared/doc/page-grammar';
import { type Address, currentEntry, HOST_APP } from '@orbis/shared/nav';
import { AGENDA_BODY, etalonOf } from '@orbis/shared/supply';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import {
  BLOCKS_TODAY,
  blocksReply,
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  wireEntity,
} from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { queryClient } from '../../trpc';
import { DetailScreen } from '../entity-detail/DetailScreen';
import { structureHandler } from '../entity-detail/structure-fixtures';

installCrashTrap();

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('requestIdleCallback', () => 1);
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
});

afterEach(() => {
  vi.unstubAllGlobals();
  useNav.setState({ mode: 'site' });
});

const id = (n: number) => `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`;
const AGENDA_ID = id(1);

const etalon = (() => {
  const e = etalonOf('agenda');
  if (e.kind === 'app') throw new Error('Повестка — не страница');
  return e;
})();

const [OVERDUE, FEED, LATER] = parsePageText(etalon.text).flatMap((n) =>
  n.kind === 'query' ? [n.text.trim()] : [],
) as [string, string, string];

const overdueTask = wireEntity({ id: id(10), title: 'Просроченный отчёт' });
const meeting = wireEntity({ id: id(11), title: 'Созвон' });
const laterTask = wireEntity({ id: id(12), title: 'Продлить страховку' });
const twoWeeks = wireEntity({ id: id(13), title: 'Через десять дней' });

/** Лента — по значению периода: так видно, какое значение посчитал «сервер». */
const feed = (b: { params?: Record<string, string> }): BlockResult => ({
  ok: true,
  kind: 'groups',
  groups: [
    {
      day: BLOCKS_TODAY,
      rows: [
        {
          entity: meeting as never,
          at: {
            slot: 'moment',
            value: '2026-09-27T03:00:00.000Z',
            end: null,
            allDay: false,
            untimed: false,
          },
        },
      ],
    },
    ...(b.params?.period === 'next_14d'
      ? [
          {
            day: '2026-10-07',
            rows: [
              {
                entity: twoWeeks as never,
                at: {
                  slot: 'deadline' as const,
                  value: '2026-10-07',
                  end: null,
                  allDay: false,
                  untimed: true,
                },
              },
            ],
          },
        ]
      : []),
  ],
  more: 0,
  closedIds: [],
});

function Top() {
  const a = useNav((s) => currentEntry(s.model).address);
  return a.kind === 'record' ? <DetailScreen entityId={a.id} /> : <div />;
}

type Item = { text: string; params?: Record<string, string> };
const batches = (calls: { path: string; input: unknown }[]): Item[][] =>
  calls
    .filter((c) => c.path === 'entity.blocks')
    .map((c) => (c.input as { blocks: Item[] }).blocks.filter((b) => 'text' in b));

function openAgenda() {
  const page = wireEntity({
    id: AGENDA_ID,
    title: etalon.title,
    emoji: etalon.emoji,
    body: etalon.text,
    aspects: [PAGE_ASPECT, SUPPLY_ASPECT],
    props: { [SUPPLY_KEY]: 'agenda' },
  });
  const address: Address = { kind: 'record', app: { kind: 'host' }, id: AGENDA_ID };
  useNav.setState({
    model: {
      activeApp: HOST_APP,
      apps: {
        [HOST_APP]: {
          activeSection: AGENDA_ID,
          stacks: { [AGENDA_ID]: [{ address }] },
        },
      },
    },
    overlay: null,
    mode: 'app',
  });
  const screenHandler = structureHandler({ name: 'page', entity: page, extra: {} });
  const blocks = blocksReply({ [OVERDUE]: [overdueTask], [FEED]: feed, [LATER]: [laterTask] });
  const handler: MockHandler = (path, input) => blocks(path, input) ?? screenHandler(path, input);
  return renderWithProviders(<Top />, handler, {
    queries: queryClient.getDefaultOptions().queries,
  });
}

test('эталон — тело Повестки поставки', () => {
  expect(etalon.text).toBe(AGENDA_BODY);
  expect([OVERDUE, FEED, LATER].every((t) => t.length > 0)).toBe(true);
});

test('Повестка на эталоне: переключатель горизонта, «Просрочено», лента по дням, «Дальше» — одной пачкой с умолчанием', async () => {
  const { calls } = openAgenda();
  expect(await screen.findByText('Просроченный отчёт')).toBeInTheDocument();
  expect(await screen.findByText('Созвон')).toBeInTheDocument();
  expect(await screen.findByText('Продлить страховку')).toBeInTheDocument();
  // Лента — группами по дням, а не строками.
  const headers = await screen.findAllByTestId('day-group-header');
  expect(headers[0]).toHaveTextContent('Сегодня');
  // Переключатель — на месте блока параметра, варианты — только от сегодня.
  const group = await screen.findByRole('radiogroup', { name: 'Горизонт' });
  expect(within(group).getAllByRole('radio')).toHaveLength(2);
  expect(within(group).getByRole('radio', { name: '7 дней' })).toBeChecked();
  expect(within(group).getByRole('radio', { name: '14 дней' })).not.toBeChecked();
  // Три блока — ОДНОЙ пачкой; значение умолчания — только у блоков, ссылающихся на параметр.
  const sent = batches(calls);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.map((b) => [b.text.trim(), b.params])).toEqual([
    [OVERDUE, undefined],
    [FEED, { period: 'next_7d' }],
    [LATER, { period: 'next_7d' }],
  ]);
});

test('«14 дней» — вторая пачка со значением next_14d, лента растёт', async () => {
  const { calls } = openAgenda();
  await screen.findByText('Созвон');
  const group = await screen.findByRole('radiogroup', { name: 'Горизонт' });
  fireEvent.click(within(group).getByRole('radio', { name: '14 дней' }));
  expect(await screen.findByText('Через десять дней')).toBeInTheDocument();
  await waitFor(() => expect(batches(calls).length).toBeGreaterThanOrEqual(2));
  const last = batches(calls).at(-1) ?? [];
  expect(last.filter((b) => b.params !== undefined).map((b) => b.params?.period)).toEqual([
    'next_14d',
    'next_14d',
  ]);
});
