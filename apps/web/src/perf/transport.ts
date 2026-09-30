// Транспорт полевых замеров (спека скорости §3.2): пачка раз в 30 с и при уходе страницы в фон. Отдельный ванильный
// клиент tRPC с `fetch keepalive`: `sendBeacon` не умеет заголовка авторизации, запрос с keepalive переживает выгрузку.
// Модуль ленивый — его грузит `perf/boot.ts` (гейт задачи 3, I-1); буфер, который он опустошает, эагерен и приходит
// аргументом `startCollector` (`collector.ts`, `PerfBuffer`).
import type { AppRouter } from '@orbis/server/src/router';
import { createTRPCClient, httpLink } from '@trpc/client';
import { getCurrentToken } from '../auth/AuthProvider';
import { TRPC_URL, trpcHeaders } from '../trpc';
import type { PerfBuffer } from './collector';

export const PERF_FLUSH_MS = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;
let buf: PerfBuffer | null = null;
let client: ReturnType<typeof createTRPCClient<AppRouter>> | null = null;

function flush(): void {
  if (buf === null || !buf.hasSamples() || client === null || getCurrentToken() === null) return;
  // Отказ сети или сервера замер не повторяет — повтор копил бы их; ответ `{accepted, dropped}` не читается.
  void client.perf.report.mutate({ samples: buf.takeBatch() }).catch(() => {});
}
function onHidden(): void {
  if (document.visibilityState === 'hidden') flush();
}

export function startCollector(buffer: PerfBuffer): void {
  if (timer !== null) return;
  buf = buffer;
  client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: TRPC_URL,
        headers: () => trpcHeaders(getCurrentToken),
        fetch: (url, init) => fetch(url, { ...(init as RequestInit), keepalive: true }),
      }),
    ],
  });
  timer = setInterval(flush, PERF_FLUSH_MS);
  // На window, не на document: событие всплывает с document, и слушатель окна идёт ПОСЛЕ слушателей document —
  // INP web-vitals, отданный на том же `visibilitychange`, успевает попасть в эту пачку.
  window.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', flush);
}

/** Тестам: снять таймер, слушателей и ссылку на буфер (сам буфер чистит `resetBufferForTests`). */
export function resetCollectorForTests(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  client = null;
  buf = null;
  window.removeEventListener('visibilitychange', onHidden);
  window.removeEventListener('pagehide', flush);
}
