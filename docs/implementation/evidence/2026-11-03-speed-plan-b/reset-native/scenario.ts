import { hashKey, QueryClient } from '@tanstack/react-query';
import { readDraft, saveDraft, setDraftScope } from '../apps/web/src/features/entity-editor/draft-storage';
import { nextNetworkOrder } from '../apps/web/src/lib/freshness/provenance';
import { createFreshnessRuntime } from '../apps/web/src/lib/freshness/runtime';
import { bindQueryResponses } from '../apps/web/src/lib/local-data/query-responses';
import { openResponseCache } from '../apps/web/src/lib/local-data/response-cache';

const buster = 'b13-disk-probe';
const rewind = 'future-cursor:21:0:11';
const floorToken = 'floor:20:complete';
const scopeOf = (name) => ({ accountId: name, graphId: name, epoch: 1 });
const key = [['entity', 'get'], { input: { id: 'record' }, type: 'query' }];
const detail = { key, queryHash: hashKey(key) };
const doc = (text) => ({ v: 3, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
const raw = (text, revision = 1) => ({ entity: { id: 'record', bodyRevision: revision, body: text, bodyDoc: doc(text) } });
const write = (cache, text, revision = 1) => cache.writeServerResponse(detail, raw(text, revision), {
  receivedAt: Date.now(), startedSequence: nextNetworkOrder(),
});
const reset = (cache, token = rewind, disposition = 'history-rewind') =>
  cache.invalidateGeneration(nextNetworkOrder(), token, disposition);
const generation = async (cache) => (await cache.capture())?.generation;
const textOnDisk = async (cache) => (await cache.read(detail))?.data.entity.body;
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function gate() {
  let open;
  const closed = new Promise((resolve) => { open = resolve; });
  return { closed, open };
}
function start(name) {
  const scope = scopeOf(name);
  const queryClient = new QueryClient();
  const runtime = createFreshnessRuntime({ queryClient, scope, transport: { start() {}, stop() {}, async reconcile() {} } });
  const binding = bindQueryResponses(queryClient, runtime, { enabled: true, buster });
  return { runtime, scope, binding, close() { binding.close(); runtime.dispose(); queryClient.clear(); } };
}
function floorPage() {
  return { watermark: '21', floor: '20', transactions: [], reset: { reason: 'floor', phase: 'complete', token: floorToken } };
}
function rewindPage() {
  return { watermark: '11', floor: '0', transactions: [], reset: { reason: 'future-cursor', phase: 'complete', token: rewind } };
}
const ordinaryScope = scopeOf('ordinary-two-tabs');
let ordinary;

window.diskProbe = {
  async runtimeBridge() {
    const run = start('runtime-bridge');
    try {
      const { runtime, scope, binding } = run;
      // First event arrives before the lazy response-cache import/open resolves.
      check(runtime.acceptChanges(scope, floorPage(), '19'), 'initial floor declined');
      const cache = await binding.ready;
      // The ready callback invokes the queued reset before this continuation.
      check(await generation(cache) === 1, 'queued initial floor was not durable');
      check(await write(cache, 'first history', 8), 'initial history write failed');
      check(runtime.acceptChanges(scope, rewindPage(), '21'), 'runtime refused authoritative rewind');
      check(await generation(cache) === 2 && !(await textOnDisk(cache)), 'rewind did not purge first history');
      check(await write(cache, 'after rewind', 2), 'new history lower revision was fenced');
      const prior = cache.capture();
      check(runtime.acceptChanges(scope, floorPage(), '11'), 'runtime declined reused floor token');
      const afterFloor = await generation(cache);
      const survived = await textOnDisk(cache);
      check(afterFloor === 3 && !survived && !cache.isCurrent(prior), 'reused floor left response: ' + JSON.stringify({ afterFloor, survived }));
      return { afterFloor, purged: true };
    } finally { run.close(); }
  },

  async lazyRewindBridge() {
    const run = start('lazy-rewind-bridge');
    try {
      const { runtime, scope, binding } = run;
      check(runtime.acceptChanges(scope, floorPage(), '19'), 'queued floor declined');
      check(runtime.acceptChanges(scope, rewindPage(), '21'), 'queued rewind declined');
      const cache = await binding.ready;
      check(await generation(cache) === 2, 'queued rewind did not commit');
      check(await write(cache, 'post-lazy-rewind'), 'queued reset left no usable generation');
      check(runtime.acceptChanges(scope, floorPage(), '11'), 'reused floor after queued rewind declined');
      const afterFloor = await generation(cache);
      const survived = await textOnDisk(cache);
      check(afterFloor === 3 && !survived, 'queued rewind dropped disposition: ' + JSON.stringify({ afterFloor, survived }));
      return { afterFloor, purged: true };
    } finally { run.close(); }
  },

  async sameTokenCurrent() {
    const cache = openResponseCache(scopeOf('same-token-current'), buster);
    try {
      check(await reset(cache), 'first rewind failed');
      const first = await generation(cache);
      check(await write(cache, 'new record after rewind'), 'new response write failed');
      check(await reset(cache), 'repeated rewind failed');
      const second = await generation(cache);
      const survived = await textOnDisk(cache);
      check(second === first + 1 && !survived, 'current handle deduplicated authoritative rewind: ' + JSON.stringify({ first, second, survived }));
      return { first, second };
    } finally { cache.close(); }
  },

  async sameTokenStaleWithQueuedWriter() {
    const scope = scopeOf('same-token-stale');
    const stale = openResponseCache(scope, buster);
    const resetting = openResponseCache(scope, buster);
    let writer;
    const nativeTransaction = IDBDatabase.prototype.transaction;
    try {
      check(await generation(stale) === 0, 'stale handle did not open at generation 0');
      check(await reset(resetting), 'peer first rewind failed');
      writer = openResponseCache(scope, buster);
      check(await generation(writer) === 1 && !(await textOnDisk(writer)), 'writer not in empty generation 1');
      const writeTicket = writer.capture();
      let oldWrite;
      IDBDatabase.prototype.transaction = function (names, mode, options) {
        const tx = nativeTransaction.call(this, names, mode, options);
        if (options?.durability === 'strict' && !oldWrite) {
          // Capture the writer's old ticket now. Its native RW transaction queues behind this reset.
          oldWrite = write(writer, 'queued old generation');
        }
        return tx;
      };
      check(await reset(stale), 'stale handle rewind failed');
      check(oldWrite, 'fixture did not queue write behind native reset');
      const written = await oldWrite;
      const second = await generation(stale);
      const survived = await textOnDisk(stale);
      check(second === 2 && !written && !survived && writer.isCurrent(writeTicket), 'stale peer rewind admitted old generation: ' + JSON.stringify({ second, written, survived }));
      return { second, written };
    } finally {
      IDBDatabase.prototype.transaction = nativeTransaction;
      writer?.close(); stale.close(); resetting.close();
    }
  },

  async freezeAfterDigest() {
    const scope = scopeOf('freeze-rewind');
    const live = openResponseCache(scope, buster);
    const frozen = openResponseCache(scope, buster);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const entered = gate();
    const release = gate();
    try {
      check(await write(live, 'peer row'), 'freeze peer write failed');
      check(await generation(frozen) === 0, 'frozen handle not initialized');
      crypto.subtle.digest = async (...args) => {
        entered.open();
        await release.closed;
        return digest(...args);
      };
      const pending = reset(frozen);
      await entered.closed;
      frozen.freeze();
      release.open();
      check(!(await pending) && await textOnDisk(live) === 'peer row', 'frozen rewind erased peer row');
      return { retained: true };
    } finally {
      release.open();
      crypto.subtle.digest = digest;
      frozen.close(); live.close();
    }
  },

  async freezeInsideRewind() {
    const scope = scopeOf('freeze-inside-rewind');
    const live = openResponseCache(scope, buster);
    const frozen = openResponseCache(scope, buster);
    const get = IDBObjectStore.prototype.get;
    let inside = false;
    try {
      check(await write(live, 'peer row'), 'freeze RW peer write failed');
      check(await generation(frozen) === 0, 'frozen RW handle not initialized');
      IDBObjectStore.prototype.get = function (key) {
        const req = get.call(this, key);
        if (this.name === 'control' && this.transaction.mode === 'readwrite' && key === 'lease') {
          req.addEventListener('success', () => { inside = true; frozen.freeze(); }, { once: true });
        }
        return req;
      };
      check(!(await reset(frozen)) && inside && await textOnDisk(live) === 'peer row', 'freeze inside rewind RW erased peer row');
      return { retained: true };
    } finally {
      IDBObjectStore.prototype.get = get;
      frozen.close(); live.close();
    }
  },

  async strictAckAbortAndEpoch() {
    const run = start('ack-strict-epoch');
    const nativePut = IDBObjectStore.prototype.put;
    const aborted = gate();
    try {
      const { runtime, scope, binding } = run;
      setDraftScope(scope.accountId);
      const cache = await binding.ready;
      check(await write(cache, 'raw before ack', 1), 'ACK base write failed');
      const slot = saveDraft('record', doc('submitted'), 1, new Date().toISOString());
      check(readDraft('record')?.slot === slot, 'fixture draft not saved');
      IDBObjectStore.prototype.put = function (...args) {
        const request = nativePut.apply(this, args);
        if (this.name === 'responses' && args[0]?.data?.entity?.bodyRevision === 2) {
          check(this.transaction.durability === 'strict', 'body ACK used non-strict transaction');
          const tx = this.transaction;
          tx.addEventListener('abort', aborted.open, { once: true });
          request.addEventListener('success', () => tx.abort(), { once: true });
        }
        return request;
      };
      const submit = () => runtime.beginBodySave({ entityId: 'record', expectedBodyRevision: 1, draftToken: slot });
      const ack = { txId: '20', result: { bodyRevision: 2, body: 'submitted', bodyDoc: doc('submitted') } };
      check(runtime.settleBodySave(submit(), ack), 'runtime did not accept first ACK');
      await aborted.closed;
      check(await textOnDisk(cache) === 'raw before ack' && readDraft('record')?.slot === slot, 'aborted strict ACK retired draft or changed disk');
      const preReset = submit();
      const oldTicket = cache.capture();
      check(runtime.acceptChanges(scope, rewindPage(), '21'), 'rewind before stale ACK failed');
      check(!(await cache.read(detail, oldTicket)) && !cache.isCurrent(oldTicket), 'old read ticket survived rewind');
      check(!runtime.settleBodySave(preReset, ack) && readDraft('record')?.slot === slot, 'pre-rewind ACK retired draft');
      return { retainedAfterStrictAbort: true, retainedAfterEpoch: true };
    } finally {
      IDBObjectStore.prototype.put = nativePut;
      run.close();
    }
  },

  async ordinaryOpen(seed) {
    ordinary = openResponseCache(ordinaryScope, buster);
    check(await generation(ordinary) === 0, 'ordinary peer opened wrong generation');
    if (seed) check(await write(ordinary, 'before ordinary reset'), 'initial ordinary write failed');
  },
  async ordinaryResetThenWrite() {
    check(await ordinary.invalidateGeneration(nextNetworkOrder(), floorToken), 'ordinary first reset failed');
    check(await write(ordinary, 'first tab new row'), 'ordinary post-reset write failed');
  },
  async ordinaryReplay() {
    check(await ordinary.invalidateGeneration(nextNetworkOrder(), floorToken), 'ordinary second tab did not adopt');
    const result = { generation: await generation(ordinary), body: await textOnDisk(ordinary) };
    check(result.generation === 1 && result.body === 'first tab new row', 'ordinary replay erased peer response: ' + JSON.stringify(result));
    return result;
  },
};
