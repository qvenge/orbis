import { requestResult } from './database';
import {
  checkpointInput,
  type InputDraftSnapshot,
  type InputDraftToken,
  type InputScope,
  type InputSlot,
  type InputSubmission,
  inputExpired,
  inputSlotKey,
  inputTokenMatchesScope,
  retireInput,
  validInputScope,
  validInputSlot,
  validInputSnapshot,
  validInputToken,
} from './input-slot';

export type { InputDraftSnapshot, InputDraftToken, InputScope } from './input-slot';
export { sameInputToken } from './input-slot';

const INPUT_PREFIX = 'orbis-input:';
const SLOTS = 'slots';

export const inputDatabaseName = (accountId: string) => INPUT_PREFIX + accountId;

export async function listInputDatabases(knownAccountIds: readonly string[] = []) {
  const names = new Set(knownAccountIds.filter(Boolean).map(inputDatabaseName));
  let discovered = false;
  try {
    for (const database of await indexedDB.databases()) {
      if (database.name?.startsWith(INPUT_PREFIX)) names.add(database.name);
    }
    discovered = true;
  } catch {
    // Fall back to accounts already known to the caller's device lifecycle.
  }
  return { names: [...names], discovered };
}

/** The lifecycle must revoke writers first. A blocked browser request may still finish later. */
export function clearInputDatabase(name: string): Promise<'deleted' | 'blocked' | 'failed'> {
  return new Promise((resolve) => {
    if (!name.startsWith(INPUT_PREFIX) || name.length === INPUT_PREFIX.length) {
      resolve('failed');
      return;
    }
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onblocked = () => resolve('blocked');
      request.onerror = () => resolve('failed');
      request.onsuccess = () => resolve('deleted');
    } catch {
      resolve('failed');
    }
  });
}

function abort(tx: IDBTransaction): void {
  try {
    tx.abort();
  } catch {
    // A browser may already have aborted or committed the transaction.
  }
}

function openDatabase(
  name: string,
  current: () => boolean,
  close: () => void,
): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      if (!current()) {
        resolve(undefined);
        return;
      }
      const request = indexedDB.open(name, 1);
      let blocked = false;
      request.onblocked = () => {
        blocked = true;
        resolve(undefined);
      };
      request.onerror = () => resolve(undefined);
      request.onupgradeneeded = () => {
        if (blocked || !current()) {
          if (request.transaction) abort(request.transaction);
          return;
        }
        const store = request.result.createObjectStore(SLOTS, { keyPath: 'key' });
        store.createIndex('graph', 'graphId');
        store.createIndex('entity', 'entity');
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked || !current()) {
          db.close();
          resolve(undefined);
          return;
        }
        db.onversionchange = () => {
          close();
          db.close();
        };
        db.onclose = close;
        resolve(db);
      };
    } catch {
      resolve(undefined);
    }
  });
}

/** Use only after the current lifecycle authorizes recovery of preserved, scoped input. */
type Recovery = { recovery?: true };
type Checkpoint = Recovery & { submitted?: true; priorSubmission?: InputSubmission };
type StoredSlot = InputSlot & { graphId: string; entity: [string, string] };

function storedSlot(slot: InputSlot): StoredSlot {
  const [graphId, entityId] = slot.key;
  return { ...slot, graphId, entity: [graphId, entityId] };
}

/**
 * Caller-supplied lease covers input privacy and lifecycle only. Shared mode passes enabled=false.
 * Freeze every old handle on transition, even if a preserving transition keeps its generation.
 */
export function openInputStore(
  inputScope: InputScope,
  {
    enabled = true,
    isCurrent,
    now = Date.now,
  }: { enabled?: boolean; isCurrent: (scope: InputScope) => boolean; now?: () => number },
) {
  const scope = Object.freeze({ ...inputScope });
  let frozen = false;
  const active = new Set<IDBTransaction>();

  function current(): boolean {
    try {
      return enabled && !frozen && validInputScope(scope) && isCurrent(scope);
    } catch {
      return false;
    }
  }

  function freeze(): void {
    frozen = true;
    for (const tx of active) abort(tx);
  }

  const database = openDatabase(inputDatabaseName(scope.accountId), current, freeze);

  async function guarded<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore, check: () => void) => Promise<T>,
  ): Promise<T | undefined> {
    const db = await database;
    if (!db || !current()) return undefined;
    let tx: IDBTransaction | undefined;
    try {
      tx =
        mode === 'readwrite'
          ? db.transaction(SLOTS, mode, { durability: 'strict' })
          : db.transaction(SLOTS, mode);
      active.add(tx);
      const transaction = tx;
      const dbStore = transaction.objectStore(SLOTS);
      const complete = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('Input transaction aborted'));
      });
      const check = () => {
        if (!current()) throw new Error('Input scope changed');
      };
      const [, result] = await Promise.all([
        complete,
        Promise.resolve().then(async () => {
          check();
          const result = await work(dbStore, check);
          check();
          return result;
        }),
      ]);
      return current() ? result : undefined;
    } catch {
      if (tx) abort(tx);
      return undefined;
    } finally {
      if (tx) active.delete(tx);
    }
  }

  function accepts(token: InputDraftToken, options: Recovery): boolean {
    return (
      current() &&
      validInputToken(token) &&
      inputTokenMatchesScope(token, scope) &&
      (token.generation === scope.generation || options.recovery === true)
    );
  }

  async function update(
    token: InputDraftToken,
    next: (previous: InputSlot | undefined) => InputSlot | undefined,
  ): Promise<boolean | undefined> {
    return guarded('readwrite', async (store, check) => {
      const raw: unknown = await requestResult(store.get(inputSlotKey(token)));
      check();
      if (raw !== undefined && !validInputSlot(raw, scope)) return false;
      const previous = raw as InputSlot | undefined;
      const updated = next(previous);
      if (!updated) return false;
      if (updated !== previous) await requestResult(store.put(storedSlot(updated)));
      return true;
    });
  }

  function list(entityId?: string): Promise<InputDraftSnapshot[] | undefined> {
    return guarded('readwrite', async (store, check) => {
      const rows: unknown[] = await requestResult(
        entityId === undefined
          ? store.index('graph').getAll(scope.graphId)
          : store.index('entity').getAll([scope.graphId, entityId]),
      );
      check();
      const snapshots: InputDraftSnapshot[] = [];
      const writes: Promise<unknown>[] = [];
      const at = now();
      for (const row of rows) {
        if (!validInputSlot(row, scope) || (entityId !== undefined && row.key[1] !== entityId))
          continue;
        const { snapshot, acknowledgedFallback, submitted } = row;
        const current = snapshot && !inputExpired(snapshot, at) ? snapshot : undefined;
        const fallback =
          acknowledgedFallback && !inputExpired(acknowledgedFallback, at)
            ? acknowledgedFallback
            : undefined;
        const submission = submitted && !inputExpired(submitted, at) ? submitted : undefined;
        if (current) snapshots.push(current);
        if (fallback) snapshots.push(fallback);
        if (current !== snapshot || fallback !== acknowledgedFallback || submission !== submitted) {
          const next = {
            ...row,
            snapshot: current,
            acknowledgedFallback: fallback,
            submitted: submission,
          };
          writes.push(requestResult(store.put(storedSlot(next))));
        }
      }
      await Promise.all(writes);
      return snapshots;
    });
  }

  return {
    scope,
    list,
    async count(): Promise<{ pending: number; acknowledged: number } | undefined> {
      const snapshots = await list();
      if (!snapshots) return undefined;
      const acknowledged = snapshots.filter((snapshot) => snapshot.acknowledged).length;
      return { pending: snapshots.length - acknowledged, acknowledged };
    },
    /** True means this token is on disk after commit. False leaves the source untouched. */
    async persistDraft(snapshot: InputDraftSnapshot, options: Checkpoint = {}) {
      if (!validInputSnapshot(snapshot) || !accepts(snapshot.token, options)) return undefined;
      if (options.submitted && snapshot.token.generation !== scope.generation) return undefined;
      const priorSubmission =
        snapshot.token.generation === scope.generation ? options.priorSubmission : undefined;
      return update(snapshot.token, (previous) =>
        checkpointInput(previous, snapshot, now(), options.submitted, priorSubmission),
      );
    },
    /** May fence a pending checkpoint even if the exact token has not reached disk yet. */
    async removeDraftIfMatch(token: InputDraftToken, options: Recovery = {}) {
      if (!accepts(token, options)) return undefined;
      return update(token, (previous) => retireInput(previous, token));
    },
    freeze,
    close() {
      freeze();
      void database.then((db) => db?.close());
    },
  };
}
