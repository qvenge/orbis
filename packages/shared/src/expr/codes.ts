/**
 * Коды отказов ТАЙП-ЧЕКЕРА языка E (§Б3, §С1-2). Строковыми константами ЗДЕСЬ — как
 * `PATTERN_NOT_REGULAR` (`registry/property-type.ts`) и по той же причине: их бросает код,
 * живущий в shared и про сервер не знающий, а имя обязано быть одно на оба пакета. `errors.ts`
 * импортирует КОНСТАНТУ, `typeof` которой и есть литеральный тип, — исчерпывающая проверка
 * `TRPC_CODE_BY_EXEC` продолжает работать. Сам чекер (`expr/check.ts`) приезжает задачей 3; коды
 * раньше него намеренно (Р-К-11): таблица кодов реформы одна, и заводить её по коду за задачу
 * значило бы править два файла в каждой. Пятый код (`DEREF_IN_CONSTRAINT`) заведён срезом Б-2 тем
 * же правилом одной таблицы — бросающая ветка приезжает задачей 1.
 */
export const EXPR_TYPE = 'EXPR_TYPE';
export const EXPR_NOT_TOTAL = 'EXPR_NOT_TOTAL';
export const EXPR_RECURSION = 'EXPR_RECURSION';
export const SECOND_LANGUAGE = 'SECOND_LANGUAGE';
/**
 * §Б3-3/§С1-2 (строка 20): `deref` в C-области правила записи. Отдельный код, а не прежний `EXPR_TYPE`
 * (`check.ts:478-481` — комментарий «свой код приезжает вместе с C-правилами в Б-2»): «правило записи не
 * читает чужую запись» — запрет по УСТРОЙСТВУ области, а не промах типа, и владельцу надо сказать именно
 * это. Бросает чекер по флагу области `ExprScope.derefDenied` (задача 1), поэтому имя — здесь.
 */
export const DEREF_IN_CONSTRAINT = 'DEREF_IN_CONSTRAINT';
export type ExprCheckCode =
  | typeof EXPR_TYPE
  | typeof EXPR_NOT_TOTAL
  | typeof EXPR_RECURSION
  | typeof SECOND_LANGUAGE
  | typeof DEREF_IN_CONSTRAINT;

/**
 * Отказ чекера. `path` — адрес узла внутри выражения (`['overdue','where','args',0]`): без него
 * владелец получил бы «тип не сошёлся» без указания места, а декларация подписки — дерево в сотню
 * узлов. Сервер переводит ошибку в `ExecError` тем же кодом.
 */
export class ExprCheckError extends Error {
  readonly code: ExprCheckCode;
  readonly path: readonly string[];
  readonly expected?: string;
  readonly actual?: string;
  constructor(
    code: ExprCheckCode,
    message: string,
    opts: { path?: readonly string[]; expected?: string; actual?: string } = {},
  ) {
    super(message);
    this.name = 'ExprCheckError';
    this.code = code;
    this.path = opts.path ?? [];
    this.expected = opts.expected;
    this.actual = opts.actual;
  }
}
