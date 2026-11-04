import { nextNetworkOrder } from '../../lib/freshness/provenance';

/** Снимки поля браузера недоступны программно: заголовок держит свою историю во вкладке. */
export const TITLE_GROUP_DELAY_MS = 500;
export const TITLE_DEPTH = 100;
interface SendToken {
  value: string;
  state?: 'accepted' | 'failed';
}
interface History {
  seen?: string;
  accepted?: string;
  unconfirmed?: string;
  acknowledged?: { value: string; sequence: number };
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
/** Projected and disk values may attach an own send but cannot establish a foreign basis. */
export function canObservePresentedTitle(id: string, value: string): boolean {
  const h = histories.get(id);
  if (h?.seen === undefined || h.pending.some((token) => token.value === value)) return true;
  if (h.observed?.state === 'failed') return h.pending.length === 0;
  return h.seen === value;
}

/** A disk title can underlie local steps before the first network read. */
export function rememberUnconfirmedTitle(id: string, value: string): void {
  const h = history(id);
  if (h.accepted === undefined) h.unconfirmed ??= value;
}

/** Only a new accepted network title can replace the retained server basis. */
export function observeAcceptedTitle(id: string, value: string, startedSequence = 0): boolean {
  const h = history(id);
  const ack = h.acknowledged;
  const afterAck = ack !== undefined && startedSequence > ack.sequence;
  const basis = h.accepted ?? h.unconfirmed;
  h.accepted = value;
  h.unconfirmed = undefined;
  if (basis === value && !afterAck) return false;
  const pending = h.pending.some((token) => token.value === value);
  const observed = h.observed?.value === value && h.observed.state !== 'failed';
  const own = pending || observed || ack?.value === value;
  const foreign = (basis !== undefined || afterAck) && !own;
  // A read started after the ACK may prove a return to the old title. An
  // earlier repeat of the old raw title leaves the attribution available.
  h.acknowledged = undefined;
  if (pending) observeTitleValue(id, value);
  else if (foreign || (!h.observed && h.pending.length === 0)) h.seen = value;
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
    h.acknowledged =
      h.accepted === token.value ? undefined : { value: token.value, sequence: nextNetworkOrder() };
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
    h.acknowledged = undefined;
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
