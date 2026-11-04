import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from '/private/tmp/orbis-b13-r5.tG4gJU/candidate/node_modules/playwright-core';
import { BUILTIN_REGISTRY } from '/private/tmp/orbis-b13-r5.tG4gJU/candidate/apps/web/src/test/registry';
import { searchBlockTexts } from '/private/tmp/orbis-b13-r5.tG4gJU/candidate/apps/web/src/features/search/search-query';

const source = '/private/tmp/orbis-b13-r5.tG4gJU/candidate/apps/web/dist';
const owner = '10000000-0000-4000-8000-000000009900';
const targets = {
  normal: '10000000-0000-4000-8000-000000009901',
  middle: '10000000-0000-4000-8000-000000009902',
  modified: '10000000-0000-4000-8000-000000009903',
  plain: '10000000-0000-4000-8000-000000009904',
};
const deviceKey = 'orbis:local-data:device:v1';
const stamp = '2026-11-03T12:00:00.000Z';
const freshness = {
  entityIds: [], graph: true, bodyOrStamp: false, threadIds: [],
  settings: false, registry: false, expiresAt: null,
};
const names = new Map(Object.entries(targets).map(([kind, id]) => [id, 'Shared link probe ' + kind]));
const row = (id: string) => ({
  id, graphId: owner, title: names.get(id) ?? 'Synthetic record', emoji: null,
  body: 'Synthetic record text', bodyDoc: { v: 3, doc: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Synthetic record text' }] },
  ] } }, bodyRefs: [], queryRefs: [], bodyRevision: 1, bodyChangedAt: stamp,
  tags: [], props: {}, aspects: [], archived: false, createdAt: stamp, updatedAt: stamp,
});
const token = 'eyJhbGciOiJIUzI1NiJ9.' + btoa(JSON.stringify({
  sub: owner, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
})) + '.fixture';
const settings = {
  graphId: owner, graphEstablished: true, plan: 'dev', timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB', weekStartDay: 'monday', tagColors: {}, installedViews: [],
  pinnedEntities: [], viewPreferences: {}, updatedAt: stamp, extensions: {}, appRules: {},
  disabledModules: [], today: '2026-11-04',
  nextMidnightAt: new Date(Date.now() + 3600_000).toISOString(),
};

function value(path: string, input: any) {
  if (path === 'registry.effective') return BUILTIN_REGISTRY;
  if (path === 'user.getSettings') return settings;
  if (path === 'entity.query') return { rows: [], freshness };
  if (path === 'entity.get') return {
    entity: row(input?.id ?? owner), relations: [], backlinks: [], thread: null,
    bodyAction: null, registryVersion: BUILTIN_REGISTRY.version, freshness,
  };
  if (path === 'entity.blocks') return {
    results: Object.fromEntries((input?.blocks ?? []).map((block: any) => [block.key, {
      ok: true, kind: 'rows', rows: block.text === searchBlockTexts('privacylink')?.records
        ? Object.values(targets).map(row) : [], more: 0, closedIds: [], freshness,
    }])), today: settings.today, timeZone: settings.timezone,
  };
  if (path === 'changes.reconcile') return {
    watermark: '20', floor: '0', reset: null, transactions: [],
  };
  if (path === 'user.seedOnboarding') return { seeded: false };
  return [];
}

const app = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/health') return Response.json({ ok: true });
    if (path.startsWith('/trpc/')) {
      const paths = decodeURIComponent(path.slice('/trpc/'.length)).split(',');
      if (paths.includes('changes.watch')) return new Response(null, { status: 503 });
      const authorized = request.headers.get('authorization')?.startsWith('Bearer ');
      const inputs = request.method === 'POST'
        ? await request.json()
        : JSON.parse(url.searchParams.get('input') ?? 'null');
      const batch = url.searchParams.has('batch');
      const results = paths.map((name, i) => authorized
        ? { result: { data: value(name, batch ? inputs?.[String(i)] : inputs) } }
        : { error: { code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401, path: name } } });
      return Response.json(batch ? results : results[0], {
        status: authorized ? 200 : 401,
        headers: { 'x-orbis-read-watermark': '20', 'cache-control': 'no-store' },
      });
    }
    const file = Bun.file(join(source, path === '/' ? 'index.html' : path.slice(1)));
    if (await file.exists()) return new Response(file, { headers: { 'cache-control': 'no-cache' } });
    if (path.includes('.')) return new Response('missing', { status: 404 });
    return new Response(Bun.file(join(source, 'index.html')), {
      headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' },
    });
  },
});
const origin = app.url.origin;
const profile = await mkdtemp('/private/tmp/orbis-b13-shared-link-profile.');
let browser: BrowserContext | undefined;
const loginForm = (page: Page) => page.getByTestId('login-screen');
const device = (page: Page) => page.evaluate((key) =>
  JSON.parse(localStorage.getItem(key) ?? '{"mode":"normal"}'), deviceKey);
const authHits: string[] = [];
function log(label: string, details: object) {
  console.log(JSON.stringify({ label, ...details }));
}
async function signIn(page: Page) {
  await loginForm(page).waitFor({ timeout: 12000 });
  await page.getByLabel('Email').fill('a@example.invalid');
  await page.getByLabel('Пароль').fill('synthetic-password');
  await page.getByRole('button', { name: 'Войти' }).click();
  await loginForm(page).waitFor({ state: 'hidden', timeout: 12000 });
}
async function search(page: Page) {
  const input = page.getByRole('searchbox', { name: 'Строка поиска' });
  await input.fill('privacylink');
  await page.getByTestId('search-hit-' + targets.normal).waitFor({ timeout: 10000 });
}
async function workerReady(page: Page) {
  await page.waitForFunction(async () => {
    const worker = navigator.serviceWorker.controller;
    if (!worker) return false;
    return new Promise<boolean>((resolve) => {
      const message = new MessageChannel();
      const timer = setTimeout(() => resolve(false), 1200);
      message.port1.onmessage = ({ data }) => {
        clearTimeout(timer);
        resolve(data?.protocol === 1 && data.ready === true);
      };
      worker.postMessage({ type: 'orbis-local-data-census' }, [message.port2]);
    });
  }, { timeout: 16000 });
}
async function openNative(context: BrowserContext, page: Page, id: string, middle: boolean) {
  const row = page.getByTestId('search-hit-' + id);
  const href = await row.getAttribute('href');
  const opened = context.waitForEvent('page');
  await row.click(middle ? { button: 'middle' } : { modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  const popup = await opened;
  await popup.waitForLoadState('domcontentloaded');
  return { popup, href };
}

try {
  browser = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: true, serviceWorkers: 'allow',
    viewport: { width: 410, height: 820 },
  });
  await browser.route('http://localhost:54321/auth/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    authHits.push(req.method() + ' ' + url.pathname);
    const headers = {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '*',
    };
    if (req.method() === 'OPTIONS' || url.pathname.endsWith('/logout'))
      return route.fulfill({ status: 204, headers });
    if (url.pathname.endsWith('/user'))
      return route.fulfill({ json: { id: owner, aud: 'authenticated', role: 'authenticated' }, headers });
    return route.fulfill({
      json: {
        access_token: token, refresh_token: 'synthetic-refresh',
        token_type: 'bearer', expires_in: 3600,
        user: { id: owner, aud: 'authenticated', role: 'authenticated' },
      },
      headers,
    });
  });
  const page = browser.pages()[0] ?? await browser.newPage();
  page.on('pageerror', (error) => log('page error', { message: error.message }));
  log('input', {
    shell: (await Bun.file(join(source, 'index.html')).text()).match(/assets\/index-[^"]+\.js/g),
    browser: browser.browser()?.version() ?? await page.evaluate(() => navigator.userAgent),
  });
  await page.goto(origin + '/search');
  await signIn(page);
  assert.equal((await device(page)).mode, 'normal');
  await search(page);
  const ordinary = await openNative(browser, page, targets.normal, true);
  await ordinary.popup.waitForURL('**/r/' + targets.normal);
  assert.notEqual(ordinary.href, null);
  log('normal native control', { href: ordinary.href, pathname: new URL(ordinary.popup.url()).pathname });
  await ordinary.popup.close();

  await page.goto(origin + '/settings');
  const toggle = page.getByRole('checkbox', { name: 'Это общий компьютер — не хранить данные на устройстве' });
  await toggle.waitFor({ timeout: 12000 });
  await workerReady(page);
  page.on('dialog', (dialog) => void dialog.accept());
  await toggle.click();
  await loginForm(page).waitFor({ timeout: 16000 });
  assert.equal((await device(page)).mode, 'shared');
  await page.goto(origin + '/search');
  await signIn(page);
  await search(page);
  assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(new URL(page.url()).search, '');

  const opened: Page[] = [];
  const register = (page: Page) => opened.push(page);
  browser.on('page', register);
  for (const [kind, id] of [['middle', targets.middle], ['modified', targets.modified]] as const) {
    const control = page.getByTestId('search-hit-' + id);
    assert.equal(await control.getAttribute('href'), null);
    assert.equal(await control.getAttribute('target'), null);
    assert.equal(await control.getAttribute('download'), null);
    await control.click(kind === 'middle' ? { button: 'middle' } : { modifiers: ['Meta'] });
    await control.click({ button: 'right' });
    log('shared native activation', {kind, path: new URL(page.url()).pathname, opened: opened.length});
  }
  await Bun.sleep(300);
  assert.deepEqual(opened, []);
  browser.off('page', register);
  await page.getByTestId('search-hit-' + targets.plain).press('Enter');
  await page.getByRole('heading', { name: names.get(targets.plain), exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  const plain = await page.evaluate(() => history.state);
  assert.equal(plain.orbisNav, 3);
  assert.ok(!JSON.stringify(plain).includes(targets.plain));
  log('plain shared control', { pathname: new URL(page.url()).pathname, state: plain });
  await browser.close();
  browser = undefined;
  const history = new Database(join(profile, 'Default', 'History'), { readonly: true });
  try {
    const all = history.query<{ url: string }, []>('SELECT url FROM urls ORDER BY id').all();
    const rows = Object.fromEntries(Object.entries(targets).map(([kind, id]) =>
      [kind, all.filter(({ url }) => url.includes(id)).map(({ url }) => new URL(url).pathname)]));
    assert.ok(rows.normal.length > 0);
    assert.equal(rows.plain.length, 0);
    log('closed Chrome History SQLite', { rows, authHits });
    assert.deepEqual([...rows.middle, ...rows.modified], [], 'Shared IDs persisted in Chrome History');
  } finally {
    history.close();
  }
} finally {
  await browser?.close();
  await app.stop(true);
  await rm(profile, { recursive: true, force: true });
}
