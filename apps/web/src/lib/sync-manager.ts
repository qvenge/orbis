import { trpcClient } from './trpc.ts';
import {
  cacheEntities,
  getPendingMutations,
  clearPendingMutations,
  getPendingCount,
} from './offline-db.ts';

const DEVICE_ID = (() => {
  let id = localStorage.getItem('orbis-device-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('orbis-device-id', id);
  }
  return id;
})();

const SYNC_KEY = 'orbis-last-sync-at';

function getLastSyncAt(): string | null {
  return localStorage.getItem(SYNC_KEY);
}

function setLastSyncAt(ts: string) {
  localStorage.setItem(SYNC_KEY, ts);
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'retrying';

interface SyncState {
  status: SyncStatus;
  retryCount: number;
  conflictCount: number;
  lastSyncAt: string | null;
}

const MAX_RETRIES = 5;
const BASE_DELAY = 1000;
const MAX_DELAY = 30000;

let state: SyncState = {
  status: 'idle',
  retryCount: 0,
  conflictCount: 0,
  lastSyncAt: getLastSyncAt(),
};

let statusListeners: Array<(status: SyncStatus, pending: number, state: SyncState) => void> = [];

async function notifyListeners() {
  const pending = await getPendingCount();
  for (const fn of statusListeners) fn(state.status, pending, state);
}

export function onSyncStatusChange(fn: (status: SyncStatus, pending: number, state: SyncState) => void) {
  statusListeners.push(fn);
  return () => {
    statusListeners = statusListeners.filter((l) => l !== fn);
  };
}

export function getSyncStats() {
  return { ...state, lastSyncAt: getLastSyncAt() };
}

export async function pull() {
  const result = await trpcClient.sync.pull.query({
    lastSyncAt: getLastSyncAt(),
    deviceId: DEVICE_ID,
  });

  if (result.entities.length > 0) {
    await cacheEntities(result.entities as Array<{ id: string; updatedAt: unknown } & Record<string, unknown>>);
  }

  setLastSyncAt(result.syncAt);
}

export async function push(): Promise<number> {
  const mutations = await getPendingMutations();
  if (mutations.length === 0) return 0;

  const result = await trpcClient.sync.push.mutate({
    deviceId: DEVICE_ID,
    lastSyncAt: getLastSyncAt(),
    changes: {
      entities: mutations
        .filter((m) => m.type !== 'delete')
        .map((m) => m.payload),
      relations: [],
    },
  });

  await clearPendingMutations(mutations.map((m) => m.id));
  setLastSyncAt(result.newSyncAt);

  return (result as { conflictCount?: number }).conflictCount ?? 0;
}

function getBackoffDelay(retry: number): number {
  return Math.min(BASE_DELAY * 2 ** retry, MAX_DELAY);
}

let retryTimeout: ReturnType<typeof setTimeout> | null = null;

async function syncWithRetry() {
  if (state.status === 'syncing' || state.status === 'retrying') return;

  state.status = 'syncing';
  state.retryCount = 0;
  state.conflictCount = 0;
  await notifyListeners();

  while (state.retryCount <= MAX_RETRIES) {
    try {
      const conflicts = await push();
      await pull();
      state.status = 'idle';
      state.conflictCount = conflicts;
      state.lastSyncAt = getLastSyncAt();
      await notifyListeners();
      return;
    } catch (err) {
      state.retryCount++;
      console.error(`[Sync] Attempt ${state.retryCount}/${MAX_RETRIES} failed:`, err);

      if (state.retryCount > MAX_RETRIES) {
        state.status = 'error';
        await notifyListeners();
        return;
      }

      state.status = 'retrying';
      await notifyListeners();

      const delay = getBackoffDelay(state.retryCount - 1);
      await new Promise<void>((resolve) => {
        retryTimeout = setTimeout(resolve, delay);
      });
      retryTimeout = null;
    }
  }
}

export { syncWithRetry as sync };

export function triggerSync() {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
  state.retryCount = 0;
  state.status = 'idle';
  syncWithRetry();
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startPeriodicSync(intervalMs = 30000) {
  syncWithRetry();

  intervalId = setInterval(syncWithRetry, intervalMs);

  window.addEventListener('online', () => {
    state.retryCount = 0;
    syncWithRetry();
  });

  return () => {
    if (intervalId) clearInterval(intervalId);
  };
}
