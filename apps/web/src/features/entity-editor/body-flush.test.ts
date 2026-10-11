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
