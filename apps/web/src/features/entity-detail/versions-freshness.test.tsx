import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { Toaster } from '../../ui/Toast';
import { runUndo } from '../undo/undo-action';
import { VersionsCard } from './VersionsCard';

const entity = wireEntity({
  id: 'e1',
  title: 'Приёмка V-1',
  body: 'нынешний текст',
  bodyRevision: 3,
});
const pinned = {
  id: 'v1',
  entityId: 'e1',
  label: 'исходный текст',
  hasDoc: true,
  actorKind: 'owner',
  createdAt: '2026-10-18T10:00:00.000Z',
};
const insurance = {
  ...pinned,
  id: 'v2',
  label: 'перед восстановлением: исходный текст',
  createdAt: '2026-10-18T11:00:00.000Z',
};

test('V-1: открытый список показывает серверную страховку после restore и убирает её после Undo без reload', async () => {
  let versions = [pinned];
  renderWithProviders(
    <>
      <VersionsCard entity={entity} active />
      <Toaster />
    </>,
    (path) => {
      if (path === 'version.list') return versions;
      if (path === 'version.restore') {
        versions = [insurance, pinned];
        return {
          ...entity,
          body: 'исходный текст',
          bodyRevision: 4,
          actionId: 'restore1',
          consequences: true,
        };
      }
      if (path === 'ai.undo') {
        versions = [pinned];
        return {
          actionId: 'undo1',
          undone: { id: 'restore1', title: 'Тело восстановлено' },
          pinnedVersions: [],
          bodyRevisions: [{ entityId: 'e1', bodyRevision: 5 }],
        };
      }
      return {};
    },
    { queries: { staleTime: Infinity } },
  );
  const card = screen.getByTestId('versions-card');
  await within(card).findByText('исходный текст');
  await userEvent.click(within(card).getByRole('button', { name: 'Восстановить' }));
  await userEvent.click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Восстановить' }),
  );
  expect(await within(card).findByText(insurance.label)).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
  await screen.findByText('Отменено: Тело восстановлено');
  await waitFor(() => expect(within(card).queryByText(insurance.label)).not.toBeInTheDocument());
  expect(within(card).getByText(pinned.label)).toBeInTheDocument();
});

test('принудительная Undo обновляет открытый список серверной страховкой текста владельца', async () => {
  const saved = { ...insurance, label: 'перед отменой: Приёмка V-1' };
  let versions = [pinned];
  renderWithProviders(
    <VersionsCard entity={entity} active />,
    (path, input) => {
      if (path === 'version.list') return versions;
      if (path === 'ai.undo') {
        expect(input).toEqual({ actionId: 'agent1', force: true });
        versions = [saved, pinned];
        return {
          actionId: 'undo1',
          undone: { id: 'agent1', title: 'Текст агента' },
          pinnedVersions: [{ id: saved.id, entityId: 'e1', label: saved.label }],
          bodyRevisions: [{ entityId: 'e1', bodyRevision: 4 }],
        };
      }
      return {};
    },
    { queries: { staleTime: Infinity } },
  );
  await screen.findByText(pinned.label);
  await act(async () => {
    expect((await runUndo('agent1', { force: true, entityIds: [] })).kind).toBe('undone');
  });
  expect(await screen.findByText(saved.label)).toBeInTheDocument();
});
