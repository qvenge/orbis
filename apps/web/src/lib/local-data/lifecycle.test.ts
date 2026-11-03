import { expect, test } from 'vitest';
import { createLocalDataLifecycle, type LocalDataReason, type LocalDataScope } from './lifecycle';

const scope: LocalDataScope = { accountId: 'a', graphId: 'g', epoch: 1 };
const next = { accountId: 'b', graphId: 'h', epoch: 2 };

test.each([
  ['logout', 'account', 'account', true],
  ['unauthorized', 'account', 'keep', true],
  ['account-switch', 'close', 'keep', true],
  ['outdated', 'account', 'keep', true],
  ['seeded', 'graph', 'keep', true],
  ['shared-on', 'device', 'device', true],
  ['shared-off', 'close', 'keep', true],
] satisfies [
  LocalDataReason,
  string,
  string,
  boolean,
][])('%s freezes synchronously and cleans only the authorized stores', async (reason, responses, input, snapshot) => {
  let unblock!: () => void;
  const fence = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const order: unknown[] = [];
  const lifecycle = createLocalDataLifecycle(async (transition) => {
    order.push(['fence', transition.reason, transition.responses, transition.input]);
    await fence;
  });
  lifecycle.register({
    snapshot: () => {
      order.push('snapshot');
      return undefined;
    },
    freeze: () => {
      order.push('freeze');
    },
    clear: () => {
      order.push('clear');
      return undefined;
    },
  });
  const transition = lifecycle.transitionLocalData(reason, scope, next);
  expect(order).toEqual([
    ...(snapshot ? ['snapshot'] : []),
    'freeze',
    ['fence', reason, responses, input],
  ]);
  unblock();
  await transition;
  expect(order.at(-1)).toBe('clear');
});

test('blocked wipe can be retried without reviving old writers or snapshotting them again', async () => {
  const order: string[] = [];
  let blocked = true;
  const lifecycle = createLocalDataLifecycle(() => {
    order.push('fence');
  });
  lifecycle.register({
    snapshot: () => {
      order.push('snapshot');
      return undefined;
    },
    freeze: () => {
      order.push('freeze');
    },
    clear: () => {
      order.push('clear');
      return blocked ? 'blocked' : undefined;
    },
  });
  const pending = lifecycle.transitionLocalData('logout', scope);
  expect(lifecycle.transitionLocalData('logout', scope)).toBe(pending);
  await expect(pending).rejects.toMatchObject({ status: 'blocked' });
  await expect(lifecycle.transitionLocalData('account-switch', scope, next)).rejects.toMatchObject({
    status: 'pending',
  });
  blocked = false;
  await lifecycle.transitionLocalData('logout', scope);
  expect(order).toEqual(['snapshot', 'freeze', 'fence', 'clear', 'clear']);
});

test('snapshot failure fences all writers before any durable deletion can start', async () => {
  const order: string[] = [];
  const lifecycle = createLocalDataLifecycle(() => {
    order.push('fence');
  });
  lifecycle.register({
    snapshot: () => {
      throw new DOMException('quota', 'QuotaExceededError');
    },
    freeze: () => {
      order.push('freeze');
    },
  });
  lifecycle.register({
    freeze: () => {
      order.push('other freeze');
    },
  });
  await expect(lifecycle.transitionLocalData('outdated', scope)).rejects.toThrow('quota');
  expect(order).toEqual(['freeze', 'other freeze']);
});

test('a quota retry commits the captured bytes without reading the retired editor again', async () => {
  let available = false;
  let editor = 'unsaved';
  const order: string[] = [];
  const lifecycle = createLocalDataLifecycle(() => {
    order.push('fence');
  });
  lifecycle.register({
    snapshot() {
      const captured = editor;
      order.push('capture');
      return [
        () => {
          if (!available) return false;
          order.push(captured);
          return true;
        },
      ];
    },
    freeze() {
      editor = '';
      order.push('freeze');
    },
  });
  await expect(lifecycle.transitionLocalData('unauthorized', scope)).rejects.toThrow(
    'Не удалось сохранить',
  );
  expect(order).toEqual(['capture', 'freeze']);
  available = true;
  await lifecycle.transitionLocalData('unauthorized', scope);
  expect(order).toEqual(['capture', 'freeze', 'unsaved', 'fence']);
});
