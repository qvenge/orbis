import { QueryCache, QueryClient, useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { makeQueryClient, type RouterInputs, trpc } from '../../trpc';
import { useEntityUpdate } from '../entity-detail/useEntityDetail';
import { isUndoEpoch, resetUndoSession, undoEpoch } from './undo-epoch';
import { offerUndoLazy } from './undo-lazy';
import { clearUndoStack, peekUndoable } from './undo-stack';

beforeEach(clearUndoStack);
function DefaultMutations() {
  const settings = trpc.user.updateSettings.useMutation();
  const checkpoint = trpc.agentRun.answerCheckpoint.useMutation();
  const proposal = trpc.routine.decideProposal.useMutation();
  return (
    <>
      <button type="button" onClick={() => settings.mutate({ timezone: 'UTC' })}>
        Настройки
      </button>
      <button
        type="button"
        onClick={() => checkpoint.mutate({ runId: 'r', answer: 'yes' } as never)}
      >
        Чекпойнт
      </button>
      <button
        type="button"
        onClick={() => proposal.mutate({ proposalId: 'p', decision: 'accept' } as never)}
      >
        Предложение
      </button>
    </>
  );
}
function Updates() {
  const { mutation: update } = useEntityUpdate('e1');
  return (
    <>
      <button type="button" onClick={() => update.mutate({ id: 'e1', title: 'Новое' })}>
        Заголовок
      </button>
      <button
        type="button"
        onClick={() => update.mutate({ id: 'e1', body: 'Текст', autosave: true })}
      >
        Автосохранение
      </button>
      <button
        type="button"
        onClick={() => update.mutate({ id: 'e1', props: { 'orbis/tag': ['t'] } })}
      >
        Тег
      </button>
    </>
  );
}
test('общая фабрика видит настройки, checkpoint и proposal без собственной плашки', async () => {
  let n = 0;
  renderWithProviders(<DefaultMutations />, () => ({ actionId: String(++n), consequences: false }));
  for (const name of ['Настройки', 'Чекпойнт', 'Предложение']) {
    fireEvent.click(screen.getByText(name));
    await waitFor(() => expect(peekUndoable()?.actionId).toBe(String(n)));
    expect(peekUndoable()?.title).toBe('действие');
  }
});
test('SELF entityUpdate: заголовок и autosave исключены, тег включён', async () => {
  let n = 0;
  const { calls } = renderWithProviders(<Updates />, (path) =>
    path === 'entity.update' ? { actionId: String(++n), consequences: false } : {},
  );
  fireEvent.click(screen.getByText('Заголовок'));
  await waitFor(() => expect(n).toBe(1));
  await act(async () => {});
  expect(peekUndoable()).toBeUndefined();
  fireEvent.click(screen.getByText('Автосохранение'));
  await waitFor(() => expect(n).toBe(2));
  await act(async () => {});
  expect(peekUndoable()).toBeUndefined();
  fireEvent.click(screen.getByText('Тег'));
  await waitFor(() => expect(peekUndoable()?.actionId).toBe('3'));
  expect(peekUndoable()?.title).toBe('правка «e1»');
  expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(3);
});
test('skip chat и строгий JournalRef не принимают undo/bookkeeping', async () => {
  const client = makeQueryClient();
  const cache = client.getMutationCache();
  for (const data of [
    { actionId: 'chat', consequences: true },
    { actionId: 'undo' },
    { actionId: 'u', undone: { id: 'a' }, pinnedVersions: [] },
    { actionId: 'bad', consequences: 'false' },
    {},
  ]) {
    // MutationMeta библиотеки, не meta сущности.
    await cache
      // biome-ignore lint/complexity/useLiteralKeys: MutationMeta библиотеки, не fixture meta сущности.
      .build(client, { ['meta']: { undoStack: 'skip' }, mutationFn: async () => data })
      .execute({});
    expect(peekUndoable()).toBeUndefined();
  }
  for (const data of [
    { actionId: 'undo' },
    { actionId: 'u', undone: { id: 'a' }, pinnedVersions: [] },
    { actionId: 'bad', consequences: 'false' },
    {},
  ]) {
    await cache.build(client, { mutationFn: async () => data }).execute({});
    expect(peekUndoable()).toBeUndefined();
  }
});
test('rerender/setOptions/resume не переснимает epoch; текущие callbacks работают', async () => {
  const client = makeQueryClient();
  const cache = client.getMutationCache();
  let finish!: (value: unknown) => void;
  const old = vi.fn();
  const newer = vi.fn();
  const settled = vi.fn();
  const options = {
    mutationFn: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    onSuccess: old,
    onSettled: settled,
  };
  const m = cache.build(client, options);
  const request = m.execute({});
  await waitFor(() => expect(finish).toBeDefined());
  resetUndoSession();
  m.setOptions({ ...options, onSuccess: newer });
  finish({ actionId: 'old', consequences: false });
  await request;
  expect(old).not.toHaveBeenCalled();
  expect(newer).not.toHaveBeenCalled();
  expect(settled).not.toHaveBeenCalled();
  expect(peekUndoable()).toBeUndefined();
  await cache
    .build(client, {
      mutationFn: async () => ({ actionId: 'new', consequences: false }),
      onSuccess: newer,
    })
    .execute({});
  expect(newer).toHaveBeenCalledOnce();
  expect(peekUndoable()?.actionId).toBe('new');
});
test('смена epoch между await cache onMutate и hook onMutate не запускает старые callbacks', async () => {
  const client = makeQueryClient();
  const cache = client.getMutationCache();
  let release!: () => void;
  const instance = vi.fn();
  const success = vi.fn();
  cache.config.onMutate = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const request = cache
    .build(client, {
      mutationFn: async () => ({ actionId: 'old', consequences: false }),
      onMutate: instance,
      onSuccess: success,
    })
    .execute({});
  resetUndoSession();
  release();
  await expect(request).rejects.toThrow('Сессия изменилась');
  expect(instance).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
  expect(peekUndoable()).toBeUndefined();
});
test('SELF плашка сохраняет конкретный title и entityIds, без ранней generic записи', async () => {
  const client = makeQueryClient();
  const cache = client.getMutationCache();
  await cache
    .build(client, {
      // biome-ignore lint/complexity/useLiteralKeys: MutationMeta библиотеки, не fixture meta сущности.
      ['meta']: { undoStack: 'self' },
      mutationFn: async () => ({ actionId: 'a', consequences: false }),
      onSuccess: () => offerUndoLazy({ actionId: 'a', title: 'Конкретное', entityIds: ['e1'] }),
    })
    .execute({});
  await vi.dynamicImportSettled();
  expect(peekUndoable()).toEqual({ actionId: 'a', title: 'Конкретное', entityIds: ['e1'] });
});

test('current error и cleanup вызываются, old error после ownerchange молчит', async () => {
  const client = makeQueryClient();
  const cache = client.getMutationCache();
  const error = vi.fn();
  const settled = vi.fn();
  await expect(
    cache
      .build(client, {
        mutationFn: async () => {
          throw new Error('current');
        },
        onError: error,
        onSettled: settled,
      })
      .execute({}),
  ).rejects.toThrow('current');
  expect(error).toHaveBeenCalledOnce();
  expect(settled).toHaveBeenCalledOnce();
  let reject!: (value: unknown) => void;
  const request = cache
    .build(client, {
      mutationFn: () =>
        new Promise((_resolve, r) => {
          reject = r;
        }),
      onError: error,
      onSettled: settled,
    })
    .execute({});
  await waitFor(() => expect(reject).toBeDefined());
  resetUndoSession();
  reject(new Error('old'));
  await expect(request).rejects.toThrow('old');
  expect(error).toHaveBeenCalledOnce();
  expect(settled).toHaveBeenCalledOnce();
});

test('auth меняется во время async global onMutate: старый запрос не отправляется с новым владельцем', async () => {
  const client = makeQueryClient();
  const cache = client.getMutationCache();
  let release!: () => void;
  const send = vi.fn(async () => ({ actionId: 'old', consequences: false }));
  cache.config.onMutate = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const request = cache.build(client, { mutationFn: send }).execute({ timezone: 'Старая правка' });
  resetUndoSession();
  release();
  await request.catch(() => {});
  expect(send).not.toHaveBeenCalled();
});

test('public QueryCache real fetch подтверждает shared doc; manualsetData и late oldfetch не дают current grant', async () => {
  const epochs = new WeakMap<object, number>();
  const granted: Array<{ current: boolean; doc: unknown }> = [];
  const cache = new QueryCache({
    onSuccess: (_data, query) =>
      granted.push({
        current: isUndoEpoch(epochs.get(query) ?? -1),
        doc: (query.state.data as { entity: { bodyDoc: object } }).entity.bodyDoc,
      }),
  });
  cache.subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'fetch')
      epochs.set(event.query, undoEpoch());
  });
  const client = new QueryClient({
    queryCache: cache,
    defaultOptions: { queries: { retry: false } },
  });
  const key = [['entity', 'get'], { input: { id: 'e1' }, type: 'query' }];
  const doc = { v: 3, doc: { type: 'doc', content: [] } };
  client.setQueryData(key, { entity: { bodyDoc: doc, bodyRevision: 3 } });
  expect(granted).toEqual([]);
  await client.fetchQuery({
    queryKey: key,
    queryFn: async () => ({ entity: { bodyDoc: structuredClone(doc), bodyRevision: 4 } }),
  });
  const accepted = client.getQueryData<{ entity: { bodyDoc: object; bodyRevision: number } }>(key);
  expect(accepted?.entity.bodyDoc).toBe(doc);
  expect(accepted?.entity.bodyRevision).toBe(4);
  expect(granted).toEqual([{ current: true, doc }]);
  let reply!: (value: unknown) => void;
  const old = client.fetchQuery({
    queryKey: key,
    queryFn: () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  });
  resetUndoSession();
  reply({ entity: { bodyDoc: structuredClone(doc), bodyRevision: 5 } });
  await old;
  expect(granted.at(-1)).toEqual({ current: false, doc });
  client.clear();
});

import { parseBody } from '@orbis/shared/doc';
import { getQueryKey } from '@trpc/react-query';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { isBodyPending, markBodyPending } from './body-provenance';

test('R56 actual producer lostresponse then current freshread preserves shareddoc identity and confirms revision', async () => {
  let client!: QueryClient;
  let mutation!: ReturnType<typeof useEntityUpdate>;
  function Host() {
    client = useQueryClient();
    mutation = useEntityUpdate('e1');
    return null;
  }
  let fail!: (error: unknown) => void;
  const { calls } = renderWithProviders(
    <Host />,
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const key = getQueryKey(trpc.entity.get, detailGetInput('e1'), 'query');
  const base = { entity: { id: 'e1', props: {}, bodyDoc: parseBody('base'), bodyRevision: 3 } };
  client.setQueryData(key, base);
  const doc = parseBody('own typed');
  act(() =>
    mutation.mutation.mutate({
      id: 'e1',
      bodyDoc: doc as RouterInputs['entity']['update']['bodyDoc'],
      autosave: true,
      expectedBodyRevision: 3,
    }),
  );
  await waitFor(() => expect(calls).toHaveLength(1));
  const optimistic = (client.getQueryData(key) as typeof base).entity.bodyDoc;
  expect(isBodyPending(optimistic)).toBe(true);
  resetUndoSession();
  await act(async () => fail(new Error('lost response')));
  expect(isBodyPending(optimistic)).toBe(true);
  await client.fetchQuery({
    queryKey: key,
    queryFn: async () => ({
      entity: { ...base.entity, bodyDoc: structuredClone(doc), bodyRevision: 4 },
    }),
  });
  const fresh = client.getQueryData(key) as typeof base;
  expect(fresh.entity.bodyDoc).toBe(optimistic);
  expect(fresh.entity.bodyRevision).toBe(4);
  expect(isBodyPending(fresh.entity.bodyDoc)).toBe(false);
  markBodyPending(fresh.entity.bodyDoc);
  client.setQueryData(key, structuredClone(fresh));
  expect(isBodyPending((client.getQueryData(key) as typeof base).entity.bodyDoc)).toBe(true);
});
test('R56 oldfetch new untagged doc cannot grant; canceled old/new flight only current grants', async () => {
  const client = makeQueryClient({ staleTime: 0 });
  const key = [['entity', 'get'], { input: { id: 'e1' }, type: 'query' }];
  let reply!: (data: unknown) => void;
  const old = client.fetchQuery({
    queryKey: key,
    queryFn: () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  });
  resetUndoSession();
  const equalCurrentDisk = parseBody('current owner draft');
  reply({ entity: { bodyDoc: equalCurrentDisk, bodyRevision: 5 } });
  await old;
  const cached = client.getQueryData(key) as { entity: { bodyDoc: object } };
  expect(isBodyPending(cached.entity.bodyDoc)).toBe(true);
  let canceledReply!: (data: unknown) => void;
  const canceled = client.fetchQuery({
    queryKey: key,
    queryFn: () =>
      new Promise((resolve) => {
        canceledReply = resolve;
      }),
  });
  await client.cancelQueries({ queryKey: key });
  await expect(canceled).resolves.toBe(cached);
  resetUndoSession();
  await client.fetchQuery({
    queryKey: key,
    queryFn: async () => ({
      entity: { bodyDoc: structuredClone(equalCurrentDisk), bodyRevision: 6 },
    }),
  });
  const accepted = client.getQueryData(key) as {
    entity: { bodyDoc: object; bodyRevision: number };
  };
  expect(accepted.entity.bodyRevision).toBe(6);
  expect(isBodyPending(accepted.entity.bodyDoc)).toBe(false);
  canceledReply({ entity: { bodyDoc: parseBody('old reply'), bodyRevision: 99 } });
  await Promise.resolve();
  expect(client.getQueryData(key)).toBe(accepted);
  expect(isBodyPending(accepted.entity.bodyDoc)).toBe(false);
  client.clear();
});
