import { createClient, type Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

const url = import.meta.env.VITE_SUPABASE_URL ?? 'http://localhost:54321';
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? 'anon';

export const supabase = createClient(url, anon, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export type SessionState = {
  token: string | null;
  userId: string | null;
  status: 'loading' | 'authed' | 'anon';
};

function fromSession(session: Session | null): SessionState {
  if (!session) return { token: null, userId: null, status: 'anon' };
  return { token: session.access_token, userId: session.user.id, status: 'authed' };
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({
    token: null,
    userId: null,
    status: 'loading',
  });
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) setState(fromSession(data.session));
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) =>
      setState(fromSession(session)),
    );
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);
  return state;
}
