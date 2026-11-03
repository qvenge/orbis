import type { StorageAccess } from '../../auth/storage';

export type InputStorage = StorageAccess & { keys(): string[] };
export type InputAccess = {
  storage: InputStorage;
  prefix: string;
  isCurrent(): boolean;
  /** The captured input generation can outlive an ordinary runtime lease. */
  canPreserve?(): boolean;
};

export function browserInputStorage(storage: Storage): InputStorage {
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
    keys: () => Object.keys(storage),
  };
}

let active: InputAccess | null | undefined;

/** null freezes product input. undefined is the legacy unbound adapter. */
export function configureInputAccess(next: InputAccess | null | undefined): void {
  active = next;
}

export function captureInputAccess(): InputAccess | null {
  if (active === undefined) {
    try {
      return {
        storage: browserInputStorage(localStorage),
        prefix: '',
        isCurrent: () => active === undefined,
      };
    } catch {
      return null;
    }
  }
  const captured = active;
  return (
    captured && {
      ...captured,
      isCurrent: () => active === captured && captured.isCurrent(),
    }
  );
}

export function removeStorageKeys(storage: InputStorage, matches: (key: string) => boolean): void {
  for (const key of storage.keys()) {
    if (matches(key)) storage.removeItem(key);
  }
}
