// apps/server/src/errors.ts
// Структурированные ошибки конвейера (§9.2: код + сообщение + details) — поднято из
// executor/errors.ts (минорный долг Task 11): ExecError используют и не-executor-модули
// (chat/threads.ts), которым зависимость от executor/ не положена.
// Коды: VALIDATION (стадии 1–2), NOT_FOUND, STALE_VERSION (§5.2), INVARIANT (§4.2/§3.3,
// для цикла blocks в details — path, Task 10), FORBIDDEN_LEVEL (§7.10 «forbidden»: гейт
// скоупа гранта и периметр записи worker'а — tools/dispatch.ts, а также незнакомый тул),
// LIMIT (entitlements §8), CONFLICT (details.reason различает ДВА пути, потребитель не
// гадает по тексту: 'id_conflict' — client-UUID непригоден для создания, chat.appendMessage
// И entity_create executor'а, одиночный и batch; 'precondition_failed' — CAS-предусловие
// entity_update не выполнено под FOR UPDATE, С7. Единый wire-контракт финального ревью —
// 1b MCP и 1c retry-буфер ключуются на кодах, 409 = конфликт ресурса).
//
// КОДЫ РЕФОРМЫ СВОЙСТВ (D43) заведены ВСЕ РАЗОМ, а не по мере появления бросающих мест, и
// это осознанно. `ExecErrorCode` — закрытый union, а `TRPC_CODE_BY_EXEC` ниже —
// ИСЧЕРПЫВАЮЩИЙ `Record` по нему: код, добавленный без строки маппинга, роняет typecheck,
// а код, добавленный вместе со строкой, но позже, — это ещё одна правка двух файлов в
// каждой из десяти задач среза. Таблица кодов реформы ОДНА, и она здесь.
//
// Два кода приходят из `@orbis/shared`, а не объявляются здесь литералом: их бросает код,
// который живёт в shared и про сервер не знает (`assertPatternRegular` — §А2-2), а имя кода
// обязано быть одно на оба пакета. Импортируется КОНСТАНТА, `typeof` которой и есть
// строковый литеральный тип, — так исчерпывающая проверка `Record` продолжает работать.
import { PATTERN_NOT_REGULAR } from '@orbis/shared';
import { TRPCError } from '@trpc/server';

export type ExecErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'STALE_VERSION'
  | 'INVARIANT'
  | 'FORBIDDEN_LEVEL'
  | 'LIMIT'
  | 'CONFLICT'
  | 'LLM_UNAVAILABLE' // §7.9: сбой LLM-провайдера — явная ошибка, не очередь (Task 9)
  // --- Реформа свойств (D43) ---
  /** §А2-5/Б6: запись в свойство, которое пишет не этот источник (`model_writable: false`,
   *  `system_writable: true`, `computed`). Отказ по ОБЪЕКТУ, не по актору. */
  | 'COMPUTED_WRITE'
  /** §С8-7: создание ребра роли с `created_by: system` из пользовательского тула. */
  | 'ROLE_SYSTEM_ONLY'
  /** §А2-1/Р15: `scope` свойства или `ref.target` — не статический Q-AST (date-токены,
   *  `search=`, `this`, проекции внутри). Бросается из shared (Задача 8). */
  | 'SCOPE_NOT_STATIC'
  /** §А5-1, паспорт Q: запрос соединяет две свободные сущности — за границей языка Q.
   *  Отдельный код, а не VALIDATION: «невыразимо» обязано отличаться от «написано с
   *  ошибкой», иначе пустой результат читается как «ничего не нашлось» (§С8-3). */
  | 'QUERY_JOIN'
  /** §А5-1: обход по нескольким ролям сразу — тоже за границей Q. */
  | 'QUERY_MULTI_ROLE'
  /** §А2-7: кап 20 неподтверждённых `proposed` на владельца исчерпан. */
  | 'REGISTRY_LIMIT'
  /** §А3-3: дельта опирается на версию системного определения, которой уже нет
   *  (трёхстороннее слияние не сошлось) — конфликт, а не ошибка ввода. */
  | 'REGISTRY_CONFLICT'
  /** §С7-11: запись в реестр замкнула граф зависимостей (свойство → правило → свойство). */
  | 'REGISTRY_CYCLE'
  /** §А2-2: паттерн текстового свойства вне класса RE2 (lookahead, обратная ссылка) —
   *  такую схему не скомпилирует не-ECMA потребитель, и это причина `strict:false` D29. */
  | typeof PATTERN_NOT_REGULAR;

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
  FORBIDDEN_LEVEL: 'FORBIDDEN', // §7.10 «forbidden»: скоуп гранта, периметр worker'а, незнакомый тул
  LIMIT: 'TOO_MANY_REQUESTS',
  CONFLICT: 'CONFLICT', // занятый client-UUID (id_conflict) — 409, как и STALE_VERSION
  // §7.9: сбой провайдера — 503. tRPC v11 имеет SERVICE_UNAVAILABLE (JSON-RPC-совместимые
  // коды @trpc/server) — семантически точнее ближайших альтернатив (TIMEOUT/BAD_GATEWAY):
  // сервис временно недоступен, клиент показывает «повторить» (кнопка ретрая 1c)
  LLM_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  // --- Реформа свойств (D43) ---
  // 403 у обоих: запрет по ОБЪЕКТУ («это свойство сюда не пишут», «эту роль ставит только
  // сервер»), а не по вводу — повторять запрос с другим текстом бессмысленно.
  COMPUTED_WRITE: 'FORBIDDEN',
  ROLE_SYSTEM_ONLY: 'FORBIDDEN',
  // 400: декларация или запрос написаны так, что система их не принимает. QUERY_JOIN и
  // QUERY_MULTI_ROLE — «невыразимо в языке Q», и 400 здесь честнее 422: клиент не может
  // исправить данные, он обязан переписать запрос.
  SCOPE_NOT_STATIC: 'BAD_REQUEST',
  QUERY_JOIN: 'BAD_REQUEST',
  QUERY_MULTI_ROLE: 'BAD_REQUEST',
  [PATTERN_NOT_REGULAR]: 'BAD_REQUEST',
  // 429 — как у LIMIT: кап `proposed` (§А2-7) снимается разбором пачки, а не другим вводом.
  REGISTRY_LIMIT: 'TOO_MANY_REQUESTS',
  // 409 — как у STALE_VERSION и CONFLICT: состояние реестра разошлось с тем, на которое
  // опиралась операция, и разрешает это человек.
  REGISTRY_CONFLICT: 'CONFLICT',
  REGISTRY_CYCLE: 'CONFLICT',
};

export function execErrorToTRPC(error: StructuredError): TRPCError {
  const code = TRPC_CODE_BY_EXEC[error.code as ExecErrorCode] ?? 'INTERNAL_SERVER_ERROR';
  return new TRPCError({ code, message: error.message, cause: error });
}
