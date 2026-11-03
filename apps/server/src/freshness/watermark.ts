import { AsyncLocalStorage } from 'node:async_hooks';
import { READ_WATERMARK_HEADER } from '@orbis/shared';
import type { MiddlewareHandler } from 'hono';

const store = new AsyncLocalStorage<{ minimum: string | null }>();

export const withReadWatermark: MiddlewareHandler = (_c, next) =>
  store.run({ minimum: null }, next);

export function recordReadWatermark(watermark: string): void {
  const request = store.getStore();
  if (request && (request.minimum === null || BigInt(watermark) < BigInt(request.minimum))) {
    request.minimum = watermark;
  }
}

export function readWatermarkHeaders(eagerGeneration: boolean): Headers {
  const headers = new Headers();
  const minimum = store.getStore()?.minimum;
  // SSE и потоковый HTTP batch формируют заголовки до завершения процедур.
  if (!eagerGeneration && minimum != null) headers.set(READ_WATERMARK_HEADER, minimum);
  return headers;
}
