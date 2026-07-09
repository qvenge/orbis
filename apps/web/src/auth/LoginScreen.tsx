import { type FormEvent, useId, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Spinner } from '../ui/Spinner';
import { supabase } from './supabase';

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailId = useId();
  const passwordId = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setError(error.message);
  }

  return (
    <div className="flex min-h-full items-center justify-center px-6">
      <Card className="w-full max-w-sm">
        <form
          onSubmit={submit}
          aria-label="Вход"
          data-testid="login-screen"
          className="flex flex-col gap-4"
        >
          <h1 className="text-2xl font-semibold">Orbis</h1>
          <label htmlFor={emailId} className="flex flex-col gap-1 text-sm">
            Email
            <Input
              id={emailId}
              aria-label="Email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label htmlFor={passwordId} className="flex flex-col gap-1 text-sm">
            Пароль
            <Input
              id={passwordId}
              aria-label="Пароль"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy && <Spinner size={14} aria-label="Входим" />}
            Войти
          </Button>
        </form>
      </Card>
    </div>
  );
}
