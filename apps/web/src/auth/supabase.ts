import { AuthClient, type Session } from '@supabase/auth-js';
import { useEffect, useState } from 'react';
import { authUrl, storageKeyFor } from './config';

const url = import.meta.env.VITE_SUPABASE_URL ?? 'http://localhost:54321';
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? 'anon';

// Диета бандла: из supabase-js использовались только четыре вызова .auth, остальное —
// postgrest/realtime/storage/functions, к которым web не обращается вовсе (все данные идут
// через tRPC). Взамен — голый auth-клиент; сам auth-js остаётся, уходит обвязка вокруг него.
// Замерено на прод-сборке: 1024.12 → 913.78 кБ сырых, 296.81 → 266.19 кБ gzip (−30.6 кБ gzip).
//
// ВАЖНО: три вещи supabase-js подставлял сам, и все три опции здесь необязательные —
// забытая уходит в молчаливый дефолт, без ошибки типов и рантайма:
//   url        → 'http://localhost:9999' (клиент ходит не туда);
//   storageKey → 'supabase.auth.token'   (чужой ключ: живые сессии не читаются, разлогин);
//   headers    → без apikey              (хостед-шлюз Supabase отвергает запрос; локальный
//                                         стенд пропускает и без него — промах этой строкой
//                                         на разработческой машине не ловится вообще).
export const auth = new AuthClient({
  url: authUrl(url),
  storageKey: storageKeyFor(url),
  headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  persistSession: true,
  autoRefreshToken: true,
  // На нём держится вход по magic link в приёмочном смоуке — ссылка приносит сессию
  // hash-фрагментом. Дефолт auth-js такой же, но опция, от которой зависит приёмка,
  // должна быть видна в коде, а не унаследована.
  detectSessionInUrl: true,
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
    auth.getSession().then(({ data }) => {
      if (active) setState(fromSession(data.session));
    });
    const { data: sub } = auth.onAuthStateChange((_e, session) => setState(fromSession(session)));
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);
  return state;
}
