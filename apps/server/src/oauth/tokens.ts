// apps/server/src/oauth/tokens.ts
// Сырьё токенов §9.3: генерация и хеширование. Отдельный модуль от grants.ts,
// потому что этим же кодом пользуется scripts/issue-pat.ts, которому база грантов
// не нужна — ему нужен только формат.
import { createHash, randomBytes } from 'node:crypto';

export const ACCESS_PREFIX = 'orbis_at_';
export const REFRESH_PREFIX = 'orbis_rt_';
export const CODE_PREFIX = 'orbis_ac_';
export const PAT_PREFIX = 'orbis_pat_';

/** Все префиксы, которые /mcp принимает как Bearer (JWT Supabase — не отсюда). */
export const BEARER_PREFIXES = [ACCESS_PREFIX, PAT_PREFIX] as const;

export const ACCESS_TTL_SECONDS = 3600;
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
export const CODE_TTL_SECONDS = 60;

/** Префикс + 32 случайных байта в hex. 256 бит энтропии — перебор бессмыслен. */
export function mintToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('hex')}`;
}

/** Единственная форма, в которой токен попадает в базу. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
