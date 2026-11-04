import { newId } from '@orbis/shared';
import type { InputAccess } from '../../lib/local-data/input-access';
import { type InputSubmission, inputExpired } from '../../lib/local-data/input-slot';
import {
  type InputDraftSnapshot,
  type InputDraftToken,
  openInputStore,
  sameInputToken,
} from '../../lib/local-data/input-store';

type SessionAccess = InputAccess & { drafts: NonNullable<InputAccess['drafts']> };
type WriterCopies = { latest?: InputDraftSnapshot; acknowledged?: InputDraftSnapshot };

export type DraftSource = {
  entityId: string;
  slot?: string;
  raw: string;
  snapshot: Omit<InputDraftSnapshot, 'token'>;
  basis: InputDraftToken['basis'];
  token?: InputDraftToken;
  stillCurrent(): boolean;
  remove(slot: string): void;
};

export function createDraftMirror(
  access: SessionAccess,
  sources: (entityId?: string) => DraftSource[],
  emergency: (snapshot: InputDraftSnapshot, preserve: boolean) => boolean,
  markFinished: (entityId: string, slot: string) => boolean,
  isFinished: (entityId: string, slot: string) => boolean,
  isSuperseded: (token: InputDraftToken) => boolean,
) {
  const { scope, persistent, signal } = access.drafts;
  const currentAccess = () => {
    try {
      return !signal.aborted && access.isCurrent();
    } catch {
      return false;
    }
  };
  const store = openInputStore(scope, { enabled: persistent, isCurrent: currentAccess });
  const rows = new Map<string, Map<string, WriterCopies>>();
  const receipts = new Map<string, InputDraftSnapshot>();
  const nativeCopies = new Map<string, InputDraftToken>();
  const writes = new Map<string, { token: InputDraftToken; count: number }>();
  const emergencyCopies = new Set<string>();
  const retired = new Set<string>();

  const writers = new Map<string, () => void>();
  const hydrated = new Map<string | undefined, Promise<void>>();

  signal.addEventListener(
    'abort',
    () => {
      store.close();
      rows.clear();
      receipts.clear();
      nativeCopies.clear();
      writes.clear();
      emergencyCopies.clear();
      hydrated.clear();
      for (const revoke of writers.values()) revoke();
      writers.clear();
    },
    { once: true },
  );

  const slotKey = (entityId: string, nonce: string) => JSON.stringify([entityId, nonce]);
  const keyOf = ({ entityId, nonce }: InputDraftToken) => slotKey(entityId, nonce);

  function merge(snapshot: InputDraftSnapshot) {
    const token = snapshot.token;
    if (signal.aborted || retired.has(keyOf(token))) return;
    let entity = rows.get(token.entityId);
    if (!entity) {
      entity = new Map();
      rows.set(token.entityId, entity);
    }
    const copies = entity.get(token.writerId) ?? {};
    entity.set(token.writerId, copies);
    const existing = copies.latest;
    if (existing && existing.token.sequence === token.sequence) {
      if (!sameInputToken(existing.token, token)) return;
      snapshot = {
        ...existing,
        rejected: existing.rejected || snapshot.rejected,
        ...(snapshot.acknowledged && { acknowledged: true }),
        ...(snapshot.recovery && { recovery: true }),
      };
    }
    if (!existing || existing.token.sequence <= token.sequence) copies.latest = snapshot;
    if (snapshot.acknowledged) {
      const previous = copies.acknowledged;
      if (
        !previous ||
        previous.token.sequence < token.sequence ||
        sameInputToken(previous.token, token)
      )
        copies.acknowledged = snapshot;
    }
  }

  function find(entityId: string, slot: string) {
    const receipt = receipts.get(slotKey(entityId, slot));
    if (receipt) return receipt;
    for (const { latest, acknowledged } of rows.get(entityId)?.values() ?? []) {
      if (latest?.token.nonce === slot) return latest;
      if (acknowledged?.token.nonce === slot) return acknowledged;
    }
    return undefined;
  }

  const lineage = (token: InputDraftToken) => JSON.stringify([token.entityId, token.writerId]);
  const hasCopy = (token: InputDraftToken) =>
    nativeCopies.get(lineage(token))?.nonce === token.nonce || emergencyCopies.has(keyOf(token));
  function rememberNative(token: InputDraftToken) {
    const key = lineage(token);
    const current = nativeCopies.get(key);
    if (!current || current.sequence <= token.sequence) nativeCopies.set(key, token);
  }

  function forget(token: InputDraftToken) {
    const { entityId, nonce } = token;
    const key = keyOf(token);
    retired.add(key);
    receipts.delete(key);
    emergencyCopies.delete(key);
    if (nativeCopies.get(lineage(token))?.nonce === nonce) nativeCopies.delete(lineage(token));
    const entity = rows.get(entityId);
    const copies = entity?.get(token.writerId);
    if (copies?.latest?.token.nonce === nonce) copies.latest = undefined;
    if (copies?.acknowledged?.token.nonce === nonce) copies.acknowledged = undefined;
    if (copies && !copies.latest && !copies.acknowledged) entity?.delete(token.writerId);
  }

  function terminal(token: InputDraftToken): boolean {
    if (retired.has(keyOf(token))) return true;
    if (!isFinished(token.entityId, token.nonce)) return false;
    forget(token);
    void store.removeDraftIfMatch(token, { recovery: true });
    return true;
  }

  function suppressed(snapshot: InputDraftSnapshot) {
    return !snapshot.acknowledged && isSuperseded(snapshot.token);
  }

  async function put(
    snapshot: InputDraftSnapshot,
    options: { recovery?: true; submitted?: true; priorSubmission?: InputSubmission } = {},
  ) {
    const token = snapshot.token;
    if (!currentAccess()) return undefined;
    if (terminal(token) || suppressed(snapshot)) return false;
    const key = keyOf(token);
    const write = writes.get(key) ?? { token, count: 0 };
    write.count += 1;
    writes.set(key, write);
    try {
      const result = await store.persistDraft(snapshot, options);
      if (!currentAccess()) return undefined;
      if (terminal(token)) {
        // The marker can land after the native put committed but before its callback.
        await store.removeDraftIfMatch(token, { recovery: true });
        return false;
      }
      if (result === true) rememberNative(token);
      return suppressed(snapshot) ? false : result;
    } finally {
      write.count -= 1;
      if (write.count === 0) writes.delete(key);
    }
  }

  async function hydrate(entityId?: string) {
    const ongoing = hydrated.get(undefined) ?? hydrated.get(entityId);
    if (ongoing) return ongoing;
    const pending = Promise.resolve().then(async () => {
      if (!currentAccess()) return;
      const available = sources(entityId);
      // Native restore and legacy enumeration can race with new input. Merge only by
      // writer-local ordering; the hook separately protects its currently edited view.
      const disk = await store.list(entityId);
      if (!currentAccess()) return;
      for (const snapshot of disk ?? []) {
        const { token } = snapshot;
        if (terminal(token) || suppressed(snapshot)) continue;
        merge(snapshot);
        rememberNative(token);
      }
      for (const source of available) {
        if (!currentAccess()) return;
        const { entityId } = source;
        let slot = source.slot;
        if (!slot) {
          // Old drafts predate slot IDs. Use the exact immutable payload for a stable
          // migration identity across tabs and a crash between commit and source removal.
          try {
            const data = new TextEncoder().encode(source.raw);
            const hash = await crypto.subtle.digest('SHA-256', data);
            slot = Array.from(new Uint8Array(hash), (value) =>
              value.toString(16).padStart(2, '0'),
            ).join('');
          } catch {
            slot = newId();
          }
        }
        if (!currentAccess()) return;
        const token = source.token ??
          find(entityId, slot)?.token ?? {
            ...scope,
            entityId,
            nonce: slot,
            writerId: slot,
            sequence: 0,
            basis: source.basis,
          };
        if (!source.stillCurrent() || terminal(token)) continue;
        const snapshot = { ...source.snapshot, token };
        if (suppressed(snapshot)) continue;
        const migrated = persistent ? await put(snapshot, { recovery: true }) : undefined;
        if (!currentAccess()) return;
        if (migrated === false || terminal(token) || suppressed(snapshot)) continue;
        merge(snapshot);
        emergencyCopies.add(keyOf(token)); // original scoped Web Storage source
        if (migrated === true && !terminal(token)) source.remove(token.nonce);
      }
    });
    hydrated.set(entityId, pending);
    try {
      await pending;
    } finally {
      if (hydrated.get(entityId) === pending) hydrated.delete(entityId);
    }
  }

  async function finishToken(token: InputDraftToken): Promise<boolean> {
    if (!currentAccess()) return false;
    // Callers have explicit discard or a durable response receipt. Fence readers
    // before the native delete, including reads that already captured its payload.
    const marked = markFinished(token.entityId, token.nonce);
    if (marked) forget(token);
    if (!persistent) return marked;
    const result = await store.removeDraftIfMatch(token, { recovery: true });
    if (!currentAccess() || (result === undefined && !marked)) return false;
    forget(token);
    return true;
  }

  function finish(entityId: string, slot: string) {
    const snapshot = find(entityId, slot);
    return snapshot ? finishToken(snapshot.token) : Promise.resolve(false);
  }

  function outcome(entityId: string, slot: string, outcome: 'rejected' | 'acknowledged') {
    const snapshot = find(entityId, slot);
    if (!snapshot || !currentAccess() || terminal(snapshot.token)) return;
    const next = { ...snapshot, [outcome]: true as const };
    merge(next);
    const key = slotKey(entityId, slot);
    receipts.set(key, next);
    if (persistent) {
      void put(next, { recovery: true }).then((result) => {
        if (
          result === undefined &&
          !retired.has(key) &&
          (next.acknowledged || emergencyCopies.has(key)) &&
          emergency(next, false)
        )
          emergencyCopies.add(key);
      });
    } else if ((next.acknowledged || hasCopy(snapshot.token)) && emergency(next, false)) {
      emergencyCopies.add(key);
    }
  }

  function writer(entityId: string) {
    let sequence = 0;
    let writerId: string | undefined;
    let current: InputDraftSnapshot | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let submittedKey: string | undefined;

    let lastEmergency: InputDraftToken | undefined;

    function stop() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (writerId) writers.delete(writerId);
    }

    function checkpoint() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!current || signal.aborted) return;
      const snapshot = current;
      if (!persistent) {
        preserve();
        return;
      }
      const active = submittedKey === undefined ? undefined : receipts.get(submittedKey);
      // Keep the submitted token if this checkpoint races with its own failed
      // registration. The native transaction checks it before replacing the text.
      const priorSubmission =
        active &&
        !active.acknowledged &&
        !active.rejected &&
        active.token.sequence < snapshot.token.sequence &&
        !terminal(active.token)
          ? { token: active.token, savedAt: active.savedAt }
          : undefined;
      void put(snapshot, { priorSubmission }).then((result) => {
        if (result === undefined && current === snapshot) preserve();
        if (current !== snapshot && timer === undefined && !signal.aborted)
          timer = setTimeout(checkpoint, 300);
      });
    }

    function preserve(retry = false): boolean | (() => boolean) {
      if (!current || retired.has(keyOf(current.token))) return true;
      const snapshot = find(entityId, current.token.nonce) ?? current;
      const saved = emergency(snapshot, false);
      if (saved) {
        emergencyCopies.add(keyOf(snapshot.token));
        if (lastEmergency && lastEmergency.nonce !== snapshot.token.nonce)
          emergencyCopies.delete(keyOf(lastEmergency));
        lastEmergency = snapshot.token;
      }
      return saved || (retry ? () => emergency(snapshot, true) : false);
    }

    return {
      stage(doc: InputDraftSnapshot['doc'], revision: number, rejected = false) {
        if (signal.aborted) return;
        if (
          current?.doc === doc &&
          'revision' in current.token.basis &&
          current.token.basis.revision === revision &&
          current.rejected === rejected
        )
          return current;
        writerId ??= newId();
        writers.set(writerId, () => {
          stop();
          current = undefined;
        });
        const token = {
          ...scope,
          entityId,
          writerId,
          nonce: newId(),
          sequence: ++sequence,
          basis: { revision },
        };
        current = { doc, token, rejected, savedAt: new Date().toISOString() };
        merge(current);
        if (timer === undefined) timer = setTimeout(checkpoint, 300);
        return current;
      },
      cancel() {
        if (!current) return;
        const token = current.token;
        const key = lineage(token);
        const inProgress = [...writes.values()]
          .map((write) => write.token)
          .filter((written) => lineage(written) === key && written.sequence <= token.sequence);
        const copies = [token, nativeCopies.get(key), lastEmergency, ...inProgress];
        const pending = new Map<string, InputDraftToken>();
        for (const copy of copies) {
          if (copy && !find(entityId, copy.nonce)?.acknowledged) pending.set(copy.nonce, copy);
        }
        current = undefined;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        // Include writes that committed before IndexedDB delivered their complete callback.
        for (const copy of pending.values()) void finishToken(copy);
      },
      submitted(snapshot: InputDraftSnapshot) {
        submittedKey = keyOf(snapshot.token);
        receipts.set(submittedKey, snapshot);
        if (persistent) {
          void put(snapshot, { submitted: true }).then((result) => {
            if (result === undefined && current === snapshot) preserve();
          });
        }
      },
      preserve,
      stop,
      kept(slot: string) {
        const snapshot = find(entityId, slot);
        return snapshot !== undefined && hasCopy(snapshot.token);
      },
    };
  }

  return {
    scope,
    writer,
    hydrate,
    find,
    isLive: (token: InputDraftToken) => writers.has(token.writerId),
    isRetired(entityId: string, nonce: string) {
      const snapshot = find(entityId, nonce);
      return snapshot
        ? terminal(snapshot.token) || suppressed(snapshot)
        : retired.has(slotKey(entityId, nonce)) || isFinished(entityId, nonce);
    },
    outcome,
    finish,
    read(entityId: string) {
      const now = Date.now();
      const candidates: InputDraftSnapshot[] = [];
      for (const copies of rows.get(entityId)?.values() ?? []) {
        for (const draft of [copies.latest, copies.acknowledged]) {
          if (!draft || inputExpired(draft, now) || terminal(draft.token) || suppressed(draft))
            continue;
          candidates.push(draft);
          break;
        }
      }
      return candidates;
    },
  };
}
