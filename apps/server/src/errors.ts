// apps/server/src/errors.ts
// Структурированные ошибки конвейера (§9.2: код + сообщение + details) — поднято из
// executor/errors.ts (минорный долг Task 11): ExecError используют и не-executor-модули
// (chat/threads.ts), которым зависимость от executor/ не положена.
// Коды: VALIDATION (стадии 1–2), NOT_FOUND, STALE_VERSION (§5.2), INVARIANT (§4.2/§3.3,
// для цикла blocks в details — path, Task 10), FORBIDDEN_LEVEL (зарезервирован §7.10, 1b),
// LIMIT (entitlements §8).
import { TRPCError } from '@trpc/server';

export type ExecErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'STALE_VERSION'
  | 'INVARIANT'
  | 'FORBIDDEN_LEVEL'
  | 'LIMIT';

export class ExecError extends Error {
  readonly code: ExecErrorCode;
  readonly details?: unknown;

  constructor(code: ExecErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ExecError';
    this.code = code;
    this.details = details;
  }
}

/** Структурированная ошибка executor'а (форма ExecuteErr.error, §9.2). */
export interface StructuredError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Маппинг кодов executor → TRPCError (бриф Task 12): STALE_VERSION → CONFLICT —
 * это 409 из §5.2 (диаграмма 00-арх §4.4). Исходная структурированная ошибка — в cause.
 */
const TRPC_CODE_BY_EXEC: Record<ExecErrorCode, TRPCError['code']> = {
  VALIDATION: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  STALE_VERSION: 'CONFLICT',
  INVARIANT: 'UNPROCESSABLE_CONTENT',
  FORBIDDEN_LEVEL: 'FORBIDDEN', // зарезервирован §7.10 (1b)
  LIMIT: 'TOO_MANY_REQUESTS',
};

export function execErrorToTRPC(error: StructuredError): TRPCError {
  const code = TRPC_CODE_BY_EXEC[error.code as ExecErrorCode] ?? 'INTERNAL_SERVER_ERROR';
  return new TRPCError({ code, message: error.message, cause: error });
}
