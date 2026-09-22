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
//   считает В ОБЛАСТИ ЗАПИСИ (Б-2, Р-4) — class, has_relation, agg_via, ctx:$self/$owner/$sensitivity:
//                их читатели ПРЕДЗАГРУЖЕНЫ в поля области (`aspects`+`reg`, `relations`, `aggVia`,
//                `self`/`owner`/`sensitivity`) сборщиком `rules/scope.ts:entityEvalScope`, потому что
//                интерпретатор синхронный и в граф сам не ходит;
//   отказывает — те же формы там, где область их читателя НЕ несёт (ведомость Budget: у неё ровно
//                одна привязка своего контракта, а класс сущности резолвится по привязкам ВСЕХ её
//                аспектов — второй ответчик разошёлся бы с `compileClassMembership`; личности и
//                чувствительности у ведомости нет), `has_relation.in_set` и предикатный набор
//                справа от `in` (дальний конец и предикат — дело SQL-бэкенда, Р-К-17), date_add с
//                годами/месяцами/временем суток (кламп «31 января + 1 месяц» — правило, у которого
//                в Б-1 нет ни одного потребителя-декларации: окна Budget задаются параметрами
//                period_start/period_end/horizon_end, Р-К-4; в SQL кламп делает сам Postgres).
import {
  type AspectDefinition,
  addDays,
  type BindingIndex,
  bindingIndexOf,
  type ContractDefinition,
  daysInclusive,
  entityClassOf,
  epochDays,
  type GraphId,
  type ResolvedBinding,
  toParts,
} from '@orbis/shared';
import {
  EXPR_DURATION_RE,
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
  /**
   * Значения строки: ключ — id свойства; core-поля лежат ЗДЕСЬ ЖЕ под своими id (`orbis/title`,
   * `orbis/archived`, `orbis/created_at`, `orbis/updated_at` — `CORE_COLUMN` в `query/compile-ast.ts`),
   * их подмешивает движок ведомостей (задача 9). Тот же договор записан ниже для целей `deref`:
   * два разных правила для «своей» строки и «чужой» развели бы одно чтение реестра на два.
   */
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
  /**
   * IANA-зона владельца (Р-33): день МОМЕНТА в `calendarHead` и в сравнении день⟷момент берётся по
   * его стеночным часам у владельца — тем же приёмом, что `AT TIME ZONE` у SQL-бэкенда. Без неё —
   * прежнее поведение (день собственного смещения момента). Наполняют движок ведомостей
   * (`runLedgers` → конструкторы области `subscriptions/budget.ts`) и `rules/scope.ts:entityEvalScope`.
   */
  timeZone?: string;
  /** Область ЗАПИСИ (Р-И-4): id самой записи — `$self`. Наполняет `entityEvalScope`. */
  self?: string;
  /** Область записи: граф владельца — `$owner`. Наполняет `entityEvalScope` из `ctx.identity.graph`. */
  owner?: GraphId;
  /** Область записи: аспекты `$self` — без них (и без `reg`) класс записи неизвестен. Наполняет `entityEvalScope`. */
  aspects?: readonly string[];
  /** Область записи: аспекты и контракты снимка для `class` и имён наборов. Наполняет `entityEvalScope`. */
  reg?: {
    aspects: ReadonlyMap<string, AspectDefinition>;
    contracts: ReadonlyMap<string, ContractDefinition>;
  };
  /**
   * Область записи: ПРЕДЗАГРУЖЕННЫЕ входящие рёбра `$self` ролей, которые читают правила (Р-И-7) —
   * БД ∪ объявленные пачкой − удалённые пачкой. Наполняет `rules/scope.ts:relationFactsOf`.
   */
  relations?: readonly RelationFact[];
  /**
   * Опубликованные величины соседей: роль → имя → значение (Е-2, Р-И-4). Живого читателя в Б-2 нет
   * (V2, Р-К-17): наполняют тесты и будущий движок; без карты `agg_via` — отказ бэкенда.
   */
  aggVia?: ReadonlyMap<string, Readonly<Record<string, ExprScalar>>>;
  /** Только область классификатора `assign_level` (задача 15): факты чувствительности вызова. */
  sensitivity?: readonly string[];
  /** Только область классификатора `assign_level` (задача 15): тронутые свойства вызова. */
  touched?: readonly string[];
}

/** Входящее ребро `$self` роли `role` от `sourceId`; `alive` — источник не архивен (Р-И-7). */
export interface RelationFact {
  role: string;
  sourceId: string;
  alive: boolean;
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

/**
 * Чтение ключа plain-record — ТОЛЬКО свой ключ: у `{}` есть `toString`, и `props['toString']` вернул
 * бы функцию прототипа, то есть отказ `EXPR_VALUE` там, где значения просто нет. Чекер спрашивает
 * реестр тем же `Object.hasOwn` (`expr/check.ts`) — дисциплина у двух бэкендов одна.
 */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
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
  const raw = own(props, propertyId);
  if (raw !== undefined && raw !== null) return scalarOf(raw, what);
  const fallback = scope.defaults?.get(propertyId);
  return fallback === undefined ? null : fallback; // умолчание может быть объявлено как null
}

function slotValue(slot: string, scope: ExprEvalScope): ExprValue {
  const binding = scope.binding;
  if (binding === undefined) {
    return fail('EXPR_SCOPE', `слот '${slot}' вне области с контрактом: привязки нет`, { slot });
  }
  const propertyId = own(binding.bind, slot);
  if (propertyId !== undefined) {
    return propValue(scope.props, propertyId, scope, `слота '${slot}' (${propertyId})`);
  }
  const fixed = own(binding.fixed, slot);
  if (fixed !== undefined) return fixed;
  return null; // §Б2-3: необязательный слот можно не связывать — это отсутствие, а не отказ
}

/**
 * Индекс привязок — МЕМО по объекту реестра области: тот же приём и довод, что у `bindingsOf`
 * движка ведомостей — `bindingIndexOf` пересобирает индекс с нуля, а `class` спрашивают на каждой
 * записи каждой операции.
 */
const INDEX_BY_REG = new WeakMap<object, BindingIndex>();
function indexOf(reg: NonNullable<ExprEvalScope['reg']>): BindingIndex {
  const cached = INDEX_BY_REG.get(reg);
  if (cached !== undefined) return cached;
  const built = bindingIndexOf(reg);
  INDEX_BY_REG.set(reg, built);
  return built;
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
    if (!Object.hasOwn(scope.params, node.param)) {
      return fail('EXPR_SCOPE', `параметра '${node.param}' нет в области ведомости`, {
        param: node.param,
      });
    }
    return own(scope.params, node.param) ?? null;
  }
  if ('agg' in node) {
    if (!Object.hasOwn(scope.aggs, node.agg)) {
      return fail('EXPR_SCOPE', `величины '${node.agg}' нет в области ведомости`, {
        agg: node.agg,
      });
    }
    return own(scope.aggs, node.agg) ?? null;
  }
  if ('phase' in node) return scope.phase === node.phase;
  if ('ctx' in node) {
    if (node.ctx === '$today') return scope.today;
    if (node.ctx === '$self' && scope.self !== undefined) return scope.self;
    if (node.ctx === '$owner' && scope.owner !== undefined) return scope.owner;
    if (node.ctx === '$sensitivity' && scope.sensitivity !== undefined) return scope.sensitivity;
    // `$touched` — задача 15 вместе с `assign_level`: контекста в EXPR_CTX ещё нет.
    return fail('EXPR_BACKEND_UNSUPPORTED', `контекст '${node.ctx}' в этой области недоступен`, {
      ctx: node.ctx,
    });
  }
  if ('class' in node) {
    const reg = scope.reg;
    if (reg === undefined || scope.aspects === undefined) {
      return fail(
        'EXPR_BACKEND_UNSUPPORTED',
        'класс записи: области без реестра и аспектов он неизвестен',
        { contract: node.class.contract },
      );
    }
    return entityClassOf(
      indexOf(reg),
      { aspects: scope.aspects, props: scope.props },
      node.class.contract,
      (id) => reg.aspects.get(id)?.rank ?? Number.MAX_SAFE_INTEGER,
    );
  }
  if ('has_relation' in node) {
    const rel = node.has_relation;
    // Дальний конец с предикатом потребовал бы второго чтения сущности — правилам Б-2 он не нужен,
    // и это ИМЕНОВАННЫЙ остаток (Р-К-17), а не забытая ветка.
    if (rel.in_set !== undefined) {
      return fail('EXPR_BACKEND_UNSUPPORTED', 'has_relation.in_set считает предикатный бэкенд', {
        role: rel.role,
      });
    }
    if (scope.relations === undefined) {
      return fail(
        'EXPR_BACKEND_UNSUPPORTED',
        'наличие ребра: предзагруженных рёбер в области нет',
        { role: rel.role },
      );
    }
    return scope.relations.some(
      (r) => r.role === rel.role && (rel.alive === undefined || r.alive === rel.alive),
    );
  }
  if ('agg_via' in node) {
    const byRole = scope.aggVia?.get(node.agg_via.role);
    if (byRole === undefined) {
      return fail('EXPR_BACKEND_UNSUPPORTED', 'Е-2 (agg_via): карты величин соседа в области нет', {
        ...node.agg_via,
      });
    }
    return own(byRole, node.agg_via.name) ?? null;
  }
  if ('date_add' in node) {
    const [value, duration] = pair(node.date_add, scope, depth, 'date_add');
    return addDuration(dateTextOf(value, 'date_add'), textOf(duration, 'date_add'));
  }
  if ('date_diff' in node) {
    const [from, to] = pair(node.date_diff, scope, depth, 'date_diff');
    return guarded(
      'date_diff',
      () =>
        epochDays(toParts(calendarHead(dateTextOf(to, 'date_diff'), scope.timeZone))) -
        epochDays(toParts(calendarHead(dateTextOf(from, 'date_diff'), scope.timeZone))),
    );
  }
  if ('days_inclusive' in node) {
    const [from, to] = pair(node.days_inclusive, scope, depth, 'days_inclusive');
    return guarded('days_inclusive', () =>
      daysInclusive(
        calendarHead(dateTextOf(from, 'days_inclusive'), scope.timeZone),
        calendarHead(dateTextOf(to, 'days_inclusive'), scope.timeZone),
      ),
    );
  }
  if ('has' in node) return hasValue(node.has, scope);
  if ('deref' in node) return derefValue(node.deref, scope);
  if ('op' in node) return applyOp(node.op, node.args, scope, depth);
  return fail('EXPR_VALUE', `неизвестная форма узла E: ${JSON.stringify(node)}`);
}

/** Текст, который выглядит как число: только по НЕМУ включается численное сравнение. */
const NUMERIC_TEXT_RE = /^-?\d+(?:\.\d+)?$/;
/** Форма ISO-значения: ДЕНЬ (`YYYY-MM-DD`) и МОМЕНТ (`YYYY-MM-DDT…`) — по ним `compare` и `calendarHead` различают род (Р-33). */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MOMENT_RE = /^\d{4}-\d{2}-\d{2}T/;
/**
 * Момент С ЯВНЫМ смещением (`Z` или `±hh:mm`) — только такой однозначно переводится в инстант:
 * `new Date('…T10:00:00')` без смещения читается в зоне ПРОЦЕССА, и ответ зависел бы от машины.
 * Схема значения `timestamp` смещение требует (`value-schema.ts`), `orbis/updated_at` области —
 * всегда `…Z`; момент без смещения (литерал формулы) остаётся при прежнем текстовом правиле.
 */
const MOMENT_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Знак сравнения двух МОМЕНТОВ по инстанту; `undefined` — пара не из двух моментов со смещением.
 *
 * ИМЕНОВАННЫЙ ОСТАТОК — точность. `Date.parse` усекает дробь секунды до миллисекунд: `…00.1234Z` и
 * `…00.1235Z` здесь равны, а `timestamptz` SQL-бэкенда их различает (микросекунды). Схема значения
 * (`\.\d+`) такую дробь допускает, но пишут её только внешние входы: штампы сервера — ISO с мс, и
 * живого правила, различающего моменты внутри одной миллисекунды, нет. Точное сравнение потребовало
 * бы своего разбора дроби — второй парсер ISO ради случая без потребителя.
 */
function instantSign(a: string, b: string): -1 | 0 | 1 | undefined {
  if (!MOMENT_WITH_OFFSET_RE.test(a) || !MOMENT_WITH_OFFSET_RE.test(b)) return undefined;
  const ia = Date.parse(a);
  const ib = Date.parse(b);
  if (Number.isNaN(ia) || Number.isNaN(ib)) return undefined;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

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
 *
 * ТАЙМЗОНА (Р-33, закрывает остаток Ф-Б1-19 / Б-1 36 и 82). ДЕНЬ ПРОТИВ МОМЕНТА сравнивается по дню
 * момента у ВЛАДЕЛЬЦА, когда область несёт его зону (`scope.timeZone`): чекер обещает «момент
 * читается в таймзоне владельца», SQL-бэкенд приводит `AT TIME ZONE`, и правило записи «событие
 * сегодня» (Б-2) обязано ответить так же, как список. Без зоны — прежнее сравнение сырого текста
 * (чистые тесты и области, которым зона не нужна).
 */
function compare(
  op: '=' | '!=' | '>' | '<' | '>=' | '<=',
  a: ExprValue,
  b: ExprValue,
  timeZone?: string,
): boolean {
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b))
    fail('EXPR_VALUE', `список в позиции сравнения '${op}'`);
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    if (op === '=') return a === b;
    if (op === '!=') return a !== b;
    return fail('EXPR_VALUE', `порядковое сравнение '${op}' над булевым значением`);
  }
  // ДЕНЬ ПРОТИВ МОМЕНТА (Р-33): к дню приводится МОМЕНТ, а не наоборот — ровно как в SQL
  // (`kindL === 'date' && kindR === 'timestamp'` → `localDateSql(r)`). Род берётся из ФОРМЫ значения,
  // а не из реестра: доступа к видам свойств у области нет по построению (тот же довод, что у
  // численного сравнения выше), а форма ISO различает день и момент однозначно.
  if (timeZone !== undefined && typeof a === 'string' && typeof b === 'string') {
    if (DATE_ONLY_RE.test(a) && MOMENT_RE.test(b)) b = calendarHead(b, timeZone);
    else if (MOMENT_RE.test(a) && DATE_ONLY_RE.test(b)) a = calendarHead(a, timeZone);
  }
  // МОМЕНТ ПРОТИВ МОМЕНТА — по инстанту, а не текстом: `…T10:00:00.001Z` позже, чем
  // `…T12:00:00+03:00` (09:00Z), хотя текстом «меньше». SQL сравнивает `timestamptz` так же, а T/C-правила
  // сравнивают `{prop:'orbis/updated_at'}` (всегда `Z`) с моментами, которые хранятся как пришли.
  const instant = typeof a === 'string' && typeof b === 'string' ? instantSign(a, b) : undefined;
  const sign =
    instant ??
    (numericLike(a) && numericLike(b)
      ? guarded(`сравнение '${op}'`, () => decCmp(String(a), String(b)))
      : cmpText(String(a), String(b)));
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
      return compare(op, ev(left, scope, d), ev(right, scope, d), scope.timeZone);
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
    case 'if': {
      // §Б3-1: `if` — ВЫРАЖЕНИЕ, а не ветвление T. Плечи вычисляются ЛЕНИВО: `daily_pace` §Б5-4
      // закрывает невзятым плечом деление на ноль (в закрытой фазе дней не осталось), и жадное
      // вычисление обменяло бы null на отказ.
      if (args.length !== 3) {
        fail('EXPR_VALUE', `оператор 'if' ожидает ровно три аргумента`, { got: args.length });
      }
      return truthy(ev(args[0] as ExprNode, scope, d))
        ? ev(args[1] as ExprNode, scope, d)
        : ev(args[2] as ExprNode, scope, d);
    }
    case 'not': {
      if (args.length !== 1) fail('EXPR_VALUE', `оператор 'not' ожидает ровно один аргумент`);
      return !truthy(ev(args[0] as ExprNode, scope, d));
    }
    case 'in': {
      const [left, right] = binary(op, args);
      // Класс слева и ИМЯ НАБОРА справа (§Б1-1): набор живёт в контракте, а не в выражении.
      // Предикатный набор чистой функцией не вычисляется — честный отказ бэкенда (Р-К-17).
      // `Object.hasOwn` — имя набора приходит из декларации, и цепочка прототипа не должна
      // отвечать за `constructor` (тот же довод, что у `contractSetKind`).
      if ('class' in left && 'const' in right && typeof right.const === 'string') {
        const where = { contract: left.class.contract, set: right.const };
        if (scope.reg === undefined) {
          return fail(
            'EXPR_BACKEND_UNSUPPORTED',
            `имя набора '${right.const}': в этой области нет реестра контрактов, набор не разрешить`,
            where,
          );
        }
        const sets = scope.reg.contracts.get(left.class.contract)?.sets;
        const set =
          sets != null && Object.hasOwn(sets, right.const) ? sets[right.const] : undefined;
        if (!Array.isArray(set)) {
          return fail(
            'EXPR_BACKEND_UNSUPPORTED',
            set === undefined
              ? `набора '${right.const}' у контракта ${left.class.contract} нет`
              : `набор '${right.const}' задан предикатом — его считает SQL-бэкенд`,
            where,
          );
        }
        const cls = ev(left, scope, d);
        return cls !== null && set.includes(String(cls));
      }
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
    default: {
      // Все пятнадцать операторов `EXPR_OPS` разобраны выше, и это утверждение держит `never`:
      // появится шестнадцатый — красным станет typecheck, а не рантайм у владельца. Ветка не
      // «каркас, который допишут»: недостижимая форма узла — дефект вызывающего, EXPR_VALUE.
      const unreachable: never = op;
      return fail('EXPR_VALUE', `оператора нет в языке E: ${String(unreachable)}`, { op });
    }
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
 * Присутствие по Р-К-12: `undefined`/`null` — нет, всё остальное (в том числе json-объект, пустая
 * строка, `false`) — есть. ОДНО правило на движок правил и интерпретатор (§Б3-4): им живут `has(p)`
 * здесь, `requires_when`/`forbidden_when`, «свойство ещё не задано» у `on_enter_class.set` и
 * `default` в `rules/engine.ts`. ЭКСПОРТИРУЕТСЯ ровно поэтому: вторая копия трёх строк развела бы
 * ответ `has(p)` в `when` правила и проверку самого правила над тем же свойством — то есть ровно тот
 * класс расхождения, ради которого правило присутствия делают одним.
 */
export function present(raw: unknown): boolean {
  return raw !== undefined && raw !== null;
}

/**
 * `has` берёт имя И как слот (когда область с контрактом его реализует), И как id свойства: §Б3-5
 * пишет `{has: <prop-id>}`, а декларация подписки §Б5-4 живёт в слотах (`if(has(carryover), …)`).
 * Разные имена для одного вопроса развели бы декларацию и правило.
 *
 * Умолчание реестра здесь НЕ применяется — спрашивают про записанное значение: `orbis/planned`
 * объявлен `default: false`, на записи не материализуется, и комментарий реестра
 * (`registry/types.ts`) требует ровно этого — «иначе `has(orbis/planned)` стал бы истинным у
 * каждой транзакции».
 *
 * Почему без `scalarOf` (Р-К-12, Р-И-5): `has` спрашивает о ПРИСУТСТВИИ, а не о значении. До Б-2
 * значение гналось через `scalarOf`, и `has(orbis/recurrence)` над json-объектом падал `EXPR_VALUE` —
 * то есть правило «шаблон повторения требует маркера» было невыразимо, хотя наличие json-значения
 * однозначно. Разбор значения остаётся там, где значение ЧИТАЮТ (`prop`, `slot`, `deref`): json в
 * позиции значения по-прежнему отказ.
 */
function hasValue(name: string, scope: ExprEvalScope): boolean {
  const binding = scope.binding;
  if (binding !== undefined) {
    const propertyId = own(binding.bind, name);
    if (propertyId !== undefined) return present(own(scope.props, propertyId));
    // fixed — значение самой декларации, оно есть всегда
    if (Object.hasOwn(binding.fixed, name)) return true;
  }
  return present(own(scope.props, name));
}

/**
 * Разбор длительности НА КОМПОНЕНТЫ. ФОРМУ держит схема узла `{duration}` — `EXPR_DURATION_RE`
 * (`expr/ast.ts`, задача 3), и проверяется она ею же, а не второй копией: та регулярка RE2-безопасна
 * (перечисление вместо lookahead, Р-К-33), потому что уезжает в `exprJsonSchema` и дальше в схему тула,
 * а здесь нужен только разбор на части. Эта регулярка — надмножество схемной: всё, что схема приняла,
 * она разложит; мост «схема принимает — бэкенд считает или отказывает названной причиной» запинен тестом.
 */
const DURATION_PARTS_RE = /^P(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(\d+H)?(\d+M)?(\d+S)?)?$/;

function pair(
  args: readonly [ExprNode, ExprNode],
  scope: ExprEvalScope,
  depth: number,
  what: string,
): [ExprValue, ExprValue] {
  if (args.length !== 2) fail('EXPR_VALUE', `'${what}' ожидает ровно два аргумента`);
  return [ev(args[0], scope, depth + 1), ev(args[1], scope, depth + 1)];
}

function textOf(value: ExprValue, what: string): string {
  if (typeof value !== 'string') fail('EXPR_ARITH', `'${what}': операнд не текст`, { value });
  return value;
}

function dateTextOf(value: ExprValue, what: string): string {
  // §Б3-4: календарь над ОТСУТСТВУЮЩЕЙ датой — не «сегодня» и не null, а отказ: тотальность такой
  // формулы обязан был проверить чекер при сохранении (`EXPR_NOT_TOTAL`).
  if (value === null) fail('EXPR_ARITH', `'${what}': дата отсутствует`);
  return textOf(value, what);
}

/**
 * Календарный день значения. У ДАТЫ это она сама; у МОМЕНТА — день его собственного смещения, а при
 * известной зоне владельца (Р-33) — день его стеночных часов, тем же приёмом, что `AT TIME ZONE` у
 * SQL-бэкенда (`expr/compile.ts`, `localDateSql`).
 *
 * ЧЕТВЁРТАЯ копия приёма «момент → день владельца» в дереве (`localDay` Agenda, `wallClockIn`
 * материализации, `localDateSql` компилятора) — названный остаток, а не недосмотр: импорт
 * `recurring/materialize` в горячий интерпретатор притащил бы модуль материализации ради строки Intl.
 */
function calendarHead(value: string, timeZone?: string): string {
  // Без смещения момент не переводится однозначно (`MOMENT_WITH_OFFSET_RE`) — день его головы.
  if (timeZone === undefined || !MOMENT_WITH_OFFSET_RE.test(value)) return value.slice(0, 10);
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? value.slice(0, 10)
    : new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
}

/**
 * `date_add` этого бэкенда — ДНЕВНОЙ гранулярности: недели и дни считает `addDays` (civil-алгоритм
 * `date.ts`), у момента сдвигается календарная голова, хвост (время и смещение зоны) остаётся как
 * был. Годы, месяцы и время суток — отказ, и это названный остаток с причиной: «31 января + 1 месяц»
 * требует ПРАВИЛА клампа, у которого в Б-1 нет ни одного потребителя-декларации (окна Budget задаются
 * параметрами `period_start`/`period_end`/`horizon_end` — Р-К-4, §Б5-4), а выбирать правило без
 * случая, который его проверяет, — это молча решить за владельца. В SQL-бэкенде кламп делает Postgres
 * (`+ interval`), и второе, отличающееся правило здесь было бы хуже отказа.
 */
function addDuration(value: string, duration: string): string {
  if (!EXPR_DURATION_RE.test(duration)) {
    fail('EXPR_ARITH', `не ISO 8601 длительность: "${duration}"`);
  }
  const match = DURATION_PARTS_RE.exec(duration);
  if (match === null) fail('EXPR_ARITH', `не ISO 8601 длительность: "${duration}"`);
  const [, years, months, weeks, days, time] = match;
  if (years !== undefined || months !== undefined || time !== undefined) {
    fail('EXPR_BACKEND_UNSUPPORTED', `date_add с годами/месяцами/временем суток: "${duration}"`, {
      duration,
    });
  }
  const shift = 7 * Number(weeks?.slice(0, -1) ?? 0) + Number(days?.slice(0, -1) ?? 0);
  // Зона владельца сюда НЕ передаётся (Р-33): сдвигается голова, а хвост смещения остаётся как был —
  // приведи голову к дню владельца, момент разъехался бы со своим же хвостом.
  const head = calendarHead(value);
  return guarded('date_add', () => `${addDays(head, shift)}${value.slice(10)}`);
}

/**
 * Одношаговое разыменование `ref` (§Б3-3): читает свойства ЦЕЛИ, глубина ровно 1, цепочек нет.
 * Тотальность: цель не найдена или архивна — ОТСУТСТВИЕ значения (спека дословно), поэтому `null`
 * читателя не отказ. Чем адресоваться (`prop` или `slot`) — ровно одно из двух, это держит схема
 * узла (`expr/ast.ts`, задача 3).
 *
 * Что обязан вернуть читатель `scope.deref` — договор с движком ведомостей (задача 9): запись,
 * адресуемая ТЕМИ ЖЕ ключами, что стоят в `read`, то есть id свойств для `props`, core-id для колонок
 * ядра (`orbis/title` — колонка `title`, `CORE_COLUMN` в `query/compile-ast.ts`) и `'tags'` для
 * массива тегов (Е-3: теги — core-слой, не свойство).
 *
 * Чтение цели идёт через тот же `propValue`, что и чтение своей строки: умолчание реестра — свойство
 * СВОЙСТВА, а не строки (РП-9). У core-ключей (`orbis/title`, `'tags'`) умолчаний в реестре нет, так
 * что для них `propValue` — это тот же `scalarOf`.
 */
function derefValue(
  ref: { prop?: string; slot?: string; read: string },
  scope: ExprEvalScope,
): ExprValue {
  const address =
    ref.prop !== undefined
      ? propValue(scope.props, ref.prop, scope, `свойства '${ref.prop}'`)
      : slotValue(ref.slot as string, scope);
  if (address === null) return null;
  if (typeof address !== 'string') {
    fail('EXPR_VALUE', 'deref: значение-адрес не ref-строка', { read: ref.read });
  }
  if (scope.deref === undefined) {
    return fail('EXPR_SCOPE', 'deref: читателя целей в области нет', { read: ref.read });
  }
  const target = scope.deref(address);
  if (target === null) return null;
  return propValue(target, ref.read, scope, `цели deref по '${ref.read}'`);
}
