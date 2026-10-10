import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/harness';
import { PropertiesRelationsPanel } from './PropertiesRelationsPanel';
import { entity, registry } from './test-fixtures';

const controller = vi.hoisted(() => ({ runs: 0, reads: 0, release: (_value: string) => {} }));
vi.mock('./useCommands', () => ({
  usePanelCommands: () => ({
    run: async () => {
      controller.runs++;
      return { kind: 'unknown', message: 'unknown' };
    },
    reconcile: async () => {
      controller.reads++;
      if (controller.reads === 1) return 'differs';
      if (controller.reads === 2)
        return new Promise((resolve) => {
          controller.release = resolve;
        });
      return 'unavailable';
    },
  }),
}));
beforeEach(() => {
  controller.runs = 0;
  controller.reads = 0;
});
it.each([
  'changed',
  'identical',
])('old C1 check never publishes into %s C2 attempt in the same editor epoch', async (kind) => {
  renderWithProviders(
    <PropertiesRelationsPanel
      target={{ entityId: entity.id, readOnly: false }}
      host={{ screenEntityId: entity.id, available: new Set(), run: () => {} }}
      onClose={() => {}}
    />,
    (path) =>
      path === 'registry.effective'
        ? registry
        : path === 'entity.get'
          ? { entity, relations: [], registryVersion: registry.version }
          : [],
  );
  fireEvent.click(await screen.findByRole('tab', { name: 'Свойства' }));
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать свойства' }));
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'first' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await screen.findByText('Проверьте ввод и сохраните явно ещё раз.');
  fireEvent.click(screen.getByRole('button', { name: 'Проверить состояние' }));
  await waitFor(() => expect(controller.reads).toBe(2));
  if (kind === 'changed')
    fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'second' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await screen.findByText(
    'Не удалось прочитать текущее состояние. Повторное сохранение недоступно.',
  );
  expect(controller.runs).toBe(2);
  await act(async () => controller.release('matches'));
  expect(screen.queryByRole('button', { name: 'Принять текущее состояние' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  expect(screen.getByLabelText('Поле теста')).toHaveValue(kind === 'changed' ? 'second' : 'first');
});
