import { expect, test } from 'bun:test';
import { SignJWT } from 'jose';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { AiDeps } from '../../../apps/server/src/ai/send-message';
import { createApp } from '../../../apps/server/src/app';
import { makeDb } from '../../../apps/server/src/db/client';
import { appRouter } from '../../../apps/server/src/router';
import { freshGraph, personal } from '../../../apps/server/test/helpers';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const until = Date.now() + 15_000;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(50);
  } while (Date.now() < until);
  throw Error(label);
}

async function inputCopies(page: Page, account: string, id: string) {
  return page.evaluate(async ({ account, id }) => {
    const prefix = 'orbis:body-draft:' + account + ':' + id;
    const web = Object.keys(localStorage).filter((key) => key.startsWith(prefix)).flatMap((key) => {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null');
      return value ? [{ token: value.inputToken, doc: value.doc, storage: 'emergency' }] : [];
    });
    const name = 'orbis-input:' + account;
    if (!(await indexedDB.databases()).some((db) => db.name === name)) return web;
    const native = await new Promise<any[]>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('slots')) { db.close(); resolve([]); return; }
        const read = db.transaction('slots').objectStore('slots').getAll();
        read.onerror = () => { db.close(); reject(read.error); };
        read.onsuccess = () => { db.close(); resolve(read.result); };
      };
    });
    return [...web, ...native.flatMap((row) => [row.snapshot, row.acknowledgedFallback])
      .filter((value) => value?.token.entityId === id)
      .map((value) => ({ token: value.token, doc: value.doc, storage: 'idb' }))];
  }, { account, id });
}

async function openEditor(page: Page) {
  const editor = page.getByTestId('body-editor').locator('[contenteditable=true]');
  const preview = page.getByTestId('editor-preview');
  await editor.or(preview).first().waitFor();
  if (await preview.isVisible()) {
    await preview.click({ timeout: 1200 }).catch(async (error) => {
      if (!(await editor.isVisible())) throw error;
    });
  }
  await editor.waitFor();
  return editor;
}

for (const lane of ['close', 'network', '401', '412-sw-update'] as const) {
  test('exact input through ' + lane, async () => {
    const dsn = new URL(process.env.DATABASE_URL ?? '');
    expect([dsn.hostname, dsn.port]).toEqual(['127.0.0.1', '54339']);
    const previousDir = process.env.B13_PREVIOUS_DIST;
    if (!previousDir?.startsWith('/private/tmp/')) throw Error('Verified 882 normal dist required');
    const currentDir = process.env.WEB_DIST_DIR;
    if (!currentDir?.startsWith('/private/tmp/')) throw Error('Verified a0 normal dist required');
    const { db, client } = makeDb();
    const a0 = createApp({ db, ai: {} as AiDeps });
    const old = createApp({ db, ai: {} as AiDeps, webDistDir: previousDir });
    let active = lane === '412-sw-update' ? old : a0;
    let inject = false;
    let writes = 0;
    const workers: { build: string; route: string }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/sw.js') workers.push({ build: active === old ? '882' : 'a0', route: url.pathname });
        if (url.pathname.includes('entity.update') && request.method === 'POST') writes++;
        if (inject && url.pathname.includes('user.updateSettings') && request.method === 'POST') {
          inject = false;
          if (lane === '401') {
            const headers = new Headers(request.headers);
            headers.delete('authorization');
            return a0.fetch(new Request(request, { headers }));
          }
          const path = 'user.updateSettings';
          const item = { error: { code: -32012, message: 'Local compatibility fault',
            data: { code: 'PRECONDITION_FAILED', httpStatus: 412, path } } };
          return Response.json(url.searchParams.has('batch') ? [item] : item, { status: 412 });
        }
        return active.fetch(request);
      },
    });
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    let context: BrowserContext | undefined;
    try {
      const account = await freshGraph();
      const caller = appRouter.createCaller({
        identity: personal(account), actorKind: 'owner', db, clientVersion: '0.7.0',
      });
      await caller.user.seedOnboarding();
      const originalBody = 'Server body before local interruption';
      const record = await caller.entity.create({
        source: 'ui', input: { title: 'Local interruption fixture', body: originalBody,
          tags: [], aspects: ['orbis/note'] },
      });
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const jwt = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' })
        .setSubject(account).setAudience('authenticated').setExpirationTime(expires)
        .sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!));
      const session = {
        access_token: jwt, refresh_token: 'local-only', expires_at: expires,
        expires_in: 3600, token_type: 'bearer',
        user: { id: account, role: 'authenticated', aud: 'authenticated', app_metadata: {}, user_metadata: {} },
      };
      const sw = lane === '412-sw-update';
      context = await browser.newContext({ serviceWorkers: sw ? 'allow' : 'block' });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin === server.url.origin) return route.continue();
        if (url.origin === 'http://localhost:54321' && url.pathname === '/auth/v1/token') {
          if (url.searchParams.get('grant_type') === 'password')
            return route.fulfill({ json: session, headers: { 'access-control-allow-origin': '*' } });
          return route.fulfill({ status: 400, json: { error: 'invalid_grant', error_description: 'Local auth expiry' },
            headers: { 'access-control-allow-origin': '*' } });
        }
        if (url.origin === 'http://localhost:54321' && url.pathname === '/auth/v1/logout')
          return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
        return route.abort();
      });
      await context.addInitScript(({ origin, session }) => {
        if (location.origin !== origin) return;
        const key = 'sb-localhost-auth-token';
        if (!sessionStorage.getItem('__b13_initialized')) {
          sessionStorage.setItem('__b13_initialized', '1');
          if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(session));
        }
        if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', () => {
          sessionStorage.setItem('__b13_controller_changes',
            String(1 + Number(sessionStorage.getItem('__b13_controller_changes') ?? 0)));
        });
      }, { origin: server.url.origin, session });
      const address = new URL('/r/' + record.id, server.url).href;
      let page = await context.newPage();
      await page.goto(address);
      const editor = await openEditor(page);
      const oldEntry = await page.locator('script[type=module][src]').first().getAttribute('src');
      if (sw) await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      let policyPage: Page | undefined;
      if (lane === '401' || sw) {
        policyPage = await context.newPage();
        await policyPage.goto(new URL('/settings', server.url).href);
        await policyPage.getByRole('textbox', { name: 'Валюта', exact: true }).waitFor();
      }
      const pending = 'Actual pending text through ' + lane;
      // Isolate the ordinary debounce, leaving native checkpoint and all product cleanup in place.
      await page.evaluate(() => {
        const native = window.setTimeout;
        window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) =>
          native(callback, delay === 1000 ? 60_000 : delay, ...args)) as typeof window.setTimeout;
      });
      if (lane === 'network') await context.setOffline(true);
      await editor.evaluate((node, text) => {
        (node as HTMLElement).focus();
        window.getSelection()?.selectAllChildren(node);
        if (!document.execCommand('insertText', false, text)) throw Error('insertText');
      }, pending);
      expect(await editor.innerText()).toContain(pending);
      const findCopy = async (from: Page) => (await inputCopies(from, account, record.id))
        .find((copy) => JSON.stringify(copy.doc).includes(pending) && copy.token);
      const before = await waitFor(() => findCopy(page), 'exact input before interruption');
      expect(before.token.nonce).toBeTypeOf('string');
      expect(writes).toBe(0);

      const state = await caller.entity.get({ id: record.id, include: ['body'] });
      expect(state.entity.body).toContain(originalBody);
      const foreign = 'Confirmed server revision before recovering ' + lane;
      await caller.entity.update({ id: record.id, body: foreign, expectedBodyRevision: state.entity.bodyRevision });

      if (lane === 'close') {
        await page.close();
        page = await context.newPage();
        await page.goto(address);
      } else if (lane === 'network') {
        await page.reload().catch(() => {});
        await context.setOffline(false);
        await page.goto(address);
      } else {
        if (!policyPage) throw Error('missing policy page');
        inject = true;
        const response = policyPage.waitForResponse((reply) =>
          reply.url().includes('user.updateSettings') && reply.status() === (sw ? 412 : 401));
        await policyPage.getByRole('textbox', { name: 'Валюта', exact: true }).fill('USD');
        await policyPage.getByRole('button', { name: 'Сохранить', exact: true }).click();
        expect((await response).status()).toBe(sw ? 412 : 401);
        await page.getByTestId(sw ? 'update-required' : 'login-screen').waitFor();
        const protectedCopy = await waitFor(() => findCopy(page), 'exact input preserved before re-entry');
        expect(protectedCopy.token).toEqual(before.token);
        if (sw) {
          expect(workers.some(({ build }) => build === '882')).toBe(true);
          const changes = await page.evaluate(() => Number(sessionStorage.getItem('__b13_controller_changes') ?? 0));
          active = a0;
          await page.getByRole('button', { name: 'Обновить', exact: true }).click();
          await page.waitForFunction((oldEntry) =>
            document.querySelector('script[type=module][src]')?.getAttribute('src') !== oldEntry &&
            !!document.querySelector('script[type=module][src]'), oldEntry);
          await page.waitForFunction((changes) =>
            Number(sessionStorage.getItem('__b13_controller_changes') ?? 0) > changes &&
            !!navigator.serviceWorker.controller, changes);
          expect(workers.some(({ build }) => build === 'a0')).toBe(true);
        } else {
          await page.getByLabel('Email').fill('local-b13@example.invalid');
          await page.getByLabel('Пароль').fill('only-local');
          await page.getByTestId('login-screen').evaluate((form: HTMLFormElement) => form.requestSubmit());
          await page.getByTestId('login-screen').waitFor({ state: 'hidden' });
        }
        await page.goto(address);
      }

      const reopened = await openEditor(page);
      await page.getByTestId('draft-banner').getByRole('button', { name: 'Оставить моё' }).waitFor();
      expect(await reopened.innerText()).toContain(foreign);
      const after = await waitFor(() => findCopy(page), 'exact token after re-entry');
      expect(after.token).toEqual(before.token);
      expect(writes).toBe(0);
      console.log(JSON.stringify({ scenario: 'text-' + lane, before: before.storage, after: after.storage,
        token: before.token, writes, recoveryOffer: true, workers, oldEntry,
        newEntry: await page.locator('script[type=module][src]').first().getAttribute('src'),
        fault: sw ? 'local typed HTTP 412 envelope' : lane === '401' ? 'actual Hono unauthorized' : null }));
    } finally {
      await context?.close();
      await browser.close();
      server.stop(true);
      await client.end();
    }
  }, 55_000);
}
