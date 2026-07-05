import { type FormEvent, useState } from 'react';
import { supabase } from './supabase';

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setError(error.message);
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Вход"
      data-testid="login-screen"
      className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 px-6"
    >
      <h1 className="text-2xl font-semibold">Orbis</h1>
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          aria-label="Email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-control border border-line bg-surface px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Пароль
        <input
          aria-label="Пароль"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-control border border-line bg-surface px-3 py-2"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="rounded-control bg-accent px-4 py-2 text-accent-foreground disabled:opacity-50"
      >
        Войти
      </button>
    </form>
  );
}
