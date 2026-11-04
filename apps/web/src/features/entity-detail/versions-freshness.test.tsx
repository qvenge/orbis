import type { Change } from '@orbis/shared';
import { parseBody } from '@orbis/shared/doc';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test } from 'vitest';
import { testFreshnessOf } from '../../test/freshness';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { trpc } from '../../trpc';
import { Toaster } from '../../ui/Toast';
import { runUndo } from '../undo/undo-action';
import { resetUndoSession } from '../undo/undo-epoch';
import { detailGetInput } from './useEntityDetail';
import { VersionsCard } from './VersionsCard';

beforeEach(resetUndoSession);

const entity = wireEntity({
  id: '019e4466-1000-7e07-b5d4-64be9721da71',
  graphId: 'owner',
  title: 'Приёмка V-1',
  body: 'нынешний текст',
  bodyDoc: parseBody('нынешний текст'),
  bodyRevision: 3,
});
const pinned = {
  id: '019e4466-1000-7e07-b5d4-64be9721da72',
  entityId: entity.id,
  label: 'исходный текст',
  hasDoc: true,
  actorKind: 'owner',
  createdAt: '2026-10-18T10:00:00.000Z',
};
const insurance = {
  ...pinned,
  id: '019e4466-1000-7e07-b5d4-64be9721da73',
  label: 'перед восстановлением: исходный текст',
  createdAt: '2026-10-18T11:00:00.000Z',
};
const restoredAction = '019e4466-1000-7e07-b5d4-64be9721da74';
const undoAction = '019e4466-1000-7e07-b5d4-64be9721da75';
const agentAction = '019e4466-1000-7e07-b5d4-64be9721da76';

function changedBody(text: string, bodyRevision: number) {
  return {
    ...entity,
    body: text,
    bodyDoc: parseBody(text),
    bodyRevision,
    bodyChangedAt: '2026-10-18T12:00:00.000Z',
  };
}

function VersionHost() {
  const detail = trpc.entity.get.useQuery(detailGetInput(entity.id));
  return (
    detail.data && (
      <>
        <VersionsCard entity={detail.data.entity} active />
        <Toaster />
      </>
    )
  );
}

function versionChanges(rowKey: string, operation: 'insert' | 'delete', action?: string) {
  const version = {
    kind: 'version',
    rowKey,
    operation,
    entityIds: [entity.id],
  } satisfies Partial<Change>;
  if (!action) return [{ ...version }];
  const body = {
    kind: 'entity',
    rowKey: entity.id,
    operation: 'update',
    scope: 'body',
    entityIds: [entity.id],
  } satisfies Partial<Change>;
  const journal = {
    kind: 'journal',
    rowKey: action,
    operation: 'insert',
    entityIds: [entity.id],
    graphWide: true,
  } satisfies Partial<Change>;
  return operation === 'insert' ? [version, body, journal] : [body, version, journal];
}

test.each([
  'narrow-after-ack',
  'full-before-ack',
] as const)('V-1: открытый список показывает серверную страховку после restore и убирает её после Undo без reload (%s)', async (delivery) => {
  let versions = [pinned];
  let serverBody = entity;
  let releaseRestore!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseRestore = resolve;
  });
  const { calls, queryClient } = renderWithProviders(
    <VersionHost />,
    async (path, input) => {
      if (path === 'entity.get') return { entity: serverBody, relations: [], thread: null };
      if (path === 'version.list') return versions;
      if (path === 'version.restore') {
        expect(input).toEqual({ versionId: pinned.id, expectedBodyRevision: 3 });
        versions = [insurance, pinned];
        serverBody = changedBody('исходный текст', 4);
        await hold;
        return { ...serverBody, txId: '1', actionId: restoredAction, consequences: true };
      }
      if (path === 'ai.undo') {
        expect(input).toEqual({ actionId: restoredAction });
        versions = [pinned];
        serverBody = changedBody(entity.body, 5);
        return {
          actionId: undoAction,
          undone: { id: restoredAction, title: 'Тело восстановлено' },
          pinnedVersions: [],
          bodyRevisions: [{ entityId: entity.id, bodyRevision: 5 }],
        };
      }
      return {};
    },
    { freshness: true, queries: { staleTime: Infinity } },
  );
  const card = await screen.findByTestId('versions-card');
  await within(card).findByText(pinned.label);
  await userEvent.click(within(card).getByRole('button', { name: 'Восстановить' }));
  await userEvent.click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Восстановить' }),
  );
  await waitFor(() =>
    expect(calls.filter((call) => call.path === 'version.restore')).toHaveLength(1),
  );
  expect(within(card).queryByText(insurance.label)).toBeNull();
  const feed = testFreshnessOf(queryClient);
  const full = delivery === 'full-before-ack';
  const insert = versionChanges(insurance.id, 'insert', full ? restoredAction : undefined);
  if (full) {
    act(() => feed.changes(insert, 1));
    expect(await within(card).findByText(insurance.label)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отменить' })).toBeNull();
  }
  await act(async () => {
    releaseRestore();
    await hold;
  });
  const undo = await screen.findByRole('button', { name: 'Отменить' });
  if (!full) {
    expect(within(card).queryByText(insurance.label)).toBeNull();
    act(() => feed.changes(insert, 1));
    expect(await within(card).findByText(insurance.label)).toBeInTheDocument();
  }
  await userEvent.click(undo);
  await screen.findByText('Отменено: Тело восстановлено');
  expect(within(card).getByText(insurance.label)).toBeInTheDocument();
  act(() => feed.changes(versionChanges(insurance.id, 'delete', full ? undoAction : undefined), 2));
  await waitFor(() => expect(within(card).queryByText(insurance.label)).toBeNull());
  expect(within(card).getByText(pinned.label)).toBeInTheDocument();
  expect(calls.filter((call) => call.path === 'ai.undo')).toHaveLength(1);
});

test('принудительная Undo обновляет открытый список серверной страховкой текста владельца', async () => {
  const saved = { ...insurance, label: 'перед отменой: Приёмка V-1' };
  let versions = [pinned];
  let serverBody = entity;
  const { calls, queryClient } = renderWithProviders(
    <VersionHost />,
    (path, input) => {
      if (path === 'entity.get') return { entity: serverBody, relations: [], thread: null };
      if (path === 'version.list') return versions;
      if (path === 'ai.undo') {
        expect(input).toEqual({ actionId: agentAction, force: true });
        versions = [saved, pinned];
        serverBody = changedBody('до агента', 4);
        return {
          actionId: undoAction,
          undone: { id: agentAction, title: 'Текст агента' },
          pinnedVersions: [{ versionId: saved.id, entityId: entity.id, label: saved.label }],
          bodyRevisions: [{ entityId: entity.id, bodyRevision: 4 }],
        };
      }
      return {};
    },
    { freshness: true, queries: { staleTime: Infinity } },
  );
  await screen.findByText(pinned.label);
  await act(async () => {
    expect((await runUndo(agentAction, { force: true, entityIds: [] })).kind).toBe('undone');
  });
  expect(screen.queryByText(saved.label)).toBeNull();
  act(() => testFreshnessOf(queryClient).changes(versionChanges(saved.id, 'insert'), 1));
  expect(await screen.findByText(saved.label)).toBeInTheDocument();
  expect(calls.filter((call) => call.path === 'ai.undo')).toHaveLength(1);
});
