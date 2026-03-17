import { useEffect } from 'react';
import { useAuthStore } from './stores/auth.ts';
import { LoginPage } from './pages/LoginPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { ErrorBoundary } from './components/common/ErrorBoundary.tsx';

export default function App() {
  const { user, loading, initialize } = useAuthStore();

  useEffect(() => {
    initialize();
  }, [initialize]);

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <p className="text-text-secondary">Loading...</p>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      {user ? <HomePage /> : <LoginPage />}
    </ErrorBoundary>
  );
}
