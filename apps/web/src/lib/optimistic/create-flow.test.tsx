import { parsePageText } from '@orbis/shared/doc/page-grammar';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HostButtons } from '../../app/frame/HostButtons';
import { installHistory, startNavigation } from '../../app/history';
import { ActiveScreen } from '../../app/router';
import { QuickCapture } from '../../features/browser/QuickCapture';
import { RecordsBlock } from '../../features/browser/RecordsBlock';
import { Blockers } from '../../features/entity-detail/Blockers';
// Load the real lazy screen before tests so a slow module transform cannot consume an interaction budget.
import '../../features/entity-detail/DetailScreen';
import { detailGetInput } from '../../features/entity-detail/useEntityDetail';
import { Renderer } from '../../features/page/Renderer';
import { resetUndoSession } from '../../features/undo/undo-epoch';
import { peekUndoable } from '../../features/undo/undo-stack';
import { resetNavForTests, useNav } from '../../state/navigation';
import { testFreshnessOf } from '../../test/freshness';
import { queryReply, renderWithProviders, trpcError, wireEntity } from '../../test/harness';
import { navAt } from '../../test/nav';
import { registryReply } from '../../test/registry';
import { trpc } from '../../trpc';
import { Toaster } from '../../ui/Toast';

let uninstall: (() => void) | undefined;
beforeEach(() => {
  resetNavForTests();
  resetUndoSession();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  startNavigation();
  uninstall = installHistory();
});
afterEach(() => uninstall?.());

function submitCapture(title: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Быстрая запись' }), {
    target: { value: title },
  });
  fireEvent.submit(screen.getByTestId('quick-capture-form'));
}

test('opens an in-flight capture without reading it and returns on server refusal', async () => {
  let rejectCreate: ((error: unknown) => void) | undefined;
  const { calls } = renderWithProviders(
    <>
      <QuickCapture context={{ kind: 'root' }} />
      <ActiveScreen />
      <Toaster />
    </>,
    (path) => {
      if (path === 'entity.create')
        return new Promise((_resolve, reject) => {
          rejectCreate = reject;
        });
      return {};
    },
    { freshness: true },
  );
  const before = window.location.href;
  const historyLength = window.history.length;
  const historyState = window.history.state;
  submitCapture('Новая запись');
  const row = await screen.findByRole('button', { name: 'Новая запись' });
  const id = (
    calls.find((call) => call.path === 'entity.create')?.input as { input: { id: string } }
  ).input.id;
  fireEvent.click(row);
  await screen.findByRole('heading', { name: 'Новая запись' });
  expect(window.location.href).toBe(before);
  expect(window.history.length).toBe(historyLength);
  expect(window.history.state).toEqual(historyState);
  expect(JSON.stringify(localStorage)).not.toContain(id);
  expect(
    calls.some((call) => {
      const input = call.input as { id?: string; ids?: string[] } | null;
      return input?.id === id || input?.ids?.includes(id);
    }),
  ).toBe(false);

  await act(async () => rejectCreate?.(trpcError('BAD_REQUEST', 'Сервер отклонил создание')));
  expect((await screen.findAllByText('Сервер отклонил создание')).length).toBeGreaterThan(0);
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Новая запись' })).toBeNull());
  expect(calls.filter((call) => call.path === 'entity.create')).toHaveLength(1);
  expect(window.location.href).toBe(before);
});

test.each([
  false,
  true,
])('recovers a lost ACK with the original UUID after remount (new edit=%s)', async (newEdit) => {
  let ack: (() => void) | undefined;
  const requests: { input: { id: string; title: string }; source: string }[] = [];
  const stored = new Map<string, ReturnType<typeof wireEntity>>();
  const actionId = '019e4466-1000-7e07-b5d4-64be9721da58';
  const parentId = '019e4466-1000-7e07-b5d4-64be9721da59';
  function Host() {
    const [visible, setVisible] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setVisible(!visible)}>
          Переключить форму
        </button>
        {visible && <QuickCapture context={{ kind: 'entity', parentId }} />}
      </>
    );
  }
  const { queryClient } = renderWithProviders(
    <Host />,
    (path, input) => {
      if (path !== 'entity.create') return {};
      const command = input as (typeof requests)[number];
      requests.push(command);
      const { id, title } = command.input;
      if (!stored.has(id)) stored.set(id, wireEntity({ id, title, graphId: 'owner' }));
      if (requests.length === 1) throw trpcError('INTERNAL_SERVER_ERROR');
      return new Promise((resolve) => {
        ack = () => resolve({ ...stored.get(id), actionId, consequences: false });
      });
    },
    { freshness: true },
  );
  submitCapture('Восстановить запись');
  await screen.findByRole('button', { name: 'Повторить сохранение' });
  act(() => testFreshnessOf(queryClient).reset());
  fireEvent.click(screen.getByRole('button', { name: 'Переключить форму' }));
  expect(screen.queryByRole('textbox', { name: 'Быстрая запись' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Переключить форму' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Быстрая запись' }), {
    target: { value: ' Восстановить запись ' },
  });
  expect(screen.getByRole('button', { name: 'Добавить' })).toBeDisabled();
  fireEvent.click(await screen.findByRole('button', { name: 'Повторить сохранение' }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toEqual(requests[0]);
  if (newEdit)
    fireEvent.change(screen.getByRole('textbox', { name: 'Быстрая запись' }), {
      target: { value: 'Следующий черновик' },
    });
  await act(async () => ack?.());
  expect(stored.size).toBe(1);
  expect(requests[0]).toMatchObject({ link: { parentId, role: 'subitem' } });
  await waitFor(() => expect(peekUndoable()?.actionId).toBe(actionId));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Повторить сохранение' })).toBeNull(),
  );
  expect(screen.getByRole('textbox', { name: 'Быстрая запись' })).toHaveValue(
    newEdit ? 'Следующий черновик' : '',
  );
  if (!newEdit) {
    fireEvent.submit(screen.getByTestId('quick-capture-form'));
    expect(requests).toHaveLength(2);
  }
});

test.each([
  false,
  true,
])('ACK opens the final UUID once only while pending is still current (back=%s)', async (back) => {
  let resolveCreate: ((value: unknown) => void) | undefined;
  let id = '';
  const push = vi.spyOn(window.history, 'pushState');
  try {
    const { calls } = renderWithProviders(
      <>
        <QuickCapture context={{ kind: 'root' }} />
        <ActiveScreen />
      </>,
      (path, input) => {
        if (path === 'entity.create') {
          id = (input as { input: { id: string } }).input.id;
          return new Promise((resolve) => {
            resolveCreate = resolve;
          });
        }
        if (path === 'entity.get')
          return {
            entity: wireEntity({ id: (input as { id: string }).id, title: 'Подтверждённая' }),
            relations: [],
          };
        return {};
      },
      { freshness: true },
    );
    submitCapture('Ожидающая');
    fireEvent.click(await screen.findByRole('button', { name: 'Ожидающая' }));
    await screen.findByRole('heading', { name: 'Ожидающая' });
    expect(push).not.toHaveBeenCalled();
    expect(
      calls.some((c) => c.path === 'entity.get' && (c.input as { id: string }).id === id),
    ).toBe(false);
    if (back) {
      act(() => useNav.getState().back());
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Ожидающая' })).toBeNull());
    }
    await act(async () =>
      resolveCreate?.(wireEntity({ id, title: 'Подтверждённая', graphId: 'owner' })),
    );
    if (back) {
      expect(await screen.findByRole('link', { name: 'Подтверждённая' })).toHaveAttribute(
        'href',
        `/r/${id}`,
      );
      expect(push).not.toHaveBeenCalled();
      expect(
        calls.some((c) => c.path === 'entity.get' && (c.input as { id: string }).id === id),
      ).toBe(false);
    } else {
      await waitFor(() =>
        expect(
          calls.some((c) => c.path === 'entity.get' && (c.input as { id: string }).id === id),
        ).toBe(true),
      );
      expect(push).toHaveBeenCalledTimes(1);
      expect(window.location.pathname).toContain(id);
    }
  } finally {
    push.mockRestore();
  }
});

test('feed before ACK yields one placement and keeps the accepted row rather than replay data', async () => {
  let resolveCreate: ((value: unknown) => void) | undefined;
  let id = '';
  let visible = false;
  const { queryClient } = renderWithProviders(
    <RecordsBlock onOpen={() => {}} />,
    (path, input) => {
      if (path === 'entity.query')
        return queryReply(visible ? [wireEntity({ id, title: 'Позднее имя' })] : []);
      if (path === 'entity.create') {
        id = (input as { input: { id: string } }).input.id;
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      return {};
    },
    { freshness: true },
  );
  await screen.findByText('Здесь появятся ваши записи');
  submitCapture('До ответа');
  await screen.findByRole('button', { name: 'До ответа' });
  visible = true;
  act(() =>
    testFreshnessOf(queryClient).changes([{ kind: 'entity', rowKey: id, operation: 'insert' }]),
  );
  await waitFor(() =>
    expect(
      queryClient
        .getQueriesData({ queryKey: [['entity', 'query']] })
        .some(([, data]) =>
          (data as { rows?: { id: string }[] } | undefined)?.rows?.some((row) => row.id === id),
        ),
    ).toBe(true),
  );
  expect(screen.queryByText('Позднее имя')).toBeNull();
  expect(screen.getAllByRole('button', { name: 'До ответа' })).toHaveLength(1);
  await act(async () =>
    resolveCreate?.(wireEntity({ id, title: 'Старый ответ', graphId: 'owner' })),
  );
  await screen.findByText('Позднее имя');
  expect(screen.queryByText('Старый ответ')).toBeNull();
  expect(screen.queryByText('Создаётся…')).toBeNull();
});

test('confirmed Undo retires the scoped create row before an unrelated refresh', async () => {
  const action = '019e4466-1000-7e07-b5d4-64be9721da54';
  const { calls } = renderWithProviders(
    <>
      <QuickCapture context={{ kind: 'root' }} />
      <Toaster />
    </>,
    (path, input) => {
      if (path === 'entity.create') {
        const { id, title } = (input as { input: { id: string; title: string } }).input;
        return {
          ...wireEntity({ id, title, graphId: 'owner' }),
          actionId: action,
          consequences: false,
        };
      }
      if (path === 'ai.undo')
        return {
          actionId: 'undo',
          undone: { id: action, title: 'С Undo' },
          pinnedVersions: [],
          bodyRevisions: [],
        };
      return {};
    },
    { freshness: true },
  );
  submitCapture('С Undo');
  await screen.findByRole('button', { name: 'С Undo' });
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'С Undo' })).toBeNull());
  expect(calls.filter((c) => c.path === 'ai.undo').map((c) => c.input)).toEqual([
    { actionId: action },
  ]);
});

test.each([
  'FORBIDDEN',
  'INTERNAL_SERVER_ERROR',
])('blocker removal restores both endpoints and keeps its controls when outcome is %s', async (code) => {
  const a = '019e4466-1000-7e07-b5d4-64be9721da55';
  const b = '019e4466-1000-7e07-b5d4-64be9721da56';
  const wire = {
    id: '019e4466-1000-7e07-b5d4-64be9721da57',
    sourceId: a,
    targetId: b,
    role: 'dependency',
    meta: {},
    createdAt: '2026-11-03T12:00:00Z',
    updatedAt: '2026-11-03T12:00:00Z',
  };
  let rejectDelete: ((error: unknown) => void) | undefined;
  function Endpoint({ id }: { id: string }) {
    const query = trpc.entity.get.useQuery(detailGetInput(id));
    return (
      <section aria-label={id}>
        <Blockers entityId={id} relations={query.data?.relations ?? []} />
      </section>
    );
  }
  const { calls } = renderWithProviders(
    <>
      <Endpoint id={a} />
      <Endpoint id={b} />
    </>,
    (path, input) => {
      if (path === 'entity.get') {
        const { id } = input as { id: string };
        return { entity: wireEntity({ id, title: id }), relations: [wire] };
      }
      if (path === 'entity.resolveRefs') return [];
      if (path === 'relation.delete')
        return new Promise((_resolve, reject) => {
          rejectDelete = reject;
        });
      return {};
    },
    { freshness: true },
  );
  const first = within(screen.getByRole('region', { name: a }));
  const second = within(screen.getByRole('region', { name: b }));
  await first.findByTestId('block-row');
  await second.findByTestId('block-row');
  fireEvent.click(first.getByRole('button', { name: 'Снять блокировку' }));
  fireEvent.click(first.getByRole('button', { name: 'Снять' }));
  await waitFor(() => expect(screen.queryAllByTestId('block-row')).toHaveLength(0));
  await act(async () => rejectDelete?.(trpcError(code, 'Снять связь нельзя')));
  if (code === 'FORBIDDEN') {
    await first.findByText('Снять связь нельзя');
  } else {
    const check = await first.findByRole('button', { name: 'Проверить состояние' });
    const count = () =>
      calls.filter((call) => call.path === 'entity.get' && (call.input as { id: string }).id === a)
        .length;
    const before = count();
    fireEvent.click(check);
    await waitFor(() =>
      expect(first.queryByRole('button', { name: 'Проверить состояние' })).toBeNull(),
    );
    expect(count()).toBeGreaterThan(before);
  }
  expect(first.getByRole('button', { name: 'Снять' })).toBeInTheDocument();
  expect(second.getByTestId('block-row')).toBeInTheDocument();
  expect(calls.filter((c) => c.path === 'relation.delete').map((c) => c.input)).toEqual([
    { source_id: a, target_id: b, role: 'dependency' },
  ]);
});

test('offline capture keeps the draft without starting a mutation or creating a row', async () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  try {
    const { calls } = renderWithProviders(
      <>
        <QuickCapture context={{ kind: 'root' }} />
        <Toaster />
      </>,
      () => ({}),
      { freshness: true },
    );
    submitCapture('Только черновик');
    await screen.findByText('Нет сети');
    expect(screen.getByRole('textbox', { name: 'Быстрая запись' })).toHaveValue('Только черновик');
    expect(screen.queryByRole('button', { name: 'Только черновик' })).toBeNull();
    expect(calls.some((call) => call.path === 'entity.create')).toBe(false);
  } finally {
    online.mockRestore();
  }
});

test('a previous runtime cannot open the confirmed record or offer Undo after it is disposed', async () => {
  let resolveCreate: ((value: unknown) => void) | undefined;
  let id = '';
  const { calls, queryClient } = renderWithProviders(
    <>
      <QuickCapture context={{ kind: 'root' }} />
      <ActiveScreen />
      <Toaster />
    </>,
    (path, input) => {
      if (path !== 'entity.create') return {};
      id = (input as { input: { id: string } }).input.id;
      return new Promise((resolve) => {
        resolveCreate = resolve;
      });
    },
    { freshness: true },
  );
  submitCapture('Прежний сеанс');
  fireEvent.click(await screen.findByRole('button', { name: 'Прежний сеанс' }));
  await screen.findByRole('heading', { name: 'Прежний сеанс' });
  act(() => {
    testFreshnessOf(queryClient).runtime.dispose();
    resetUndoSession();
    resetNavForTests();
  });
  await act(async () =>
    resolveCreate?.({
      ...wireEntity({ id, title: 'Прежний сеанс', graphId: 'owner' }),
      actionId: 'stale-action',
      consequences: false,
    }),
  );
  expect(useNav.getState().pendingCreate).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Прежний сеанс' })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Быстрая запись' })).toHaveValue('');
  expect(peekUndoable()).toBeUndefined();
  expect(
    calls.some((call) => call.path === 'entity.get' && (call.input as { id: string }).id === id),
  ).toBe(false);
});

test('system Back in app mode closes only the transient create screen', async () => {
  act(() => useNav.setState({ mode: 'app' }));
  const before = useNav.getState().model;
  let id = '';
  renderWithProviders(
    <>
      <QuickCapture context={{ kind: 'root' }} />
      <ActiveScreen />
    </>,
    (path, input) => {
      if (path !== 'entity.create') return {};
      id = (input as { input: { id: string } }).input.id;
      return new Promise(() => {});
    },
    { freshness: true },
  );
  submitCapture('Временный экран');
  fireEvent.click(await screen.findByRole('button', { name: 'Временный экран' }));
  await screen.findByRole('heading', { name: 'Временный экран' });
  act(() => window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state })));
  expect(useNav.getState().pendingCreate).toBeNull();
  expect(useNav.getState().model).toBe(before);
  expect(JSON.stringify(window.history.state)).not.toContain(id);
  expect(screen.queryByRole('heading', { name: 'Временный экран' })).toBeNull();
});

test('a retry started on the pending screen clears its original draft after Back', async () => {
  let resolveCreate: ((value: unknown) => void) | undefined;
  let id = '';
  let attempts = 0;
  const { calls } = renderWithProviders(
    <>
      <QuickCapture context={{ kind: 'root' }} />
      <ActiveScreen />
    </>,
    (path, input) => {
      if (path !== 'entity.create') return {};
      id = (input as { input: { id: string } }).input.id;
      if (++attempts === 1) throw trpcError('INTERNAL_SERVER_ERROR');
      return new Promise((resolve) => {
        resolveCreate = resolve;
      });
    },
    { freshness: true },
  );
  submitCapture('Исходный черновик');
  await screen.findByRole('button', { name: 'Повторить сохранение' });
  fireEvent.click(screen.getByRole('button', { name: 'Исходный черновик' }));
  const pending = within(screen.getByTestId('screen-content'));
  fireEvent.click(await pending.findByRole('button', { name: 'Повторить сохранение' }));
  await waitFor(() => expect(attempts).toBe(2));
  act(() => useNav.getState().back());
  await act(async () =>
    resolveCreate?.(wireEntity({ id, title: 'Исходный черновик', graphId: 'owner' })),
  );
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Быстрая запись' })).toHaveValue(''),
  );
  expect(
    calls.some((call) => call.path === 'entity.get' && (call.input as { id: string }).id === id),
  ).toBe(false);
});

function fillPopup(container: HTMLElement, title: string) {
  fireEvent.change(within(container).getByRole('textbox', { name: 'Быстрая запись' }), {
    target: { value: title },
  });
}
function submitPopup(container: HTMLElement) {
  fireEvent.click(within(container).getByRole('button', { name: 'Добавить' }));
}

test.each([
  ['unmodified', false, false],
  ['newer edit', true, false],
  ['older unknown intent', false, true],
] as const)('popup reopened before linked refusal retains the right draft (%s)', async (_scenario, newEdit, previousUnknown) => {
  let reject: (reason: unknown) => void = () => {};
  let attempts = 0;
  navAt(a);
  const { calls } = renderWithProviders(
    <>
      <HostButtons />
      <Endpoint id={a} />
    </>,
    (path) => {
      if (path === 'entity.get')
        return { entity: wireEntity({ id: a, title: 'Родитель' }), relations: [] };
      if (path === 'entity.create') {
        if (++attempts === 1 && previousUnknown) throw trpcError('INTERNAL_SERVER_ERROR');
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      }
      return {};
    },
    { freshness: true },
  );
  await waitFor(() => expect(calls.some((c) => c.path === 'entity.get')).toBe(true));
  const toggle = screen.getByTestId('host-new');
  fireEvent.click(toggle);
  let popup = screen.getByTestId('host-capture');
  if (previousUnknown) {
    fillPopup(popup, 'Предыдущий черновик');
    submitPopup(popup);
    await within(popup).findByRole('button', { name: 'Повторить сохранение' });
  }
  fillPopup(popup, 'Исправимый черновик');
  submitPopup(popup);
  await within(popup).findByText('Создаётся…');
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'entity.create').map((c) => c.input)).toEqual(
      Array.from({ length: previousUnknown ? 2 : 1 }, () =>
        expect.objectContaining({ link: { parentId: a, role: 'subitem' } }),
      ),
    ),
  );
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  popup = screen.getByTestId('host-capture');
  if (newEdit) fillPopup(popup, 'Новый черновик');
  await act(async () => reject(trpcError('BAD_REQUEST', 'Создание отклонено')));
  await within(popup).findByText('Создание отклонено');
  expect(within(popup).queryByRole('button', { name: 'Исправимый черновик' })).toBeNull();
  expect(within(popup).getByRole('textbox', { name: 'Быстрая запись' })).toHaveValue(
    newEdit ? 'Новый черновик' : 'Исправимый черновик',
  );
});

const a = '019e4466-1000-7e07-b5d4-64be9721da55';
const b = '019e4466-1000-7e07-b5d4-64be9721da56';
const edge = {
  id: '019e4466-1000-7e07-b5d4-64be9721da57',
  sourceId: a,
  targetId: b,
  role: 'dependency',
  meta: {},
  createdAt: '2026-11-03T12:00:00Z',
  updatedAt: '2026-11-03T12:00:00Z',
};

function Endpoint({ id }: { id: string }) {
  const query = trpc.entity.get.useQuery(detailGetInput(id));
  return (
    <section aria-label={id}>
      <Blockers entityId={id} relations={query.data?.relations ?? []} />
    </section>
  );
}

test('definitive relation rejection rechecks both raw endpoints even before the external feed arrives', async () => {
  const reads: string[] = [];
  let exists = true;
  const { calls } = renderWithProviders(
    <>
      <Endpoint id={a} />
      <Endpoint id={b} />
    </>,
    (path, input) => {
      if (path === 'entity.get') {
        const { id } = input as { id: string };
        reads.push(id);
        return { entity: wireEntity({ id, title: id }), relations: exists ? [edge] : [] };
      }
      if (path === 'entity.resolveRefs') return [];
      if (path === 'relation.delete') throw trpcError('NOT_FOUND', 'связь не найдена');
      return {};
    },
    { freshness: true },
  );
  const first = within(screen.getByRole('region', { name: a }));
  await waitFor(() => expect(screen.getAllByTestId('block-row')).toHaveLength(2));
  reads.length = 0;
  exists = false;
  fireEvent.click(first.getByRole('button', { name: 'Снять блокировку' }));
  fireEvent.click(first.getByRole('button', { name: 'Снять' }));
  await first.findByText('связь не найдена');
  expect(calls.filter((c) => c.path === 'relation.delete')).toHaveLength(1);
  await waitFor(() =>
    expect({
      reread: [...new Set(reads)].sort(),
      visible: screen.queryAllByTestId('block-row').length,
    }).toEqual({ reread: [a, b], visible: 0 }),
  );
});

test('offline removal preserves raw endpoints without sending or scheduling reconciliation', async () => {
  const { calls, queryClient } = renderWithProviders(
    <>
      <Endpoint id={a} />
      <Endpoint id={b} />
    </>,
    (path, input) => {
      if (path === 'entity.get') {
        const { id } = input as { id: string };
        return { entity: wireEntity({ id, title: id }), relations: [edge] };
      }
      if (path === 'entity.resolveRefs') return [];
      return {};
    },
    { freshness: true },
  );
  await waitFor(() => expect(screen.getAllByTestId('block-row')).toHaveLength(2));
  const first = within(screen.getByRole('region', { name: a }));
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  try {
    fireEvent.click(first.getByRole('button', { name: 'Снять блокировку' }));
    fireEvent.click(first.getByRole('button', { name: 'Снять' }));
    await first.findByText('Нет сети');
    expect(screen.getAllByTestId('block-row')).toHaveLength(2);
    expect(calls.filter((call) => call.path === 'relation.delete')).toHaveLength(0);
    expect(calls.filter((call) => call.path === 'entity.get')).toHaveLength(2);
    for (const id of [a, b])
      expect(
        queryClient.getQueryState(getQueryKey(trpc.entity.get, detailGetInput(id), 'query'))
          ?.isInvalidated,
      ).toBe(false);
  } finally {
    online.mockRestore();
  }
});

test('pending relation deletion overlays accepted data through an in-scope feed reset', async () => {
  const reads: string[] = [];
  let rejectDelete: (reason: unknown) => void = () => {};
  const { queryClient, calls } = renderWithProviders(
    <>
      <Endpoint id={a} />
      <Endpoint id={b} />
    </>,
    (path, input) => {
      if (path === 'entity.get') {
        const { id } = input as { id: string };
        reads.push(id);
        return { entity: wireEntity({ id, title: id }), relations: [edge] };
      }
      if (path === 'entity.resolveRefs') return [];
      if (path === 'relation.delete')
        return new Promise((_resolve, reject) => {
          rejectDelete = reject;
        });
      return {};
    },
    { freshness: true },
  );
  const first = within(screen.getByRole('region', { name: a }));
  await waitFor(() => expect(screen.getAllByTestId('block-row')).toHaveLength(2));
  fireEvent.click(first.getByRole('button', { name: 'Снять блокировку' }));
  fireEvent.click(first.getByRole('button', { name: 'Снять' }));
  await waitFor(() => expect(screen.queryAllByTestId('block-row')).toHaveLength(0));
  await first.findByText('Снимается…');
  reads.length = 0;
  act(() => testFreshnessOf(queryClient).reset());
  await waitFor(() => expect([...new Set(reads)].sort()).toEqual([a, b]));
  expect(calls.filter((c) => c.path === 'relation.delete')).toHaveLength(1);
  expect(first.getByText('Снимается…')).toBeInTheDocument();
  const inFlightRows = screen.queryAllByTestId('block-row').length;
  await act(async () => rejectDelete(trpcError('FORBIDDEN', 'Нельзя снять')));
  await first.findByText('Нельзя снять');
  expect(screen.queryAllByTestId('block-row')).toHaveLength(2);
  expect(inFlightRows).toBe(0);
});

test('late parent classification in real host popup retains the original pending attempt and explicit retry', async () => {
  navAt(a);
  let acceptParent: (value: unknown) => void = () => {};
  const committed = new Set<string>();
  let rejectCreate: (reason: unknown) => void = () => {};
  const { calls } = renderWithProviders(
    <>
      <HostButtons />
      <Endpoint id={a} />
    </>,
    (path, input) => {
      if (path === 'entity.get')
        return new Promise((resolve) => {
          acceptParent = resolve;
        });
      if (path === 'entity.create') {
        committed.add((input as { input: { id: string } }).input.id);
        return new Promise((_resolve, reject) => {
          rejectCreate = reject;
        });
      }
      return {};
    },
    { freshness: true },
  );
  await waitFor(() => expect(calls.some((c) => c.path === 'entity.get')).toBe(true));
  fireEvent.click(screen.getByTestId('host-new'));
  const popup = within(screen.getByTestId('host-capture'));
  fireEvent.change(popup.getByRole('textbox', { name: 'Быстрая запись' }), {
    target: { value: 'Сохранение при загрузке контекста' },
  });
  fireEvent.click(popup.getByRole('button', { name: 'Добавить' }));
  await popup.findByText('Создаётся…');
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.create')).toHaveLength(1));
  expect(calls.find((c) => c.path === 'entity.create')?.input).not.toHaveProperty('link');
  await act(async () =>
    acceptParent({ entity: wireEntity({ id: a, title: 'Родитель' }), relations: [] }),
  );
  await act(async () => rejectCreate(trpcError('INTERNAL_SERVER_ERROR')));
  expect(popup.getByRole('button', { name: 'Повторить сохранение' })).toBeInTheDocument();
  const preview = Boolean(
    popup.queryByRole('button', { name: 'Сохранение при загрузке контекста' }),
  );
  expect(popup.getByRole('button', { name: 'Добавить' })).toBeDisabled();
  fireEvent.submit(screen.getByTestId('quick-capture-form'));
  expect(preview).toBe(true);
  fireEvent.click(popup.getByRole('button', { name: 'Повторить сохранение' }));
  const writes = () =>
    calls.filter((call) => call.path === 'entity.create').map((call) => call.input);
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[1]).toEqual(writes()[0]);
  expect(committed.size).toBe(1);
});

test.each([
  ['records', 'Быстрая запись', 'Добавить'],
  ['day-planner', 'Новая задача', 'Добавить задачу'],
  ['inbox', 'Новая запись во входящих', 'Сохранить во входящие'],
])('two Renderer %s forms isolate previews and submit locks', async (block, field, button) => {
  const nodes = parsePageText(`Первая секция

{{${block}}}

Вторая секция

{{${block}}}`);
  const { calls } = renderWithProviders(
    <Renderer nodes={nodes} kind="page" appendUnplacedCards={false} />,
    (path) => {
      if (path === 'entity.create') return new Promise(() => {});
      if (path === 'entity.query') return queryReply([]);
      if (path === 'user.getSettings')
        return {
          timezone: 'Asia/Almaty',
          today: '2026-10-19',
          nextMidnightAt: new Date(Date.now() + 86_400_000).toISOString(),
          graphEstablished: true,
        };
      return registryReply(path) ?? {};
    },
    { freshness: true },
  );
  await waitFor(() => expect(screen.getAllByRole('button', { name: button })).toHaveLength(2));
  const [first, second] = screen.getAllByRole('textbox', { name: field });
  const firstElement = first?.closest('form');
  const secondElement = second?.closest('form');
  if (!first || !second || !firstElement || !secondElement)
    throw new Error('Expected two capture forms');
  const firstForm = within(firstElement);
  const secondForm = within(secondElement);
  fireEvent.change(first, { target: { value: 'Только первый блок' } });
  fireEvent.change(second, { target: { value: 'Независимый ввод' } });
  await waitFor(() => expect(firstForm.getByRole('button', { name: button })).toBeEnabled());
  fireEvent.click(firstForm.getByRole('button', { name: button }));
  await firstForm.findByRole('button', { name: 'Только первый блок' });
  expect(secondForm.queryByRole('button', { name: 'Только первый блок' })).toBeNull();
  expect(secondForm.getByRole('button', { name: button })).toBeEnabled();
  fireEvent.click(secondForm.getByRole('button', { name: button }));
  await secondForm.findByRole('button', { name: 'Независимый ввод' });
  expect(firstForm.queryByRole('button', { name: 'Независимый ввод' })).toBeNull();
  await waitFor(() =>
    expect(calls.filter((call) => call.path === 'entity.create')).toHaveLength(2),
  );
});
