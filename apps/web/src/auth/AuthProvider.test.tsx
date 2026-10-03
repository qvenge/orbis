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
  saveDraft('e1', parseBody('неотправленная правка'), 3, '2026-01-02T00:00:00.000Z');
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

import { waitFor } from '@testing-library/react';
import { offerUndoLazy } from '../features/undo/undo-lazy';
import { renderWithProviders } from '../test/harness';
import { trpc } from '../trpc';
import { Toaster } from '../ui/Toast';
import { emitUnauthorized } from './events';

function LateSelf() {
  const update = trpc.entity.update.useMutation({
    // biome-ignore lint/complexity/useLiteralKeys: MutationMeta библиотеки, не fixture meta сущности.
    ['meta']: { undoStack: 'self' },
    onSuccess: () => offerUndoLazy({ actionId: 'old', title: 'Старое действие', entityIds: [] }),
  });
  return (
    <button type="button" onClick={() => update.mutate({ id: 'e1', props: {} })}>
      Поздняя правка
    </button>
  );
}
test('401: поздний SELF успех не возвращает плашку предыдущей сессии', async () => {
  mockSession({ token: 'jwt', userId: 'u1', status: 'authed' });
  let finish!: (value: unknown) => void;
  const { calls } = renderWithProviders(
    <AuthProvider>
      <Toaster />
      <LateSelf />
    </AuthProvider>,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByText('Поздняя правка'));
  await waitFor(() => expect(calls).toHaveLength(1));
  act(() => emitUnauthorized());
  await act(async () => {
    finish({ actionId: 'old', consequences: false });
    await vi.dynamicImportSettled();
  });
  await waitFor(() => expect(screen.queryByText('Старое действие')).not.toBeInTheDocument());
});

import { peekUndoable, pushUndoable } from '../features/undo/undo-stack';
import { trpcError } from '../test/harness';
import { auth } from './supabase';

test('transport: поздний 401 прежнего владельца не выходит из новой сессии', async () => {
  mockSession({ token: 'jwt1', userId: 'u1', status: 'authed' });
  let reject!: (error: unknown) => void;
  const { rerender, calls } = renderWithProviders(
    <AuthProvider>
      <LateSelf />
    </AuthProvider>,
    () =>
      new Promise((_resolve, r) => {
        reject = r;
      }),
    { authErrors: true },
  );
  fireEvent.click(screen.getByText('Поздняя правка'));
  await waitFor(() => expect(calls).toHaveLength(1));
  mockSession({ token: 'jwt2', userId: 'u2', status: 'authed' });
  // AuthProvider остаётся в существующем дереве providers через повторный render state.
  rerender(
    <AuthProvider>
      <Child />
    </AuthProvider>,
  );
  pushUndoable({ actionId: 'new', title: 'Новая запись' });
  await act(async () => {
    reject(trpcError('UNAUTHORIZED', 'старый токен'));
  });
  expect(auth.signOut).not.toHaveBeenCalled();
  expect(peekUndoable()?.actionId).toBe('new');
});

test('current401 стирает стек и вызывает signOut; смена владельца стирает стек до нового дерева', () => {
  mockSession({ token: 'jwt1', userId: 'u1', status: 'authed' });
  const { rerender } = render(
    <AuthProvider>
      <Child />
    </AuthProvider>,
  );
  pushUndoable({ actionId: 'a', title: 'Первое' });
  act(() => emitUnauthorized());
  expect(peekUndoable()).toBeUndefined();
  expect(auth.signOut).toHaveBeenCalledOnce();
  pushUndoable({ actionId: 'b', title: 'Второе' });
  mockSession({ token: 'jwt2', userId: 'u2', status: 'authed' });
  rerender(
    <AuthProvider>
      <Child />
    </AuthProvider>,
  );
  expect(peekUndoable()).toBeUndefined();
});
test('transport current401 доставляет ошибку caller и выходит; outdated остаётся глобальным после смены владельца', async () => {
  mockSession({ token: 'jwt1', userId: 'u1', status: 'authed' });
  let reject!: (error: unknown) => void;
  const { calls, rerender } = renderWithProviders(
    <AuthProvider>
      <LateSelf />
    </AuthProvider>,
    () =>
      new Promise((_resolve, r) => {
        reject = r;
      }),
    { authErrors: true },
  );
  fireEvent.click(screen.getByText('Поздняя правка'));
  await waitFor(() => expect(calls).toHaveLength(1));
  pushUndoable({ actionId: 'a', title: 'Первое' });
  await act(async () => reject(trpcError('UNAUTHORIZED', 'token')));
  expect(auth.signOut).toHaveBeenCalledOnce();
  expect(peekUndoable()).toBeUndefined();
  // Новая обвязка нужна, потому что прежний Provider теперь вышел по401.
  rerender(
    <AuthProvider>
      <Child />
    </AuthProvider>,
  );
});

import { useState } from 'react';
import { type BodySave, useBodySave } from '../features/entity-editor/useBodySave';
import { mockEntityUpdateResult } from '../test/harness';

test('actual ownerchange same-mounted body: old waiter/reply/gate не мешает новому сохранению', async () => {
  mockSession({ token: 'jwt1', userId: 'u1', status: 'authed' });
  let api!: BodySave;
  const base = {
    bodyRevision: 3,
    bodyDoc: parseBody('Основа'),
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  function Body() {
    api = useBodySave('e1', base);
    return null;
  }
  const stableBody = <Body />;
  function Host() {
    const [, refresh] = useState(0);
    return (
      <>
        <button type="button" onClick={() => refresh((value) => value + 1)}>
          Перерисовать сессию
        </button>
        <AuthProvider>{stableBody}</AuthProvider>
      </>
    );
  }
  const replies: Array<(value: unknown) => void> = [];
  const { calls } = renderWithProviders(<Host />, (path) =>
    path === 'entity.update'
      ? new Promise((resolve) => {
          replies.push(resolve);
        })
      : {},
  );
  act(() => api.onDocChange(parseBody('Старый текст')));
  let firstResult: unknown;
  act(() => {
    void api.flushSettled().then((value) => {
      firstResult = value;
      return value;
    });
  });
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(1));
  let oldFinish!: ReturnType<BodySave['beginRewrite']>;
  act(() => {
    oldFinish = api.beginRewrite();
  });
  mockSession({ token: 'jwt2', userId: 'u2', status: 'authed' });
  fireEvent.click(screen.getByText('Перерисовать сессию'));
  await waitFor(() => expect(firstResult).toBe('nothing'));
  let newFinish!: ReturnType<BodySave['beginRewrite']>;
  act(() => {
    newFinish = api.beginRewrite();
  });
  act(() => oldFinish(10));
  expect(api.rewritePending).toBe(true);
  act(() => newFinish());
  act(() => api.onDocChange(parseBody('Новый текст')));
  let second!: Promise<unknown>;
  act(() => {
    second = api.flushSettled();
  });
  await waitFor(() => expect(replies).toHaveLength(2));
  await act(async () => replies[0]?.(mockEntityUpdateResult({ id: 'e1', bodyRevision: 10 })));
  expect(api.revisionForRewrite()).toBe(3);
  expect(api.state).toBe('saving');
  await act(async () => replies[1]?.(mockEntityUpdateResult({ id: 'e1', bodyRevision: 4 })));
  expect(await second).toBe('saved');
  expect(api.revisionForRewrite()).toBe(4);
  expect(api.state).toBe('idle');
});

test('Task18: ownerchange до паузы сохраняет последний набор только старому владельцу', async () => {
  mockSession({ token: 'jwt1', userId: 'u1', status: 'authed' });
  let api!: BodySave;
  let shown = parseBody('Основа');
  function Body() {
    api = useBodySave('e1', {
      bodyRevision: 3,
      bodyDoc: shown,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    return null;
  }
  const body = <Body />;
  function Host() {
    const [, refresh] = useState(0);
    return (
      <>
        <button type="button" onClick={() => refresh((n) => n + 1)}>
          Смена владельца
        </button>
        <AuthProvider>{body}</AuthProvider>
      </>
    );
  }
  const { calls } = renderWithProviders(<Host />, (path) =>
    path === 'entity.update' ? mockEntityUpdateResult({ id: 'e1', bodyRevision: 4 }) : {},
  );
  act(() => api.onDocChange(parseBody('Последние слова до паузы')));
  shown = parseBody('Последние слова до паузы'); // Новый serverdoc совпал случайно, oldowner его не подтверждал.
  mockSession({ token: 'jwt2', userId: 'u2', status: 'authed' });
  fireEvent.click(screen.getByText('Смена владельца'));
  await waitFor(() =>
    expect(localStorage.getItem('orbis:body-draft:u1:e1')).toContain('Последние слова до паузы'),
  );
  expect(localStorage.getItem('orbis:body-draft:u2:e1')).toBeNull();
  expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(0);
  expect(api.pendingDraft).toBeNull();
  const oldDraft = localStorage.getItem('orbis:body-draft:u1:e1');
  shown = parseBody('Основа');
  mockSession({ token: 'jwt1-again', userId: 'u1', status: 'authed' });
  fireEvent.click(screen.getByText('Смена владельца'));
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(1));
  expect(JSON.stringify(calls.find((c) => c.path === 'entity.update')?.input)).toContain(
    'Последние слова до паузы',
  );
  expect(oldDraft).toContain('Последние слова до паузы');
});

import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { detailGetInput } from '../features/entity-detail/useEntityDetail';

test('R56 actual BodySave factory owner reentry sends unconfirmed cached body; current success works', async () => {
  mockSession({ token: 'jwt1', userId: 'u1', status: 'authed' });
  const key = getQueryKey(trpc.entity.get, detailGetInput('e1'), 'query');
  let api!: BodySave;
  let oldReply!: (value: unknown) => void;
  const base = {
    entity: {
      id: 'e1',
      props: {},
      bodyRevision: 3,
      bodyDoc: parseBody('Основа'),
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  function Body() {
    const client = useQueryClient();
    const data = client.getQueryData(key) as typeof base;
    api = useBodySave('e1', data.entity);
    return null;
  }
  const body = <Body />;
  function Host() {
    const client = useQueryClient();
    const [, refresh] = useState(() => {
      client.setQueryData(key, base);
      return 0;
    });
    return (
      <>
        <button type="button" onClick={() => refresh((n) => n + 1)}>
          Вход владельца
        </button>
        <AuthProvider>{body}</AuthProvider>
      </>
    );
  }
  let sends = 0;
  const { calls } = renderWithProviders(<Host />, (path) => {
    if (path !== 'entity.update') return {};
    sends++;
    if (sends === 1)
      return new Promise((resolve) => {
        oldReply = resolve;
      });
    return mockEntityUpdateResult({ id: 'e1', bodyRevision: 4 });
  });
  act(() => {
    api.onDocChange(parseBody('Неподтверждённый набор'));
    api.flush();
  });
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(1), {
    timeout: 800,
  });
  mockSession({ token: 'jwt2', userId: 'u2', status: 'authed' });
  fireEvent.click(screen.getByText('Вход владельца'));
  await waitFor(
    () =>
      expect(localStorage.getItem('orbis:body-draft:u1:e1')).toContain('Неподтверждённый набор'),
    { timeout: 800 },
  );
  expect(localStorage.getItem('orbis:body-draft:u2:e1')).toBeNull();
  expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(1);
  mockSession({ token: 'jwt1-again', userId: 'u1', status: 'authed' });
  fireEvent.click(screen.getByText('Вход владельца'));
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(2), {
    timeout: 800,
  });
  await waitFor(() => expect(api.revisionForRewrite()).toBe(4), { timeout: 800 });
  expect(localStorage.getItem('orbis:body-draft:u1:e1')).toBeNull();
  await act(async () => oldReply(mockEntityUpdateResult({ id: 'e1', bodyRevision: 99 })));
  expect(api.revisionForRewrite()).toBe(4);
});

import type { Editor } from '@tiptap/core';
import {
  canRedoStep,
  canUndoStep,
  pushStep,
  undoStep,
} from '../features/entity-editor/arrows-stack';
import {
  acquireEditor,
  hasLiveEditor,
  releaseEditor,
} from '../features/entity-editor/editor-cache';

test('401 стирает шаги; уход пользователя уничтожает отпущенный редактор', () => {
  mockSession({ token: 'jwt', userId: 'u1', status: 'authed' });
  const r = render(
    <AuthProvider>
      <Child />
    </AuthProvider>,
  );
  const editor = { destroy: vi.fn(), isDestroyed: false } as unknown as Editor;
  acquireEditor('e1', () => editor);
  releaseEditor('e1');
  pushStep('e1', 'title');
  act(() => emitUnauthorized());
  expect(canUndoStep('e1')).toBe(false);
  mockSession({ token: null, userId: null, status: 'anon' });
  r.rerender(
    <AuthProvider>
      <Child />
    </AuthProvider>,
  );
  expect(editor.destroy).toHaveBeenCalledOnce();
  expect(hasLiveEditor('e1')).toBe(false);
});

import { NativeRow } from '../features/entity-detail/NativeRow';
import { BodyEditor } from '../features/entity-editor/BodyEditor';
import { wireEntity } from '../test/harness';
import { registryReply } from '../test/registry';

test('тот же id при смене authed владельца: новый Editor переживает old cleanup и использует новые handlers', () => {
  mockSession({ token: 'a', userId: 'u-a', status: 'authed' });
  let refresh!: () => void;
  const changes = vi.fn(),
    save = vi.fn(),
    doc = parseBody('тело');
  function Host() {
    const [, set] = useState(0);
    refresh = () => set((n) => n + 1);
    return (
      <AuthProvider>
        <NativeRow
          entity={wireEntity({ id: 'e1', title: 'План' })}
          onToggleTask={() => {}}
          onSaveTitle={save}
        />
        <BodyEditor entityId="e1" doc={doc} onChange={changes} />
      </AuthProvider>
    );
  }
  renderWithProviders(
    <Host />,
    (path) =>
      registryReply(path) ?? (path === 'entity.resolveRefs' || path === 'entity.suggest' ? [] : {}),
  );
  const get = () =>
    (
      screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
        editor: Editor;
      }
    ).editor;
  const old = get();
  const heldUpdate = old.options.onUpdate;
  const heldTransaction = old.options.onTransaction;
  act(() => old.commands.insertContentAt(1, 'А'));
  expect(canUndoStep('e1')).toBe(true);
  mockSession({ token: 'b', userId: 'u-b', status: 'authed' });
  act(() => refresh());
  expect(screen.getByTestId('body-editor').querySelector('.ProseMirror')).not.toBeNull();
  const next = get();
  expect(next === old).toBe(false);
  expect(old.isDestroyed).toBe(true);
  expect(next.isDestroyed).toBe(false);
  expect(canUndoStep('e1')).toBe(false);
  const heldPayload = {
    editor: next,
    transaction: next.state.tr.insertText('Чужое', 1),
    appendedTransactions: [],
  };
  act(() => {
    heldUpdate?.(heldPayload);
    heldTransaction?.(heldPayload);
  });
  expect(changes).toHaveBeenCalledTimes(1);
  expect(canUndoStep('e1')).toBe(false);
  act(() => next.commands.insertContentAt(1, 'Б'));
  expect(changes).toHaveBeenCalledTimes(2);
  expect(canUndoStep('e1')).toBe(true);
  act(() => expect(undoStep('e1')).toBe(true));
  expect(canRedoStep('e1')).toBe(true);
  act(() =>
    heldTransaction?.({
      editor: next,
      transaction: next.state.tr.insertText('Чужое', 1),
      appendedTransactions: [],
    }),
  );
  expect(canRedoStep('e1')).toBe(true);
  fireEvent.change(screen.getByTestId('title-edit'), { target: { value: 'План В' } });
  fireEvent.keyDown(screen.getByTestId('title-edit'), { key: 'z', ctrlKey: true });
  expect(save).toHaveBeenCalledWith('План', 'План');
});
