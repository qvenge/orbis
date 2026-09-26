import { parseBody } from '@orbis/shared/doc';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('./supabase', () => ({
  auth: { signOut: vi.fn(), signInWithPassword: vi.fn() },
  useSession: vi.fn(),
}));
// «Обновить» — через свежий сервис-воркер (Л-5); сама механика — `pwa/fresh-reload.test.ts`.
vi.mock('../pwa/fresh-reload', () => ({ reloadWithFreshWorker: vi.fn(() => Promise.resolve()) }));

import { saveDraft } from '../features/entity-editor/draft-storage';
import { reloadWithFreshWorker } from '../pwa/fresh-reload';
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

beforeEach(() => {
  vi.clearAllMocks();
  // Скоуп черновиков — модульное состояние `draft-storage`, а ключ ложится на диск браузера:
  // без уборки соседний тест читал бы чужой ключ.
  localStorage.clear();
});

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

test('authed → children с userId в контексте, и черновики скоупятся по этому аккаунту', () => {
  mockSession({ token: 'jwt', userId: 'u1', status: 'authed' });
  render(
    <AuthProvider>
      <Child />
    </AuthProvider>,
  );
  expect(screen.getByTestId('child')).toHaveTextContent('user:u1');

  // ПРОВОДКА СКОУПА ЧЕРНОВИКОВ, и проверяется она КЛЮЧОМ НА ДИСКЕ, а не шпионом на вызов:
  // шпион пинит вызов, а вопрос в том, под каким аккаунтом лежит неотправленная заметка.
  // `AuthProvider` — единственное место, откуда скоуп ставится в бою (`setDraftScope`
  // из сессии, рядом с `setRetryScope`); до среза «Г» ту же проводку косвенно держал тест
  // изоляции в `draft.test.tsx`, но он ставил скоуп из поля записи, а ключ записи — ГРАФ
  // (D44), и теперь скоуп идёт от аккаунта. Без этого пина снятие строки в `AuthProvider`
  // оставляло весь веб зелёным, а в общем браузере следующий залогинившийся видел бы чужую
  // неотправленную заметку под общим ключом `orbis:body-draft::e1`.
  saveDraft(
    'e1',
    parseBody('неотправленная правка'),
    '2026-01-01T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z',
  );
  expect(localStorage.getItem('orbis:body-draft:u1:e1')).not.toBeNull();
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

test('«Обновить» на экране «обновите приложение» — перезагрузка через свежий сервис-воркер, одна на два нажатия (Л-5)', () => {
  mockSession({ token: 'jwt', userId: 'u1', status: 'authed' });
  render(
    <AuthProvider>
      <Child />
    </AuthProvider>,
  );
  act(() => emitClientOutdated());
  const button = screen.getByRole('button', { name: 'Обновить' });
  // Два нажатия подряд, пока ждём новый воркер: цепочка одна, кнопка заперта и говорит, что занята.
  fireEvent.click(button);
  fireEvent.click(button);
  expect(reloadWithFreshWorker).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
  expect(button).toHaveTextContent('Обновляется…');
});
