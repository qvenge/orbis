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
  /**
   * Транспортный актор запроса (§9.3): 'owner' — JWT Supabase (и неаутентифицированные
   * запросы), 'agent' — PAT внешнего агента. Уже, чем ActorKind executor'а ('ai' — не
   * транспорт: внутренний AI действует внутри запросов владельца).
   */
  actorKind: 'owner' | 'agent';
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
    // Дискриминатор fail-closed (fix round): наш StructuredError — plain object,
    // НЕ Error. `!(cause instanceof Error)` обязателен: системные ошибки
    // (ECONNREFUSED/UND_ERR_* из fetch/undici) — это Error со СТРОКОВЫМ code,
    // и без этой проверки они утекали бы клиенту с сырым message и stack.
    //
    // Эта structured-ветка — СТРАХОВКА, а не основной путь: наши структурированные
    // ошибки (execErrorToTRPC) уже маппятся на не-INTERNAL коды (BAD_REQUEST/CONFLICT/…)
    // и выходят выше на первом guard. Фактическая защита их message — именно тот guard;
    // сюда structured-cause долетел бы лишь при изменении коэрсии `cause` в tRPC (напр.,
    // будущая обёртка нашего cause в Error с INTERNAL-кодом) — тогда ветка не даст
    // затереть его нейтральным текстом.
    const cause = error.cause;
    if (
      cause &&
      typeof cause === 'object' &&
      !(cause instanceof Error) &&
      typeof (cause as { code?: unknown }).code === 'string'
    ) {
      return shape;
    }
    // Сырой Error: оригинал — в серверный лог (с path процедуры), клиенту —
    // нейтральный текст без stack
    console.error(`[trpc] внутренняя ошибка (path=${shape.data.path ?? '?'}):`, cause ?? error);
    return {
      ...shape,
      message: 'внутренняя ошибка сервера',
      data: { ...shape.data, stack: undefined },
    };
  },
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

// Формат версии N(.N)*: всё прочее (пустая строка, 'v0.1.0', '0.0.x', мусор)
// эквивалентно отсутствию заголовка — не блокируем (fix round: политика
// «мусор ≈ отсутствие» держится пред-проверкой, а не NaN-семантикой).
const VERSION_RE = /^\d+(\.\d+)*$/;

// Покомпонентное semver-сравнение без зависимостей (§9.1): a < b.
// Вызывается только для строк, прошедших VERSION_RE — компоненты числовые.
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
  const v = ctx.clientVersion;
  if (v !== null && VERSION_RE.test(v) && semverLess(v, MIN_COMPATIBLE_CLIENT_VERSION)) {
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

// §9.3 (Task 3): PAT-агент проходит protectedProcedure (identity есть identity),
// но операции владельца аккаунта — экспорт, настройки, онбординг-сид, approve/reject
// pending-подтверждений (§7.10, Task 6) — только под actorKind 'owner'. Read-пути
// (getSettings, entity.*, chat.*) агенту остаются открыты.
export const ownerOnlyProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.actorKind !== 'owner') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'операция доступна только владельцу' });
  }
  return next();
});
