// Web Vitals и «сервер против сети» (спека скорости §3.1): INP/LCP — библиотека Google `web-vitals`; время сервера —
// `PerformanceResourceTiming.serverTiming` запросов tRPC (same-origin, `Timing-Allow-Origin` не нужен).
// Модуль ленивый — его грузит `perf/boot.ts` (гейт задачи 3, I-1), поэтому `web-vitals` здесь импортируется статически:
// в эагерное замыкание экрана записи он не попадает и так.
import type { PerfSample } from '@orbis/shared';
import { onINP, onLCP } from 'web-vitals';
import type { PerfBuffer } from './collector';

/** Потолок схемы `perfSampleSchema.procedure`: имена процедур, точки и запятые, до 200 знаков. */
const PROC_MAX = 200;
const PROC_NAME_RE = /^[a-zA-Z.]+$/;
const round = (v: number) => Math.min(600_000, Math.max(0, Math.round(v * 10) / 10));

/**
 * Список процедур пачки tRPC в форме, которую примет схема (гейт задачи 3, M-5): повторы имён убираются (пачка
 * первой загрузки экрана — это десятки `entity.blocks`), а не влезающий хвост отрезается по границе имени с
 * запятой в конце — знак «список неполон». Крупная пачка — самый ценный замер «сервер против сети», терять его нельзя.
 */
export function procedureListOf(names: readonly string[]): string | null {
  const unique = [...new Set(names)];
  if (unique.length === 0 || !unique.every((n) => PROC_NAME_RE.test(n))) return null;
  const full = unique.join(',');
  if (full.length <= PROC_MAX) return full;
  let out = '';
  for (const n of unique) {
    if (out.length + n.length + 1 > PROC_MAX) break;
    out += `${n},`;
  }
  return out === '' ? null : out;
}

export function requestSampleOf(e: {
  name: string;
  duration: number;
  serverTiming?: ReadonlyArray<{ name: string; duration: number }>;
}): Omit<PerfSample, 'device' | 'net' | 'appVersion'> | null {
  let names: string[];
  try {
    const path = new URL(e.name, window.location.origin).pathname;
    const i = path.indexOf('/trpc/');
    if (i < 0) return null;
    names = decodeURIComponent(path.slice(i + 6)).split(',');
  } catch {
    return null;
  }
  // Собственная отправка замеров — не замер: иначе каждая пачка порождала бы следующую.
  if (names.includes('perf.report')) return null;
  const procedure = procedureListOf(names);
  if (procedure === null) return null;
  const app = e.serverTiming?.find((t) => t.name === 'app');
  const db = e.serverTiming?.find((t) => t.name === 'db');
  return {
    metric: 'request',
    procedure,
    durMs: round(e.duration),
    ...(app ? { serverMs: round(app.duration) } : {}),
    ...(db ? { dbMs: round(db.duration) } : {}),
  };
}

/** Буфер — аргументом, а не импортом (см. докблок `PerfBuffer`). */
export function startVitals({ recordSample, perfBase }: PerfBuffer): void {
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const s = requestSampleOf(e as PerformanceResourceTiming);
          if (s !== null) recordSample({ ...perfBase(), ...s });
        }
      }).observe({ type: 'resource', buffered: true });
    } catch {
      // браузер без Resource Timing — замеров запросов нет, прочие метрики идут
    }
  }
  // LCP и события web-vitals наблюдает с буфера браузера — подписка после загрузки ленивого чанка их не теряет.
  onINP((m) => recordSample({ ...perfBase(), metric: 'inp', durMs: round(m.value) }));
  onLCP((m) => recordSample({ ...perfBase(), metric: 'lcp', durMs: round(m.value) }));
}
