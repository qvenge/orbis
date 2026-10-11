import { describe, expect, test, vi } from 'vitest';
import { trpcError } from '../test/harness';
import { runGraphCommand } from './graph-command';

describe('one graph write, classified by the HTTP tRPC result', () => {
  test.each([
    false,
    true,
  ])('confirmed current JournalRef preserves consequences=%s', async (consequences) => {
    expect(
      await runGraphCommand(async () => ({ actionId: 'current-journal', consequences })),
    ).toEqual({ kind: 'confirmed', actionId: 'current-journal', consequences });
  });
  test('confirmed write returns the actual action ID', async () => {
    const write = vi.fn().mockResolvedValue({ actionId: 'action-id' });
    expect(await runGraphCommand(write)).toEqual({ kind: 'confirmed', actionId: 'action-id' });
    expect(write).toHaveBeenCalledTimes(1);
  });
  test('confirmed no-op response does not invent an action ID', async () => {
    expect(await runGraphCommand(async () => ({}))).toEqual({ kind: 'confirmed' });
  });
  test.each([
    'BAD_REQUEST',
    'UNPROCESSABLE_CONTENT',
    'NOT_FOUND',
    'FORBIDDEN',
    'CONFLICT',
  ])('%s is a known rejection with only its public reason', async (code) => {
    const write = vi.fn().mockRejectedValue(trpcError(code, 'Недопустимая ссылка'));
    expect(await runGraphCommand(write)).toEqual({
      kind: 'rejected',
      message: 'Недопустимая ссылка',
    });
    expect(write).toHaveBeenCalledTimes(1);
  });
  test.each([
    'INTERNAL_SERVER_ERROR',
    'SERVICE_UNAVAILABLE',
    'TIMEOUT',
    'toString',
    '__proto__',
  ])('%s has unknown outcome and cannot disclose server details', async (code) => {
    expect(
      await runGraphCommand(async () => {
        throw trpcError(code, 'SELECT secret FROM private; stack');
      }),
    ).toEqual({ kind: 'unknown', message: 'Не удалось подтвердить сохранение' });
  });
  test.each([
    new TypeError('Failed to fetch'),
    new Error('network timeout'),
    { data: { code: 'BAD_REQUEST' }, message: 'untrusted' },
  ])('untrusted/network error is never retried: %j', async (error) => {
    const write = vi.fn().mockRejectedValue(error);
    expect(await runGraphCommand(write)).toEqual({
      kind: 'unknown',
      message: 'Не удалось подтвердить сохранение',
    });
    expect(write).toHaveBeenCalledTimes(1);
  });
  test.each([
    undefined,
    null,
    [],
    { actionId: 123 },
  ])('absent/malformed data cannot become a confirmed write: %j', async (data) => {
    const write = vi.fn().mockResolvedValue(data);
    expect(await runGraphCommand(write)).toEqual({
      kind: 'unknown',
      message: 'Не удалось подтвердить сохранение',
    });
  });
  test('synchronous transport throw is also captured once', async () => {
    expect(
      await runGraphCommand(() => {
        throw new TypeError('offline');
      }),
    ).toEqual({ kind: 'unknown', message: 'Не удалось подтвердить сохранение' });
  });
});
