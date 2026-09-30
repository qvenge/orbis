// Потолки приёма полевых замеров (спека скорости §3.2, РП-26): скользящая минута на аккаунт и остаток суток.
import { describe, expect, test } from 'bun:test';
import {
  PERF_BATCHES_PER_MINUTE,
  PERF_SAMPLES_PER_DAY,
  roomToday,
  takeBatchSlot,
} from './rate-limit';

describe('perf/rate-limit', () => {
  test('шесть пачек в минуту — да, седьмая — нет, через 60 001 мс — снова да', () => {
    const a = crypto.randomUUID();
    const t = 1_000_000;
    expect(PERF_BATCHES_PER_MINUTE).toBe(6);
    for (let i = 0; i < 6; i++) expect(takeBatchSlot(a, t + i)).toBe(true);
    expect(takeBatchSlot(a, t + 10)).toBe(false);
    expect(takeBatchSlot(a, t + 60_001)).toBe(true);
  });

  test('другой аккаунт независим', () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const t = 5_000_000;
    for (let i = 0; i < 6; i++) takeBatchSlot(a, t);
    expect(takeBatchSlot(a, t)).toBe(false);
    expect(takeBatchSlot(b, t)).toBe(true);
  });

  test('остаток суток: 4999 → 1, 6000 → 0', () => {
    expect(PERF_SAMPLES_PER_DAY).toBe(5000);
    expect(roomToday(4999)).toBe(1);
    expect(roomToday(6000)).toBe(0);
  });
});
