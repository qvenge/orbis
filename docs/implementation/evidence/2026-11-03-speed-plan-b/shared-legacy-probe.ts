import assert from 'node:assert/strict';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  ignoreDefaultArgs: ['--disable-back-forward-cache'],
});
const report = (type: string, fields: object) => console.log(JSON.stringify({ type, ...fields }));

function html(legacy: boolean, document: string) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${document}</title><script>
    window.documentId = crypto.randomUUID();
    window.shell = ${JSON.stringify(legacy ? 'legacy' : 'current')};
    window.showEvents = [];
    window.addEventListener('pagehide', e => {
      if (window.shell === 'legacy') {
        localStorage.setItem('legacy-hide', JSON.stringify({
          persisted: e.persisted, id: window.documentId,
          controller: navigator.serviceWorker.controller?.scriptURL ?? null
        }));
      }
    });
    window.addEventListener('pageshow', e => {
      showEvents.push(e.persisted);
      if (window.shell === 'legacy') {
        localStorage.setItem('legacy-write', JSON.stringify({ id: window.documentId, persisted: e.persisted }));
      }
    });
    </script><main>${document}</main>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } },
  );
}

const currentShell = await html(false, '/worker-shell').text();
const worker = `
const rev = new URL(self.location.href).searchParams.get('rev');
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// Same-origin shell-only route models Workbox navigateFallback pointing to the current precache.
self.addEventListener('fetch', event => {
  if (rev !== 'second' || event.request.mode !== 'navigate') return;
  if (!['/old', '/held'].includes(new URL(event.request.url).pathname)) return;
  event.respondWith(new Response(${JSON.stringify(currentShell)}, {
    headers: { 'content-type':'text/html; charset=utf-8' },
  }));
});
async function windows() {
  return (await self.clients.matchAll({type:'window', includeUncontrolled:true}))
    .map(({id,url})=>({id,path:new URL(url).pathname})).sort((a,b)=>a.path.localeCompare(b.path));
}
self.addEventListener('message', event => {
  event.waitUntil((async () => {
    if (event.data === 'claim') await self.clients.claim();
    event.ports[0].postMessage({ rev, windows: await windows() });
  })());
});
`;

async function ask(page: Page, command: 'claim' | 'census') {
  return page.evaluate(async (cmd) => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) throw Error('no controller');
    const channel = new MessageChannel();
    return new Promise<{ rev: string; windows: { id: string; path: string }[] }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('worker timeout')), 4000);
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(timeout);
        channel.port1.close();
        resolve(data);
      };
      controller.postMessage(cmd, [channel.port2]);
    });
  }, command);
}

async function activate(page: Page, rev: string) {
  const event = await page.evaluate(async (revision) => {
    const expected = '?rev=' + revision;
    const before = navigator.serviceWorker.controller?.scriptURL ?? null;
    const changes: string[] = [];
    const changed = () => changes.push(navigator.serviceWorker.controller?.scriptURL ?? '');
    navigator.serviceWorker.addEventListener('controllerchange', changed);
    try {
      await navigator.serviceWorker.register('/sw.js' + expected, { scope: '/', updateViaCache: 'none' });
      const start = performance.now();
      while (!navigator.serviceWorker.controller?.scriptURL.endsWith(expected)) {
        if (performance.now() - start > 7000) throw Error('activation timeout ' + revision);
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      return { before, after: navigator.serviceWorker.controller.scriptURL, changes };
    } finally {
      navigator.serviceWorker.removeEventListener('controllerchange', changed);
    }
  }, rev);
  assert.equal((await ask(page, 'census')).rev, rev);
  return event;
}

async function doc(page: Page) {
  await page.waitForFunction(() => (window as any).showEvents?.length > 0);
  return page.evaluate(() => ({
    id: (window as any).documentId as string,
    shell: (window as any).shell as string,
    pageshow: (window as any).showEvents as boolean[],
    navType: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type,
    controller: navigator.serviceWorker.controller?.scriptURL ?? null,
    legacyWrite: JSON.parse(localStorage.getItem('legacy-write') ?? 'null'),
  }));
}

let epoch = 0;
async function runCase(
  name: string,
  use: (context: BrowserContext, origin: string, switchShell: () => void,
    held: Promise<void>, release: () => void) => Promise<void>,
) {
  epoch += 1;
  let legacy = true;
  const release = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      switch (url.pathname) {
        case '/sw.js':
          return new Response(worker, {
            headers: { 'content-type': 'application/javascript', 'cache-control': 'no-store' },
          });
        case '/old':
        case '/old-active':
          return html(legacy, url.pathname);
        case '/held': {
          const captured = legacy;
          held.resolve();
          await release.promise;
          return html(captured, '/held');
        }
        default:
          return html(false, url.pathname);
      }
    },
  });
  const context = await browser.newContext();
  try {
    report('case', { epoch, name, origin: server.url.origin });
    await use(context, server.url.origin, () => { legacy = false; }, held.promise, release.resolve);
  } finally {
    release.resolve();
    await context.close();
    await server.stop(true);
  }
}

async function cachedCase(rotate: boolean, uncontrolled: boolean) {
  await runCase(
    rotate ? (uncontrolled ? 'rotate-uncontrolled' : 'rotate-already-claimed') : 'repeat-claim-control',
    async (context, origin, switchShell) => {
      const old = await context.newPage();
      const cdp = await context.newCDPSession(old);
      await cdp.send('Page.enable');
      const misses: string[] = [];
      cdp.on('Page.backForwardCacheNotUsed', event => {
        misses.push(...event.notRestoredExplanations.map(reason => reason.reason));
      });
      await old.goto(origin + '/old');
      const initial = await doc(old);
      assert.equal(initial.shell, 'legacy');
      assert.equal(initial.controller, null);
      const driver = await context.newPage();
      await driver.goto(origin + '/driver');
      if (!uncontrolled) {
        report('worker-first', await activate(driver, 'first'));
        await old.waitForFunction(() =>
          navigator.serviceWorker.controller?.scriptURL.endsWith('?rev=first'));
      }
      const beforeHide = await doc(old);
      await old.goto(origin + '/neutral');
      const hidden = await driver.evaluate(() => JSON.parse(localStorage.getItem('legacy-hide') ?? 'null'));
      assert.equal(hidden?.persisted, true, 'precondition: the legacy document should enter BFCache');
      assert.equal(hidden.id, initial.id);
      if (uncontrolled) {
        // Keeping the legacy document uncontrolled after the first activation requires no earlier
        // registration. This case measures first-claim eviction rather than a repeat claim.
        assert.equal(hidden.controller, null);
      } else {
        assert.ok(hidden.controller?.endsWith('?rev=first'));
        const census = await ask(driver, 'census');
        assert.ok(census.windows.some((w) => w.path === '/driver'));
        assert.ok(census.windows.every((w) => w.path !== '/old'));
        report('before-barrier', { beforeHide, hidden, census });
      }
      await driver.evaluate(() => localStorage.removeItem('legacy-write'));
      switchShell();
      if (rotate) report('worker-rotation', await activate(driver, 'second'));
      else report('worker-repeat-claim', await ask(driver, 'claim'));
      const afterBarrier = await ask(driver, 'census');
      await old.goBack({ waitUntil: 'commit' });
      const after = await doc(old);
      report('after-back', { after, initial, hidden, afterBarrier, misses });
      if (rotate) {
        assert.notEqual(after.id, initial.id);
        assert.deepEqual(after.pageshow, [false]);
        assert.equal(after.shell, 'current');
        assert.equal(after.legacyWrite, null);
      } else {
        assert.equal(after.id, initial.id);
        assert.deepEqual(after.pageshow, [false, true]);
        assert.equal(after.shell, 'legacy');
        assert.deepEqual(after.legacyWrite, { id: initial.id, persisted: true });
      }
    },
  );
}

try {
  report('versions', { chrome: browser.version(), bun: Bun.version });
  await cachedCase(false, false);
  await cachedCase(true, false);
  await cachedCase(true, true);
  await runCase('active-and-non-execution-ready-navigation', async (context, origin, switchShell, held, release) => {
    const driver = await context.newPage();
    await driver.goto(origin + '/driver');
    report('worker-first', await activate(driver, 'first'));
    const active = await context.newPage();
    await active.goto(origin + '/old-active');
    assert.equal((await doc(active)).shell, 'legacy');

    const tab = await context.newPage();
    const unfinished = tab.goto(origin + '/held', { waitUntil: 'load' }).then(
      () => 'loaded',
      (e: unknown) => String(e),
    );
    await held;
    const before = await ask(driver, 'census');
    assert.ok(before.windows.some((w) => w.path === '/old-active'));
    assert.ok(before.windows.every((w) => w.path !== '/held'));
    switchShell();
    report('worker-rotation', await activate(driver, 'second'));
    const after = await ask(driver, 'census');
    assert.ok(after.windows.some((w) => w.path === '/old-active'));
    assert.ok(after.windows.every((w) => w.path !== '/held'));
    await active.waitForFunction(() =>
      navigator.serviceWorker.controller?.scriptURL.endsWith('?rev=second'));
    const activeAfter = await doc(active);
    assert.equal(activeAfter.shell, 'legacy');

    await driver.evaluate(() => localStorage.removeItem('legacy-write'));
    release();
    const completion = await unfinished;
    const late = completion === 'loaded' ? await doc(tab) : null;
    const final = await ask(driver, 'census');
    report('navigation-race', { before, after, activeAfter, completion, late, final });
    assert.equal(completion, 'loaded');
    assert.equal(late?.shell, 'legacy');
    assert.equal(late?.legacyWrite.id, late?.id);
    assert.ok(final.windows.some((w) => w.path === '/held'));
  });
} finally {
  await browser.close();
}
