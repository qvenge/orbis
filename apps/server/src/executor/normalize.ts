// apps/server/src/executor/normalize.ts
// Доменные нормализации стадии 4 (§2.1, §3.2, §3.3, §4.1, §9.2).
import { ExecError } from './errors';

export type AspectData = Record<string, unknown>;
export type AspectsMap = Record<string, AspectData>;

/** Теги нормализуются в нижний регистр и дедуплицируются (порядок первого вхождения). */
export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.toLowerCase()))];
}

/** Инлайн-ссылки body: [[entity:uuid]] и [[entity:uuid|текст]] (§2.1). */
export const BODY_REFS_RE = /\[\[entity:([0-9a-f-]{36})(?:\|[^\]]*)?\]\]/gi;

/** body_refs извлекаются при каждом create/update, затрагивающем body; lowercase + dedupe. */
export function extractBodyRefs(body: string): string[] {
  const refs = new Set<string>();
  for (const m of body.matchAll(BODY_REFS_RE)) {
    const id = m[1];
    if (id) refs.add(id.toLowerCase());
  }
  return [...refs];
}

/**
 * Merge аспектов entity_update — семантика §9.2 ДОСЛОВНО: «aspects мержится по aspect-id,
 * а внутри аспекта — по полям (shallow merge: переданы только {status, completed_at} →
 * остальные поля аспекта сохраняются; поле со значением null удаляется); значение null
 * вместо объекта аспекта снимает аспект целиком (detach), остальные данные сущности
 * не затрагиваются». Результат merge валидируется ajv (стадия 2), не патч.
 */
export function mergeAspects(
  current: AspectsMap,
  patch: Record<string, Record<string, unknown> | null>,
): { merged: AspectsMap; touched: string[] } {
  const merged: AspectsMap = { ...current };
  const touched = Object.keys(patch);
  for (const [aspectId, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[aspectId]; // detach аспекта целиком
      continue;
    }
    const next: AspectData = { ...(current[aspectId] ?? {}), ...value };
    for (const [field, fieldValue] of Object.entries(next)) {
      if (fieldValue === null) delete next[field]; // поле со значением null удаляется
    }
    merged[aspectId] = next;
  }
  return { merged, touched };
}

/**
 * Переходы status ↔ completed_at (§3.2): переход в done без переданного completed_at →
 * проставить clock(); уход из done → очистить completed_at. Мутирует next.
 */
export function applyTaskCompletion(
  prev: AspectData | undefined,
  next: AspectData,
  now: Date,
): void {
  const prevStatus = prev?.status;
  if (next.status === 'done' && prevStatus !== 'done' && next.completed_at === undefined) {
    next.completed_at = now.toISOString();
  }
  if (prevStatus === 'done' && next.status !== 'done') {
    delete next.completed_at;
  }
}

/**
 * Financial-инвариант §3.3 над ФИНАЛЬНЫМ состоянием аспектов сущности:
 * - recurring=true валиден только при orbis/schedule.recurrence на той же сущности
 *   (ветка derived_from появится с relations в Task 10);
 * - не-шаблон (recurring falsy) обязан иметь occurred_on.
 */
export function assertFinancialInvariant(aspects: AspectsMap): void {
  const fin = aspects['orbis/financial'];
  if (!fin) return;
  if (fin.recurring === true) {
    const schedule = aspects['orbis/schedule'];
    const recurrence =
      schedule && typeof schedule.recurrence === 'object' && schedule.recurrence !== null
        ? schedule.recurrence
        : undefined;
    if (!recurrence) {
      throw new ExecError(
        'INVARIANT',
        'orbis/financial.recurring=true валиден только на шаблоне с orbis/schedule.recurrence (§3.3)',
        { invariant: 'financial_recurring_requires_recurrence' },
      );
    }
  } else if (fin.occurred_on === undefined) {
    throw new ExecError(
      'INVARIANT',
      'orbis/financial без recurring обязан иметь occurred_on (§3.3)',
      { invariant: 'financial_requires_occurred_on' },
    );
  }
}
