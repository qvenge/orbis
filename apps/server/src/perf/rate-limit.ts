// Потолки приёма замеров (РП-26): защита таблицы от заполнения. Пачка ≤ 100 — схемой (`perfReportInput`).
export const PERF_BATCHES_PER_MINUTE = 6;
export const PERF_SAMPLES_PER_DAY = 5000;
const WINDOW_MS = 60_000;
const recent = new Map<string, number[]>();
/** Скользящая минута на аккаунт В ПРОЦЕССЕ: инстанс один (`render.yaml`, `numInstances` не задан); при нескольких
 *  потолок станет «на инстанс» — суточный потолок в базе держит таблицу и тогда. */
export function takeBatchSlot(accountId: string, now: number): boolean {
  if (recent.size > 1000)
    for (const [k, v] of recent) if (now - (v.at(-1) ?? 0) >= WINDOW_MS) recent.delete(k);
  const kept = (recent.get(accountId) ?? []).filter((t) => now - t < WINDOW_MS);
  const ok = kept.length < PERF_BATCHES_PER_MINUTE;
  if (ok) kept.push(now);
  recent.set(accountId, kept);
  return ok;
}
export const roomToday = (countLastDay: number): number =>
  Math.max(0, PERF_SAMPLES_PER_DAY - countLastDay);
