import { parseBody } from '@orbis/shared/doc';
import { useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { useEffect } from 'react';
import { afterEach, expect, it } from 'vitest';
import {
  type BodyPublication,
  freshnessRuntimeOf,
  recordDiskRead,
} from '../../lib/freshness/provenance';
import { browserInputStorage, configureInputAccess } from '../../lib/local-data/input-access';
import { testFreshnessOf } from '../../test/freshness';
import { fixtureFreshness, renderWithProviders, wireEntity } from '../../test/harness';
import { trpc } from '../../trpc';
import {
  captureDraftWriter,
  listDraftsIn,
  readDraft,
  setDraftScope,
} from '../entity-editor/draft-storage';
import { type BodySave, type BodySaveEntity, useBodySave } from '../entity-editor/useBodySave';
import { isBodyPending } from '../undo/body-provenance';
import { undoEpoch } from '../undo/undo-epoch';
import { detailGetInput } from './detail-input';

const id = '00000000-0000-4000-8000-000000000001';
const A = parseBody('server A');
const B = parseBody('persisted user B');
const C = parseBody('foreign server C');
const owner = 'owner';
const key = getQueryKey(trpc.entity.get, detailGetInput(id), 'query');
const detail = (revision: number, body: typeof A) => ({
  entity: wireEntity({ id, title: 'Recovery', bodyDoc: body, bodyRevision: revision }),
  freshness: { ...fixtureFreshness, entityIds: [id] },
  bodyAction: null,
  registryVersion: '1',
});
const sessions: AbortController[] = [];
afterEach(() => {
  sessions.splice(0).forEach((controller) => {
    controller.abort();
  });
  configureInputAccess(undefined);
  setDraftScope('');
  sessionStorage.clear();
  localStorage.clear();
});
function openInputSession() {
  const controller = new AbortController();
  sessions.push(controller);
  configureInputAccess({
    storage: browserInputStorage(sessionStorage),
    prefix: 'probe:',
    isCurrent: () => !controller.signal.aborted,
    drafts: {
      scope: { accountId: owner, graphId: owner, generation: '0:0' },
      persistent: false,
      signal: controller.signal,
    },
  });
  return controller;
}

it.each([
  'held network',
  'ordinary old shown basis',
  'ordinary latest shown C',
  'confirmed after rewind',
] as const)('public recovery with %s', async (variant) => {
  setDraftScope(owner);
  const first = openInputSession();
  const priorWriter = captureDraftWriter(id).managed;
  if (!priorWriter) throw new Error('Expected managed input');
  const submitted = priorWriter.stage(B, 2);
  if (!submitted) throw new Error('Expected staged B');
  expect(priorWriter.preserve()).toBe(true);
  expect(listDraftsIn(browserInputStorage(sessionStorage), owner, 'probe:')[0]?.draft.slot).toBe(
    submitted.token.nonce,
  );
  first.abort();
  openInputSession();

  let resolveRead!: (reply: unknown) => void;
  const network = new Promise((resolve) => {
    resolveRead = resolve;
  });
  let reads = 0;
  let clicks = 0;
  const receipts: BodyPublication[] = [];
  let api!: BodySave;
  function Editor({ record }: { record: BodySaveEntity }) {
    const save = useBodySave(id, record);
    api = save;
    useEffect(() => {
      // The editor keeps its previously shown A while the background GET accepts C.
      if (record.bodyRevision === 2) save.onShown(2, A);
    }, [record.bodyRevision, save.onShown]);
    return save.pendingDraft ? (
      <button
        type="button"
        onClick={() => {
          clicks++;
          save.applyPendingDraft();
        }}
      >
        Оставить моё
      </button>
    ) : null;
  }
  function Probe() {
    const client = useQueryClient();
    freshnessRuntimeOf(client)?.setSinks({
      acceptBody(receipt) {
        receipts.push(receipt);
      },
    });
    const read = trpc.entity.get.useQuery(detailGetInput(id));
    const record = read.data?.entity;
    return record ? (
      <Editor record={{ ...record, bodyRevision: record.bodyRevision ?? 0 }} />
    ) : null;
  }
  const view = renderWithProviders(
    <Probe />,
    (path) => {
      if (path === 'entity.get') {
        if (++reads > 1) return network;
        const raw = detail(2, A);
        recordDiskRead(raw, {
          source: 'disk',
          scope: { accountId: owner, graphId: owner, epoch: undoEpoch() },
          receivedAt: Date.now() - 1000,
        });
        return raw;
      }
      if (path === 'entity.update') return { ...detail(4, B).entity, txId: '40' };
      throw new Error(path);
    },
    { freshness: true, queries: { staleTime: Infinity } },
  );
  const feed = testFreshnessOf(view.queryClient);
  const writes = () => view.calls.filter(({ path }) => path === 'entity.update');
  try {
    await screen.findByRole('button', { name: 'Оставить моё' });
    await waitFor(() => expect(reads).toBe(2));
    expect(api.pendingDraft?.doc).toEqual(B);
    expect(
      isBodyPending(view.queryClient.getQueryData<ReturnType<typeof detail>>(key)?.entity.bodyDoc),
    ).toBe(true);
    expect(writes()).toHaveLength(0);
    if (variant === 'confirmed after rewind') {
      act(() => {
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
      });
    }
    if (variant !== 'held network') {
      await act(async () => resolveRead(detail(3, C)));
      await waitFor(() =>
        expect(
          view.queryClient.getQueryData<ReturnType<typeof detail>>(key)?.entity.bodyRevision,
        ).toBe(3),
      );
      expect(
        isBodyPending(
          view.queryClient.getQueryData<ReturnType<typeof detail>>(key)?.entity.bodyDoc,
        ),
      ).toBe(false);
    }
    if (variant === 'ordinary latest shown C') act(() => api.onShown(3, C));
    fireEvent.click(screen.getByRole('button', { name: 'Оставить моё' }));
    expect(clicks).toBe(1);
    if (variant === 'held network') {
      await act(async () => {});
      expect(writes()).toHaveLength(0);
      expect(readDraft(id)?.doc).toEqual(B);
    } else {
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]?.input).toMatchObject({
        id,
        bodyDoc: B,
        expectedBodyRevision: 3,
        autosave: true,
      });
      await waitFor(() => expect(receipts).toHaveLength(1));
      expect(receipts[0]).toMatchObject({
        entityId: id,
        expectedBodyRevision: 3,
        draftToken: submitted.token.nonce,
        result: { bodyRevision: 4, bodyDoc: B },
      });
    }
  } finally {
    view.unmount();
    resolveRead(detail(3, C));
  }
});
