import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import type { RouterOutputs } from '../../trpc';
import { GeneralForm } from './GeneralForm';

const settings = {
  timezone: 'UTC',
  defaultCurrency: 'RUB',
  weekStartDay: 'monday',
} as RouterOutputs['user']['getSettings'];
function Host() {
  const [accepted, setAccepted] = useState(settings);
  return (
    <>
      <GeneralForm settings={accepted} />
      <button type="button" onClick={() => setAccepted({ ...settings, timezone: 'Asia/Barnaul' })}>
        Принять первое
      </button>
      <button type="button" onClick={() => setAccepted({ ...settings, timezone: 'Europe/Moscow' })}>
        Принять второе
      </button>
    </>
  );
}
test('принятые настройки обновляют чистую форму, но сохраняют живой черновик', () => {
  renderWithProviders(<Host />);
  expect(screen.getByLabelText('Таймзона')).toHaveValue('UTC');
  fireEvent.click(screen.getByText('Принять первое'));
  expect(screen.getByLabelText('Таймзона')).toHaveValue('Asia/Barnaul');
  fireEvent.change(screen.getByLabelText('Таймзона'), { target: { value: 'draft' } });
  fireEvent.click(screen.getByText('Принять второе'));
  expect(screen.getByLabelText('Таймзона')).toHaveValue('draft');
});

import { act, waitFor } from '@testing-library/react';
import { trpc } from '../../trpc';
import { Toaster } from '../../ui/Toast';
import { peekUndoable } from '../undo/undo-stack';
import { useUndoHotkey } from '../undo/useUndoHotkey';

function SettingsScreen() {
  useUndoHotkey();
  const query = trpc.user.getSettings.useQuery();
  return (
    <>
      <Toaster />
      {query.data && <GeneralForm settings={query.data} />}
    </>
  );
}
test('real runUndo перечитывает принятую чистую форму без ложной повторной записи', async () => {
  let current = settings;
  const { calls } = renderWithProviders(<SettingsScreen />, (path, input) => {
    if (path === 'user.getSettings') return current;
    if (path === 'user.updateSettings') {
      current = { ...current, ...(input as object) };
      return { ...current, actionId: 'settings', consequences: false };
    }
    if (path === 'ai.undo') {
      current = settings;
      return {
        actionId: 'undo',
        undone: { id: 'settings', title: 'Настройки' },
        pinnedVersions: [],
        bodyRevisions: [],
      };
    }
    return {};
  });
  const field = await screen.findByLabelText('Таймзона');
  fireEvent.change(field, { target: { value: 'Europe/Moscow' } });
  fireEvent.click(screen.getByText('Сохранить'));
  await waitFor(() => expect(calls.filter((c) => c.path === 'user.getSettings')).toHaveLength(2));
  await waitFor(() => expect(peekUndoable()?.actionId).toBe('settings'));
  fireEvent.keyDown(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true });
  await screen.findByText('Отменено: Настройки');
  await waitFor(() => expect(field).toHaveValue('UTC'));
  fireEvent.click(screen.getByText('Сохранить'));
  expect(calls.filter((c) => c.path === 'user.updateSettings')).toHaveLength(1);
});
test('живой черновик после отправки сохраняется при accepted refetch', async () => {
  let current = settings;
  let finish!: (value: unknown) => void;
  const { calls } = renderWithProviders(<SettingsScreen />, (path, input) => {
    if (path === 'user.getSettings') return current;
    if (path === 'user.updateSettings') {
      current = { ...current, ...(input as object) };
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return {};
  });
  const field = await screen.findByLabelText('Таймзона');
  fireEvent.change(field, { target: { value: 'Europe/Moscow' } });
  fireEvent.click(screen.getByText('Сохранить'));
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.change(field, { target: { value: 'Asia/Barnaul' } });
  await act(async () => finish({ ...current, actionId: 'settings', consequences: false }));
  await waitFor(() => expect(calls.filter((c) => c.path === 'user.getSettings')).toHaveLength(2));
  expect(field).toHaveValue('Asia/Barnaul');
});
