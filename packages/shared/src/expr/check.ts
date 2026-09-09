/**
 * ТАЙП-ЧЕКЕР ЯЗЫКА E (§Б3-4) — единственное место, где выражение получает СМЫСЛ.
 *
 * Он работает НА СОХРАНЕНИИ декларации, а не на её исполнении, и в этом весь его смысл:
 * формула, сложившая деньги с текстом, обязана быть отвергнута тогда, когда её пишут, а не
 * тогда, когда владелец открыл Budget и увидел пустую полосу. Отсюда два требования, которых
 * у компилятора Q нет вовсе:
 *
 *  — ТИПЫ ОПЕРАНДОВ. Q проверяет форму узла и адрес поля; E обязан знать, что `amount` —
 *    decimal, а `$today` — date, иначе `amount + "text"` доезжает до Postgres.
 *  — ТОТАЛЬНОСТЬ. Сравнение с отсутствующим значением даёт `false` (это решение §Б3-4, и на
 *    нём стоит `not(planned = true)` набора `facts`), а вот АРИФМЕТИКА над отсутствующим —
 *    отказ ПРИ СОХРАНЕНИИ: `limit + carryover` на конверте без переноса иначе давал бы null
 *    в рантайме, то есть тихо пустую величину. Обходится ровно одним `if(has(x), …, …)`.
 *
 * Отказ несёт КОД и ПУТЬ (`ExprCheckError`, задача 1): без пути «тип не сошёлся» не адресует
 * ничего, а декларация подписки — дерево в сотню узлов. Класс отказа живёт в `codes.ts`,
 * потому что чекер стоит в shared и про сервер не знает; перевод в `ExecError` делает
 * `apps/server/src/expr/check.ts`.
 */
import { isListPropertyType } from '../query/parse-ast';
import type { ContractDefinition } from '../registry/contract-type';
import type { PropertyDefinition } from '../registry/property-type';
import type { PropertyKind } from '../registry/types';
import {
  EXPR_TREE_DEPTH_CAP,
  type ExprNode,
  type ExprOp,
  type ExprScalar,
  exprNodeSchema,
  exprTreeExceedsDepth,
} from './ast';
import {
  EXPR_NOT_TOTAL,
  EXPR_RECURSION,
  EXPR_TYPE,
  type ExprCheckCode,
  ExprCheckError,
  SECOND_LANGUAGE,
} from './codes';

/**
 * Тип значения выражения. `class` несёт имя контракта: `in` над ним проверяет, что справа
 * стоит набор ИМЕННО ЭТОГО контракта. `sensitivity` — не скаляр, а закрытый словарь фактов
 * (Е-4): единственное, что с ним законно, — `in`.
 */
export type ExprType =
  | { kind: 'boolean' | 'text' | 'number' | 'decimal' | 'date' | 'timestamp' | 'duration' | 'null' }
  | { kind: 'class'; contract: string }
  | { kind: 'list'; of: ExprType }
  | { kind: 'sensitivity' };

/**
 * Область, в которой выражение осмысленно. Всё, чего в области нет, — отказ, а не пустота
 * (§С8-3): `{agg:'spent'}` без `aggs` называет «нет такой величины», а не считает ноль.
 */
export interface ExprScope {
  reg: {
    properties: ReadonlyMap<string, PropertyDefinition>;
    contracts: ReadonlyMap<string, ContractDefinition>;
  };
  /** Область слотов: `{slot}`, `{has: slot}`, `{deref:{slot}}` законны только при нём. */
  contract?: string;
  params?: Readonly<Record<string, ExprType>>;
  /** Величины той же ведомости, уже вычисленные к этому месту (§Б3-2). */
  aggs?: Readonly<Record<string, ExprType>>;
  phases?: readonly string[];
  /** Только правило `assign_level` (Б-2); иначе `{ctx:'$sensitivity'}` → EXPR_TYPE. */
  allowSensitivity?: boolean;
  /** D/V — да; C-правила записи — нет (§Б3-3; свой код приезжает с ними в Б-2). */
  allowDeref?: boolean;
}

/** Тип + необязательность + сам литерал: строка-литерал доводится до decimal/date по соседу. */
interface Typed {
  type: ExprType;
  optional: boolean;
  literal?: ExprScalar;
}

const DEC_RE = /^-?\d+(\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOOL: Typed = { type: { kind: 'boolean' }, optional: false };
/** Типы с линейным порядком: только у них осмысленны `>`, `<`, `>=`, `<=`. */
const ORDERED: ReadonlySet<ExprType['kind']> = new Set(['number', 'decimal', 'date', 'timestamp']);
/**
 * Типы, у которых равенство ЕСТЬ. Список закрытый и короче, чем «всё, что сошлось по типу»:
 * у класса контракта равенство подменяло бы членство (`in`), у списка и у `null` его нет вовсе,
 * а у длительности нет представления в операнде ни одного бэкенда. Без этой строки
 * `class(a) = class(b)` типизировался бы `boolean` и доезжал до SQL-бэкенда, где отказ приходит
 * уже НА ЧТЕНИИ подписки — то есть ровно тогда, когда §Б3-4 обещал отказ при СОХРАНЕНИИ.
 */
const EQUATABLE: ReadonlySet<ExprType['kind']> = new Set([
  'boolean',
  'text',
  'number',
  'decimal',
  'date',
  'timestamp',
]);
const COMPARISONS: ReadonlySet<ExprOp> = new Set(['=', '!=', '>', '<', '>=', '<=']);
const ARITHMETIC: ReadonlySet<ExprOp> = new Set(['+', '-', '*', '/']);
/**
 * Контракт фактов чувствительности (§Б1-2). Имя названо ЗДЕСЬ, а не выведено из области:
 * `{ctx:'$sensitivity'}` по определению §Б3-2а читает именно его словарь, и словарь этот
 * закрытый — второго контракта фактов у величины быть не может.
 */
const SENSITIVITY_CONTRACT = 'orbis/sensitivity';

/** Печать типа для текста отказа: читателем будет человек в карточке. */
function label(type: ExprType): string {
  if (type.kind === 'list') return `list<${label(type.of)}>`;
  if (type.kind === 'class') return `class<${type.contract}>`;
  return type.kind;
}

/**
 * Отказ чекера. Конструктор задачи 1 — закон: `(code, message, { path, expected, actual })`;
 * текст собирается здесь из ожидания и факта, чтобы каждый вызов не сочинял его заново.
 */
const bad = (
  code: ExprCheckCode,
  path: readonly string[],
  expected?: string,
  actual?: string,
): never => {
  const at = path.length === 0 ? 'в корне' : `в ${path.join('.')}`;
  const detail =
    expected === undefined
      ? ''
      : `: ожидалось ${expected}${actual === undefined ? '' : `, получено ${actual}`}`;
  throw new ExprCheckError(code, `${code} ${at}${detail}`, { path, expected, actual });
};

export function exprTypeOfKind(kind: PropertyKind): ExprType {
  switch (kind) {
    case 'number':
      return { kind: 'number' };
    case 'decimal':
      return { kind: 'decimal' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'date':
      return { kind: 'date' };
    case 'timestamp':
      return { kind: 'timestamp' };
    // `time` — 'ЧЧ:ММ': у текста лексикографический порядок И ЕСТЬ хронологический — то же
    // допущение, что у `castedExpr` компилятора Q, второго не заводим.
    case 'text':
    case 'time':
    case 'select':
    case 'ref':
    case 'grant':
    case 'registry_ref':
      return { kind: 'text' };
    // У вложенного объекта нет скалярного значения — ни сравнить, ни сложить (§6.4); только has().
    case 'json':
      return bad(EXPR_TYPE, ['json'], 'скалярный тип', 'json');
  }
}

/**
 * {prop} НЕОБЯЗАТЕЛЕН ВСЕГДА, и это не осторожность, а §Б2-3: аспект прикреплён, а
 * обязательный слот у конкретной сущности пуст — законное состояние. Обязательность живёт у
 * СЛОТА КОНТРАКТА (`required`), и в области она видна: `{slot:'limit'}` обязателен,
 * `{slot:'carryover'}` — нет, и ровно на этом стоит `limit + if(has(carryover), carryover,
 * "0")` (§Б5-4, Р-К-13).
 */
function typedOfProp(id: string, s: ExprScope, path: readonly string[]): Typed {
  const def = s.reg.properties.get(id);
  if (!def) return bad(EXPR_TYPE, path, 'id свойства из реестра', id);
  const base = exprTypeOfKind(def.type.kind);
  return { type: isListPropertyType(def.type) ? { kind: 'list', of: base } : base, optional: true };
}

function typedOfSlot(name: string, s: ExprScope, path: readonly string[]): Typed {
  if (s.contract === undefined) {
    return bad(EXPR_TYPE, path, 'слот законен только в области с контрактом', name);
  }
  const def = s.reg.contracts.get(s.contract);
  const slot = def?.kind === 'slots' ? def.slots.find((x) => x.name === name) : undefined;
  if (!slot) return bad(EXPR_TYPE, path, `слот контракта ${s.contract}`, name);
  if (slot.type.kind === 'relation_role') {
    return bad(EXPR_TYPE, path, 'слот-значение', 'слот-роль читается узлом has_relation');
  }
  // any_of[timestamp,date]: тип по первому kind, а date и timestamp сравнимы между собой —
  // тот же принцип, что у date-токенов Q (`acceptsDateTokenKind`).
  const kind = slot.type.kind === 'any_of' ? (slot.type.kinds[0] as PropertyKind) : slot.type.kind;
  return { type: exprTypeOfKind(kind), optional: !slot.required };
}

/**
 * Литерал-строку доводим до типа соседа: "0.85" — decimal, "2026-01-31" — date. Числом
 * decimal не пишут (ревизия 3, Р-К-13), поэтому обратного приведения нет.
 */
function coerce(t: Typed, want: ExprType): Typed | undefined {
  if (t.type.kind === want.kind) return t;
  if (typeof t.literal === 'string' && want.kind === 'decimal' && DEC_RE.test(t.literal)) {
    return { ...t, type: want };
  }
  if (
    typeof t.literal === 'string' &&
    (want.kind === 'date' || want.kind === 'timestamp') &&
    DATE_RE.test(t.literal)
  ) {
    return { ...t, type: want };
  }
  // date и timestamp сравнимы: момент читается в таймзоне владельца, как date-токены Q.
  if (
    (t.type.kind === 'date' && want.kind === 'timestamp') ||
    (t.type.kind === 'timestamp' && want.kind === 'date')
  ) {
    return t;
  }
  return undefined;
}

/** Общий тип двух операндов или `undefined`, если его нет. */
function unify(l: Typed, r: Typed): ExprType | undefined {
  if (coerce(r, l.type) !== undefined) return l.type;
  if (coerce(l, r.type) !== undefined) return r.type;
  return undefined;
}

function compare(op: ExprOp, l: Typed, r: Typed, path: readonly string[]): Typed {
  const common = unify(l, r);
  if (common === undefined) {
    return bad(EXPR_TYPE, path, 'операнды одного типа', `${label(l.type)} и ${label(r.type)}`);
  }
  if (!EQUATABLE.has(common.kind)) {
    return bad(EXPR_TYPE, path, 'скалярный тип, у которого есть равенство', label(common));
  }
  if (op !== '=' && op !== '!=' && !ORDERED.has(common.kind)) {
    return bad(EXPR_TYPE, path, 'тип с линейным порядком', label(common));
  }
  // §Б3-4: сравнение ТОТАЛЬНО — отсутствие значения читается как `false`, а не как
  // «неизвестно», поэтому необязательность операндов здесь не проверяется вовсе.
  return BOOL;
}

function arith(op: ExprOp, l: Typed, r: Typed, path: readonly string[]): Typed {
  // §Б3-4: сравнение с отсутствующим — false, а АРИФМЕТИКА с отсутствующим — отказ ПРИ
  // СОХРАНЕНИИ, а не null в рантайме. Обходится одним `if(has(x), …, …)`.
  if (l.optional) return bad(EXPR_NOT_TOTAL, [...path, '0'], 'значение, которое есть всегда');
  if (r.optional) return bad(EXPR_NOT_TOTAL, [...path, '1'], 'значение, которое есть всегда');
  // Деньги на число умножать и делить законно (`remaining / days_inclusive(…)` §Б5-4),
  // складывать — почти всегда ошибка типа: у слагаемых разные единицы. УМНОЖЕНИЕ КОММУТАТИВНО,
  // поэтому обе стороны равноправны; деление — нет, и `число / деньги` остаётся отказом.
  if ((op === '*' || op === '/') && l.type.kind === 'decimal' && r.type.kind === 'number') {
    return { type: { kind: 'decimal' }, optional: false };
  }
  if (op === '*' && r.type.kind === 'decimal' && l.type.kind === 'number') {
    return { type: { kind: 'decimal' }, optional: false };
  }
  // Р-К-29: деление — ВСЕГДА decimal (масштаб 2), иначе `daily_pace` §Б5-4 теряет копейки;
  // паритет с decimal-бэкендом задачи 8, который делит строками.
  if (op === '/' && l.type.kind === 'number' && r.type.kind === 'number') {
    return { type: { kind: 'decimal' }, optional: false };
  }
  // Доводка литерала — СИММЕТРИЧНАЯ (`unify`, как у `compare`), а не только справа налево:
  // §Б3-4 обещает доводку по соседу, и `"0.85" * limit` обязано значить ровно то же, что
  // `limit * "0.85"`. Несимметричный `coerce(r, l.type)` отказывал первой форме `EXPR_TYPE`.
  const common = unify(l, r);
  if (common === undefined || (common.kind !== 'number' && common.kind !== 'decimal')) {
    return bad(
      EXPR_TYPE,
      path,
      'операнды одного числового типа',
      `${label(l.type)} и ${label(r.type)}`,
    );
  }
  return { type: common, optional: false };
}

/** Имена, про которые условие `if` уже сказало «есть»: has(x) в положительной позиции и внутри and. */
function guardsOf(node: ExprNode, into: Set<string>): void {
  if ('has' in node) into.add(node.has);
  else if ('op' in node && node.op === 'and') for (const a of node.args) guardsOf(a, into);
}

/**
 * Есть ли в структуре ссылка на саму себя.
 *
 * СТОИТ ПЕРЕД ГЕЙТОМ ГЛУБИНЫ, и порядок здесь — суть. Цикл глубины не имеет вовсе, а гейт
 * глубины назвал бы его «слишком глубоким деревом» — диагноз, по которому автор декларации
 * искал бы лишние уровни вложенности там, где их нет. §С8-3 требует, чтобы отказ называл
 * ИМЕННО ТО, что случилось.
 *
 * И стоит перед СХЕМОЙ, по той же причине, что и гейт глубины: `z.lazy` спускается по циклу
 * рекурсивно и исчерпывает стек `RangeError`'ом, которого `safeParse` не ловит. Поэтому
 * второго такого сторожа внутри типизации нет: до неё циклическое значение не доходит.
 *
 * Множество — ПОСЕЩЁННЫЕ объекты, а не путь: один подобъект, использованный в двух ветках
 * дерева, — законное переиспользование, и до строки `has` он доходит уже помеченным; цикл же
 * отличается тем, что объект встречается СРЕДИ СВОИХ ПОТОМКОВ — это и проверяет спуск с
 * явной отметкой выхода.
 */
function hasSelfReference(value: unknown): boolean {
  const onPath = new Set<object>();
  const stack: Array<{ node: unknown; enter: boolean }> = [{ node: value, enter: true }];
  while (stack.length > 0) {
    const frame = stack.pop() as { node: unknown; enter: boolean };
    const node = frame.node;
    if (typeof node !== 'object' || node === null) continue;
    if (!frame.enter) {
      onPath.delete(node);
      continue;
    }
    if (onPath.has(node)) return true;
    onPath.add(node);
    stack.push({ node, enter: false });
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      stack.push({ node: child, enter: true });
    }
  }
  return false;
}

/** Значение из словаря области по СОБСТВЕННОМУ ключу: `constructor` и `toString` — не имена. */
function own<T>(dict: Readonly<Record<string, T>> | undefined, name: string): T | undefined {
  return dict !== undefined && Object.hasOwn(dict, name) ? dict[name] : undefined;
}

function slotsContractOf(
  id: string,
  s: ExprScope,
): Extract<ContractDefinition, { kind: 'slots' }> | undefined {
  const def = s.reg.contracts.get(id);
  return def !== undefined && def.kind === 'slots' ? def : undefined;
}

/** Ветка `in`: слева класс контракта, справа имя набора либо перечисление классов (Р-И-11). */
function classMembership(
  contract: string,
  rhs: ExprNode,
  s: ExprScope,
  path: readonly string[],
): Typed {
  const def = slotsContractOf(contract, s);
  if (def === undefined) return bad(EXPR_TYPE, path, 'контракт со слотами', contract);
  if (!('const' in rhs)) {
    return bad(EXPR_TYPE, path, 'имя набора либо перечисление классов контракта', 'выражение');
  }
  const value = rhs.const;
  if (typeof value === 'string') {
    // Имя набора: у контракта он объявлен либо нет — «набора нет» не то же самое, что
    // «сущность не член», и молчать об опечатке нельзя (§С8-3).
    if (!Object.hasOwn(def.sets, value)) {
      return bad(EXPR_TYPE, path, `набор контракта ${contract}`, value);
    }
    return BOOL;
  }
  if (Array.isArray(value)) {
    const classes = new Set(def.classes.map((c) => c.key));
    for (const cls of value) {
      if (!classes.has(cls)) return bad(EXPR_TYPE, path, `класс контракта ${contract}`, cls);
    }
    return BOOL;
  }
  return bad(EXPR_TYPE, path, 'имя набора либо перечисление классов', JSON.stringify(value));
}

/** Ветка `in` по словарю фактов чувствительности (Е-4). */
function factMembership(left: Typed, s: ExprScope, path: readonly string[]): Typed {
  const def = s.reg.contracts.get(SENSITIVITY_CONTRACT);
  const facts = def?.kind === 'facts' ? def.facts.map((f) => f.key) : [];
  if (typeof left.literal !== 'string' || !facts.includes(left.literal)) {
    return bad(
      EXPR_TYPE,
      [...path, '0'],
      `факт словаря ${SENSITIVITY_CONTRACT}`,
      typeof left.literal === 'string' ? left.literal : label(left.type),
    );
  }
  return BOOL;
}

function dateNode(
  form: 'date_add' | 'date_diff' | 'days_inclusive',
  args: readonly ExprNode[],
  s: ExprScope,
  path: readonly string[],
  present: ReadonlySet<string>,
): Typed {
  const l = typeOf(args[0] as ExprNode, s, [...path, '0'], present);
  const r = typeOf(args[1] as ExprNode, s, [...path, '1'], present);
  if (l.optional) return bad(EXPR_NOT_TOTAL, [...path, '0'], 'дата, которая есть всегда');
  if (r.optional) return bad(EXPR_NOT_TOTAL, [...path, '1'], 'дата, которая есть всегда');
  const moment = (t: ExprType) => t.kind === 'date' || t.kind === 'timestamp';
  if (!moment(l.type)) return bad(EXPR_TYPE, [...path, '0'], 'date | timestamp', label(l.type));
  // Сдвиг сохраняет РОД: иначе `date_add` тихо превращал бы `deadline` в timestamp и ломал
  // сравнение с `$today`.
  if (form === 'date_add') {
    if (r.type.kind !== 'duration') {
      return bad(EXPR_TYPE, [...path, '1'], 'duration', label(r.type));
    }
    return { type: l.type, optional: false };
  }
  if (!moment(r.type)) return bad(EXPR_TYPE, [...path, '1'], 'date | timestamp', label(r.type));
  // Оба дают целые дни: знаковое у date_diff, ≥ 0 у days_inclusive. Знак — не тип, его
  // держит бэкенд.
  return { type: { kind: 'number' }, optional: false };
}

function opNodeType(
  node: Extract<ExprNode, { op: ExprOp }>,
  s: ExprScope,
  path: readonly string[],
  present: ReadonlySet<string>,
): Typed {
  const args = node.args;
  const at = (i: number): string[] => [...path, 'args', String(i)];
  if (node.op === 'and' || node.op === 'or' || node.op === 'not') {
    for (const [i, arg] of args.entries()) {
      const t = typeOf(arg, s, at(i), present);
      if (t.type.kind !== 'boolean') bad(EXPR_TYPE, at(i), 'boolean', label(t.type));
    }
    return BOOL;
  }
  if (node.op === 'if') {
    const cond = typeOf(args[0] as ExprNode, s, at(0), present);
    if (cond.type.kind !== 'boolean') bad(EXPR_TYPE, at(0), 'boolean', label(cond.type));
    // `if(has(x), …)` — единственный способ сделать тотальной арифметику над необязательным
    // значением (§Б3-4): условие сужает область ТОЛЬКО для положительного плеча.
    const guarded = new Set(present);
    guardsOf(args[0] as ExprNode, guarded);
    const a = typeOf(args[1] as ExprNode, s, at(1), guarded);
    const b = typeOf(args[2] as ExprNode, s, at(2), present);
    // Плечо `{const:null}` — не тип, а признак: величина объявлена НЕОБЯЗАТЕЛЬНОЙ
    // (`daily_pace` вне активной фазы), и второе плечо задаёт её тип целиком.
    if (a.type.kind === 'null') return { type: b.type, optional: true };
    if (b.type.kind === 'null') return { type: a.type, optional: true };
    const common = unify(a, b);
    if (common === undefined) {
      return bad(EXPR_TYPE, path, 'плечи одного типа', `${label(a.type)} и ${label(b.type)}`);
    }
    return { type: common, optional: a.optional || b.optional };
  }
  if (node.op === 'in') {
    const left = typeOf(args[0] as ExprNode, s, at(0), present);
    if (left.type.kind === 'class') {
      return classMembership(left.type.contract, args[1] as ExprNode, s, at(1));
    }
    const right = typeOf(args[1] as ExprNode, s, at(1), present);
    if (right.type.kind === 'sensitivity') return factMembership(left, s, path);
    // Е-3: `deref(...).tags in [...]` и вообще «текст в списке текстов».
    if (right.type.kind === 'list' && coerce(left, right.type.of) !== undefined) return BOOL;
    return bad(
      EXPR_TYPE,
      path,
      'класс контракта, словарь фактов либо список значений справа',
      `${label(left.type)} и ${label(right.type)}`,
    );
  }
  const l = typeOf(args[0] as ExprNode, s, at(0), present);
  const r = typeOf(args[1] as ExprNode, s, at(1), present);
  if (COMPARISONS.has(node.op)) return compare(node.op, l, r, [...path, 'args']);
  if (ARITHMETIC.has(node.op)) return arith(node.op, l, r, [...path, 'args']);
  return bad(EXPR_TYPE, path, 'оператор канона §Б3-5', node.op);
}

function derefType(
  spec: { prop?: string; slot?: string; read: string },
  s: ExprScope,
  path: readonly string[],
): Typed {
  // §Б3-3 запрещает `deref` в C-правилах записи; свой код `DEREF_IN_CONSTRAINT` приезжает
  // вместе с C-правилами в Б-2, а до тех пор «здесь разыменование не читается» — отказ по типу.
  if (s.allowDeref !== true) {
    return bad(EXPR_TYPE, path, 'область, где разыменование разрешено (D/V)', 'deref');
  }
  const base =
    spec.slot !== undefined
      ? typedOfSlot(spec.slot, s, path)
      : typedOfProp(spec.prop as string, s, path);
  const baseKind =
    spec.slot !== undefined
      ? slotsContractOf(s.contract ?? '', s)?.slots.find((x) => x.name === spec.slot)?.type
      : s.reg.properties.get(spec.prop as string)?.type;
  const isRef =
    baseKind !== undefined &&
    (baseKind.kind === 'ref' || (baseKind.kind === 'any_of' && baseKind.kinds.includes('ref')));
  if (!isRef) return bad(EXPR_TYPE, path, 'ссылочная база (kind ref)', label(base.type));
  // 'tags' — имя ЯДРА (Е-3), а не запись реестра: у сущности теги лежат колонкой.
  if (spec.read === 'tags') {
    return { type: { kind: 'list', of: { kind: 'text' } }, optional: true };
  }
  const read = typedOfProp(spec.read, s, path);
  // Цель ссылки может быть архивна или снята — прочитанное значение НЕОБЯЗАТЕЛЬНО всегда.
  return { ...read, optional: true };
}

function typeOf(
  node: ExprNode,
  s: ExprScope,
  path: readonly string[],
  present: ReadonlySet<string>,
): Typed {
  if ('const' in node) {
    const value = node.const;
    if (value === null) return { type: { kind: 'null' }, optional: true, literal: null };
    if (Array.isArray(value)) {
      return { type: { kind: 'list', of: { kind: 'text' } }, optional: false };
    }
    if (typeof value === 'boolean')
      return { type: { kind: 'boolean' }, optional: false, literal: value };
    if (typeof value === 'number') {
      // Decimal пишется СТРОКОЙ (Р-К-13): дробное JSON-число потеряло бы хвост копеек ещё
      // до чекера, и отказ здесь — единственное место, где это ещё видно автору.
      if (!Number.isInteger(value)) {
        return bad(EXPR_TYPE, path, 'целое число; decimal пишется строкой («0.85»)', String(value));
      }
      return { type: { kind: 'number' }, optional: false, literal: value };
    }
    return { type: { kind: 'text' }, optional: false, literal: value as string };
  }
  if ('duration' in node) return { type: { kind: 'duration' }, optional: false };
  if ('prop' in node) {
    const t = typedOfProp(node.prop, s, path);
    return present.has(node.prop) ? { ...t, optional: false } : t;
  }
  if ('slot' in node) {
    const t = typedOfSlot(node.slot, s, path);
    return present.has(node.slot) ? { ...t, optional: false } : t;
  }
  if ('param' in node) {
    const t = own(s.params, node.param);
    if (t === undefined) return bad(EXPR_TYPE, path, 'параметр области', node.param);
    return { type: t, optional: false };
  }
  if ('ctx' in node) {
    if (node.ctx === '$today') return { type: { kind: 'date' }, optional: false };
    if (node.ctx === '$sensitivity') {
      // §Б3-2а Е-4: словарь фактов виден ТОЛЬКО правилу `assign_level`; в предикате набора
      // или формуле его чтение — не «пусто», а невыразимость.
      if (s.allowSensitivity !== true) {
        return bad(EXPR_TYPE, path, 'область правила assign_level', '$sensitivity');
      }
      return { type: { kind: 'sensitivity' }, optional: false };
    }
    // `$owner` и `$self` — идентификаторы: сравнивать их можно только с текстом.
    return { type: { kind: 'text' }, optional: false };
  }
  if ('agg' in node) {
    // Величина, которой в области нет, — «нет такой» (EXPR_TYPE), а не рекурсия: ведомость
    // строится по порядку и кладёт в `aggs` только уже вычисленные (§Б3-2 «ациклично по
    // построению»); EXPR_RECURSION остаётся за структурной самоссылкой.
    const t = own(s.aggs, node.agg);
    if (t === undefined) return bad(EXPR_TYPE, path, 'величина ведомости', node.agg);
    return { type: t, optional: false };
  }
  if ('phase' in node) {
    if (s.phases?.includes(node.phase) !== true) {
      return bad(EXPR_TYPE, path, 'фаза ведомости', node.phase);
    }
    return BOOL;
  }
  if ('agg_via' in node) {
    // Опубликованные величины Б-1 — `spent`/`remaining` конверта, обе decimal; сверка роли и
    // имени по реестру `published` — Б-2 (§Б5-5, Р-И-30): у `ExprScope` нет ни ролей, ни
    // этого реестра. Ребра может не быть — значение НЕОБЯЗАТЕЛЬНО.
    return { type: { kind: 'decimal' }, optional: true };
  }
  if ('deref' in node) return derefType(node.deref, s, path);
  if ('op' in node) return opNodeType(node, s, path, present);
  if ('has' in node) {
    if (s.reg.properties.has(node.has)) return BOOL;
    if (slotsContractOf(s.contract ?? '', s)?.slots.some((x) => x.name === node.has) === true) {
      return BOOL;
    }
    return bad(EXPR_TYPE, path, 'id свойства реестра либо имя слота контракта области', node.has);
  }
  if ('has_relation' in node) {
    const spec = node.has_relation;
    if (spec.in_set !== undefined) {
      const def = slotsContractOf(spec.in_set.contract, s);
      if (def === undefined) {
        return bad(EXPR_TYPE, path, 'контракт со слотами', spec.in_set.contract);
      }
      if (!Object.hasOwn(def.sets, spec.in_set.set)) {
        return bad(EXPR_TYPE, path, `набор контракта ${spec.in_set.contract}`, spec.in_set.set);
      }
    }
    // Роль НЕ сверяется со словарём: у `ExprScope` его нет, а ребро с неизвестной ролью
    // просто не найдётся — это «не выполнено», а не невыразимость.
    return BOOL;
  }
  if ('class' in node) {
    const def = slotsContractOf(node.class.contract, s);
    if (def === undefined) {
      return bad(EXPR_TYPE, path, 'контракт со слотами', node.class.contract);
    }
    if (def.classes.length === 0) {
      return bad(EXPR_TYPE, path, 'контракт с классами', node.class.contract);
    }
    return { type: { kind: 'class', contract: def.id }, optional: false };
  }
  if ('date_add' in node)
    return dateNode('date_add', node.date_add, s, [...path, 'date_add'], present);
  if ('date_diff' in node) {
    return dateNode('date_diff', node.date_diff, s, [...path, 'date_diff'], present);
  }
  return dateNode('days_inclusive', node.days_inclusive, s, [...path, 'days_inclusive'], present);
}

/**
 * Тип выражения в этой области — либо отказ `ExprCheckError`.
 *
 * ПОРЯДОК ПРОВЕРОК — СУТЬ, а не оформление:
 *  1. строка в E-позиции — ВТОРОЙ ЯЗЫК (§Б3-1): текст — сахар Р18, парсера текста в Б-1 нет,
 *     и «amount > 100» обязано называться вторым языком, а не синтаксической ошибкой;
 *  2. самоссылка — раньше глубины (см. `hasSelfReference`);
 *  3. глубина — раньше схемы: `z.lazy` исчерпает стек прежде любого условия ВНУТРИ схемы,
 *     тот же порядок и та же причина, что у гейтов Q;
 *  4. форма — схемой;
 *  5. типы — обходом.
 */
export function checkExpr(expr: unknown, scope: ExprScope): ExprType {
  if (typeof expr === 'string') return bad(SECOND_LANGUAGE, [], 'JSON-AST §Б3-5', expr);
  if (hasSelfReference(expr)) return bad(EXPR_RECURSION, [], 'дерево без самоссылки');
  if (exprTreeExceedsDepth(expr, EXPR_TREE_DEPTH_CAP)) {
    return bad(EXPR_TYPE, [], `дерево не глубже ${EXPR_TREE_DEPTH_CAP} уровней`);
  }
  const parsed = exprNodeSchema.safeParse(expr);
  if (!parsed.success) {
    return bad(
      EXPR_TYPE,
      [],
      'узел канона §Б3-5',
      JSON.stringify(parsed.error.issues[0]?.path ?? []),
    );
  }
  return typeOf(parsed.data, scope, [], new Set()).type;
}
