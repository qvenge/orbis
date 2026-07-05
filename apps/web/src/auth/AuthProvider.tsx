import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { onClientOutdated, onUnauthorized } from './events';
import { LoginScreen } from './LoginScreen';
import { supabase, useSession } from './supabase';

type AuthContextValue = { token: string | null; userId: string | null };
const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// Токен для tRPC-линка, который живёт вне React. Обновляется на каждом рендере провайдера.
let currentToken: string | null = null;
export function getCurrentToken(): string | null {
  return currentToken;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const [outdated, setOutdated] = useState(false);
  currentToken = session.token;

  useEffect(() => {
    onClientOutdated(() => setOutdated(true));
    onUnauthorized(() => {
      void supabase.auth.signOut();
    });
  }, []);

  if (outdated) return <UpdateRequiredScreen />;
  if (session.status === 'loading')
    return (
      <div role="status" aria-live="polite">
        Загрузка…
      </div>
    );
  if (session.status === 'anon' || !session.token) return <LoginScreen />;

  return (
    <AuthContext.Provider value={{ token: session.token, userId: session.userId }}>
      {children}
    </AuthContext.Provider>
  );
}

export function UpdateRequiredScreen() {
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
        className="rounded-control bg-accent px-4 py-2 text-accent-foreground"
        onClick={() => location.reload()}
      >
        Обновить
      </button>
    </div>
  );
}
