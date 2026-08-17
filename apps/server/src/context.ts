// apps/server/src/context.ts
// Runtime-сборка request-контекста (Task 14): импорты auth (jose/env) живут здесь,
// а не в trpc.ts — type-граф AppRouter → router → trpc остаётся чист от runtime-модулей
// bun-окружения (обязательство «изоляция auth от type-графа router»).
import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import type { AiDeps } from './ai/send-message';
import { verifyAccessToken } from './auth';
import type { Db } from './db/client';
import { verifyBearer } from './oauth/grants';
import { BEARER_PREFIXES } from './oauth/tokens';
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

    // §9.3: Bearer с агентским префиксом (orbis_at_ / orbis_pat_) — ТОЛЬКО сверка с
    // таблицей грантов, JWT-путь не пробуется: недействительный токен агента остаётся
    // неаутентифицированным (fail-closed), а не «вдруг JWT». Ветка развилки — префикс,
    // а не исход проверки: иначе отозванный токен уезжал бы на владельческий путь и
    // получал actorKind 'owner' (пусть и без actorUserId) — атрибуцию агента нельзя
    // терять из-за того, что доступ отозвали.
    //
    // С переездом доступа из env в таблицу (D34) источник правды здесь тот же, что у
    // /mcp: verifyBearer. Двух механизмов с разными источниками правды у одного токена
    // быть не должно — именно поэтому apps/server/src/pat.ts снят целиком.
    if (token !== null && BEARER_PREFIXES.some((p) => token.startsWith(p))) {
      const identity = await verifyBearer(db, token);
      return {
        actorUserId: identity?.ownerId ?? null,
        actorKind: 'agent',
        // Идентичность гранта (С2) — симметрично /mcp (mcp/server.ts): один и тот же
        // токен пускают обе поверхности, и то, что известно о доступе, не должно
        // зависеть от выбранного агентом транспорта. Ключа нет вовсе, если гранта нет
        // (токен неизвестен или отозван) — «нет гранта» и «грант без области» различимы.
        ...(identity !== null && {
          grant: { id: identity.grantId, scope: identity.scope, label: identity.label },
        }),
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
