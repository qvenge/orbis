// Web Vitals и «сервер против сети» (спека скорости §3.1): INP/LCP — библиотека Google `web-vitals`; время сервера —
// `PerformanceResourceTiming.serverTiming` запросов tRPC (same-origin, `Timing-Allow-Origin` не нужен).
import type { PerfSample } from '@orbis/shared';
import { perfBase, recordSample } from './collector';

const PROC_RE = /^[a-zA-Z.,]{1,200}$/;
const round = (v: number) => Math.min(600_000, Math.max(0, Math.round(v * 10) / 10));

export function requestSampleOf(e: {
  name: string;
  duration: number;
  serverTiming?: ReadonlyArray<{ name: string; duration: number }>;
}): Omit<PerfSample, 'device' | 'net' | 'appVersion'> | null {
  let path: string;
  try {
    path = new URL(e.name, window.location.origin).pathname;
  } catch {
    return null;
  }
  const i = path.indexOf('/trpc/');
  if (i < 0) return null;
  const procedure = decodeURIComponent(path.slice(i + 6));
  if (!PROC_RE.test(procedure) || procedure.split(',').includes('perf.report')) return null;
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

export function startVitals(): void {
  if (typeof PerformanceObserver === 'undefined') return;
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
  // Отдельным чанком: входной чанк входит в эагерное замыкание экрана записи (порог CI). LCP и события
  // web-vitals наблюдает с буфера — поздняя подписка их не теряет.
  void import('web-vitals')
    .then(({ onINP, onLCP }) => {
      onINP((m) => recordSample({ ...perfBase(), metric: 'inp', durMs: round(m.value) }));
      onLCP((m) => recordSample({ ...perfBase(), metric: 'lcp', durMs: round(m.value) }));
    })
    .catch(() => {});
}
