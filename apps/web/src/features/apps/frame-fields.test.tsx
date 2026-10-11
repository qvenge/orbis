import { APP_ASPECT, SUPPLY_ASPECT, SUPPLY_KEY, SUPPLY_TEXT } from '@orbis/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, expect, test } from 'vitest';
import { invalidateGraph } from '../../lib/invalidate';
import { resetNavForTests, useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders, wireEntity } from '../../test/harness';
import { trpc } from '../../trpc';
import { DropdownMenu } from '../../ui/DropdownMenu';
import type { WireEntity } from '../entity-detail/record-host';
import { shellRevertPlan } from '../supply/revert-shell';
import { canRevert, supplyNoteOf, useFrameMenu } from './frame-menu';
import { APPS_QUERY } from './useApps';

const A = '00000000-0000-4000-8000-000000001501';
const B = '00000000-0000-4000-8000-000000001502';
const BODY = 'Настоящий текст страницы поставки.';
const pageApp = (id = A, title = 'Записи'): WireEntity =>
  wireEntity({
    id,
    title,
    body: BODY,
    aspects: ['orbis/page', SUPPLY_ASPECT, APP_ASPECT],
    // Печать страницы: known records выбирает page раньше навешенного APP_ASPECT.
    props: {
      [SUPPLY_KEY]: 'records',
      [SUPPLY_TEXT]: `{"emoji":null,"title":"${title}"}\n\n${BODY}`,
    },
  });
const light = (row: WireEntity): WireEntity => {
  const { body: _body, ...rest } = row;
  return rest;
};
const read = (row: WireEntity) => ({
  entity: { ...row, bodyRevision: 1, bodyChangedAt: row.updatedAt },
  registryVersion: 1,
});
function active(id: string): void {
  useNav.setState({ model: { ...useNav.getState().model, activeApp: id } });
}
beforeEach(() => resetNavForTests());

// Настоящие hook, query cache, tRPC link и DropdownMenu; подменяется только сеть.
function FrameMenu() {
  const menu = useFrameMenu();
  const anchor = useRef<HTMLButtonElement>(null);
  const utils = trpc.useUtils();
  return (
    <>
      <button type="button" id="frame-trigger" ref={anchor}>
        Меню рамки
      </button>
      <button type="button" onClick={() => invalidateGraph(utils)}>
        Перечитать граф
      </button>
      <DropdownMenu
        sections={menu.sections}
        open
        onOpenChange={() => {}}
        anchorRef={anchor}
        triggerId="frame-trigger"
        contentId="frame-menu"
      />
      {menu.element}
    </>
  );
}
function network(rows: WireEntity[], get: (id: string) => unknown | Promise<unknown>): MockHandler {
  return (path, input) => {
    if (path === 'entity.query') {
      expect(input).toEqual({ query: APPS_QUERY });
      return rows.map(light);
    }
    if (path === 'entity.get') {
      const request = input as { id: string; include?: string[] };
      expect(request.include).toEqual(['body']);
      return get(request.id);
    }
    throw new Error(`неожиданный запрос ${path}`);
  };
}
const group = (title = 'Записи') => screen.getByRole('group', { name: `Приложение «${title}»` });
function noFakeStatus(title = 'Записи'): void {
  expect(within(group(title)).queryByTestId('menu-note')).toBeNull();
  expect(within(group(title)).queryByRole('menuitem', { name: 'Вернуть как было' })).toBeNull();
}

test('mixed-kind рамка читает body одной записи; пока ответа нет статус не придумывается', async () => {
  active(A);
  let release!: (v: unknown) => void;
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  const row = pageApp();
  const { calls } = renderWithProviders(
    <FrameMenu />,
    network([row], () => delayed),
  );
  await screen.findByRole('group', { name: 'Приложение «Записи»' });
  noFakeStatus();
  expect(supplyNoteOf(light(row))).toBeUndefined();
  expect(canRevert(light(row))).toBe(false);
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'entity.get')).toEqual([
      { path: 'entity.get', input: { id: A, include: ['body'] } },
    ]),
  );
  // Метаданные full-ответа могли быть старее списка: из чтения берётся лишь тело своего id.
  await act(async () => release(read({ ...row, title: 'Старое имя', props: {} })));
  expect(await within(group()).findByText('Как в поставке')).toBeInTheDocument();
  expect(within(group()).queryByText('Изменено вами')).toBeNull();
  expect(shellRevertPlan(row.props)).toBeNull();
  expect(within(group()).queryByRole('menuitem', { name: 'Вернуть как было' })).toBeNull();
});

test('отказ чтения тела не превращает mixed-kind рамку в «Изменено вами»', async () => {
  active(A);
  let reject!: (e: Error) => void;
  const delayed = new Promise((_resolve, r) => {
    reject = r;
  });
  const { calls } = renderWithProviders(
    <FrameMenu />,
    network([pageApp()], () => delayed),
  );
  await waitFor(() => expect(calls.some((c) => c.path === 'entity.get')).toBe(true));
  await act(async () => reject(new Error('нет сети')));
  noFakeStatus();
});

test.each([
  ['host-shell', [APP_ASPECT, SUPPLY_ASPECT], true],
  ['upcoming', [APP_ASPECT, SUPPLY_ASPECT], true],
  ['future-app', [APP_ASPECT, SUPPLY_ASPECT], true],
  ['records', [APP_ASPECT], false],
] as const)('app %s без page-печати не дочитывает body', async (key, aspects, note) => {
  active(A);
  const row = wireEntity({
    id: A,
    title: 'Приложение',
    aspects: [...aspects],
    props: {
      [SUPPLY_KEY]: key,
      [SUPPLY_TEXT]: '{\n  "emoji": null,\n  "props": {},\n  "title": "Приложение"\n}',
    },
  });
  const { calls } = renderWithProviders(
    <FrameMenu />,
    network([row], () => {
      throw new Error('лишнее чтение body');
    }),
  );
  const section = await screen.findByRole('group', { name: 'Приложение «Приложение»' });
  if (note) expect(within(section).getByText('Как в поставке')).toBeInTheDocument();
  else expect(within(section).queryByTestId('menu-note')).toBeNull();
  expect(calls.filter((c) => c.path === 'entity.get')).toEqual([]);
});

test('переключение рамки: позднее тело A не подменяет B; возврат использует cache своего id', async () => {
  active(A);
  const a = pageApp();
  const b = pageApp(B, 'Другая рамка');
  let releaseA!: (v: unknown) => void;
  let releaseB!: (v: unknown) => void;
  const pa = new Promise((r) => {
    releaseA = r;
  });
  const pb = new Promise((r) => {
    releaseB = r;
  });
  const { calls } = renderWithProviders(
    <FrameMenu />,
    network([a, b], (id) => (id === A ? pa : pb)),
    { queries: { staleTime: 30_000 } },
  );
  await waitFor(() => expect(calls.some((c) => c.path === 'entity.get')).toBe(true));
  act(() => active(B));
  await screen.findByRole('group', { name: 'Приложение «Другая рамка»' });
  noFakeStatus('Другая рамка');
  await act(async () => releaseB(read({ ...b, body: 'Текст изменён владельцем.' })));
  expect(await within(group('Другая рамка')).findByText('Изменено вами')).toBeInTheDocument();
  await act(async () => releaseA(read(a)));
  expect(within(group('Другая рамка')).getByText('Изменено вами')).toBeInTheDocument();
  expect(within(group('Другая рамка')).queryByText('Как в поставке')).toBeNull();
  // Page-print по-прежнему не является shell rollback plan, даже когда текст действительно правлен.
  expect(
    within(group('Другая рамка')).queryByRole('menuitem', { name: 'Вернуть как было' }),
  ).toBeNull();
  act(() => active(A));
  expect(await within(group()).findByText('Как в поставке')).toBeInTheDocument();
  expect(calls.filter((c) => c.path === 'entity.get')).toEqual([
    { path: 'entity.get', input: { id: A, include: ['body'] } },
    { path: 'entity.get', input: { id: B, include: ['body'] } },
  ]);
});

test('invalidateGraph перечитывает single body key вместе с лёгким списком', async () => {
  active(A);
  const row = pageApp();
  let body = BODY;
  const { calls } = renderWithProviders(
    <FrameMenu />,
    network([row], () => read({ ...row, body })),
    { queries: { staleTime: 30_000 } },
  );
  expect(await screen.findByText('Как в поставке')).toBeInTheDocument();
  body = 'Владелец изменил текст.';
  fireEvent.click(screen.getByRole('button', { name: 'Перечитать граф', hidden: true }));
  expect(await screen.findByText('Изменено вами')).toBeInTheDocument();
  expect(calls.filter((c) => c.path === 'entity.get')).toEqual([
    { path: 'entity.get', input: { id: A, include: ['body'] } },
    { path: 'entity.get', input: { id: A, include: ['body'] } },
  ]);
});
