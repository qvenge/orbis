// Локальная верификация Supabase access_token через jose — без сетевого auth.getUser
// на каждый запрос (docs/implementation/01-phase0-findings.md, «JWT в Bun»).
// Путь: JWKS ({SUPABASE_URL}/auth/v1/.well-known/jwks.json) → fallback HS256 по legacy-секрету
// (локальный стек подписывает HS256). Референс: spikes/spike-01-rls/test/jwt.test.ts.

import type { JWTPayload } from 'jose';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const AUDIENCE = 'authenticated';

const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** База Supabase без завершающего слэша: иначе issuer/JWKS-URL склеятся с двойным «//». */
function supabaseBase(): string | undefined {
  return process.env.SUPABASE_URL?.replace(/\/+$/, '') || undefined;
}

function resolveJwksUrl(): string | null {
  if (process.env.SUPABASE_JWKS_URL) return process.env.SUPABASE_JWKS_URL;
  const base = supabaseBase();
  return base ? `${base}/auth/v1/.well-known/jwks.json` : null;
}

async function verifyViaJwks(token: string): Promise<JWTPayload | null> {
  const url = resolveJwksUrl();
  if (!url) return null;
  let jwks = jwksSets.get(url);
  if (!jwks) {
    try {
      jwks = createRemoteJWKSet(new URL(url));
    } catch {
      // Мусор в SUPABASE_URL/SUPABASE_JWKS_URL: невалидный URL — это не 500 на каждый
      // запрос, а «JWKS-путь недоступен» с переходом к следующему способу проверки.
      return null;
    }
    jwksSets.set(url, jwks);
  }
  // Hardening (Task 14): allowlist асимметричных алгоритмов — HS256 в JWKS-пути
  // отвергается до резолва ключей (защита от alg-confusion); issuer пинится к
  // Supabase-проекту, когда SUPABASE_URL задан (чужой iss → null).
  const base = supabaseBase();
  const issuer = base ? `${base}/auth/v1` : undefined;
  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience: AUDIENCE,
      algorithms: ['RS256', 'ES256'],
      ...(issuer ? { issuer } : {}),
    });
    return payload;
  } catch {
    return null;
  }
}

let legacyWarned = false;

/**
 * HS256 по legacy-секрету — путь локального стека (он подписывает симметрично).
 * На асимметричных ключах (JWKS) этот путь в проде мёртв, а заданный SUPABASE_JWT_SECRET
 * лишь расширяет поверхность: знающий секрет подделает sub любого владельца. Issuer здесь
 * НЕ пинится намеренно — прод-логин может фактически держаться на этом фолбэке, и молча
 * ужесточить проверку значило бы разлогинить владельца. Вместо этого срабатывание в
 * production логируется один раз: сигнал убрать секрет из окружения (runbook §2).
 */
async function verifyViaLegacySecret(token: string): Promise<JWTPayload | null> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (process.env.NODE_ENV === 'production' && !legacyWarned) {
      legacyWarned = true;
      console.warn(
        '[auth] токен принят HS256-фолбэком по SUPABASE_JWT_SECRET. В production это лишняя ' +
          'поверхность: если проект на асимметричных ключах, уберите секрет из окружения.',
      );
    }
    return payload;
  } catch {
    return null;
  }
}

/** Валидный токен → sub (actorUserId); невалидный/неверифицируемый → null, без throw. */
export async function verifyAccessToken(token: string): Promise<string | null> {
  const payload = (await verifyViaJwks(token)) ?? (await verifyViaLegacySecret(token));
  const sub = payload?.sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}
