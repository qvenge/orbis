import type { ChangePage } from '@orbis/shared';
import { withIdentity } from '../db/with-identity';
import type { Identity } from '../identity';
import type { Context } from '../trpc';
import { readChanges } from './feed';
import type { ChangeWake } from './listener';

const COALESCE_MS = 50;
const SAFETY_MS = 30_000;
const QUIET_MS = 300_000;
const REFRESH_BEFORE_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;
const STOPPED = Symbol('stream stopped');

export type TokenRefresh = { kind: 'refresh-token' };
type StreamOptions = {
  from: string;
  expiresAt: number;
  signal: AbortSignal;
  subscribe: (wake: (notice: ChangeWake) => void) => () => void;
  read: (from: string) => Promise<{ page: ChangePage; targetXid: string }>;
};

function interruptible<T>(result: Promise<T>, signal: AbortSignal): Promise<T | typeof STOPPED> {
  return new Promise((resolve, reject) => {
    const stop = () => resolve(STOPPED);
    result.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

export async function* streamChanges({
  from,
  expiresAt,
  signal,
  subscribe,
  read,
}: StreamOptions): AsyncGenerator<ChangePage | TokenRefresh> {
  const cutoff = expiresAt - REFRESH_BEFORE_MS;
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  if (signal.aborted) return;
  signal.addEventListener('abort', stop, { once: true });
  let cutoffTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleCutoff() {
    const remaining = cutoff - Date.now();
    if (remaining <= 0) stop();
    else cutoffTimer = setTimeout(scheduleCutoff, Math.min(remaining, MAX_TIMER_MS));
  }
  scheduleCutoff();

  let seedTarget = true;
  let target = -1n;
  let provisionalFloor = 0n;
  let safetyAt = Date.now();
  let notifyAt = Infinity;
  let retryAt = Infinity;
  let quietAt = Infinity;
  let nextQuietAllowed = -Infinity;
  let retryDelay = 100;
  let lastReset: string | undefined;
  let wakeWaiter: (() => void) | undefined;

  const unsubscribe = subscribe((notice) => {
    if ('recovered' in notice) seedTarget = true;
    else if (notice.txId > target) target = notice.txId;
    notifyAt = Math.min(notifyAt, Date.now() + COALESCE_MS);
    wakeWaiter?.();
  });

  try {
    while (!stopped.signal.aborted) {
      // While xmin is holding a known target, further commits extend that
      // target without defeating the retry backoff.
      const wakeAt = retryAt === Infinity ? notifyAt : retryAt;
      const delay = Math.min(safetyAt, wakeAt, quietAt) - Date.now();
      if (delay > 0) {
        // Recompute the deadline when a NOTIFY or reconnect arrives during sleep.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, delay);
          function done() {
            clearTimeout(timer);
            stopped.signal.removeEventListener('abort', done);
            wakeWaiter = undefined;
            resolve();
          }
          wakeWaiter = done;
          stopped.signal.addEventListener('abort', done, { once: true });
        });
        continue;
      }

      const seedThisRead = seedTarget;
      seedTarget = false;
      notifyAt = Infinity;
      const result = await interruptible(read(from), stopped.signal);
      if (result === STOPPED || stopped.signal.aborted || Date.now() >= cutoff) break;
      const { page, targetXid } = result;
      const watermark = BigInt(page.watermark);
      if (seedThisRead && BigInt(targetXid) > target) target = BigInt(targetXid);
      if (page.reset?.phase === 'provisional') provisionalFloor = BigInt(page.floor);
      const now = Date.now();
      safetyAt = now + SAFETY_MS;
      if (watermark <= target || watermark < provisionalFloor) {
        retryAt = now + retryDelay;
        retryDelay = Math.min(retryDelay * 2, 2_000);
      } else {
        retryAt = Infinity;
        retryDelay = 100;
      }
      const hasChanges = page.transactions.length > 0;
      const hasReset = page.reset !== null && page.reset.token !== lastReset;
      const hasProgress = page.watermark !== from;
      if (hasChanges || hasReset || (hasProgress && now >= nextQuietAllowed)) {
        if (!hasChanges && !hasReset) nextQuietAllowed = now + QUIET_MS;
        quietAt = Infinity;
        from = page.watermark;
        lastReset = page.reset?.token;
        yield page;
      } else {
        quietAt = hasProgress ? nextQuietAllowed : Infinity;
      }
    }
    if (!signal.aborted && Date.now() >= cutoff) yield { kind: 'refresh-token' };
  } finally {
    unsubscribe();
    clearTimeout(cutoffTimer);
    signal.removeEventListener('abort', stop);
  }
}

export function watchChanges(
  ctx: Context & { identity: Identity; expiresAt: number },
  from: string,
  signal?: AbortSignal,
) {
  const activeSignals = [signal, ctx.changeListener?.signal].filter((value) => value !== undefined);
  return streamChanges({
    from,
    expiresAt: ctx.expiresAt,
    signal: AbortSignal.any(activeSignals),
    subscribe: (wake) => ctx.changeListener?.subscribe(ctx.identity.graph, wake) ?? (() => {}),
    read: (cursor) => withIdentity(ctx.db, ctx.identity, (tx) => readChanges(tx, { from: cursor })),
  });
}
