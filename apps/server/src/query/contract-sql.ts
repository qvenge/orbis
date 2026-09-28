// apps/server/src/query/contract-sql.ts
// ЯЗЫК КОНТРАКТОВ В SQL (спека 1в §3.1–§3.3, §4.2): адрес слота и значение контракта в поле
// запроса. Разбор кладёт адрес в то же поле `prop`/`field`, что и id свойства (`query/ast.ts`,
// `QueryContractAddress`); компилятор (`compile-ast.ts`) отдаёт такой узел сюда целиком.
//
// ЧТО ТАКОЕ АДРЕС НА ЗАПИСИ. `<контракт>.<слот>` — значения свойств, которые привязали к слоту
// аспекты, СТОЯЩИЕ НА ЗАПИСИ (`implements` поставки, расширений и своих аспектов владельца). У
// записи их бывает несколько (расписание и аспект владельца оба дают `moment`), поэтому значение
// адреса — НАБОР: строка на привязку, `CASE WHEN aspects @> ARRAY[<аспект>] THEN <значение> END`.
// Привязки берутся из индекса снимка (`bindingIndexOf`) в порядке ранга аспекта — на этом порядке
// стоит «значение аспекта с меньшим рангом» у слотов не-дат (РП-21).
//
// ЗНАЧЕНИЕ «ДАТЫ» (§3.2, §4.2, К-1) — тот же набор по слотам с ролью, отфильтрованный правилом:
// есть факт — только факты; иначе закрытая запись (набор `closed` завершаемости) — дат нет;
// иначе — планы. Правило названо в коде (`@orbis/shared`, `registry/contract-value.ts`), здесь
// исполняется.
//
// КВАНТОРЫ (§3.3). Условие на адресе истинно, если истинно ХОТЯ БЫ ДЛЯ ОДНОГО значения
// (`EXISTS`); отрицание — полное отрицание положительной формы (`negated`), и запись без значений
// его проходит. Единственное исключение — `overdue` у значения контракта (К-2): «все даты позади,
// и хотя бы одна есть». У адреса слота `overdue` — обычное «значение раньше сегодня».
//
// Инварианты компилятора те же (шапка `compile-ast.ts`): значения — параметрами, `lit`/`sql.raw` —
// только для того, что пришло из реестра (id аспекта, id свойства, имя слота), изоляция — RLS.
// Условие над значением строится ОБЩИМ шагом `exprCond` — тем же, что у свойства.
import {
  type AddressKind,
  addressKindOf,
  bindingIndexOf,
  COMPLETABLE_CLOSED,
  type ContractDefinition,
  hasValidCalendar,
  type ResolvedBinding,
} from '@orbis/shared';
import {
  fieldRefKey,
  isContractAddress,
  type QueryContractAddress,
  type QueryFilterNode,
  type QueryPropOp,
  type QueryScalar,
} from '@orbis/shared/query';
import { type SQL, sql } from 'drizzle-orm';
import { ExecError } from '../errors';
import { compileClassMembership } from '../expr/compile';
import {
  type CompileCtx,
  type CondExpr,
  exprCond,
  lit,
  negated,
  propertyValueExprs,
} from './compile-ast';

/** Узел предиката с адресом в `prop` — вход `addressCond`. */
export interface QueryPropNodeWithAddress {
  prop: QueryContractAddress;
  op: QueryPropOp;
  value: unknown;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function fail(reason: string, message: string, extra?: Record<string, unknown>): never {
  throw new ExecError('VALIDATION', message, { reason, ...extra });
}

/** Ключ адреса для отказов — ключом контракта, как его пишет текст (`orbis/when.deadline`). */
function addressName(addr: QueryContractAddress, cctx: CompileCtx): string {
  const key = cctx.reg.contracts.get(addr.contract)?.key ?? addr.contract;
  return fieldRefKey({ ...addr, contract: key });
}

/**
 * Вид адреса или структурный отказ. Вход `ast:` тула идёт мимо разбора (§А5-4), поэтому здесь
 * повторены отказы разбора — с теми же кодами (`UNKNOWN_CONTRACT`, `UNKNOWN_SLOT`,
 * `NO_CONTRACT_VALUE`), чтобы дерево с опечаткой не превращалось в пустой ответ.
 */
function kindOrFail(addr: QueryContractAddress, cctx: CompileCtx): AddressKind {
  const c: ContractDefinition | undefined = cctx.reg.contracts.get(addr.contract);
  const name = addressName(addr, cctx);
  if (c === undefined) {
    return fail('UNKNOWN_CONTRACT', `неизвестный контракт '${addr.contract}'`, {
      contract: addr.contract,
    });
  }
  const kind = addressKindOf(addr, cctx.reg);
  if (kind !== null) return kind;
  if (addr.slot === undefined) {
    return fail('NO_CONTRACT_VALUE', `у контракта нет значения — адресуйте слот: '${name}'`, {
      contract: addr.contract,
    });
  }
  const slot = c.kind === 'slots' ? c.slots.find((s) => s.name === addr.slot) : undefined;
  if (slot === undefined) {
    return fail('UNKNOWN_SLOT', `у контракта '${c.key}' нет слота '${addr.slot}'`, {
      contract: addr.contract,
      slot: addr.slot,
    });
  }
  return fail('TYPE', `слот '${name}' — роль ребра: значения свойства у него нет`, {
    contract: addr.contract,
    slot: addr.slot,
  });
}

/** Значение слота под аспектом привязки: NULL, если аспекта на записи нет. */
function guarded(aspectId: string, expr: SQL): SQL {
  return sql`CASE WHEN aspects @> ARRAY[${lit(aspectId)}] THEN ${expr} END`;
}

/** Аспекты привязок — префильтр по GIN-индексу `aspects` у положительных форм. */
function aspectsAny(bindings: readonly ResolvedBinding[]): SQL {
  const ids = [...new Set(bindings.map((b) => b.aspectId))];
  return sql`aspects && ARRAY[${sql.join(
    ids.map((id) => lit(id)),
    sql`, `,
  )}]::text[]`;
}

/** Слот с датой: хотя бы один вид — `date` или `timestamp` (у значения «даты» — всегда). */
function isDated(kind: AddressKind): boolean {
  return kind.kind === 'dates' || kind.kinds.some((k) => k === 'date' || k === 'timestamp');
}

/** Привязки слота в порядке ранга аспекта (`bindingIndexOf`) — только те, что слот связали свойством. */
function slotBindings(
  addr: Required<QueryContractAddress>,
  cctx: CompileCtx,
): Array<{ binding: ResolvedBinding; propertyId: string }> {
  return bindingIndexOf(cctx.reg)
    .byContract(addr.contract)
    .flatMap((binding) => {
      const propertyId = binding.bind[addr.slot];
      return propertyId === undefined ? [] : [{ binding, propertyId }];
    });
}

/**
 * ЗНАЧЕНИЯ СЛОТА (§3.1): отношение со строкой на привязку. У слота с датой — `sv(at, day)`
 * (момент и календарный день в поясе владельца), у прочих — `sv(v)` (значение под кастом по виду
 * привязанного свойства). Привязок нет — `null`: адресовать на записях нечего.
 */
export function slotValuesSql(addr: Required<QueryContractAddress>, cctx: CompileCtx): SQL | null {
  const kind = kindOrFail(addr, cctx);
  const rows = slotBindings(addr, cctx);
  if (rows.length === 0) return null;
  if (isDated(kind)) {
    const values = rows.map(({ binding, propertyId }) => {
      const v = propertyValueExprs(propertyId, cctx);
      return sql`(${guarded(binding.aspectId, sql`(${v.at()})`)}, ${guarded(binding.aspectId, v.day())})`;
    });
    return sql`(VALUES ${sql.join(values, sql`, `)}) AS sv(at, day)`;
  }
  const values = rows.map(
    ({ binding, propertyId }) =>
      sql`(${guarded(binding.aspectId, propertyValueExprs(propertyId, cctx).value())})`,
  );
  return sql`(VALUES ${sql.join(values, sql`, `)}) AS sv(v)`;
}

/**
 * ДАТЫ ЗНАЧЕНИЯ «ДАТЫ» (§3.2, §4.2): отношение `(slot, at, day)` по слотам с ролью, уже
 * отфильтрованное правилом:
 *
 *   WHERE d.at IS NOT NULL
 *     AND ( d.role = 'fact'
 *        OR ( NOT <есть значение у любого факт-слота на записи>
 *             AND NOT COALESCE(<запись в наборе closed завершаемости>, false) ) )
 *
 * Строка у слота без роли не заводится вовсе (`end`, `all_day` в значение не входят). Привязок с
 * ролью нет — `null`: дат нет ни у одной записи.
 */
export function whenDatesSql(contractId: string, cctx: CompileCtx): SQL | null {
  const c = cctx.reg.contracts.get(contractId);
  if (c === undefined || c.kind !== 'slots') return null;
  const roleOf = new Map(
    c.slots.flatMap((s) => (s.value_role === undefined ? [] : [[s.name, s.value_role] as const])),
  );
  const rows: SQL[] = [];
  const facts: SQL[] = [];
  for (const binding of bindingIndexOf(cctx.reg).byContract(contractId)) {
    for (const [slot, role] of roleOf) {
      const propertyId = binding.bind[slot];
      if (propertyId === undefined) continue;
      const v = propertyValueExprs(propertyId, cctx);
      const at = guarded(binding.aspectId, sql`(${v.at()})`);
      rows.push(sql`(${lit(slot)}, ${lit(role)}, ${at}, ${guarded(binding.aspectId, v.day())})`);
      if (role === 'fact') facts.push(sql`${at} IS NOT NULL`);
    }
  }
  if (rows.length === 0) return null;
  const hasFact = facts.length === 0 ? sql`false` : sql`(${sql.join(facts, sql` OR `)})`;
  const closedContract = [...cctx.reg.contracts.values()].find(
    (x) => x.key === COMPLETABLE_CLOSED.contract,
  );
  const closed =
    closedContract === undefined
      ? sql`false`
      : compileClassMembership(closedContract.id, COMPLETABLE_CLOSED.set, cctx, sql.raw('e'));
  return sql`(SELECT d.slot, d.at, d.day FROM (VALUES ${sql.join(rows, sql`, `)}) AS d(slot, role, at, day) WHERE d.at IS NOT NULL AND (d.role = 'fact' OR (NOT ${hasFact} AND NOT COALESCE(${closed}, false))))`;
}

/**
 * ПРЕДФИЛЬТР ЗНАЧЕНИЯ «ДАТЫ» — необходимое условие положительной формы, дешёвое на строке.
 * Каждая дата записи — день одного из свойств, привязанных к слотам с ролью; значит, если форма
 * истинна хоть для одной даты, она истинна и для дня хоть одного такого свойства. Проверка идёт
 * по сырым свойствам (без подзапроса), и коррелированный `EXISTS` по датам считается только у
 * записей, прошедших её. Решает по-прежнему `EXISTS`: предфильтр правило значения не заменяет.
 * Замер — `perf/graph.test.ts`, `when:value-next_7d`: 681 мс p95 без предфильтра на 50 000 задач.
 */
function valuePrefilter(
  contractId: string,
  node: { op: QueryPropOp; value: unknown },
  name: string,
  cctx: CompileCtx,
): SQL {
  const c = cctx.reg.contracts.get(contractId);
  const roles = new Set(
    c?.kind === 'slots' ? c.slots.filter((s) => s.value_role !== undefined).map((s) => s.name) : [],
  );
  const properties = new Set<string>();
  for (const binding of bindingIndexOf(cctx.reg).byContract(contractId)) {
    for (const slot of roles) {
      const propertyId = binding.bind[slot];
      if (propertyId !== undefined) properties.add(propertyId);
    }
  }
  if (properties.size === 0) return sql`false`;
  const overdue = node.op === 'eq' && isTokenValue(node.value) && node.value.token === 'overdue';
  const parts = [...properties].sort().map((propertyId) => {
    const day = propertyValueExprs(propertyId, cctx).day();
    if (overdue) return sql`${day} < ${cctx.today}::date`;
    const expr: CondExpr = {
      name,
      of: `поля '${name}'`,
      day: () => day,
      comparable: () => day,
      param: (v) => dayLiteral(name, v),
      dayParam: (v) => dayLiteral(name, v),
    };
    return exprCond(expr, node.op, node.value, cctx);
  });
  return parts.length === 1 ? (parts[0] as SQL) : sql`(${sql.join(parts, sql` OR `)})`;
}

/** Литерал дня: форма и календарь. Значение «даты» сравнивается по ДНЯМ записи (§3.3). */
function dayLiteral(name: string, value: QueryScalar): SQL {
  if (typeof value !== 'string' || !DAY_RE.test(value) || !hasValidCalendar(value)) {
    return fail('TYPE', `адрес '${name}' ожидает дату YYYY-MM-DD, получено '${String(value)}'`, {
      property: name,
      value,
    });
  }
  return sql`${value}::date`;
}

/**
 * Выражение условия над датами строки `alias` (`w` — значение «даты», `sv` — слот с датой).
 *
 * У слота с `timestamp` среди видов литерал дня сравнивается с ДНЁМ значения, момент — с МОМЕНТОМ.
 * Литералы одного условия (`range`, `in`) обязаны быть одного вида: левая сторона у условия одна, и
 * `sv.day BETWEEN $::date AND $::timestamptz` сравнил бы день с моментом — событие 07-17 20:00
 * попадало бы в «..2026-07-17T12:00». Отказ `TYPE` тем же текстом, что у разбора (эталон — свойство
 * `timestamp`, которое дня рядом с моментом не принимает вовсе; перенос гейта задачи 1, Minor-1).
 */
function datedExpr(
  name: string,
  alias: 'w' | 'sv',
  momentLiterals: boolean,
  cctx: CompileCtx,
): CondExpr {
  const day = sql.raw(`${alias}.day`);
  const at = sql.raw(`${alias}.at`);
  const isDay = (v: QueryScalar) => typeof v === 'string' && DAY_RE.test(v);
  /** Литерал момента ISO — только у слота с `timestamp` среди видов. */
  const moment = (v: QueryScalar): SQL => {
    if (typeof v !== 'string' || !hasValidCalendar(v) || Number.isNaN(Date.parse(v))) {
      return fail(
        'TYPE',
        `адрес '${name}' ожидает дату или момент ISO 8601, получено '${String(v)}'`,
        { property: name, value: v },
      );
    }
    return sql`${v}::timestamptz`;
  };
  return {
    name,
    of: `поля '${name}'`,
    day: () => day,
    // Литерал дня сравнивается с днём, момент — с моментом (у слота с `timestamp`).
    comparable: (samples) => {
      if (!momentLiterals) return day;
      const days = samples.filter(isDay).length;
      if (days !== 0 && days !== samples.length) {
        return fail(
          'TYPE',
          `условие у поля '${name}': литералы одного вида — все дни или все моменты ISO 8601; получено ${samples.map((v) => `'${String(v)}'`).join(', ')}`,
          { property: name },
        );
      }
      return days === 0 ? at : day;
    },
    param: (v) => (!momentLiterals || isDay(v) ? dayLiteral(name, v) : moment(v)),
    // Граница рядом с токеном — день; момент ISO переводится в день пояса владельца.
    dayParam: (v) =>
      !momentLiterals || isDay(v)
        ? dayLiteral(name, v)
        : sql`(${moment(v)} AT TIME ZONE ${cctx.timeZone})::date`,
  };
}

/** Выражение условия над значением слота не-даты: каст литерала — по первому виду слота. */
function scalarExpr(name: string, kind: Extract<AddressKind, { kind: 'slot' }>): CondExpr {
  const first = kind.kinds[0];
  const numeric = first === 'number' || first === 'decimal';
  return {
    name,
    of: `поля '${name}'`,
    day: () =>
      fail(
        'TYPE',
        `относительное время и сравнение по дате применимы только к полям с датой (date/timestamp); поле '${name}' — ${kind.kinds.join('|')}`,
        { property: name },
      ),
    comparable: () => sql.raw('sv.v'),
    param: (v) => {
      if (numeric) {
        const ok = typeof v === 'number' || (typeof v === 'string' && DECIMAL_RE.test(v));
        if (!ok)
          return fail('TYPE', `адрес '${name}' ожидает число, получено '${String(v)}'`, {
            property: name,
            value: v,
          });
        return sql`${v}::numeric`;
      }
      if (first === 'boolean') {
        if (typeof v !== 'boolean')
          return fail('TYPE', `адрес '${name}' ожидает true или false`, {
            property: name,
            value: v,
          });
        return sql`${v}::boolean`;
      }
      return sql`${String(v)}`;
    },
    dayParam: () =>
      fail('TYPE', `адрес '${name}' — не дата: граница-день неприменима`, { property: name }),
  };
}

/** Токен ли значение узла (`{token}`), а не литерал. */
function isTokenValue(value: unknown): value is { token: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'token' in value;
}

/** «Все даты позади, и хотя бы одна есть» (К-2) — `overdue` у значения контракта. */
function valueOverdue(dates: SQL, cctx: CompileCtx): SQL {
  return sql`(EXISTS (SELECT 1 FROM ${dates} w) AND NOT EXISTS (SELECT 1 FROM ${dates} w WHERE w.day >= ${cctx.today}::date))`;
}

/**
 * Условие на адресе (§3.1–§3.3): положительные формы — «хоть одно значение», `ne` — полное
 * отрицание `eq`, `overdue` у значения контракта — К-2. Записи без значений ни одной
 * положительной формы не проходят, отрицание — проходят.
 */
// ОБХОДЧИК-Q: contract-sql
export function addressCond(node: QueryPropNodeWithAddress, cctx: CompileCtx): SQL {
  const addr = node.prop;
  const kind = kindOrFail(addr, cctx);
  const name = addressName(addr, cctx);
  if (node.op === 'contains') {
    return fail(
      'TYPE',
      `оператор 'contains' не определён для адреса '${name}': вхождение элемента бывает у списка`,
      { property: name, op: node.op },
    );
  }
  if (node.op === 'ne') {
    return negated(addressCond({ ...node, op: 'eq' }, cctx));
  }
  if (kind.kind === 'dates') {
    const dates = whenDatesSql(addr.contract, cctx);
    if (dates === null) return sql`false`;
    const pre = valuePrefilter(addr.contract, node, name, cctx);
    if (node.op === 'eq' && isTokenValue(node.value) && node.value.token === 'overdue') {
      return sql`(${pre} AND ${valueOverdue(dates, cctx)})`;
    }
    const cond = exprCond(datedExpr(name, 'w', false, cctx), node.op, node.value, cctx);
    return sql`(${pre} AND EXISTS (SELECT 1 FROM ${dates} w WHERE ${cond}))`;
  }
  const slotAddr = addr as Required<QueryContractAddress>;
  const values = slotValuesSql(slotAddr, cctx);
  if (values === null) return sql`false`;
  const expr = isDated(kind)
    ? datedExpr(name, 'sv', kind.kinds.includes('timestamp'), cctx)
    : scalarExpr(name, kind);
  const cond = exprCond(expr, node.op, node.value, cctx);
  return sql`(${aspectsAny(slotBindings(slotAddr, cctx).map((r) => r.binding))} AND EXISTS (SELECT 1 FROM ${values} WHERE ${cond}))`;
}

/**
 * Условие ОДНОЙ даты — для ключа сортировки: у `overdue` значения контракта это «эта дата раньше
 * сегодня» (К-2 — про запись целиком, а ключ выбирается среди её дат), прочие формы — как в
 * условии.
 */
function perDateCond(
  expr: CondExpr,
  node: QueryPropNodeWithAddress,
  alias: 'w' | 'sv',
  cctx: CompileCtx,
): SQL {
  if (node.op === 'eq' && isTokenValue(node.value) && node.value.token === 'overdue') {
    return sql`${sql.raw(`${alias}.day`)} < ${cctx.today}::date`;
  }
  return exprCond(expr, node.op, node.value, cctx);
}

/**
 * КЛЮЧ СОРТИРОВКИ ПО АДРЕСУ (§3.3, РП-21). У значения «даты» и у слота с датой — самая ранняя из
 * дат записи, удовлетворяющих КАЖДОМУ положительному условию блока на том же адресе; нет такой —
 * удовлетворяющая хотя бы одному; условий нет — самая ранняя вообще. У слота не-даты — значение
 * привязки аспекта с меньшим рангом (`COALESCE` в порядке `bindingIndexOf`). Без значения — NULL,
 * и `NULLS LAST` вызывающего ставит запись в конец.
 *
 * `positive` — дети верхнего `and` блока (или сам фильтр): отсюда берутся узлы `{prop: адрес}`
 * того же адреса, кроме `ne` и `contains` (отрицание ключа не задаёт).
 */
export function addressSortKey(
  addr: QueryContractAddress,
  positive: readonly QueryFilterNode[],
  cctx: CompileCtx,
): SQL {
  const kind = kindOrFail(addr, cctx);
  const name = addressName(addr, cctx);
  const key = fieldRefKey(addr);
  const conds = positive.flatMap((n) =>
    'prop' in n &&
    isContractAddress(n.prop) &&
    fieldRefKey(n.prop) === key &&
    n.op !== 'ne' &&
    n.op !== 'contains'
      ? [n as QueryPropNodeWithAddress]
      : [],
  );
  if (kind.kind === 'slot' && !isDated(kind)) {
    const rows = slotBindings(addr as Required<QueryContractAddress>, cctx);
    if (rows.length === 0) return sql`NULL`;
    const parts = rows.map(({ binding, propertyId }) =>
      guarded(binding.aspectId, propertyValueExprs(propertyId, cctx).value()),
    );
    return sql`COALESCE(${sql.join(parts, sql`, `)})`;
  }
  const alias = kind.kind === 'dates' ? 'w' : 'sv';
  const source =
    kind.kind === 'dates'
      ? whenDatesSql(addr.contract, cctx)
      : slotValuesSql(addr as Required<QueryContractAddress>, cctx);
  if (source === null) return sql`NULL`;
  const from = kind.kind === 'dates' ? sql`${source} w` : source;
  const at = sql.raw(`${alias}.at`);
  if (conds.length === 0) return sql`(SELECT min(${at}) FROM ${from})`;
  const expr = datedExpr(
    name,
    alias,
    kind.kind === 'slot' && kind.kinds.includes('timestamp'),
    cctx,
  );
  const each = conds.map((n) => perDateCond(expr, n, alias, cctx));
  const all = sql.join(each, sql` AND `);
  const any = sql.join(each, sql` OR `);
  return sql`COALESCE((SELECT min(${at}) FROM ${from} WHERE ${all}), (SELECT min(${at}) FROM ${from} WHERE ${any}))`;
}

/**
 * Числовое значение адреса для `sum`/`latest` (§3.1): у слота числового вида — значение привязки
 * с меньшим рангом (`COALESCE` по рангу), у значения контракта — отказ: даты не суммируются.
 */
export function addressNumericSql(
  addr: QueryContractAddress,
  cctx: CompileCtx,
  op: 'sum' | 'latest',
): SQL {
  const kind = kindOrFail(addr, cctx);
  const name = addressName(addr, cctx);
  if (kind.kind === 'dates') {
    return fail('TYPE', `${op} по значению '${name}' невозможен: даты не суммируются`, {
      property: name,
    });
  }
  if (!kind.kinds.every((k) => k === 'number' || k === 'decimal')) {
    return fail(
      'FIELD',
      `${op} по адресу '${name}' невозможен: вид ${kind.kinds.join('|')} не числовой`,
      {
        property: name,
      },
    );
  }
  const rows = slotBindings(addr as Required<QueryContractAddress>, cctx);
  if (rows.length === 0) return sql`NULL::numeric`;
  const parts = rows.map(({ binding, propertyId }) =>
    guarded(binding.aspectId, propertyValueExprs(propertyId, cctx).value()),
  );
  return sql`(COALESCE(${sql.join(parts, sql`, `)}))::numeric`;
}
