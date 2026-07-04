// apps/server/src/context.ts
// Runtime-сборка request-контекста (Task 14): импорты auth (jose/env) живут здесь,
// а не в trpc.ts — type-граф AppRouter → router → trpc остаётся чист от runtime-модулей
// bun-окружения (обязательство «изоляция auth от type-графа router»).
import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import { verifyAccessToken } from './auth';
import type { Db } from './db/client';
import type { Context } from './trpc';

/** Фабрика createContext: db создаётся один раз при старте (index.ts) и замыкается здесь. */
export function makeCreateContext(db: Db) {
  return async function createContext({ req }: { req: Request }): Promise<Context> {
    const header = req.headers.get('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    return {
      actorUserId: token ? await verifyAccessToken(token) : null,
      db,
      clientVersion: req.headers.get(CLIENT_VERSION_HEADER),
    };
  };
}
