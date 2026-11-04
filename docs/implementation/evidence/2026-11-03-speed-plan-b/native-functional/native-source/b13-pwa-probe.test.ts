import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { AiDeps } from './apps/server/src/ai/send-message';
import { createApp } from './apps/server/src/app';
import { appRouter } from './apps/server/src/router';
import { appDb, freshGraph, personal } from './apps/server/test/helpers';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const secret = 'only-local-b11-pwa-fixture-48c3f705babb8b15';
const storageKey = 'sb-localhost-auth-token';
const firstBody = 'B11 body retained in a real offline app';
const entityText = 'B11 entity thread sentinel';
const globalText = 'B11 global thread sentinel';

async function requireVisible(page: Page, selector: string) {
  await page.locator(selector).waitFor({ state: 'visible', timeout: 12_000 });
}

async function eventually(predicate: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(40);
  }
  throw new Error(what);
}

async function openProperties(page: Page) {
  await page.getByTestId('screen-menu').click();
  await page.getByRole('menuitem', { name: 'Свойства и связи' }).click();
  await requireVisible(page, '[data-testid="panel-scroll"]');
}

test('real Hono/DB/Chrome startup and controlled PWA offline restart', async () => {
  expect(new URL(process.env.DATABASE_URL!).port).toBe('54339');
  expect(new URL(process.env.DATABASE_URL_ADMIN!).port).toBe('54339');
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_JWKS_URL;
  process.env.SUPABASE_JWT_SECRET = secret;
  const graph = await freshGraph();
  const { db, client } = appDb();
  const caller = appRouter.createCaller({ identity: personal(graph), actorKind: 'owner', db, clientVersion: null });
  const now = Math.floor(Date.now() / 1000);
  async function session(expires: number) {
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(graph)
      .setAudience('authenticated')
      .setExpirationTime(expires)
      .sign(new TextEncoder().encode(secret));
    return {
      access_token: token,
      refresh_token: 'b11-local-probe-refresh',
      expires_at: expires,
      expires_in: Math.max(1, expires - now),
      token_type: 'bearer',
      user: { id: graph, app_metadata: {}, user_metadata: {}, aud: 'authenticated' },
    };
  }
  const current = await session(now + 3600);
  const expired = await session(now - 1000);
  await caller.user.seedOnboarding();
  const entity = await caller.entity.create({ input: { title: 'B11 offline record', body: firstBody, tags: [] }, source: 'quick_capture' });
  const recordThread = await caller.chat.ensureThread({ entityId: entity.id });
  const globalThread = await caller.chat.ensureThread({});
  await caller.chat.appendUserMessage({ id: crypto.randomUUID(), threadId: recordThread.threadId, content: entityText });
  await caller.chat.appendUserMessage({ id: crypto.randomUUID(), threadId: globalThread.threadId, content: globalText });

  const api = createApp({ db, ai: {} as AiDeps, webDistDir: process.env.WEB_DIST_DIR });
  const seen: { path: string; method: string; credentialed: boolean }[] = [];
  let holdSettings: Promise<void> | undefined;
  let releaseSettings: (() => void) | undefined;
  let holdChatCode: Promise<void> | undefined;
  let releaseChatCode: (() => void) | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const credentialed = request.headers.has('authorization');
      seen.push({ path, method: request.method, credentialed });
      if (path.startsWith('/auth/v1/')) return new Response(null, { status: 503 });
      if (credentialed && path.includes('user.getSettings')) await holdSettings;
      if (path.includes('/assets/ChatPanel-')) await holdChatCode;
      return api.fetch(request);
    },
  });
  const base = server.url.origin;
  const profiles = mkdtempSync('/private/tmp/orbis-b11-chrome-');
  let browser: BrowserContext | undefined;
  const open = (name: string, serviceWorkers: 'allow' | 'block', mobile = false) =>
    chromium.launchPersistentContext(join(profiles, name), {
      executablePath: chrome,
      headless: true,
      serviceWorkers,
      viewport: mobile ? { width: 414, height: 890 } : { width: 1440, height: 1000 },
      args: ['--no-first-run', '--no-default-browser-check'],
    });
  const authenticate = async (context: BrowserContext) =>
    context.addInitScript(({ key, value }) => {
      if (location.protocol === 'http:' && !localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify(value));
    }, { key: storageKey, value: current });
  const noteUrl = `${base}/r/${entity.id}`;
  const shellFor = (id: string) => `[data-thread-id="${id}"][data-thread-ready="true"]`;
  const credentialedPaths = (entries: typeof seen) =>
    entries.filter((entry) => entry.credentialed && entry.path.startsWith('/trpc/'));
  try {
    // Empty browser cache. Hold the settings response and the chat UI module on separate passes.
    browser = await open('cold', 'block');
    await authenticate(browser);
    let page = browser.pages()[0]!;
    holdSettings = new Promise((resolve) => { releaseSettings = resolve; });
    await page.goto(noteUrl, { waitUntil: 'domcontentloaded' });
    for (const path of ['user.getSettings', 'registry.effective', 'entity.get', '/assets/DetailScreen-']) {
      await eventually(() => seen.some((entry) => entry.path.includes(path) &&
        (path.startsWith('/assets/') || entry.credentialed)), `missing early ${path}`);
    }
    await requireVisible(page, '[data-testid="onboarding-splash"]');
    console.log(JSON.stringify({ coldStartup: seen.filter((entry) => entry.credentialed || entry.path.includes('DetailScreen-')) }));
    releaseSettings?.();
    holdSettings = undefined;
    await page.getByText(firstBody, { exact: true }).waitFor({ timeout: 12_000 });

    holdChatCode = new Promise((resolve) => { releaseChatCode = resolve; });
    const coldChat = seen.length;
    await page.getByTestId('host-chat').click();
    await eventually(() => seen.slice(coldChat).some((entry) => entry.path.includes('ChatPanel-')), 'chat UI module was not requested');
    await eventually(() => seen.slice(coldChat).some((entry) => entry.method === 'POST' && entry.path.includes('chat.openThread')), 'chat POST waited for the UI chunk');
    expect(await page.locator(shellFor(globalThread.threadId)).count()).toBe(0);
    releaseChatCode?.();
    holdChatCode = undefined;
    await page.getByText(globalText, { exact: true }).waitFor({ timeout: 12_000 });
    await requireVisible(page, `#side-chat ${shellFor(globalThread.threadId)} input[aria-label="Сообщение"]`);
    const coldChatRequests = credentialedPaths(seen.slice(coldChat));
    expect(coldChatRequests.filter((entry) => entry.path.includes('chat.openThread'))).toHaveLength(1);
    expect(coldChatRequests.filter((entry) => entry.path.includes('chat.listMessages'))).toHaveLength(0);
    console.log(JSON.stringify({ coldChatRequests }));
    await browser.close();

    // Desktop and phone visit the real built screens, then Chrome is closed and the
    // same isolated profile is restarted offline with the expiry already in its SDK slot.
    for (const mobile of [false, true]) {
      const name = mobile ? 'phone' : 'desktop';
      browser = await open(name, 'allow', mobile);
      await authenticate(browser);
      page = browser.pages()[0]!;
      await page.goto(noteUrl, { waitUntil: 'domcontentloaded' });
      await page.getByText(firstBody, { exact: true }).waitFor({ timeout: 12_000 });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 20_000 });
      if (!mobile) {
        await openProperties(page);
        await page.keyboard.press('Escape');
        await page.getByRole('tab', { name: 'Тред' }).click();
        await page.getByText(entityText, { exact: true }).waitFor({ timeout: 12_000 });
        await page.getByRole('tab', { name: 'Запись' }).click();
      }
      await page.getByTestId('host-chat').click();
      await page.getByText(globalText, { exact: true }).waitFor({ timeout: 12_000 });
      await requireVisible(page, `${shellFor(globalThread.threadId)} input[aria-label="Сообщение"]`);
      const cacheShape = await page.waitForFunction(async ({ graph, entityId, globalId, mobile }) => {
        const data = await new Promise<any[]>((resolve, reject) => {
          const open = indexedDB.open(`orbis-cache:${graph}`);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const get = db.transaction('responses').objectStore('responses').getAll();
            get.onerror = () => { db.close(); reject(get.error); };
            get.onsuccess = () => { db.close(); resolve(get.result); };
          };
        });
        const find = (a: unknown, b: unknown) => data.find((row) => row.key[0] === a && row.key[1] === b);
        const binding = find('chatOpen', null);
        const outer = find('chatThread', globalId);
        const inner = data.find((row) => row.key[0]?.join?.('.') === 'chat.listMessages' &&
          row.key[1]?.input?.threadId === globalId);
        const detail = data.find((row) => row.key[0]?.join?.('.') === 'entity.get' &&
          row.key[1]?.input?.id === entityId && Array.isArray(row.key[1]?.input?.include));
        if (!binding || !outer || !inner || !detail || (!mobile && !find('chatOpen', entityId))) return false;
        return {
          binding: binding.data, outer: outer.data.pages.length, inner: inner.data.length,
          oldest: binding.receivedAt, detail: detail.data.entity.id,
        };
      }, { graph, entityId: entity.id, globalId: globalThread.threadId, mobile }, { timeout: 12_000 });
      const durable = await cacheShape.jsonValue();
      expect(durable).toMatchObject({
        binding: { threadId: globalThread.threadId }, outer: 1, detail: entity.id,
      });
      await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
        { key: storageKey, value: expired });
      await browser.close();

      browser = await open(name, 'allow', mobile);
      await browser.setOffline(true);
      page = browser.pages()[0]!;
      const offline = seen.length;
      const assets = new Set<string>();
      page.on('response', (response) => {
        if (response.fromServiceWorker()) assets.add(new URL(response.url()).pathname);
      });
      await page.goto(mobile ? `${base}/chat` : noteUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 12_000 });
      if (!mobile) {
        await page.getByText(firstBody, { exact: true }).waitFor({ timeout: 12_000 });
        const status = page.getByText(/нет сети · экран на \d{2}:\d{2} · часть данных недоступна/).first();
        await status.waitFor({ timeout: 12_000 });
        console.log(JSON.stringify({ offlineDetailStatus: await status.textContent(), online: await page.evaluate(() => navigator.onLine) }));
        await openProperties(page);
        await page.keyboard.press('Escape');
        await page.getByRole('tab', { name: 'Тред' }).click();
        await page.getByText(entityText, { exact: true }).waitFor({ timeout: 12_000 });
        await page.getByLabel('Сообщение').fill('B11 offline ordinary command');
        await page.getByRole('button', { name: 'Отправить' }).click();
        await page.getByTestId('error-card').getByText('Не удалось отправить сообщение.').waitFor({ timeout: 12_000 });
        await page.getByTestId('host-chat').click();
      }
      await page.getByText(globalText, { exact: true }).waitFor({ timeout: 12_000 });
      await requireVisible(page, `${shellFor(globalThread.threadId)} input[aria-label="Сообщение"]`);
      expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}').expires_at, storageKey))
        .toBe(expired.expires_at);
      expect(credentialedPaths(seen.slice(offline))).toHaveLength(0);
      const cacheURLs = await page.evaluate(async () => {
        const all = await Promise.all((await caches.keys()).map(async (name) =>
          (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname)));
        return all.flat();
      });
      expect(cacheURLs.filter((path) => path.startsWith('/trpc/'))).toEqual([]);
      expect([...assets].some((path) => path.includes('/assets/ChatPanel-'))).toBe(true);
      if (!mobile) {
        expect([...assets].some((path) => path.includes('/assets/DetailScreen-'))).toBe(true);
        expect([...assets].some((path) => path.includes('/assets/PropertiesRelationsPanel-'))).toBe(true);
      }
      console.log(JSON.stringify({ pwaOffline: name, profile: profiles, sources: [...assets], durable }));
      await browser.close();
      browser = undefined;
    }
  } finally {
    releaseSettings?.();
    releaseChatCode?.();
    await browser?.close();
    await server.stop(true);
    await client.end();
  }
}, 180_000);
