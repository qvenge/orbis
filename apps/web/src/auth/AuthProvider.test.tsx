import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: { auth: { signOut: vi.fn(), signInWithPassword: vi.fn() } },
  useSession: vi.fn(),
}));

import { AuthProvider, useAuth } from './AuthProvider';
import { emitClientOutdated } from './events';
import { useSession } from './supabase';

// biome-ignore lint/suspicious/noExplicitAny: свободная форма сессии для стаба
const mockSession = (v: any) =>
  (useSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(v);

function Child() {
  const { userId } = useAuth();
  return <div data-testid="child">user:{userId}</div>;
}

beforeEach(() => vi.clearAllMocks());

test('anon → LoginScreen', () => {
  mockSession({ token: null, userId: null, status: 'anon' });
  render(
    <AuthProvider>
      <Child />
    </AuthProvider>,
  );
  expect(screen.getByTestId('login-screen')).toBeInTheDocument();
  expect(screen.queryByTestId('child')).not.toBeInTheDocument();
});

test('authed → children с userId в контексте', () => {
  mockSession({ token: 'jwt', userId: 'u1', status: 'authed' });
  render(
    <AuthProvider>
      <Child />
    </AuthProvider>,
  );
  expect(screen.getByTestId('child')).toHaveTextContent('user:u1');
});

test('emitClientOutdated → экран «обновите приложение»', () => {
  mockSession({ token: 'jwt', userId: 'u1', status: 'authed' });
  render(
    <AuthProvider>
      <Child />
    </AuthProvider>,
  );
  act(() => emitClientOutdated());
  expect(screen.getByTestId('update-required')).toBeInTheDocument();
  expect(screen.queryByTestId('child')).not.toBeInTheDocument();
});
