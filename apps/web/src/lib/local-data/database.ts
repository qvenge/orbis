const RESPONSE_PREFIX = 'orbis-cache:';
const CATALOG_PREFIX = 'orbis:cache-catalog:';
export const RESPONSE_STORE = 'responses';
export const CONTROL_STORE = 'control';

export const responseDatabaseName = (accountId: string) => RESPONSE_PREFIX + accountId;

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Resolve only after the transaction commits. Use only IndexedDB requests inside work. */
export async function transaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
  durable = false,
): Promise<T> {
  const stores = [CONTROL_STORE, RESPONSE_STORE];
  const tx = durable
    ? db.transaction(stores, mode, { durability: 'strict' })
    : db.transaction(stores, mode);
  const complete = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  const result = Promise.resolve()
    .then(() => work(tx))
    .catch((error: unknown) => {
      try {
        tx.abort();
      } catch {
        // The browser can have already aborted the transaction on request failure.
      }
      throw error;
    });
  const [value] = await Promise.all([result, complete]);
  return value;
}

export function openResponseDatabase(
  accountId: string,
  { canOpen, onVersionChange }: { canOpen: () => boolean; onVersionChange: () => void },
): Promise<IDBDatabase | undefined> {
  const name = responseDatabaseName(accountId);
  return new Promise((resolve) => {
    try {
      if (!canOpen()) {
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
        if (blocked || !canOpen()) {
          request.transaction?.abort();
          return;
        }
        const db = request.result;
        const store = db.createObjectStore(RESPONSE_STORE, { keyPath: ['graphId', 'queryHash'] });
        store.createIndex('graph', 'graphId');
        store.createIndex('expires', 'expiresAt');
        store.createIndex('entity', 'entityKeys', { multiEntry: true });
        db.createObjectStore(CONTROL_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked || !canOpen()) {
          db.close();
          resolve(undefined);
          return;
        }
        db.onversionchange = () => {
          db.close();
          onVersionChange();
        };
        db.onclose = onVersionChange;
        try {
          localStorage.setItem(CATALOG_PREFIX + name, '1');
        } catch {
          // indexedDB.databases() can independently discover the response store.
        }
        resolve(db);
      };
    } catch {
      resolve(undefined);
    }
  });
}

export async function listResponseDatabases(): Promise<{ names: string[]; discovered: boolean }> {
  const names = new Set<string>();
  let discovered = false;
  try {
    for (const db of await indexedDB.databases()) {
      if (db.name?.startsWith(RESPONSE_PREFIX)) names.add(db.name);
    }
    discovered = true;
  } catch {
    // Some browsers only provide the local catalog.
  }
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(CATALOG_PREFIX + RESPONSE_PREFIX)) {
        names.add(key.slice(CATALOG_PREFIX.length));
      }
    }
  } catch {
    // Return known names and report when exhaustive discovery could not be verified.
  }
  return { names: [...names], discovered };
}

/** The lifecycle caller must fence new opens before deletion, which can remain queued when blocked. */
export function deleteResponseDatabase(name: string): Promise<'deleted' | 'blocked' | 'failed'> {
  return new Promise((resolve) => {
    if (!name.startsWith(RESPONSE_PREFIX)) {
      resolve('failed');
      return;
    }
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onblocked = () => resolve('blocked');
      request.onerror = () => resolve('failed');
      request.onsuccess = () => {
        try {
          localStorage.removeItem(CATALOG_PREFIX + name);
        } catch {
          // A leftover catalog name is safe to delete again.
        }
        resolve('deleted');
      };
    } catch {
      resolve('failed');
    }
  });
}
