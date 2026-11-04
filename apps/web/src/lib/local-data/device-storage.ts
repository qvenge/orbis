import { removeStoredAuth } from '../../auth/storage';
import {
  clearDraftsIn,
  isDraftSlotFinishedIn,
  listDraftsIn,
} from '../../features/entity-editor/draft-storage';
import { clearNavigationIn } from '../../state/navigation';
import { clearQueuedIn, listQueuedIn, mergeQueuedInto } from '../retry-buffer/storage';
import {
  deleteResponseDatabase,
  listResponseDatabases,
  openResponseDatabase,
  RESPONSE_STORE,
  requestResult,
  responseDatabaseName,
  transaction,
} from './database';
import { DEVICE_ACCOUNT_PREFIX, type DeviceIntent } from './device-control';
import { type InputStorage, removeStorageKeys } from './input-access';
import {
  clearInputDatabase,
  inputDatabaseName,
  listInputDatabases,
  openInputStore,
} from './input-store';

type Result = 'deleted' | 'blocked' | 'failed';

function knownAccounts(storage: InputStorage) {
  return storage
    .keys()
    .filter((key) => key.startsWith(DEVICE_ACCOUNT_PREFIX))
    .map((key) => key.slice(DEVICE_ACCOUNT_PREFIX.length));
}

function authOwner(storage: InputStorage, key: string): string | undefined {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw)?.user?.id?.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

async function clearResponseGraph(accountId: string, graphId: string, isCurrent: () => boolean) {
  const db = await openResponseDatabase(accountId, {
    canOpen: isCurrent,
    onVersionChange: () => {},
  });
  if (!db) return 'failed';
  try {
    await transaction(
      db,
      'readwrite',
      async (tx) => {
        if (!isCurrent()) throw new Error('Переход изменился');
        const store = tx.objectStore(RESPONSE_STORE);
        const keys = await requestResult(store.index('graph').getAllKeys(graphId));
        if (!isCurrent()) throw new Error('Переход изменился');
        await Promise.all(keys.map((key) => requestResult(store.delete(key))));
        if (!isCurrent()) throw new Error('Переход изменился');
      },
      true,
    );
    return 'deleted';
  } catch {
    return 'failed';
  } finally {
    db.close();
  }
}

export async function clearDeviceStorage(
  storage: InputStorage,
  authKey: string,
  intent: DeviceIntent,
  isCurrent: () => boolean,
): Promise<Result> {
  const { reason, accountId, graphId } = intent;
  if (!isCurrent()) return 'failed';
  if (reason === 'shared-off') return 'deleted';
  if (reason === 'shared-on') {
    const responses = await listResponseDatabases();
    const input = await listInputDatabases(knownAccounts(storage));
    if (!isCurrent()) return 'failed';
    const results = await Promise.all([
      ...responses.names.map(deleteResponseDatabase),
      ...input.names.map(clearInputDatabase),
    ]);
    if (!isCurrent()) return 'failed';
    if (results.includes('blocked')) return 'blocked';
    if (results.includes('failed')) return 'failed';
    // A catalogue may be incomplete if storage was unavailable before this protocol.
    if (!responses.discovered || !input.discovered) return 'failed';
    clearDraftsIn(storage);
    clearQueuedIn(storage);
    clearNavigationIn(storage);
    removeStoredAuth(storage, authKey);
    removeStorageKeys(storage, (key) => key.startsWith(DEVICE_ACCOUNT_PREFIX));
    return 'deleted';
  }
  if (!accountId) return 'failed';
  if (reason === 'seeded') {
    if (!graphId) return 'failed';
    const result = await clearResponseGraph(accountId, graphId, isCurrent);
    if (result !== 'deleted' || !isCurrent()) return 'failed';
    clearNavigationIn(storage, accountId, graphId);
    return 'deleted';
  }
  const response = await deleteResponseDatabase(responseDatabaseName(accountId));
  if (response !== 'deleted') return response;
  if (reason === 'logout') {
    const input = await clearInputDatabase(inputDatabaseName(accountId));
    if (input !== 'deleted') return input;
  }
  if (!isCurrent()) return 'failed';
  clearNavigationIn(storage, accountId);
  if (reason === 'logout') {
    clearDraftsIn(storage, accountId);
    clearQueuedIn(storage, accountId);
  }
  if (
    (reason === 'logout' || reason === 'unauthorized') &&
    authOwner(storage, authKey) === accountId
  ) {
    removeStoredAuth(storage, authKey);
  }
  return 'deleted';
}

export async function countUnsent(
  storage: InputStorage,
  generation: (owner: string) => string,
  accountId?: string,
  isCurrent = () => true,
): Promise<{ count: number; version: string }> {
  const drafts = new Set<string>();
  function add(owner: string, entityId: string, token: string) {
    drafts.add(`${owner}:${entityId}:${token}`);
  }
  for (const { accountId: owner, entityId, draft } of listDraftsIn(storage, accountId)) {
    add(owner, entityId, draft.slot ?? draft.savedAt);
  }
  const inventory = await listInputDatabases();
  if (!inventory.discovered && knownAccounts(storage).length) {
    throw new Error('Не удалось проверить все сохранённые черновики');
  }
  for (const name of inventory.names) {
    const owner = name.slice('orbis-input:'.length);
    if (accountId !== undefined && accountId !== owner) continue;
    const input = openInputStore(
      { accountId: owner, graphId: owner, generation: generation(owner) },
      { isCurrent, now: () => 0 },
    );
    try {
      const snapshots = await input.list();
      if (!snapshots) throw new Error('Не удалось проверить сохранённые черновики');
      for (const snapshot of snapshots) {
        const { entityId, nonce } = snapshot.token;
        const time = Date.parse(snapshot.savedAt);
        if (
          !snapshot.acknowledged &&
          !(Number.isFinite(time) && Date.now() - time > 30 * 24 * 60 * 60 * 1000) &&
          !isDraftSlotFinishedIn(storage, owner, entityId, nonce)
        ) {
          add(owner, entityId, nonce);
        }
      }
    } finally {
      input.close();
    }
  }
  if (!isCurrent()) throw new Error('Сеанс изменился');
  const queue = [...new Set(listQueuedIn(storage, accountId).map((item) => item.clientId))].sort();
  return {
    count: drafts.size + queue.length,
    version: JSON.stringify([[...drafts].sort(), queue]),
  };
}

export async function preserveSharedInput(
  source: InputStorage,
  prefix: string,
  target: InputStorage,
  accountId: string,
  generation: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const drafts = listDraftsIn(source, accountId, prefix).sort(
    (a, b) => Number(!!b.draft.acknowledged) - Number(!!a.draft.acknowledged),
  );
  const input = drafts.length
    ? openInputStore({ accountId, graphId: accountId, generation }, { isCurrent })
    : undefined;
  try {
    for (const { entityId, draft } of drafts) {
      if (!input || !isCurrent()) return false;
      const legacyToken = {
        accountId,
        graphId: accountId,
        generation,
        entityId,
        writerId: draft.recovery ? `${prefix}${draft.slot ?? draft.savedAt}` : prefix,
        nonce: draft.slot ?? draft.savedAt,
        sequence: Math.max(0, Date.parse(draft.savedAt) || 0),
        basis:
          draft.baseRevision === undefined
            ? { updatedAt: draft.baseUpdatedAt ?? '' }
            : { revision: draft.baseRevision },
      };
      const managed = draft.inputToken;
      if (
        managed &&
        (managed.accountId !== accountId ||
          managed.graphId !== accountId ||
          managed.entityId !== entityId ||
          managed.generation !== generation ||
          managed.nonce !== draft.slot)
      )
        return false;
      const token = managed ?? legacyToken;
      if (isDraftSlotFinishedIn(target, accountId, entityId, token.nonce)) continue;
      const ok = await input.persistDraft({
        token,
        doc: draft.doc,
        savedAt: draft.savedAt,
        rejected: draft.rejected,
        ...(draft.recovery && { recovery: true }),
        ...(draft.acknowledged && { acknowledged: true }),
      });
      if (ok !== true) return false;
      // Preserve the compatible scoped source until the normal input reader imports it.
      const suffix = draft.recovery ? `:${token.nonce}` : '';
      const key = `orbis:body-draft:${accountId}:${entityId}${suffix}`;
      if (target.getItem(key) === null) target.setItem(key, JSON.stringify(draft));
    }
    if (!isCurrent()) return false;
    mergeQueuedInto(target, accountId, listQueuedIn(source, accountId, prefix));
    return true;
  } finally {
    input?.close();
  }
}
