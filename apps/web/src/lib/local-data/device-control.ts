import type { StorageAccess } from '../../auth/storage';
import type { LocalDataReason } from './lifecycle';

export const DEVICE_CONTROL_KEY = 'orbis:local-data:device:v1';
export const DEVICE_ACCOUNT_PREFIX = 'orbis:local-data:account:';
const WRITERS = 'orbis:local-data:writers';
const TRANSITION = 'orbis:local-data:transition';
const BARRIER_TIMEOUT_MS = 2500;
const reasons = new Set([
  'logout',
  'unauthorized',
  'outdated',
  'seeded',
  'shared-on',
  'shared-off',
]);

type Request = {
  reason: Exclude<LocalDataReason, 'account-switch'>;
  accountId?: string;
  graphId?: string;
  tabKey?: string;
  buildId?: string;
};
export type DeviceIntent = Request & { generation: string; phase?: 'prepare' | 'wipe' };
type Control = {
  mode: 'normal' | 'shared';
  generation: string;
  /** Changes only when inputs throughout the device were explicitly discarded. */
  inputGeneration: string;
  /** Existing shared namespaces survive OFF until their own tab can hand off. */
  sharedGeneration: string;
  accountInput: Record<string, string>;
  accountAuth?: Record<string, string>;
  rejectedBuilds?: string[];
  rejectionGeneration?: string;
  compatibleBuilds?: string[];
  completedSharedOff?: { generation: string; tabKey: string; accountId: string };
  cancelledGeneration?: string;
  pending?: DeviceIntent;
};

type WipeResult = 'deleted' | 'blocked' | 'failed' | 'cancelled';
type LockMode = 'shared' | 'exclusive';
export type DeviceLock = <T>(
  name: string,
  mode: LockMode,
  action: () => T | Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

const initial: Control = {
  mode: 'normal',
  generation: '0',
  inputGeneration: '0',
  sharedGeneration: '0',
  accountInput: {},
};

export function browserDeviceLock(locks: LockManager | undefined): DeviceLock | undefined {
  if (locks)
    return async (name, mode, action, signal) =>
      await locks.request(name, { mode, ...(signal && { signal }) }, action);
}

export function createDeviceControl(storage: StorageAccess, lock?: DeviceLock) {
  function read(): Control {
    const raw = storage.getItem(DEVICE_CONTROL_KEY);
    if (raw === null) return initial;
    const value = JSON.parse(raw) as Control;
    if (
      !value ||
      (value.mode !== 'normal' && value.mode !== 'shared') ||
      typeof value.generation !== 'string' ||
      typeof value.inputGeneration !== 'string' ||
      typeof value.sharedGeneration !== 'string' ||
      !value.accountInput ||
      typeof value.accountInput !== 'object' ||
      (value.pending &&
        (!reasons.has(value.pending.reason) || value.pending.generation !== value.generation))
    )
      throw new Error('Не удалось прочитать настройки локальных данных');
    return value;
  }

  function write(value: Control) {
    storage.setItem(DEVICE_CONTROL_KEY, JSON.stringify(value));
  }

  function inputGeneration(accountId: string, state = read()): string {
    return `${state.inputGeneration}:${Object.hasOwn(state.accountInput, accountId) ? state.accountInput[accountId] : '0'}`;
  }

  function rejectionGeneration(state: Control): string {
    return state.rejectionGeneration ?? state.generation;
  }

  function acceptsBuild(id: string, state = read()): boolean {
    if (state.rejectedBuilds?.includes(id)) return false;
    return !state.rejectedBuilds?.length || !!state.compatibleBuilds?.includes(id);
  }

  async function confirmCompatibleBuild(id: string, observed: Control): Promise<boolean> {
    if (!lock) return false;
    return lock(TRANSITION, 'exclusive', () => {
      const state = read();
      const epoch = rejectionGeneration(state);
      if (
        state.pending ||
        state.generation !== observed.generation ||
        epoch !== rejectionGeneration(observed) ||
        state.rejectedBuilds?.includes(id)
      )
        return false;
      if (!acceptsBuild(id, state))
        write({
          ...state,
          rejectionGeneration: epoch,
          compatibleBuilds: [...(state.compatibleBuilds ?? []), id],
        });
      return true;
    });
  }

  async function begin(request: Request): Promise<DeviceIntent> {
    if (!lock) throw new Error('Этот браузер не может подтвердить остановку записи во вкладках');
    return lock(TRANSITION, 'exclusive', () => {
      let state = read();
      if (
        request.reason === 'outdated' &&
        request.buildId &&
        !state.rejectedBuilds?.includes(request.buildId)
      ) {
        state = {
          ...state,
          rejectedBuilds: [...(state.rejectedBuilds ?? []), request.buildId],
          rejectionGeneration: crypto.randomUUID(),
          compatibleBuilds: undefined,
        };
        if (state.pending) write(state);
      }
      if (state.pending) {
        const old = state.pending;
        if (
          old.reason === request.reason &&
          old.accountId === request.accountId &&
          old.graphId === request.graphId &&
          old.tabKey === request.tabKey
        )
          return old;
        throw new Error('Другая очистка ещё не завершена');
      }
      if (
        (request.reason === 'shared-on' && state.mode === 'shared') ||
        (request.reason === 'shared-off' && state.mode === 'normal')
      ) {
        throw new Error('Режим уже изменился');
      }
      const pending: DeviceIntent = {
        ...request,
        generation: crypto.randomUUID(),
        ...((request.reason === 'logout' || request.reason === 'shared-on') && {
          phase: 'prepare',
        }),
      };
      write({ ...state, generation: pending.generation, pending });
      return pending;
    });
  }

  async function finish(
    intent: DeviceIntent,
    clear: () => Promise<WipeResult>,
    authorize?: () => Promise<'wipe' | 'blocked' | 'cancelled'>,
  ): Promise<WipeResult> {
    if (!lock) return 'blocked';
    return lock(TRANSITION, 'exclusive', async () => {
      const state = read();
      if (state.generation !== intent.generation) return 'failed';
      if (!state.pending)
        return state.cancelledGeneration === intent.generation ? 'cancelled' : 'deleted';
      if (
        state.pending.reason !== intent.reason ||
        state.pending.accountId !== intent.accountId ||
        state.pending.graphId !== intent.graphId ||
        state.pending.tabKey !== intent.tabKey
      )
        return 'failed';
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), BARRIER_TIMEOUT_MS);
      try {
        return await lock(
          WRITERS,
          'exclusive',
          async () => {
            clearTimeout(timeout);
            const { pending: _pending, ...previous } = state;
            if (state.pending?.phase === 'prepare') {
              const consent = await authorize?.();
              if (consent === 'cancelled') {
                write({ ...previous, cancelledGeneration: intent.generation });
                return 'cancelled';
              }
              if (consent !== 'wipe') return 'blocked';
              write({ ...state, pending: { ...state.pending, phase: 'wipe' } });
            }
            const outcome = await clear();
            if (outcome !== 'deleted') return outcome;
            const next: Control = { ...previous };
            if (intent.reason === 'shared-on') {
              next.mode = 'shared';
              next.sharedGeneration = intent.generation;
              next.inputGeneration = intent.generation;
              next.accountInput = {};
              next.accountAuth = {};
              next.completedSharedOff = undefined;
            } else if (intent.reason === 'shared-off') {
              next.mode = 'normal';
              if (intent.tabKey && intent.accountId)
                next.completedSharedOff = {
                  generation: intent.generation,
                  tabKey: intent.tabKey,
                  accountId: intent.accountId,
                };
            } else if (intent.reason === 'logout' && intent.accountId) {
              next.accountInput = { ...state.accountInput, [intent.accountId]: intent.generation };
            }
            if (
              (intent.reason === 'logout' || intent.reason === 'unauthorized') &&
              intent.accountId
            ) {
              next.accountAuth = { ...state.accountAuth, [intent.accountId]: intent.generation };
            }
            write(next);
            return 'deleted';
          },
          abort.signal,
        );
      } catch {
        return abort.signal.aborted ? 'blocked' : 'failed';
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  async function holdWriters(): Promise<() => void> {
    if (!lock) return () => {};
    return new Promise((resolve, reject) => {
      let release!: () => void;
      const lifetime = new Promise<void>((done) => {
        release = done;
      });
      void lock(WRITERS, 'shared', () => {
        resolve(release);
        return lifetime;
      }).catch(reject);
    });
  }

  async function cancel(intent: DeviceIntent): Promise<boolean> {
    if (!lock) return false;
    return lock(TRANSITION, 'exclusive', () => {
      const { pending, ...state } = read();
      if (pending?.generation !== intent.generation || pending.phase !== 'prepare') return false;
      write({ ...state, cancelledGeneration: intent.generation });
      return true;
    });
  }

  return {
    read,
    begin,
    finish,
    cancel,
    acceptsBuild,
    confirmCompatibleBuild,
    holdWriters,
    inputGeneration,
    authGeneration(accountId: string) {
      const entries = read().accountAuth;
      return entries && Object.hasOwn(entries, accountId) ? (entries[accountId] ?? '0') : '0';
    },
    canUse(generation: string) {
      const current = read();
      return current.generation === generation && !current.pending;
    },
    canPreserveInput(accountId: string, generation: string) {
      const current = read();
      return (
        inputGeneration(accountId, current) === generation &&
        (current.pending?.phase === 'prepare' ||
          (current.pending?.reason !== 'shared-on' &&
            !(current.pending?.reason === 'logout' && current.pending.accountId === accountId)))
      );
    },
  };
}
