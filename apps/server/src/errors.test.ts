// apps/server/src/errors.test.ts
// Таблица кодов отказов и её перевод в HTTP. Главный страж полноты — не этот файл, а
// typecheck: `TRPC_CODE_BY_EXEC` объявлен как ИСЧЕРПЫВАЮЩИЙ `Record<ExecErrorCode, …>`, и
// код без строки маппинга не компилируется вовсе. Тест здесь стережёт второе — что перевод
// не «работает», а переводит В ТО ЖЕ, что обещано спекой: молча заменённый 409 на 400
// typecheck прошёл бы.
import { expect, test } from 'bun:test';
import { PATTERN_NOT_REGULAR } from '@orbis/shared';
import type { TRPCError } from '@trpc/server';
import { ExecError, type ExecErrorCode, execErrorToTRPC } from './errors';

/** Ожидание — дословно таблица §С8/плана Задачи 3 плюс восемь исходных кодов. */
const EXPECTED: Record<ExecErrorCode, TRPCError['code']> = {
  VALIDATION: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  STALE_VERSION: 'CONFLICT',
  INVARIANT: 'UNPROCESSABLE_CONTENT',
  FORBIDDEN_LEVEL: 'FORBIDDEN',
  LIMIT: 'TOO_MANY_REQUESTS',
  CONFLICT: 'CONFLICT',
  LLM_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  COMPUTED_WRITE: 'FORBIDDEN',
  ROLE_SYSTEM_ONLY: 'FORBIDDEN',
  SCOPE_NOT_STATIC: 'BAD_REQUEST',
  QUERY_JOIN: 'BAD_REQUEST',
  QUERY_MULTI_ROLE: 'BAD_REQUEST',
  REGISTRY_LIMIT: 'TOO_MANY_REQUESTS',
  REGISTRY_CONFLICT: 'CONFLICT',
  REGISTRY_CYCLE: 'CONFLICT',
  PATTERN_NOT_REGULAR: 'BAD_REQUEST',
};

test('каждый код ExecError переводится в обещанный код tRPC', () => {
  for (const [code, trpc] of Object.entries(EXPECTED)) {
    const err = execErrorToTRPC(new ExecError(code as ExecErrorCode, 'сообщение'));
    expect({ code, trpc: err.code }).toEqual({ code, trpc });
  }
});

// Девять кодов реформы (§С8, рулинг Р-П-6). Перечислены здесь ЯВНО, а не выведены из
// EXPECTED: без явного списка забытый в union'е код так же молча отсутствовал бы и в
// ожидании — тест проверял бы сам себя.
test('коды реформы свойств заведены все девять', () => {
  const reform = [
    'COMPUTED_WRITE',
    'ROLE_SYSTEM_ONLY',
    'SCOPE_NOT_STATIC',
    'QUERY_JOIN',
    'QUERY_MULTI_ROLE',
    'REGISTRY_LIMIT',
    'REGISTRY_CONFLICT',
    'REGISTRY_CYCLE',
    PATTERN_NOT_REGULAR,
  ];
  for (const code of reform) expect(Object.keys(EXPECTED)).toContain(code);
});

// Р-П-6: имя кода `PATTERN_NOT_REGULAR` живёт в shared строковой константой (её бросает
// `assertPatternRegular`, до сервера не знающий). Второго определения быть не должно —
// иначе одно из двух однажды переименуют, и отказ перестанет ловиться маппингом.
test('PATTERN_NOT_REGULAR берётся из shared, а не объявлен вторым литералом', () => {
  expect(PATTERN_NOT_REGULAR).toBe('PATTERN_NOT_REGULAR');
  expect(execErrorToTRPC(new ExecError(PATTERN_NOT_REGULAR, 'паттерн')).code).toBe('BAD_REQUEST');
});

test('неизвестный код — 500, а не тихий 400', () => {
  expect(execErrorToTRPC({ code: 'НЕ_КОД', message: 'x' }).code).toBe('INTERNAL_SERVER_ERROR');
});

test('исходная структурированная ошибка остаётся в cause', () => {
  const err = execErrorToTRPC(new ExecError('REGISTRY_CYCLE', 'цикл', { path: ['a', 'b'] }));
  expect((err.cause as ExecError).details).toEqual({ path: ['a', 'b'] });
});
