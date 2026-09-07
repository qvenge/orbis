/**
 * ГЕЙТ ЗАПИСИ E на сервере — единственная дверь, через которую E-выражение попадает в
 * реестр владельца.
 *
 * ВХОД-ДЕРЕВА 6 — шестой вход у деревьев конвейера и первый не у Q. Сюда приходят ВСЕ
 * E-выражения деклараций: предикат-наборы контракта (задача 4), декларации подписок
 * (задачи 5/6/9), правила аспекта (Б-2). Гейт один, потому что писателей E ровно столько,
 * сколько его зовут: `registry/ops.ts` и `subscriptions/registry.ts`.
 *
 * ПОРЯДОК — СУТЬ: глубина ПЕРВОЙ (у `exprNodeSchema` рекурсия `z.lazy`, а `safeParse` не
 * ловит `RangeError`), затем схема и типизация внутри `checkExpr`. Кап СВОЙ
 * (`EXPR_TREE_DEPTH_CAP`): у E другое дерево; обоснование числа — в его докблоке, второй
 * константы здесь нет.
 *
 * Самоссылку (`EXPR_RECURSION`) ловит `checkExpr`, а не этот гейт, и это не пропуск: сюда
 * значение приезжает из JSON — из аргумента тула или из jsonb реестра, — а в JSON цикл
 * невыразим. Код остаётся за структурами, собранными в процессе.
 */
import {
  checkExpr,
  EXPR_TREE_DEPTH_CAP,
  ExprCheckError,
  type ExprScope,
  type ExprType,
  exprTreeExceedsDepth,
} from '@orbis/shared/expr';
import { ExecError } from '../errors';

export function assertExprChecked(expr: unknown, scope: ExprScope): ExprType {
  if (exprTreeExceedsDepth(expr, EXPR_TREE_DEPTH_CAP)) {
    throw new ExecError(
      'VALIDATION',
      `выражение вложено глубже ${EXPR_TREE_DEPTH_CAP} уровней — такая декларация разворачивалась бы на каждом чтении реестра`,
      { reason: 'EXPR_TOO_DEEP', cap: EXPR_TREE_DEPTH_CAP },
    );
  }
  try {
    return checkExpr(expr, scope);
  } catch (e) {
    // Чекер живёт в shared и про сервер не знает: он бросает СВОЙ класс, а `execute` ловит
    // только `ExecError` — без перевода отказ приезжал бы пятисоткой (образец перевода
    // `PatternNotRegularError` в `registry/ops.ts`). Код тот же: четыре константы E —
    // члены `ExecErrorCode` (задача 1).
    if (e instanceof ExprCheckError) {
      throw new ExecError(e.code, e.message, {
        path: e.path,
        expected: e.expected,
        actual: e.actual,
      });
    }
    throw e;
  }
}
