import { expect, test } from 'bun:test';
import {
  DEREF_IN_CONSTRAINT,
  EXPR_NOT_TOTAL,
  EXPR_RECURSION,
  EXPR_TYPE,
  type ExprCheckCode,
  ExprCheckError,
  SECOND_LANGUAGE,
} from './codes';

test('имена кодов E — ровно пять и совпадают со своими литералами', () => {
  expect([EXPR_TYPE, EXPR_NOT_TOTAL, EXPR_RECURSION, SECOND_LANGUAGE, DEREF_IN_CONSTRAINT]).toEqual(
    ['EXPR_TYPE', 'EXPR_NOT_TOTAL', 'EXPR_RECURSION', 'SECOND_LANGUAGE', 'DEREF_IN_CONSTRAINT'],
  );
});

// Пятый код — Б-2: его бросит ЧЕКЕР (флаг области `derefDenied`, задача 1), а не сервер, поэтому имя
// живёт здесь, рядом с четырьмя, а не литералом в `errors.ts`. Проверка «он и правда член ExprCheckCode»
// — типом: присвоение литерала переменной этого типа не скомпилировалось бы, забудь мы union.
test('DEREF_IN_CONSTRAINT — член ExprCheckCode и годится конструктору отказа', () => {
  const code: ExprCheckCode = DEREF_IN_CONSTRAINT;
  const e = new ExprCheckError(code, 'deref в C-правиле записи', { path: ['when', 'args', '0'] });
  expect([e.code, e.path]).toEqual(['DEREF_IN_CONSTRAINT', ['when', 'args', '0']]);
});

test('ExprCheckError несёт код и адрес узла; без адреса — пустой путь, не undefined', () => {
  const e = new ExprCheckError(EXPR_TYPE, 'ждали number', {
    path: ['overdue', 'where'],
    expected: 'number',
    actual: 'text',
  });
  expect([e.code, e.path, e.expected, e.actual]).toEqual([
    'EXPR_TYPE',
    ['overdue', 'where'],
    'number',
    'text',
  ]);
  expect(new ExprCheckError(SECOND_LANGUAGE, 'строка в E-позиции').path).toEqual([]);
});
