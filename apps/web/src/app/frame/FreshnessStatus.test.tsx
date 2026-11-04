import { screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { FreshnessStatus } from './FreshnessStatus';

const freshness = vi.hoisted(() => ({
  online: false,
  updating: false,
  hasCopy: true,
  receivedAt: Date.UTC(2026, 0, 1, 9, 30) as number | null,
  hasVisible: true,
  old: false,
  finance: false,
}));

vi.mock('../../lib/freshness/screen', async (load) => ({
  ...(await load<typeof import('../../lib/freshness/screen')>()),
  useFreshnessScreen: () => freshness,
}));

afterEach(() => {
  freshness.online = false;
  freshness.updating = false;
  freshness.hasCopy = true;
  freshness.receivedAt = Date.UTC(2026, 0, 1, 9, 30);
});

test('the complete saved screen shows its age offline', () => {
  renderWithProviders(<FreshnessStatus />);
  expect(screen.getByRole('status')).toHaveTextContent(/^нет сети · экран на \d{2}:\d{2}$/);
});

test('a partial saved screen still shows its age and the missing data', () => {
  freshness.hasCopy = false;
  renderWithProviders(<FreshnessStatus />);
  expect(screen.getByRole('status')).toHaveTextContent(
    /^нет сети · экран на \d{2}:\d{2} · часть данных недоступна$/,
  );
});

test('offline without any saved snapshot says there is no saved copy', () => {
  freshness.hasCopy = false;
  freshness.receivedAt = null;
  renderWithProviders(<FreshnessStatus />);
  expect(screen.getByRole('status')).toHaveTextContent(/^нет сети · нет сохранённой копии$/);
});

test('online refresh keeps its own status', () => {
  freshness.online = true;
  freshness.updating = true;
  renderWithProviders(<FreshnessStatus />);
  expect(screen.getByRole('status')).toHaveTextContent(/^обновляется$/);
});
