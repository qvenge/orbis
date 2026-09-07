import { expect, test } from 'bun:test';
import {
  EXPR_NOT_TOTAL,
  EXPR_RECURSION,
  EXPR_TYPE,
  ExprCheckError,
  SECOND_LANGUAGE,
} from './codes';

test('имена кодов E — ровно четыре и совпадают со своими литералами', () => {
  expect([EXPR_TYPE, EXPR_NOT_TOTAL, EXPR_RECURSION, SECOND_LANGUAGE]).toEqual([
    'EXPR_TYPE',
    'EXPR_NOT_TOTAL',
    'EXPR_RECURSION',
    'SECOND_LANGUAGE',
  ]);
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
