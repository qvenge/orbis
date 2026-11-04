import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { FreshnessVisibility } from '../../lib/freshness/screen';
import { testFreshnessOf } from '../../test/freshness';
import {
  fixtureFreshness,
  queryReply,
  renderWithProviders,
  trpcError,
  wireEntity,
} from '../../test/harness';
import { type RouterOutputs, trpc } from '../../trpc';
import { bindStepOwner, canUndoStep, pushStep, resetSteps } from '../entity-editor/arrows-stack';
import { registerBodyFlush } from '../entity-editor/body-flush';
import { readDraft } from '../entity-editor/draft-storage';
import { type BodySave, type BodySaveEntity, useBodySave } from '../entity-editor/useBodySave';
import { ConfigureView } from '../page/ConfigureView';
import { TemplatePreview } from '../page/TemplatePreview';
import { BodyScreenProvider } from './EntityBody';
import { PropertiesRelationsPanel } from './properties-relations/PropertiesRelationsPanel';
import { registry } from './properties-relations/test-fixtures';
import { detailGetInput, useEntityDetail } from './useEntityDetail';
import { VersionsCard } from './VersionsCard';

beforeEach(() => localStorage.clear());

const id = '00000000-0000-4000-8000-000000000001';
const doc = (text: string) => ({
  v: 3 as const,
  doc: {
    type: 'doc' as const,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
});
const entity = (bodyRevision: number, text: string) =>
  wireEntity({ id, title: 'Test record', bodyRevision, bodyDoc: doc(text), body: text });
const detail = (bodyRevision: number, text: string) => ({
  entity: entity(bodyRevision, text),
  bodyAction: null,
  registryVersion: '1',
  freshness: { ...fixtureFreshness, entityIds: [id] },
});
const key = getQueryKey(trpc.entity.get, detailGetInput(id), 'query');
const alternateKey = getQueryKey(trpc.entity.get, { id, include: ['body'] }, 'query');
function reset(feed: ReturnType<typeof testFreshnessOf>) {
  feed.changes([], 30);
  expect(
    feed.runtime.acceptChanges(
      feed.scope,
      {
        watermark: '20',
        floor: '0',
        transactions: [],
        reset: { reason: 'future-cursor', phase: 'complete', token: 'future-cursor:31:0:20' },
      },
      '31',
    ),
  ).toBe(true);
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it.each([
  'success',
  'rejection',
] as const)('an autosave %s crossing reset keeps the draft and never becomes editor basis', async (outcome) => {
  const first = deferred();
  const old = deferred();
  let revision = 3;
  let saves = 0;
  let editor!: BodySave;
  function Editor({ record }: { record: BodySaveEntity }) {
    editor = useBodySave(id, record);
    return null;
  }
  function Probe() {
    const read = trpc.entity.get.useQuery(detailGetInput(id));
    const record = read.data?.entity;
    return record ? (
      <Editor record={{ ...record, bodyRevision: record.bodyRevision ?? 0 }} />
    ) : null;
  }
  const { queryClient, calls } = renderWithProviders(
    <Probe />,
    (path) => {
      if (path === 'entity.get') return detail(revision, 'server');
      if (path === 'entity.update') return saves++ === 0 ? first.promise : old.promise;
      throw new Error(path);
    },
    { freshness: true },
  );
  const feed = testFreshnessOf(queryClient);
  const flush = (text: string) =>
    act(() => {
      editor.onDocChange(doc(text));
      editor.flush();
    });
  await waitFor(() => expect(editor).toBeDefined());

  flush('confirmed before reset');
  await waitFor(() => expect(saves).toBe(1));
  await act(async () => first.resolve({ ...entity(4, 'confirmed before reset'), txId: '8' }));
  await waitFor(() => expect(editor.expectedRevision()).toBe(4));
  expect(readDraft(id)).toBeNull();

  act(() => editor.onShown(4));
  flush('only local draft');
  await waitFor(() => expect(saves).toBe(2));
  revision = 2;
  act(() => reset(feed));
  await waitFor(() =>
    expect(queryClient.getQueryData(key)).toMatchObject({ entity: { bodyRevision: 2 } }),
  );
  act(() => editor.onShown(2));
  const stored = readDraft(id);
  expect(stored?.doc).toEqual(doc('only local draft'));

  await act(async () => {
    if (outcome === 'success') old.resolve({ ...entity(5, 'only local draft'), txId: '35' });
    else old.reject(trpcError('BAD_REQUEST'));
  });
  await waitFor(() => expect(editor.state).toBe('idle'));
  expect(editor.expectedRevision()).toBe(2);
  expect(editor.hasUnsent()).toBe(true);
  expect(readDraft(id)).toEqual(stored);
  expect(calls.filter(({ path }) => path === 'entity.update')).toHaveLength(2);
});

it('version.restore started before reset cannot project old body over a fresh read', async () => {
  const old = deferred();
  let revision = 3;
  function Probe() {
    const read = trpc.entity.get.useQuery(detailGetInput(id));
    return read.data ? <VersionsCard entity={read.data.entity} active /> : null;
  }
  const { queryClient, calls } = renderWithProviders(
    <Probe />,
    (path) => {
      if (path === 'entity.get') return detail(revision, 'server');
      if (path === 'version.list')
        return [
          {
            id: 'version',
            label: 'Old version',
            createdAt: '2026-01-01T00:00:00.000Z',
            hasDoc: true,
          },
        ];
      if (path === 'user.getSettings') return { timezone: 'UTC' };
      if (path === 'version.restore') return old.promise;
      throw new Error(path);
    },
    { freshness: true },
  );
  const finish = vi.fn();
  const resetHistory = vi.fn();
  const unbindStep = bindStepOwner(id, 'body', {
    reset: resetHistory,
    undo: () => true,
    redo: () => true,
  });
  const unregister = registerBodyFlush(
    id,
    async () => 'nothing',
    () => 3,
    () => finish,
  );
  try {
    await screen.findByText('Old version');
    fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Восстановить' }),
    );
    await waitFor(() =>
      expect(calls.filter(({ path }) => path === 'version.restore')).toHaveLength(1),
    );
    revision = 2;
    act(() => reset(testFreshnessOf(queryClient)));
    await waitFor(() =>
      expect(queryClient.getQueryData(key)).toMatchObject({ entity: { bodyRevision: 2 } }),
    );
    pushStep(id, 'body');
    await act(async () =>
      old.resolve({
        ...entity(4, 'old timeline'),
        actionId: 'old-restore',
        consequences: false,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const forced = queryClient.refetchQueries({ queryKey: key, exact: true });
    await act(async () => forced);
    expect(queryClient.getQueryData(key)).toMatchObject({ entity: { bodyRevision: 2 } });
    expect(finish).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(resetHistory).not.toHaveBeenCalled();
    expect(canUndoStep(id)).toBe(true);
  } finally {
    unregister();
    unbindStep();
    resetSteps(id);
  }
});

it('old-generation NOT_FOUND does not remove a current response for the same entity', async () => {
  const old = deferred();
  const removeEntity = vi.fn();
  let alternateReads = 0;
  function Probe() {
    trpc.entity.get.useQuery(detailGetInput(id));
    trpc.entity.get.useQuery({ id, include: ['body'] });
    return null;
  }
  const { queryClient, calls } = renderWithProviders(
    <Probe />,
    (path, input) => {
      if (
        path === 'entity.get' &&
        (input as { include?: string[] }).include?.length === 1 &&
        alternateReads++ === 0
      )
        return old.promise;
      return detail(3, 'server');
    },
    { freshness: true },
  );
  const feed = testFreshnessOf(queryClient);
  feed.runtime.setSinks({ removeEntity });
  await waitFor(() => expect(calls.filter(({ path }) => path === 'entity.get')).toHaveLength(2));
  await waitFor(() => expect(queryClient.getQueryData(key)).toBeDefined());
  act(() => reset(feed));
  await waitFor(() => expect(calls.filter(({ path }) => path === 'entity.get')).toHaveLength(3));
  await act(async () => old.reject(trpcError('NOT_FOUND')));
  await waitFor(() => expect(queryClient.getQueryData(alternateKey)).toBeDefined());
  expect(removeEntity).not.toHaveBeenCalled();
});

it('a canceled foreign refresh stays owed after successful own autosave', async () => {
  const old = deferred();
  const save = deferred();
  let mutation!: ReturnType<typeof useEntityDetail>['update'];
  let reads = 0;
  function Probe() {
    mutation = useEntityDetail(id).update;
    return null;
  }
  const { queryClient, calls } = renderWithProviders(
    <Probe />,
    (path) => {
      if (path === 'entity.get') {
        reads++;
        if (reads === 2) return old.promise;
        return {
          ...detail(reads === 1 ? 3 : 4, 'server'),
          entity: {
            ...entity(reads === 1 ? 3 : 4, 'server'),
            title: reads === 1 ? 'Before foreign change' : 'Changed abroad',
          },
        };
      }
      if (path === 'entity.update') return save.promise;
      throw new Error(path);
    },
    { freshness: true },
  );
  await waitFor(() => expect(queryClient.getQueryData(key)).toBeDefined());
  const feed = testFreshnessOf(queryClient);
  act(() => feed.changes([{ kind: 'entity', rowKey: id, scope: 'other' }], 10));
  await waitFor(() => expect(reads).toBe(2));
  act(() =>
    mutation.mutate({ id, bodyDoc: doc('saved'), expectedBodyRevision: 3, autosave: true }),
  );
  await waitFor(() => expect(calls.filter(({ path }) => path === 'entity.update')).toHaveLength(1));
  act(() => feed.changes([{ kind: 'entity', rowKey: id, scope: 'body' }], 11));
  await act(async () => save.resolve({ ...entity(4, 'saved'), txId: '11' }));
  await waitFor(() => expect(mutation.isSuccess).toBe(true));
  await act(async () => old.resolve(detail(3, 'obsolete canceled response')));
  await waitFor(() =>
    expect(queryClient.getQueryData(key)).toMatchObject({ entity: { title: 'Changed abroad' } }),
  );
});

it('a hidden Relations panel tab does not fetch label queries', async () => {
  const otherId = '00000000-0000-4000-8000-000000000002';
  let label = 'Other end';
  const { calls, queryClient } = renderWithProviders(
    <PropertiesRelationsPanel
      target={{ entityId: id, readOnly: true }}
      host={
        {
          ready: false,
          pending: false,
          available: new Set(),
          run: async () => ({ kind: 'rejected' }),
        } as never
      }
      onClose={() => {}}
    />,
    (path) => {
      if (path === 'entity.get')
        return {
          ...detail(3, 'server'),
          registryVersion: registry.version,
          relations: [{ id: 'edge', sourceId: id, targetId: otherId, role: 'orbis/dependency' }],
        };
      if (path === 'registry.effective') return registry;
      if (path === 'user.getSettings') return { disabledModules: [] };
      if (path === 'entity.resolveRefs') return [{ id: otherId, title: label }];
      return [];
    },
    { freshness: true },
  );
  const dialog = await screen.findByRole('dialog', { name: 'Свойства и связи' });
  await within(dialog).findByRole('tab', { name: 'Аспекты' });
  expect(within(dialog).getByRole('tab', { name: 'Связи' })).toHaveAttribute(
    'aria-selected',
    'false',
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  const labelReads = () => calls.filter(({ path }) => path === 'entity.resolveRefs');
  expect(labelReads()).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Связи' }));
  await within(dialog).findByRole('link', { name: 'Открыть: Other end' });
  expect(labelReads()).toHaveLength(1);

  fireEvent.click(within(dialog).getByRole('tab', { name: 'Аспекты' }));
  label = 'Renamed while hidden';
  act(() => testFreshnessOf(queryClient).changes([{ kind: 'entity', rowKey: otherId }], 10));
  const labels = queryClient
    .getQueryCache()
    .getAll()
    .find((query) => (query.queryKey[0] as string[])?.join?.('.') === 'entity.resolveRefs');
  await waitFor(() => expect(labels?.state.isInvalidated).toBe(true));
  expect(labelReads()).toHaveLength(1);
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Связи' }));
  await within(dialog).findByRole('link', { name: 'Открыть: Renamed while hidden' });
  expect(labelReads()).toHaveLength(2);
});

it('an overlay keeps configure and template preview mounted without reading until visible', async () => {
  const previewId = '00000000-0000-4000-8000-000000000002';
  const configureId = '00000000-0000-4000-8000-000000000003';
  function Views() {
    const [visible, setVisible] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setVisible(true)}>
          Show views
        </button>
        <FreshnessVisibility visible={visible}>
          <BodyScreenProvider
            value={{
              asMarkdown: false,
              onCloseMarkdown() {},
              screenConflict: false,
              noticeHost: null,
              onRefresh() {},
              bodyGate: { current: null },
            }}
          >
            <ConfigureView targetId={configureId} onDone={() => {}} />
            <TemplatePreview page={detail(3, 'Template') as RouterOutputs['entity']['get']} />
          </BodyScreenProvider>
        </FreshnessVisibility>
      </>
    );
  }
  const { calls } = renderWithProviders(
    <Views />,
    (path, input) => {
      if (path === 'entity.query')
        return queryReply([wireEntity({ id: previewId, title: 'Sample record' })]);
      if (path === 'entity.get') {
        const targetId = (input as { id: string }).id;
        const title = targetId === configureId ? 'Configurable page' : 'Sample record';
        return {
          ...detail(3, 'server'),
          entity: wireEntity({ id: targetId, title, bodyRevision: 3 }),
        };
      }
      if (path === 'registry.effective') return registry;
      return {};
    },
    { freshness: true },
  );

  const reads = () => calls.filter(({ path }) => path === 'entity.get' || path === 'entity.query');
  await act(async () => {});
  expect(reads()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Show views' }));
  await waitFor(() =>
    expect(reads().filter(({ path }) => path === 'entity.query')).toHaveLength(1),
  );
  await waitFor(() =>
    expect(
      reads()
        .filter(({ path }) => path === 'entity.get')
        .map(({ input }) => (input as { id: string }).id)
        .sort(),
    ).toEqual([previewId, configureId]),
  );
});
