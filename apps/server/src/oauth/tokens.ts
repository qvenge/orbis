// apps/server/src/oauth/tokens.ts
// Сырьё токенов §9.3: формат, генерация и хеширование. Отдельный модуль от grants.ts,
// потому что о ФОРМАТЕ токена спрашивают и те, кому таблица грантов не нужна: так,
// context.ts берёт отсюда BEARER_PREFIXES, чтобы отличить Bearer агента от JWT
// владельца, не заглядывая в базу. (Прежнее обоснование называло потребителем
// scripts/issue-pat.ts — с переездом выдачи PAT в базу (D34) скрипт ходит через
// issuePatGrant и этого модуля не касается.)
import { createHash, randomBytes } from 'node:crypto';

export const ACCESS_PREFIX = 'orbis_at_';
export const REFRESH_PREFIX = 'orbis_rt_';
export const CODE_PREFIX = 'orbis_ac_';
export const PAT_PREFIX = 'orbis_pat_';

/**
 * Все префиксы, которыми опознаётся Bearer внешнего агента (JWT Supabase — не отсюда).
 * Спрашивают двое: verifyBearer (пускать ли в таблицу грантов) и context.ts (агентский
 * это путь в tRPC или владельческий). Набор один на обоих — разъехавшись, они дали бы
 * токен, который /mcp принимает, а tRPC считает владельческим JWT, или наоборот.
 */
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
