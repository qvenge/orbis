// apps/server/src/actions/resolve.ts
// РЕЗОЛВ ДЕЙСТВИЯ (§Б6-4): «резолв id → CAS-precondition → подстановка → операции».
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ДОМ, А НЕ СТРОКА `MUTATION_ENVELOPES`. `precondition` живёт ТОЛЬКО в
// exec-надмножестве (`contracts/tools.ts`, `entityUpdateExecInput`), через конверты диспатча не
// проходит по построению (`validateMutationEnvelope` в `tools/dispatch.ts`; PRD
// `01-architecture.md` §9.2), а `prepareOp` исполнителя отверг бы незнакомый тул. Образец сборки
// exec-формы с предусловиями — тот же, которым пользуется отложка: `loadTargets` + `buildUpdate`
// (`routines/propose.ts`); третьей пары «прочитать цель и снять предусловия» в сервере быть не
// должно.
//
// `$expr` РЕЗОЛВИТСЯ ДО ПЕРВОГО ШАГА И ИЗ СОСТОЯНИЯ НА МОМЕНТ CAS (§Б6-3 дословно): читать
// результат предыдущего шага нельзя, поэтому область вычисления собирается ОДИН раз на цель и
// переиспользуется всеми шагами.
import {
  type ActionDefinition,
  BATCH_CAP_DEFAULT,
  effectiveLabel,
  type GraphId,
} from '@orbis/shared';
import type { ExprNode, ExprScalar } from '@orbis/shared/expr';
import { OWNER_LOCALE } from '@orbis/shared/query';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import { type ExprEvalScope, evalExpr } from '../expr/eval';
import { type CompileCtx, compileWhere } from '../query/compile-ast';
import { actionHash, paramLiteralType } from '../registry/actions';
import type { RegistrySnapshot } from '../registry/load';
import { literalFormViolation } from '../registry/validate-props';
import { buildUpdate, type ExecOperation, loadTargets, type TargetRow } from '../routines/propose';
import { type EntityScopeInput, entityEvalScope, relationFactsOf } from '../rules/scope';
import type { ToolDispatchResult } from '../tools/dispatch-common';

export type { ExecOperation };

/**
 * Строка карточки «было → станет» — та же форма, что у отложенной единицы (`tools/dispatch.ts`
 * импортирует её отсюда): вторая копия формы разошлась бы с карточкой действия.
 */
export interface DeferredRow {
  field: string;
  before?: string;
  after: string;
}

export const runActionInput = z
  .object({
    action: z.string().min(1), // key либо id строки реестра
    self: z.string().uuid().optional(),
    params: z.record(z.unknown()).optional(),
    batch_id: z.string().uuid().optional(),
  })
  .strict();
export type RunActionInput = z.infer<typeof runActionInput>;

export interface ResolvedAction {
  decl: ActionDefinition;
  /** `[self]` либо результат `over` (кап проверен), порядок по id. */
  targets: readonly string[];
  /** exec-форма с CAS (`buildUpdate`) — то, что уедет в `execute` / pending. */
  operations: ExecOperation[];
  hash: string;
  summary: string;
  rows: DeferredRow[];
}

/** Подпись действия владельцу; у пакетного — с числом целей. */
export function actionSummary(decl: ActionDefinition, n: number): string {
  const label = effectiveLabel(decl.label, OWNER_LOCALE);
  return n === 1 ? `Действие «${label}»` : `Действие «${label}» — ${n} ${entitiesNoun(n)}`;
}

/**
 * Декларация по ссылке вызова: id строки реестра либо её `key`. Вынесено из `resolveAction`,
 * потому что спросить модуль действия надо ДО резолва (`actions/run.ts`): действие выключенного
 * модуля не читает цели вовсе, а не отказывает после того, как прочитало.
 */
export function lookupAction(reg: RegistrySnapshot, ref: string): ActionDefinition {
  const decl = reg.actions.get(ref) ?? [...reg.actions.values()].find((a) => a.key === ref);
  if (decl === undefined) {
    throw new ExecError('NOT_FOUND', `действия «${ref}» нет в реестре`, { action: ref });
  }
  if (decl.status === 'deprecated') {
    // Снятая декларация не исполняется, но и «не найдено» неправда: строка есть (§А10-3).
    throw new ExecError('VALIDATION', `действие «${decl.key}» снято`, {
      reason: 'ACTION_DEPRECATED',
      action: decl.id,
    });
  }
  return decl;
}

export async function resolveAction(
  tx: Tx,
  reg: RegistrySnapshot,
  graphId: GraphId,
  input: RunActionInput,
  args: { today: string; timeZone: string },
): Promise<ResolvedAction> {
  const decl = lookupAction(reg, input.action);
  const params = checkedParams(decl, input.params ?? {});

  // Цели: `over === null` — ровно `self`; иначе — результат Q, отсортированный по id.
  const targets =
    decl.over === null
      ? [requireSelf(decl, input.self)]
      : await queryTargets(tx, reg, graphId, decl, input.self, args);

  const loaded = await loadTargets(
    tx,
    graphId,
    targets.map((id) => ({ tool: 'entity_update', input: { id } })),
  );
  if ('error' in loaded) refuse(loaded.error);
  const rows = new Map(loaded.rows);
  const roles = relationRolesOf(decl.precondition);

  // Шаги строятся ПО ЦЕЛИ, и область вычисления у каждой своя (§Б6-3 «$self — сущность, к
  // которой применяется действие»).
  const raw: Array<{ index: number; tool: string; input: Record<string, unknown> }> = [];
  for (const id of targets) {
    const current = rows.get(id);
    if (current === undefined) {
      throw new ExecError('NOT_FOUND', 'цель действия не найдена', { action: decl.id, id });
    }
    const scope = entityEvalScope({
      reg,
      state: { props: current.props, aspects: current.aspects },
      core: coreOf(current, id),
      today: args.today,
      timeZone: args.timeZone,
      relations: await relationFactsOf(tx, id, roles),
      owner: graphId,
      // Параметры видны и предусловию: та же область, что у подстановки шагов, — иначе
      // `{param}` в предусловии отвечал бы EXPR_SCOPE там, где чекер декларации его пропустил.
      params,
    });
    if (decl.precondition !== null && evalExpr(decl.precondition, scope) !== true) {
      // §Б6-4: «нарушено — честный отказ, не двойное исполнение». Форма отказа та же, что у CAS
      // исполнителя (`assertPrecondition`, `executor.ts`) — читатели уже умеют её разбирать.
      throw new ExecError('CONFLICT', `действие «${decl.key}»: предусловие не выполнено`, {
        reason: 'precondition_failed',
        action: decl.id,
        id,
      });
    }
    for (const [index, step] of decl.steps.entries()) {
      raw.push({
        index,
        tool: step.tool,
        input: substitute(step.input, scope) as Record<string, unknown>,
      });
    }
  }

  // Шаг может править НЕ цель (id шага — выражение, не обязательно `$self`): «было» у такого
  // шага снимается с ЕГО строки, а не со строки цели, — иначе CAS-пункт сверял бы чужое значение.
  const foreign = raw.filter(
    (op) =>
      op.tool === 'entity_update' && !(typeof op.input.id === 'string' && rows.has(op.input.id)),
  );
  for (const op of foreign) {
    if (typeof op.input.id !== 'string') {
      throw new ExecError(
        'VALIDATION',
        `действие «${decl.key}»: шаг ${op.index + 1} — id цели не вычислился в строку`,
        { reason: 'ACTION_STEP_INPUT', action: decl.id, step: op.index },
      );
    }
  }
  if (foreign.length > 0) {
    const more = await loadTargets(tx, graphId, foreign);
    if ('error' in more) refuse(more.error);
    for (const [id, row] of more.rows) rows.set(id, row);
  }

  const operations: ExecOperation[] = [];
  const cardRows: DeferredRow[] = [];
  for (const op of raw) {
    const built = buildStep(decl, loaded.reg, op, rows);
    operations.push(built.op);
    cardRows.push(...built.rows);
  }
  return {
    decl,
    targets,
    operations,
    hash: actionHash(decl),
    summary: actionSummary(decl, targets.length),
    rows: cardRows,
  };
}

/**
 * Сборка одной операции. `entity_update` — через `buildUpdate` (CAS-пункты по ТРОНУТЫМ
 * свойствам, §А7-3, снимок `loadTargets` — тот, по которому пункты и снимаются); остальные
 * тулы шага — сырой конверт: у создания и рёбер предусловий нет (докблок `buildUpdate`).
 */
function buildStep(
  decl: ActionDefinition,
  reg: RegistrySnapshot,
  op: { index: number; tool: string; input: Record<string, unknown> },
  rows: ReadonlyMap<string, TargetRow>,
): { op: ExecOperation; rows: DeferredRow[] } {
  if (op.tool !== 'entity_update') return { op: { tool: op.tool, input: op.input }, rows: [] };
  const current = rows.get(op.input.id as string);
  if (current === undefined) {
    throw new ExecError('NOT_FOUND', 'цель шага действия не найдена', {
      action: decl.id,
      step: op.index,
      id: op.input.id,
    });
  }
  const built = buildUpdate(reg, op.index, op.input, current);
  if ('error' in built) {
    throw new ExecError('VALIDATION', `действие «${decl.key}»: шаг ${op.index + 1} не собран`, {
      reason: 'ACTION_STEP_INPUT',
      action: decl.id,
      step: op.index,
      cause: built.error.status === 'error' ? built.error.error : undefined,
    });
  }
  const props = (built.op.input.props as Record<string, unknown> | undefined) ?? {};
  const unset = (built.op.input.unset as string[] | undefined) ?? [];
  const cardRows: DeferredRow[] = [
    ...Object.entries(props).map(([field, after]) => ({
      field,
      ...(current.props[field] !== undefined && { before: cardValue(current.props[field]) }),
      after: cardValue(after),
    })),
    ...unset.map((field) => ({
      field,
      ...(current.props[field] !== undefined && { before: cardValue(current.props[field]) }),
      after: '—',
    })),
  ];
  return { op: built.op, rows: cardRows };
}

/** Значение в строке карточки: строка как есть, прочее — JSON (карточка — текст, не данные). */
function cardValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Подстановка: обход шаблона, замена каждой обёртки `{$expr}` значением (Р-И-24). `{ctx:'$self'}`
 * и `{param}` вычисляет интерпретатор по области цели — она уже несёт и `self`, и параметры.
 */
function substitute(value: unknown, scope: ExprEvalScope): unknown {
  if (Array.isArray(value)) return value.map((v) => substitute(v, scope));
  if (typeof value !== 'object' || value === null) return value;
  const obj = value as Record<string, unknown>;
  if (Object.hasOwn(obj, '$expr')) return evalExpr(obj.$expr as ExprNode, scope);
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, substitute(v, scope)]));
}

/** Core-часть области вычисления: `TargetRow` расширена тремя колонками (Р-К-30). */
function coreOf(row: TargetRow, id: string): EntityScopeInput['core'] {
  return {
    id,
    title: row.title,
    archived: row.archived,
    createdAt: row.createdAt,
    // Действие НИЧЕГО не штампует: `updatedAt` здесь — тот, что лежит в строке СЕЙЧАС. Момент
    // записи штампует исполнитель (`monotonicUpdatedAt`), и подставлять сюда «будущее» значило
    // бы дать предусловию читать время, которого ещё нет.
    updatedAt: row.updatedAt,
  };
}

/**
 * Роли, которые читает `precondition`: их рёбра предзагружаются ДО вычисления (интерпретатор
 * синхронен — Р-И-4). Обход дерева, а не `relationRolesUsed` правил (`rules/scope.ts`): та
 * принимает список ПРАВИЛ, а здесь одно выражение.
 */
function relationRolesOf(node: ExprNode | null): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    const hr = o.has_relation as { role?: unknown } | undefined;
    if (hr !== undefined && typeof hr.role === 'string') out.add(hr.role);
    for (const x of Object.values(o)) walk(x);
  };
  walk(node);
  return out;
}

/**
 * МНОЖЕСТВО ЦЕЛЕЙ map-действия. Компилятор запросов — ТОТ ЖЕ, что у `entity_query` и у
 * `ref.target` (`compileWhere`, `query/compile-ast.ts`): второй способ прочитать Q отвечал бы на
 * `class=` и умолчание архивности иначе, чем сам язык.
 *
 * `ORDER BY e.id` — порядок ОПРЕДЕЛЁН, а не «как вернула база»: операции уезжают в одну строку
 * журнала и в её inverse, а golden §С8-27 (задача 9) сверяет их списком.
 *
 * Кап — ОТКАЗ, не усечение (§Б6-3): усечённая пачка молча сделала бы не то, что просили, и
 * повторный вызов доделал бы остаток — то есть «отложить просроченные» стало бы операцией без
 * числа исполнений.
 *
 * `self` у пакетного действия — отказ, а не молчаливое «не заметили»: модель, приславшая `self`,
 * думает, что правит ОДНУ запись, а исполнилась бы правка всех целей запроса.
 */
async function queryTargets(
  tx: Tx,
  reg: RegistrySnapshot,
  graphId: GraphId,
  decl: ActionDefinition,
  self: string | undefined,
  args: { today: string; timeZone: string },
): Promise<string[]> {
  if (self !== undefined) {
    throw new ExecError(
      'VALIDATION',
      `действие «${decl.key}» пакетное: цели даёт его собственный запрос — self не принимается`,
      { reason: 'ACTION_PARAMS', action: decl.id, param: 'self' },
    );
  }
  if (decl.over === null) return [];
  const cctx: CompileCtx = {
    graphId,
    today: args.today,
    timeZone: args.timeZone,
    reg,
    thisEntityId: null,
  };
  const found = await tx.execute(
    sql`SELECT e.id FROM entities e WHERE ${compileWhere(decl.over, cctx)} ORDER BY e.id`,
  );
  const ids = [...found].map((r) => (r as { id: string }).id);
  const cap = decl.batch_cap ?? BATCH_CAP_DEFAULT;
  if (ids.length > cap) {
    throw new ExecError(
      'VALIDATION',
      `действие «${decl.key}»: целей ${ids.length}, кап ${cap} — пачка не усекается (§Б6-3)`,
      { reason: 'BATCH_CAP_EXCEEDED', action: decl.id, cap, found: ids.length },
    );
  }
  return ids;
}

/**
 * Параметры вызова против объявленных (§Б6-1). Недостающий обязательный, лишний и значение не
 * того рода — один `reason` на три случая (`ACTION_PARAMS`) с НАЗВАННЫМ именем в `details`:
 * модели нужно имя поля, а не три разных кода.
 */
function checkedParams(
  decl: ActionDefinition,
  given: Record<string, unknown>,
): Record<string, ExprScalar> {
  const declared = new Map(decl.params.map((p) => [p.name, p]));
  for (const name of Object.keys(given)) {
    if (!declared.has(name)) {
      throw new ExecError(
        'VALIDATION',
        `действие «${decl.key}»: параметра «${name}» нет в декларации`,
        { reason: 'ACTION_PARAMS', action: decl.id, param: name },
      );
    }
  }
  const out: Record<string, ExprScalar> = {};
  for (const [name, p] of declared) {
    const value = given[name];
    if (value === undefined) {
      if (p.required) {
        throw new ExecError('VALIDATION', `действие «${decl.key}»: не задан параметр «${name}»`, {
          reason: 'ACTION_PARAMS',
          action: decl.id,
          param: name,
        });
      }
      continue;
    }
    // Род значения сверяется ТЕМ ЖЕ ajv, что и литерал предиката запроса
    // (`literalFormViolation`, `registry/validate-props.ts`): второй инстанс ajv рядом означал бы
    // второй набор правил strict-режима — то есть значение, годное для записи, могло бы не пройти
    // здесь. Параметр-контракт — ссылка на сущность-реализацию (§Б6-1), то есть uuid; членство в
    // контракте проверят шаги на записи.
    const violation =
      'kind' in p.type
        ? literalFormViolation(paramLiteralType(p.type.kind), value)
        : z.string().uuid().safeParse(value).success
          ? undefined
          : 'ожидается uuid сущности';
    if (violation !== undefined) {
      throw new ExecError(
        'VALIDATION',
        `действие «${decl.key}»: параметр «${name}» — ${violation}`,
        { reason: 'ACTION_PARAMS', action: decl.id, param: name },
      );
    }
    out[name] = value as ExprScalar;
  }
  return out;
}

/** У одиночного действия цель приходит вызовом: множества у него нет по построению (§Б6-3). */
function requireSelf(decl: ActionDefinition, self: string | undefined): string {
  if (self !== undefined) return self;
  throw new ExecError('VALIDATION', `действие «${decl.key}» применяется к записи — нужен self`, {
    reason: 'ACTION_SELF_REQUIRED',
    action: decl.id,
  });
}

/**
 * Отказ `loadTargets` — ТЕМ ЖЕ кодом и текстом (цель не найдена под RLS либо запрещена по объекту),
 * а не подменённым «не найдено»: причина отказа модели нужна настоящая.
 */
function refuse(out: ToolDispatchResult): never {
  if (out.status !== 'error') throw new Error('loadTargets: отказ без ошибки');
  throw new ExecError(
    out.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION',
    out.error.message,
    out.error.details,
  );
}

function entitiesNoun(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'записей';
  const mod10 = n % 10;
  if (mod10 === 1) return 'запись';
  if (mod10 >= 2 && mod10 <= 4) return 'записи';
  return 'записей';
}
