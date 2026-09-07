/**
 * ДОМ ЯЗЫКА E (§Б3-5) — канон узлов, единственный язык формул и предикатов деклараций.
 *
 * Язык E и язык Q — РАЗНЫЕ языки над одним графом: Q отбирает СУЩНОСТИ («покажи задачи со
 * сроком до пятницы»), E считает и решает ЗНАЧЕНИЕ на одной сущности или ведомости («сумма
 * лимита и переноса», «эта операция — факт»). Поэтому дерево здесь своё, а не расширение
 * `QueryFilterNode`: у Q нет ни типов операндов, ни арифметики, ни слотов контракта, а у E
 * нет ни проекции, ни сортировки, ни поиска.
 *
 * КАП ГЛУБИНЫ — СВОЙ (`EXPR_TREE_DEPTH_CAP`), потому что дерево другое: число сегодня
 * совпадает с `QUERY_TREE_DEPTH_CAP`, но совпадение — не связь. Сдвинется граница у Q —
 * здесь не изменится ничего, и наоборот. МЕХАНИКА при этом одна на два языка (см.
 * `exprTreeExceedsDepth`): два обхода одной и той же вложенности — это два ответа на один
 * вопрос.
 */
import { z } from 'zod';
import { queryTreeExceedsDepth } from '../query/ast';

/**
 * Предел вложенности E-дерева. Число взято от Q (`QUERY_TREE_DEPTH_CAP`) НЕ импортом, а
 * измерением: самое глубокое выражение спеки — `daily_pace` §Б5-4 — занимает 7 уровней JSON,
 * то есть кап даёт девятикратный запас (пиннится тестом корпуса `EXPR_FIXTURES`). Запас
 * нужен не выражениям владельца, а гарантии: за гейтом стоит `z.lazy`, и достаточно глубокий
 * вход исчерпал бы стек раньше любого условия ВНУТРИ схемы.
 *
 * Проверяется ЯВНЫМ обходом ДО zod — тот же порядок и та же причина, что у пяти гейтов Q
 * (докблок `query/ast.ts`, «ВХОДОВ У ДЕРЕВА СНАРУЖИ ПЯТЬ»).
 */
export const EXPR_TREE_DEPTH_CAP = 64;

/**
 * Глубже ли значение, чем `cap` уровней вложенности JSON.
 *
 * Обход ОДИН на два языка: реализация Q считает вложенность СЫРОГО значения и ничего не
 * знает про канон, поэтому подходит E дословно, а два обхода одной вложенности были бы двумя
 * ответами на один вопрос. Своя здесь только КОНСТАНТА — она про другое дерево.
 */
export function exprTreeExceedsDepth(value: unknown, cap: number): boolean {
  return queryTreeExceedsDepth(value, cap);
}

/**
 * Операторы §Б3-5 — РОВНО 15. Арность каждого — часть формы, а не проверка чекера: вход
 * `expr:` тула владельца идёт мимо тайп-чекера ровно так же, как `ast:` у Q, и `{op:'not'}`
 * с двумя аргументами обязан отвергаться схемой (§С8-3 «невыразимое — ошибка, а не пустота»).
 */
export const EXPR_OPS = [
  '=',
  '!=',
  '>',
  '<',
  '>=',
  '<=',
  '+',
  '-',
  '*',
  '/',
  'and',
  'or',
  'not',
  'in',
  'if',
] as const;
export type ExprOp = (typeof EXPR_OPS)[number];

/**
 * Контекстные величины §Б3-5. `$sensitivity` стоит особняком: он законен ТОЛЬКО в области с
 * `allowSensitivity` (правило `assign_level`, Б-2) — см. `checkExpr`.
 */
export const EXPR_CTX = ['$today', '$owner', '$self', '$sensitivity'] as const;
export type ExprCtx = (typeof EXPR_CTX)[number];

/**
 * Имена форм узла — 16 форм канона §Б3-5 плюс `slot` (Р-И-10): слот контракта адресуется
 * отдельной ветвью, потому что имя слота живёт ВНУТРИ контракта, а не в реестре свойств.
 * Список — мерка полноты корпуса `EXPR_FIXTURES` (§С8-28) и порядок разбора в печати.
 */
export const EXPR_FORMS = [
  'const',
  'duration',
  'prop',
  'slot',
  'param',
  'ctx',
  'agg',
  'phase',
  'agg_via',
  'deref',
  'op',
  'has',
  'has_relation',
  'class',
  'date_add',
  'date_diff',
  'days_inclusive',
] as const;
export type ExprForm = (typeof EXPR_FORMS)[number];

/**
 * Скаляр значения. Decimal — ТОЛЬКО строка («0.85»), число здесь всегда целое (дни, счёт):
 * §А2-2 и Р-К-13. Дробное JSON-число потеряло бы хвост копеек ещё до чекера, поэтому оно
 * отвергается типом, а не округляется.
 */
export type ExprScalar = string | number | boolean | null;

/**
 * ISO 8601 БЕЗ lookahead: `(?!` — та самая конструкция, из-за которой схема не компилируется
 * у не-ECMA потребителя (D29, `assertPatternRegular` в `registry/property-type.ts`), а этот
 * паттерн уезжает в `exprJsonSchema` и дальше в схему тула владельца. Условие «хотя бы один
 * компонент» выражено ПЕРЕЧИСЛЕНИЕМ первого присутствующего, а не отрицательным просмотром.
 */
export const EXPR_DURATION_PATTERN =
  '^P(\\d+Y(\\d+M)?(\\d+W)?(\\d+D)?|\\d+M(\\d+W)?(\\d+D)?|\\d+W(\\d+D)?|\\d+D)' +
  '(T(\\d+H(\\d+M)?(\\d+S)?|\\d+M(\\d+S)?|\\d+S))?$|^PT(\\d+H(\\d+M)?(\\d+S)?|\\d+M(\\d+S)?|\\d+S)$';
export const EXPR_DURATION_RE = new RegExp(EXPR_DURATION_PATTERN);

/**
 * Узел выражения §Б3-5 — 17 ветвей. Форма каждой ветви: один ключ-имя, разбор union'а по
 * ключу (тот же приём, что у `QueryFilterNode`).
 */
export type ExprNode =
  /** Массив строк — только справа у `in`: явный список классов либо тегов. */
  | { const: ExprScalar | readonly string[] }
  | { duration: string }
  /** id свойства после нормализации (`key` до неё). */
  | { prop: string }
  /** Слот контракта ОБЛАСТИ (Р-И-10): имя внутри контракта, не запись реестра. */
  | { slot: string }
  | { param: string }
  | { ctx: ExprCtx }
  /** Величина ТОЙ ЖЕ ведомости (§Б3-2 «ациклично по построению»). */
  | { agg: string }
  /** «Ведомость в фазе» → boolean (Р-И-16). */
  | { phase: string }
  /** Е-2: опубликованная величина по ребру роли. */
  | { agg_via: { role: string; name: string } }
  /** Ровно один из `prop`/`slot`; `read` — id свойства (в т.ч. core) либо имя ядра `tags`. */
  | { deref: { prop?: string; slot?: string; read: string } }
  | { op: ExprOp; args: readonly ExprNode[] }
  /** id свойства ЛИБО имя слота в области с контрактом. */
  | { has: string }
  /** Е-1 + ревизия 3: входящее ребро роли, при желании — состояние дальнего конца. */
  | { has_relation: { role: string; in_set?: { contract: string; set: string }; alive?: boolean } }
  /** Класс самой сущности под контрактом → тип `class<contract>`. */
  | { class: { contract: string } }
  /** (date|timestamp, duration) → тот же род, что слева. */
  | { date_add: readonly [ExprNode, ExprNode] }
  /** (date, date) → число дней, знаковое. */
  | { date_diff: readonly [ExprNode, ExprNode] }
  /** (date, date) → число дней ≥ 0, границы включены. */
  | { days_inclusive: readonly [ExprNode, ExprNode] };

// ─────────────────────────── zod-схема канона ───────────────────────────

const N = z.string().min(1);
const constValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()).min(1),
]);

/**
 * Рекурсия через `z.lazy`, вход помечен `unknown`: схема — гейт НЕДОВЕРЕННОГО входа (jsonb
 * реестра, аргумент тула владельца), и обещать типизированный вход было бы ложью.
 *
 * ЧЕГО ЭТОТ ГЕЙТ НЕ ДЕЛАЕТ — он про форму, а не про глубину: `z.lazy` спускается рекурсивно
 * и исчерпывает стек раньше любого условия внутри схемы. Глубину стережёт
 * `exprTreeExceedsDepth` — явным обходом и ДО zod (см. `checkExpr` и `assertExprChecked`).
 *
 * АРНОСТЬ — ЧАСТЬ ФОРМЫ, и потому `{op}` разложен на четыре ветки: `not` — один аргумент,
 * `if` — ровно три, `and`/`or` — два и больше, прочие одиннадцать — ровно два. Приём тот же,
 * каким форма `rel` в Q связана с `kind` (докблок `query/ast-json-schema.ts`): необязательные
 * поля вместо веток пропустили бы `{op:'not', args:[a,b]}` мимо разбора прямо в компилятор.
 */
export const exprNodeSchema: z.ZodType<ExprNode, z.ZodTypeDef, unknown> = z.lazy(
  () =>
    z.union([
      z.object({ const: constValueSchema }).strict(),
      z.object({ duration: z.string().regex(EXPR_DURATION_RE, 'длительность ISO 8601') }).strict(),
      z.object({ prop: N }).strict(),
      z.object({ slot: N }).strict(),
      z.object({ param: N }).strict(),
      z.object({ ctx: z.enum(EXPR_CTX) }).strict(),
      z.object({ agg: N }).strict(),
      z.object({ phase: N }).strict(),
      z.object({ agg_via: z.object({ role: N, name: N }).strict() }).strict(),
      z
        .object({
          deref: z.union([
            z.object({ prop: N, read: N }).strict(),
            z.object({ slot: N, read: N }).strict(),
          ]),
        })
        .strict(),
      z
        .object({
          op: z.enum(['=', '!=', '>', '<', '>=', '<=', '+', '-', '*', '/', 'in']),
          args: z.tuple([exprNodeSchema, exprNodeSchema]),
        })
        .strict(),
      z.object({ op: z.literal('not'), args: z.tuple([exprNodeSchema]) }).strict(),
      z
        .object({
          op: z.literal('if'),
          args: z.tuple([exprNodeSchema, exprNodeSchema, exprNodeSchema]),
        })
        .strict(),
      z.object({ op: z.enum(['and', 'or']), args: z.array(exprNodeSchema).min(2) }).strict(),
      z.object({ has: N }).strict(),
      z
        .object({
          has_relation: z
            .object({
              role: N,
              in_set: z.object({ contract: N, set: N }).strict().optional(),
              alive: z.boolean().optional(),
            })
            .strict(),
        })
        .strict(),
      z.object({ class: z.object({ contract: N }).strict() }).strict(),
      z.object({ date_add: z.tuple([exprNodeSchema, exprNodeSchema]) }).strict(),
      z.object({ date_diff: z.tuple([exprNodeSchema, exprNodeSchema]) }).strict(),
      z.object({ days_inclusive: z.tuple([exprNodeSchema, exprNodeSchema]) }).strict(),
    ]) as unknown as z.ZodType<ExprNode, z.ZodTypeDef, unknown>,
);

/**
 * Формы, встреченные в дереве, — мерка полноты `EXPR_FIXTURES` (§С8-28).
 *
 * Обход ИТЕРАТИВНЫЙ: вход недоверенный, а рекурсия исчерпала бы стек ровно на том дереве,
 * ради которого её и зовут. Множество — ПОСЕЩЁННЫЕ объекты, а не путь: вопрос «какие формы
 * встретились», и второй проход по тому же подобъекту ответа не меняет; заодно фикстура
 * «самоссылка невыразима» (циклический объект корпуса) не подвешивает обход.
 */
export function exprFormsOf(expr: ExprNode): Set<ExprForm> {
  const found = new Set<ExprForm>();
  const seen = new Set<object>();
  const stack: unknown[] = [expr];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const form of EXPR_FORMS) if (form in node) found.add(form);
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push(child);
  }
  return found;
}
