import { afterAll, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { adminDb, appDb, requireEnv } from '../../test/helpers';
import { type ChangeWake, startChangeListener } from './listener';

requireEnv();
const admin = adminDb().client;
const { client, makeListenerClient } = appDb();
afterAll(() => Promise.all([admin.end(), client.end()]));

test('one LISTEN socket wakes by graph, relistens after termination and wakes all', async () => {
  const firstGraph = crypto.randomUUID();
  const secondGraph = crypto.randomUUID();
  const first: ChangeWake[] = [];
  const second: ChangeWake[] = [];
  const attached = Promise.withResolvers<number>();
  const reattached = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const replayed = Promise.withResolvers<void>();
  const channel = makeListenerClient();
  const wrap: Pick<Sql, 'listen' | 'end'> = {
    listen(name, notification, onlisten) {
      return channel.listen(name, notification, onlisten);
    },
    end: channel.end,
  };
  const originalListen = wrap.listen;
  wrap.listen = (name, notification, onlisten) => {
    let attachments = 0;
    const opening = originalListen(name, notification, () => {
      onlisten?.();
      attachments++;
      if (attachments === 2) reattached.resolve();
    });
    void opening.then(({ state }) => attached.resolve(state.pid), attached.reject);
    return opening;
  };
  const listener = startChangeListener(() => wrap);
  const off = listener.subscribe(firstGraph, (wake) => {
    first.push(wake);
    if ('txId' in wake && wake.txId === 9007199254740993n) received.resolve();
    if ('txId' in wake && wake.txId === 9007199254740994n) replayed.resolve();
  });
  listener.subscribe(secondGraph, (wake) => second.push(wake));
  try {
    const pid = await attached.promise;
    await admin.notify('orbis_changes', JSON.stringify({ graphId: firstGraph, txId: '03' }));
    await admin.notify(
      'orbis_changes',
      JSON.stringify({ graphId: firstGraph, txId: '9007199254740993' }),
    );
    await received.promise;
    expect(first).toEqual([{ recovered: true }, { txId: 9007199254740993n }]);
    expect(second).toEqual([{ recovered: true }]);

    await admin`SELECT pg_terminate_backend(${pid})`;
    await reattached.promise;
    await admin.notify('orbis_changes', JSON.stringify({ txId: '9007199254740994' }));
    await replayed.promise;
    expect(first.slice(-2)).toEqual([{ recovered: true }, { txId: 9007199254740994n }]);
    expect(second.slice(-2)).toEqual([{ recovered: true }, { txId: 9007199254740994n }]);
  } finally {
    off();
    await listener.close();
  }
});
