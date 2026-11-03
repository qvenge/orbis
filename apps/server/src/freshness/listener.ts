import { changeXidInput } from '@orbis/shared';
import type { Sql } from 'postgres';

const CHANNEL = 'orbis_changes';

export function changeStreamEnabled(): boolean {
  return process.env.ORBIS_CHANGE_STREAM !== '0';
}
const GRAPH_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type ChangeWake = { txId: bigint } | { recovered: true };
type Wake = (notice: ChangeWake) => void;
type Connector = Pick<Sql, 'listen' | 'end'>;

/** One lazy LISTEN socket for the process. The regular DB pool never holds it. */
export function startChangeListener(makeClient: () => Connector) {
  const subscribers = new Map<string, Set<Wake>>();
  const stopping = new AbortController();
  let connector: Connector | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 100;
  let closePromise: Promise<void> | undefined;

  function notify(payload: string) {
    let notice: { graphId?: unknown; txId?: unknown } | null;
    try {
      notice = JSON.parse(payload);
    } catch {
      return;
    }
    if (!notice || typeof notice !== 'object') return;
    const xid = changeXidInput.safeParse(notice.txId);
    if (!xid.success) return;
    const wake = { txId: BigInt(xid.data) };
    if ('graphId' in notice) {
      if (typeof notice.graphId !== 'string' || !GRAPH_ID.test(notice.graphId)) return;
      for (const callback of subscribers.get(notice.graphId.toLowerCase()) ?? []) callback(wake);
    } else {
      for (const group of subscribers.values()) for (const callback of group) callback(wake);
    }
  }

  async function connect() {
    if (stopping.signal.aborted) return;
    const current = makeClient();
    connector = current;
    try {
      await current.listen(
        CHANNEL,
        (payload) => {
          if (!stopping.signal.aborted && connector === current) notify(payload);
        },
        () => {
          if (stopping.signal.aborted || connector !== current) return;
          retryDelay = 100;
          for (const group of subscribers.values()) {
            for (const callback of group) callback({ recovered: true });
          }
        },
      );
    } catch {
      // postgres.js relistens on socket loss. An initial SQL refusal can leave a
      // rejected channel cached on that handle, so retry with a fresh handle.
      if (stopping.signal.aborted || connector !== current) return;
      console.warn('[freshness] LISTEN недоступен, работает периодическая сверка');
      await current.end({ timeout: 0 });
      if (stopping.signal.aborted) return;
      connector = undefined;
      retry = setTimeout(() => void connect(), retryDelay);
      retryDelay = Math.min(retryDelay * 2, 2_000);
    }
  }
  void connect();

  return {
    signal: stopping.signal,
    subscribe(graph: string, wake: Wake) {
      if (stopping.signal.aborted) return () => {};
      const key = graph.toLowerCase();
      const group = subscribers.get(key) ?? new Set<Wake>();
      group.add(wake);
      subscribers.set(key, group);
      return () => {
        group.delete(wake);
        if (!group.size && subscribers.get(key) === group) subscribers.delete(key);
      };
    },
    close() {
      if (closePromise) return closePromise;
      stopping.abort();
      clearTimeout(retry);
      subscribers.clear();
      closePromise = connector?.end({ timeout: 0 }) ?? Promise.resolve();
      return closePromise;
    },
  };
}

export type ChangeListener = ReturnType<typeof startChangeListener>;
