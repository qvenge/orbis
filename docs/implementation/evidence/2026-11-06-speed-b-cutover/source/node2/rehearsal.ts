import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page, Response as PageResponse } from 'playwright-core';
import { LifecycleObserver } from './lifecycle-observer.ts';
import { checkActualDb, checkContainer, checkDsn, loadHandoff, sha } from './identity.ts';

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { serve } from './node-http.ts';
import { readFile, writeFile, readJson, exists, inventory, sleep, spawnOwned, processRows, recordChildrenAt } from './node-platform.ts';
import type { OwnedChild } from './node-platform.ts';
assert(!process.versions.bun && process.versions.node === '23.11.0', 'Real pinned Node23.11 must own Playwright');
const BUN_EXECUTABLE = process.env.ORBIS_CUTOVER_BUN_PATH;
assert(BUN_EXECUTABLE?.startsWith('/'), 'Explicit pinned Bun executable is required for app/migrator/validators');
const NEW_HANDOFF_SHA = '0cfd6acf2b25e41f1d7ac599d1cd45f616b78a8ca11692f4f96ab01f45cddb7b';
assert(/^[a-f0-9]{64}$/.test(NEW_HANDOFF_SHA), 'New allocation is not issued; never resume old P0027');

const OLD = 'b5abb7fe70068c06b7075ed54a2a0f3c3d729d7b';
const CURRENT = 'c7ccb9dd1f4cc1f68d43255ecf313768ebc2b315';
const CURRENT_TRACKED = 2132;
const CURRENT_MANIFEST_SHA = '2ec1888a7d71ebd2e93bca482da11620a087a6f479403cc86968d4e71b048abe';
const AUTH = 'http://localhost:54321';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sourceDir = dirname(fileURLToPath(import.meta.url));
const [scenario, manifests, outDir, handoffPath, handoffSha] = process.argv.slice(2);
assert(scenario === 'N' || scenario === 'P');
assert(['P'].includes(scenario), 'This source proposal is P-only; N must not be repeated');
assert(/^[a-f0-9]{40}$/.test(CURRENT), 'Reviewed current commit pin');
assert(Number.isSafeInteger(CURRENT_TRACKED) && CURRENT_TRACKED > 0, 'Exact reviewed current source inventory count');
assert(/^[a-f0-9]{64}$/.test(CURRENT_MANIFEST_SHA), 'Root-issued current artifact manifest');
assert(manifests?.startsWith('/private/tmp/orbis-cutover-'));
assert(outDir?.startsWith('/private/tmp/orbis-cutover-'));
assert.equal(process.env.ORBIS_CUTOVER_DISPOSABLE, '1');
const adminDsn = process.env.DATABASE_URL_ADMIN ?? '';
const runtimeDsn = process.env.DATABASE_URL ?? '';
function redact(message: string): string {
  for (const dsn of [adminDsn, runtimeDsn]) {
    if (!dsn) continue;
    message = message.replaceAll(dsn, '[cutover DSN omitted]');
  }
  return message;
}
assert(handoffPath && handoffSha);
assert.equal(handoffSha, NEW_HANDOFF_SHA);
const handoff = await loadHandoff(handoffPath, handoffSha, scenario);
assert.equal(handoff.manifests.current, CURRENT_MANIFEST_SHA, 'Reviewed current manifest pin');
checkDsn(adminDsn, handoff, 'admin');
checkDsn(runtimeDsn, handoff, 'runtime');
await checkContainer(handoff);
await mkdir(outDir, { mode: 0o700 });
recordChildrenAt(outDir);
const profile = await mkdtemp(join(outDir, 'chrome.'));
const log = (phase: string, data: object = {}) => console.log(JSON.stringify({ phase, ...data }));

const fileDigest = (bytes: Uint8Array) => sha(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
function fileAt(root: string, name: string) {
  const file = resolve(root, name);
  assert(file.startsWith(root + sep), name);
  return file;
}
type Artifact = {
  commit: string;
  tree: string;
  dist: string;
  entry: string;
  source: Record<string, string>;
  assets: Record<string, { bytes: number; sha256: string }>;
};
async function verify(name: 'old' | 'current', commit: string, tracked: number): Promise<Artifact> {
  const bytes = await readFile(join(manifests, name + '.json'));
  assert.equal(sha(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), handoff.manifests[name], 'Root-pinned manifest mismatch: ' + name);
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Artifact;
  assert.equal(manifest.commit, commit);
  assert(manifest.tree.startsWith('/private/tmp/orbis-'));
  assert.equal(manifest.dist, join(manifest.tree, 'apps/web/dist'));
  for (const part of ['', 'apps/web', 'apps/server']) {
    const names = await readdir(join(manifest.tree, part));
    assert(!names.some(name => /^\.env(?:$|\.)/.test(name) && name !== '.env.example'),
      'Unexpected environment file in artifact tree');
  }
  assert.equal(Object.keys(manifest.source).length, tracked);
  for (const [path, digest] of Object.entries(manifest.source))
    assert.equal(fileDigest(await readFile(fileAt(manifest.tree, path))), digest, path);
  const distInventory = await inventory(manifest.dist);
  assert.deepEqual(distInventory, Object.keys(manifest.assets).sort(), 'Unexpected dist inventory');
  for (const [path, metadata] of Object.entries(manifest.assets)) {
    const data = await readFile(fileAt(manifest.dist, path));
    assert.equal(data.byteLength, metadata.bytes, path);
    assert.equal(fileDigest(data), metadata.sha256, path);
  }
  for (const name of ['index.html', 'sw.js', manifest.entry]) assert(manifest.assets[name], name);
  assert((await readFile(fileAt(manifest.dist, manifest.entry), 'utf8')).includes(AUTH));
  log('artifact', { name, commit, entry: manifest.entry, html: manifest.assets['index.html'].sha256,
    sw: manifest.assets['sw.js'].sha256, files: Object.keys(manifest.assets).length });
  return manifest;
}
const old = await verify('old', OLD, 1425);
const current = await verify('current', CURRENT, CURRENT_TRACKED);
const fromCurrent = createRequire(join(current.tree, 'package.json'));
const playwrightRoot = dirname(fromCurrent.resolve('playwright-core/package.json'));
assert.equal((await readJson(join(playwrightRoot, 'package.json'))).version, '1.63.0');
assert.equal(fileDigest(await readFile(join(playwrightRoot, 'lib/coreBundle.js'))),
  '549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171',
  'Playwright default-argument source changed');
process.env.DEBUG = 'pw:browser';
const { chromium } = await import(pathToFileURL(join(playwrightRoot, 'index.mjs')).href);
const { SignJWT } = await import(pathToFileURL(fromCurrent.resolve('jose')).href);
const { default: postgres } = await import(pathToFileURL(fromCurrent.resolve('postgres')).href);
const sql = postgres(adminDsn, { max: 1 });
const owner = crypto.randomUUID();
const email = 'cutover-' + owner + '@example.invalid';
const pass = 'synthetic-local-password';
const secret = crypto.randomUUID() + crypto.randomUUID();
const expiresAt = Math.floor(Date.now() / 1000) + 3600;
const token = await new SignJWT({ role: 'authenticated', email })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(owner).setAudience('authenticated')
  .setIssuer(AUTH + '/auth/v1').setIssuedAt().setExpirationTime(expiresAt)
  .sign(new TextEncoder().encode(secret));

const serverEnv: Record<string, string> = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  ORBIS_CUTOVER_DISPOSABLE: '1', DATABASE_URL: runtimeDsn,
  SUPABASE_JWT_SECRET: secret,
  ORBIS_ROUTINE_SCHEDULER: '0', ORBIS_CHANGE_STREAM: '0',
};
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
const children = new Set<OwnedChild>();
async function upstream(artifact: Artifact) {
  const ready = join(outDir, artifact.commit.slice(0, 8) + '.ready.json');
  const output = join(outDir, artifact.commit.slice(0, 8) + '-server.log');
  await checkContainer(handoff);
  await checkActualDb(sql, handoff, 'admin');
  const child = await spawnOwned([BUN_EXECUTABLE!, join(sourceDir, 'bun/launcher.ts'), artifact.tree, artifact.dist, ready,
    handoffPath, handoffSha, scenario], { cwd: artifact.tree, env: serverEnv, stdout: output });
  children.add(child);
  const address = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error('Actual server launcher exited');
    if (!(await exists(ready))) return false;
    try { return (await readJson(ready)).upstream as string; } catch { return false; }
  }, 'real upstream ready');
  assert.equal(new URL(address).hostname, '127.0.0.1');
  log('upstream-ready', { commit: artifact.commit, address, pid: child.pid });
  return { child, address };
}
async function stop(child: OwnedChild) {
  if (child.exitCode === null) child.kill('SIGTERM');
  assert.equal(await within(child.exited, 'real upstream exit'), 0);
  children.delete(child);
}

type Op = { name: string; input: Record<string, any> };
type Journal = {
  sequence: number; phase: 'old' | 'current'; actor: 'browser' | 'driver'; version: string | null;
  names: string[]; bodies: string[]; creates: string[];
  createPayloads: { id: string; digest: string }[];
  outcomes?: { name: string; ok: boolean; errorCode?: string; id?: string }[];
  forwarded: boolean; status?: number;
};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const fields = Object.entries(value).filter(([, item]) => item !== undefined);
  return Object.fromEntries(fields.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
}
const canonicalSha = (value: unknown) => sha(JSON.stringify(canonical(value)));
const journal: Journal[] = [];
let phase: 'old' | 'current' = 'old';
let address = '';
let blockOldInputs = false;
let blockReplay = false;
let legacyAssets = false;
let upstreamActive = 0;
const ids = { a: crypto.randomUUID(), b: crypto.randomUUID(), held: crypto.randomUUID() };
const heldPath = '/r/' + ids.held;
const arrived = Promise.withResolvers<void>();
const release = Promise.withResolvers<boolean>();
let holdEnabled = false;
let heldUsed = false;
function ops(path: string, body: any, batched: boolean): Op[] {
  if (!path.startsWith('/trpc/')) return [];
  return decodeURIComponent(path.slice(6)).split(',').map((name, i) => ({
    name, input: (batched ? body?.[String(i)] : body) ?? {},
  }));
}
const proxy = await serve({
  hostname: '127.0.0.1', port: 0, idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (legacyAssets && phase === 'current' && scenario === 'N' && url.pathname.startsWith('/assets/')) {
      const name = url.pathname.slice(1);
      if (old.assets[name] && !current.assets[name]) {
        log('negative-old-hashed-asset', { name });
        const file = await readFile(fileAt(old.dist, name));
        return new Response(file, { headers: { 'content-type': name.endsWith('.css') ? 'text/css' : 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' } });
      }
    }
    const bytes = req.method === 'POST' ? await req.arrayBuffer() : undefined;
    let body;
    try { body = bytes?.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : JSON.parse(url.searchParams.get('input') ?? 'null'); }
    catch { return new Response('Unexpected fixture request', { status: 400 }); }
    const requests = ops(url.pathname, body, url.searchParams.has('batch'));
    const actor = req.headers.get('x-cutover-driver') === '1' ? 'driver' : 'browser';
    const version = req.headers.get('x-orbis-client-version');
    const bodies = requests.filter(({ name, input }) => name === 'entity.update' &&
      (Object.hasOwn(input, 'body') || Object.hasOwn(input, 'bodyDoc'))).map(({ input }) => String(input.id));
    const createRequests = requests.filter(({ name, input }) =>
      name === 'entity.create' && input.source === 'fast_path');
    const createPayloads = createRequests.map(({ input }) => ({
      id: String(input.input?.id), digest: canonicalSha(input),
    }));
    const creates = createPayloads.map(({ id }) => id);
    const gated = actor === 'browser' && (
      (phase === 'old' && blockOldInputs && (bodies.some(id => id === ids.a || id === ids.b) || creates.length > 0)) ||
      (phase === 'current' && blockReplay && creates.length > 0));
    const row: Journal = { sequence: journal.length + 1, phase, actor, version,
      names: requests.map(r => r.name), bodies, creates, createPayloads, forwarded: !gated };
    if (requests.length) journal.push(row);
    if (gated) {
      log('before-upstream-transport-fault', row);
      return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    if (!address) return new Response(null, { status: 503 });
    const capture = holdEnabled && !heldUsed && phase === 'old' && url.pathname === heldPath;
    if (capture) heldUsed = true;
    const headers = new Headers(req.headers);
    headers.delete('x-cutover-driver');
    headers.delete('host');
    headers.delete('connection');
    let response: Response;
    upstreamActive++;
    try {
      const raw = await fetch(address + url.pathname + url.search, { method: req.method, headers, body: bytes, redirect: 'manual' });
      row.status = raw.status;
      const out = await raw.arrayBuffer();
      if (requests.length) {
        try {
          const result = JSON.parse(new TextDecoder().decode(out));
          const items = url.searchParams.has('batch') ? result : [result];
          if (Array.isArray(items)) row.outcomes = requests.map(({ name }, i) => {
            const item = items[i];
            return { name, ok: item?.result !== undefined, errorCode: item?.error?.data?.code,
              id: item?.result?.data?.id };
          });
        } catch {
          // HTTP and transport failures need not carry a tRPC envelope.
        }
      }
      const h = new Headers(raw.headers);
      if (requests.length) h.set('x-cutover-sequence', String(row.sequence));
      h.delete('content-encoding');
      h.delete('content-length');
      response = new Response([204, 205, 304].includes(raw.status) ? null : out,
        { status: raw.status, headers: h });
      if (capture) {
        assert.equal(raw.status, 200);
        assert.equal(sha(out), old.assets['index.html'].sha256);
        log('old-html-latched', { path: heldPath, hash: sha(out) });
      }
    } finally { upstreamActive--; }
    if (capture) {
      arrived.resolve();
      if (!(await release.promise)) {
        log('old-html-discarded-before-delivery', { path: heldPath });
        return new Response(null, { status: 410 });
      }
      log('old-html-released', { path: heldPath });
    }
    return response;
  },
});
const origin = proxy.url.origin;
// Browser network may reach only the two explicit fixture origins. Auth is
// fulfilled by CDP before networking, and all other URLs use this deny proxy.
const egress = await serve({ hostname: '127.0.0.1', port: 0,
  fetch: () => new Response(null, { status: 403 }) });
const neutral = await serve({ hostname: '127.0.0.1', port: 0,
  fetch: () => new Response('<!doctype html><title>Cutover neutral</title>', { headers: { 'content-type': 'text/html' } }) });

type ProcessIdentity = { pid: number; ppid: number; start: string; cmd: string };
async function processes(): Promise<ProcessIdentity[]> {
  return processRows();
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
const lifecycle = new LifecycleObserver(log);
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
  await lifecycle.install(context);
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
async function newPage(chrome: Live): Promise<Page> {
  const page = await chrome.context.newPage();
  const cdp = await chrome.context.newCDPSession(page);
  // Use a narrow CDP pattern rather than Playwright route(), which disables
  // HTTP cache globally and would make the ordinary restart control artificial.
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: AUTH + '/auth/v1/*' }] });
  cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const u = new URL(request.url);
    const headers = [
      { name: 'access-control-allow-origin', value: origin },
      { name: 'access-control-allow-methods', value: 'GET,POST,OPTIONS' },
      { name: 'access-control-allow-headers', value: request.headers['Access-Control-Request-Headers']
          ?? request.headers['access-control-request-headers'] ?? '*' },
      { name: 'content-type', value: 'application/json' },
    ];
    const send = (responseCode: number, value?: object) => cdp.send('Fetch.fulfillRequest', {
      requestId, responseCode, responseHeaders: headers,
      ...(value ? { body: Buffer.from(JSON.stringify(value)).toString('base64') } : {}),
    });
    try {
      assert.equal(u.origin, AUTH);
      assert(u.pathname.startsWith('/auth/v1/'));
      if (request.method === 'OPTIONS' || u.pathname.endsWith('/logout')) return void await send(204);
      const user = { id: owner, email, aud: 'authenticated', role: 'authenticated' };
      if (u.pathname.endsWith('/user')) return void await send(200, user);
      assert(u.pathname.endsWith('/token'));
      if (u.searchParams.get('grant_type') === 'password') {
        const auth = JSON.parse(request.postData ?? '{}');
        assert.equal(auth.email, email);
        assert.equal(auth.password, pass);
      } else assert.equal(u.searchParams.get('grant_type'), 'refresh_token');
      await send(200, { access_token: token, refresh_token: 'synthetic-cutover-refresh',
        token_type: 'bearer', expires_in: 3600, expires_at: expiresAt, user });
    } catch {
      log('unexpected-auth-fixture-request', { path: u.pathname, method: request.method });
      await send(403).catch(() => {});
    }
  });
  return page;
}
async function assertClosedProfile() {
  const preferences = await readJson(join(profile, 'Default/Preferences'));
  assert.equal(preferences.profile?.exit_type, 'Normal', 'Profile must record a graceful exit');
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    let present = true;
    try { await lstat(join(profile, name)); } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      present = false;
    }
    assert(!present, 'Profile singleton markers must be absent');
  }
}
async function closeChrome() {
  const chrome = live;
  if (!chrome) return;
  await censusProcesses(chrome);
  await within(chrome.context.close(), 'graceful persistent-context close');
  assert.equal(chrome.contextClosed, true);
  await processesEnded(chrome.root, chrome.observed);
  await assertClosedProfile();
  log('chrome-exit', { identity: pidKey(chrome.root),
    descendants: [...chrome.observed.keys()], contextClosed: true, transport: 'pipe' });
  live = undefined;
}

async function rpc<T = any>(name: string, input?: unknown, version = phase === 'old' ? '0.6.0' : '0.7.0', read = false) {
  const url = new URL(origin + '/trpc/' + name);
  if (read && input !== undefined) url.searchParams.set('input', JSON.stringify(input));
  const res = await fetch(url, {
    method: read ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token,
      'x-cutover-driver': '1', 'x-orbis-client-version': version },
    body: !read && input !== undefined ? JSON.stringify(input) : undefined,
  });
  const json = await res.json() as { result?: { data: T }; error?: { data?: { code?: string } } };
  return { status: res.status, data: json.result?.data, code: json.error?.data?.code };
}
async function ok<T = any>(name: string, input?: unknown, read = false): Promise<T> {
  const response = await rpc<T>(name, input, undefined, read);
  assert.equal(response.status, 200, name);
  assert.notEqual(response.data, undefined, name);
  return response.data as T;
}
async function revision(id: string) {
  const data = await ok('entity.get', { id, include: ['body', 'bodyDoc'] }, true);
  return { body: data.entity.body as string, rev: data.entity.bodyRevision as number };
}
async function seed() {
  await checkContainer(handoff);
  await checkActualDb(sql, handoff, 'admin');
  await sql`insert into auth.users (id,aud,role,email,created_at,updated_at)
      values (${owner},'authenticated','authenticated',${email},now(),now())`;
  await ok('user.seedOnboarding');
  for (const [key, id] of Object.entries(ids)) {
    await ok('entity.create', { source: 'ui', input: {
      id, title: 'Cutover ' + key, body: 'Original ' + key, tags: [], aspects: ['orbis/note'],
    } });
  }
}
const login = (page: Page) => page.getByTestId('login-screen');
async function signIn(page: Page, expectReady = true) {
  await login(page).waitFor({ timeout });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(pass);
  await page.getByRole('button', { name: 'Войти' }).click();
  if (expectReady) await login(page).waitFor({ state: 'hidden', timeout });
}
async function entry(page: Page) {
  return page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')));
}
async function requireEntry(page: Page, artifact: Artifact) {
  assert((await entry(page)).includes('/' + artifact.entry), 'Unexpected browser entry');
}
async function worker(page: Page) {
  return page.evaluate(() => new Promise<{ url: string | null; ready: boolean; protocol?: number }>(resolve => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) return resolve({ url: null, ready: false });
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve({ url: controller.scriptURL, ready: false }); }, 1700);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve({ url: controller.scriptURL, ready: data?.ready === true, protocol: data?.protocol });
    };
    controller.postMessage({ type: 'orbis-local-data-census' }, [channel.port2]);
  }));
}
async function currentWorker(page: Page, ready: boolean) {
  const report = await waitFor(async () => {
    const answer = await worker(page);
    return answer.protocol === 1 && answer.ready === ready ? answer : false;
  }, 'current worker census ' + ready);
  const served = await fetch(origin + '/sw.js', { cache: 'no-cache' });
  assert.equal(sha(await served.arrayBuffer()), current.assets['sw.js'].sha256);
  return report;
}
const toggle = (page: Page) => page.getByRole('checkbox', { name: 'Это общий компьютер — не хранить данные на устройстве' });
const key = (id: string) => 'orbis:body-draft:' + owner + ':' + id;
const queue = 'orbis:retry-buffer:v1:' + owner;
async function store(page: Page) {
  return page.evaluate(async ({ a, b, queue }) => ({
    drafts: [localStorage.getItem(a), localStorage.getItem(b)], queue: localStorage.getItem(queue),
    keys: Object.keys(localStorage).sort(), session: Object.keys(sessionStorage).sort(),
    mode: JSON.parse(localStorage.getItem('orbis:local-data:device:v1') ?? '{"mode":"normal"}'),
    databases: (await indexedDB.databases()).map(row => row.name ?? '').sort(),
  }), { a: key(ids.a), b: key(ids.b), queue });
}
function assertWiped(data: Awaited<ReturnType<typeof store>>) {
  assert.equal(data.mode.mode, 'shared');
  assert.equal(data.mode.pending ?? null, null);
  assert(!data.keys.some(k => /^(sb-.*auth-token|orbis:(body-draft|retry-buffer|nav))/.test(k)));
  assert(!data.databases.some(k => /^orbis-(input|cache):/.test(k)));
}
async function opaque(page: Page) {
  const snapshot = await page.evaluate(() => ({ url: location.pathname + location.search, state: history.state }));
  assert.equal(snapshot.url, '/');
  assert.equal(snapshot.state?.orbisNav, 3);
  assert(!Object.values(ids).some(id => JSON.stringify(snapshot.state).includes(id)));
}
async function switchUpstream(oldServer: Awaited<ReturnType<typeof upstream>>) {
  await waitFor(async () => upstreamActive === 0, 'drained old upstream');
  await stop(oldServer.child);
  address = '';
  await checkContainer(handoff);
  await checkActualDb(sql, handoff, 'admin');
  const migrationEnv = { PATH: serverEnv.PATH!, DATABASE_URL_ADMIN: adminDsn };
  const build = await spawnOwned([BUN_EXECUTABLE!, 'run', '--cwd', join(current.tree, 'apps/server'), 'db:migrate'],
    { cwd: current.tree, env: migrationEnv, stdout: 'pipe', stderr: 'pipe' });
  children.add(build);
  const [migrationStatus, stdout, stderr] = await within(Promise.all([
    build.exited, new Response(build.stdout).text(), new Response(build.stderr).text(),
  ]), '0027 migration', 45_000).catch(async error => {
    if (build.exitCode === null) {
      build.kill('SIGTERM');
      await within(build.exited, 'owned migrator cleanup');
    }
    throw error;
  });
  if (build.exitCode !== null) children.delete(build);
  await writeFile(join(outDir, 'migrate.log'), redact(stdout));
  await writeFile(join(outDir, 'migrate.stderr.log'), redact(stderr));
  assert.equal(migrationStatus, 0);
  const [head] = await sql`select max(created_at)::text as n from drizzle.__drizzle_migrations`;
  assert.equal(head?.n, '1793710145542');
  phase = 'current';
  address = (await upstream(current)).address;
  assert.equal((await fetch(origin + '/health')).status, 200);
  const stale = await rpc('user.getSettings', undefined, '0.6.0', true);
  assert.equal(stale.status, 412);
  assert.equal(stale.code, 'PRECONDITION_FAILED');
  log('driver-412', { status: stale.status, code: stale.code });
}

async function heldNavigation(chrome: Live) {
  const page = await newPage(chrome);
  assert(chrome.context.pages().every(target => target.url() === 'about:blank'));
  log('held-first-navigation-before-any-origin-document');
  holdEnabled = true;
  const result = page.goto(origin + heldPath, { waitUntil: 'load', timeout: 0 }).then(
    () => 'loaded' as const,
    () => 'cancelled' as const,
  );
  await within(arrived.promise, 'b5 held HTML latch');
  await within(censusProcesses(chrome), 'held process census');
  log('held-natural-network-first-navigation');
  return { page, result };
}

async function bfcache(chrome: Live, candidate: 'held' | 'b' = 'held') {
  const page = await newPage(chrome);
  const cdp = await chrome.context.newCDPSession(page);
  await cdp.send('Page.enable');
  cdp.on('Page.backForwardCacheNotUsed', ({ notRestoredExplanations }) =>
    log('bfcache-not-used', { reasons: notRestoredExplanations.map(value => value.reason) }));
  await page.goto(origin + '/r/' + ids[candidate]);
  await requireEntry(page, old);
  await page.getByRole('heading', { name: 'Cutover ' + candidate, exact: true }).waitFor({ timeout });
  return lifecycle.roundTrip(page, neutral.url.origin, timeout);
}

async function edit(page: Page, id: string, marker: string) {
  await page.goto(origin + '/r/' + id);
  await requireEntry(page, old);
  const body = page.getByTestId('body-editor').locator('[contenteditable="true"]').first();
  await body.click({ timeout });
  await page.keyboard.press('End');
  await page.keyboard.insertText(' ' + marker);
  await page.waitForFunction(({ key, marker }) => localStorage.getItem(key)?.includes(marker), {
    key: key(id), marker,
  }, { timeout });
}

async function proveOldWorker(page: Page) {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout });
  const response = await fetch(origin + '/sw.js', { cache: 'no-cache' });
  assert.equal(sha(await response.arrayBuffer()), old.assets['sw.js'].sha256);
  await requireEntry(page, old);
  if (live) await censusProcesses(live);
  await waitFor(async () => journal.some(row =>
    row.phase === 'old' && row.actor === 'browser' && row.version === '0.6.0' && row.status === 200),
  'real browser 0.6 header');
  log('old-controller-and-entry', { entry: old.entry, controller: await page.evaluate(() =>
    navigator.serviceWorker.controller?.scriptURL ?? null) });
}

// Admission prepares a worker only. Qualified readiness belongs to the next
// ordinary document after the entire assisted browser has exited.
async function admissionStep<T>(label: string, action: () => Promise<T>, ms = 8_000): Promise<T> {
  log('admission-step-start', { label });
  try {
    const value = await within(action(), label, ms);
    log('admission-step-complete', { label });
    return value;
  } catch (error) {
    log('admission-step-failed', { label, message: redact(String(error)) });
    throw error;
  }
}
async function freshNetworkPage(chrome: Live, path: string) {
  const page = await admissionStep('new-page', () => newPage(chrome));
  const cdp = await admissionStep('new-cdp-session', () => chrome.context.newCDPSession(page));
  await admissionStep('network-enable', () => cdp.send('Network.enable'));
  await admissionStep('bypass-true', () => cdp.send('Network.setBypassServiceWorker', { bypass: true }));
  await admissionStep('cache-disabled-true', () => cdp.send('Network.setCacheDisabled', { cacheDisabled: true }));
  const response = await admissionStep('current-document', () =>
    page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 8_000 }));
  assert(response && !response.fromServiceWorker());
  assert.equal(sha(await admissionStep('current-html-bytes', () => response.body())), current.assets['index.html'].sha256);
  await admissionStep('current-entry', () => requireEntry(page, current));
  log('fresh-network-admission', { scenario, entry: current.entry, html: current.assets['index.html'].sha256 });
  await admissionStep('window.load', () => page.waitForLoadState('load', { timeout: 8_000 }));
  const reg = await admissionStep('getRegistration-exact-scope', () => page.evaluateHandle(async (scope: string) => {
    const found = await navigator.serviceWorker.getRegistration(scope);
    if (!found || found.scope !== scope) throw new Error('Existing exact-scope registration unavailable');
    return found;
  }, origin + '/'));
  await admissionStep('registration.update', () => reg.evaluate(async r => { await r.update(); }));
  const proof = await admissionStep('registration.active-protocol1', () => waitFor(async () => {
    const observed = await reg.evaluate(r => new Promise<{ active: string | null; url?: string; protocol?: number; ready?: boolean }>(resolve => {
      const active = r.active;
      if (!active) return resolve({ active: null });
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); resolve({ active: active.state, url: active.scriptURL }); }, 1700);
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(timer); channel.port1.close();
        resolve({ active: active.state, url: active.scriptURL, protocol: data?.protocol, ready: data?.ready });
      };
      active.postMessage({ type: 'orbis-local-data-census' }, [channel.port2]);
    }));
    log('registration-active-protocol-observation', { observed, businessPageReadyClaimed: false });
    return observed.protocol === 1 && observed.url === origin + '/sw.js' ? observed : false;
  }, 'actual active current worker', 8_000));
  log('assisted-worker-prepared', { proof, businessPageReadyClaimed: false,
    targetResetCommandsIssued: false, nextProof: 'whole browser exit then new ordinary document' });
  // No finally reset: target-scoped overrides die with the whole browser.
  // A failing step escapes directly to the original-failure recorder/cleanup.
  return page;
}

async function negative(oldServer: Awaited<ReturnType<typeof upstream>>) {
  const chrome = await launch();
  const held = await heldNavigation(chrome);
  const visible = await newPage(chrome);
  await visible.goto(origin + '/r/' + ids.a);
  await signIn(visible);
  await proveOldWorker(visible);
  blockOldInputs = true;
  await edit(visible, ids.a, 'R5-negative-retained-body');
  const bfcacheCovered = await bfcache(chrome, 'b');
  const before = await store(visible);
  assert(before.drafts[0]);
  assert(before.keys.includes('orbis:nav:v2'));
  await switchUpstream(oldServer);

  const initiator = await freshNetworkPage(chrome, '/settings');
  await currentWorker(initiator, false);
  const confirms: string[] = [];
  initiator.on('dialog', dialog => {
    confirms.push(dialog.message());
    void dialog.accept();
  });
  await toggle(initiator).click({ timeout });
  await initiator.getByText('Очистка ещё не завершена.', { exact: false }).waitFor({ timeout });
  const blocked = await store(initiator);
  assert.equal(blocked.mode.mode, 'normal');
  assert.equal(blocked.mode.pending?.reason, 'shared-on');
  assert(blocked.drafts[0] && before.drafts[0]);
  const saved = JSON.parse(before.drafts[0]);
  const retained = JSON.parse(blocked.drafts[0]);
  assert.deepEqual({ doc: retained.doc, baseRevision: retained.baseRevision },
    { doc: saved.doc, baseRevision: saved.baseRevision });
  log('visible-legacy-blocked-wipe', { mode: blocked.mode.mode, confirmations: confirms });

  await visible.close();
  await currentWorker(initiator, true);
  await initiator.getByRole('button', { name: 'Повторить' }).click();
  await login(initiator).waitFor({ timeout });
  assertWiped(await store(initiator));
  legacyAssets = true;
  release.resolve(true);
  assert.equal(await within(held.result, 'late old document'), 'loaded');
  await requireEntry(held.page, old);
  await login(held.page).waitFor({ timeout });
  const lateWorker = await worker(held.page);
  log('late-held-old-code', { entry: old.entry, controller: lateWorker,
    classification: lateWorker.protocol === 1 ? 'old-code-under-current-worker' : 'same-origin-held-old-code' });

  const observation = observePageVersion(held.page, '0.6.0');
  let lateBrowser412 = false;
  try {
    await signIn(held.page, false);
    await held.page.waitForFunction(() => !!localStorage.getItem('sb-localhost-auth-token'), undefined, { timeout });
    const late = await store(held.page);
    assert(late.keys.includes('sb-localhost-auth-token'));
    log('legacy-writer-after-purge', {
      authKeyPresent: true, navKeyPresent: late.keys.includes('orbis:nav:v2'), bfcacheCovered,
    });
    const late412 = await waitFor(async () => observation.matched.find(row =>
      row.outcomes?.some(result => result.errorCode === 'PRECONDITION_FAILED')) ?? false,
    'late-browser tRPC 412', 5_000).catch(() => undefined);
    lateBrowser412 = late412 !== undefined;
    log('late-browser-412', { observed: lateBrowser412, requestSequence: late412?.sequence, httpStatus: late412?.status });
  } finally { observation.stop(); }
  await closeChrome();
  log('scenario-result', { scenario: 'N', status: 'expected-unsafe-reproduced', bfcacheCovered, lateBrowser412 });
}

function observePageVersion(page: Page, version: string) {
  const from = journal.length;
  const matched: Journal[] = [];
  const listener = async (response: PageResponse) => {
    if (!response.url().startsWith(origin + '/trpc/')) return;
    try {
      if (response.request().frame() !== page.mainFrame()) return;
      const seq = Number(await response.headerValue('x-cutover-sequence'));
      const row = journal[seq - 1];
      if (seq > from && row?.phase === 'current' && row.actor === 'browser' && row.version === version)
        matched.push(row);
    } catch {
      // A worker-only request cannot stand in for this page's evidence.
    }
  };
  page.on('response', listener);
  return { matched, stop: () => page.off('response', listener) };
}

async function entryEvidence(page: Page, assisted: boolean) {
  const observed = observePageVersion(page, '0.7.0');
  try {
    const response = await page.goto(origin + '/settings', { waitUntil: 'domcontentloaded' });
    const files = await entry(page);
    log('startup-entry', { assisted, fromServiceWorker: response?.fromServiceWorker(), files });
    if (!files.includes('/' + current.entry)) return null;
    assert(response);
    assert.equal(sha(await response.body()), current.assets['index.html'].sha256);
    await currentWorker(page, true);
    const matched = await page.evaluate(async () => {
      const response = await caches.match('/index.html', { ignoreSearch: true });
      if (!response) return null;
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()));
      return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
    });
    assert.equal(matched, current.assets['index.html'].sha256, 'current precache index bytes');
    const versionSeen = await waitFor(async () =>
      observed.matched.find(row => row.outcomes?.some(result => result.ok)) ?? false,
      'real 0.7 response for the new main frame');
    const startup = response.fromServiceWorker() ? 'ordinary-worker-controlled' : 'fresh-http-later-controller';
    log('startup-qualified', { startup, assisted, requestSequence: versionSeen.sequence });
    return startup;
  } finally {
    observed.stop();
  }
}
async function restartOrdinary() {
  const first = await launch();
  const page = await newPage(first);
  const firstStartup = await entryEvidence(page, false);
  if (firstStartup) return { page, assisted: false, startup: firstStartup };
  log('restart-only-insufficient', { observedEntry: await entry(page) });
  await closeChrome();
  const aid = await launch();
  await freshNetworkPage(aid, '/settings');
  await admissionStep('whole-browser-close-and-pid-exit', closeChrome, 18_000);
  const next = await launch();
  const ordinary = await newPage(next);
  const startup = await entryEvidence(ordinary, true);
  assert(startup, 'Assisted recovery did not produce a fresh startup');
  return { page: ordinary, assisted: true, startup };
}
type DraftExpectation = { doc: unknown; baseRevision: number };
let checkpointSequence = 0;
const retainedTokens = new Map<string, unknown[]>();
async function inputCheckpoint(page: Page, label: string) {
  const evidence = await within(page.evaluate(async ({ owner, ids }) => {
    const keys = Object.keys(localStorage).filter(key => Object.values(ids).some(id =>
      key === 'orbis:body-draft:' + owner + ':' + id ||
      key.startsWith('orbis:body-draft:' + owner + ':' + id + ':'))).sort();
    const legacy = keys.map(key => ({ key, raw: localStorage.getItem(key) }));
    const finished = Object.keys(localStorage).filter(key => Object.values(ids).some(id =>
      key.startsWith('orbis:body-draft-finished:' + owner.toLowerCase() + ':' + id.toLowerCase() + ':')))
      .sort().map(key => ({ key, raw: localStorage.getItem(key) }));
    const controlRaw = localStorage.getItem('orbis:local-data:device:v1');
    const queueRaw = localStorage.getItem('orbis:retry-buffer:v1:' + owner);
    const name = 'orbis-input:' + owner;
    const databases = (await indexedDB.databases()).map(db => db.name ?? '').sort();
    let slots: any[] = [];
    if (databases.includes(name)) slots = await new Promise<any[]>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        try {
          const tx = db.transaction('slots', 'readonly');
          let values: any[] = [];
          tx.oncomplete = () => { db.close(); resolve(values); };
          tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Readonly slots aborted')); };
          const get = tx.objectStore('slots').getAll();
          get.onsuccess = () => { values = get.result; };
          get.onerror = () => { db.close(); reject(get.error); };
        } catch (error) { db.close(); reject(error); }
      };
    });
    return { owner, ids, legacy, finished, slots, controlRaw, queueRaw, databases, at: Date.now(),
      url: location.href, time: new Date().toISOString() };
  }, { owner, ids }), 'readonly input checkpoint ' + label);
  const file = `${++checkpointSequence}-${label}.input.json`;
  await writeFile(join(outDir, file), JSON.stringify(evidence, null, 2));
  log('input-checkpoint', { label, file, digest: sha(JSON.stringify(evidence)) });
  return evidence;
}
async function requireDraftSnapshot(page: Page, id: string, expected: DraftExpectation) {
  const observed = await inputCheckpoint(page, 'retained-' + id);
  const child = await spawnOwned([BUN_EXECUTABLE!, join(sourceDir, 'validators.bun.ts'),
    current.tree, join(manifests, 'current.json'), handoff.manifests.current], {
    cwd: current.tree, env: { PATH: serverEnv.PATH! }, stdout: 'pipe', stderr: 'pipe',
    input: JSON.stringify({ observed, owner, id, expected, previousTokens: retainedTokens.get(id) }),
  });
  children.add(child);
  try {
    const [status, stdout, stderr] = await within(Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]), 'readonly production validator child');
    const answer = JSON.parse(stdout);
    if (!answer.ok) {
      const error = new Error(redact(answer.message)); error.name = answer.name;
      error.stack = redact(answer.stack ?? answer.message); throw error;
    }
    assert.equal(status, 0, redact(stderr));
    if (answer.retainedTokens) retainedTokens.set(id, answer.retainedTokens);
  } finally { if (child.exitCode !== null) children.delete(child); }

}

async function pendingBody(page: Page, id: string, expected: { doc: unknown; baseRevision: number }) {
  await page.goto(origin + '/r/' + id);
  await requireEntry(page, current);
  const banner = page.getByTestId('draft-banner');
  await banner.getByRole('button', { name: 'Оставить моё' }).waitFor({ timeout });
  await requireDraftSnapshot(page, id, expected);
  return banner;
}
const bodyPosts = (id: string) => journal.filter(row => row.phase === 'current' && row.actor === 'browser' && row.bodies.includes(id));
async function enableFinanceForP() {
  const before = await ok<{ disabledModules: string[] }>('user.getSettings', undefined, true);
  assert(Array.isArray(before.disabledModules) && before.disabledModules.includes('finance'),
    'Expected the b5 onboarding Finance-off mask');
  const changed = await ok<{ disabledModules: string[] }>('user.setModuleEnabled', {
    module: 'finance', enabled: true,
  });
  const observed = await ok<{ disabledModules: string[] }>('user.getSettings', undefined, true);
  assert(Array.isArray(changed.disabledModules) && !changed.disabledModules.includes('finance'));
  assert(Array.isArray(observed.disabledModules) && !observed.disabledModules.includes('finance'),
    'Finance must be enabled on the real b5 graph before fast-path');
  log('p-finance-enabled', { before: before.disabledModules, after: observed.disabledModules });
}

async function transportCategory() {
  const registry = await ok<{ aspects: { id: string }[] }>('registry.effective', undefined, true);
  assert(Array.isArray(registry.aspects), 'Unexpected b5 registry shape');
  for (const id of ['orbis/category', 'orbis/financial'])
    assert(registry.aspects.some(aspect => aspect.id === id), 'Missing onboarding aspect: ' + id);
  const rows = await ok<unknown>('entity.query', { query: 'aspect=orbis/category' }, true);
  assert(Array.isArray(rows), 'Expected the flat b5 category array');
  for (const row of rows) {
    assert(row && typeof row.id === 'string' && typeof row.title === 'string' &&
      row.props && typeof row.props === 'object' && !Array.isArray(row.props),
    'Expected b5 category id, title and props');
  }
  const matching = rows.filter(row => row.title === 'Транспорт' &&
    Array.isArray(row.props['orbis/aliases']) && row.props['orbis/aliases'].includes('такси'));
  assert.equal(matching.length, 1, 'Expected one real onboarding Transport category');
  return matching[0]!.id as string;
}

async function financialRows(): Promise<any[]> {
  return Array.from(await sql`
    select id, title, body, tags, aspects, props, archived from entities
    where graph_id = ${owner} and 'orbis/financial' = any(aspects)
  `);
}

async function fastPathActions(): Promise<any[]> {
  return Array.from(await sql`
    select id, entity_id, entity_ids, operations from action_journal
    where graph_id = ${owner} and source = 'fast_path'
  `);
}

type D2Input = {
  id: string; title: string; body?: string; tags?: string[]; aspects?: string[];
  props?: Record<string, unknown>;
};
async function semanticRows(input: D2Input): Promise<any[]> {
  const tags = sql.json(input.tags ?? []);
  const aspects = sql.json(input.aspects ?? []);
  return Array.from(await sql`
    select id, title, body, tags, aspects, props, archived from entities
    where graph_id = ${owner} and title = ${input.title} and body = ${input.body ?? ''}
      and to_jsonb(tags) @> ${tags}::jsonb and to_jsonb(tags) <@ ${tags}::jsonb
      and to_jsonb(aspects) @> ${aspects}::jsonb and to_jsonb(aspects) <@ ${aspects}::jsonb
      and props @> ${sql.json(input.props ?? {})}::jsonb
  `);
}

async function positive(oldServer: Awaited<ReturnType<typeof upstream>>) {
  await enableFinanceForP();
  const category = await transportCategory();
  assert.deepEqual(await financialRows(), [], 'Fresh onboarding graph has financial rows');
  assert.deepEqual(await fastPathActions(), [], 'Fresh onboarding graph has fast-path actions');
  log('d2-onboarding-baseline', { graph: owner, category, financialRows: 0, fastPathActions: 0 });
  const chrome = await launch();
  const held = await heldNavigation(chrome);
  const a = await newPage(chrome);
  await a.goto(origin + '/r/' + ids.a);
  await signIn(a);
  await proveOldWorker(a);
  const originals = await Promise.all([revision(ids.a), revision(ids.b)]);
  const markerA = 'R5-recover-first-synthetic-body';
  const markerB = 'R5-discard-second-synthetic-body';
  blockOldInputs = true;
  await edit(a, ids.a, markerA);
  const b = await newPage(chrome);
  await edit(b, ids.b, markerB);
  const chat = await newPage(chrome);
  await chat.goto(origin + '/chat');
  await requireEntry(chat, old);
  let d2From = journal.length;
  const d2BrowserRoute = () => journal.slice(d2From).filter(row => row.actor === 'browser' &&
    row.names.some(name => name === 'ai.sendMessage' || name === 'entity.create'));
  try {
    await inputCheckpoint(chat, 'before-d2-precondition');
    const input = chat.getByRole('textbox', { name: 'Сообщение' });
    await input.waitFor({ state: 'visible', timeout });
    const chip = chat.getByTestId('composer-context');
    const contextBefore = await chip.allTextContents();
    assert(contextBefore.length <= 1, 'Expected at most one Composer context');
    log('d2-composer-context-before', { text: contextBefore });
    if (contextBefore.length) await chip.getByRole('button', { name: 'Убрать ссылку', exact: true }).click({ timeout });
    await chip.waitFor({ state: 'detached', timeout });
    await input.fill('такси 500');
    const send = chat.getByRole('button', { name: 'Отправить', exact: true });
    assert.equal(await chip.count(), 0, 'D2 requires an explicitly context-free Composer');
    assert.equal(await send.isEnabled(), true, 'Composer must be ready to send');
    log('d2-composer-ready', { contextCount: 0, text: await input.inputValue(),
      sendEnabled: true, preview: 'b5 Composer exposes no pre-submit financial preview' });
    await inputCheckpoint(chat, 'before-d2-submit');
    assert.equal(await chip.count(), 0, 'Composer context must remain absent at submit');
    log('d2-composer-at-submit', { contextCount: 0 });
    d2From = journal.length;
    await send.click({ timeout });
    const routed = await waitFor(async () => d2BrowserRoute()[0] ?? false, 'D2 actual browser route');
    log('d2-browser-route', { first: routed });
    assert(!d2BrowserRoute().some(row => row.names.includes('ai.sendMessage')),
      'D2 went through AI, not the required financial fast-path');
    assert(routed.creates.length === 1 && routed.forwarded === false,
      'Expected an actual fast_path create stopped before upstream');
    await chat.waitForFunction(key => !!localStorage.getItem(key), queue, { timeout });
    await inputCheckpoint(chat, 'after-d2-queue-observed');
    log('d2-public-pending-ui', {
      pending: await chat.getByTestId('pending-indicator').allTextContents(),
      cards: await chat.getByTestId('entity-card').allTextContents(),
    });
  } catch (error) {
    await inputCheckpoint(chat, 'd2-precondition-failure').catch(checkpointError =>
      log('d2-failure-checkpoint-unavailable', { message: redact(String(checkpointError)) }));
    throw error;
  } finally {
    await writeFile(join(outDir, 'd2-browser-route.json'), JSON.stringify(d2BrowserRoute(), null, 2));
  }
  const before = await store(chat);
  const drafts = before.drafts.map(raw => {
    assert(raw);
    const parsed = JSON.parse(raw);
    return { doc: parsed.doc, baseRevision: parsed.baseRevision as number };
  });
  const queued = JSON.parse(before.queue ?? '[]');
  assert.equal(queued.length, 1);
  const queuedId: string = queued[0].clientId;
  assert.equal(queued[0].payload.input.id ?? queuedId, queuedId);
  assert.equal(queued[0].payload.source, 'fast_path');
  const expectedInput: D2Input = { ...queued[0].payload.input, id: queuedId };
  const expectedPayload = { ...queued[0].payload, input: expectedInput };
  assert.equal(expectedInput.props?.['orbis/finance_category'], category);
  assert(expectedInput.aspects?.includes('orbis/financial'));
  assert.deepEqual(await semanticRows(expectedInput), [], 'D2 committed before cutover');
  assert.deepEqual(await financialRows(), [], 'Unexpected old financial write');
  assert.deepEqual(await fastPathActions(), [], 'Unexpected old fast-path action');
  assert.equal((await rpc('entity.get', { id: queuedId }, '0.6.0', true)).status, 404);
  assert.deepEqual(await Promise.all([revision(ids.a), revision(ids.b)]), originals);
  assert(before.keys.includes('sb-localhost-auth-token'));
  assert(before.keys.includes('orbis:nav:v2'));
  log('pre-switch-input', { draft: drafts.map(d => ({ docSha: sha(JSON.stringify(d.doc)), basis: d.baseRevision })),
    queueId: queuedId, queueSha: sha(before.queue!), originals });
  const bfcacheCovered = await bfcache(chrome, 'b');
  await inputCheckpoint(a, 'before-old-exit');
  await within(closeChrome(), 'whole old context close and PID exit');
  assert.equal(await within(held.result, 'old held target cancelled'), 'cancelled');
  release.resolve(false);
  assert.deepEqual(await Promise.all([revision(ids.a), revision(ids.b)]), originals);
  assert(!journal.some(row => row.phase === 'old' && row.actor === 'browser' && row.forwarded &&
    (row.bodies.some(id => id === ids.a || id === ids.b) || row.creates.includes(queuedId))));
  for (const id of [ids.a, ids.b]) assert(journal.some(row => row.phase === 'old' &&
    row.actor === 'browser' && !row.forwarded && row.bodies.includes(id)), 'Expected actual b5 body POST at gate');
  blockReplay = true;
  await switchUpstream(oldServer);

  const afterCas = [];
  for (const [index, id] of [ids.a, ids.b].entries()) {
    const original = originals[index]!;
    const body = 'Server CAS ' + index;
    const ack = await ok('entity.update', { id, body, expectedBodyRevision: original.rev });
    const reread = await revision(id);
    assert.equal(ack.bodyRevision, reread.rev);
    assert.equal(reread.body, ack.body);
    assert.equal(reread.body.trimEnd(), body);
    assert.notEqual(reread.rev, drafts[index]!.baseRevision);
    afterCas.push(reread);
  }
  log('pre-open-cas', { afterCas });
  const { page, assisted, startup } = await restartOrdinary();
  const now = live!;
  await inputCheckpoint(page, 'after-current-start-before-recovery');
  const pending = await store(page);
  assert.deepEqual(JSON.parse(pending.queue ?? '[]'), queued);
  const first = await pendingBody(page, ids.a, drafts[0]!);
  const secondPage = await newPage(now);
  await pendingBody(secondPage, ids.b, drafts[1]!);
  assert.equal(bodyPosts(ids.a).length + bodyPosts(ids.b).length, 0);
  await first.getByRole('button', { name: 'Оставить моё' }).click();
  await waitFor(async () => {
    const after = await revision(ids.a);
    return after.body.includes(markerA) && after.rev > afterCas[0]!.rev ? after : false;
  }, 'explicit first body ACK');
  const firstAck = bodyPosts(ids.a).filter(row => row.forwarded && row.status === 200);
  assert.equal(firstAck.length, 1);
  assert.equal(bodyPosts(ids.b).length, 0);

  assert.deepEqual(await semanticRows(expectedInput), [], 'D2 committed before replay admission');
  assert.deepEqual(await financialRows(), []);
  assert.deepEqual(await fastPathActions(), []);
  blockReplay = false;
  const retry = await newPage(now);
  await retry.goto(origin + '/chat');
  await requireEntry(retry, current);
  const button = retry.getByRole('button', { name: /Ждут отправки: 1\. Отправить сейчас/ });
  const queueStillPresent = (await store(retry)).queue;
  if (queueStillPresent && JSON.parse(queueStillPresent).length > 0)
    await button.click({ timeout });
  await waitFor(async () => {
    const fetched = await rpc('entity.get', { id: queuedId }, '0.7.0', true);
    return fetched.status === 200 && (fetched.data as any)?.entity?.id === queuedId;
  }, 'D2 original UUID received');
  const expectedDigest = canonicalSha(expectedPayload);
  const forwarded = journal.filter(row => row.phase === 'current' && row.actor === 'browser' &&
    row.forwarded && row.createPayloads.length > 0);
  assert(forwarded.length > 0, 'No real forwarded D2 request');
  for (const row of forwarded) assert(row.createPayloads.every(value =>
    value.id === queuedId && value.digest === expectedDigest), 'D2 forwarded under changed UUID or payload');
  const successes = forwarded.flatMap(row => row.outcomes ?? [])
    .filter(result => result.name === 'entity.create' && result.ok);
  assert(successes.length > 0 && successes.every(result => result.id === queuedId), 'D2 ACK identity mismatch');

  // Search by full recorded semantics, independently of the original UUID.
  // The broader, empty-before baseline also detects a changed payload/ID in
  // this otherwise fresh graph.
  const rows = await semanticRows(expectedInput);
  assert.deepEqual(rows.map(row => row.id), [queuedId], 'D2 duplicate or missing entity by semantics');
  assert.deepEqual((await financialRows()).map(row => row.id), [queuedId], 'Unexpected second financial entity');
  const saved = rows[0]!;
  assert.equal(saved.archived, false);
  for (const [name, value] of Object.entries(expectedInput.props ?? {}))
    assert.deepEqual(saved.props[name], value, name);
  const actions = await fastPathActions();
  assert.equal(actions.length, 1, 'D2 duplicate or missing fast-path journal action in this graph');
  assert(actions[0]?.entity_id === queuedId || actions[0]?.entity_ids.includes(queuedId));
  const operation = actions[0]!.operations.find((item: { op: string; payload?: D2Input }) =>
    item.op === 'entity_create' && item.payload?.id === queuedId);
  assert(operation?.payload, 'No matching entity_create in the committed D2 journal action');
  assert.equal(operation.payload.title, expectedInput.title);
  assert.equal(operation.payload.props?.['orbis/finance_category'], category);
  log('d2-exact-replay', { queuedId, expectedDigest, forwarded: forwarded.map(row => row.sequence),
    successfulAttempts: successes.length, action: actions[0]?.id });
  assert.deepEqual(JSON.parse((await store(retry)).queue ?? '[]'), []);
  await retry.close();
  await secondPage.close();
  await page.goto(origin + '/settings');
  await currentWorker(page, true);
  const decide = { accept: false, messages: [] as string[] };
  page.on('dialog', dialog => {
    decide.messages.push(dialog.message());
    void (decide.accept ? dialog.accept() : dialog.dismiss());
  });
  await inputCheckpoint(page, 'before-discard-cancel');
  const beforeCancel = await store(page);
  await toggle(page).click();
  await waitFor(async () => decide.messages.length > 0, 'discard confirmation');
  assert.match(decide.messages[0]!, /Неотправленных черновиков и записей: 1\./);
  await inputCheckpoint(page, 'after-discard-cancel');
  const afterCancel = await store(page);
  assert.equal(afterCancel.mode.mode, 'normal');
  // Exact retained B semantics/token are checked across LS/native below.
  assert.equal(afterCancel.queue, beforeCancel.queue);
  await requireDraftSnapshot(page, ids.b, drafts[1]!);
  assert.equal(bodyPosts(ids.b).length, 0);
  decide.accept = true;
  await toggle(page).click();
  await login(page).waitFor({ timeout });
  assertWiped(await store(page));
  assert.equal(bodyPosts(ids.b).length, 0);
  assert.deepEqual(await revision(ids.b), afterCas[1]);
  assert((await revision(ids.a)).body.includes(markerA));
  assert.equal((await rpc('entity.get', { id: queuedId }, '0.7.0', true)).status, 200);
  log('preserve-then-explicit-wipe', { draftA: true, draftBPosts: bodyPosts(ids.b).length,
    originalD2: queuedId, confirmations: decide.messages });

  await signIn(page);
  const sharedAuth = (await store(page)).session.filter(k => /^orbis:shared:auth:.*:sb-localhost-auth-token$/.test(k));
  assert.equal(sharedAuth.length, 1);
  await page.getByTestId('host-search').click();
  await page.getByRole('searchbox', { name: 'Строка поиска' }).fill('Cutover a');
  await page.getByTestId('search-hit-' + ids.a).click({ timeout });
  await page.getByRole('heading', { name: 'Cutover a', exact: true }).waitFor({ timeout });
  await opaque(page);
  await page.goBack({ waitUntil: 'commit' });
  await opaque(page);
  await page.reload();
  await requireEntry(page, current);
  await currentWorker(page, true);
  assertWiped(await store(page));
  assert.equal(await login(page).isVisible(), false);
  assert((await store(page)).session.includes(sharedAuth[0]!));
  const fresh = await newPage(now);
  await fresh.goto(origin);
  await login(fresh).waitFor({ timeout });
  await requireEntry(fresh, current);
  await closeChrome();
  const last = await launch();
  const reopened = await newPage(last);
  const response = await reopened.goto(origin);
  await login(reopened).waitFor({ timeout });
  await requireEntry(reopened, current);
  assertWiped(await store(reopened));
  log('reopened-current-after-purge', { fromServiceWorker: response?.fromServiceWorker() });
  await closeChrome();
  log('scenario-result', { scenario: 'P', status: bfcacheCovered ? 'local-positive-pass' : 'local-positive-bfcache-uncovered', assisted, startup, bfcacheCovered });
}

try {
  await checkContainer(handoff);
  await checkActualDb(sql, handoff, 'admin');
  const [head] = await sql`select max(created_at)::text as n from drizzle.__drizzle_migrations`;
  assert.equal(head?.n, '1790767973713', 'Disposable database must start at exact 0026');
  const oldServer = await upstream(old);
  address = oldServer.address;
  await seed();
  if (scenario === 'N') await negative(oldServer);
  else await positive(oldServer);
} catch (error) {
  const message = redact(String(error));
  const stack = redact(error instanceof Error ? error.stack ?? message : message);
  const details = { name: error instanceof Error ? error.name : typeof error, message, stack };
  await writeFile(join(outDir, 'original-failure.json'), JSON.stringify(details, null, 2));
  log('scenario-result', { scenario, status: 'failed-or-inconclusive', message, stack });
  const preserved = new Error(message);
  preserved.stack = stack;
  throw preserved;
} finally {
  release.resolve(false);
  await closeChrome().catch(error => log('disposable-profile-retained', { profile, message: String(error) }));
  for (const child of [...children]) await stop(child).catch(error => log('owned-upstream-cleanup', { message: String(error) }));
  await proxy.stop(true);
  await neutral.stop(true);
  await egress.stop(true);
  await sql.end();
  await writeFile(join(outDir, 'request-journal.json'), JSON.stringify(journal, null, 2));
}
