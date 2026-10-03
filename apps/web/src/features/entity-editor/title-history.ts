/** Снимки поля браузера недоступны программно: заголовок держит свою историю во вкладке. */
export const TITLE_GROUP_DELAY_MS = 500;
export const TITLE_DEPTH = 100;
interface SendToken {
  value: string;
  state?: 'accepted' | 'failed';
}
interface History {
  seen?: string;
  pending: SendToken[];
  observed?: SendToken;
  done: string[];
  undone: string[];
  open: boolean;
  at: number;
  word: boolean;
  kind: boolean;
}
const histories = new Map<string, History>();
function history(id: string): History {
  const h = histories.get(id) ?? {
    pending: [],
    done: [],
    undone: [],
    open: false,
    at: 0,
    word: false,
    kind: true,
  };
  histories.set(id, h);
  return h;
}
/** Наблюдение переживает холодный возврат; provisional значения не подтверждают CAS. */
export function observeTitleValue(id: string, value: string): boolean {
  const h = history(id);
  if (h.seen === value && h.observed?.state !== 'failed') return false;
  const observed = h.pending.findIndex((v) => v.value === value);
  const foreign = h.seen !== undefined && observed < 0;
  h.seen = value;
  const token = h.pending[observed];
  h.observed = token?.state === 'accepted' ? undefined : token;
  if (observed >= 0) h.pending.splice(0, observed + 1);
  return foreign;
}
export function markTitleSent(id: string, value: string): SendToken | undefined {
  const h = history(id);
  const token = { value };
  if (value !== h.seen) {
    h.pending = h.pending.filter((v) => v.value !== value);
    h.pending.push(token);
  } else if (h.observed && h.observed.state !== 'accepted') {
    h.pending.length = 0;
    h.observed = token;
  } else return;
  return token;
}
/** Отказ снимает только своё намерение, даже если поле уже размонтировано. */
export function rejectTitleSend(id: string, token: SendToken | undefined): boolean {
  const h = histories.get(id);
  if (
    !h ||
    !token ||
    token.state === 'accepted' ||
    (h.observed !== token && !h.pending.includes(token))
  )
    return false;
  h.pending = h.pending.filter((v) => v !== token);
  if (h.observed === token) token.state = 'failed';
  // Более новая отправка, ещё не попавшая в props, не теряет свои шаги из-за старого отказа.
  return !h.pending.length && h.observed?.state === 'failed';
}
/** Успех подтверждает только всё ещё принадлежащее этой записи намерение. */
export function acceptTitleSend(id: string, token: SendToken | undefined): void {
  const h = histories.get(id);
  if (token && h && (h.observed === token || h.pending.includes(token))) {
    token.state = 'accepted';
    if (h.observed === token) h.observed = undefined;
  }
}
export function recordTitleChange(
  id: string,
  prev: string,
  next: string,
  now = Date.now(),
): boolean {
  if (prev === next) return false;
  const h = history(id);
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
  const h = histories.get(id);
  if (h) {
    h.done.length = h.undone.length = h.pending.length = 0;
    h.open = false;
    h.observed = undefined;
  }
};
export const forgetTitleHistory = (id: string): void => {
  histories.delete(id);
};
export const clearTitleHistories = (): void => histories.clear();

export function closeTitleGroup(id: string): void {
  const h = histories.get(id);
  if (h) h.open = false;
}
