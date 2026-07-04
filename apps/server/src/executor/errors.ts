// apps/server/src/executor/errors.ts
// Структурированные ошибки конвейера (§9.2: код + сообщение + details).
// Коды: VALIDATION (стадии 1–2), NOT_FOUND, STALE_VERSION (§5.2), INVARIANT (§4.2/§3.3,
// для цикла blocks в details — path, Task 10), FORBIDDEN_LEVEL (зарезервирован §7.10, 1b),
// LIMIT (entitlements §8).
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
