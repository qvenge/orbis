// Полевые замеры (спека скорости §3.2): буфер в памяти. Он — во входном чанке, потому что его пишут метки экрана записи;
// транспорт пачек и наблюдатели Web Vitals грузятся ленивым чанком `perf/boot` (гейт задачи 3, I-1: в эагерном
// замыкании экрана записи — только склейка). Замеры, сделанные до загрузки чанка, ждут здесь и уходят первой пачкой.
// «Общий компьютер» замеры не отключает — содержимого в них нет (§3.2).
import type { PerfSample } from '@orbis/shared';
import { APP_VERSION } from '../app/version';

export const PERF_BATCH_MAX = 100; // потолок схемы `perfReportInput`
const BUFFER_MAX = 5 * PERF_BATCH_MAX; // сверх — отбрасывается старое: замер не данные владельца
const NETS = new Set(['slow-2g', '2g', '3g', '4g']);
let buffer: PerfSample[] = [];

/** Общие поля замера: устройство, сеть (где браузер её называет), версия приложения. */
export function perfBase(): Pick<PerfSample, 'device' | 'net' | 'appVersion'> {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const eff = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection
    ?.effectiveType;
  return {
    device: coarse ? 'mobile' : 'desktop',
    ...(eff !== undefined && NETS.has(eff) ? { net: eff as NonNullable<PerfSample['net']> } : {}),
    appVersion: APP_VERSION,
  };
}

export function recordSample(s: PerfSample): void {
  buffer.push(s);
  if (buffer.length > BUFFER_MAX) buffer = buffer.slice(buffer.length - BUFFER_MAX);
}

/** Транспорту (`perf/transport.ts`, через `perfBuffer`): следующая пачка — до `PERF_BATCH_MAX` старейших замеров, вынутых из буфера. */
export function takeBatch(): PerfSample[] {
  const batch = buffer.slice(0, PERF_BATCH_MAX);
  buffer = buffer.slice(PERF_BATCH_MAX);
  return batch;
}

export function hasSamples(): boolean {
  return buffer.length > 0;
}

/**
 * Буфер для ленивого чанка `perf/boot` — ПЕРЕДАЁТСЯ ему из `main.tsx`, а не импортируется им: статическое ребро из
 * ленивого чанка к этому модулю вынесло бы буфер в отдельный общий чанк замыкания экрана записи (замерено сборкой:
 * +133 Б gzip замыкания; гейт задачи 3, I-1). Транспорт и `vitals.ts` берут отсюда только тип.
 */
export interface PerfBuffer {
  recordSample(s: PerfSample): void;
  perfBase(): Pick<PerfSample, 'device' | 'net' | 'appVersion'>;
  takeBatch(): PerfSample[];
  hasSamples(): boolean;
}
export const perfBuffer: PerfBuffer = { recordSample, perfBase, takeBatch, hasSamples };

/** Тестам: опустошить буфер. */
export function resetBufferForTests(): void {
  buffer = [];
}
