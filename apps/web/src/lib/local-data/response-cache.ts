import { DOC_SCHEMA_VERSION } from '@orbis/shared/doc/types';
import { hashKey, type QueryKey } from '@tanstack/react-query';
import { cacheDependencyOf } from '../freshness/dependencies';
import {
  type BodyPublication,
  type NetworkReadReceipt,
  nextNetworkOrder,
  sameFreshnessScope,
} from '../freshness/provenance';
import type { FreshnessScope } from '../freshness/transport';
import {
  CONTROL_STORE,
  openResponseDatabase,
  RESPONSE_STORE,
  requestResult,
  transaction,
} from './database';

export const RESPONSE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const THREAD_LIMIT = 50;

export const makeResponseBuster = (buildId: string, docVersion: number) =>
  JSON.stringify([buildId, docVersion]);
export const responseBuster = makeResponseBuster(import.meta.env.VITE_BUILD_ID, DOC_SCHEMA_VERSION);

type Data = Record<string, unknown>;
type ResponseMeta = Pick<NetworkReadReceipt, 'receivedAt' | 'startedAt' | 'startedSequence'> & {
  fragmentTimes?: Readonly<Record<string, number>>;
};
export type ResponseKey = { key: QueryKey; queryHash: string };
type Envelope = ResponseKey &
  Omit<ResponseMeta, 'startedAt' | 'startedSequence'> & {
    expiresAt: number;
    data: unknown;
    buster: string;
    graphId: string;
    generation: number;
    entityKeys: string[];
  };
type Control = { buster: string; lease: string; retired: string[] };
type GraphControl = {
  generation: number;
  deleted: Record<string, number>;
  resetDigests?: string[];
};
type Session = { db: IDBDatabase; lease: string; generation: number };
type Ticket = Promise<Session | undefined> | undefined;

const object = (value: unknown): Data | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Data)
    : undefined;
const family = (key: QueryKey) => (Array.isArray(key[0]) ? key[0].join('.') : key[0]);
function inputId(key: QueryKey): string | undefined {
  const id = object(object(key[1])?.input)?.id;
  return typeof id === 'string' ? id.toLowerCase() : undefined;
}
const entityIndexKey = (graphId: string, id: string) => JSON.stringify([graphId, id.toLowerCase()]);
const emptyGraph: GraphControl = { generation: 0, deleted: {} };
const unsafeCardFields = new Set(['operations', 'inverse', 'results', 'cursor']);

function safeThreadFields(value: unknown, parent?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => safeThreadFields(item));
  const fields = object(value);
  if (!fields) return value;
  return Object.fromEntries(
    Object.entries(fields)
      .filter(
        ([name]) => !unsafeCardFields.has(name) && !(parent === 'pending' && name === 'input'),
      )
      .map(([name, child]) => [name, safeThreadFields(child, name)]),
  );
}

function projectTail(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw.slice(0, THREAD_LIMIT).map((row) => safeThreadFields(row));
}

export function projectServerResponse(key: QueryKey, raw: unknown): unknown {
  const policy = cacheDependencyOf(key, raw)?.persistence;
  if (!policy || policy === 'none') return undefined;
  const path = family(key);
  if (path === 'chatThread') {
    const data = object(raw);
    if (
      !Array.isArray(data?.pages) ||
      !Array.isArray(data.pageParams) ||
      data.pageParams[0] !== undefined
    )
      return undefined;
    const tail = projectTail(data.pages[0]);
    if (tail) return { pages: [tail], pageParams: [undefined] };
    return undefined;
  }
  if (path === 'chat.listMessages') {
    if (object(object(key[1])?.input)?.before !== undefined) return undefined;
    return projectTail(raw);
  }
  if (path === 'entity.get') {
    const detail = object(raw);
    const thread = object(detail?.thread);
    if (thread) return { ...detail, thread: { ...thread, messages: projectTail(thread.messages) } };
  }
  return raw;
}

export function isRestorableResponse(
  { receivedAt, fragmentTimes }: Pick<ResponseMeta, 'receivedAt' | 'fragmentTimes'>,
  now: number,
): boolean {
  return [receivedAt, ...Object.values(fragmentTimes ?? {})].every(
    (at) => Number.isFinite(at) && at >= 0 && at <= now && now - at < RESPONSE_TTL_MS,
  );
}

async function deleteIndexKeys(
  store: IDBObjectStore,
  index: string,
  key: IDBValidKey | IDBKeyRange,
): Promise<void> {
  const keys = await requestResult(store.index(index).getAllKeys(key));
  await Promise.all(keys.map((primaryKey) => requestResult(store.delete(primaryKey))));
}

export function openResponseCache(
  scope: FreshnessScope,
  buster: string,
  { enabled = true, now = Date.now }: { enabled?: boolean; now?: () => number } = {},
) {
  const graphKey = `graph:${scope.graphId}`;
  const revisionPrefix = `body:[${JSON.stringify(scope.graphId)},`;
  const enabledForScope = enabled && !!scope.accountId && !!scope.graphId;
  const latestWrites = new Map<string, number>();
  let frozen = false;
  let initializing: IDBTransaction | undefined;
  let resetting: IDBTransaction | undefined;
  let cutoff = 0;
  const tombstones = new Map<string, { at: number }>();
  const database = enabledForScope
    ? openResponseDatabase(scope.accountId, { canOpen: () => !frozen, onVersionChange: freeze })
    : Promise.resolve(undefined);

  let active: Ticket = enabledForScope
    ? database
        .then(async (db) => {
          if (!db) return undefined;
          if (frozen) {
            db.close();
            return undefined;
          }
          try {
            return await transaction(db, 'readwrite', async (tx) => {
              initializing = tx;
              if (frozen) return undefined;
              const control = tx.objectStore(CONTROL_STORE);
              let state = await requestResult<Control | undefined>(control.get('lease'));
              if (state?.retired.includes(buster)) return undefined;
              if (!state || state.buster !== buster) {
                state = {
                  buster,
                  lease: crypto.randomUUID(),
                  retired: state ? [...state.retired, state.buster] : [],
                };
                await requestResult(control.clear());
                await Promise.all([
                  requestResult(control.put(state, 'lease')),
                  requestResult(tx.objectStore(RESPONSE_STORE).clear()),
                ]);
              }
              await deleteIndexKeys(
                tx.objectStore(RESPONSE_STORE),
                'expires',
                IDBKeyRange.upperBound(now()),
              );
              const graph = await requestResult<GraphControl | undefined>(control.get(graphKey));
              return { db, lease: state.lease, generation: graph?.generation ?? 0 };
            });
          } finally {
            initializing = undefined;
            if (frozen) db.close();
          }
        })
        .catch(() => undefined)
    : undefined;

  function capture(): Ticket {
    return frozen ? undefined : active;
  }

  async function guarded<T>(
    ticket: Ticket,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore, graph: GraphControl, tx: IDBTransaction) => Promise<T>,
    durable = false,
  ): Promise<T | undefined> {
    try {
      const session = await ticket;
      if (!session || frozen || ticket !== active) return undefined;
      const result = await transaction(
        session.db,
        mode,
        async (tx) => {
          const control = tx.objectStore(CONTROL_STORE);
          const [lease, graph = emptyGraph] = await Promise.all([
            requestResult<Control | undefined>(control.get('lease')),
            requestResult<GraphControl | undefined>(control.get(graphKey)),
          ]);
          if (lease?.lease !== session.lease) {
            frozen = true;
            return undefined;
          }
          if (graph.generation !== session.generation || frozen || ticket !== active)
            return undefined;
          return work(tx.objectStore(RESPONSE_STORE), graph, tx);
        },
        durable,
      );
      if (!frozen && ticket === active) return result;
    } catch {
      // Unavailable, quota-exhausted and aborted storage all leave the in-memory path usable.
    }
  }

  function invalidateGeneration(startedSequenceCutoff = nextNetworkOrder(), resetToken?: string) {
    if (frozen) return Promise.resolve(false);
    cutoff = Math.max(cutoff, startedSequenceCutoff);
    tombstones.clear();
    latestWrites.clear();
    const previous = active;
    active = previous
      ?.then(async (session) => {
        if (!session || frozen) return undefined;
        // Match a reset across tabs without storing a resumable feed position.
        const digest =
          resetToken &&
          (await crypto.subtle.digest('SHA-256', new TextEncoder().encode(resetToken)));
        const fingerprint = digest ? Array.from(new Uint8Array(digest)).join('.') : undefined;
        if (frozen) return undefined;
        try {
          return await transaction(
            session.db,
            'readwrite',
            async (tx) => {
              resetting = tx;
              if (frozen) return undefined;
              const control = tx.objectStore(CONTROL_STORE);
              const [lease, graph = emptyGraph] = await Promise.all([
                requestResult<Control | undefined>(control.get('lease')),
                requestResult<GraphControl | undefined>(control.get(graphKey)),
              ]);
              if (frozen || lease?.lease !== session.lease) return undefined;
              const history = graph.resetDigests ?? [];
              if (fingerprint && history.includes(fingerprint))
                return { ...session, generation: graph.generation };
              const generation = graph.generation + 1;
              const resetDigests = fingerprint ? [...history.slice(-15), fingerprint] : history;
              const revisionKeys = await requestResult(
                control.getAllKeys(IDBKeyRange.bound(revisionPrefix, `${revisionPrefix}\uffff`)),
              );
              if (frozen) return undefined;
              await Promise.all([
                requestResult(control.put({ generation, deleted: {}, resetDigests }, graphKey)),
                deleteIndexKeys(tx.objectStore(RESPONSE_STORE), 'graph', scope.graphId),
                ...revisionKeys.map((key) => requestResult(control.delete(key))),
              ]);
              return { ...session, generation };
            },
            true,
          );
        } finally {
          resetting = undefined;
        }
      })
      .catch(() => undefined);
    return active?.then((session) => !frozen && session !== undefined) ?? Promise.resolve(false);
  }

  function eligible(startedSequence: number): boolean {
    return !frozen && startedSequence > cutoff;
  }

  async function rememberRevision(
    tx: IDBTransaction,
    graph: GraphControl,
    id: string,
    revision: number,
  ): Promise<boolean> {
    const control = tx.objectStore(CONTROL_STORE);
    const key = `body:${entityIndexKey(scope.graphId, id)}`;
    const previous = await requestResult<{ generation: number; revision: number } | undefined>(
      control.get(key),
    );
    if (previous?.generation === graph.generation) {
      if (previous.revision > revision) return false;
      if (previous.revision === revision) return true;
    }
    await requestResult(control.put({ generation: graph.generation, revision }, key));
    return true;
  }

  async function writeServerResponse(
    { key, queryHash }: ResponseKey,
    raw: unknown,
    meta: ResponseMeta,
  ) {
    if (!eligible(meta.startedSequence)) return false;
    const ticket = capture();
    const data = projectServerResponse(key, raw);
    if (!ticket || data === undefined || !isRestorableResponse(meta, now())) return false;
    let snapshot: unknown;
    try {
      snapshot = structuredClone(data);
    } catch {
      return false;
    }
    const own = family(key) === 'entity.get' ? inputId(key) : undefined;
    const { startedSequence, startedAt, receivedAt, fragmentTimes } = meta;
    if (startedSequence < (latestWrites.get(queryHash) ?? 0)) return false;
    latestWrites.set(queryHash, startedSequence);
    const ids = new Set(cacheDependencyOf(key, raw)?.dependencies.entityIds ?? []);
    if (typeof own === 'string') ids.add(own);
    const entityKeys = [...ids].map((id) => entityIndexKey(scope.graphId, id));
    const ownKey = own && entityIndexKey(scope.graphId, own);
    const entity = object(object(snapshot)?.entity);
    const result = await guarded(ticket, 'readwrite', async (store, graph, tx) => {
      const localRemoval = ownKey ? tombstones.get(ownKey) : undefined;
      const blocked = entityKeys.filter(
        (id) => tombstones.has(id) || Object.hasOwn(graph.deleted, id),
      );
      const revived =
        ownKey &&
        blocked.length === 1 &&
        blocked[0] === ownKey &&
        typeof entity?.id === 'string' &&
        entity.id.toLowerCase() === own &&
        startedAt !== undefined &&
        startedAt <= receivedAt &&
        startedAt > Math.max(localRemoval?.at ?? -1, graph.deleted[ownKey] ?? -1);
      if (blocked.length > 0 && !revived) return undefined;
      const existing = await requestResult<Envelope | undefined>(
        store.get([scope.graphId, queryHash]),
      );
      if (existing && existing.receivedAt > receivedAt) return undefined;
      if (latestWrites.get(queryHash) !== startedSequence) return undefined;
      if (own) {
        const revision = entity?.bodyRevision;
        if (typeof revision === 'number' && !(await rememberRevision(tx, graph, own, revision)))
          return undefined;
      }
      if (revived && Object.hasOwn(graph.deleted, ownKey)) {
        const deleted = { ...graph.deleted };
        delete deleted[ownKey];
        await requestResult(tx.objectStore(CONTROL_STORE).put({ ...graph, deleted }, graphKey));
      }
      const envelope: Envelope = {
        key,
        queryHash,
        data: snapshot,
        entityKeys,
        graphId: scope.graphId,
        buster,
        generation: graph.generation,
        receivedAt,
        fragmentTimes,
        expiresAt: Math.min(receivedAt, ...Object.values(fragmentTimes ?? {})) + RESPONSE_TTL_MS,
      };
      await requestResult(store.put(envelope));
      return { revived, localRemoval };
    });
    if (ownKey && result?.revived && tombstones.get(ownKey) === result.localRemoval)
      tombstones.delete(ownKey);
    return result !== undefined;
  }

  async function acceptBodyResult(receipt: BodyPublication, draftToken = receipt.draftToken) {
    if (
      !sameFreshnessScope(scope, receipt.scope) ||
      !eligible(receipt.startedSequence) ||
      receipt.draftToken !== draftToken
    )
      return false;
    const { receivedAt } = receipt;
    let result: BodyPublication['result'];
    try {
      result = structuredClone(receipt.result);
    } catch {
      return false;
    }
    if (
      !Number.isInteger(result.bodyRevision) ||
      result.bodyRevision < receipt.expectedBodyRevision ||
      !isRestorableResponse({ receivedAt }, now())
    )
      return false;
    const ticket = capture();
    const entityKey = entityIndexKey(scope.graphId, receipt.entityId);
    const committed = await guarded(
      ticket,
      'readwrite',
      async (store, graph, tx) => {
        if (
          tombstones.has(entityKey) ||
          Object.hasOwn(graph.deleted, entityKey) ||
          !(await rememberRevision(tx, graph, receipt.entityId, result.bodyRevision))
        )
          return false;
        const records = await requestResult<Envelope[]>(store.index('entity').getAll(entityKey));
        let storedBody = false;
        for (const record of records) {
          if (
            family(record.key) !== 'entity.get' ||
            inputId(record.key) !== receipt.entityId.toLowerCase() ||
            !isRestorableResponse(record, now())
          )
            continue;
          const detail = object(record.data);
          const entity = object(detail?.entity);
          const revision = entity?.bodyRevision;
          if (!entity || typeof revision !== 'number' || revision > result.bodyRevision) continue;
          const hasBodyDoc = 'bodyDoc' in entity && object(result.bodyDoc) !== undefined;
          storedBody ||= hasBodyDoc;
          await requestResult(
            store.put({
              ...record,
              fragmentTimes: { ...record.fragmentTimes, body: receivedAt },
              data: {
                ...detail,
                ...('bodyAction' in (detail ?? {}) &&
                  result.bodyAction !== undefined && { bodyAction: result.bodyAction }),
                entity: {
                  ...entity,
                  bodyRevision: result.bodyRevision,
                  ...(result.bodyChangedAt !== undefined && {
                    bodyChangedAt: result.bodyChangedAt,
                  }),
                  ...('body' in entity && result.body !== undefined && { body: result.body }),
                  ...(hasBodyDoc && { bodyDoc: result.bodyDoc }),
                },
              },
            } satisfies Envelope),
          );
        }
        return storedBody;
      },
      true,
    );
    return committed === true && !tombstones.has(entityKey);
  }

  async function removeEntity(id: string) {
    const key = entityIndexKey(scope.graphId, id);
    const at = now();
    tombstones.set(key, { at });
    return guarded(
      capture(),
      'readwrite',
      async (store, graph, tx) => {
        const control = tx.objectStore(CONTROL_STORE);
        await Promise.all([
          requestResult(
            control.put(
              {
                ...graph,
                deleted: { ...graph.deleted, [key]: Math.max(graph.deleted[key] ?? 0, at) },
              },
              graphKey,
            ),
          ),
          requestResult(control.delete(`body:${key}`)),
          deleteIndexKeys(store, 'entity', key),
        ]);
      },
      true,
    );
  }

  function freeze() {
    frozen = true;
    for (const tx of [initializing, resetting]) {
      try {
        tx?.abort();
      } catch {
        // The browser may already have finished committing this transaction.
      }
    }
  }

  return {
    scope,
    capture,
    isCurrent: (ticket: Ticket) => !frozen && ticket !== undefined && ticket === active,
    async read({ key, queryHash }: ResponseKey, ticket = capture()) {
      const policy = cacheDependencyOf(key)?.persistence;
      if (!policy || policy === 'none') return undefined;
      return guarded(ticket, 'readonly', async (store, graph) => {
        const row = await requestResult<Envelope | undefined>(
          store.get([scope.graphId, queryHash]),
        );
        if (
          !row ||
          row.buster !== buster ||
          row.generation !== graph.generation ||
          hashKey(row.key) !== hashKey(key) ||
          row.entityKeys.some((id) => tombstones.has(id) || Object.hasOwn(graph.deleted, id)) ||
          !isRestorableResponse(row, now())
        )
          return undefined;
        return { data: row.data, receivedAt: row.receivedAt, fragmentTimes: row.fragmentTimes };
      });
    },
    async hasDurableBody(
      id: string,
      revision: number,
      bodyDoc: unknown,
      ticket = capture(),
    ): Promise<boolean> {
      const entityKey = entityIndexKey(scope.graphId, id);
      const target = hashKey([bodyDoc]);
      const found = await guarded(ticket, 'readonly', async (store, graph) => {
        if (tombstones.has(entityKey) || Object.hasOwn(graph.deleted, entityKey)) return false;
        const records = await requestResult<Envelope[]>(store.index('entity').getAll(entityKey));
        return records.some((record) => {
          if (
            family(record.key) !== 'entity.get' ||
            inputId(record.key) !== id.toLowerCase() ||
            !isRestorableResponse(record, now())
          )
            return false;
          const entity = object(object(record.data)?.entity);
          return (
            entity?.bodyRevision === revision &&
            object(entity.bodyDoc) !== undefined &&
            hashKey([entity.bodyDoc]) === target
          );
        });
      });
      return found === true && !tombstones.has(entityKey);
    },
    writeServerResponse,
    acceptBodyResult,
    invalidateGeneration,
    removeEntity,
    async remove({ queryHash }: ResponseKey) {
      return guarded(capture(), 'readwrite', async (store) => {
        await requestResult(store.delete([scope.graphId, queryHash]));
      });
    },
    freeze,
    close() {
      freeze();
      void database.then((db) => db?.close());
    },
  };
}
