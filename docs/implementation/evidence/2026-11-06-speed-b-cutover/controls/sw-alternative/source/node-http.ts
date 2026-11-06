// This adapts the existing harness handler, not application routes or semantics.
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);
export async function serve(options: {
  hostname: '127.0.0.1'; port: 0; idleTimeout?: number;
  fetch: (request: Request) => Response | Promise<Response>;
}) {
  const sockets = new Set<Socket>();
  const active = new Set<AbortController>();
  const errors: unknown[] = [];
  let port = 0;
  const server = createServer(async (req, res) => {
    const abort = new AbortController(); active.add(abort);
    const onAborted = () => abort.abort(new Error('Client aborted request'));
    const onResponseClose = () => { if (!res.writableFinished) onAborted(); };
    req.once('aborted', onAborted);
    res.once('close', onResponseClose);
    // IncomingMessage.close also fires after a complete, normal request body.
    // It must never abort an otherwise live held response.
    if (req.aborted) onAborted();
    try {
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        if (!hop.has(name.toLowerCase())) headers.append(name, req.rawHeaders[i + 1]!);
      }
      // Proxies receive absolute-form URLs; origin servers receive /path.
      // Never concatenate an absolute URL onto the local fixture origin.
      const target = /^https?:\/\//i.test(req.url ?? '')
        ? new URL(req.url!) : new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const init = { method: req.method, headers, signal: abort.signal,
        ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}) } as RequestInit;
      const response = await options.fetch(new Request(target, init));
      if (abort.signal.aborted) { await response.body?.cancel(); return; }
      res.statusCode = response.status;
      if (response.statusText) res.statusMessage = response.statusText;
      for (const [name, value] of response.headers) {
        if (name !== 'set-cookie' && !hop.has(name)) res.setHeader(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      if (req.method === 'HEAD' || !response.body) res.end();
      else {
        // Stream the first SSE chunk immediately; pipeline supplies backpressure,
        // and destroys/cancels the source on a disconnected response.
        res.flushHeaders();
        await pipeline(Readable.fromWeb(response.body as never), res);
      }
    } catch (error) {
      if (!abort.signal.aborted) { errors.push(error); console.error('node-http-adapter-error', error); }
      if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
    } finally {
      active.delete(abort); req.off('aborted', onAborted); res.off('close', onResponseClose);
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.on('upgrade', (_req, socket) => socket.destroy());
  if (options.idleTimeout === 0) {
    server.timeout = 0; server.requestTimeout = 0; server.headersTimeout = 0; server.keepAliveTimeout = 0;
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(options.port, options.hostname, resolve);
  });
  port = (server.address() as { port: number }).port;
  return { port, url: new URL('http://127.0.0.1:' + port),
    async stop(force = false) {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (force) {
        for (const controller of active) controller.abort(new Error('Owned harness server stopping'));
        for (const socket of sockets) socket.destroy();
      } else server.closeIdleConnections();
      await closed;
      if (errors.length) throw new AggregateError(errors, 'Unexpected harness HTTP adapter errors');
    } };
}
