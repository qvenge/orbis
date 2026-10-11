import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { resetRegistryVersionForTests } from '../../../lib/registry/useRegistry';
import { renderWithProviders, trpcError } from '../../../test/harness';
import { registryReply } from '../../../test/registry';
import { Toaster } from '../../../ui/Toast';
import { useToastStore } from '../../../ui/toast-store';
import { registerBodyFlush } from '../../entity-editor/body-flush';
import { resetUndoSession } from '../../undo/undo-epoch';
import { peekUndoable } from '../../undo/undo-stack';
import { CONTINUE_UNDO } from '../../undo/undo-toast';
import type { PanelCommand } from './types';
import { usePanelCommands } from './useCommands';

const id = '00000000-0000-4000-8000-000000000010';
const actionId = '00000000-0000-4000-8000-000000000100';
const command: PanelCommand = {
  kind: 'values',
  entityId: id,
  patch: { props: { 'user/name': 'Новое' } },
};
function Probe({ value = command }: { value?: PanelCommand }) {
  const { run } = usePanelCommands();
  const [outcome, setOutcome] = useState<unknown>();
  return (
    <>
      <button type="button" onClick={() => void run(value).then(setOutcome)}>
        Записать
      </button>
      <output data-testid="outcome">{JSON.stringify(outcome)}</output>
      <Toaster />
    </>
  );
}
beforeEach(() => {
  resetUndoSession();
  resetRegistryVersionForTests();
});
afterEach(() => resetUndoSession());

test('panel receipt enters current global stack and uses shared body settlement and structured Undo continuation', async () => {
  let release!: () => void;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const off = registerBodyFlush(id, async () => {
    await settled;
    return 'saved';
  });
  let undoCalls = 0;
  const { calls } = renderWithProviders(<Probe />, (path) => {
    if (path === 'entity.updateBatch') return { actionId, consequences: false };
    if (path === 'ai.undo') {
      if (++undoCalls === 1)
        throw trpcError('CONFLICT', 'private', {
          code: 'UNDO_TEXT_CHANGED',
          details: {
            action: { id: actionId, title: 'Свойства' },
            continuation: { kind: 'here' },
            entries: [
              {
                entityId: id,
                title: 'Запись',
                actorKind: 'owner',
                actorLabel: null,
                at: '2026-10-11T00:00:00Z',
              },
            ],
          },
        });
      return {
        actionId: 'undo-receipt',
        undone: { id: actionId, title: 'Свойства' },
        pinnedVersions: [],
        bodyRevisions: [],
      };
    }
    return registryReply(path) ?? {};
  });
  try {
    fireEvent.click(screen.getByText('Записать'));
    await screen.findByRole('button', { name: 'Отменить' });
    expect(peekUndoable()?.actionId).toBe(actionId);
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
    expect(calls.filter((call) => call.path === 'ai.undo')).toHaveLength(0);
    await act(async () => {
      release();
      await settled;
    });
    fireEvent.click(await screen.findByRole('button', { name: CONTINUE_UNDO }));
    await screen.findByText('Отменено: Свойства');
    expect(calls.filter((call) => call.path === 'ai.undo').map((call) => call.input)).toEqual([
      { actionId },
      { actionId, force: true },
    ]);
    expect(peekUndoable()).toBeUndefined();
  } finally {
    off();
  }
});

test.each([
  { actionId, consequences: false },
  { actionId, consequences: true },
  { actionId },
  { actionId, consequences: 'false' },
])('panel registers only a current JournalRef receipt: %j', async (receipt) => {
  renderWithProviders(<Probe />, (path) =>
    path === 'entity.updateBatch' ? receipt : (registryReply(path) ?? {}),
  );
  fireEvent.click(screen.getByText('Записать'));
  await screen.findByText('Сохранены свойства');
  if (typeof receipt.consequences === 'boolean') {
    expect(peekUndoable()?.actionId).toBe(actionId);
    await screen.findByRole('button', { name: 'Отменить' });
  } else {
    expect(peekUndoable()).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Отменить' })).toBeNull();
  }
});

test.each([
  'values',
  'createRelation',
] as const)('late vanilla %s receipt after session reset has no toast or stack entry', async (kind) => {
  let release!: (value: unknown) => void;
  const deferred = new Promise((resolve) => {
    release = resolve;
  });
  const value: PanelCommand =
    kind === 'values'
      ? command
      : {
          kind,
          entityId: id,
          key: {
            source_id: id,
            target_id: '00000000-0000-4000-8000-000000000020',
            role: 'mention',
          },
        };
  const { calls } = renderWithProviders(<Probe value={value} />, (path) => {
    if (path === 'entity.updateBatch' || path === 'relation.create') return deferred;
    return registryReply(path) ?? {};
  });
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() =>
    expect(
      calls.some(
        (call) => call.path === (kind === 'values' ? 'entity.updateBatch' : 'relation.create'),
      ),
    ).toBe(true),
  );
  act(() => resetUndoSession());
  await act(async () => {
    release({ actionId, consequences: false });
    await deferred;
  });
  await waitFor(() => expect(screen.getByTestId('outcome')).not.toHaveTextContent('confirmed'));
  expect(useToastStore.getState().toasts).toEqual([]);
  expect(peekUndoable()).toBeUndefined();
});
