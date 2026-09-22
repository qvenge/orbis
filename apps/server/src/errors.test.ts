// apps/server/src/errors.test.ts
// Таблица кодов отказов и её перевод в HTTP. Главный страж полноты — не этот файл, а
// typecheck: `TRPC_CODE_BY_EXEC` объявлен как ИСЧЕРПЫВАЮЩИЙ `Record<ExecErrorCode, …>`, и
// код без строки маппинга не компилируется вовсе. Тест здесь стережёт второе — что перевод
// не «работает», а переводит В ТО ЖЕ, что обещано спекой: молча заменённый 409 на 400
// typecheck прошёл бы.
import { expect, test } from 'bun:test';
import {
  DEREF_IN_CONSTRAINT,
  EXPR_NOT_TOTAL,
  EXPR_RECURSION,
  EXPR_TYPE,
  PATTERN_NOT_REGULAR,
  SECOND_LANGUAGE,
} from '@orbis/shared';
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
  // --- Б-1: контракты, привязки, подписки, язык E, модули ---
  BIND_TYPE: 'BAD_REQUEST',
  VARIANT_UNMAPPED: 'BAD_REQUEST',
  SLOT_AMBIGUOUS: 'BAD_REQUEST',
  SURFACE_UNKNOWN: 'BAD_REQUEST',
  SUBSCRIPTION_RAW_REF: 'BAD_REQUEST',
  MODULE_DISABLED: 'FORBIDDEN',
  [EXPR_TYPE]: 'BAD_REQUEST',
  [EXPR_NOT_TOTAL]: 'BAD_REQUEST',
  [EXPR_RECURSION]: 'BAD_REQUEST',
  [SECOND_LANGUAGE]: 'BAD_REQUEST',
  // --- Б-2: правила, действия ---
  ACTION_NESTED: 'BAD_REQUEST',
  ACTION_BRANCH: 'BAD_REQUEST',
  UNIQUE_ON_MANY: 'BAD_REQUEST',
  SENSITIVITY_UNDERDECLARED: 'BAD_REQUEST',
  BATCH_UNBOUNDED: 'BAD_REQUEST',
  RULE_CONFLICT: 'BAD_REQUEST',
  [DEREF_IN_CONSTRAINT]: 'BAD_REQUEST',
};

test('каждый код ExecError переводится в обещанный код tRPC', () => {
  for (const [code, trpc] of Object.entries(EXPECTED)) {
    const err = execErrorToTRPC(new ExecError(code as ExecErrorCode, 'сообщение'));
    expect({ code, trpc: err.code }).toEqual({ code, trpc });
  }
});

// Двадцать шесть кодов реформы (§С1-2: 21 строка / 24 имени плюс REGISTRY_LIMIT и REGISTRY_CONFLICT,
// которых в §С1-2 нет; десять из них завёл срез Б-1, семь — срез Б-2). Перечислены здесь ЯВНО, а не
// выведены из EXPECTED: без явного списка забытый в union'е код так же молча отсутствовал бы и в
// ожидании — тест проверял бы сам себя.
test('коды реформы свойств заведены все двадцать шесть', () => {
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
    'BIND_TYPE',
    'VARIANT_UNMAPPED',
    'SLOT_AMBIGUOUS',
    'SURFACE_UNKNOWN',
    'SUBSCRIPTION_RAW_REF',
    'MODULE_DISABLED',
    EXPR_TYPE,
    EXPR_NOT_TOTAL,
    EXPR_RECURSION,
    SECOND_LANGUAGE,
    'ACTION_NESTED',
    'ACTION_BRANCH',
    'UNIQUE_ON_MANY',
    'SENSITIVITY_UNDERDECLARED',
    'BATCH_UNBOUNDED',
    'RULE_CONFLICT',
    DEREF_IN_CONSTRAINT,
  ];
  expect(reform.length).toBe(26);
  for (const code of reform) expect(Object.keys(EXPECTED)).toContain(code);
  expect(Object.keys(EXPECTED).length).toBe(34);
});

// Р-И-10: имя `DEREF_IN_CONSTRAINT` приходит из shared, как четыре кода E и PATTERN_NOT_REGULAR, —
// бросает его тайп-чекер, до сервера не знающий. Второго определения быть не должно: одно из двух
// однажды переименуют, и отказ перестанет ловиться маппингом.
test('DEREF_IN_CONSTRAINT берётся из shared и переводится в 400', () => {
  expect(DEREF_IN_CONSTRAINT).toBe('DEREF_IN_CONSTRAINT');
  expect(execErrorToTRPC(new ExecError(DEREF_IN_CONSTRAINT, 'deref в C-правиле')).code).toBe(
    'BAD_REQUEST',
  );
});

// Почему у всех семи 400, а не 422/403: каждый из них — отказ ДЕКЛАРАЦИИ (правила, действия), написанной
// так, что система её не принимает; другими данными он не снимается, автор обязан переписать декларацию.
// 422 (INVARIANT) остаётся за нарушением инварианта ЗАПИСИ, 403 — за запретом по объекту (MODULE_DISABLED).
test('шесть кодов Б-2 сервера — 400 каждый', () => {
  for (const code of [
    'ACTION_NESTED',
    'ACTION_BRANCH',
    'UNIQUE_ON_MANY',
    'SENSITIVITY_UNDERDECLARED',
    'BATCH_UNBOUNDED',
    'RULE_CONFLICT',
  ] as const) {
    expect({ code, trpc: execErrorToTRPC(new ExecError(code, 'декларация')).code }).toEqual({
      code,
      trpc: 'BAD_REQUEST',
    });
  }
});

// Р-И-1: имена кодов чекера E живут в shared константами (их бросает `ExprCheckError`, до
// сервера не знающий) — как `PATTERN_NOT_REGULAR`. Второго определения быть не должно.
test('коды E берутся из shared и переводятся в 400', () => {
  expect([EXPR_TYPE, EXPR_NOT_TOTAL, EXPR_RECURSION, SECOND_LANGUAGE]).toEqual([
    'EXPR_TYPE',
    'EXPR_NOT_TOTAL',
    'EXPR_RECURSION',
    'SECOND_LANGUAGE',
  ]);
  expect(execErrorToTRPC(new ExecError(EXPR_TYPE, 'тип')).code).toBe('BAD_REQUEST');
});

// MODULE_DISABLED — 403, а не 400: отказ по ОБЪЕКТУ («модуль выключен»), и повторять запрос
// с другим текстом бессмысленно (§Б8-3; тот же довод, что у COMPUTED_WRITE).
test('MODULE_DISABLED — 403', () => {
  expect(execErrorToTRPC(new ExecError('MODULE_DISABLED', 'выключен')).code).toBe('FORBIDDEN');
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
