/** Снимки поля браузера недоступны программно: заголовок держит свою историю во вкладке. */
export const TITLE_GROUP_DELAY_MS = 500;
export const TITLE_DEPTH = 100;
interface History {
  done: string[];
  undone: string[];
  open: boolean;
  at: number;
  word: boolean;
  kind: boolean;
}
const histories = new Map<string, History>();
export function recordTitleChange(
  id: string,
  prev: string,
  next: string,
  now = Date.now(),
): boolean {
  if (prev === next) return false;
  const h = histories.get(id) ?? {
    done: [],
    undone: [],
    open: false,
    at: 0,
    word: false,
    kind: true,
  };
  histories.set(id, h);
  const kind = next.length >= prev.length;
  const fresh = !h.open || now - h.at >= TITLE_GROUP_DELAY_MS || h.word || kind !== h.kind;
  if (fresh) {
    h.done.push(prev);
    if (h.done.length > TITLE_DEPTH) h.done.shift();
  }
  h.undone = [];
  h.open = true;
  h.at = now;
  h.kind = kind;
  h.word = kind && /\s$/.test(next);
  return fresh;
}
function move(id: string, current: string, from: 'done' | 'undone'): string | null {
  const h = histories.get(id),
    v = h?.[from].pop();
  if (h === undefined || v === undefined) return null;
  h[from === 'done' ? 'undone' : 'done'].push(current);
  h.open = false;
  return v;
}
export const undoTitle = (id: string, current: string): string | null => move(id, current, 'done');
export const redoTitle = (id: string, current: string): string | null =>
  move(id, current, 'undone');
export const resetTitleHistory = (id: string): void => {
  histories.delete(id);
};
export const clearTitleHistories = (): void => histories.clear();

export function closeTitleGroup(id: string): void {
  const h = histories.get(id);
  if (h) h.open = false;
}
