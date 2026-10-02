import { expect, test } from 'vitest';
import { staleBodyError, trpcError } from '../test/harness';
import { isTitleStale } from './orbis-error';

test('замок заголовка узнаётся по свойству расхождения; прочие 409 и кривой провод не подходят', () => {
  expect(
    isTitleStale(
      trpcError('CONFLICT', 'Отказ', {
        code: 'CONFLICT',
        details: {
          reason: 'precondition_failed',
          mismatches: [{ property: 'orbis/title' }],
        },
      }),
    ),
  ).toBe(true);
  for (const error of [
    staleBodyError(),
    trpcError('CONFLICT'),
    trpcError('CONFLICT', 'Занят id', { code: 'CONFLICT', details: { reason: 'id_conflict' } }),
    trpcError('CONFLICT', 'Статус', {
      code: 'CONFLICT',
      details: { mismatches: [{ property: 'orbis/task_status' }] },
    }),
    trpcError('CONFLICT', 'Кривая форма', { code: 'CONFLICT', details: { mismatches: {} } }),
    trpcError('CONFLICT', 'Кривые строки', {
      code: 'CONFLICT',
      details: { mismatches: [null, 'orbis/title'] },
    }),
    new Error('CONFLICT'),
  ])
    expect(isTitleStale(error)).toBe(false);
});
