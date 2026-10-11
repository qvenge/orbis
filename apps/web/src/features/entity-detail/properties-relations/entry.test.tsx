import { PAGE_ASPECT, TEMPLATE_FOR_PROPERTY } from '@orbis/shared';
import { currentEntry } from '@orbis/shared/nav';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetRegistryVersionForTests } from '../../../lib/registry/useRegistry';
import { registerLeaveGuard } from '../../../state/leave-guard';
import { useNav } from '../../../state/navigation';
import { renderWithProviders, wireEntity } from '../../../test/harness';
import { navAt } from '../../../test/nav';
import { BUILTIN_REGISTRY, registryReply } from '../../../test/registry';
import { trpc } from '../../../trpc';
import { previewCandidatesAst } from '../../page/TemplatePreview';
import { resetUndoSession } from '../../undo/undo-epoch';
import { resetDetailMenuModuleForTests } from '../DetailMenuSlot';
import { DetailScreen } from '../DetailScreen';
import { PropertiesRelationsSlot, runLazyPanelHost } from '../PropertiesRelationsSlot';
import { dispatchPanelHost, type LatestPanelHost } from './panel-host';

it('waiting preview entry stays disabled; resolved same-page panel closes back to host menu focus', async () => {
  let release: (rows: ReturnType<typeof wireEntity>[]) => void = () => {};
  const pending = new Promise<ReturnType<typeof wireEntity>[]>((resolve) => (release = resolve));
  renderWithProviders(<DetailScreen entityId={id} />, (path, input) => {
    if (path === 'entity.get')
      return {
        entity: wireEntity({
          id,
          title: 'Страница A',
          body: '{{title}}',
          props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/task'] },
          aspects: [PAGE_ASPECT],
        }),
        relations: [],
        thread: null,
      };
    if (
      path === 'entity.query' &&
      JSON.stringify((input as { ast: unknown }).ast) ===
        JSON.stringify(previewCandidatesAst(['orbis/task']))
    )
      return pending;
    return registryReply(path) ?? [];
  });
  fireEvent.click(await screen.findByTestId('screen-menu'));
  expect(
    await screen.findByRole('menuitem', {
      name: 'Свойства и связи — дождитесь записи предпросмотра',
    }),
  ).toHaveAttribute('aria-disabled', 'true');
  release([]);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Свойства и связи' }));
  await screen.findByRole('dialog', { name: 'Свойства и связи' });
  await screen.findByText(id);
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
  await waitFor(() => expect(screen.getByTestId('screen-menu')).toHaveFocus());
});

function MovingHost() {
  const [address, setAddress] = useState(id);
  const utils = trpc.useUtils();
  return (
    <>
      <button type="button" onClick={() => setAddress(other)}>
        force B
      </button>
      <button type="button" onClick={() => setAddress(id)}>
        force A
      </button>
      <button type="button" onClick={() => void utils.entity.get.invalidate()}>
        refetch host
      </button>
      <DetailScreen entityId={address} />
    </>
  );
}
async function openPanel() {
  fireEvent.click(await screen.findByTestId('screen-menu'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Свойства и связи' }));
  return screen.findByRole('dialog', { name: 'Свойства и связи' });
}
it('forced A to B keeps frozen archive A; legal restore after explicit A reopening addresses only A', async () => {
  let archived = true;
  const writes: unknown[] = [];
  renderWithProviders(<MovingHost />, (path, input, type) => {
    if (type === 'mutation') {
      writes.push(input);
      archived = false;
      return { ok: true, entity: wireEntity({ id, title: 'Архив A', archived: false }) };
    }
    if (path === 'entity.get') {
      const current = (input as { id: string }).id;
      return {
        entity: wireEntity({
          id: current,
          title: current === id ? 'Архив A' : 'Запись B',
          archived: current === id && archived,
          props: {},
          aspects: [],
        }),
        relations: [],
        thread: null,
      };
    }
    return registryReply(path) ?? [];
  });
  const dialog = await openPanel();
  await within(dialog).findByText('Архив A');
  fireEvent.click(screen.getByText('force B'));
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: 'Восстановить запись' })).toBeDisabled(),
  );
  expect(within(dialog).getByText(id)).toBeVisible();
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
  fireEvent.click(screen.getByText('force A'));
  const reopened = await openPanel();
  fireEvent.click(await within(reopened).findByRole('button', { name: 'Восстановить запись' }));
  await waitFor(() => expect(writes).toContainEqual({ id, archived: false }));
  expect(writes.some((value) => (value as { id?: string }).id === other)).toBe(false);
});
it('real preview menu targets chosen B readonly and explicit body opens B via host without writes', async () => {
  const writes: unknown[] = [];
  renderWithProviders(<DetailScreen entityId={id} />, (path, input, type) => {
    if (type === 'mutation') {
      writes.push(input);
      return {};
    }
    if (path === 'registry.effective') return BUILTIN_REGISTRY;
    if (path === 'entity.get') {
      const current = (input as { id: string }).id;
      return {
        entity: wireEntity({
          id: current,
          title: current === id ? 'Шаблон A' : 'Пример B',
          body: current === id ? '{{title}}' : 'Текст B',
          props: current === id ? { [TEMPLATE_FOR_PROPERTY]: ['orbis/task'] } : {},
          aspects: current === id ? [PAGE_ASPECT] : [],
        }),
        relations: [],
        thread: null,
      };
    }
    if (
      path === 'entity.query' &&
      JSON.stringify((input as { ast: unknown }).ast) ===
        JSON.stringify(previewCandidatesAst(['orbis/task']))
    )
      return [wireEntity({ id: other, title: 'Пример B', aspects: [], props: {} })];
    return registryReply(path) ?? [];
  });
  await screen.findByTestId('template-preview-record');
  const dialog = await openPanel();
  expect(await within(dialog).findByText('Пример B')).toBeVisible();
  expect(within(dialog).getByText(other)).toBeVisible();
  expect(within(dialog).getByText('Предпросмотр — только чтение')).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Открыть текст записи' }));
  await waitFor(() =>
    expect(currentEntry(useNav.getState().model).address).toMatchObject({
      kind: 'record',
      id: other,
    }),
  );
  expect(currentEntry(useNav.getState().model).view?.via).toBe('host');
  expect(writes).toHaveLength(0);
});
it.each([
  'preview',
  'configure',
])('same-page %s body exit remains host after effects and an independent refetch', async (mode) => {
  const { calls } = renderWithProviders(<MovingHost />, (path, input) =>
    path === 'entity.get'
      ? {
          entity: wireEntity({
            id: (input as { id: string }).id,
            title: 'Страница A',
            body: 'Тело A',
            aspects: [PAGE_ASPECT],
            props: {},
          }),
          relations: [],
          thread: null,
        }
      : (registryReply(path) ?? []),
  );
  fireEvent.click(await screen.findByTestId('screen-menu'));
  fireEvent.click(
    await screen.findByRole('menuitem', {
      name: mode === 'preview' ? 'Предпросмотр на записи…' : 'Настроить',
    }),
  );
  await screen.findByTestId(mode === 'preview' ? 'template-preview-plaque' : 'configure-view');
  const dialog = await openPanel();
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Открыть текст записи' }));
  await waitFor(() =>
    expect(
      screen.queryByTestId(mode === 'preview' ? 'template-preview-plaque' : 'configure-view'),
    ).toBeNull(),
  );
  await waitFor(() => expect(currentEntry(useNav.getState().model).view?.via).toBe('host'));
  fireEvent.click(screen.getByText('refetch host'));
  await waitFor(() =>
    expect(calls.filter((call) => call.path === 'entity.get').length).toBeGreaterThan(1),
  );
  expect(currentEntry(useNav.getState().model).view?.via).toBe('host');
  expect(screen.queryByTestId('configure-view')).toBeNull();
  expect(screen.queryByTestId('template-preview-plaque')).toBeNull();
});
const other = '00000000-0000-4000-8000-000000000902';
function latest(entityId = id): LatestPanelHost {
  return {
    entity: wireEntity({ id: entityId, title: 'Host', archived: true }),
    available: new Set(['openBody', 'restore', 'makePage', 'stopPage', 'configureApp']),
    restricted: false,
    setMode: vi.fn(),
    setHostView: vi.fn(),
    restore: vi.fn(),
    makePage: vi.fn(),
    stopPage: vi.fn(),
    onClose: vi.fn(),
  };
}
it.each([
  'restore',
  'makePage',
  'stopPage',
  'configureApp',
] as const)('direct %s rejects mismatched, readonly and restricted context, even with visible capability', (action) => {
  for (const [targetId, readOnly, restricted] of [
    [other, false, false],
    [id, true, false],
    [id, false, true],
  ] as const) {
    const host = latest();
    host.restricted = restricted;
    dispatchPanelHost(action, { entityId: targetId, readOnly }, () => host);
    expect(host.restore).not.toHaveBeenCalled();
    expect(host.makePage).not.toHaveBeenCalled();
    expect(host.stopPage).not.toHaveBeenCalled();
    expect(host.setHostView).not.toHaveBeenCalled();
  }
});
it.each([
  'makePage',
  'openBody',
] as const)('delayed %s dispatcher from an old session cannot execute on a same-id new host', async (action) => {
  const host = latest();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = runLazyPanelHost(
    action,
    { entityId: id, readOnly: false },
    () => host,
    async () => {
      await gate;
      return import('./panel-host');
    },
  );
  resetUndoSession();
  release();
  await pending;
  expect(host.makePage).not.toHaveBeenCalled();
  expect(host.setMode).not.toHaveBeenCalled();
  expect(host.setHostView).not.toHaveBeenCalled();
  expect(host.onClose).not.toHaveBeenCalled();
});
it('delayed dispatcher reads after import; A to B and context changes cannot use captured A handlers', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let current = latest();
  const original = current;
  const target = { entityId: id, readOnly: false };
  const pending = runLazyPanelHost(
    'makePage',
    target,
    () => current,
    async () => {
      await gate;
      return import('./panel-host');
    },
  );
  target.entityId = other;
  current = latest(other);
  release();
  await pending;
  expect(original.makePage).not.toHaveBeenCalled();
  expect(current.makePage).not.toHaveBeenCalled();
  const same = latest();
  let allow: () => void = () => {};
  const delayed = new Promise<void>((resolve) => (allow = resolve));
  const next = runLazyPanelHost(
    'configureApp',
    { entityId: id, readOnly: false },
    () => same,
    async () => {
      await delayed;
      return import('./panel-host');
    },
  );
  same.restricted = true;
  allow();
  await next;
  expect(same.setHostView).not.toHaveBeenCalled();
});
it('distinct lazy getters for the same host share its actual pending intent and release after failure', async () => {
  const host = latest();
  let release: () => void = () => {};
  const load = new Promise<void>((resolve) => (release = resolve));
  let reject: (error: unknown) => void = () => {};
  const mutation = new Promise((_resolve, rejection) => (reject = rejection));
  host.makePage = vi.fn(() => mutation);
  const loader = async () => {
    await load;
    return import('./panel-host');
  };
  const first = runLazyPanelHost('makePage', { entityId: id, readOnly: false }, () => host, loader);
  const second = runLazyPanelHost(
    'makePage',
    { entityId: id, readOnly: false },
    () => host,
    loader,
  );
  release();
  await waitFor(() => expect(host.makePage).toHaveBeenCalledTimes(1));
  reject(new Error('write failed'));
  await Promise.allSettled([first, second]);
  host.makePage = vi.fn(async () => false);
  await runLazyPanelHost('makePage', { entityId: id, readOnly: false }, () => host);
  expect(host.makePage).toHaveBeenCalledTimes(1);
});
it('failed lazy host loading releases the intent for an explicit retry', async () => {
  const host = latest();
  const read = () => host;
  await expect(
    runLazyPanelHost('makePage', { entityId: id, readOnly: false }, read, async () => {
      throw new Error('chunk failed');
    }),
  ).rejects.toThrow('chunk failed');
  expect(host.makePage).not.toHaveBeenCalled();
  await runLazyPanelHost('makePage', { entityId: id, readOnly: false }, read);
  expect(host.makePage).toHaveBeenCalledTimes(1);
});
it('body navigation addresses foreign preview target and refused leave never changes any view', () => {
  const host = latest();
  const off = registerLeaveGuard(() => false);
  dispatchPanelHost('openBody', { entityId: other, readOnly: true }, () => host);
  expect(currentEntry(useNav.getState().model).address).toMatchObject({ kind: 'record', id });
  expect(host.setHostView).not.toHaveBeenCalled();
  expect(host.setMode).not.toHaveBeenCalled();
  off();
  dispatchPanelHost('openBody', { entityId: other, readOnly: true }, () => host);
  expect(currentEntry(useNav.getState().model).address).toMatchObject({
    kind: 'record',
    id: other,
  });
  expect(currentEntry(useNav.getState().model).view?.via).toBe('host');
  expect(host.setHostView).not.toHaveBeenCalled();
});
const id = '00000000-0000-4000-8000-000000000901';
const loads = vi.hoisted(() => ({ count: 0, fail: false }));
beforeEach(() => {
  loads.count = 0;
  loads.fail = false;
  resetDetailMenuModuleForTests();
  resetRegistryVersionForTests();
  navAt(id);
  vi.stubGlobal('requestIdleCallback', () => 1);
});
afterEach(() => vi.unstubAllGlobals());
vi.mock('./PropertiesRelationsPanel', async (original) => {
  loads.count++;
  if (loads.fail) throw new Error('chunk');
  return original();
});
it('closed slot renders null without module load or requests', () => {
  const { calls, container } = renderWithProviders(
    <PropertiesRelationsSlot
      target={null}
      onClose={() => {}}
      host={{ screenEntityId: id, available: new Set(), run: () => {} }}
    />,
  );
  expect(container).toBeEmptyDOMElement();
  expect(loads.count).toBe(0);
  expect(calls).toHaveLength(0);
});
it.each([
  { aspects: [] },
  { aspects: [PAGE_ASPECT] },
  { aspects: ['orbis/app'] },
])('entry belongs to host regardless of aspects %s; menu alone does not load panel', async ({
  aspects,
}) => {
  const { calls } = renderWithProviders(<DetailScreen entityId={id} />, (path) =>
    path === 'entity.get'
      ? {
          entity: wireEntity({ id, title: 'Запись', body: '', aspects, props: {} }),
          relations: [],
          thread: null,
        }
      : (registryReply(path) ?? []),
  );
  fireEvent.click(await screen.findByTestId('screen-menu'));
  const item = await screen.findByRole('menuitem', { name: 'Свойства и связи' });
  expect(loads.count).toBe(0);
  const before = calls.length;
  fireEvent.click(item);
  expect(await screen.findByRole('dialog', { name: 'Свойства и связи' })).toBeVisible();
  expect(
    calls.slice(before).some((c) => c.path === 'entity.query' || c.path === 'entity.resolveRefs'),
  ).toBe(false);
});
