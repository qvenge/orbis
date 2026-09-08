// Движок подписки Agenda (§Б5-6, §А5-5). Дом движков подписок — `subscriptions/` (Р-И-17).
//
// ОДИН SELECT с OR-деревом: обе секции считаются одной выборкой, тег приезжает колонкой.
// Тега ДВА булевых, а не один `CASE … ELSE`: сущность попадает в обе секции сразу (срок
// вчера, начало завтра), и единственный тег молча съедал бы одно из двух вхождений, которые
// сегодня дают три запроса клиента.
//
// Окно берётся ИЗ ДЕКЛАРАЦИИ (`window`/`params`), не из предикатов (Р-К-12): по нему же
// роутер расширяет материализацию — условие по дате внутри предиката окну невидимо.
import {
  type AgendaListResult,
  type AgendaRow,
  type AgendaSubscription,
  addDays,
  type BindingIndex,
  bindingIndexOf,
} from '@orbis/shared';
import type { ExprNode } from '@orbis/shared/expr';
import { type SQL, sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import type { WireEntity } from '../executor/types';
import { compileClassMembership, compileExprPredicate } from '../expr/compile';
import {
  type CompileCtx,
  compileWhere,
  ENTITY_SELECT_COLUMNS,
  propertyLocalDateExpr,
} from '../query/compile-ast';
import { queryContext } from '../query/context';
import { wallClockIn } from '../recurring/materialize';
import type { RegistrySnapshot } from '../registry/load';
import { toWireEntityFromSql } from '../wire';
import { resolveSlotOnEntity } from './registry';

export const AGENDA_SUBSCRIPTION_ID = 'orbis/agenda';
/** Строка entities в подзапросе — алиас `e`, тот же, что у `compileQueryAst`. */
const ROW: SQL = sql.raw('e');

/**
 * Декларация Agenda из снимка реестра. Читатель строки снимка здесь пока один, поэтому и хелпер
 * узкий; задача 9 заводит общий `builtinSubscription(reg, id)` (`subscriptions/registry.ts`) и
 * обобщает ЭТУ функцию до обёртки над ним (M12) — имя, сигнатура и оба отказа ниже остаются, так
 * что ни движок, ни роутер при этом не правятся.
 */
export function agendaSubscriptionOf(reg: RegistrySnapshot): AgendaSubscription {
  const row = reg.subscriptions.get(AGENDA_SUBSCRIPTION_ID);
  // Отказ, а не пустая повестка: незасеянный реестр обязан быть виден как поломка сида.
  if (row === undefined)
    throw new ExecError(
      'NOT_FOUND',
      `подписка '${AGENDA_SUBSCRIPTION_ID}' не засеяна — пересейте реестры`,
      { subscription: AGENDA_SUBSCRIPTION_ID },
    );
  if (row.definition.engine !== 'agenda')
    throw new ExecError(
      'VALIDATION',
      `подписка '${AGENDA_SUBSCRIPTION_ID}' объявлена движком '${row.definition.engine}'`,
      { reason: 'SUBSCRIPTION_ENGINE', subscription: AGENDA_SUBSCRIPTION_ID },
    );
  return row.definition;
}

/** Привязка контракта, реализующая ИМЕННО этот слот: аспект + свойство под ним. */
interface SlotBinding {
  aspectId: string;
  propertyId: string;
}

function slotBindings(reg: RegistrySnapshot, contract: string, slot: string): SlotBinding[] {
  const idx = bindingIndexOf({ aspects: reg.aspects, contracts: reg.contracts });
  const out: SlotBinding[] = [];
  for (const b of idx.byContract(contract)) {
    const propertyId = b.bind[slot];
    // Привязка без этого слота (§Б2-3 — частичная привязка законна) просто не участвует.
    if (propertyId === undefined || !reg.properties.has(propertyId)) continue;
    out.push({ aspectId: b.aspectId, propertyId });
  }
  // Порядок детерминирован: он уезжает в план и в golden-снимки поверхностей (§С8-20).
  return out.sort((a, b) => (a.aspectId < b.aspectId ? -1 : a.aspectId > b.aspectId ? 1 : 0));
}

/** `aspects @> ARRAY['<id>']` — форма Q-узла `{aspect}` (`compile-ast.ts`). */
const hasAspect = (aspectId: string): SQL => sql`aspects @> ARRAY[${aspectId}]::text[]`;
/** Тотальные «нет» и «да» — формула `negated` компилятора. */
const not = (c: SQL): SQL => sql`NOT COALESCE(${c}, false)`;
const total = (c: SQL): SQL => sql`COALESCE(${c}, false)`;
/** Пустой список привязок — предикат, ложный для всех: секция честно пуста, а не «вся таблица». */
const anyOf = (parts: SQL[]): SQL =>
  parts.length === 0 ? sql`false` : sql`(${sql.join(parts, sql` OR `)})`;

/**
 * Значение E-узла-границы окна. Полный интерпретатор E (`expr/eval.ts`) приходит задачей 8;
 * границы окна Agenda — ровно две формы канона: `{param}` (подставляет движок, §Б5-4 ревизии 3)
 * и `{ctx:'$today'}`. Любая другая форма — ГРОМКИЙ отказ: молча подставленная дата дала бы
 * повестку не того горизонта.
 */
function dateOfNode(
  node: ExprNode,
  params: Readonly<Record<string, string>>,
  today: string,
): string {
  if ('param' in node && params[node.param] !== undefined) return params[node.param] as string;
  if ('ctx' in node && node.ctx === '$today') return today;
  throw new ExecError('VALIDATION', 'граница окна подписки Agenda не вычислима этим движком', {
    reason: 'EXPR_BACKEND_UNSUPPORTED',
    node,
  });
}

/** Момент слота как timestamptz: у date-свойства — локальная полночь (§Б1-2 any_of). */
function slotInstant(b: SlotBinding, cctx: CompileCtx): SQL {
  return cctx.reg.properties.get(b.propertyId)?.type.kind === 'date'
    ? sql`(((props->>${b.propertyId})::date + time '00:00') AT TIME ZONE ${cctx.timeZone})`
    : sql`(props->>${b.propertyId})::timestamptz`;
}

export async function agendaListOf(
  tx: Tx,
  ownerId: string,
  def: AgendaSubscription,
  args: { today: string; timeZone: string; days: number },
): Promise<AgendaListResult> {
  // Контекст компиляции — отсюда, «сегодня»/таймзона — из args: материализация роутера уже
  // посчитала их, и пересчёт на границе суток разъехался бы с её окном.
  const base = await queryContext(tx, ownerId, null);
  const cctx: CompileCtx = { ...base, today: args.today, timeZone: args.timeZone };
  const params = { window_from: args.today, window_to: addDays(args.today, args.days - 1) };
  const from = dateOfNode(def.show.window.from, params, args.today);
  const to = dateOfNode(def.show.window.to, params, args.today);
  const before = dateOfNode(def.overdue.before, params, args.today);

  const moments = slotBindings(cctx.reg, def.show.contract, def.show.slot);
  const deadlines = slotBindings(cctx.reg, def.overdue.contract, def.overdue.slots[0]);
  const notTemplate = not(compileClassMembership(def.hide.contract, def.hide.set, cctx, ROW));
  const openClass = total(compileExprPredicate(def.overdue.where, { cctx, row: ROW }));
  const dateOf = (b: SlotBinding) => propertyLocalDateExpr(b.propertyId, cctx);

  const inWindow = total(
    sql`${anyOf(
      moments.map(
        (b) =>
          sql`(${hasAspect(b.aspectId)} AND ${dateOf(b)} BETWEEN ${from}::date AND ${to}::date)`,
      ),
    )} AND ${notTemplate}`,
  );
  const inOverdue = total(
    sql`${anyOf(
      [...deadlines, ...moments].map(
        (b) => sql`(${hasAspect(b.aspectId)} AND ${dateOf(b)} < ${before}::date)`,
      ),
    )} AND ${notTemplate} AND ${openClass}`,
  );
  // LEAST игнорирует NULL — просроченное сортируется по более ранней из двух дат ровно так,
  // как склеивал клиент (`useAgenda.ts:207-218`).
  const winSort = sql`LEAST(${sql.join(
    moments.map((b) => slotInstant(b, cctx)),
    sql`, `,
  )})`;
  const ovSort = sql`LEAST(${sql.join([...deadlines, ...moments].map(dateOf), sql`, `)})`;
  const wCap = def.show.limit + 1;
  const oCap = def.overdue.limit + 1;
  const cols = sql.raw(ENTITY_SELECT_COLUMNS);

  const rows = (await tx.execute(sql`
    SELECT ${cols}, in_window, in_overdue, rn_window, rn_overdue FROM (
      SELECT ${cols}, ${inWindow} AS in_window, ${inOverdue} AS in_overdue,
        ROW_NUMBER() OVER (PARTITION BY ${inWindow} ORDER BY ${winSort} ASC NULLS LAST, id) AS rn_window,
        ROW_NUMBER() OVER (PARTITION BY ${inOverdue} ORDER BY ${ovSort} ASC NULLS LAST, id) AS rn_overdue
      FROM entities e
      WHERE ${compileWhere({ filter: null }, cctx)} AND (${inWindow} OR ${inOverdue})
    ) t
    WHERE (in_window AND rn_window <= ${wCap}) OR (in_overdue AND rn_overdue <= ${oCap})
    ORDER BY in_window DESC, rn_window, rn_overdue, id`)) as unknown as Record<string, unknown>[];

  const out: AgendaRow[] = [];
  const truncated = { window: false, overdue: false };
  for (const r of rows) {
    const entity = toWireEntityFromSql(r);
    // Строка-сторож (rn = limit+1) в выдачу не едет — она и есть доказательство усечения.
    if (r.in_window === true) {
      if (Number(r.rn_window) === wCap) truncated.window = true;
      else out.push(rowOf(entity, 'window', cctx, def));
    }
    if (r.in_overdue === true) {
      if (Number(r.rn_overdue) === oCap) truncated.overdue = true;
      else out.push(rowOf(entity, 'overdue', cctx, def));
    }
  }
  return { today: args.today, timezone: args.timeZone, rows: out, truncated };
}

/** Локальный день значения: date — как есть, момент — стеночные часы владельца. */
const localDay = (v: string, tz: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : wallClockIn(new Date(v), tz).date;

function rowOf(
  entity: WireEntity,
  section: 'window' | 'overdue',
  cctx: CompileCtx,
  def: AgendaSubscription,
): AgendaRow {
  const idx = bindingIndexOf({ aspects: cctx.reg.aspects, contracts: cctx.reg.contracts });
  // Две привязки слота на сущности без `prefer` → SLOT_AMBIGUOUS (§С8-21) — отказ движка, а
  // не тихий выбор первой попавшейся.
  const pick = (contract: string, slot: string, prefer: readonly string[]) => {
    try {
      return resolveSlotOnEntity(idx, entity, contract, slot, prefer);
    } catch (e) {
      // Полная форма details §1.1 (`{subscription, contract, slot, entityId, aspects}`) собирается в точке
      // отказа: резолвер задачи 5 подписки не знает, движок — знает (M6, Р-К-36).
      if (e instanceof ExecError && e.code === 'SLOT_AMBIGUOUS')
        throw new ExecError(e.code, e.message, {
          ...((e.details as Record<string, unknown> | undefined) ?? {}),
          subscription: AGENDA_SUBSCRIPTION_ID,
        });
      throw e;
    }
  };
  if (section === 'window') {
    const moment = pick(def.show.contract, def.show.slot, def.show.prefer);
    return {
      entity,
      section,
      at: String(moment?.value ?? ''),
      slot: 'moment',
      allDay: isAllDay(entity, moment, idx, def.show.contract, cctx),
    };
  }
  const dl = pick(def.overdue.contract, def.overdue.slots[0], def.overdue.prefer);
  const mo = pick(def.overdue.contract, def.overdue.slots[1], def.overdue.prefer);
  const d = dl === null ? null : localDay(String(dl.value), cctx.timeZone);
  const m = mo === null ? null : localDay(String(mo.value), cctx.timeZone);
  // Минимум двух дат (§Б5-6); при равенстве выигрывает `deadline` — порядок слотов подписки.
  const byDeadline = d !== null && (m === null || d <= m);
  return {
    entity,
    section,
    at: (byDeadline ? d : m) as string,
    slot: byDeadline ? 'deadline' : 'moment',
    allDay: false,
  };
}

/**
 * «Весь день» — ОСТАТОК C: слота под него в §Б1-2 нет, контракт `orbis/when` его не описывает,
 * а без признака ломаются «весь день» и порядок all_day-первыми (§4.1). Признака два:
 * date-свойство в слоте `moment` (день по типу) и сырое `orbis/all_day` ядра Планировщика —
 * единственное сырое чтение движка, названное вслух.
 */
function isAllDay(
  entity: WireEntity,
  moment: { aspectId: string } | null,
  idx: BindingIndex,
  contract: string,
  cctx: CompileCtx,
): boolean {
  if (entity.props['orbis/all_day'] === true) return true;
  const bound = moment === null ? undefined : idx.slotOf(moment.aspectId, contract, 'moment');
  const propertyId = bound !== undefined && 'prop' in bound ? bound.prop : undefined;
  return propertyId !== undefined && cctx.reg.properties.get(propertyId)?.type.kind === 'date';
}
