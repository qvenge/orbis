import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders, trpcError } from '../../test/harness';
import { OnboardingGate } from './OnboardingGate';

const settings = {
  graphId: 'u1',
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

// seedOnboarding вызывается безусловно раз за сессию: признак «граф заведён» — оболочка хоста, а не
// строка настроек (срез 1б §8.6); на заведённом графе сервер отвечает {seeded:false} и ничего не пишет.
test('повторный вход: seedOnboarding вызван, рендер не ждёт его; после ответа — refetch настроек', async () => {
  let seedDone = false;
  const { calls } = renderWithProviders(
    <OnboardingGate>
      <div data-testid="app">app</div>
    </OnboardingGate>,
    (path) => {
      if (path === 'user.getSettings')
        return seedDone ? { ...settings, installedViews: ['orbis-budget'] } : settings;
      if (path === 'user.seedOnboarding') {
        // Медленный ответ: рендер приложения не должен его ждать
        return new Promise((resolve) =>
          setTimeout(() => {
            seedDone = true;
            resolve({ seeded: false });
          }, 50),
        );
      }
      throw new Error(`unexpected ${path}`);
    },
  );
  // Приложение рендерится, пока мутация ещё висит
  await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
  expect(calls.some((c) => c.path === 'user.seedOnboarding')).toBe(true);
  // После ответа настройки перечитаны
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'user.getSettings').length).toBeGreaterThan(1),
  );
});

test('повторный вход С настройками: seedOnboarding всё равно вызван (безусловность), рендер не заблокирован', async () => {
  const { calls } = renderWithProviders(
    <OnboardingGate>
      <div data-testid="app">app</div>
    </OnboardingGate>,
    (path) => {
      if (path === 'user.getSettings') return { ...settings, installedViews: ['orbis-budget'] };
      if (path === 'user.seedOnboarding') return new Promise(() => {}); // никогда не отвечает
      throw new Error(`unexpected ${path}`);
    },
  );
  await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
  expect(calls.some((c) => c.path === 'user.seedOnboarding')).toBe(true);
  expect(screen.queryByTestId('onboarding-splash')).not.toBeInTheDocument();
});

test('фоновый seedOnboarding упал у пользователя С настройками: приложение рендерится, alert не показывается', async () => {
  renderWithProviders(
    <OnboardingGate>
      <div data-testid="app">app</div>
    </OnboardingGate>,
    (path) => {
      if (path === 'user.getSettings') return settings;
      if (path === 'user.seedOnboarding') throw trpcError('INTERNAL_SERVER_ERROR');
      throw new Error(`unexpected ${path}`);
    },
  );
  await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

// Срез 1б (Э-18, R-19): граф старой формы — сервер отвечает CONFLICT, и экран перевода показывается
// даже при существующей строке настроек: фоновый отказ здесь обязан остановить приложение.
test('граф старой формы: seedOnboarding → CONFLICT при существующих настройках — экран перевода, приложение не рисуется', async () => {
  renderWithProviders(
    <OnboardingGate>
      <div data-testid="app">app</div>
    </OnboardingGate>,
    (path) => {
      if (path === 'user.getSettings') return settings;
      if (path === 'user.seedOnboarding') throw trpcError('CONFLICT');
      throw new Error(`unexpected ${path}`);
    },
  );
  await waitFor(() =>
    expect(
      screen.getByText('Граф старой формы: его переводит только пересев мира —'),
    ).toBeInTheDocument(),
  );
  // `migrate-1b` снят срезом 1в (РП-13): экран отсылает к ранбуку, не к снятой команде.
  expect(
    screen.getByText('docs/implementation/02-ops-runbook.md, раздел reset-world'),
  ).toBeInTheDocument();
  expect(screen.queryByText(/migrate-1b/)).toBeNull();
  expect(screen.queryByTestId('app')).not.toBeInTheDocument();
});

test('иной отказ seedOnboarding без настроек — прежний «Не удалось загрузить настройки», экрана перевода нет', async () => {
  renderWithProviders(
    <OnboardingGate>
      <div data-testid="app">app</div>
    </OnboardingGate>,
    (path) => {
      if (path === 'user.getSettings') throw trpcError('NOT_FOUND');
      if (path === 'user.seedOnboarding') throw trpcError('INTERNAL_SERVER_ERROR');
      throw new Error(`unexpected ${path}`);
    },
  );
  await waitFor(() =>
    expect(
      screen.getByText('Не удалось загрузить настройки. Повторите позже.'),
    ).toBeInTheDocument(),
  );
  expect(screen.queryByText('Граф нужно перевести на новую версию:')).not.toBeInTheDocument();
});
