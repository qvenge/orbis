// apps/server/src/expr/eval.ts
// ВТОРОЙ бэкенд языка E (§Б3-5) — интерпретатор ФОРМУЛ поверх уже прочитанных значений: строки
// ведомостей Budget (§Б5-4: effective_limit / remaining / daily_pace / порог alerts / ключ порядка
// карточек) считаются здесь. Первый бэкенд — предикатный (`expr/compile.ts`): он переводит E в WHERE
// и живёт над МНОЖЕСТВАМИ, а не над строкой.
//
// Почему интерпретатор на сервере, а не в shared (Р-И-14): вся точная decimal-арифметика монорепо —
// `budget/decimal.ts`, и её докблок говорит «ЕДИНСТВЕННАЯ точная decimal-арифметика сервера». Формулы
// исполняет только сервер; переезд арифметики в shared ради второго дома интерпретатора завёл бы
// второй разбор decimal-строк.
//
// ЧТО ЭТОТ БЭКЕНД СЧИТАЕТ, А ЧТО ОТДАЁТ ДРУГОМУ — часть контракта, а не умолчание (§С8-3
// «невыразимое — ошибка, а не пустота»):
//   считает    — const, duration, prop, slot, param, ctx:$today, agg, phase, has, deref, op×15,
//                date_diff, days_inclusive, date_add дневной гранулярности;
//   отказывает — class, has_relation, agg_via (нужен граф: у области ведомости ровно одна привязка
//                своего контракта, а класс сущности резолвится по привязкам ВСЕХ её аспектов —
//                второй ответчик разошёлся бы с `compileClassMembership` на сущности с двумя
//                аспектами), ctx:$owner/$self/$sensitivity (личность и чувствительность — области
//                правил и классификатора, у ведомости их нет: см. форму ExprEvalScope), date_add с
//                годами/месяцами/временем суток (кламп «31 января + 1 месяц» — правило, у которого
//                в Б-1 нет ни одного потребителя-декларации: окна Budget задаются параметрами
//                period_start/period_end/horizon_end, Р-К-4; в SQL кламп делает сам Postgres).
import type { ResolvedBinding } from '@orbis/shared';
import {
  EXPR_TREE_DEPTH_CAP,
  type ExprNode,
  type ExprOp,
  type ExprScalar,
} from '@orbis/shared/expr';
import { decAdd, decCmp, decDiv, decMul, decSub } from '../budget/decimal';
import { ExecError } from '../errors';

export interface ExprEvalScope {
  /** Параметры ведомости (Р-К-4: period_start | period_end | horizon_end). */
  params: Record<string, ExprScalar>;
  /** Уже посчитанные величины ТОЙ ЖЕ ведомости; порядок обеспечивает движок (§Б3-2, ациклично). */
  aggs: Record<string, ExprScalar>;
  phase: string | null;
  props: Record<string, unknown>;
  /** Привязка области: без неё `{slot}`, `{has: слот}` и `{deref:{slot}}` незаконны (§Б5-4). */
  binding?: ResolvedBinding;
  /**
   * Умолчания ЧТЕНИЯ из реестра: id свойства → `type.default` (РП-9, `registry/types.ts`).
   * Не запись, а чтение: на записи умолчание не материализуется, и `has` его не видит (ниже).
   *
   * Поле есть, потому что второй бэкенд того же языка E его уже применяет: `castedExpr`
   * (`query/compile-ast.ts`, булева ветка) пишет
   * `COALESCE((props->>'orbis/planned')::boolean, false)`. Без карты одно и то же выражение
   * `planned = false` в SQL отвечало бы «да», а здесь «нет» — язык с двумя ответами перестаёт быть
   * языком. §Б3-4 называет умолчание явно: тотальности требует арифметика «с отсутствующим свойством
   * БЕЗ `default`».
   *
   * Наполняет движок ведомостей (задача 9) один раз на снимок реестра:
   *   const defaults = new Map<string, ExprScalar>();
   *   for (const [id, def] of reg.properties) {
   *     if (def.type.kind === 'boolean' && def.type.default !== undefined) defaults.set(id, def.type.default);
   *   }
   * Карта опущена (`undefined`) — семантика прежняя, §Б3-4 без умолчаний: так живут чистые тесты.
   */
  defaults?: ReadonlyMap<string, ExprScalar>;
  /** «Сегодня» владельца в его таймзоне (R17) — вычисляет движок (`localTodayTx`), не этот файл. */
  today: string;
  /** Одношаговое чтение цели `ref` (§Б3-3): props цели + core-id + `tags`; нет цели → null. */
  deref?: (id: string) => Record<string, unknown> | null;
}

export type ExprValue = string | number | boolean | null | readonly string[];

/**
 * Причины структурного отказа бэкенда — ЗАКРЫТЫЙ union, а не свободная строка. Q-компилятор пишет
 * `fail(reason: string, …)` (`query/compile-ast.ts`), и опечатка в имени причины там компилируется
 * молча; здесь опечатка красит typecheck.
 *  EXPR_ARITH               — RangeError decimal-арифметики или календаря (деление на ноль, не
 *                             decimal-строка, несуществующая дата, арифметика над отсутствующим);
 *  EXPR_BACKEND_UNSUPPORTED — форма канона, которую считает ДРУГОЙ бэкенд (таблица в шапке);
 *  EXPR_SCOPE               — имя, которого нет в области ведомости (параметр, величина, слот вне
 *                             контракта, отсутствующий читатель deref) — дефект декларации/движка;
 *  EXPR_VALUE               — значение не выражается скаляром E (json-объект, список в скалярной
 *                             позиции, небулево в булевой, неверная арность оператора);
 *  EXPR_DEPTH               — бюджет вычисления §Б3-2.
 */
type RefusalReason =
  | 'EXPR_ARITH'
  | 'EXPR_BACKEND_UNSUPPORTED'
  | 'EXPR_SCOPE'
  | 'EXPR_VALUE'
  | 'EXPR_DEPTH';

function fail(reason: RefusalReason, message: string, extra?: Record<string, unknown>): never {
  throw new ExecError('VALIDATION', message, { reason, ...extra });
}

/**
 * RangeError — единственный класс, которым отвечают `decimal.ts` и `date.ts`. Наружу он обязан выйти
 * структурной ошибкой §9.2, а не пятисоткой: движок ведомостей считает 480 конвертов в одном ответе,
 * и «не посчиталось на этом» должно быть читаемо.
 */
function guarded<T>(what: string, compute: () => T): T {
  try {
    return compute();
  } catch (e) {
    if (e instanceof RangeError) fail('EXPR_ARITH', `${what}: ${e.message}`);
    throw e;
  }
}

/** Значение из `props` в скаляр E; json-объект сюда доехать не должен — его ловит чекер (§С8-28). */
function scalarOf(raw: unknown, what: string): ExprValue {
  if (raw === undefined || raw === null) return null;
  const kind = typeof raw;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return raw as ExprValue;
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
    return raw as readonly string[];
  }
  return fail('EXPR_VALUE', `значение ${what} не выражается скаляром E`);
}

/**
 * Чтение значения свойства по id — ЕДИНСТВЕННОЕ место, где применяется умолчание реестра.
 * Правило одно для своей строки и для цели `deref`: умолчание принадлежит СВОЙСТВУ, а не строке, и
 * разное правило для «своего» и «чужого» `planned` развело бы два чтения одного реестра.
 */
function propValue(
  props: Record<string, unknown>,
  propertyId: string,
  scope: ExprEvalScope,
  what: string,
): ExprValue {
  const raw = props[propertyId];
  if (raw !== undefined && raw !== null) return scalarOf(raw, what);
  const fallback = scope.defaults?.get(propertyId);
  return fallback === undefined ? null : fallback; // умолчание может быть объявлено как null
}

function slotValue(slot: string, scope: ExprEvalScope): ExprValue {
  const binding = scope.binding;
  if (binding === undefined) {
    return fail('EXPR_SCOPE', `слот '${slot}' вне области с контрактом: привязки нет`, { slot });
  }
  const propertyId = binding.bind[slot];
  if (propertyId !== undefined) {
    return propValue(scope.props, propertyId, scope, `слота '${slot}' (${propertyId})`);
  }
  const fixed = binding.fixed[slot];
  if (fixed !== undefined) return fixed;
  return null; // §Б2-3: необязательный слот можно не связывать — это отсутствие, а не отказ
}

export function evalExpr(expr: ExprNode, scope: ExprEvalScope): ExprValue {
  return ev(expr, scope, 0);
}

function ev(node: ExprNode, scope: ExprEvalScope, depth: number): ExprValue {
  if (depth > EXPR_TREE_DEPTH_CAP) {
    return fail('EXPR_DEPTH', `дерево глубже ${EXPR_TREE_DEPTH_CAP} — бюджет вычисления §Б3-2`);
  }
  if ('const' in node) return node.const as ExprValue;
  if ('duration' in node) return node.duration;
  if ('prop' in node) return propValue(scope.props, node.prop, scope, `свойства '${node.prop}'`);
  if ('slot' in node) return slotValue(node.slot, scope);
  if ('param' in node) {
    if (!(node.param in scope.params)) {
      return fail('EXPR_SCOPE', `параметра '${node.param}' нет в области ведомости`, {
        param: node.param,
      });
    }
    return scope.params[node.param] ?? null;
  }
  if ('agg' in node) {
    if (!(node.agg in scope.aggs)) {
      return fail('EXPR_SCOPE', `величины '${node.agg}' нет в области ведомости`, {
        agg: node.agg,
      });
    }
    return scope.aggs[node.agg] ?? null;
  }
  if ('phase' in node) return scope.phase === node.phase;
  if ('ctx' in node) {
    if (node.ctx === '$today') return scope.today;
    return fail('EXPR_BACKEND_UNSUPPORTED', `контекст '${node.ctx}' бэкенду формул недоступен`, {
      ctx: node.ctx,
    });
  }
  if ('class' in node) {
    return fail(
      'EXPR_BACKEND_UNSUPPORTED',
      'класс сущности считает предикатный бэкенд (compileClassMembership)',
      { contract: node.class.contract },
    );
  }
  if ('has_relation' in node) {
    return fail('EXPR_BACKEND_UNSUPPORTED', 'наличие ребра считает предикатный бэкенд', {
      role: node.has_relation.role,
    });
  }
  if ('agg_via' in node) {
    return fail(
      'EXPR_BACKEND_UNSUPPORTED',
      'Е-2 (agg_via) — опубликованные величины соседа, бэкенд в Б-2',
      { role: node.agg_via.role, name: node.agg_via.name },
    );
  }
  if ('has' in node) return hasValue(node.has, scope);
  if ('op' in node) return applyOp(node.op, node.args, scope, depth);
  return fail('EXPR_VALUE', `неизвестная форма узла E: ${JSON.stringify(node)}`);
}

/** Текст, который выглядит как число: только по НЕМУ включается численное сравнение. */
const NUMERIC_TEXT_RE = /^-?\d+(?:\.\d+)?$/;

function numericLike(value: ExprValue): value is string | number {
  return typeof value === 'number' || (typeof value === 'string' && NUMERIC_TEXT_RE.test(value));
}

function cmpText(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Сравнение. Два правила, и оба — решение, а не умолчание:
 *  1) §Б3-4: сравнение с ОТСУТСТВУЮЩИМ значением — ложь у всех шести операторов, `!=` тоже. Иначе
 *     `!=` на пустом свойстве отвечал бы «да» и открывал бы fail-open там, где вся семантика §6.1
 *     закрыта (`negated` Q-компилятора делает то же — `NOT COALESCE(x, false)`).
 *  2) Численно сравниваются оба операнда, ЕСЛИ оба выглядят числом (`NUMERIC_TEXT_RE` или `number`):
 *     '850.0' и '850.00' обязаны быть равны, потому что decimal в E — строка (ревизия 3). Остальное —
 *     лексикографически, и это ровно то, чем живут даты: у ISO 'YYYY-MM-DD' лексикографический
 *     порядок и есть хронологический (`phaseOf` в `aggregates.ts` сравнивает так же).
 *     Названный остаток: два ТЕКСТОВЫХ свойства, чьи значения оба выглядят числом ('007' и '7'),
 *     сравнятся численно. Тип операндов знает чекер (задача 3), а не рантайм: доступа к видам
 *     свойств у области ведомости нет по построению (форма `ExprEvalScope`), и добавлять его сюда
 *     значило бы завести второй реестр в горячем цикле на 480 конвертов. Живого потребителя у
 *     остатка в Б-1 нет: единственный текст ведомости — `deref(category).title`, и он идёт в ключ
 *     порядка, а не в `=`.
 */
function compare(op: '=' | '!=' | '>' | '<' | '>=' | '<=', a: ExprValue, b: ExprValue): boolean {
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b))
    fail('EXPR_VALUE', `список в позиции сравнения '${op}'`);
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    if (op === '=') return a === b;
    if (op === '!=') return a !== b;
    return fail('EXPR_VALUE', `порядковое сравнение '${op}' над булевым значением`);
  }
  const sign =
    numericLike(a) && numericLike(b)
      ? guarded(`сравнение '${op}'`, () => decCmp(String(a), String(b)))
      : cmpText(String(a), String(b));
  switch (op) {
    case '=':
      return sign === 0;
    case '!=':
      return sign !== 0;
    case '>':
      return sign > 0;
    case '<':
      return sign < 0;
    case '>=':
      return sign >= 0;
    default:
      return sign <= 0;
  }
}

function binary(op: ExprOp, args: readonly ExprNode[]): [ExprNode, ExprNode] {
  if (args.length !== 2) {
    fail('EXPR_VALUE', `оператор '${op}' ожидает ровно два аргумента`, { got: args.length });
  }
  return [args[0] as ExprNode, args[1] as ExprNode];
}

function applyOp(
  op: ExprOp,
  args: readonly ExprNode[],
  scope: ExprEvalScope,
  depth: number,
): ExprValue {
  const d = depth + 1;
  switch (op) {
    case '=':
    case '!=':
    case '>':
    case '<':
    case '>=':
    case '<=': {
      const [left, right] = binary(op, args);
      return compare(op, ev(left, scope, d), ev(right, scope, d));
    }
    case 'and':
    case 'or': {
      if (args.length < 2) fail('EXPR_VALUE', `оператор '${op}' требует не меньше двух аргументов`);
      // Короткое замыкание — не оптимизация, а условие тотальности: `daily_pace` §Б5-4 закрывает
      // делением на ноль плечо, которое в закрытой фазе считаться не должно (дней не осталось).
      const decisive = op === 'or';
      for (const arg of args) {
        if (truthy(ev(arg, scope, d)) === decisive) return decisive;
      }
      return !decisive;
    }
    case 'not': {
      if (args.length !== 1) fail('EXPR_VALUE', `оператор 'not' ожидает ровно один аргумент`);
      return !truthy(ev(args[0] as ExprNode, scope, d));
    }
    case 'in': {
      const [left, right] = binary(op, args);
      const value = ev(left, scope, d);
      const list = ev(right, scope, d);
      if (value === null) return false; // §Б3-4: членство отсутствующего — ложь
      if (!Array.isArray(list)) fail('EXPR_VALUE', `правый операнд 'in' — не список строк`);
      return (list as readonly string[]).some((item) => item === String(value));
    }
    case '+':
    case '-':
    case '*':
    case '/': {
      const [left, right] = binary(op, args);
      return arith(op, ev(left, scope, d), ev(right, scope, d));
    }
    default:
      return fail('EXPR_BACKEND_UNSUPPORTED', `оператор '${op}' ещё не подключён`, { op });
  }
}

/**
 * Арифметика. Три решения:
 *  1) отсутствующий операнд — ОТКАЗ, а не ноль: §Б3-4 объявляет такую формулу ошибкой типизации ПРИ
 *     СОХРАНЕНИИ (`EXPR_NOT_TOTAL`), то есть сюда она доехать не должна; подстановка нуля соврала бы
 *     деньгами тихо (ровно то, что делает `carryover ?? '0'` оракула — и там это допустимо только
 *     потому, что после среза А валидатор не пускает нестроку в decimal-свойство, Р-К-13);
 *  2) строка в арифметической позиции — decimal-строка: тип проверил чекер, а `parseDec` всё равно
 *     ответит RangeError на не-decimal, и он станет EXPR_ARITH;
 *  3) деление ВСЕГДА отдаёт decimal (масштаб 2): `daily_pace` §Б5-4 делит decimal на число дней, и
 *     целочисленного деления в языке нет вовсе — иначе «остаток/дни» молча терял бы копейки.
 */
function arith(op: '+' | '-' | '*' | '/', a: ExprValue, b: ExprValue): ExprValue {
  if (a === null || b === null)
    fail('EXPR_ARITH', `арифметика '${op}' над отсутствующим значением`);
  if (Array.isArray(a) || Array.isArray(b) || typeof a === 'boolean' || typeof b === 'boolean') {
    fail('EXPR_VALUE', `операнд '${op}' не число и не decimal`);
  }
  if (op === '/') return guarded('деление', () => decDiv(String(a), String(b)));
  if (typeof a === 'number' && typeof b === 'number') {
    return op === '+' ? a + b : op === '-' ? a - b : a * b;
  }
  return guarded(`арифметика '${op}'`, () =>
    op === '+'
      ? decAdd(String(a), String(b))
      : op === '-'
        ? decSub(String(a), String(b))
        : decMul(String(a), String(b)),
  );
}

/** Небулево в булевой позиции ловит чекер (§С8-28); отсутствие — ложь (fail-closed §Б3-4). */
function truthy(value: ExprValue): boolean {
  if (value === null) return false;
  if (typeof value !== 'boolean') {
    fail('EXPR_VALUE', `в булевой позиции не булево: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * `has` берёт имя И как слот (когда область с контрактом его реализует), И как id свойства: §Б3-5
 * пишет `{has: <prop-id>}`, а декларация подписки §Б5-4 живёт в слотах (`if(has(carryover), …)`).
 * Разные имена для одного вопроса развели бы декларацию и правило.
 *
 * Умолчание реестра здесь НЕ применяется — спрашивают про записанное значение: `orbis/planned`
 * объявлен `default: false`, на записи не материализуется, и комментарий реестра
 * (`registry/types.ts`) требует ровно этого — «иначе `has(orbis/planned)` стал бы истинным у
 * каждой транзакции». Проверка `scalarOf` остаётся: json-объект в позиции значения — отказ, а не «есть».
 */
function hasValue(name: string, scope: ExprEvalScope): boolean {
  const binding = scope.binding;
  if (binding !== undefined) {
    const propertyId = binding.bind[name];
    if (propertyId !== undefined)
      return scalarOf(scope.props[propertyId], `слота '${name}'`) !== null;
    if (name in binding.fixed) return true; // fixed — значение самой декларации, оно есть всегда
  }
  return scalarOf(scope.props[name], `свойства '${name}'`) !== null;
}
