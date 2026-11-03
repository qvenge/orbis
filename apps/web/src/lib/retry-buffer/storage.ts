import {
  captureInputAccess,
  type InputStorage,
  removeStorageKeys,
} from '../local-data/input-access';
import type { QueuedCreate } from './index';

const KEY_PREFIX = 'orbis:retry-buffer:v1';

export interface QueueStorage {
  load(): QueuedCreate[];
  save(items: QueuedCreate[]): void;
}

let scope: string | null = null;
let scopeEpoch = 0;
const queueKey = (userId: string | null) => (userId ? `${KEY_PREFIX}:${userId}` : KEY_PREFIX);

function readKey(storage: InputStorage, key: string): QueuedCreate[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isQueuedCreate) : [];
  } catch {
    return [];
  }
}

function isQueuedCreate(v: unknown): v is QueuedCreate {
  if (typeof v !== 'object' || v === null) return false;
  const q = v as Partial<QueuedCreate>;
  return (
    typeof q.clientId === 'string' && typeof q.tool === 'string' && typeof q.createdAt === 'string'
  );
}

export function setQueueScope(userId: string | null): void {
  if (scope !== userId) scopeEpoch += 1;
  scope = userId;
  const access = captureInputAccess();
  if (!userId || !access?.isCurrent() || access.prefix) return;
  const legacy = readKey(access.storage, KEY_PREFIX);
  if (legacy.length === 0) return;
  const own = readKey(access.storage, queueKey(userId));
  access.storage.setItem(queueKey(userId), JSON.stringify([...own, ...legacy]));
  access.storage.removeItem(KEY_PREFIX);
}

export function captureQueueStorage(): QueueStorage & { isCurrent(): boolean } {
  const access = captureInputAccess();
  const owner = scope;
  const epoch = scopeEpoch;
  const isCurrent = () => scopeEpoch === epoch && !!access?.isCurrent();
  const key = (access?.prefix ?? '') + queueKey(owner);
  return {
    isCurrent,
    load: () => (access && isCurrent() ? readKey(access.storage, key) : []),
    save(items) {
      if (!access || !isCurrent()) throw new Error('Сеанс ввода изменился');
      access.storage.setItem(key, JSON.stringify(items));
    },
  };
}

export const localStorageQueue: QueueStorage = {
  load: () => captureQueueStorage().load(),
  save: (items) => captureQueueStorage().save(items),
};

export function listQueuedIn(storage: InputStorage, accountId?: string, prefix = '') {
  if (accountId !== undefined) return readKey(storage, prefix + queueKey(accountId));
  return storage
    .keys()
    .filter((key) => key === prefix + KEY_PREFIX || key.startsWith(`${prefix}${KEY_PREFIX}:`))
    .flatMap((key) => readKey(storage, key));
}

export function queuedInputOwners(storage: InputStorage, prefix: string): string[] {
  const start = `${prefix}${KEY_PREFIX}:`;
  return storage
    .keys()
    .filter((key) => key.startsWith(start) && readKey(storage, key).length > 0)
    .map((key) => key.slice(start.length));
}

export function mergeQueuedInto(
  storage: InputStorage,
  accountId: string,
  items: readonly QueuedCreate[],
): void {
  if (items.length === 0) return;
  const key = queueKey(accountId);
  const current = readKey(storage, key);
  const seen = new Set(current.map((item) => item.clientId));
  storage.setItem(
    key,
    JSON.stringify([...current, ...items.filter((item) => !seen.has(item.clientId))]),
  );
}

export function clearQueuedIn(storage: InputStorage, accountId?: string, prefix = ''): void {
  const start = prefix + KEY_PREFIX;
  removeStorageKeys(storage, (key) =>
    accountId === undefined
      ? key === start || key.startsWith(`${start}:`)
      : key === prefix + queueKey(accountId),
  );
}
