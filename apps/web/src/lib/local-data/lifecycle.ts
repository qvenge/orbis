export type LocalDataScope = Readonly<{ accountId: string; graphId: string; epoch: number }>;

const policies = {
  logout: { responses: 'account', input: 'account' },
  unauthorized: { responses: 'account', input: 'keep' },
  'account-switch': { responses: 'close', input: 'keep' },
  outdated: { responses: 'account', input: 'keep' },
  seeded: { responses: 'graph', input: 'keep' },
  'shared-on': { responses: 'device', input: 'device' },
  'shared-off': { responses: 'close', input: 'keep' },
} as const;

export type LocalDataReason = keyof typeof policies;
type Policy = (typeof policies)[LocalDataReason];

export type LocalDataTransition = Readonly<{
  reason: LocalDataReason;
  oldScope: LocalDataScope | null;
  newScope?: LocalDataScope;
}> &
  Policy;

export type SnapshotRetry = () => boolean;

type Cleanup = 'deleted' | 'blocked' | 'failed' | undefined;

export type LocalDataParticipant = {
  /** Save dirty input before freezing, including preparation of a cancellable wipe. */
  snapshot?: (transition: LocalDataTransition) => SnapshotRetry[] | undefined;
  /** Revoke admission and cancel producers synchronously, before any asynchronous work. */
  freeze?: (transition: LocalDataTransition) => void;
  /** Authorised cleanup after the external durable fence. Must support retries. */
  clear?: (transition: LocalDataTransition) => Cleanup | Promise<Cleanup>;
};

export class LocalDataCleanupError extends Error {
  constructor(readonly status: 'blocked' | 'failed' | 'pending') {
    super(`Local data transition: ${status}`);
  }
}

type Work = {
  transition: LocalDataTransition;
  participants: Set<LocalDataParticipant>;
  prepared: boolean;
  preparationError?: { cause: unknown };
  snapshots: SnapshotRetry[];
  fenced: boolean;
  running?: Promise<void>;
};

function sameScope(a?: LocalDataScope | null, b?: LocalDataScope | null) {
  return (
    a === b ||
    (a && b && a.accountId === b.accountId && a.graphId === b.graphId && a.epoch === b.epoch)
  );
}

/** One coordinator per application. Only a completed transition may admit the next scope. */
export function createLocalDataLifecycle(
  fence: (transition: LocalDataTransition) => void | Promise<void>,
) {
  const participants = new Set<LocalDataParticipant>();
  let work: Work | undefined;

  function prepare(task: Work) {
    const { transition } = task;
    const phases = ['snapshot', 'freeze'] as const;
    for (const phase of phases) {
      for (const participant of task.participants) {
        try {
          const captured = participant[phase]?.(transition);
          if (captured) task.snapshots.push(...captured);
        } catch (cause) {
          task.preparationError ??= { cause };
        }
      }
    }
    task.prepared = true;
  }

  async function execute(task: Work) {
    if (!task.prepared) prepare(task);
    if (task.preparationError) throw task.preparationError.cause;
    task.snapshots = task.snapshots.filter((commit) => !commit());
    if (task.snapshots.length > 0)
      throw new Error('Не удалось сохранить несохранённый текст перед переходом');
    if (!task.fenced) {
      await fence(task.transition);
      task.fenced = true;
    }
    for (const participant of task.participants) {
      const result = await participant.clear?.(task.transition);
      if (result === 'blocked' || result === 'failed') throw new LocalDataCleanupError(result);
      task.participants.delete(participant);
    }
  }

  function transitionLocalData(
    reason: LocalDataReason,
    oldScope: LocalDataScope | null,
    newScope?: LocalDataScope,
  ): Promise<void> {
    if (
      work &&
      (work.transition.reason !== reason ||
        !sameScope(work.transition.oldScope, oldScope) ||
        !sameScope(work.transition.newScope, newScope))
    ) {
      return Promise.reject(new LocalDataCleanupError('pending'));
    }

    work ??= {
      transition: {
        reason,
        oldScope: oldScope && { ...oldScope },
        ...(newScope && { newScope: { ...newScope } }),
        ...policies[reason],
      },
      participants: new Set(participants),
      prepared: false,
      snapshots: [],
      fenced: false,
    };
    const task = work;
    if (task.running) return task.running;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    task.running = new Promise((done, failed) => {
      resolve = done;
      reject = failed;
    });
    void execute(task).then(
      () => {
        work = undefined;
        resolve();
      },
      (error: unknown) => {
        delete task.running;
        reject(error);
      },
    );
    return task.running;
  }

  return {
    register(participant: LocalDataParticipant) {
      participants.add(participant);
      return () => {
        participants.delete(participant);
      };
    },
    forgetCompletedElsewhere() {
      if (!work?.running) work = undefined;
    },
    transitionLocalData,
  };
}

export type LocalDataLifecycle = ReturnType<typeof createLocalDataLifecycle>;

type PendingInput = {
  pending(): object | undefined;
  preserve(): SnapshotRetry | undefined;
};

const liveInput = new Set<PendingInput>();

/** Editors register their actual in-memory slot, including the debounce window. */
export function registerPendingInput(input: PendingInput): () => void {
  liveInput.add(input);
  return () => {
    liveInput.delete(input);
  };
}

const inputVersions = new WeakMap<object, string>();

export function pendingInputVersions(): string[] {
  const versions = [];
  for (const slot of liveInput) {
    const value = slot.pending();
    if (!value) continue;
    let version = inputVersions.get(value);
    if (!version) {
      version = crypto.randomUUID();
      inputVersions.set(value, version);
    }
    versions.push(version);
  }
  return versions;
}

export function snapshotPendingInputs(): SnapshotRetry[] {
  return [...liveInput].map((slot) => slot.preserve()).filter((commit) => commit !== undefined);
}
