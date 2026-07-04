// apps/server/src/pat.ts
// PAT-аутентификация внешних агентов (§9.3, решение 1 плана 1b): без таблицы —
// сервер знает только SHA-256-хеш токена (env ORBIS_PAT_HASH, hex) и владельца,
// от чьего имени действует агент (env ORBIS_PAT_OWNER_ID). Hash-only: сырой токен
// нигде не хранится и не логируется; отзыв = смена env + рестарт. Выдача — scripts/issue-pat.ts.
import { createHash, timingSafeEqual } from 'node:crypto';

/** Префикс PAT: Bearer с ним идёт ТОЛЬКО в verifyPat — JWT-путь не пробуется (context.ts). */
export const PAT_PREFIX = 'orbis_pat_';

/**
 * Валидный токен → владелец; любой отказ — отсутствие ЛЮБОГО из env, битый hex в env,
 * несовпадение хеша — → null (fail-closed), без throw и без логирования токена.
 *
 * Constant-time конструктивно: сравниваются два 32-байтных sha256-дайджеста через
 * timingSafeEqual — длины всегда равны, тайминг сравнения не зависит от содержимого
 * токена (хеширование выравнивает произвольную длину входа).
 */
export function verifyPat(token: string): { ownerId: string } | null {
  const hashHex = process.env.ORBIS_PAT_HASH;
  const ownerId = process.env.ORBIS_PAT_OWNER_ID;
  if (!hashHex || !ownerId) return null;

  // Ожидаемый дайджест из env: Buffer.from(_, 'hex') молча обрезает на первом
  // невалидном символе — length-гейт ловит и мусор, и усечённый hex (fail-closed).
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== 32) return null;

  const actual = createHash('sha256').update(token).digest();
  return timingSafeEqual(actual, expected) ? { ownerId } : null;
}
