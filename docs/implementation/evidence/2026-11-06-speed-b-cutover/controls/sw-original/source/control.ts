// Generated from the runner's reviewed process/pipe slices. No DB or App imports.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, lstat, readlink, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from 'playwright-core';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:http';
const exec = promisify(execFile);
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
import { serve } from './node-http.ts';



if (process.versions.bun) throw new Error('Run the Chrome lifecycle with Node: python3 run-node-control.py');
const outDir = process.argv[2];
assert(outDir?.startsWith('/private/tmp/orbis-cutover-sw-admission.'));
await mkdir(outDir + '/profile-parent', { mode: 0o700 });
let profile = await mkdtemp(join(outDir, 'profile-parent/chrome.'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwrightRoot = '/private/tmp/orbis-safari-recheck-build.onROez/candidate/node_modules/playwright-core';
assert.equal(JSON.parse(await readFile(join(playwrightRoot, 'package.json'), 'utf8')).version, '1.63.0');
assert.equal(sha(await readFile(join(playwrightRoot, 'lib/coreBundle.js'))),
  '549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171');
// Public Playwright debug channel copies both successful/failed browser stderr.
process.env.DEBUG = 'pw:browser';
const { chromium } = await import(playwrightRoot + '/index.mjs');
let attempt = 0;
const log = (phase: string, data: object = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), monotonicMs: performance.now(), attempt, phase, ...data }));
const manifestDir = '/private/tmp/orbis-cutover-p-manifests.8koum30b';
const manifests: Record<string, any> = {};
for (const [phase, digest] of [['old', '7b5182a818bceb6839659923e5937af0c085ffcb6aeb93747deae7ae92a003eb'],
  ['current', '2ec1888a7d71ebd2e93bca482da11620a087a6f479403cc86968d4e71b048abe']]) {
  const bytes = await readFile(join(manifestDir, phase + '.json')); assert.equal(sha(bytes), digest);
  const manifest = JSON.parse(bytes.toString()); manifests[phase] = manifest;
  for (const [name, meta] of Object.entries(manifest.assets) as [string, any][]) {
    const value = await readFile(join(manifest.dist, name)); assert.equal(sha(value), meta.sha256, name);
  }
}
// Intentionally replace only HTML, including the SW navigation-fallback index.
// Actual worker/workbox/registration/assets stay byte-identical; App is never loaded.
const probe = `<!doctype html><meta charset="utf-8"><title>SW admission probe</title>
<script>window.__swProbe={loaded:false,events:[]};
function record(kind){const row={kind,time:performance.now(),state:document.readyState,controller:navigator.serviceWorker.controller?.state||null};window.__swProbe.events.push(row);console.log('SW_ADMISSION '+JSON.stringify(row));}
window.addEventListener('load',()=>{window.__swProbe.loaded=true;record('window.load');});
navigator.serviceWorker.addEventListener('controllerchange',()=>record('controllerchange'));</script>
<script src="/registerSW.js"></script><main>Empty probe: no App/Auth/input/challenge responder</main>`;
let phase: 'old' | 'current' = 'current';
const mime = (name: string) => name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css'
  : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.webmanifest') ? 'application/manifest+json'
  : name.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
const proxy = await serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/trpc/') || path.includes('/auth/')) throw new Error('Business route forbidden in SW control');
    const name = path.slice(1);
    const headers = { 'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' };
    if (path === '/' || path === '/index.html' || path === '/probe.html') {
      log('http-probe-html', { phase, path, replacementOfApp: true });
      return new Response(probe, { headers: { ...headers, 'content-type': 'text/html' } });
    }
    const meta = manifests[phase].assets[name];
    if (!meta || name.includes('..')) return new Response(null, { status: 404 });
    const bytes = await readFile(join(manifests[phase].dist, name)); assert.equal(sha(bytes), meta.sha256);
    if (name === 'sw.js' || name === 'registerSW.js' || name === 'orbis-local-data-worker.js')
      log('http-actual-worker-asset', { phase, name, hash: meta.sha256 });
    return new Response(bytes, { headers: { ...headers, 'content-type': mime(name) } });
  } });
const neutral = await serve({ hostname: '127.0.0.1', port: 0,
  fetch: () => new Response('<!doctype html><title>Neutral</title>', { headers: { 'content-type': 'text/html' } }) });
const egress = await serve({ hostname: '127.0.0.1', port: 0,
  fetch: () => new Response(null, { status: 403 }) });

const timeout = 18_000;
async function within<T>(pending: Promise<T>, label: string, ms = timeout): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timeout')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitFor<T>(check: () => Promise<T | false>, label: string, ms = timeout): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value !== false) return value;
    await sleep(100);
  }
  throw new Error(label + ' timeout');
}
type ProcessIdentity = { pid: number; ppid: number; start: string; cmd: string };
async function processes(): Promise<ProcessIdentity[]> {
  const { stdout: output } = await exec('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,command='], { maxBuffer: 4 * 1024 * 1024 });
  return output.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), start: m[3]!, cmd: m[4]! }] : [];
  });
}
const pidKey = (p: ProcessIdentity) => `${p.pid}/${p.start}`;
type Live = { context: BrowserContext; observed: Map<string, ProcessIdentity>;
  root: ProcessIdentity; contextClosed: boolean };
let live: Live | undefined;
function usesProfile(process: ProcessIdentity) {
  return process.cmd.split(/\s+/).includes('--user-data-dir=' + profile);
}
function browserRoots(all: ProcessIdentity[]) {
  return all.filter(p => usesProfile(p) && p.cmd.startsWith(CHROME + ' ') &&
    !p.cmd.split(/\s+/).some(arg => arg.startsWith('--type=')));
}
function recordDescendants(
  all: ProcessIdentity[], root: ProcessIdentity, observed: Map<string, ProcessIdentity>,
) {
  const current = all.find(p => pidKey(p) === pidKey(root));
  const related = new Set(current ? [current.pid] : []);
  let changed: boolean;
  do {
    changed = false;
    for (const p of all) if (!related.has(p.pid) && related.has(p.ppid)) {
      related.add(p.pid);
      changed = true;
    }
  } while (changed);
  for (const p of all) if (related.has(p.pid) || usesProfile(p))
    observed.set(pidKey(p), p);
}
async function censusProcesses(chrome: Live) {
  recordDescendants(await processes(), chrome.root, chrome.observed);
}
async function processesEnded(root: ProcessIdentity, observed: Map<string, ProcessIdentity>) {
  await waitFor(async () => (await processes()).every(p =>
    pidKey(p) !== pidKey(root) && !observed.has(pidKey(p)) && !usesProfile(p)),
  'all disposable Chrome process identities ended');
}
async function cleanupFailedStartup(
  root: ProcessIdentity | undefined, observed: Map<string, ProcessIdentity>,
) {
  const all = await processes();
  const roots = browserRoots(all);
  assert(roots.length <= 1, 'More than one browser process in the disposable profile');
  const owned = root ?? roots[0];
  if (!owned) {
    assert(!all.some(usesProfile), 'Unidentified startup helper in disposable profile');
    return;
  }
  recordDescendants(all, owned, observed);
  const current = all.find(p => pidKey(p) === pidKey(owned));
  if (current) {
    assert(usesProfile(current) && browserRoots([current]).length === 1);
    process.kill(current.pid, 'SIGTERM'); // Only the exact owned profile, on failed startup.
  }
  await processesEnded(owned, observed);
  log('failed-startup-cleanup', { identity: pidKey(owned), descendants: [...observed.keys()] });
}

async function launch(): Promise<Live> {
  let startupRoot: ProcessIdentity | undefined;
  const observed = new Map<string, ProcessIdentity>();
  let monitoring = true;
  let monitorError: unknown;
  const monitor = (async () => {
    try {
      while (monitoring) {
        const all = await processes();
        const roots = browserRoots(all);
        assert(roots.length <= 1, 'More than one browser process in the disposable profile');
        if (roots[0]) {
          if (startupRoot) assert.equal(pidKey(roots[0]), pidKey(startupRoot));
          else startupRoot = roots[0];
        }
        if (startupRoot) recordDescendants(all, startupRoot, observed);
        await sleep(100);
      }
    } catch (error) { monitorError = error; }
  })();
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: CHROME,
      headless: true,
      chromiumSandbox: true,
      viewport: { width: 410, height: 820 },
      timeout,
      // In installed Playwright 1.63.0 this is the sole BFCache-disabling
      // default. Keep all other defaults, including its feature list.
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
      args: [
        '--disable-background-mode', '--window-size=410,820',
        `--proxy-server=${egress.url.origin}`,
        `--proxy-bypass-list=<-loopback>;127.0.0.1:${proxy.port};127.0.0.1:${neutral.port}`,
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      ],
    });
  } catch (error) {
    monitoring = false;
    await monitor;
    await cleanupFailedStartup(startupRoot, observed);
    throw error;
  }
  monitoring = false;
  await monitor;
  try {
    if (monitorError) throw monitorError;
    const roots = browserRoots(await processes());
    assert.equal(roots.length, 1, 'Expected exactly one disposable Chrome browser process');
    const root = roots[0]!;
    if (startupRoot) assert.equal(pidKey(root), pidKey(startupRoot));
    const args = root.cmd.split(/\s+/);
    assert(args.includes('--remote-debugging-pipe'));
    assert(!args.some(arg => arg === '--disable-back-forward-cache' ||
      (arg.startsWith('--disable-features=') && arg.slice('--disable-features='.length)
        .split(',').some(feature => feature.split('<')[0] === 'BackForwardCache'))));
    assert(!args.includes('--no-sandbox'));
    assert(context.pages().every(page => page.url() === 'about:blank'), 'Unexpected restored target');
    const candidate: Live = { context, root, observed, contextClosed: false };
    context.once('close', () => { candidate.contextClosed = true; });
    live = candidate;
    await censusProcesses(candidate);
  } catch (error) {
    await context.close().catch(() => {});
    await cleanupFailedStartup(startupRoot, observed);
    live = undefined;
    throw error;
  }
  const infoPage = context.pages()[0];
  assert(infoPage && live);
  const info = await context.newCDPSession(infoPage);
  const version = await info.send('Browser.getVersion');
  await info.detach();
  log('chrome-launch', { transport: 'pipe', version: version.product, identity: pidKey(live.root),
    descendants: [...live.observed.keys()], arguments: live.root.cmd.split(/\s+/),
    bfCacheDefaultRemoved: '--disable-back-forward-cache' });
  return live;
}
async function closeChrome() {
  const chrome = live;
  if (!chrome) return;
  await censusProcesses(chrome);
  const browser = chrome.context.browser(); assert(browser);
  await within(browser.close(), 'public browser-level close', 8000);
  assert.equal(chrome.contextClosed, true);
  await processesEnded(chrome.root, chrome.observed);
  log('chrome-exit', { identity: pidKey(chrome.root),
    descendants: [...chrome.observed.keys()], contextClosed: true, transport: 'pipe' });
  live = undefined;
}


async function profileProof(label: string) {
  const markers = [];
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const path = join(profile, name);
    try {
      const info = await lstat(path);
      markers.push({ name, type: info.isSymbolicLink() ? 'symlink' : 'file',
        target: info.isSymbolicLink() ? await readlink(path) : null, mtimeMs: info.mtimeMs });
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      markers.push({ name, type: 'absent' });
    }
  }
  const preferences = await readFile(join(profile, 'Default/Preferences'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const exitType = preferences ? JSON.parse(preferences).profile?.exit_type : null;
  const evidence = { label, profile, markers, exitType };
  await writeFile(join(outDir, `${attempt}-${label}.profile.json`), JSON.stringify(evidence, null, 2));
  log('profile-proof', evidence);
  if (label === 'after-all-pid-exit' || (label === 'before-launch' && attempt > 1)) {
    assert.equal(exitType, 'Normal', 'Profile must record a graceful exit');
    assert(markers.every(marker => marker.type === 'absent'), 'Profile singleton markers must be absent');
  }
}
async function censusProof(label: string) {
  if (!live) { log('census-proof', { label, live: false }); return; }
  await within(censusProcesses(live), 'census ' + label);
  const evidence = { label, root: live.root, observed: [...live.observed.values()] };
  await writeFile(join(outDir, `${attempt}-${label}.processes.json`), JSON.stringify(evidence, null, 2));
  log('census-proof', { label, root: pidKey(live.root), observed: [...live.observed.keys()] });
}
let firstFailure: { label: string; message: string; stack?: string } | undefined;
const fatalPageError = Promise.withResolvers<never>();
void fatalPageError.promise.catch(() => {});
async function step<T>(label: string, run: () => Promise<T>, ms = 8000): Promise<T> {
  log('await-before', { label });
  try { const value = await within(Promise.race([run(), fatalPageError.promise]), label, ms); log('await-resolve', { label }); return value; }
  catch (error) {
    const detail = { label, message: String(error), stack: error instanceof Error ? error.stack : undefined };
    firstFailure ??= detail; log('await-reject', detail); throw error;
  }
}
async function open(fresh: boolean) {
  attempt++;
  if (fresh && attempt > 1) profile = await mkdtemp(join(outDir, 'profile-parent/chrome.'));
  await profileProof(fresh ? 'fresh-blank-profile' : 'before-launch');
  const chrome = await step('browser-launch', launch, 18000);
  chrome.context.on('page', page => {
    page.on('console', message => { if (message.text().startsWith('SW_ADMISSION ')) log('page-event', { text: message.text() }); });
    page.on('pageerror', error => {
      firstFailure ??= { label: 'page-error', message: String(error), stack: error.stack };
      log('page-error', firstFailure); fatalPageError.reject(error);
    });
  });
  return chrome;
}
async function closed() {
  await step('browser-close-and-all-pid-exit', closeChrome, 10000);
  await profileProof('after-all-pid-exit');
}
async function readyAndLoad(page: any, label: string) {
  // Start ready before waiting for load, matching the P DOMContentLoaded seam.
  // Actual registerSW.js only registers on the actual window.load event.
  const ready = step(label + ':navigator.ready', () => page.evaluateHandle(async () => {
    console.log('SW_ADMISSION ' + JSON.stringify({ kind: 'ready-before', state: document.readyState,
      loaded: (window as any).__swProbe?.loaded, controller: navigator.serviceWorker.controller?.state ?? null }));
    const reg = await navigator.serviceWorker.ready;
    console.log('SW_ADMISSION ' + JSON.stringify({ kind: 'ready-resolved', scope: reg.scope,
      active: reg.active?.state, waiting: reg.waiting?.state, installing: reg.installing?.state }));
    return reg;
  }));
  const load = step(label + ':window.load', () => page.waitForLoadState('load', { timeout: 8000 }));
  return (await Promise.all([ready, load]))[0];
}
async function state(page: any, reg: any, label: string) {
  const value = await step(label + ':state', () => reg.evaluate((r: ServiceWorkerRegistration) => ({
    documentState: document.readyState, loadSeen: (window as any).__swProbe?.loaded,
    events: (window as any).__swProbe?.events, scope: r.scope,
    active: r.active ? { state: r.active.state, url: r.active.scriptURL } : null,
    waiting: r.waiting?.state ?? null, installing: r.installing?.state ?? null,
    controller: navigator.serviceWorker.controller ? { state: navigator.serviceWorker.controller.state,
      url: navigator.serviceWorker.controller.scriptURL } : null,
  })), 2500);
  log('registration-state', { label, value });
}
async function update(reg: any, label: string) {
  await step(label + ':reg.update', () => reg.evaluate(async (r: ServiceWorkerRegistration) => {
    console.log('SW_ADMISSION ' + JSON.stringify({ kind: 'update-before', active: r.active?.state, waiting: r.waiting?.state, installing: r.installing?.state }));
    try { await r.update(); console.log('SW_ADMISSION ' + JSON.stringify({ kind: 'update-resolved', active: r.active?.state, waiting: r.waiting?.state, installing: r.installing?.state })); }
    catch (error) { console.log('SW_ADMISSION ' + JSON.stringify({ kind: 'update-rejected', message: String(error) })); throw error; }
  }));
}
async function currentCode(page: any, label: string) {
  await step(label + ':controller', () => page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 8000 }));
  const proof = await step(label + ':public-worker-protocol', () => page.evaluate(() => new Promise(resolve => {
    const controller = navigator.serviceWorker.controller!; const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve({ timeout: true }); }, 1700);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data); };
    controller.postMessage({ type: 'orbis-local-data-census' }, [channel.port2]);
  })), 2500);
  log('actual-worker-protocol', { label, proof, businessPageReadyClaimed: false });
  assert.equal((proof as any).protocol, 1, 'Current frozen worker must answer protocol1');
  // Probe deliberately does not fake the app challenge response; ready may be false.
}
try {
  log('control-scope', { htmlReplacement: true, app: false, auth: false, db: false,
    positive: 'current worker/same empty probe without bypass in fresh profile',
    limitation: 'upgrade history differs; no sole-bypass or original-P cause claim' });
  phase = 'current';
  let chrome = await open(true);
  let page = await chrome.context.newPage();
  await step('positive-current:dom', () => page.goto(proxy.url.origin + '/probe.html', { waitUntil: 'domcontentloaded', timeout: 8000 }));
  let reg = await readyAndLoad(page, 'positive-current-no-bypass');
  await state(page, reg, 'positive-current-before-update'); await update(reg, 'positive-current-no-bypass');
  await state(page, reg, 'positive-current-after-update'); await currentCode(page, 'positive-current-no-bypass');
  await closed();
  log('positive-current-no-bypass-complete');

  phase = 'old'; chrome = await open(true); page = await chrome.context.newPage();
  await step('old:dom', () => page.goto(proxy.url.origin + '/probe.html', { waitUntil: 'domcontentloaded', timeout: 8000 }));
  reg = await readyAndLoad(page, 'old');
  await step('old:controller', () => page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 8000 }));
  await state(page, reg, 'old-active-ready'); await closed();

  phase = 'current'; chrome = await open(false); page = await chrome.context.newPage();
  const cdp = await chrome.context.newCDPSession(page);
  await step('current:Network.enable', () => cdp.send('Network.enable'), 5000);
  await step('current:bypass-true', () => cdp.send('Network.setBypassServiceWorker', { bypass: true }), 5000);
  await step('current:cache-disabled-true', () => cdp.send('Network.setCacheDisabled', { cacheDisabled: true }), 5000);
  await step('current:dom', () => page.goto(proxy.url.origin + '/probe.html', { waitUntil: 'domcontentloaded', timeout: 8000 }));
  reg = await readyAndLoad(page, 'current-bypass');
  await state(page, reg, 'current-before-update'); await update(reg, 'current-bypass');
  await state(page, reg, 'current-before-reset');
  await step('current:reset-bypass-false', () => cdp.send('Network.setBypassServiceWorker', { bypass: false }), 6000);
  await state(page, reg, 'current-after-bypass-reset');
  await step('current:reset-cache-disabled-false', () => cdp.send('Network.setCacheDisabled', { cacheDisabled: false }), 6000);
  await state(page, reg, 'current-after-cache-reset'); await currentCode(page, 'current-after-resets');
  await closed();

  chrome = await open(false); page = await chrome.context.newPage();
  const response = await step('ordinary:dom', () => page.goto(proxy.url.origin + '/probe.html', { waitUntil: 'domcontentloaded', timeout: 8000 }));
  reg = await readyAndLoad(page, 'ordinary'); await state(page, reg, 'ordinary'); await currentCode(page, 'ordinary');
  assert(response && (response as any).fromServiceWorker(), 'Ordinary probe response must come from actual SW');
  log('ordinary-current-probe-proof', { fromServiceWorker: true, protocol: 1, actualAppHtmlClaimed: false });
  await closed();
  log('sw-admission-control-result', { status: 'all-control-stages-complete', positiveNoBypass: true,
    originalPOrBusinessPrivacyPass: false });
} catch (error) {
  firstFailure ??= { label: 'control', message: String(error), stack: error instanceof Error ? error.stack : undefined };
  await writeFile(join(outDir, 'first-failure.json'), JSON.stringify(firstFailure, null, 2));
  log('sw-admission-control-result', { status: 'failed-or-uncovered', firstFailure }); process.exitCode = 1;
} finally {
  await closeChrome().catch(error => { log('cleanup-error', { message: String(error) }); process.exitCode = 1; });
  for (const server of [proxy, neutral, egress]) await server.stop(true).catch(error => {
    log('cleanup-error', { message: String(error) }); process.exitCode = 1;
  });
}
