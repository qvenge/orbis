import { useState } from 'react';
import { useAuthStore } from '../stores/auth.ts';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { signIn, signUp } = useAuthStore();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const result = isSignUp
      ? await signUp(email, password)
      : await signIn(email, password);

    if (result.error) {
      setError(result.error);
    }
    setLoading(false);
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface-dim p-8">
        <h1 className="mb-1 text-2xl font-semibold text-text">Orbis</h1>
        <p className="mb-6 text-sm text-text-secondary">
          {isSignUp ? 'Create your account' : 'Sign in to continue'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted outline-none transition-colors duration-150 focus:border-primary"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted outline-none transition-colors duration-150 focus:border-primary"
          />

          {error && (
            <p className="text-sm text-danger">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:bg-primary-dark disabled:opacity-50"
          >
            {loading ? '...' : isSignUp ? 'Sign Up' : 'Sign In'}
          </button>
        </form>

        <button
          onClick={() => { setIsSignUp(!isSignUp); setError(null); }}
          className="mt-4 text-sm text-text-secondary transition-colors duration-150 hover:text-primary"
        >
          {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
        </button>
      </div>
    </div>
  );
}
