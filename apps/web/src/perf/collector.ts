// Полевые замеры (спека скорости §3.2): буфер в памяти, пачка раз в 30 с и при уходе страницы в фон. Транспорт —
// отдельный ванильный клиент tRPC с `fetch keepalive`: `sendBeacon` не умеет заголовка авторизации, запрос с keepalive
// переживает выгрузку. «Общий компьютер» замеры не отключает — содержимого в них нет (§3.2).
import type { AppRouter } from '@orbis/server/src/router';
import type { PerfSample } from '@orbis/shared';
import { createTRPCClient, httpLink } from '@trpc/client';
import { APP_VERSION } from '../app/version';
import { getCurrentToken } from '../auth/AuthProvider';
import { TRPC_URL, trpcHeaders } from '../trpc';

export const PERF_FLUSH_MS = 30_000;
export const PERF_BATCH_MAX = 100; // потолок схемы `perfReportInput`
const BUFFER_MAX = 5 * PERF_BATCH_MAX; // сверх — отбрасывается старое: замер не данные владельца
const NETS = new Set(['slow-2g', '2g', '3g', '4g']);
let buffer: PerfSample[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let client: ReturnType<typeof createTRPCClient<AppRouter>> | null = null;

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

function flush(): void {
  if (buffer.length === 0 || client === null || getCurrentToken() === null) return;
  const samples = buffer.slice(0, PERF_BATCH_MAX);
  buffer = buffer.slice(PERF_BATCH_MAX);
  // Отказ сети или сервера замер не повторяет — повтор копил бы их; ответ `{accepted, dropped}` не читается.
  void client.perf.report.mutate({ samples }).catch(() => {});
}
function onHidden(): void {
  if (document.visibilityState === 'hidden') flush();
}

export function startCollector(): void {
  if (timer !== null) return;
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

/** Тестам: снять таймер и слушателей, опустошить буфер. */
export function resetCollectorForTests(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  client = null;
  buffer = [];
  window.removeEventListener('visibilitychange', onHidden);
  window.removeEventListener('pagehide', flush);
}
