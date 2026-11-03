import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { stepsGeneration } from '../features/entity-editor/arrows-stack';
import { setDraftScope } from '../features/entity-editor/draft-storage';
import { destroyAllEditors } from '../features/entity-editor/editor-cache';
import { resetUndoSession, setUndoOwner } from '../features/undo/undo-epoch';
import type { BrowserLocalData } from '../lib/local-data/browser-lifecycle';
import type { LocalDataScope } from '../lib/local-data/lifecycle';
import { PrivacyActionsContext } from '../lib/local-data/privacy-actions';
import { RELOADING_LABEL, useFreshReload } from '../pwa/useFreshReload';
import { setRetryScope } from '../state/retry';
import { onClientOutdated, onUnauthorized } from './events';
import { LoginScreen } from './LoginScreen';
import { auth, useSession } from './supabase';

type AuthContextValue = {
  token: string | null;
  userId: string | null;
  cacheOnly: boolean;
  scope?: LocalDataScope;
  shared?: boolean;
};
const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// Токен для tRPC-линка, который живёт вне React. Обновляется на каждом рендере провайдера.
let currentToken: string | null = null;
let expiresAt: number | undefined;
let productToken: (() => string | null) | undefined;
export function configureProductToken(read: () => string | null): void {
  productToken = read;
}
export function getCurrentToken(): string | null {
  if (productToken) return productToken();
  return expiresAt !== undefined && expiresAt <= Date.now() ? null : currentToken;
}

export function AuthProvider({
  children,
  privacy,
  allowCacheOnly = false,
}: {
  children: ReactNode;
  privacy?: BrowserLocalData;
  allowCacheOnly?: boolean;
}) {
  return privacy ? (
    <ScopedAuthProvider privacy={privacy}>{children}</ScopedAuthProvider>
  ) : (
    <StandaloneAuthProvider allowCacheOnly={allowCacheOnly}>{children}</StandaloneAuthProvider>
  );
}

function ScopedAuthProvider({
  children,
  privacy,
}: {
  children: ReactNode;
  privacy: BrowserLocalData;
}) {
  const state = useSyncExternalStore(privacy.subscribe, privacy.getState);
  useLayoutEffect(() => privacy.didRender(state), [privacy, state]);
  useEffect(() => {
    const removeOutdated = onClientOutdated(privacy.outdated);
    const removeUnauthorized = onUnauthorized(privacy.unauthorized);
    return () => {
      removeOutdated();
      removeUnauthorized();
    };
  }, [privacy]);
  if (state.phase === 'outdated') return <UpdateRequiredScreen />;
  if (state.phase === 'pending') {
    return (
      <div
        role="alert"
        className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-4 px-6 text-center"
      >
        <p>{state.message}</p>
        <button type="button" onClick={() => void privacy.retry()}>
          Повторить
        </button>
        {state.canCancel && (
          <button type="button" onClick={() => void privacy.cancel()}>
            Отменить очистку
          </button>
        )}
      </div>
    );
  }
  if (state.phase === 'loading' || state.session.status === 'loading') {
    return (
      <div role="status" aria-live="polite">
        Загрузка…
      </div>
    );
  }
  if (!state.scope || state.session.status === 'anon')
    return (
      <>
        {state.message && <p role="alert">{state.message}</p>}
        <LoginScreen />
      </>
    );
  const shared = state.mode === 'shared';
  return (
    <AuthContext.Provider
      value={{
        token: privacy.getToken(),
        userId: state.scope.accountId,
        cacheOnly: state.session.status === 'cache-only',
        scope: state.scope,
        shared,
      }}
    >
      <PrivacyActionsContext.Provider
        value={{
          shared,
          scope: state.scope,
          canSeed: !!privacy.getToken() && privacy.canSeed(state.scope),
          message: state.message,
          logout: () => void privacy.request('logout'),
          toggleShared: () => void privacy.request(shared ? 'shared-off' : 'shared-on'),
          graphSeeded: (scope) => void privacy.seeded(scope),
        }}
      >
        {children}
      </PrivacyActionsContext.Provider>
    </AuthContext.Provider>
  );
}

function StandaloneAuthProvider({
  children,
  allowCacheOnly = false,
}: {
  children: ReactNode;
  /** Enable only when the child transport gates all product HTTP without a bearer. */
  allowCacheOnly?: boolean;
}) {
  const session = useSession();
  const [outdated, setOutdated] = useState(false);
  currentToken = outdated ? null : session.token;
  expiresAt = session.status === 'authed' ? session.expiresAt : undefined;
  // Скоуп retry-буфера — по владельцу сессии, до рендера дерева (эффекты детей идут
  // раньше эффектов родителя, а useRetryFlush в App дренирует очередь на монтировании).
  // Иначе на общем браузере следующий аккаунт дослал бы чужие записи в свой workspace.
  setUndoOwner(session.userId);
  setRetryScope(session.userId);
  // Скоуп черновиков — по тому же аккаунту сессии и по той же причине (общий браузер).
  setDraftScope(session.userId ?? '');

  // biome-ignore lint/correctness/useExhaustiveDependencies: каждый owner transition уничтожает только прежнее поколение после unmount детей
  useEffect(() => {
    const generation = stepsGeneration();
    return () => destroyAllEditors(generation);
  }, [session.userId]);

  useEffect(() => {
    const removeOutdated = onClientOutdated(() => {
      currentToken = null;
      setOutdated(true);
    });
    const removeUnauthorized = onUnauthorized(() => {
      currentToken = null;
      resetUndoSession();
      void Promise.resolve(auth.signOut()).catch(() => {
        // The auth adapter remains revoked if storage cleanup fails.
      });
    });
    return () => {
      removeOutdated();
      removeUnauthorized();
    };
  }, []);

  if (outdated) return <UpdateRequiredScreen />;
  if (session.status === 'loading')
    return (
      <div role="status" aria-live="polite">
        Загрузка…
      </div>
    );
  if (session.status === 'anon') return <LoginScreen />;
  const cacheOnly = session.status === 'cache-only';
  if (cacheOnly && !allowCacheOnly) {
    return (
      <div role="status" aria-live="polite">
        Ждём восстановления связи для входа…
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ token: session.token, userId: session.userId, cacheOnly }}>
      {children}
    </AuthContext.Provider>
  );
}

export function UpdateRequiredScreen() {
  const reload = useFreshReload();
  return (
    <div
      role="alert"
      data-testid="update-required"
      className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-4 px-6 text-center"
    >
      <h1 className="text-2xl font-semibold">Обновите приложение</h1>
      <p className="text-sm text-text-secondary">
        Установлена устаревшая версия Orbis. Обновите страницу, чтобы продолжить.
      </p>
      <button
        type="button"
        className="rounded-control bg-accent px-4 py-2 text-accent-foreground disabled:opacity-60"
        // Не голый reload: под старым сервис-воркером он отдаёт старый прекеш (Л-5, pwa/fresh-reload).
        disabled={reload.pending}
        onClick={reload.start}
      >
        {reload.pending ? RELOADING_LABEL : 'Обновить'}
      </button>
    </div>
  );
}
