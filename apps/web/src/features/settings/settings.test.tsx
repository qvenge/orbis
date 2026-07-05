import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { ExportButton } from './ExportButton';
import { GeneralForm } from './GeneralForm';

const settings = {
  ownerId: 'u',
  plan: 'dev',
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 'monday',
  tagColors: {},
  installedViews: [],
  pinnedEntities: [],
  viewPreferences: {},
  updatedAt: 'x',
};

test('GeneralForm сабмитит частичный апдейт (только изменённый timezone)', async () => {
  const { calls } = renderWithProviders(<GeneralForm settings={settings as never} />, (path) =>
    path === 'user.updateSettings' ? settings : {},
  );
  fireEvent.change(screen.getByLabelText(/таймзона/i), { target: { value: 'UTC' } });
  fireEvent.submit(screen.getByTestId('general-form'));
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'user.updateSettings');
    // Строгий toEqual: стережёт «шлём только изменённые поля» — упал бы при регрессе на полный объект.
    expect(c?.input).toEqual({ timezone: 'UTC' });
  });
});

beforeEach(() => {
  // jsdom не имеет createObjectURL
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:x'),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
});

test('ExportButton формирует Blob с format:orbis-export', async () => {
  const createObjectURL = URL.createObjectURL as ReturnType<typeof vi.fn>;
  renderWithProviders(<ExportButton />, (path) =>
    path === 'user.exportData'
      ? {
          format: 'orbis-export',
          version: 1,
          exportedAt: 'x',
          entities: [],
          relations: [],
          chatThreads: [],
          chatMessages: [],
          userSettings: settings,
          aspectDefinitions: [],
        }
      : {},
  );
  fireEvent.click(screen.getByRole('button', { name: /экспорт/i }));
  await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
  const text = await blob.text();
  expect(JSON.parse(text).format).toBe('orbis-export');
});
