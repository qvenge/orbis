import { expect, test } from 'bun:test';
import { getFileStore } from './store';

test.skipIf(process.env.ORBIS_TEST_STORAGE !== '1')(
  'private Storage writes, streams exact ranges and tolerates repeated deletion',
  async () => {
    const store = getFileStore();
    const key = 'acceptance/' + crypto.randomUUID();
    try {
      await store.put(key, new Uint8Array([1, 2, 3, 4]));
      expect([
        ...new Uint8Array(
          await new Response(await store.read(key, { offset: 0, length: 2 })).arrayBuffer(),
        ),
      ]).toEqual([1, 2]);
      expect([
        ...new Uint8Array(
          await new Response(await store.read(key, { offset: 1, length: 2 })).arrayBuffer(),
        ),
      ]).toEqual([2, 3]);
      expect([...new Uint8Array(await new Response(await store.read(key)).arrayBuffer())]).toEqual([
        1, 2, 3, 4,
      ]);
    } finally {
      await store.remove(key);
      await store.remove(key);
    }
  },
);
