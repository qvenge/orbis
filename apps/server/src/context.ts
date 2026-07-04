// apps/server/src/context.ts
// Runtime-сборка request-контекста (Task 14): импорты auth (jose/env) живут здесь,
// а не в trpc.ts — type-граф AppRouter → router → trpc остаётся чист от runtime-модулей
// bun-окружения (обязательство «изоляция auth от type-графа router»).
import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import type { AiDeps } from './ai/send-message';
import { verifyAccessToken } from './auth';
import type { Db } from './db/client';
import { PAT_PREFIX, verifyPat } from './pat';
import type { Context } from './trpc';

/**
 * Фабрика createContext: db и AI-deps (Task 9: провайдер один на процесс, §7.7)
 * создаются один раз при старте (index.ts) и замыкаются здесь.
 */
export function makeCreateContext(db: Db, ai?: AiDeps) {
  return async function createContext({ req }: { req: Request }): Promise<Context> {
    const header = req.headers.get('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const clientVersion = req.headers.get(CLIENT_VERSION_HEADER);
    const aiDeps = ai !== undefined ? { ai } : {};

    // §9.3 (Task 3): Bearer с префиксом PAT — ТОЛЬКО verifyPat, JWT-путь не пробуется:
    // невалидный PAT остаётся неаутентифицированным (fail-closed), а не «вдруг JWT».
    if (token?.startsWith(PAT_PREFIX)) {
      const pat = verifyPat(token);
      return {
        actorUserId: pat?.ownerId ?? null,
        actorKind: 'agent',
        db,
        clientVersion,
        ...aiDeps,
      };
    }

    return {
      actorUserId: token ? await verifyAccessToken(token) : null,
      actorKind: 'owner',
      db,
      clientVersion,
      ...aiDeps,
    };
  };
}
