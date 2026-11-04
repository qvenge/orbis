import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import { freezeNavigationHistory } from '../../app/history';
import { APP_VERSION } from '../../app/version';
import {
  bootstrapSharedSession,
  clearSharedSessionStorage,
  prepareSharedSessionGeneration,
  type SharedSession,
} from '../../auth/shared-session';
import { removeStoredAuth } from '../../auth/storage';
import {
  captureAuthHandoff,
  captureAuthRevoker,
  lockAuthCommit,
  normalAuthStorageKey,
  readAuthSession,
  recheckStoredAuth,
  retireAuthClient,
  type SessionState,
  setAuthClientScope,
  storedAuthOwner,
  subscribeAuthSession,
} from '../../auth/supabase';
import { stepsGeneration } from '../../features/entity-editor/arrows-stack';
import {
  clearDraftsIn,
  hydrateDrafts,
  listDraftsIn,
  setDraftScope,
} from '../../features/entity-editor/draft-storage';
import { destroyAllEditors } from '../../features/entity-editor/editor-cache';
import { resetUndoSession, setUndoOwner, undoEpoch } from '../../features/undo/undo-epoch';
import { configureNavigation } from '../../state/navigation';
import { freezeRetryBuffer, setRetryAdmission, setRetryScope } from '../../state/retry';
import { clearQueuedIn, listQueuedIn, queuedInputOwners } from '../retry-buffer/storage';
import {
  browserDeviceLock,
  createDeviceControl,
  DEVICE_ACCOUNT_PREFIX,
  DEVICE_CONTROL_KEY,
  type DeviceIntent,
} from './device-control';
import { browserInputStorage, configureInputAccess } from './input-access';
import {
  createLocalDataLifecycle,
  type LocalDataReason,
  type LocalDataScope,
  pendingInputVersions,
  type SnapshotRetry,
  snapshotPendingInputs,
} from './lifecycle';
import {
  type CountChallenge,
  installVisibleClientResponse,
  type PurgeChallenge,
  visibleClientsReport,
} from './visible-clients';

const anonymous = { status: 'anon', userId: null, token: null } as const;
const buildId = import.meta.env.VITE_BUILD_ID;
const waiting = 'Очистка ещё не завершена. Закройте или обновите другие вкладки Orbis и повторите.';
const canContinue = 'Не удалось проверить локальные данные. Повторите попытку.';
const handoffWaiting =
  'Общий режим выключен в другой вкладке. Ваш сеанс и ввод пока остались в этой вкладке.';
const handoffConflict =
  'В обычном режиме открыт другой аккаунт. Выйдите из него, чтобы перенести свой сеанс и ввод.';

type BrowserState = {
  phase: 'loading' | 'ready' | 'pending' | 'outdated';
  mode: 'normal' | 'shared';
  session: SessionState;
  scope: LocalDataScope | null;
  message?: string;
  canCancel?: boolean;
};
type RuntimeLease = { signal: AbortSignal; isCurrent(): boolean };
type CountedInput = Map<string, string[]>;
type CountEvidence = { count: number; version: string; ready: boolean };

async function ownerTag(owner: string, nonce: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce + owner));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function confirmWipe(reason: 'logout' | 'shared-on', evidence: CountEvidence) {
  if (reason === 'logout' && evidence.ready && !evidence.count) return true;
  const action = reason === 'logout' ? 'Выйти?' : 'Включить режим общего компьютера?';
  const known = `Неотправленных черновиков и записей: ${evidence.count}.`;
  const detail = evidence.ready
    ? 'Они будут удалены.'
    : 'Часть вкладок пока не ответила. Очистка начнётся после проверки.';
  return window.confirm(`${action} ${known} ${detail}`);
}

export function createBrowserLocalData() {
  // Access through the browser object lazily so a denied storage backend fails at bootstrap.
  const storage = {
    getItem: (key: string) => localStorage.getItem(key),
    setItem: (key: string, value: string) => localStorage.setItem(key, value),
    removeItem: (key: string) => localStorage.removeItem(key),
    keys: () => Object.keys(localStorage),
  };
  const device = createDeviceControl(storage, browserDeviceLock(navigator.locks));
  const listeners = new Set<() => void>();
  const freezes = new Set<() => void>();
  const seededGraphs = new Set<string>();
  let state: BrowserState = { phase: 'loading', mode: 'normal', session: anonymous, scope: null };
  let shared: SharedSession | undefined;
  let sharedGeneration: string | undefined;
  let release: (() => void) | undefined;
  let generation: string | undefined;
  let controller: AbortController | undefined;
  let runtimeLease: RuntimeLease | undefined;
  let started = false;
  let transitioning = false;
  let confirming = false;
  let retry: (() => Promise<void>) | undefined;
  let localIntent: DeviceIntent | undefined;
  let preservingLocally = false;
  let authClosed: Promise<void> | undefined;
  let handoff: ReturnType<typeof captureAuthHandoff>;
  let revoke: ReturnType<typeof captureAuthRevoker>;
  let peerOwner: string | undefined;
  let retainedOwner: string | undefined;
  let peerSnapshots: SnapshotRetry[] | undefined;
  let localOwner: string | undefined;
  let watchingAuth = false;
  let channel: BroadcastChannel | undefined;
  const documentVersion = crypto.randomUUID();
  const inputVersions = new Map<string, { slots: string; version: string }>();
  let consent: { challenge: CountChallenge; evidence: CountEvidence } | undefined;
  let cancelled = false;
  let compatibility: { generation: string; result: Promise<boolean> } | undefined;
  let rendered: BrowserState | undefined;
  let suspendedRoot: HTMLElement | null = null;
  let resumeValidated = false;

  function revealRenderedScope() {
    if (!suspendedRoot || !resumeValidated || rendered !== state) return;
    if (
      state.scope &&
      (!runtimeLease?.isCurrent() || readAuthSession().userId !== state.scope.accountId)
    )
      return;
    suspendedRoot.style.removeProperty('visibility');
    suspendedRoot = null;
  }

  async function verifyCompatibility(): Promise<boolean> {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/trpc/user.getSettings`, {
        headers: { [CLIENT_VERSION_HEADER]: APP_VERSION },
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 401) return false;
      const { error } = await response.json();
      return (
        error?.code === -32001 &&
        error.data?.code === 'UNAUTHORIZED' &&
        error.data.httpStatus === 401 &&
        error.data.path === 'user.getSettings'
      );
    } catch {
      return false;
    }
  }

  function publish(next: BrowserState) {
    state = next;
    for (const notify of listeners) notify();
  }

  function pending(message = waiting) {
    let canCancel = false;
    try {
      canCancel = device.read().pending?.phase === 'prepare';
    } catch {
      // Storage denied or unreadable.
    }
    publish({ ...state, phase: 'pending', scope: null, session: anonymous, message, canCancel });
  }

  function live(generationAtStart: string): boolean {
    try {
      return !!release && generation === generationAtStart && device.canUse(generationAtStart);
    } catch {
      return false;
    }
  }

  function sharedLive(at: string): boolean {
    try {
      const current = device.read();
      return (
        at === current.sharedGeneration &&
        (current.pending?.reason !== 'shared-on' || current.pending.phase === 'prepare')
      );
    } catch {
      return false;
    }
  }

  function announce(intent: DeviceIntent) {
    channel?.postMessage({ reason: intent.reason, generation: intent.generation });
  }

  function freeze(keepAuth: boolean, holdWriters = false) {
    const editors = stepsGeneration();
    controller?.abort();
    controller = undefined;
    runtimeLease = undefined;
    configureInputAccess(null);
    configureNavigation(null);
    freezeRetryBuffer();
    resetUndoSession();
    for (const stop of [...freezes]) stop();
    queueMicrotask(() => destroyAllEditors(editors));
    freezeNavigationHistory();
    if (!keepAuth) {
      authClosed = retireAuthClient();
      if (!holdWriters) releaseWriters();
    }
  }

  function releaseWriters() {
    const old = release;
    release = undefined;
    old?.();
  }

  function clearLocalShared(intent: DeviceIntent, owner?: string) {
    if (!shared || !owner || intent.accountId !== owner) return;
    if (intent.reason !== 'logout' && intent.reason !== 'unauthorized') return;
    const tab = browserInputStorage(sessionStorage);
    if (storedAuthOwner(tab, shared.authKey) === owner) removeStoredAuth(tab, shared.authKey);
    if (intent.reason === 'logout') {
      clearDraftsIn(tab, owner, shared.inputPrefix);
      clearQueuedIn(tab, owner, shared.inputPrefix);
    }
  }

  function purgeTab(challenge: PurgeChallenge): boolean {
    try {
      const intent = device.read().pending;
      if (
        intent?.generation !== challenge.generation ||
        intent.reason !== challenge.reason ||
        intent.phase !== 'wipe'
      )
        return false;
      if (intent.reason === 'shared-on') clearSharedSessionStorage();
      else clearLocalShared(intent, intent.accountId);
      return true;
    } catch {
      return false;
    }
  }

  function dropSharedSource(owner: string) {
    const source = shared?.storage;
    if (!shared || !source) return;
    clearDraftsIn(source, owner, shared.inputPrefix);
    clearQueuedIn(source, owner, shared.inputPrefix);
    if (storedAuthOwner(source, shared.authKey) === owner) removeStoredAuth(source, shared.authKey);
  }

  function sharedOwners(source: NonNullable<SharedSession['storage']>, prefix: string) {
    return new Set([
      ...listDraftsIn(source, undefined, prefix).map(({ accountId }) => accountId),
      ...queuedInputOwners(source, prefix),
    ]);
  }

  function tabInput(): CountedInput {
    const owners: CountedInput = new Map();
    const owner = state.scope?.accountId;
    const add = (id: string, slots: string[]) => {
      if (slots.length) owners.set(id, [...(owners.get(id) ?? []), ...slots]);
    };
    if (owner) add(owner, pendingInputVersions());
    const source =
      shared?.storage && sharedGeneration === device.read().sharedGeneration
        ? browserInputStorage(sessionStorage)
        : undefined;
    if (source && shared) {
      for (const { accountId, draft } of listDraftsIn(source, undefined, shared.inputPrefix))
        add(accountId, [draft.slot ?? draft.savedAt]);
      for (const accountId of queuedInputOwners(source, shared.inputPrefix))
        add(
          accountId,
          listQueuedIn(source, accountId, shared.inputPrefix).map(({ clientId }) => clientId),
        );
    }
    return owners;
  }

  async function countTab(challenge: CountChallenge) {
    const rows: [string, string[]][] = [];
    for (const [owner, slots] of tabInput())
      if (!challenge.ownerTag || (await ownerTag(owner, challenge.nonce)) === challenge.ownerTag)
        rows.push([owner, [...slots].sort()]);
    if (rows.length === 0) return { count: 0, version: documentVersion };
    const slots = JSON.stringify(rows.sort(([a], [b]) => a.localeCompare(b)));
    const key = challenge.ownerTag ?? '';
    const prior = inputVersions.get(key);
    const version = prior?.slots === slots ? prior.version : crypto.randomUUID();
    // The challenge nonce changes for every operation. Keep only the latest scoped entry.
    if (key)
      for (const old of inputVersions.keys()) if (old && old !== key) inputVersions.delete(old);
    inputVersions.set(key, { slots, version });
    return { count: rows.reduce((sum, [, values]) => sum + values.length, 0), version };
  }

  async function countForWipe(
    challenge: CountChallenge,
    accountId: string | undefined,
    current: () => boolean,
  ): Promise<CountEvidence> {
    const { countUnsent } = await import('./device-storage');
    const [disk, local, peers] = await Promise.all([
      countUnsent(storage, (owner) => device.inputGeneration(owner), accountId, current),
      countTab(challenge),
      visibleClientsReport(challenge),
    ]);
    const reports = peers.counts ?? [];
    return {
      count: disk.count + local.count + reports.reduce((sum, item) => sum + item.count, 0),
      version: JSON.stringify([disk.version, local, reports.map(({ version }) => version).sort()]),
      ready: peers.ready && peers.counts !== undefined,
    };
  }

  function checkSharedRevocation() {
    const source = shared?.storage;
    if (!shared || !source) return;
    const prefix = shared.inputPrefix;
    for (const owner of sharedOwners(source, prefix)) {
      const inputEpoch = source.getItem(`${prefix}input-epoch:${owner}`);
      if ((inputEpoch ?? '0:0') !== device.inputGeneration(owner)) {
        clearDraftsIn(source, owner, prefix);
        clearQueuedIn(source, owner, prefix);
      }
    }
    const owner = storedAuthOwner(source, shared.authKey);
    if (
      owner &&
      (source.getItem(`${prefix}auth-epoch:${owner}`) ?? '0') !== device.authGeneration(owner)
    ) {
      removeStoredAuth(source, shared.authKey);
    }
  }

  function retainedSharedOwner() {
    if (!shared?.storage) return;
    const source = shared.storage;
    checkSharedRevocation();
    return (
      storedAuthOwner(source, shared.authKey) ??
      sharedOwners(source, shared.inputPrefix).values().next().value
    );
  }

  async function enter(resetAuth = true) {
    const current = device.read();
    if (current.pending) {
      retry = retryCurrentDevice;
      pending();
      return;
    }
    if (!device.acceptsBuild(buildId, current)) {
      const rejected = current.rejectedBuilds?.includes(buildId);
      if (!rejected && compatibility?.generation !== current.generation) {
        compatibility = {
          generation: current.generation,
          result: verifyCompatibility().then(
            (verified) => verified && device.confirmCompatibleBuild(buildId, current),
          ),
        };
      }
      const compatible = !rejected && (await compatibility?.result);
      if (!device.canUse(current.generation)) {
        retry = retryCurrentDevice;
        return pending();
      }
      if (!compatible) {
        publish({ phase: 'outdated', mode: current.mode, session: anonymous, scope: null });
        return;
      }
    }
    if (current.mode === 'normal' && resetAuth && current.sharedGeneration !== '0') {
      const at = current.sharedGeneration;
      const hadLineage = prepareSharedSessionGeneration(at);
      if (!shared && hadLineage) {
        shared = await bootstrapSharedSession(normalAuthStorageKey, () => sharedLive(at));
        sharedGeneration = at;
      }
      if (shared?.storage && sharedGeneration === at) {
        const completed = current.completedSharedOff;
        if (
          completed?.generation === current.generation &&
          completed.tabKey === shared.authKey &&
          shared.isCurrent() &&
          device.canUse(current.generation)
        )
          dropSharedSource(completed.accountId);
        retainedOwner = retainedSharedOwner();
      }
      if (shared && sharedGeneration === at && retainedOwner) {
        checkSharedRevocation();
        retry = continueRetained;
        pending(handoffWaiting);
        return;
      }
      retainedOwner = undefined;
    }
    if (!release) {
      const acquired = await device.holdWriters();
      if (!device.canUse(current.generation)) {
        acquired();
        pending();
        return;
      }
      release = acquired;
    }
    generation = current.generation;
    if (resetAuth) {
      if (current.mode === 'shared' && (!shared || sharedGeneration !== current.sharedGeneration)) {
        shared?.close();
        const at = current.sharedGeneration;
        prepareSharedSessionGeneration(at);
        shared = await bootstrapSharedSession(normalAuthStorageKey, () => sharedLive(at));
        sharedGeneration = at;
        retainedOwner = undefined;
      }
      if (current.mode === 'normal') {
        shared?.close();
        shared = undefined;
      }
      checkSharedRevocation();
      const lease = shared;
      await setAuthClientScope({
        storageKey: lease?.authKey ?? normalAuthStorageKey,
        backend: lease ? lease.storage : storage,
        isCurrent: () => live(current.generation) && (!lease || lease.isCurrent()),
      });
    }
    if (!live(current.generation)) {
      pending();
      return;
    }
    publish({ phase: 'ready', mode: current.mode, session: readAuthSession(), scope: null });
    if (!watchingAuth) {
      watchingAuth = true;
      subscribeAuthSession(observeAuth);
    }
    observeAuth();
  }

  async function continueRetained() {
    const owner = retainedOwner;
    const source = shared?.storage;
    if (transitioning || !owner || !shared || !source) return;
    transitioning = true;
    let hold: (() => void) | undefined;
    try {
      const now = device.read();
      if (now.pending || now.mode !== 'normal') return pending(handoffWaiting);
      const current = () => device.canUse(now.generation) && !!shared?.isCurrent();
      const canTransfer = () => {
        const normal = storedAuthOwner(storage, normalAuthStorageKey);
        return normal === owner || storage.getItem(normalAuthStorageKey) === null;
      };
      if (!canTransfer()) return pending(handoffConflict);
      if (!window.confirm('Перенести сеанс и неотправленный ввод этой вкладки в обычный режим?'))
        return;
      hold = await device.holdWriters();
      if (!current() || !canTransfer()) return pending(handoffConflict);
      checkSharedRevocation();
      const session = captureAuthHandoff(source, shared.authKey);
      const { preserveSharedInput } = await import('./device-storage');
      const ok = await preserveSharedInput(
        source,
        shared.inputPrefix,
        storage,
        owner,
        device.inputGeneration(owner),
        current,
      );
      if (!ok || !current()) return pending(canContinue);
      if (!canTransfer()) return pending(handoffConflict);
      const stored = await lockAuthCommit(
        normalAuthStorageKey,
        () =>
          current() &&
          canTransfer() &&
          (storage.getItem(normalAuthStorageKey) !== null ||
            !session ||
            session.persistTo(storage, normalAuthStorageKey, current)),
      );
      if (!stored || !current()) return pending(handoffConflict);
      dropSharedSource(owner);
      retainedOwner = undefined;
      retry = undefined;
      await enter();
    } catch {
      pending(canContinue);
    } finally {
      hold?.();
      transitioning = false;
      observeAuth();
    }
  }

  function admit(session: SessionState) {
    const owner = session.userId;
    if (!owner || !generation || !live(generation)) {
      if (!owner) publish({ ...state, session, scope: null });
      return;
    }
    if (state.scope?.accountId === owner && runtimeLease?.isCurrent()) {
      publish({ ...state, session });
      return;
    }
    setUndoOwner(owner);
    const scope: LocalDataScope = { accountId: owner, graphId: owner, epoch: undoEpoch() };
    const at = generation;
    const inputAt = device.inputGeneration(owner);
    const abort = new AbortController();
    controller = abort;
    const isCurrent = () => !abort.signal.aborted && live(at);
    runtimeLease = { signal: abort.signal, isCurrent };
    const backend = shared ? shared.storage : storage;
    configureInputAccess(
      backend
        ? {
            storage: backend,
            prefix: shared?.inputPrefix ?? '',
            drafts: {
              scope: { accountId: owner, graphId: scope.graphId, generation: inputAt },
              persistent: !shared,
              signal: abort.signal,
            },
            isCurrent: () => !abort.signal.aborted && device.canPreserveInput(owner, inputAt),
            canPreserve: () => device.canPreserveInput(owner, inputAt),
          }
        : null,
    );
    setDraftScope(owner);
    void hydrateDrafts();
    setRetryScope(owner);
    configureNavigation({ ...scope, generation: at, shared: !!shared, isCurrent });
    if (!shared) {
      // Account discovery normally comes from native IndexedDB, with this metadata as fallback.
      try {
        storage.setItem(DEVICE_ACCOUNT_PREFIX + owner, '1');
      } catch {
        // Destructive cleanup will refuse an incomplete inventory.
      }
    } else if (shared.storage) {
      shared.storage.setItem(`${shared.inputPrefix}input-epoch:${owner}`, inputAt);
      shared.storage.setItem(
        `${shared.inputPrefix}auth-epoch:${owner}`,
        device.authGeneration(owner),
      );
    }
    publish({ ...state, session, scope });
  }

  function observeAuth() {
    if (state.phase !== 'ready' || transitioning || !generation || !live(generation)) return;
    const session = readAuthSession();
    if (session.status === 'loading') return;
    if (state.scope && state.scope.accountId !== session.userId) {
      void run(session.userId ? 'account-switch' : 'unauthorized', state.scope);
    } else {
      admit(session);
    }
  }

  const lifecycle = createLocalDataLifecycle(async (transition) => {
    preservingLocally = false;
    if (transition.reason === 'account-switch') return;
    releaseWriters();
    localIntent = await device.begin({
      reason: transition.reason,
      ...(transition.reason === 'outdated' && { buildId }),
      ...(transition.reason === 'shared-off' && shared && { tabKey: shared.authKey }),
      ...(transition.oldScope && {
        accountId: transition.oldScope.accountId,
        graphId: transition.oldScope.graphId,
      }),
    });
    announce(localIntent);
  });

  lifecycle.register({
    snapshot: snapshotPendingInputs,
    freeze(transition) {
      localOwner = transition.oldScope?.accountId;
      preservingLocally = true;
      if (transition.reason === 'shared-off') handoff = captureAuthHandoff();
      if (transition.reason === 'logout') revoke = captureAuthRevoker();
      freeze(transition.reason === 'account-switch', preservingLocally);
      pending();
    },
    async clear(transition) {
      if (transition.reason === 'account-switch') return 'deleted';
      const intent = localIntent;
      if (!intent) return 'failed';
      await authClosed;
      const result = await finish(intent);
      if (result === 'cancelled') {
        cancelled = true;
        return 'deleted';
      }
      return result;
    },
  });

  function finish(intent: DeviceIntent) {
    return device.finish(
      intent,
      () => clear(intent),
      () => authorizeWipe(intent),
    );
  }

  async function authorizeWipe(intent: DeviceIntent) {
    const isCurrent = () => device.read().pending?.generation === intent.generation;
    if (intent.reason === 'shared-on' || intent.reason === 'logout') {
      const target = intent.reason === 'logout' ? intent.accountId : undefined;
      const nonce = crypto.randomUUID();
      const challenge = consent?.challenge ?? {
        nonce,
        ...(target && { ownerTag: await ownerTag(target, nonce) }),
      };
      const evidence = await countForWipe(challenge, target, isCurrent);
      if (!evidence.ready) return 'blocked' as const;
      if (
        (!consent?.evidence.ready || evidence.version !== consent.evidence.version) &&
        !confirmWipe(intent.reason, evidence)
      )
        return 'cancelled' as const;
      consent = { challenge, evidence };
      return 'wipe' as const;
    }
    return 'blocked' as const;
  }

  async function clear(intent: DeviceIntent) {
    const isCurrent = () => device.read().pending?.generation === intent.generation;
    const operations = await import('./device-storage');
    if (intent.reason === 'shared-off') {
      if (
        !shared?.isCurrent() ||
        !intent.accountId ||
        !handoff ||
        handoff.userId !== intent.accountId ||
        intent.tabKey !== shared.authKey
      ) {
        return 'blocked' as const;
      }
      const source = shared.storage;
      if (
        source &&
        !(await operations.preserveSharedInput(
          source,
          shared.inputPrefix,
          storage,
          intent.accountId,
          device.inputGeneration(intent.accountId),
          isCurrent,
        ))
      )
        return 'failed' as const;
      const captured = handoff;
      if (
        !(await lockAuthCommit(normalAuthStorageKey, () =>
          captured.persistTo(storage, normalAuthStorageKey, isCurrent),
        ))
      )
        return 'failed' as const;
      return 'deleted' as const;
    }
    // A shared graph has no persisted responses. Do not create an empty cache to clear it.
    if (intent.reason === 'seeded' && device.read().mode === 'shared') return 'deleted' as const;
    const result = await operations.clearDeviceStorage(
      storage,
      normalAuthStorageKey,
      intent,
      isCurrent,
    );
    if (result !== 'deleted') return result;
    if (intent.reason === 'shared-on' || intent.reason === 'logout') {
      const peers = await visibleClientsReport(undefined, {
        reason: intent.reason,
        generation: intent.generation,
      });
      if (!peers.ready) return 'blocked' as const;
    } else {
      clearLocalShared(intent, localOwner);
    }
    return result;
  }

  async function run(reason: LocalDataReason, oldScope: LocalDataScope | null): Promise<void> {
    if (transitioning) return;
    transitioning = true;
    retry = () => run(reason, oldScope);
    try {
      await lifecycle.transitionLocalData(reason, oldScope);
      if (localIntent) announce(localIntent);
      localIntent = undefined;
      retry = undefined;
      consent = undefined;
      localOwner = undefined;
      const remote = cancelled ? undefined : revoke;
      cancelled = false;
      revoke = undefined;
      handoff = undefined;
      if (reason === 'outdated') {
        publish({ ...state, phase: 'outdated' });
      } else {
        await enter(reason !== 'account-switch');
      }
      if (remote)
        void remote().catch(() => {
          if (!state.scope)
            publish({
              ...state,
              message: 'Данные удалены с устройства. Не удалось завершить сеанс на сервере.',
            });
        });
    } catch {
      pending();
    } finally {
      transitioning = false;
      observeAuth();
      if (!preservingLocally) {
        try {
          const now = device.read();
          if (
            now.generation !== (localIntent?.generation ?? generation) &&
            state.phase !== 'outdated'
          )
            void syncDevice();
        } catch {
          // The pending screen retains the explicit retry when device storage is unavailable.
        }
      }
    }
  }

  async function resumeIntent(intent: DeviceIntent) {
    if (transitioning) return;
    transitioning = true;
    retry = retryCurrentDevice;
    try {
      const result = await finish(intent);
      if (result !== 'deleted' && result !== 'cancelled') return pending();
      announce(intent);
      retry = undefined;
      consent = undefined;
      lifecycle.forgetCompletedElsewhere();
      localIntent = undefined;
      await enter();
    } catch {
      pending();
    } finally {
      transitioning = false;
      observeAuth();
    }
  }

  function retryCurrentDevice() {
    return syncDevice(true);
  }

  async function syncDevice(resumePending = false) {
    if (transitioning || preservingLocally || state.phase === 'outdated') return;
    try {
      const now = device.read();
      if (now.generation === generation && !now.pending && state.phase === 'ready') return;
      if (release) {
        peerOwner ??= state.scope?.accountId;
        const intent = now.pending;
        if (intent?.reason === 'shared-off' && shared && peerOwner) retainedOwner = peerOwner;
        if (peerOwner && intent?.phase !== 'wipe') peerSnapshots ??= snapshotPendingInputs();
        else peerSnapshots = [];
        peerSnapshots = peerSnapshots.filter((commit) => !commit());
        if (peerSnapshots.length) {
          freeze(false, true);
          retry = syncDevice;
          return pending('Не удалось сохранить несохранённый текст. Освободите место и повторите.');
        }
        peerSnapshots = undefined;
        freeze(false);
        pending();
      }
      if (now.pending) {
        const intent = now.pending;
        retry = retryCurrentDevice;
        if (resumePending) return await resumeIntent(intent);
        pending();
        return;
      }
      transitioning = true;
      await authClosed;
      peerOwner = undefined;
      retry = undefined;
      lifecycle.forgetCompletedElsewhere();
      localIntent = undefined;
      localOwner = undefined;
      handoff = undefined;
      revoke = undefined;
      consent = undefined;
      await enter();
    } catch {
      retry = syncDevice;
      pending(canContinue);
    } finally {
      transitioning = false;
      observeAuth();
    }
  }

  async function request(reason: 'logout' | 'shared-on' | 'shared-off') {
    if (state.phase !== 'ready' || !state.scope || transitioning || confirming) return;
    const scope = state.scope;
    if (reason === 'shared-off') return run(reason, scope);
    confirming = true;
    try {
      const target = reason === 'logout' ? scope.accountId : undefined;
      const current = () => state.scope === scope && !!runtimeLease?.isCurrent();
      const nonce = crypto.randomUUID();
      const challenge = { nonce, ...(target && { ownerTag: await ownerTag(target, nonce) }) };
      const evidence = await countForWipe(challenge, target, current);
      if (!current()) return;
      if (!confirmWipe(reason, evidence)) return;
      const checked = await countForWipe(challenge, target, current);
      if (!current()) return;
      if (checked.version !== evidence.version || checked.ready !== evidence.ready) {
        publish({
          ...state,
          message: 'Неотправленные данные изменились. Проверьте новый счёт и повторите.',
        });
        return;
      }
      consent = { challenge, evidence: checked };
      await run(reason, scope);
    } catch {
      if (state.scope === scope) publish({ ...state, message: canContinue });
    } finally {
      confirming = false;
    }
  }

  return {
    async start() {
      if (started) return;
      started = true;
      transitioning = true;
      setRetryAdmission(() => !!this.getToken());
      installVisibleClientResponse(countTab, purgeTab);
      try {
        channel =
          typeof BroadcastChannel === 'undefined'
            ? undefined
            : new BroadcastChannel('orbis:local-data');
        channel?.addEventListener('message', () => void syncDevice());
        window.addEventListener('storage', (event) => {
          if (event.key === DEVICE_CONTROL_KEY || event.key === null) void syncDevice();
        });
        window.addEventListener('pagehide', (event) => {
          if (!event.persisted) return;
          suspendedRoot = document.getElementById('root');
          resumeValidated = false;
          suspendedRoot?.style.setProperty('visibility', 'hidden');
        });
        window.addEventListener('pageshow', (event) => {
          if (!event.persisted) {
            void syncDevice();
            return;
          }
          try {
            // A later document in this same tab may have purged the inherited
            // marker. Restore the parked lease before asking the SDK for its owner.
            shared?.restoreFromPageCache(event);
            recheckStoredAuth();
          } finally {
            void syncDevice().finally(() => {
              resumeValidated = true;
              revealRenderedScope();
            });
          }
        });
        const now = device.read();
        if (now.pending) {
          const intent = now.pending;
          if (
            (intent.reason !== 'shared-on' || intent.phase === 'prepare') &&
            now.sharedGeneration !== '0' &&
            prepareSharedSessionGeneration(now.sharedGeneration)
          ) {
            const at = now.sharedGeneration;
            shared = await bootstrapSharedSession(normalAuthStorageKey, () => sharedLive(at));
            sharedGeneration = at;
            const owner = shared.storage
              ? storedAuthOwner(shared.storage, shared.authKey)
              : undefined;
            if (
              intent.reason === 'shared-off' &&
              shared.authKey === intent.tabKey &&
              shared.storage
            ) {
              handoff = captureAuthHandoff(shared.storage, shared.authKey);
              localOwner = handoff?.userId;
            } else if (now.mode === 'normal') retainedOwner = owner;
            else peerOwner = owner;
          }
          retry = () => resumeIntent(intent);
          pending();
        } else {
          await enter();
        }
      } catch {
        retry = syncDevice;
        pending(canContinue);
      } finally {
        transitioning = false;
        observeAuth();
        if (state.phase === 'ready' && generation && !live(generation)) void syncDevice();
      }
    },
    getState: () => state,
    didRender(renderedState: BrowserState) {
      rendered = renderedState;
      revealRenderedScope();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    registerRuntimeFreeze(callback: () => void) {
      freezes.add(callback);
      return () => {
        freezes.delete(callback);
      };
    },
    getLease: () => runtimeLease,
    getToken() {
      const raw = readAuthSession();
      return raw.status === 'authed' &&
        raw.expiresAt &&
        raw.expiresAt > Date.now() &&
        raw.userId === state.scope?.accountId &&
        runtimeLease?.isCurrent()
        ? raw.token
        : null;
    },
    request,
    async retry() {
      await retry?.();
    },
    async cancel() {
      const intent = device.read().pending;
      if (!intent || !(await device.cancel(intent))) return;
      announce(intent);
      await syncDevice();
    },
    unauthorized: () => state.scope && run('unauthorized', state.scope),
    outdated: () => run('outdated', state.scope),
    canSeed(scope: LocalDataScope) {
      return (
        scope === state.scope && !!runtimeLease?.isCurrent() && !seededGraphs.has(scope.graphId)
      );
    },
    seeded(scope: LocalDataScope) {
      if (scope === state.scope && runtimeLease?.isCurrent() && !seededGraphs.has(scope.graphId)) {
        seededGraphs.add(scope.graphId);
        return run('seeded', scope);
      }
    },
  };
}

export type BrowserLocalData = ReturnType<typeof createBrowserLocalData>;
