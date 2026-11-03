import { expect, test } from 'bun:test';
import type { BrowserContext, Page } from 'playwright-core';
import { coldStarts, LAB_URL, offlineStart } from './scenario';
import type { LabSample } from './summary';

const owner = '50f87c9d-37ea-4b66-8aa0-b6b0533be505';
const cache = `orbis-cache:${owner}`;
const id = 'lab-record';
const target = `${LAB_URL}/r/${id}`;

function browserFixture({ blocked = false, controller = false, offlineRecord = false } = {}) {
  const steps: string[] = [];
  const disk = new Set([cache, 'orbis-cache:another-owner', `orbis-input:${owner}`]);
  const localStorage = {
    'sb-lab-auth-token': JSON.stringify({ user: { id: owner }, access_token: 'fixture' }),
    'orbis:d2:buffer': 'pending capture',
    'orbis:draft:emergency': 'pending text',
    getItem(this: Record<string, unknown>, key: string) {
      const value = this[key];
      return typeof value === 'string' ? value : null;
    },
  };
  const indexedDB = {
    deleteDatabase(name: string) {
      steps.push(`delete:${name}`);
      const request: { onsuccess?: () => void; onblocked?: () => void } = {};
      queueMicrotask(() => {
        if (blocked) request.onblocked?.();
        else {
          disk.delete(name);
          request.onsuccess?.();
        }
      });
      return request;
    },
  };
  const parked = `blob:${LAB_URL}/parked`;
  let location = target;
  let offline = false;
  const page = {
    url: () => location,
    goto: async (url: string) => {
      steps.push(`goto:${url}`);
      location = url;
    },
    evaluate: async (fn: (...args: unknown[]) => unknown, arg: unknown) =>
      new Function('URL', 'localStorage', 'indexedDB', 'window', 'arg', `return (${fn})(arg);`)(
        { createObjectURL: () => parked },
        localStorage,
        indexedDB,
        { __lab: { lcp: null } },
        arg,
      ),
    waitForFunction: async (fn: () => unknown) => {
      if (fn.toString().includes('serviceWorker')) {
        if (!controller) throw new Error('fixture has no service worker');
      } else if (offline && !offlineRecord) {
        throw new Error('fixture has no offline record');
      }
      return { jsonValue: async () => 150 };
    },
    close: async () => {
      steps.push('close');
    },
  } as unknown as Page;
  const ctx = {
    pages: () => [page],
    newPage: async () => page,
    newCDPSession: async () => ({
      send: async (method: string, params?: { storageTypes: string }) => {
        steps.push(params ? `${method}:${params.storageTypes}` : method);
      },
      detach: async () => {},
    }),
    setOffline: async (value: boolean) => {
      offline = value;
      steps.push(`offline:${offline}`);
    },
  } as unknown as BrowserContext;
  return { ctx, page, steps, disk, localStorage, parked };
}

test('пустой кеш данных удаляет одну базу владельца между холодной оболочкой и тёплым стартом', async () => {
  const { ctx, page, steps, disk, localStorage, parked } = browserFixture();
  const samples: LabSample[] = [];
  await coldStarts(ctx, page, 1, samples, [], id, async () => {
    steps.push('first transitions');
  });
  expect(samples.map((sample) => sample.kind)).toEqual(['cold-shell', 'empty', 'warm-shell']);
  expect(steps).toEqual([
    `goto:${parked}`,
    'Network.clearBrowserCache',
    'Storage.clearDataForOrigin:cache_storage,service_workers',
    `goto:${target}`,
    `goto:${parked}`,
    `delete:${cache}`,
    `goto:${target}`,
    'first transitions',
    `goto:${target}`,
  ]);
  expect([...disk]).toEqual(['orbis-cache:another-owner', `orbis-input:${owner}`]);
  expect(localStorage['orbis:d2:buffer']).toBe('pending capture');
  expect(localStorage['orbis:draft:emergency']).toBe('pending text');
  expect(localStorage['sb-lab-auth-token']).toContain(owner);
});

test('заблокированное удаление не выдаёт отсчёт с пустым кешем данных', async () => {
  const { ctx, page, disk } = browserFixture({ blocked: true });
  const samples: LabSample[] = [];
  const run = coldStarts(ctx, page, 1, samples, [], id, async () => {});
  await expect(run).rejects.toThrow('кеш данных открыт');
  expect(samples.map((sample) => sample.kind)).toEqual(['cold-shell']);
  expect(disk.has(cache)).toBe(true);
});

test('офлайн повторно открывает ту же запись и сохраняет прогретый диск', async () => {
  const { ctx, steps, disk } = browserFixture({ controller: true, offlineRecord: true });
  const samples: LabSample[] = [];
  await offlineStart(ctx, samples, [], id);
  expect(steps).toEqual(['offline:true', `goto:${target}`, 'close', 'offline:false']);
  expect(samples[0]).toMatchObject({ metric: 'cold_start', kind: 'offline' });
  expect(disk.has(cache)).toBe(true);
});

test('активный service worker без сохранённой целевой записи не даёт warm-data отсчёт', async () => {
  const { ctx, page } = browserFixture({ controller: true });
  const samples: LabSample[] = [];
  await coldStarts(ctx, page, 1, samples, [], id, async () => {});
  expect(samples.at(-1)).toMatchObject({
    kind: 'warm-unverified',
    startup: { shell: 'controlled', target: 'unavailable' },
  });
});

test('только совместимая целевая запись, открывшаяся в новой вкладке без сети, даёт warm-data', async () => {
  const { ctx, page } = browserFixture({ controller: true, offlineRecord: true });
  const samples: LabSample[] = [];
  await coldStarts(ctx, page, 1, samples, [], id, async () => {});
  expect(samples.at(-1)).toMatchObject({
    kind: 'warm',
    startup: { shell: 'controlled', target: 'ready-offline' },
  });
});
