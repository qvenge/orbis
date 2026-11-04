import { expect, test } from 'bun:test';
import { SignJWT } from 'jose';
import { chromium, type Page } from 'playwright-core';
import type { AiDeps } from '../../../apps/server/src/ai/send-message';
import { createApp } from '../../../apps/server/src/app';
import { makeDb } from '../../../apps/server/src/db/client';
import { startChangeListener } from '../../../apps/server/src/freshness/listener';
import { appRouter } from '../../../apps/server/src/router';
import { freshGraph, personal } from '../../../apps/server/test/helpers';

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait };
}

async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw Error(label);
}

function idbRows(page: Page, name: string, store: string) {
  return page.evaluate(async ({ name, store }) => {
    if (!(await indexedDB.databases()).some((db) => db.name === name)) return [];
    return new Promise<any[]>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(store)) { db.close(); resolve([]); return; }
        const read = db.transaction(store).objectStore(store).getAll();
        read.onerror = () => { db.close(); reject(read.error); };
        read.onsuccess = () => { db.close(); resolve(read.result); };
      };
    });
  }, { name, store });
}

test('real detail and side chat keep action-correlated read counts and exact ACK persistence', async () => {
  const dsn = new URL(process.env.DATABASE_URL ?? '');
  expect([dsn.hostname, dsn.port]).toEqual(['127.0.0.1', '54339']);
  expect(process.env.ORBIS_CHANGE_STREAM).not.toBe('0');
  const { db, client, makeListenerClient } = makeDb();
  const account = await freshGraph();
  const caller = appRouter.createCaller({
    identity: personal(account), actorKind: 'owner', db, clientVersion: '0.7.0',
  });
  await caller.user.seedOnboarding();
  const record = await caller.entity.create({ source: 'ui', input: {
    title: 'Local causal body fixture', body: 'Initial local body', tags: [], aspects: ['orbis/note'],
  } });
  const thread = await caller.chat.ensureThread({});
  const chatText = 'Retained side chat tail for body causality';
  await caller.chat.appendUserMessage({ id: crypto.randomUUID(), threadId: thread.threadId, content: chatText });
  const listener = startChangeListener(makeListenerClient);
  const app = createApp({ db, ai: {} as AiDeps, changeListener: listener });
  const requests: { phase: string; paths: string[]; target: boolean; held: boolean; method: string }[] = [];
  const heartbeats: { phase: string }[] = [];
  const reads = gate();
  const ack = gate();
  let phase = 'startup';
  let holdReads = false;
  let ungatedTargetReads = 0;
  let holdAck = false;
  let heldReply: { status: number; id: string; bodyRevision: number; txId: string; bodyDoc: unknown } | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const paths = url.pathname.startsWith('/trpc/') ? url.pathname.slice('/trpc/'.length).split(',') : [];
      const target = req.method === 'GET' && paths.includes('entity.get') &&
        !!url.searchParams.get('input')?.includes(record.id);
      if (paths.length && req.headers.has('authorization'))
        requests.push({ phase, paths, target, held: target && holdReads, method: req.method });
      const stream = paths.includes('changes.watch');
      if (stream) server.timeout(req, 90);
      const ungated = target && !holdReads;
      if (ungated) ungatedTargetReads++;
      if (target && holdReads) {
        server.timeout(req, 90);
        await reads.wait;
      }
      const response = await app.fetch(req).finally(() => {
        if (ungated) ungatedTargetReads--;
      });
      if (holdAck && req.method === 'POST' && paths.includes('entity.update') && !heldReply) {
        const raw = await response.clone().json();
        const item = Array.isArray(raw) ? raw[paths.indexOf('entity.update')] : raw;
        const data = item?.result?.data?.json ?? item?.result?.data;
        heldReply = { status: response.status, id: data?.id, bodyRevision: data?.bodyRevision,
          txId: data?.txId, bodyDoc: data?.bodyDoc };
        await ack.wait;
      }
      if (!stream || !response.body) return response;
      const decoder = new TextDecoder();
      let pending = '';
      const body = response.body.pipeThrough(new TransformStream({
        transform(chunk: Uint8Array, controller) {
          pending += decoder.decode(chunk, { stream: true });
          const events = pending.split(/\r?\n\r?\n/);
          pending = events.pop() ?? '';
          for (const event of events)
            if (/^event: ?ping$/m.test(event)) heartbeats.push({ phase });
          controller.enqueue(chunk);
        },
      }));
      return new Response(body, { status: response.status, headers: response.headers });
    },
  });
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === server.url.origin ? route.continue() : route.abort());
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(account).setAudience('authenticated').setExpirationTime(expires)
      .sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!));
    await context.addInitScript(({ origin, account, jwt, expires }) => {
      if (location.origin !== origin) return;
      localStorage.setItem('sb-localhost-auth-token', JSON.stringify({ access_token: jwt,
        refresh_token: 'local-only', expires_at: expires, expires_in: 3600, token_type: 'bearer',
        user: { id: account, role: 'authenticated', aud: 'authenticated', app_metadata: {}, user_metadata: {} },
      }));
    }, { origin: server.url.origin, account, jwt, expires });
    const page = await context.newPage();
    await page.goto(new URL('/r/' + record.id, server.url).href);
    await page.getByText('Initial local body', { exact: true }).waitFor();
    await page.getByTestId('host-chat').click();
    const side = page.locator(`#side-chat [data-thread-id="${thread.threadId}"][data-thread-ready="true"]`);
    await side.getByText(chatText, { exact: true }).waitFor();
    await side.getByRole('textbox', { name: 'Сообщение' }).waitFor();
    const editor = page.getByTestId('body-editor').locator('[contenteditable=true]');
    const preview = page.getByTestId('editor-preview');
    if (await preview.isVisible()) await preview.click();
    await editor.waitFor();
    const cached = async () => (await idbRows(page, 'orbis-cache:' + account, 'responses'))
      .find((row) => row.data?.entity?.id === record.id && row.data.entity.bodyDoc)?.data.entity;
    await until(cached, 'initial exact detail durable');
    expect(requests.some(({ paths }) => paths.includes('changes.watch'))).toBe(true);
    await editor.evaluate((node) => {
      (node as HTMLElement).focus();
      const selection = window.getSelection();
      selection?.selectAllChildren(node);
      selection?.collapseToEnd();
    });

    phase = 'typing-30s';
    const begin = Date.now();
    let strokes = 0;
    while (Date.now() - begin < 30_000) {
      await page.keyboard.insertText(' x');
      strokes++;
      await Bun.sleep(700);
    }
    const finalTyped = await editor.innerText();
    await until(async () => {
      const body = await cached();
      return body?.body?.trim() === finalTyped.trim() ? body : undefined;
    }, 'last typed body is durable before strict causality window');
    await side.getByText(chatText, { exact: true }).waitFor();

    phase = 'strict-ack-before-get';
    holdReads = true;
    holdAck = true;
    await until(async () => ungatedTargetReads === 0 ? true : undefined, 'pre-window target reads drained');
    const prior = await cached();
    const priorServer = await caller.entity.get({ id: record.id, include: ['body'] });
    expect(priorServer.entity.bodyRevision).toBe(prior.bodyRevision);
    const strictText = ' Strict ACK witness';
    await page.keyboard.insertText(strictText);
    const incoming = await until(async () => heldReply, 'real HTTP ACK held');
    expect(incoming).toMatchObject({ status: 200, id: record.id, bodyRevision: prior.bodyRevision + 1 });
    expect(incoming.txId).toMatch(/^\d+$/);
    const inputs = async () => (await idbRows(page, 'orbis-input:' + account, 'slots'))
      .flatMap((row) => [row.snapshot, row.acknowledgedFallback]).filter(Boolean);
    const exact = await until(async () => (await inputs()).find((snapshot) =>
      snapshot.token.entityId === record.id && JSON.stringify(snapshot.doc).includes(strictText.trim())),
    'exact input token checkpointed while HTTP response is held');
    expect((await cached()).bodyRevision).toBe(prior.bodyRevision);
    ack.release();
    const proven = await until(async () => {
      const stored = await cached();
      const stillDraft = (await inputs()).some((entry) => entry.token.nonce === exact.token.nonce);
      return stored?.bodyRevision === incoming.bodyRevision &&
        JSON.stringify(stored.bodyDoc) === JSON.stringify(incoming.bodyDoc) && !stillDraft
        ? stored : undefined;
    }, 'exact durable body and token retirement without releasing any target GET');
    expect(proven.bodyRevision).toBe(incoming.bodyRevision);
    const strictReads = requests.filter((entry) => entry.phase === phase && entry.target);
    expect(strictReads.every((entry) => entry.held)).toBe(true);
    holdAck = false;
    holdReads = false;
    reads.release();
    phase = 'after-ack-no-input';
    await Bun.sleep(6000);
    await side.getByText(chatText, { exact: true }).waitFor();
    expect(await editor.innerText()).toContain(strictText.trim());
    const summarize = (label: string) => {
      const rows = requests.filter((entry) => entry.phase === label);
      const occurrences = (names: string[]) =>
        rows.flatMap((row) => row.paths).filter((path) => names.includes(path)).length;
      return {
        bodyWrites: occurrences(['entity.update']),
        targetGetRequests: rows.filter((row) => row.target).length,
        allEntityGets: occurrences(['entity.get']),
        chatReads: occurrences(['chat.openThread', 'chat.listMessages', 'chat.threadEntity', 'chat.listThreads']),
        watchOpens: occurrences(['changes.watch']),
        heartbeats: heartbeats.filter((item) => item.phase === label).length,
        reconciles: occurrences(['changes.reconcile']),
      };
    };
    console.log(JSON.stringify({ scenario: '30s-body-sidechat-action-counts', strokes,
      typing: summarize('typing-30s'), strict: summarize('strict-ack-before-get'),
      afterAck: summarize('after-ack-no-input'), strictReads, txId: incoming.txId,
      bodyRevision: incoming.bodyRevision, token: exact.token, durableBeforeReleasingGets: true }));
    await context.close();
  } finally {
    ack.release();
    reads.release();
    await browser.close();
    server.stop(true);
    await listener.close();
    await client.end();
  }
}, 90_000);
