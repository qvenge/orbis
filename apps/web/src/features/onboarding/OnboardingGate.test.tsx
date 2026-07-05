import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders, trpcError } from '../../test/harness';
import { OnboardingGate } from './OnboardingGate';

const settings = {
  ownerId: 'u1',
  plan: 'dev',
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 'monday',
  tagColors: {},
  installedViews: [],
  pinnedEntities: [],
  viewPreferences: {},
  updatedAt: '2026-07-05T00:00:00.000Z',
};

test('первый вход: getSettings NOT_FOUND → seedOnboarding → рендер детей', async () => {
  let seeded = false;
  const { calls } = renderWithProviders(
    <OnboardingGate>
      <div data-testid="app">app</div>
    </OnboardingGate>,
    (path) => {
      if (path === 'user.getSettings') {
        if (!seeded) throw trpcError('NOT_FOUND');
        return settings;
      }
      if (path === 'user.seedOnboarding') {
        seeded = true;
        return { seeded: true };
      }
      throw new Error(`unexpected ${path}`);
    },
  );
  await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
  expect(calls.some((c) => c.path === 'user.seedOnboarding')).toBe(true);
});

test('повторный вход: settings есть сразу → seedOnboarding НЕ вызывается', async () => {
  const { calls } = renderWithProviders(
    <OnboardingGate>
      <div data-testid="app">app</div>
    </OnboardingGate>,
    (path) => {
      if (path === 'user.getSettings') return settings;
      throw new Error(`unexpected ${path}`);
    },
  );
  await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
  expect(calls.some((c) => c.path === 'user.seedOnboarding')).toBe(false);
});

test('ошибка seedOnboarding: ветка восстановления (не splash), «Повторить» повторяет мутацию', async () => {
  const { calls } = renderWithProviders(
    <OnboardingGate>
      <div data-testid="app">app</div>
    </OnboardingGate>,
    (path) => {
      if (path === 'user.getSettings') throw trpcError('NOT_FOUND');
      if (path === 'user.seedOnboarding') throw trpcError('INTERNAL_SERVER_ERROR');
      throw new Error(`unexpected ${path}`);
    },
  );

  // seed упал → показывается alert-восстановление, а не вечный splash
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  expect(screen.queryByTestId('onboarding-splash')).not.toBeInTheDocument();

  const seedCallsBefore = calls.filter((c) => c.path === 'user.seedOnboarding').length;
  expect(seedCallsBefore).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'user.seedOnboarding').length).toBeGreaterThan(
      seedCallsBefore,
    ),
  );
});
