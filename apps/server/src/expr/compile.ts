/**
 * SQL-БЭКЕНД ПРЕДИКАТОВ E — один из двух бэкендов языка (второй, decimal-интерпретатор
 * формул, приезжает задачей 8).
 *
 * Он отвечает на ОДИН вопрос: «подходит ли строка `entities` под это выражение». Поэтому
 * здесь живут только те формы, у которых есть предикатный смысл (сравнения, булева логика,
 * членство в наборе, наличие значения, входящее ребро), а величины и арифметика отказывают
 * НАЗВАННО (`EXPR_BACKEND_UNSUPPORTED`): «нет у этого бэкенда» — не то же самое, что «ложно»,
 * и молчаливое `true` спрятало бы дефект декларации на годы (§С8-3).
 *
 * ПРИЁМЫ БЕРУТСЯ У КОМПИЛЯТОРА Q, а не пишутся заново (`lit`, `castedExpr`, `negated`,
 * `CORE_COLUMN`): каст по `kind` реестра, экранирование литерала и тотальное отрицание
 * обязаны быть одни на два компилятора — два SQL по одному графу разошлись бы на первой
 * правке §6.1. Целиком `compile-ast.ts` не переиспользуется: он строит один SELECT по
 * `entities`, а предикат E — фрагмент, встающий в чужой запрос (`row` — алиас строки).
 *
 * ГЛАВНАЯ ФОРМА — OR ПО ПРИВЯЗКАМ. Контракт не знает своих реализаций, поэтому предикат «по
 * слотам» разворачивается в дизъюнкцию по ВСЕМ привязкам контракта из снимка реестра: аспект
 * владельца, реализовавший тот же контракт, попадает в тот же OR без единой строки кода —
 * это и есть гейт §С8-18.
 */
import {
  bindingIndexOf,
  type ContractDefinition,
  type PropertyDefinition,
  type ResolvedBinding,
} from '@orbis/shared';
import { EXPR_FORMS, type ExprNode, type ExprOp, type ExprScalar } from '@orbis/shared/expr';
import { type SQL, sql } from 'drizzle-orm';
import { ExecError } from '../errors';
import { CORE_COLUMN, type CompileCtx, castedExpr, lit, negated } from '../query/compile-ast';

/**
 * Причины отказа компиляции E. ТИПИЗИРОВАНЫ, в отличие от `reason: string` у компилятора Q:
 * там опечатка в причине компилируется молча, и потребитель, ключующийся на строке, узнаёт
 * об этом на проде.
 */
export const EXPR_COMPILE_REASONS = [
  'UNKNOWN_CONTRACT',
  'UNKNOWN_SET',
  'UNKNOWN_SLOT',
  'EXPR_BACKEND_UNSUPPORTED',
  'EXPR_SHAPE',
] as const;
type ExprCompileReason = (typeof EXPR_COMPILE_REASONS)[number];

export interface ExprCompileScope {
  cctx: CompileCtx;
  /** Предикат «по слотам»: имя контракта области. */
  contract?: string;
  /** Одна привязка (внутри OR по привязкам контракта). */
  binding?: ResolvedBinding;
  /** Алиас строки `entities`, к которой пишется предикат (`sql.raw('e')`, `'b'`, `'far'`). */
  row: SQL;
  params?: Readonly<Record<string, ExprScalar>>;
  /**
   * Уровень вложенности EXISTS'ов `has_relation` — от него зависят алиасы подзапроса
   * (см. `relationPredicate`). Поле области, а не параметр функций §1.2: сигнатуры
   * `compileContractPredicate`/`compileClassMembership` — закон реестра, поэтому глубину
   * протаскивают внутренние `contractPredicateAt`/`classMembershipAt`, а экспортируемые
   * обёртки начинают с нуля.
   */
  relationDepth?: number;
  /**
   * Сколько ПРЕДИКАТНЫХ НАБОРОВ уже развёрнуто на этом пути (кап — `SET_RECURSION_CAP`).
   * Считается отдельно от `relationDepth`, а не тем же числом, и это несущее различие:
   * `relationDepth` заодно даёт алиасы подзапросов, и увеличив его ради набора, мы сдвинули
   * бы имена `r`/`far` у уже написанного SQL. Набор же рекурсирует и БЕЗ нового EXISTS —
   * через правый операнд `in` (`{const:'<набор>'}`), — поэтому свой счётчик обязателен.
   */
  setDepth?: number;
}

/** Область слотов: контракт и привязка известны оба или ни один. */
type SlotScope = Required<Pick<ExprCompileScope, 'cctx' | 'contract' | 'binding' | 'row'>>;

/** Форма отказа — как у компилятора Q, но причина типизирована. */
function fail(reason: ExprCompileReason, message: string, extra?: Record<string, unknown>): never {
  throw new ExecError('VALIDATION', message, { reason, ...extra });
}

/** Имя формы узла — для текста отказа: «что именно бэкенд не умеет». */
function formOf(node: ExprNode): string {
  for (const form of EXPR_FORMS) if (form in node) return form;
  return 'неизвестная форма';
}

function unsupported(what: string): never {
  return fail(
    'EXPR_BACKEND_UNSUPPORTED',
    `${what}: у SQL-бэкенда предикатов такой формы нет — величины и арифметика живут в decimal-интерпретаторе`,
    { form: what },
  );
}

function slotsContract(
  id: string,
  cctx: CompileCtx,
): Extract<ContractDefinition, { kind: 'slots' }> | undefined {
  const def = cctx.reg.contracts.get(id);
  return def !== undefined && def.kind === 'slots' ? def : undefined;
}

/** Выражение доступа к значению свойства на строке `row` (каст — по `kind` реестра). */
function propertySql(prop: PropertyDefinition, row: SQL): SQL {
  if (prop.storage === 'core') {
    const column = CORE_COLUMN[prop.id];
    if (column === undefined) {
      return fail(
        'EXPR_SHAPE',
        `свойство '${prop.id}' объявлено core-проекцией, но колонки под него нет`,
        { property: prop.id },
      );
    }
    return sql`${row}.${sql.raw(column)}`;
  }
  return castedExpr(sql`${row}.props->>${lit(prop.id)}`, prop.type);
}

/** «У значения есть значение»: у core-проекции — колонка не NULL, у props — наличие ключа. */
function propertyPresenceSql(prop: PropertyDefinition, row: SQL): SQL {
  if (prop.storage === 'core') {
    const column = CORE_COLUMN[prop.id];
    if (column === undefined) {
      return fail(
        'EXPR_SHAPE',
        `свойство '${prop.id}' объявлено core-проекцией, но колонки под него нет`,
        { property: prop.id },
      );
    }
    return sql`${row}.${sql.raw(column)} IS NOT NULL`;
  }
  return sql`${row}.props ? ${lit(prop.id)}`;
}

function propertyOf(propertyId: string, scope: SlotScope, slot: string): PropertyDefinition {
  const prop = scope.cctx.reg.properties.get(propertyId);
  // Привязка ссылается на свойство, которого нет: это не «значения нет», а рассогласованный
  // реестр — `checkImplements` такое не пропускает (`UNKNOWN_PROPERTY`, §1.4).
  if (prop === undefined) {
    return fail(
      'EXPR_SHAPE',
      `привязка '${scope.binding.aspectId}' ссылается на свойство '${propertyId}', которого нет в реестре`,
      { slot, property: propertyId },
    );
  }
  return prop;
}

/**
 * Значение слота в этой привязке. Исходов ТРИ (§Б2-3 «частичная привязка законна»):
 *  — слота нет среди `slots` контракта → отказ: в декларации опечатка, и молчать нельзя;
 *  — слот связан (`bind`/`fixed`) → выражение по свойству либо константа;
 *  — слот ОБЪЯВЛЕН контрактом, но в этой привязке не связан → `NULL`, то есть «значения нет».
 *
 * Третий исход — не поблажка. `compileContractPredicate` строит OR по ВСЕМ привязкам
 * контракта, и в этом OR стоят чужие аспекты: у аспекта владельца может быть связано четыре
 * слота денег из девяти, а предикат `money-movement.sets.facts` читает `planned`. Отказ здесь
 * ронял бы членство у КАЖДОГО владельца своего аспекта — то есть Budget, повестку и весь
 * гейт §С8-18 разом. Тотальность при этом не теряется: её дают COALESCE в
 * `compileClassMembership` и `negated` там же, где они даются отсутствующему свойству, — а не
 * подмена NULL на `false` внутри значения.
 */
function slotSql(slot: string, scope: SlotScope): SQL {
  const decl = slotsContract(scope.contract, scope.cctx)?.slots.find((s) => s.name === slot);
  if (decl === undefined) {
    return fail('UNKNOWN_SLOT', `у контракта '${scope.contract}' нет слота '${slot}'`, {
      contract: scope.contract,
      slot,
    });
  }
  const fixed = scope.binding.fixed[slot];
  if (fixed !== undefined) return typeof fixed === 'string' ? lit(fixed) : sql.raw(String(fixed));
  const propertyId = scope.binding.bind[slot];
  if (propertyId === undefined) return sql`NULL`;
  return propertySql(propertyOf(propertyId, scope, slot), scope.row);
}

/**
 * «Значение слота у этой сущности есть». Слот без привязки отвечает `false` — «не член», а не
 * отказом: в `requiredSlots` попадают только ОБЯЗАТЕЛЬНЫЕ, а обязательный без привязки
 * запрещён `checkImplements` (`REQUIRED_SLOT_UNBOUND`, §1.4), и второго отказа на состояние,
 * которого реестр не допускает, заводить незачем.
 */
function presenceSql(slot: string, scope: SlotScope): SQL {
  if (scope.binding.fixed[slot] !== undefined) return sql`true`;
  const propertyId = scope.binding.bind[slot];
  if (propertyId === undefined) return sql`false`;
  return propertyPresenceSql(propertyOf(propertyId, scope, slot), scope.row);
}

/** Условие «слот несёт один из вариантов класса» (§Б2-2). */
function variantCond(slot: string, variants: readonly (string | boolean)[], scope: SlotScope): SQL {
  const propertyId = scope.binding.bind[slot];
  // Карта вариантов на несвязанном слоте вариантов в данных не имеет — «не член».
  if (propertyId === undefined) return sql`false`;
  const prop = propertyOf(propertyId, scope, slot);
  if (prop.type.kind === 'json') {
    // Р-К-3: у вложенного объекта вариантов в значении нет — статус даёт САМО НАЛИЧИЕ
    // (`orbis/recurrence` есть → шаблон), и отнесение написано маркерами present/absent.
    const parts = variants.map((v) =>
      String(v) === 'present'
        ? sql`${scope.row}.props ? ${lit(prop.id)}`
        : sql`NOT (${scope.row}.props ? ${lit(prop.id)})`,
    );
    return parts.length === 1 ? (parts[0] as SQL) : sql`(${sql.join(parts, sql.raw(' OR '))})`;
  }
  const value = propertySql(prop, scope.row);
  // Булев вариант — литерал `true`/`false`, а не строка: `->>` даёт текст, но каст реестра
  // уже привёл выражение к boolean.
  const literals = variants.map((v) => (typeof v === 'boolean' ? sql.raw(String(v)) : lit(v)));
  if (literals.length === 1) return sql`${value} = ${literals[0] as SQL}`;
  return sql`${value} IN (${sql.join(literals, sql.raw(', '))})`;
}

/** Скаляр декларации литералом: строки экранируются, числа и булевы идут как есть. */
function scalarSql(value: ExprScalar): SQL {
  if (value === null) return sql`NULL`;
  if (typeof value === 'string') return lit(value);
  return sql.raw(String(value));
}

/** Операнд сравнения. Всё, что не имеет предикатного смысла, отказывает названно. */
function valueSql(node: ExprNode, scope: ExprCompileScope): SQL {
  if ('const' in node) {
    if (Array.isArray(node.const)) {
      return fail('EXPR_SHAPE', 'список значений законен только справа у `in`', {
        form: 'const',
      });
    }
    return scalarSql(node.const as ExprScalar);
  }
  if ('prop' in node) {
    const prop = scope.cctx.reg.properties.get(node.prop);
    if (prop === undefined) {
      return fail('EXPR_SHAPE', `неизвестное свойство '${node.prop}': такого id нет в реестре`, {
        property: node.prop,
      });
    }
    return propertySql(prop, scope.row);
  }
  if ('slot' in node) return slotSql(node.slot, slotScopeOf(scope, 'slot'));
  if ('param' in node) {
    const value = scope.params === undefined ? undefined : scope.params[node.param];
    if (value === undefined) {
      return fail('EXPR_SHAPE', `параметр '${node.param}' не задан вызывающим`, {
        param: node.param,
      });
    }
    return scalarSql(value);
  }
  if ('ctx' in node) {
    if (node.ctx === '$today') return sql`${scope.cctx.today}::date`;
    if (node.ctx === '$self') return sql`${scope.row}.id`;
    if (node.ctx === '$owner') return sql`${scope.cctx.ownerId}`;
    return unsupported('$sensitivity');
  }
  if ('date_add' in node) {
    const shift = node.date_add[1];
    if (!('duration' in shift)) {
      return fail('EXPR_SHAPE', 'сдвиг даты требует длительности вторым аргументом', {
        form: 'date_add',
      });
    }
    // Литерал в тексте запроса не зависит от схемы (докблок `lit`): regex формы —
    // защита ВХОДА, а не экранирование вывода.
    return sql`(${valueSql(node.date_add[0], scope)}) + interval ${lit(shift.duration)}`;
  }
  return unsupported(formOf(node));
}

function slotScopeOf(scope: ExprCompileScope, form: string): SlotScope {
  if (scope.contract === undefined || scope.binding === undefined) {
    return fail('EXPR_SHAPE', `${form} законен только в предикате по слотам контракта`, { form });
  }
  return { cctx: scope.cctx, contract: scope.contract, binding: scope.binding, row: scope.row };
}

/**
 * БУЛЕВ УЗЕЛ-ЗНАЧЕНИЕ В ПРЕДИКАТНОЙ ПОЗИЦИИ (B2 I-2). Чекер типизирует `{prop}`/`{slot}` булева
 * рода как `boolean` и пропускает такую декларацию на записи (§Б3-4), поэтому бэкенд обязан её
 * СЧИТАТЬ, а не отвечать «формы нет»: иначе отказ приезжает не автору декларации, а владельцу на
 * чтении поверхности (Р-И-7).
 *
 * COALESCE — не украшение, а ТОТАЛЬНОСТЬ: без него отсутствующее значение даёт NULL, и строка
 * молча выпадает из выдачи вместо честного «не член» (то же правило, что у `negated`).
 *
 * НЕбулевой род — отказ ЗДЕСЬ и структурный (`EXPR_SHAPE`), а не ошибка Postgres на чтении:
 * через дверь записи такая форма недостижима (чекер требует `boolean`), но §С8-3 требует, чтобы
 * у невыразимого было имя.
 */
function booleanValueSql(node: ExprNode, scope: ExprCompileScope): SQL {
  const type =
    'prop' in node
      ? scope.cctx.reg.properties.get(node.prop)?.type
      : slotsContract(slotScopeOf(scope, 'slot').contract, scope.cctx)?.slots.find(
          (s) => s.name === (node as { slot: string }).slot,
        )?.type;
  // Неизвестное имя назовёт `valueSql` своим отказом — второго словаря на одно место не заводится.
  const boolean =
    type === undefined ||
    type.kind === 'boolean' ||
    (type.kind === 'any_of' && type.kinds.includes('boolean'));
  if (!boolean) {
    return fail(
      'EXPR_SHAPE',
      `${formOf(node)} рода ${type.kind} в предикатной позиции: здесь законно только булево значение`,
      { form: formOf(node), kind: type.kind },
    );
  }
  return sql`COALESCE(${valueSql(node, scope)}, false)`;
}

/** Оператор сравнения в SQL: `!=` пишется стандартным `<>`. */
const COMPARISON_SQL: Partial<Record<ExprOp, string>> = {
  '=': '=',
  '!=': '<>',
  '>': '>',
  '<': '<',
  '>=': '>=',
  '<=': '<=',
};

function hasPredicate(name: string, scope: ExprCompileScope): SQL {
  if (scope.contract !== undefined && scope.binding !== undefined) {
    const decl = slotsContract(scope.contract, scope.cctx)?.slots.find((s) => s.name === name);
    // «Есть ли значение» у несвязанного слота — честное «нет» (§Б2-3), а не отказ: то же
    // правило, что у `slotSql`.
    if (decl !== undefined) return presenceSql(name, slotScopeOf(scope, 'has'));
  }
  const prop = scope.cctx.reg.properties.get(name);
  if (prop === undefined) {
    return fail(
      'EXPR_SHAPE',
      `has('${name}'): это ни id свойства реестра, ни слот контракта области`,
      { name },
    );
  }
  return propertyPresenceSql(prop, scope.row);
}

/**
 * Входящее ребро роли (Е-1). Якорь тот же, что у Q (`QUERY_REL_ANCHOR.has_relation = 'target'`):
 * сущность стоит ЦЕЛЬЮ ребра, дальний конец — источник. `alive: true` — «дальний конец не
 * архивен», дословно как у оракула агрегатов.
 *
 * АЛИАСЫ СВОИ НА КАЖДЫЙ УРОВЕНЬ (`r`/`far`, `r2`/`far2`, …), и это не косметика. Предикат
 * набора сам может быть `has_relation` (набор `blocked` контракта завершаемости), и тогда
 * внутренний EXISTS встаёт ВНУТРЬ внешнего. С одним именем на оба уровня `far` внутреннего
 * подзапроса затеняет внешний, условие `<rel>.target_id = far.id` начинает читать СВОЙ же
 * источник — предикат молча вырождается в «ребро-петлю» и не находит ничего. Отказом такое
 * не проявляется вовсе: SQL законен, ответ пуст.
 *
 * РОЛЬ СВЕРЯЕТСЯ С РЕЕСТРОМ — как `roleOrFail` у компилятора Q: опечатка в имени роли иначе
 * компилируется в условие, ложное всегда, то есть «не выполнено» вместо «такого имени нет»
 * (§С8-3). Причина отказа — `EXPR_SHAPE`, а не шестая своя: `EXPR_COMPILE_REASONS` объявлен
 * реестром §1.2 пятёркой, а `details.role` адресует место не хуже отдельного кода.
 */
function relationPredicate(
  spec: { role: string; in_set?: { contract: string; set: string }; alive?: boolean },
  scope: ExprCompileScope,
): SQL {
  if (!scope.cctx.reg.roles.has(spec.role)) {
    return fail('EXPR_SHAPE', `роли '${spec.role}' нет в реестре владельца`, { role: spec.role });
  }
  const depth = scope.relationDepth ?? 0;
  const suffix = depth === 0 ? '' : String(depth + 1);
  const rel = sql.raw(`r${suffix}`);
  const far = sql.raw(`far${suffix}`);
  const conds: SQL[] = [sql`${rel}.target_id = ${scope.row}.id`, sql`${rel}.role = ${spec.role}`];
  if (spec.alive !== undefined) {
    conds.push(spec.alive ? sql`NOT ${far}.archived` : sql`${far}.archived`);
  }
  if (spec.in_set !== undefined) {
    conds.push(
      classMembershipAt(
        spec.in_set.contract,
        spec.in_set.set,
        scope.cctx,
        far,
        depth + 1,
        scope.setDepth ?? 0,
      ),
    );
  }
  return sql`EXISTS (SELECT 1 FROM relations ${rel} JOIN entities ${far} ON ${far}.id = ${rel}.source_id WHERE ${sql.join(conds, sql.raw(' AND '))})`;
}

function inPredicate(args: readonly ExprNode[], scope: ExprCompileScope): SQL {
  const left = args[0] as ExprNode;
  const right = args[1] as ExprNode;
  if (!('class' in left)) {
    // `in` по значению (Е-3, «текст в списке тегов») — работа decimal-бэкенда: у предиката
    // наборов левый операнд всегда класс контракта.
    return unsupported('in по значению');
  }
  if (!('const' in right)) {
    return fail('EXPR_SHAPE', 'справа у `in` над классом стоит имя набора либо список классов', {
      contract: left.class.contract,
    });
  }
  const value = right.const;
  if (typeof value === 'string') {
    return classMembershipAt(
      left.class.contract,
      value,
      scope.cctx,
      scope.row,
      scope.relationDepth ?? 0,
      scope.setDepth ?? 0,
    );
  }
  if (Array.isArray(value)) {
    return compileClassListMembership(left.class.contract, value, scope.cctx, scope.row);
  }
  return fail('EXPR_SHAPE', 'справа у `in` над классом стоит имя набора либо список классов', {
    contract: left.class.contract,
  });
}

/**
 * Временной род операнда сравнения: `date` (календарный день) или `timestamp` (момент).
 * `undefined` — «род не временной либо неизвестен», и тогда сравнение остаётся как было.
 *
 * Нужен ровно одному месту — выравниванию сторон ниже: у `{ctx:'$today'}` род календарный,
 * у слота `when.moment` — моментный, и без выравнивания их сравнивал бы Postgres в
 * СЕССИОННОЙ зоне. `date_add` намеренно не разбирается: его результат — момент по правилам
 * SQL, и приписывать ему день значило бы менять смысл там, где зона ни при чём.
 */
function temporalKindOf(node: ExprNode, scope: ExprCompileScope): 'date' | 'timestamp' | undefined {
  if ('ctx' in node) return node.ctx === '$today' ? 'date' : undefined;
  const propertyId =
    'prop' in node
      ? node.prop
      : 'slot' in node && scope.binding !== undefined
        ? scope.binding.bind[node.slot]
        : undefined;
  if (propertyId === undefined) return undefined;
  const kind = scope.cctx.reg.properties.get(propertyId)?.type.kind;
  return kind === 'date' || kind === 'timestamp' ? kind : undefined;
}

/**
 * Момент → календарный день ВЛАДЕЛЬЦА. Формула та же, что у `dateExpr` компилятора Q
 * (`compile-ast.ts`, `propertyLocalDateExpr`): второй способ читать день сущности означал бы,
 * что запрос и предикат декларации расходятся на строках у полуночи.
 */
function localDateSql(value: SQL, scope: ExprCompileScope): SQL {
  return sql`(${value} AT TIME ZONE ${scope.cctx.timeZone})::date`;
}

export function compileExprPredicate(expr: ExprNode, scope: ExprCompileScope): SQL {
  if ('op' in expr) {
    if (expr.op === 'and' || expr.op === 'or') {
      const parts = expr.args.map((a) => compileExprPredicate(a, scope));
      return sql`(${sql.join(parts, sql.raw(expr.op === 'and' ? ' AND ' : ' OR '))})`;
    }
    // Отрицание ТОТАЛЬНОЕ (`NOT COALESCE(x, false)`): без него строка с отсутствующим
    // значением давала бы NULL и молча выпадала из выдачи.
    if (expr.op === 'not') return negated(compileExprPredicate(expr.args[0] as ExprNode, scope));
    if (expr.op === 'in') return inPredicate(expr.args, scope);
    // `if` — член канона §Б3-5, и чекер типизирует его булевым: плечи компилируются теми же
    // предикатами, условие — тоже. Плечо `{const:null}` отвергает ветка `const` ниже
    // (`EXPR_SHAPE`): «необязательное» в предикатной позиции у бэкенда смысла не имеет.
    if (expr.op === 'if') {
      const [cond, then, other] = expr.args as [ExprNode, ExprNode, ExprNode];
      return sql`(CASE WHEN ${compileExprPredicate(cond, scope)} THEN ${compileExprPredicate(
        then,
        scope,
      )} ELSE ${compileExprPredicate(other, scope)} END)`;
    }
    const operator = COMPARISON_SQL[expr.op];
    if (operator === undefined) return unsupported(`оператор '${expr.op}'`);
    const leftNode = expr.args[0] as ExprNode;
    const rightNode = expr.args[1] as ExprNode;
    const kindL = temporalKindOf(leftNode, scope);
    const kindR = temporalKindOf(rightNode, scope);
    let l = valueSql(leftNode, scope);
    let r = valueSql(rightNode, scope);
    // ДЕНЬ ПРОТИВ МОМЕНТА (Ф-Б1-19): момент приводится к календарному дню владельца, а не
    // сравнивается с датой как есть. Иначе Postgres достраивает `'…'::date` до полуночи
    // СЕССИОННОЙ зоны, и дело, назначенное на утро владельца, читается вчерашним — тем самым
    // просроченным — у каждого, чья зона не равна серверной.
    if (kindL === 'date' && kindR === 'timestamp') r = localDateSql(r, scope);
    if (kindL === 'timestamp' && kindR === 'date') l = localDateSql(l, scope);
    return sql`${l} ${sql.raw(operator)} ${r}`;
  }
  if ('const' in expr) {
    if (typeof expr.const !== 'boolean') {
      return fail('EXPR_SHAPE', 'предикат обязан быть булевым', { form: 'const' });
    }
    return expr.const ? sql`true` : sql`false`;
  }
  if ('has' in expr) return hasPredicate(expr.has, scope);
  if ('has_relation' in expr) return relationPredicate(expr.has_relation, scope);
  if ('prop' in expr || 'slot' in expr) return booleanValueSql(expr, scope);
  return unsupported(formOf(expr));
}

export function compileContractPredicate(
  contract: string,
  expr: ExprNode,
  cctx: CompileCtx,
  row: SQL,
): SQL {
  return contractPredicateAt(contract, expr, cctx, row, 0);
}

/** То же, но с уровнями вложенности: см. `ExprCompileScope.relationDepth`/`setDepth`. */
function contractPredicateAt(
  contract: string,
  expr: ExprNode,
  cctx: CompileCtx,
  row: SQL,
  depth: number,
  setDepth = 0,
): SQL {
  if (!cctx.reg.contracts.get(contract)) {
    return fail('UNKNOWN_CONTRACT', `контракта '${contract}' нет в реестре владельца`, {
      contract,
    });
  }
  const bindings = bindingIndexOf(cctx.reg).byContract(contract);
  // Ни одной привязки — множество контракта ПУСТО, и это `false`, а не «пропустить условие»:
  // пустое условие вернуло бы все строки.
  if (bindings.length === 0) return sql`false`;
  const parts = bindings.map((binding) => {
    const aspect = sql`${row}.aspects @> ARRAY[${lit(binding.aspectId)}]`;
    // §Б2-3: аспект прикреплён, но обязательный слот пуст — сущность НЕ член контракта.
    const required = binding.requiredSlots.map((s) =>
      presenceSql(s, { cctx, contract, binding, row }),
    );
    const body = compileExprPredicate(expr, {
      cctx,
      contract,
      binding,
      row,
      relationDepth: depth,
      setDepth,
    });
    return sql`(${sql.join([aspect, ...required, body], sql.raw(' AND '))})`;
  });
  return parts.length === 1 ? (parts[0] as SQL) : sql`(${sql.join(parts, sql.raw(' OR '))})`;
}

export function compileClassMembership(
  contract: string,
  set: string,
  cctx: CompileCtx,
  row: SQL,
): SQL {
  return classMembershipAt(contract, set, cctx, row, 0, 0);
}

/**
 * ПОТОЛОК РАЗВЁРТКИ ПРЕДИКАТНЫХ НАБОРОВ (Ф-Б1-21). Набор, предикат которого через `in` либо
 * `has_relation.in_set` приводит обратно к нему самому, разворачивался бы бесконечно —
 * и владелец получал бы не отказ, а переполнение стека, то есть падение без единого имени.
 *
 * ЧИСЛО, А НЕ ГРАФ ССЫЛОК: цикл ловится там же, где он больно бьёт, — на развёртке, — и
 * ловится ЛЮБОЙ, включая цикл через три-четыре набора. Граф пришлось бы держать вторым
 * описанием устройства наборов рядом с самими наборами. 16 — заведомо выше всего, что
 * встречается: самая глубокая встроенная цепочка Б-1 разворачивает один набор внутри
 * другого (`blocked` → `open`), то есть два уровня.
 *
 * ЗАПИСЬ ЭТОТ КАП НЕ ЗАМЕНЯЕТ, А ДОПОЛНЯЕТ: тул `contract_sets_delta_set` отвергает
 * самоссылку владельца раньше и точнее — состав СВОЕГО набора это КЛАССЫ контракта
 * (`contractDeltaSchema`), и имя набора среди них не значится (`DELTA_SET_UNKNOWN_CLASS`
 * ДО записи). Здесь fail-closed на случай цикла, пришедшего сидом либо будущей формой
 * дельты: пропустить его значило бы уронить процесс на чтении.
 */
const SET_RECURSION_CAP = 16;

/** То же, но с уровнями вложенности: см. `ExprCompileScope.relationDepth`/`setDepth`. */
function classMembershipAt(
  contract: string,
  set: string,
  cctx: CompileCtx,
  row: SQL,
  depth: number,
  setDepth: number,
): SQL {
  if (setDepth >= SET_RECURSION_CAP) {
    return fail(
      'EXPR_SHAPE',
      `набор '${set}' контракта '${contract}' разворачивается глубже ${SET_RECURSION_CAP} уровней — вероятна ссылка набора на себя`,
      { contract, set, setDepth },
    );
  }
  const def = cctx.reg.contracts.get(contract);
  if (!def) {
    return fail('UNKNOWN_CONTRACT', `контракта '${contract}' нет в реестре владельца`, {
      contract,
    });
  }
  const spec =
    def.kind === 'slots' && def.sets !== null && Object.hasOwn(def.sets, set)
      ? def.sets[set]
      : undefined;
  if (spec === undefined) {
    return fail('UNKNOWN_SET', `у контракта '${contract}' нет набора '${set}'`, { contract, set });
  }
  // Предикат-набор (`money-movement.sets.facts`) — то же выражение по слотам, но ОБЁРНУТОЕ
  // COALESCE: слот, объявленный контрактом и не связанный в конкретной привязке, даёт NULL
  // (§Б2-3, `slotSql`), а `NULL = false` — это NULL, а не «не член». Без обёртки строка
  // молча выпадала бы и из набора, и из `NOT (…)` над ним.
  if (!Array.isArray(spec)) {
    return sql`COALESCE((${contractPredicateAt(contract, spec, cctx, row, depth, setDepth + 1)}), false)`;
  }
  // Списочный набор — перечисление классов контракта: та же ветка, что у `{const:[…]}` в `in`.
  return compileClassListMembership(contract, spec, cctx, row);
}

/**
 * Членство в ПЕРЕЧИСЛЕНИИ классов — вторая форма правого операнда `in` (Р-И-11:
 * `{const:'<набор>'}` либо `{const:[<классы>]}`). Встроенные декларации зовут наборы по
 * имени — перечисление дублировало бы состав, уже названный контрактом; для деклараций
 * владельца оно остаётся законным: набора под нужный состав контракт мог не назвать. Класс,
 * которого контракт не объявлял, не даёт ни одной части OR — то есть «не член».
 */
export function compileClassListMembership(
  contract: string,
  classList: readonly string[],
  cctx: CompileCtx,
  row: SQL,
): SQL {
  if (!cctx.reg.contracts.get(contract)) {
    return fail('UNKNOWN_CONTRACT', `контракта '${contract}' нет в реестре владельца`, {
      contract,
    });
  }
  const classes = new Set(classList);
  const parts: SQL[] = [];
  for (const binding of bindingIndexOf(cctx.reg).byContract(contract)) {
    const aspect = sql`${row}.aspects @> ARRAY[${lit(binding.aspectId)}]`;
    for (const [slot, byClass] of binding.variantsOfClass) {
      // `fixed`-слот считается ниже одним аспектом: вариант у него ровно один, и условие по
      // значению искало бы свойство, которого у привязки нет.
      if (binding.fixed[slot] !== undefined) continue;
      const variants = [...classes].flatMap((cls) => byClass.get(cls) ?? []);
      if (variants.length > 0) {
        parts.push(
          sql`(${aspect} AND ${variantCond(slot, variants, { cctx, contract, binding, row })})`,
        );
      }
    }
    // `fixed`-слот: класс задан декларацией, значит членство решается одним аспектом.
    for (const [slot, value] of Object.entries(binding.fixed)) {
      const cls = binding.classOfVariant.get(slot)?.get(String(value));
      if (cls !== undefined && classes.has(cls)) parts.push(aspect);
    }
  }
  // Пусто — `false`: сущность без аспекта контракта не член ни одного набора, и это ТОТАЛЬНО
  // (false, а не NULL). На этом стоит `excludeBlocked`: блокер-заметка без статуса не член
  // `closed`, значит по-прежнему блокирует.
  if (parts.length === 0) return sql`false`;
  return parts.length === 1 ? (parts[0] as SQL) : sql`(${sql.join(parts, sql.raw(' OR '))})`;
}
