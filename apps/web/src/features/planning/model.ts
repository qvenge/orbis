import type { QueryAst, QueryFilterNode } from '@orbis/shared/query';

export const PLANNED_DATE = 'orbis/planned_date';
export const PLAN_ORDER = 'orbis/plan_order';
export const INBOX_STATE = 'orbis/inbox_state';
export const TASK_STATUS = 'orbis/task_status';

export interface PlanningRecord {
  id: string;
  title: string;
  body?: string;
  props: Record<string, unknown>;
  aspects: string[];
  tags: string[];
  archived: boolean;
  createdAt: string;
}

export function planningDayOffset(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function isClosed(record: PlanningRecord): boolean {
  return ['done', 'cancelled'].includes(String(record.props[TASK_STATUS]));
}

export function sortPlannedTasks<T extends PlanningRecord>(rows: readonly T[]): T[] {
  const rank = (r: T) =>
    typeof r.props[PLAN_ORDER] === 'number'
      ? (r.props[PLAN_ORDER] as number)
      : Number.MAX_SAFE_INTEGER;
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/** Promote only an unclassified task; the server checks this expectation atomically. */
export function taskPromotionPatch(record: PlanningRecord) {
  const status = record.props[TASK_STATUS];
  return status === undefined || status === 'inbox'
    ? {
        props: { [TASK_STATUS]: 'planned' },
        expectedTaskStatus: status === 'inbox' ? ('inbox' as const) : null,
      }
    : { props: {} };
}

/** A merge patch only: neither scheduling nor triage rewrites content or links. */
export function planTaskPatch(record: PlanningRecord, day: string, rank: number) {
  const props: Record<string, unknown> = {
    [PLANNED_DATE]: day,
    [PLAN_ORDER]: rank,
    [INBOX_STATE]: 'processed',
  };
  const promotion = taskPromotionPatch(record);
  Object.assign(props, promotion.props);
  return {
    id: record.id,
    ...promotion,
    props,
    ...(!record.aspects.includes('orbis/task') && { aspects: { attach: ['orbis/task'] } }),
  };
}

export function classifyInbox(record: PlanningRecord): 'pending' | 'later' | null {
  if (record.archived || isClosed(record)) return null;
  const state = record.props[INBOX_STATE];
  if (state === 'processed') return null;
  if (state === 'later') return 'later';
  if (state === 'pending') return 'pending';
  if (record.tags.includes('gtd-someday')) return 'later';
  if (record.tags.includes('gtd-reference')) return null;
  return record.props[TASK_STATUS] === 'inbox' || record.aspects.length === 0 ? 'pending' : null;
}

const eq = (prop: string, value: string): QueryFilterNode => ({ prop, op: 'eq', value });
const noState: QueryFilterNode = { not: { has: INBOX_STATE } };
const active: QueryFilterNode = {
  not: { prop: TASK_STATUS, op: 'in', value: ['done', 'cancelled'] },
};

export function inboxQuery(
  aspectIds: string[],
  state: 'pending' | 'later',
  limit: number,
): QueryAst {
  const legacy: QueryFilterNode =
    state === 'later'
      ? { tag: 'gtd-someday' }
      : {
          and: [
            { not: { tag: 'gtd-someday' } },
            { not: { tag: 'gtd-reference' } },
            {
              or: [
                eq(TASK_STATUS, 'inbox'),
                { and: aspectIds.map((aspect) => ({ not: { aspect } })) },
              ],
            },
          ],
        };
  return {
    filter: { and: [active, { or: [eq(INBOX_STATE, state), { and: [noState, legacy] }] }] },
    sortBy: [{ field: 'orbis/created_at', dir: 'desc' }],
    limit,
  };
}

export function dayQuery(day: string, limit: number): QueryAst {
  return {
    filter: { and: [{ aspect: 'orbis/task' }, eq(PLANNED_DATE, day)] },
    sortBy: [
      { field: PLAN_ORDER, dir: 'asc' },
      { field: 'orbis/created_at', dir: 'asc' },
    ],
    limit,
  };
}

export function availableTasksQuery(limit: number): QueryAst {
  return {
    filter: { and: [{ aspect: 'orbis/task' }, active] },
    sortBy: [{ field: 'orbis/updated_at', dir: 'desc' }],
    limit,
  };
}
