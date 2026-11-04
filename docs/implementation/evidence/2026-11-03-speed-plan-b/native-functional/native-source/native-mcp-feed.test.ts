import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SignJWT } from 'jose';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import postgres from 'postgres';
import type { AiDeps } from '../../../apps/server/src/ai/send-message';
import { createApp } from '../../../apps/server/src/app';
import { makeDb } from '../../../apps/server/src/db/client';
import { startChangeListener } from '../../../apps/server/src/freshness/listener';
import { issuePatGrant } from '../../../apps/server/src/oauth/grants';
import { appRouter } from '../../../apps/server/src/router';
import { freshGraph, personal } from '../../../apps/server/test/helpers';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const trace = (value: object) => console.log(JSON.stringify(value));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
}
async function localJwt(sub: string) {
  const expiry = Math.floor(Date.now()/1000) + 3600;
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw Error('missing local auth secret');
  const token = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub).setAudience('authenticated').setExpirationTime(expiry).sign(new TextEncoder().encode(secret));
  return { access_token: token, refresh_token: 'local-b13', token_type: 'bearer', expires_in: 3600,
    expires_at: expiry, user: { id: sub, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} } };
}
async function acceptBrowserAuth(context: BrowserContext, origin: string, session: Awaited<ReturnType<typeof localJwt>>) {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : route.abort();
  });
  await context.addInitScript(({ origin, session }) => {
    if (location.origin === origin && !localStorage.getItem('sb-localhost-auth-token'))
      localStorage.setItem('sb-localhost-auth-token', JSON.stringify(session));
  }, { origin, session });
}
async function observedTitle(page: Page, title: string, timeout = 12_000) {
  return (await (await page.waitForFunction((title) => {
    const node = document.querySelector('main h1');
    return node?.textContent === title && node.getClientRects().length > 0 ? Date.now() : false;
  }, title, { polling: 20, timeout })).jsonValue()) as number;
}
function onlyLoopback(name: string) {
  const url = new URL(process.env[name] ?? '');
  expect([url.hostname, url.port]).toEqual(['127.0.0.1', '54339']);
  return url.toString();
}

test('real MCP tool and two Chrome clients on LISTEN/SSE, including held xmin and disabled stream', async () => {
  onlyLoopback('DATABASE_URL');
  const admin = postgres(onlyLoopback('DATABASE_URL_ADMIN'), { max: 2 });
  const { db, client, makeListenerClient } = makeDb();
  const listener = startChangeListener(makeListenerClient);
  const app = createApp({ db, ai: {} as AiDeps, changeListener: listener });
  const calls: { lane: string; at: number; txIds?: string[] }[] = [];
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1', fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.includes('changes.watch')) {
        expect(url.search).not.toMatch(/bearer|authorization|access.token/i);
        expect(request.headers.get('authorization')).toMatch(/^Bearer /);
        server.timeout(request, 60);
        calls.push({ lane: 'watch', at: Date.now() });
      }
      if (url.pathname.includes('changes.reconcile')) calls.push({ lane: 'reconcile', at: Date.now() });
      return app.fetch(request);
    },
  });
  const disabledApp = createApp({ db, ai: {} as AiDeps });
  const disabled = Bun.serve({
    port: 0, hostname: '127.0.0.1', async fetch(request) {
      const url = new URL(request.url);
      const at = Date.now();
      if (url.pathname.includes('changes.watch')) calls.push({ lane: 'disabled-watch', at });
      const response = await disabledApp.fetch(request);
      if (url.pathname.includes('changes.reconcile') && response.ok) {
        const output = await response.clone().json();
        const answers = Array.isArray(output) ? output : [output];
        const txIds = answers.flatMap((item: any) => {
          const data = item?.result?.data?.json ?? item?.result?.data;
          return Array.isArray(data?.transactions) ? data.transactions.map((tx: any) => String(tx.txId)) : [];
        });
        calls.push({ lane: 'disabled-reconcile', at, txIds });
      }
      return response;
    },
  });
  const agent = new Client({ name: 'b13-local-probe', version: '0.7.0' });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const flag = process.env.ORBIS_CHANGE_STREAM;
  expect(flag).not.toBe('0');
  try {
    const graph = await freshGraph();
    const fixture = await localJwt(graph);
    const caller = appRouter.createCaller({ identity: personal(graph), actorKind: 'owner', db, clientVersion: '0.7.0' });
    await caller.user.seedOnboarding();
    const initial = 'B13 local initial';
    const entity = await caller.entity.create({ source: 'ui', input: { title: initial, tags: [], aspects: ['orbis/task'] } });
    const pat = await issuePatGrant(db, { identity: personal(graph), label: 'B13 synthetic local MCP' });
    await agent.connect(new StreamableHTTPClientTransport(new URL('/mcp', server.url),
      { requestInit: { headers: { Authorization: 'Bearer ' + pat } } }));
    const contexts = await Promise.all([browser.newContext({ serviceWorkers: 'block' }), browser.newContext({ serviceWorkers: 'block' })]);
    const pages = await Promise.all(contexts.map(async (context) => {
      await acceptBrowserAuth(context, server.url.origin, fixture);
      const page = await context.newPage();
      const handshake = page.waitForResponse((r) => r.url().includes('changes.watch') && r.status() === 200);
      await page.goto(new URL('/r/' + entity.id, server.url).href, { waitUntil: 'domcontentloaded' });
      await observedTitle(page, initial);
      await handshake;
      return page;
    }));
    expect(calls.filter(({ lane }) => lane === 'watch').length).toBeGreaterThanOrEqual(2);
    async function edit(title: string) {
      const start = Date.now();
      const result = await agent.callTool({ name: 'entity_update', arguments: { id: entity.id, title } });
      expect(result.isError ?? false).toBe(false);
      const [event] = await admin`select extract(epoch from at)*1000 as at_ms, tx_id::text as tx_id
        from public.change_feed where graph_id=${graph} and kind='entity' and row_key=${entity.id}
        and operation='update' order by id desc limit 1`;
      expect(Number(event?.at_ms)).toBeGreaterThan(0);
      return { start, eventAt: Number(event?.at_ms), txId: String(event?.tx_id) };
    }
    const updated = 'B13 local MCP change';
    const committed = await edit(updated);
    const observed = await Promise.all(pages.map((page) => observedTitle(page, updated)));
    expect(observed.every((at) => at >= committed.start)).toBe(true);
    trace({ scenario: 'mcp-two-local-clients', eventAt: committed.eventAt, observed, clients: 2 });
    const ready = deferred();
    const release = deferred();
    const held = admin.begin(async (tx) => {
      await tx`select pg_current_xact_id()`;
      ready.resolve();
      await release.promise;
    });
    let eventAt = 0;
    try {
      await ready.promise;
      const start = Date.now();
      const change = await edit('B13 local held xmin');
      eventAt = change.eventAt;
      await Bun.sleep(750);
      for (const page of pages) expect(await page.locator('main h1').textContent()).toBe(updated);
      trace({ scenario: 'held-xmin-before-release', heldForMs: Date.now()-start, bothUnchanged: true });
    } finally {
      release.resolve();
      await held;
    }
    const released = Date.now();
    const heldApplied = await Promise.all(pages.map((page) => observedTitle(page, 'B13 local held xmin')));
    expect(heldApplied.every((at) => at >= released)).toBe(true);
    trace({ scenario: 'held-xmin-after-release', eventAt, released, observed: heldApplied });
    await Promise.all(contexts.map((context) => context.close()));
    await listener.close();

    process.env.ORBIS_CHANGE_STREAM = '0';
    const off = await browser.newContext({ serviceWorkers: 'block' });
    await acceptBrowserAuth(off, disabled.url.origin, fixture);
    const page = await off.newPage();
    const unavailable = page.waitForResponse((r) => r.url().includes('changes.watch') && r.status() === 503);
    await page.goto(new URL('/r/' + entity.id, disabled.url).href, { waitUntil: 'domcontentloaded' });
    await observedTitle(page, 'B13 local held xmin');
    await unavailable;
    const reconciliationStart = calls.length;
    const degraded = await edit('B13 local reconcile');
    const done = await observedTitle(page, 'B13 local reconcile');
    const postEditCalls = calls.slice(reconciliationStart).filter(({ at }) => at >= degraded.start);
    expect(postEditCalls.some(({ lane, txIds }) => lane === 'disabled-reconcile' && txIds?.includes(degraded.txId))).toBe(true);
    expect(done).toBeGreaterThanOrEqual(degraded.start);
    trace({ scenario: 'stream-off-local-fallback', eventAt: degraded.eventAt, observed: done,
      postEditRequests: postEditCalls });
    await off.close();
  } finally {
    if (flag === undefined) delete process.env.ORBIS_CHANGE_STREAM;
    else process.env.ORBIS_CHANGE_STREAM = flag;
    await browser.close();
    await agent.close();
    server.stop(true);
    disabled.stop(true);
    await listener.close();
    await Promise.all([admin.end(), client.end()]);
  }
}, 75_000);
