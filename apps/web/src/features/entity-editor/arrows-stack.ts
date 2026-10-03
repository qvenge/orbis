import {
  clearTitleHistories,
  closeTitleGroup,
  resetTitleHistory,
  TITLE_DEPTH,
} from './title-history';
export type StepOwner = 'title' | 'body';
export interface StepOwnerHandlers {
  undo(): boolean;
  redo(): boolean;
  reset(): void;
  closeGroup?(): void;
  observe?(): void;
}
interface Steps {
  done: StepOwner[];
  undone: StepOwner[];
}
/** Здесь только порядок; документы остаются в истории ProseMirror, заголовки — в своих снимках. */
const steps = new Map<string, Steps>();
const owners = new Map<string, Partial<Record<StepOwner, StepOwnerHandlers>>>();
const listeners = new Set<() => void>();
const applying = new Set<string>();
let generation = 0;
export const stepsGeneration = (): number => generation;
const emit = () => {
  for (const l of listeners) l();
};
const of = (id: string): Steps => {
  const s = steps.get(id) ?? { done: [], undone: [] };
  steps.set(id, s);
  return s;
};
/** Уборка старого поля не отвязывает владельца, уже заменённого новым монтированием. */
export function bindStepOwner(
  id: string,
  owner: StepOwner,
  h: StepOwnerHandlers | null,
): () => void {
  const o = owners.get(id) ?? {};
  if (h === null) delete o[owner];
  else o[owner] = h;
  owners.set(id, o);
  return () => {
    if (owners.get(id)?.[owner] === h) delete o[owner];
  };
}
/** Только для уже отвергнутой наблюдавшейся основы без более нового своего намерения. */
export function observeFailedTitleBasis(id: string): void {
  const o = owners.get(id);
  if (o?.title?.observe) o.title.observe();
  else if (o?.body) resetSteps(id);
}
export function pushStep(id: string, owner: StepOwner): void {
  const s = of(id);
  if (owner === 'title') owners.get(id)?.body?.closeGroup?.();
  s.done.push(owner);
  if (owner === 'title' && s.done.filter((o) => o === 'title').length > TITLE_DEPTH)
    s.done.splice(s.done.indexOf('title'), 1);
  s.undone = [];
  emit();
}
/** Новая буква в уже открытой группе также отменяет право на повтор другого поля. */
export function discardRedo(id: string): void {
  const s = steps.get(id);
  if (s?.undone.length) {
    s.undone = [];
    emit();
  }
}
function move(id: string, from: 'done' | 'undone'): boolean {
  const s = steps.get(id),
    top = s?.[from].at(-1),
    h = top === undefined ? undefined : owners.get(id)?.[top];
  if (s === undefined || top === undefined || h === undefined || applying.has(id)) return false;
  applying.add(id);
  let ok = false;
  try {
    ok = from === 'done' ? h.undo() : h.redo();
  } finally {
    applying.delete(id);
  }
  if (!ok || steps.get(id) !== s) return false;
  s[from].pop();
  s[from === 'done' ? 'undone' : 'done'].push(top);
  emit();
  return true;
}
export const undoStep = (id: string): boolean => move(id, 'done');
export const redoStep = (id: string): boolean => move(id, 'undone');
export function syncBodyDepth(id: string, depth: number, historyEdit = false): void {
  if (applying.has(id)) return;
  const s = of(id),
    count = s.done.filter((o) => o === 'body').length;
  if (depth > count) {
    closeTitleGroup(id);
    for (let i = count; i < depth; i++) s.done.push('body');
    s.undone = [];
  } else if (depth < count) {
    let drop = count - depth + Number(historyEdit);
    s.done = s.done.filter((o) => !(o === 'body' && drop-- > 0));
    if (historyEdit) {
      closeTitleGroup(id);
      s.done.push('body');
      s.undone = [];
    }
  } else return;
  emit();
}
export function resetSteps(id: string): void {
  steps.delete(id);
  resetTitleHistory(id);
  const o = owners.get(id);
  o?.body?.reset();
  o?.title?.reset();
  emit();
}
export function clearAllSteps(): void {
  generation++;
  steps.clear();
  owners.clear();
  clearTitleHistories();
  emit();
}
export const canUndoStep = (id: string): boolean => (steps.get(id)?.done.length ?? 0) > 0;
export const canRedoStep = (id: string): boolean => (steps.get(id)?.undone.length ?? 0) > 0;
export function subscribeSteps(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
