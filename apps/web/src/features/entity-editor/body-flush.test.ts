import { expect, test } from 'vitest';
import { bodyRevisionOf, flushBodyOf, mountedBodyIds, registerBodyFlush } from './body-flush';

test('немонтированное тело nothing; старая уборка не снимает новую регистрацию с тем же callback', async () => {
  expect(await flushBodyOf('x')).toBe('nothing');
  const flush = async () => 'saved' as const;
  const old = registerBodyFlush('x', flush, () => 3);
  const current = registerBodyFlush('x', flush, () => 4);
  old();
  expect(bodyRevisionOf('x')).toBe(4);
  expect(mountedBodyIds()).toContain('x');
  expect(await flushBodyOf('x')).toBe('saved');
  current();
  expect(mountedBodyIds()).not.toContain('x');
});

test('flush covers both editors and honors an older editor blocked by unapplied Markdown', async () => {
  const order: string[] = [];
  const first = registerBodyFlush('both', async () => {
    order.push('first');
    return 'blocked';
  });
  const second = registerBodyFlush('both', async () => {
    order.push('second');
    return 'nothing';
  });
  try {
    expect(await flushBodyOf('both')).toBe('blocked');
    expect(order).toEqual(['first']);
    first();
    expect(await flushBodyOf('both')).toBe('nothing');
    expect(order).toEqual(['first', 'second']);
  } finally {
    first();
    second();
  }
});

test('a replacement registration during another flush blocks a rewrite', async () => {
  const first = registerBodyFlush('changing', async () => 'nothing');
  let acknowledge: (value: 'saved') => void = () => {};
  const second = registerBodyFlush(
    'changing',
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const result = flushBodyOf('changing');
  await Promise.resolve();
  first();
  const replacement = registerBodyFlush('changing', async () => 'nothing');
  try {
    acknowledge('saved');
    expect(await result).toBe('blocked');
  } finally {
    second();
    replacement();
  }
});

test('a newer settled version still invalidates the previous editor checkpoint', async () => {
  let version = 1;
  let acknowledge: (value: 'saved') => void = () => {};
  const first = registerBodyFlush(
    'newer',
    async () => 'nothing',
    undefined,
    undefined,
    () => version,
  );
  const second = registerBodyFlush(
    'newer',
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const result = flushBodyOf('newer');
  await Promise.resolve();
  version = 2;
  try {
    acknowledge('saved');
    expect(await result).toBe('blocked');
  } finally {
    first();
    second();
  }
});
