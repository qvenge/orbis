export type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// The pinned AuthClient also stores PKCE state and, with separate userStorage, the user.
const authKeys = (key: string) => [key, `${key}-code-verifier`, `${key}-user`, `${key}-revision`];

export function removeStoredAuth(backend: StorageAccess, key: string): void {
  for (const slot of authKeys(key)) backend.removeItem(slot);
}

/**
 * Each AuthClient gets its own adapter, even when two successive clients use the same key.
 * The lifecycle supplies its current client and generation check, and revokes before disposal.
 * An SDK operation can still finish and emit an event after revoke. Its caller uses the same
 * isCurrent check before publishing that event.
 */
export function createAuthStorage({
  key,
  backend,
  isCurrent: isOwner = () => true,
}: {
  key: string;
  backend: StorageAccess | null;
  isCurrent?: () => boolean;
}): { storage: StorageAccess; isCurrent: () => boolean; revoke: () => void } {
  let revoked = false;
  const isCurrent = () => !revoked && isOwner();
  const allowed = new Set(authKeys(key));
  const memory = new Map<string, string>();

  return {
    isCurrent,
    revoke() {
      revoked = true;
      memory.clear();
    },
    storage: {
      getItem(slot) {
        if (!isCurrent() || !allowed.has(slot)) return null;
        return backend ? backend.getItem(slot) : (memory.get(slot) ?? null);
      },
      setItem(slot, value) {
        if (!isCurrent() || !allowed.has(slot)) return;
        if (backend) backend.setItem(slot, value);
        else memory.set(slot, value);
      },
      removeItem(slot) {
        if (!isCurrent() || !allowed.has(slot)) return;
        if (backend) backend.removeItem(slot);
        else memory.delete(slot);
      },
    },
  };
}
