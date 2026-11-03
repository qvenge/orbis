import { useQueryClient } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { expect, it } from 'vitest';
import { useChatThread } from '../../features/chat/useChatThread';
import { detailGetInput, useEntityDetail } from '../../features/entity-detail/useEntityDetail';
import { isBodyPending } from '../../features/undo/body-provenance';
import { undoEpoch } from '../../features/undo/undo-epoch';
import { testFreshnessOf } from '../../test/freshness';
import { fixtureFreshness, renderWithProviders, wireEntity } from '../../test/harness';
import { type RouterInputs, trpc } from '../../trpc';
import {
  networkReadContext,
  nextNetworkOrder,
  recordDiskRead,
  recordNetworkReadReceipt,
} from './provenance';

const entityId = '00000000-0000-4000-8000-000000000001';
const threadId = '00000000-0000-4000-8000-000000000002';
const doc = (text: string) =>
  ({
    v: 1,
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  }) as RouterInputs['entity']['update']['bodyDoc'];

it('an early own autosave publishes its revision without fetching detail or side chat', async () => {
  let mutation: ReturnType<typeof useEntityDetail>['update'] | undefined;
  function Probe() {
    mutation = useEntityDetail(entityId).update;
    trpc.entity.get.useQuery({ id: entityId, include: ['body'] });
    useChatThread(threadId);
    return null;
  }
  let acknowledge: (data: unknown) => void = () => {};
  const ack = new Promise((resolve) => {
    acknowledge = resolve;
  });
  let revision = 3;
  const makeEntity = () =>
    wireEntity({
      id: entityId,
      title: 'Test record',
      body: revision === 3 ? 'before' : 'after',
      bodyDoc: doc(revision === 3 ? 'before' : 'after'),
      bodyRevision: revision,
    });
  const { queryClient, calls } = renderWithProviders(
    <Probe />,
    (path) => {
      if (path === 'entity.get')
        return {
          entity: makeEntity(),
          bodyAction: null,
          registryVersion: '1',
          freshness: { ...fixtureFreshness, entityIds: [entityId], threadIds: [threadId] },
        };
      if (path === 'entity.update') return ack;
      if (path === 'chat.listMessages') return [];
      throw new Error(path);
    },
    { freshness: true, queries: { staleTime: Infinity } },
  );
  const detailKey = getQueryKey(trpc.entity.get, detailGetInput(entityId), 'query');
  const revisionInCache = () =>
    queryClient.getQueryData<{
      entity: { bodyRevision: number };
      bodyAction: unknown;
    }>(detailKey)?.entity.bodyRevision;
  const count = (path: string) => calls.filter((entry) => entry.path === path).length;
  await waitFor(() => expect(revisionInCache()).toBe(3));
  await waitFor(() => expect(count('chat.listMessages')).toBe(1));
  const baseline = queryClient.getQueryState(detailKey)?.dataUpdatedAt;

  act(() =>
    mutation?.mutate({
      id: entityId,
      expectedBodyRevision: 3,
      bodyDoc: doc('after'),
      autosave: true,
    }),
  );
  await waitFor(() => {
    if (mutation?.error) throw mutation.error;
    expect(count('entity.update')).toBe(1);
  });
  const feed = testFreshnessOf(queryClient);
  await act(async () => {
    feed.changes(
      [
        { kind: 'entity', rowKey: entityId, scope: 'body' },
        { kind: 'journal', rowKey: 'journal-action', entityIds: [entityId] },
      ],
      10,
    );
    await new Promise((resolve) => setTimeout(resolve, 130));
  });
  expect(count('entity.get')).toBe(2);
  expect(count('chat.listMessages')).toBe(1);
  revision = 4;
  await act(async () => acknowledge({ ...makeEntity(), txId: '10', bodyAction: { id: 'action' } }));
  await waitFor(() => expect(revisionInCache()).toBe(4));
  expect(
    queryClient.getQueryData(
      getQueryKey(trpc.entity.get, { id: entityId, include: ['body'] }, 'query'),
    ),
  ).toMatchObject({ entity: { bodyRevision: 4, body: 'after' } });
  expect(queryClient.getQueryData(detailKey)).toMatchObject({ bodyAction: { id: 'action' } });
  expect(queryClient.getQueryState(detailKey)?.dataUpdatedAt).toBe(baseline);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160));
  });
  expect(count('entity.get')).toBe(2);
  expect(count('chat.listMessages')).toBe(1);

  await act(async () =>
    feed.changes([
      { kind: 'entity', rowKey: entityId, scope: 'body' },
      { kind: 'message', rowKey: 'assistant', threadId },
    ]),
  );
  await waitFor(() => expect(count('entity.get')).toBe(4));
  await waitFor(() => expect(count('chat.listMessages')).toBe(2));
});

it('only actual graph POSTs reconcile without a stream, including vanilla D2 and unknown Undo', async () => {
  const { createFreshnessRuntime } = await import('./runtime');
  const { bindFreshnessRuntime, nextNetworkOrder } = await import('./provenance');
  const { undoEpoch } = await import('../../features/undo/undo-epoch');
  const { makeVanillaClient, queryClient } = await import('../../trpc');
  const { vi } = await import('vitest');
  const scope = { accountId: 'owner', graphId: 'owner', epoch: undoEpoch() };
  const transport = { start() {}, stop() {}, reconcile: vi.fn(async () => {}) };
  const runtime = createFreshnessRuntime({ scope, transport, queryClient });
  const unbind = bindFreshnessRuntime(queryClient, runtime);
  const settings = getQueryKey(trpc.user.getSettings, undefined, 'query');
  const raw = { graphEstablished: true };
  queryClient.setQueryData(settings, raw);
  const query = queryClient.getQueryCache().find({ queryKey: settings, exact: true });
  if (!query) throw new Error('Missing settings fixture');
  runtime.acceptRead({
    source: 'network',
    key: settings,
    raw,
    scope,
    queryHash: query.queryHash,
    receipt: {
      epoch: scope.epoch,
      watermark: '10',
      receivedAt: Date.now(),
      startedSequence: nextNetworkOrder(),
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('ai.undo')) throw new Error('lost response');
      return new Response(JSON.stringify([{ result: { data: {} } }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const vanilla = makeVanillaClient(() => 'token');
  try {
    await vanilla.entity.blocks.mutate({ blocks: [] });
    expect(transport.reconcile).not.toHaveBeenCalled();
    await vanilla.entity.create.mutate({
      input: { id: entityId, title: 'D2', tags: [] },
      source: 'fast_path',
    });
    expect(transport.reconcile).toHaveBeenCalledTimes(1);
    await expect(vanilla.ai.undo.mutate({ actionId: threadId })).rejects.toThrow('lost response');
    expect(transport.reconcile).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
    runtime.dispose();
    unbind();
    queryClient.clear();
  }
});

it('a null server result is still a network read of its own key', async () => {
  const key = getQueryKey(
    trpc.budget.envelopeForCategory,
    { categoryId: entityId, date: '2026-11-03' },
    'query',
  );
  function Probe() {
    const client = useQueryClient();
    trpc.budget.envelopeForCategory.useQuery(
      { categoryId: entityId, date: '2026-11-03' },
      {
        trpc: { context: networkReadContext(client, key) },
      },
    );
    return null;
  }
  const { queryClient } = renderWithProviders(<Probe />, () => null, { freshness: true });
  const runtime = testFreshnessOf(queryClient).runtime;
  await waitFor(() => {
    const hash = queryClient.getQueryCache().find({ queryKey: key, exact: true })?.queryHash ?? '';
    expect(runtime.publicationOf(hash)).toMatchObject({ source: 'network', raw: null });
  });
  expect(runtime.getScreen().hasCopy).toBe(true);
});

it('a canceled null receipt cannot replace a newer same-key network receipt', async () => {
  const { queryClient } = renderWithProviders(null, () => ({}), { freshness: true });
  const key = getQueryKey(
    trpc.budget.envelopeForCategory,
    { categoryId: entityId, date: '2026-11-03' },
    'query',
  );
  const context = networkReadContext(queryClient, key);
  const epoch = undoEpoch();
  const old = { epoch, watermark: '10', receivedAt: 100, startedSequence: nextNetworkOrder() };
  const newest = { epoch, watermark: '20', receivedAt: 200, startedSequence: nextNetworkOrder() };
  let resolveOld: () => void = () => {};
  const later = new Promise<void>((resolve) => {
    resolveOld = resolve;
  });
  const canceled = queryClient
    .fetchQuery({
      queryKey: key,
      queryFn: async () => {
        await later;
        context.onNetworkReadReceipt(old, null);
        return null;
      },
    })
    .catch(() => {});
  await queryClient.cancelQueries({ queryKey: key });
  await queryClient.fetchQuery({
    queryKey: key,
    queryFn: async () => {
      context.onNetworkReadReceipt(newest, null);
      resolveOld();
      await later;
      return null;
    },
  });
  await canceled;
  const hash = queryClient.getQueryCache().find({ queryKey: key, exact: true })?.queryHash ?? '';
  expect(testFreshnessOf(queryClient).runtime.publicationOf(hash)).toMatchObject({
    receipt: newest,
  });
});

it('disk cannot confirm an editor basis, even when the network shares the same document', async () => {
  const { queryClient } = renderWithProviders(null, () => ({}), { freshness: true });
  const { scope, runtime } = testFreshnessOf(queryClient);
  const key = getQueryKey(trpc.entity.get, detailGetInput(entityId), 'query');
  const raw = { entity: { bodyDoc: doc('same'), bodyRevision: 3 } };
  recordDiskRead(raw, { source: 'disk', scope, receivedAt: 100 });
  await queryClient.fetchQuery({ queryKey: key, queryFn: async () => raw });
  const shown = queryClient.getQueryData<typeof raw>(key);
  expect(isBodyPending(shown?.entity.bodyDoc)).toBe(true);
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  const network = structuredClone(raw);
  recordNetworkReadReceipt(network, {
    epoch: scope.epoch,
    watermark: '10',
    receivedAt: 200,
    startedSequence: nextNetworkOrder(),
  });
  const published: unknown[] = [];
  runtime.setSinks({ writeNetwork: ({ raw }) => published.push(raw) });
  await queryClient.fetchQuery({ queryKey: key, queryFn: async () => network });
  expect(queryClient.getQueryData(key)).toBe(shown);
  expect(isBodyPending(shown?.entity.bodyDoc)).toBe(false);
  expect(published).toHaveLength(1);
  expect(published[0]).toBe(network);
});
