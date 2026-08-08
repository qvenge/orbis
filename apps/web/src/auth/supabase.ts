import { AuthClient, type Session } from '@supabase/auth-js';
import { useEffect, useState } from 'react';
import { authUrl, storageKeyFor } from './config';

const url = import.meta.env.VITE_SUPABASE_URL ?? 'http://localhost:54321';
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? 'anon';

// Диета бандла: из supabase-js использовались только четыре вызова .auth, остальное —
// postgrest/realtime/storage/functions, к которым web не обращается вовсе (все данные идут
// через tRPC). Взамен — голый auth-клиент; сам auth-js остаётся, уходит обвязка вокруг него.
// Замер на прод-сборке («до» — чистый main@2067e64 во временном worktree, «после» — эта ветка,
// одна машина и один vite): 1 024 018 → 913 840 Б сырых, 293.3 → 263.0 кБ gzip, выигрыш 30.3 кБ.
// Обе цифры gzip сняты одним и тем же `gzip -c`. Строку `gzip:` из отчёта vite сюда подставлять
// нельзя: на этом же файле она даёт 266.20 кБ против 263 024 Б настоящих — систематическое
// завышение ~1.2%, которое сдвинуло бы исторический ряд замеров на ~3 кБ. Таблица, рецепт и
// разбор расхождения — docs/superpowers/reviews/2026-08-04-bundle-diet.md (работа 1).
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
  // Плоский мерж опций в GoTrueClient (`{...DEFAULT_OPTIONS, ...options}`) заменяет
  // дефолтные заголовки целиком, поэтому вендорский 'X-Client-Info' отсюда пропадает.
  // Так и задумано (решение Р13): его никто не читает — ни наш сервер, ни RLS, ни шлюз;
  // это телеметрия Supabase, и слать её нам незачем.
  headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  persistSession: true,
  autoRefreshToken: true,
  // Обе опции ниже держат вход по magic link в приёмочном смоуке: implicit-поток приносит
  // сессию hash-фрагментом (pkce принёс бы `?code`), а detectSessionInUrl её оттуда
  // забирает. Дефолты auth-js такие же, но опция, от которой зависит приёмка, должна быть
  // видна в коде, а не унаследована.
  flowType: 'implicit',
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
