import { MIN_COMPATIBLE_CLIENT_VERSION } from '@orbis/shared';
import { initTRPC, TRPCError } from '@trpc/server';
import type { Db } from './db/client';

// Identity течёт только через request-контекст; имя — actorUserId, не userId (D11).
// db — один инстанс на процесс (index.ts), в контекст кладётся ссылкой (Task 12).
// createContext живёт в context.ts (Task 14): здесь — только типы и сборка процедур,
// чтобы type-граф AppRouter → router → trpc не тянул runtime-импорты auth.
// type, а не interface: у interface нет неявной index signature, и он не проходит
// требование Record<string, unknown> у createContext в @hono/trpc-server.
export type Context = {
  actorUserId: string | null;
  db: Db;
  /** Значение заголовка CLIENT_VERSION_HEADER; null — заголовок не прислан (curl/смоуки). */
  clientVersion: string | null;
};

// Глобальный errorFormatter (Task 14, из ревью Task 12): неожиданные ошибки
// БД/рантайма не отдают клиенту сырой message (SQL-текст drizzle и т.п.) и stack.
// Структурированные наши ошибки (cause { code, ... } из execErrorToTRPC) — безопасны,
// их message сохраняется как есть.
const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    if (shape.data.code !== 'INTERNAL_SERVER_ERROR') return shape;
    const cause = error.cause as { code?: unknown } | undefined;
    if (cause && typeof cause === 'object' && typeof cause.code === 'string') return shape;
    // Сырой Error: оригинал — в серверный лог, клиенту — нейтральный текст без stack
    console.error('[trpc] внутренняя ошибка:', error.cause ?? error);
    return {
      ...shape,
      message: 'внутренняя ошибка сервера',
      data: { ...shape.data, stack: undefined },
    };
  },
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

// Покомпонентное semver-сравнение без зависимостей (§9.1): a < b.
// Нечисловые компоненты дают NaN, любое сравнение с NaN ложно → мусорный
// заголовок не блокирует запрос (эквивалентен отсутствию заголовка).
function semverLess(a: string, b: string): boolean {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? 0);
    const y = Number(pb[i] ?? 0);
    if (x !== y) return x < y;
  }
  return false;
}

// §9.1 (Task 14): клиент старше MIN_COMPATIBLE_CLIENT_VERSION получает отказ
// до любой работы (в т.ч. до auth-проверки); без заголовка — пропускаем.
const versionGate = t.middleware(({ ctx, next }) => {
  if (ctx.clientVersion !== null && semverLess(ctx.clientVersion, MIN_COMPATIBLE_CLIENT_VERSION)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `клиент устарел: минимальная совместимая версия ${MIN_COMPATIBLE_CLIENT_VERSION}`,
      cause: { code: 'CLIENT_OUTDATED', min: MIN_COMPATIBLE_CLIENT_VERSION },
    });
  }
  return next();
});

export const publicProcedure = t.procedure.use(versionGate);
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.actorUserId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { actorUserId: ctx.actorUserId } });
});
