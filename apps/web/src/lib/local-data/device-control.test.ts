import { afterEach, expect, test } from 'vitest';
import { createDeviceControl, type DeviceLock } from './device-control';

afterEach(() => localStorage.clear());

const lock: DeviceLock = async (_name, _mode, callback) => callback();
const authorize = async () => 'wipe' as const;

test('device mode changes only after the durable pending operation finishes', async () => {
  const first = createDeviceControl(localStorage, lock);
  const peer = createDeviceControl(localStorage, lock);
  const start = first.read();
  const intent = await first.begin({ reason: 'shared-on' });
  expect(peer.read()).toMatchObject({ mode: 'normal', pending: { reason: 'shared-on' } });
  expect(peer.canUse(start.generation)).toBe(false);
  await expect(first.finish(intent, async () => 'blocked', authorize)).resolves.toBe('blocked');
  expect(peer.read().mode).toBe('normal');
  expect(peer.read().pending).toEqual({ ...intent, phase: 'wipe' });
  await expect(peer.finish(intent, async () => 'deleted')).resolves.toBe('deleted');
  expect(first.read()).toMatchObject({ mode: 'shared' });
  expect(first.read().pending).toBeUndefined();
  expect(first.read().inputGeneration).not.toBe(start.inputGeneration);
});

test('account-only logout invalidates only its input generation after cleanup', async () => {
  const device = createDeviceControl(localStorage, lock);
  const owner = device.inputGeneration('owner');
  const other = device.inputGeneration('other');
  const intent = await device.begin({ reason: 'logout', accountId: 'owner' });
  expect(device.canPreserveInput('owner', owner)).toBe(true);
  expect(device.canPreserveInput('other', other)).toBe(true);
  await expect(
    device.finish(
      intent,
      async () => {
        expect(device.canPreserveInput('owner', owner)).toBe(false);
        return 'deleted';
      },
      authorize,
    ),
  ).resolves.toBe('deleted');
  expect(device.inputGeneration('owner')).not.toBe(owner);
  expect(device.inputGeneration('other')).toBe(other);
});

test('prepared wipe can be cancelled after reload without reviving an old writer generation', async () => {
  const device = createDeviceControl(localStorage, lock);
  const previous = device.read().generation;
  const input = device.inputGeneration('owner');
  const intent = await device.begin({ reason: 'shared-on' });
  const restarted = createDeviceControl(localStorage, lock);
  expect(restarted.read().pending?.phase).toBe('prepare');
  expect(restarted.canPreserveInput('owner', input)).toBe(true);
  expect(await restarted.cancel(intent)).toBe(true);
  expect(restarted.canUse(previous)).toBe(false);
  expect(restarted.canUse(intent.generation)).toBe(true);
  expect(restarted.inputGeneration('owner')).toBe(input);
  await expect(device.finish(intent, async () => 'deleted', authorize)).resolves.toBe('cancelled');
});

test('blocked 412 records the rejected build durably before cleanup', async () => {
  const device = createDeviceControl(localStorage, lock);
  const intent = await device.begin({
    reason: 'outdated',
    accountId: 'owner',
    buildId: 'known-old',
  });
  await expect(device.finish(intent, async () => 'blocked')).resolves.toBe('blocked');
  const restarted = createDeviceControl(localStorage, lock);
  expect(restarted.read().rejectedBuilds).toEqual(['known-old']);
  await restarted.finish(intent, async () => 'deleted');
  expect(restarted.read().rejectedBuilds).toEqual(['known-old']);
});

test('only a successful Shared OFF publishes the initiating lineage receipt', async () => {
  const device = createDeviceControl(localStorage, lock);
  const on = await device.begin({ reason: 'shared-on' });
  await device.finish(on, async () => 'deleted', authorize);
  const off = await device.begin({ reason: 'shared-off', tabKey: 'initiator', accountId: 'a' });
  await device.finish(off, async () => 'failed');
  expect(device.read().completedSharedOff).toBeUndefined();
  await device.finish(off, async () => 'deleted');
  expect(device.read()).toMatchObject({
    mode: 'normal',
    completedSharedOff: { generation: off.generation, tabKey: 'initiator', accountId: 'a' },
  });
  await device.finish(off, async () => {
    throw new Error('A peer observing completion cannot run the transfer twice');
  });
  expect(device.read().completedSharedOff?.tabKey).toBe('initiator');
});

test('positive compatibility proofs survive restart until a newer explicit rejection', async () => {
  const device = createDeviceControl(localStorage, lock);
  const old = await device.begin({ reason: 'outdated', buildId: 'old' });
  await device.finish(old, async () => 'deleted');
  const observed = device.read();
  expect(await device.confirmCompatibleBuild('fresh', observed)).toBe(true);
  expect(await device.confirmCompatibleBuild('other-fresh', observed)).toBe(true);

  const restarted = createDeviceControl(localStorage, lock);
  expect(restarted.acceptsBuild('fresh')).toBe(true);
  expect(restarted.acceptsBuild('other-fresh')).toBe(true);
  expect(restarted.acceptsBuild('unknown')).toBe(false);
  expect(await restarted.confirmCompatibleBuild('old', observed)).toBe(false);
  const seeded = await restarted.begin({ reason: 'seeded', accountId: 'a', graphId: 'g' });
  await restarted.finish(seeded, async () => 'deleted');
  expect(restarted.acceptsBuild('fresh')).toBe(true);

  const late = restarted.read();
  const freshRejection = await restarted.begin({ reason: 'outdated', buildId: 'fresh' });
  expect(await restarted.confirmCompatibleBuild('unknown', late)).toBe(false);
  await restarted.finish(freshRejection, async () => 'deleted');
  expect(restarted.acceptsBuild('fresh')).toBe(false);
  expect(restarted.acceptsBuild('other-fresh')).toBe(false);
  expect(await restarted.confirmCompatibleBuild('fresh', restarted.read())).toBe(false);
  expect(await restarted.confirmCompatibleBuild('other-fresh', late)).toBe(false);
  expect(await restarted.confirmCompatibleBuild('other-fresh', restarted.read())).toBe(true);
});
