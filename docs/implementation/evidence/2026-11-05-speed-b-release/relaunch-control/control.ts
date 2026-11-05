// Generated from the runner's reviewed process/pipe slices. No DB or App imports.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
const sha = (data: ArrayBuffer) => new Bun.CryptoHasher('sha256').update(data).digest('hex');


const outDir = Bun.argv[2];
assert(outDir?.startsWith('/private/tmp/orbis-cutover-relaunch.'));
await mkdir(outDir + '/profile-parent', { mode: 0o700 });
const profile = await mkdtemp(join(outDir, 'profile-parent/chrome.'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwrightRoot = "/private/tmp/orbis-cutover-current.5ejcvs08" + '/node_modules/playwright-core';
assert.equal((await Bun.file(join(playwrightRoot, 'package.json')).json()).version, '1.63.0');
assert.equal(sha(await Bun.file(join(playwrightRoot, 'lib/coreBundle.js')).arrayBuffer()),
  '549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171');
// Public Playwright debug channel copies both successful/failed browser stderr.
process.env.DEBUG = 'pw:browser';
const { chromium } = await import(playwrightRoot);
let attempt = 0;
const log = (phase: string, data: object = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), monotonicMs: performance.now(), attempt, phase, ...data }));
const proxy = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    assert(path === '/one' || path === '/two' || path === '/favicon.ico');
    return new Response('<!doctype html><title>' + path + '</title><main>' + path + '</main>', {
      headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' },
    });
  },
});
const neutral = Bun.serve({ hostname: '127.0.0.1', port: 0,
  fetch: () => new Response('<!doctype html><title>Benign neutral</title>', { headers: { 'content-type': 'text/html' } }) });
const egress = Bun.serve({ hostname: '127.0.0.1', port: 0,
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
    await Bun.sleep(100);
  }
  throw new Error(label + ' timeout');
}
type ProcessIdentity = { pid: number; ppid: number; start: string; cmd: string };
async function processes(): Promise<ProcessIdentity[]> {
  const child = Bun.spawn(['/bin/ps', '-ww', '-axo', 'pid=,ppid=,lstart=,command='], { stdout: 'pipe' });
  const output = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0);
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
        await Bun.sleep(100);
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
  await within(chrome.context.close(), 'graceful persistent-context close');
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
  const preferences = Bun.file(join(profile, 'Default/Preferences'));
  const exitType = await preferences.exists() ? (await preferences.json()).profile?.exit_type : null;
  const evidence = { label, profile, markers, exitType };
  await Bun.write(join(outDir, `${attempt}-${label}.profile.json`), JSON.stringify(evidence, null, 2));
  log('profile-proof', evidence);
}
async function censusProof(label: string) {
  if (!live) { log('census-proof', { label, live: false }); return; }
  await within(censusProcesses(live), 'census ' + label);
  const evidence = { label, root: live.root, observed: [...live.observed.values()] };
  await Bun.write(join(outDir, `${attempt}-${label}.processes.json`), JSON.stringify(evidence, null, 2));
  log('census-proof', { label, root: pidKey(live.root), observed: [...live.observed.keys()] });
}
try {
  for (attempt = 1; attempt <= 2; attempt++) {
    await profileProof('before-launch');
    log('before-launch', { transport: 'reviewed public persistent pipe', timeoutMs: timeout,
      newProfile: attempt === 1, sameProfileAsFirst: attempt === 2,
      stderrCapture: 'DEBUG=pw:browser; raw stderr.log', navigation: 'about:blank only' });
    await launch();
    log('after-launch');
    await censusProof('after-launch');
    await profileProof('after-launch');
    log('before-context-close');
    await closeChrome();
    log('after-context-close-and-all-recorded-pid-exit');
    await profileProof('after-all-pid-exit');
  }
  log('relaunch-control-result', { status: 'two-sequential-public-pipe-launches-closed',
    profile, app: false, auth: false, database: false });
} catch (error) {
  log('relaunch-control-result', { status: 'failed-or-inconclusive', profile,
    name: error instanceof Error ? error.name : typeof error,
    message: String(error), stack: error instanceof Error ? error.stack : undefined });
  await Bun.write(join(outDir, 'original-failure.json'), JSON.stringify({
    attempt, message: String(error), stack: error instanceof Error ? error.stack : undefined,
  }, null, 2));
  await profileProof('failure').catch(error => log('profile-proof-failed', { message: String(error) }));
  throw error;
} finally {
  await closeChrome().catch(error => log('owned-cleanup-incomplete', { message: String(error) }));
  await proxy.stop(true);
  await neutral.stop(true);
  await egress.stop(true);
}
