import {
  hashKey,
  type Query,
  type QueryClient,
  type QueryKey,
  replaceEqualDeep,
} from '@tanstack/react-query';
import type { createFreshnessRuntime } from './runtime';
import type { FreshnessScope } from './transport';

export type NetworkReadReceipt = Readonly<{
  epoch: number;
  watermark: string | null;
  receivedAt: number;
  startedAt?: number;
  startedSequence: number;
}>;

export type ReadOrigin =
  | { source: 'network'; receipt: NetworkReadReceipt }
  | { source: 'disk'; receivedAt: number; fragmentTimes?: Readonly<Record<string, number>> }
  | { source: 'optimistic' };

export type ReadPublication = ReadOrigin & {
  scope: FreshnessScope;
  key: QueryKey;
  queryHash: string;
  raw: unknown;
};

export type BodyResult = {
  bodyRevision: number;
  body?: string | null;
  bodyDoc?: unknown;
  bodyAction?: unknown;
  bodyChangedAt?: string;
};

export type BodyPublication = {
  entityId: string;
  expectedBodyRevision: number;
  result: BodyResult;
  txId: string;
  receivedAt: number;
  ackSequence: number;
  startedSequence: number;
  draftToken?: string;
  scope: FreshnessScope;
};

export type FreshnessSinks = {
  writeNetwork?: (read: Extract<ReadPublication, { source: 'network' }>) => void;
  acceptBody?: (receipt: BodyPublication) => void;
  resetResponses?: (
    scope: FreshnessScope,
    startedSequenceCutoff: number,
    resetToken: string,
  ) => void;
  removeEntity?: (scope: FreshnessScope, id: string) => void;
  project?: (read: ReadPublication) => unknown;
};

let networkOrder = 0;
export function nextNetworkOrder(): number {
  return ++networkOrder;
}

export const sameFreshnessScope = (a: FreshnessScope, b: FreshnessScope) =>
  a.epoch === b.epoch && a.accountId === b.accountId && a.graphId === b.graphId;

const runtimes = new WeakMap<QueryClient, ReturnType<typeof createFreshnessRuntime>>();
export function freshnessRuntimeOf(client: QueryClient) {
  return runtimes.get(client);
}

/** A feed reset retires reads and display intents, while a command still belongs to this scope. */
export function captureCommandScope(client: QueryClient): () => boolean {
  const runtime = freshnessRuntimeOf(client);
  return () => freshnessRuntimeOf(client) === runtime && (runtime?.isCurrentScope() ?? true);
}

/** Change the visible value without a TanStack success transition. */
export function shareProjectedData<TError>(query: Query<unknown, TError>, shown: unknown): unknown {
  const { structuralSharing } = query.options;
  const previous = query.state.data;
  return typeof structuralSharing === 'function'
    ? structuralSharing(previous, shown)
    : structuralSharing === false
      ? shown
      : replaceEqualDeep(previous, shown);
}

export function bindFreshnessRuntime(
  client: QueryClient,
  runtime: ReturnType<typeof createFreshnessRuntime>,
): () => void {
  runtimes.set(client, runtime);
  return () => {
    if (runtimes.get(client) === runtime) runtimes.delete(client);
  };
}

const networkReceipts = new WeakMap<object, NetworkReadReceipt>();
const restored = new WeakMap<
  object,
  Extract<ReadOrigin, { source: 'disk' }> & { scope: FreshnessScope }
>();
const observations = new WeakMap<object, NetworkReadReceipt>();

export function networkReadReceiptOf(raw: unknown): NetworkReadReceipt | undefined {
  if (typeof raw === 'object' && raw !== null) return networkReceipts.get(raw);
}

export function recordNetworkReadReceipt(raw: unknown, receipt: NetworkReadReceipt): void {
  if (typeof raw === 'object' && raw !== null) networkReceipts.set(raw, receipt);
}

export function inheritNetworkReadReceipt(rawParent: unknown, constituent: object): void {
  const receipt = networkReadReceiptOf(rawParent);
  if (receipt) recordNetworkReadReceipt(constituent, receipt);
}

export function recordDiskRead(
  raw: object,
  origin: Extract<ReadOrigin, { source: 'disk' }> & { scope: FreshnessScope },
): void {
  restored.set(raw, origin);
}

export function diskReadOf(raw: unknown) {
  if (typeof raw === 'object' && raw !== null) return restored.get(raw);
}

type DiskOrigin = Extract<ReadOrigin, { source: 'disk' }> & { scope: FreshnessScope };
const diskAttempts = new WeakMap<object, { raw: unknown; origin: DiskOrigin }>();

/** The TanStack observer publishes before QueryCache.onSuccess. Stage by query for scalars too. */
export function stageDiskRead(
  query: object,
  raw: unknown,
  origin: DiskOrigin,
  signal: AbortSignal,
) {
  const attempt = { raw, origin };
  diskAttempts.set(query, attempt);
  if (raw !== null && typeof raw === 'object') recordDiskRead(raw, origin);
  signal.addEventListener(
    'abort',
    () => {
      if (diskAttempts.get(query) === attempt) diskAttempts.delete(query);
    },
    { once: true },
  );
}

export function isPublishingDisk(query: { state: { data: unknown } }) {
  const attempt = diskAttempts.get(query);
  return attempt !== undefined && Object.is(query.state.data, attempt.raw);
}

export const diskAwareStaleTime = (normal: number) => (query: { state: { data: unknown } }) =>
  isPublishingDisk(query) ? 0 : normal;

export function takeDiskRead(query: object, raw: unknown): DiskOrigin | undefined {
  const attempt = diskAttempts.get(query);
  diskAttempts.delete(query);
  if (attempt && Object.is(attempt.raw, raw)) return attempt.origin;
}

export function observeNetworkRead(shown: unknown, receipt: NetworkReadReceipt): void {
  if (typeof shown === 'object' && shown !== null) observations.set(shown, receipt);
}

export function networkObservationOf(shown: unknown): NetworkReadReceipt | undefined {
  if (typeof shown === 'object' && shown !== null) return observations.get(shown);
}

export function forgetNetworkObservation(shown: unknown): void {
  if (typeof shown === 'object' && shown !== null) observations.delete(shown);
}

const scalarReceipts = new WeakMap<object, { raw: unknown; receipt: NetworkReadReceipt }>();

/** Primitives have no object identity. Bind their evidence to the observer's exact query. */
export function networkReadContext(client: QueryClient, key: QueryKey) {
  return {
    onNetworkReadReceipt(receipt: NetworkReadReceipt, raw: unknown) {
      if (typeof raw === 'object' && raw !== null) return;
      const query = client.getQueryCache().get(hashKey(key));
      if (query?.state.fetchStatus !== 'fetching') return;
      const staged = scalarReceipts.get(query);
      if (!staged || receipt.startedSequence >= staged.receipt.startedSequence)
        scalarReceipts.set(query, { raw, receipt });
    },
  };
}

export function takeScalarReadReceipt(query: object, raw: unknown): NetworkReadReceipt | undefined {
  const staged = scalarReceipts.get(query);
  scalarReceipts.delete(query);
  if (staged && Object.is(staged.raw, raw)) return staged.receipt;
}

type ReadErrorReceipt = Pick<NetworkReadReceipt, 'epoch' | 'startedSequence'>;
const readErrors = new WeakMap<object, ReadErrorReceipt>();
export function recordReadErrorReceipt(error: unknown, receipt: ReadErrorReceipt): void {
  if (typeof error === 'object' && error !== null) readErrors.set(error, receipt);
}
export function readErrorReceiptOf(error: unknown): ReadErrorReceipt | undefined {
  if (typeof error === 'object' && error !== null) return readErrors.get(error);
}
