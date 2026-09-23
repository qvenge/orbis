// apps/server/src/actions/precondition.ts
// ПРЕДУСЛОВИЕ ДЕЙСТВИЯ (§Б6-4) — ОДИН дом вычисления на два момента: резолв вызова
// (`actions/resolve.ts`) и «Принять» отложенной единицы (`policy/pending.ts`, эррата Ф-Б2-18).
//
// ЗАЧЕМ ВТОРОЙ МОМЕНТ. CAS исполнителя держит только свойства, которые шаги ТРОГАЮТ
// (`buildUpdate`, `routines/propose.ts`), а предусловие вправе читать и нетронутое — колонку
// `orbis/archived` у `plan-to-fact`, рёбра (`has_relation`), «сегодня». Единица, поставленная в
// пятницу, в понедельник исполнилась бы поверх записи, у которой предусловие уже ложно: CAS
// этого не видит по построению. Поэтому на «Принять» предусловие считается ЗАНОВО — тем же
// кодом, что и при резолве, иначе два момента отвечали бы на один вопрос по-разному.
//
// ОТДЕЛЬНЫЙ ДОМ, А НЕ ФУНКЦИЯ В `resolve.ts`, — ради графа импортов: `resolve.ts` тянет
// `routines/propose.ts`, а тот — `policy/pending.ts`; импорт резолва из `pending.ts` замкнул бы
// цикл по значению. Здесь нет ни предложений, ни pending — только чтение целей, область
// вычисления и интерпретатор. Тип строки цели (`TargetRow`) остаётся у `loadTargets` и берётся
// отсюда импортом ТИПА — рантайм-дуги он не создаёт.
import type { ActionDefinition, GraphId } from '@orbis/shared';
import type { ExprNode, ExprScalar } from '@orbis/shared/expr';
import { inArray } from 'drizzle-orm';
import { entities } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import { type ExprEvalScope, evalExpr } from '../expr/eval';
import { ownerTimeZone, todayInTimeZone } from '../query/context';
import type { RegistrySnapshot } from '../registry/load';
import type { TargetRow } from '../routines/propose';
import { type EntityScopeInput, entityEvalScope, relationFactsOf } from '../rules/scope';

/** «Сегодня» и зона владельца — то, чем резолв читает date-токены Q и предусловия. */
export interface ActionDateArgs {
  today: string;
  timeZone: string;
}

/**
 * Даты резолва по часам ВЫЗОВА. Одна функция на три места (исполнение `runAction`, снимок
 * отложенной единицы, «Принять»): два резолва одного вызова, считающие «сегодня» по разным
 * часам, дали бы карточке одно множество целей, а уровню — другое.
 */
export async function actionDateArgs(
  tx: Tx,
  graphId: GraphId,
  clock?: () => Date,
): Promise<ActionDateArgs> {
  const timeZone = await ownerTimeZone(tx, graphId);
  return { today: todayInTimeZone(timeZone, clock?.() ?? new Date()), timeZone };
}

/**
 * Строки целей под RLS — ЕДИНСТВЕННОЕ чтение «цели действия и предложения» в сервере:
 * `loadTargets` (`routines/propose.ts`) читает через него и добавляет свои проверки (запрет по
 * объекту, NOT_FOUND с индексом операции). Второе чтение с другим набором колонок разошлось бы
 * с первым молча — ровно то, от чего предостерегает докблок `TargetRow`.
 */
export async function readTargetRows(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, TargetRow>> {
  const rows = new Map<string, TargetRow>();
  if (ids.length === 0) return rows;
  const found = await tx
    .select({
      id: entities.id,
      props: entities.props,
      aspects: entities.aspects,
      updatedAt: entities.updatedAt,
      title: entities.title,
      archived: entities.archived,
      createdAt: entities.createdAt,
    })
    .from(entities)
    .where(inArray(entities.id, [...ids]));
  for (const row of found) {
    rows.set(row.id, {
      props: row.props as Record<string, unknown>,
      aspects: row.aspects,
      updatedAt: row.updatedAt,
      title: row.title,
      archived: row.archived,
      createdAt: row.createdAt,
    });
  }
  return rows;
}

/**
 * Роли, которые читает `precondition`: их рёбра предзагружаются ДО вычисления (интерпретатор
 * синхронен — Р-И-4). Обход дерева, а не `relationRolesUsed` правил (`rules/scope.ts`): та
 * принимает список ПРАВИЛ, а здесь одно выражение.
 */
export function relationRolesOf(node: ExprNode | null): Set<string> {
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
 * Область вычисления ОДНОЙ цели (§Б6-3 «$self — сущность, к которой применяется действие»).
 * Параметры видны и предусловию: та же область, что у подстановки шагов, — иначе `{param}` в
 * предусловии отвечал бы EXPR_SCOPE там, где чекер декларации его пропустил.
 */
export async function targetScope(
  tx: Tx,
  args: {
    reg: RegistrySnapshot;
    graphId: GraphId;
    id: string;
    row: TargetRow;
    roles: ReadonlySet<string>;
    params: Record<string, ExprScalar>;
    dates: ActionDateArgs;
  },
): Promise<ExprEvalScope> {
  return entityEvalScope({
    reg: args.reg,
    state: { props: args.row.props, aspects: args.row.aspects },
    core: coreOf(args.row, args.id),
    today: args.dates.today,
    timeZone: args.dates.timeZone,
    relations: await relationFactsOf(tx, args.id, args.roles),
    owner: args.graphId,
    params: args.params,
  });
}

/**
 * §Б6-4: «нарушено — честный отказ, не двойное исполнение». Форма отказа та же, что у CAS
 * исполнителя (`assertPrecondition`, `executor.ts`) — читатели уже умеют её разбирать: экран
 * пачки (`divergenceOf`, `routines/lifecycle.ts`) читает её как «устарело» и гасит единицу.
 */
export function assertPreconditionHolds(
  decl: ActionDefinition,
  scope: ExprEvalScope,
  id: string,
): void {
  if (decl.precondition !== null && evalExpr(decl.precondition, scope) !== true) {
    throw new ExecError('CONFLICT', `действие «${decl.key}»: предусловие не выполнено`, {
      reason: 'precondition_failed',
      action: decl.id,
      id,
    });
  }
}

/**
 * Предусловие на «Принять» (эррата Ф-Б2-18): по ЦЕЛЯМ, снятым при постановке, и с теми же
 * параметрами вызова — но по состоянию и «сегодня» момента одобрения. Цели не пересчитываются
 * запросом заново: владелец подтверждал ИМЕННО эти записи, и запись, выпавшая из Q (срок уже
 * перенесли), ловится CAS её тронутого свойства, а не молчаливой подменой набора.
 *
 * Цели, которой больше нет под RLS, — NOT_FOUND: исполнять правку того, чего нет, нечем, и тот же
 * ответ дал бы исполнитель на её операции.
 */
export async function recheckPrecondition(
  tx: Tx,
  args: {
    reg: RegistrySnapshot;
    graphId: GraphId;
    decl: ActionDefinition;
    targets: readonly string[];
    params: Record<string, ExprScalar>;
    dates: ActionDateArgs;
  },
): Promise<void> {
  const { decl } = args;
  if (decl.precondition === null) return;
  const rows = await readTargetRows(tx, args.targets);
  const roles = relationRolesOf(decl.precondition);
  for (const id of args.targets) {
    const row = rows.get(id);
    if (row === undefined) {
      throw new ExecError('NOT_FOUND', 'цель действия не найдена', { action: decl.id, id });
    }
    const scope = await targetScope(tx, { ...args, id, row, roles });
    assertPreconditionHolds(decl, scope, id);
  }
}
