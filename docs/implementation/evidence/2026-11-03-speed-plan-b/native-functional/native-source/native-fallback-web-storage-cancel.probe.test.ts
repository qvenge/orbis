import { expect, test } from 'bun:test';
import { SignJWT } from 'jose';
import { chromium, type Page } from 'playwright-core';
import type { AiDeps } from '../../../apps/server/src/ai/send-message';
import { createApp } from '../../../apps/server/src/app';
import { makeDb } from '../../../apps/server/src/db/client';
import { appRouter } from '../../../apps/server/src/router';
import { freshGraph, personal } from '../../../apps/server/test/helpers';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
}
async function until(check: () => Promise<boolean>, label: string) {
  const end = Date.now() + 12_000;
  do {
    if (await check()) return;
    await Bun.sleep(25);
  } while (Date.now() < end);
  throw Error(label);
}
async function inputRows(page: Page, scope: string) {
  return await page.evaluate(async (scope) => {
    const name = 'orbis-input:' + scope;
    if (!(await indexedDB.databases()).some((db) => db.name === name)) return [];
    return new Promise<any[]>((resolve, reject) => {
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
  }, scope);
}
async function responseRows(page: Page, scope: string) {
  return await page.evaluate(async (scope) => {
    const name = 'orbis-cache:' + scope;
    if (!(await indexedDB.databases()).some((db) => db.name === name)) return [];
    return new Promise<any[]>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('responses')) { db.close(); resolve([]); return; }
        const read = db.transaction('responses').objectStore('responses').getAll();
        read.onerror = () => { db.close(); reject(read.error); };
        read.onsuccess = () => { db.close(); resolve(read.result); };
      };
    });
  }, scope);
}
async function emergency(page: Page, account: string, record: string) {
  return await page.evaluate(({ account, record }) => {
    const prefix = 'orbis:body-draft:' + account + ':' + record + ':';
    return Object.keys(localStorage).filter((key) => key.startsWith(prefix)).map((key) => {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null');
      const finished = !!value?.slot && localStorage.getItem(
        'orbis:body-draft-finished:' + account + ':' + record + ':' + value.slot) !== null;
      return { key, value, finished };
    });
  }, { account, record });
}
const inputText = (snapshot: any) => snapshot?.doc?.doc?.content?.[0]?.content?.[0]?.text;
const inputToken = (snapshot: any) => snapshot?.token ?? snapshot?.inputToken;
function exactToken(snapshot: any) {
  const token = inputToken(snapshot);
  expect(token?.nonce).toBeTypeOf('string');
  expect(token?.generation).toBeDefined();
  return token;
}


test('same-SHA normal → response-off → normal keeps B12 native and emergency input', async () => {
  const dsn = new URL(process.env.DATABASE_URL ?? '');
  expect([dsn.hostname, dsn.port]).toEqual(['127.0.0.1', '54339']);
  const offDir = process.env.B13_FALLBACK_DIST;
  if (!offDir || !offDir.startsWith('/private/tmp/')) throw Error('fallback build required');
  const { db, client } = makeDb();
  const primary = createApp({ db, ai: {} as AiDeps });
  const fallback = createApp({ db, ai: {} as AiDeps, webDistDir: offDir });
  let mode: 'primary' | 'fallback' = 'primary';
  let postCount = 0;
  let postGate: ReturnType<typeof gate> | undefined;
  let heldStatus: number | undefined;
  let holdOffRead: ReturnType<typeof gate> | undefined;
  let offReadStarted: ReturnType<typeof gate> | undefined;
  let offRecordId: string | undefined;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const url = new URL(req.url);
    const app = mode === 'primary' ? primary : fallback;
    if (mode === 'fallback' && url.pathname.startsWith('/trpc/')) {
      console.log(JSON.stringify({ event: 'off-request', method: req.method,
        path: url.pathname, authenticated: req.headers.has('authorization'),
        matchingRecord: !!offRecordId && !!url.searchParams.get('input')?.includes(offRecordId) }));
    }
    if (req.method === 'POST' && url.pathname.includes('entity.update')) {
      const pending = ++postCount === 1 ? postGate : undefined;
      const response = await app.fetch(req);
      if (pending) {
        heldStatus = response.status;
        await pending.promise;
      }
      return response;
    }
    if (mode === 'fallback' && holdOffRead && req.method === 'GET' &&
        url.pathname.includes('entity.get') && req.headers.has('authorization') &&
        offRecordId && url.searchParams.get('input')?.includes(offRecordId)) {
      offReadStarted?.resolve();
      await holdOffRead.promise;
    }
    return app.fetch(req);
  }});
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    for (const lane of ['idb', 'web-storage'] as const) {
      if (String(lane) !== 'web-storage') continue;
      const account = await freshGraph();
      const caller = appRouter.createCaller({ identity: personal(account), actorKind: 'owner', db, clientVersion: '0.7.0' });
      await caller.user.seedOnboarding();
      const record = await caller.entity.create({ source: 'ui', input: { title: 'Local draft fixture',
        body: 'Initial local input', tags: [], aspects: ['orbis/note'] } });
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const jwt = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).setSubject(account)
        .setAudience('authenticated').setExpirationTime(expires)
        .sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!));
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.addInitScript(({ origin, account, jwt, expires }) => {
        if (location.origin !== origin) return;
        const key = 'sb-localhost-auth-token';
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ access_token: jwt,
          refresh_token: 'local-only', expires_at: expires, expires_in: 3600, token_type: 'bearer',
          user: { id: account, role: 'authenticated', aud: 'authenticated', app_metadata: {}, user_metadata: {} } }));
        if (localStorage.getItem('__b13_input_abort') === 'true') {
          const put = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function(value, ...rest) {
            const request = put.call(this, value, ...rest);
            if (this.transaction.db.name.startsWith('orbis-input:')) this.transaction.abort();
            return request;
          };
        }
      }, { origin: server.url.origin, account, jwt, expires });
      const page = await context.newPage();
      page.on('pageerror', (error) => console.log(JSON.stringify({ event: 'pageerror', message: error.message })));
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.origin === server.url.origin ? route.continue() : route.abort();
      });
      const address = new URL('/r/' + record.id, server.url).href;
      const editor = page.getByTestId('body-editor').locator('[contenteditable=true]');
      const setText = (text: string) => editor.evaluate((node, text) => {
        (node as HTMLElement).focus();
        window.getSelection()?.selectAllChildren(node);
        if (!document.execCommand('insertText', false, text)) throw Error('insertText');
      }, text);
      const detailCache = async () => (await responseRows(page, account)).find((row) =>
        row.data?.entity?.id === record.id && row.data.entity.bodyDoc != null);
      const openEditor = async () => {
        const preview = page.getByTestId('editor-preview');
        await editor.or(preview).first().waitFor();
        if (await preview.isVisible()) {
          await preview.click({ timeout: 1_000 }).catch(async (error) => {
            if (!(await editor.isVisible())) throw error;
          });
        }
        await editor.waitFor();
      };
      mode = 'primary';
      postCount = 0;
      heldStatus = undefined;
      await page.goto(address);
      await openEditor();
      await until(async () => !!(await detailCache()), 'primary persisted detail');
      const savedRevision = (await detailCache())?.data.entity.bodyRevision;
      const native = () => inputRows(page, account);
      const rawWeb = () => emergency(page, account, record.id);
      const web = async () => (await rawWeb()).filter((row) => !row.finished);
      const snapshots = async () => lane === 'idb'
        ? (await native()).flatMap((row) => [row.snapshot, row.acknowledgedFallback]).filter(Boolean)
        : (await web()).map((row) => row.value);
      if (lane === 'idb') {
        const normal = await caller.entity.create({ source: 'ui', input: {
          title: 'Normal strict ACK', body: 'Initial normal body', tags: [], aspects: ['orbis/note'],
        } });
        await page.goto(new URL('/r/' + normal.id, server.url).href);
        await openEditor();
        const normalResponse = async () => (await responseRows(page, account)).find((row) =>
          row.data?.entity?.id === normal.id && row.data.entity.bodyDoc != null);
        await until(async () => !!(await normalResponse()), 'normal persisted initial body');
        const originalRevision = (await normalResponse())?.data.entity.bodyRevision;
        postGate = gate();
        const normalText = 'Normal autosave strict ACK exact body';
        await setText(normalText);
        await until(async () => heldStatus === 200, 'normal real ACK held');
        await until(async () => (await native()).some((row) =>
          row.snapshot?.token.entityId === normal.id && inputText(row.snapshot) === normalText), 'normal exact input checkpoint');
        const sent = exactToken((await native()).find((row) =>
          row.snapshot?.token.entityId === normal.id)?.snapshot);
        expect((await normalResponse())?.data.entity.bodyRevision).toBe(originalRevision);
        postGate.resolve();
        await until(async () => {
          const response = (await normalResponse())?.data.entity;
          const remains = (await native()).some((row) => [row.snapshot, row.acknowledgedFallback]
            .some((candidate) => inputToken(candidate)?.nonce === sent.nonce));
          return response?.bodyRevision === originalRevision + 1 &&
            inputText({ doc: response.bodyDoc }) === normalText && !remains;
        }, 'normal actual ACK and matching response commit retire the exact input');
        expect(postCount).toBe(1);
        console.log(JSON.stringify({ scenario: 'normal-ack-durable', token: sent, revision: originalRevision + 1 }));
        await page.goto(address);
        await openEditor();
        postCount = 0;
        heldStatus = undefined;
      }
      if (lane === 'web-storage') await page.evaluate(() => localStorage.setItem('__b13_input_abort', 'true'));
      const offResponseRows = JSON.stringify(await responseRows(page, account));
      holdOffRead = gate();
      offReadStarted = gate();
      offRecordId = record.id;
      mode = 'fallback';
      await page.reload({ waitUntil: 'domcontentloaded' });
      await until(async () => {
        const entered = await Promise.race([offReadStarted!.promise.then(() => true), Bun.sleep(25).then(() => false)]);
        return entered;
      }, 'off reload makes a real credentialed entity.get').catch(async (error) => {
        console.log(JSON.stringify({ event: 'off-get-timeout', path: new URL(page.url()).pathname,
          body: (await page.locator('body').innerText()).slice(0, 1000) }));
        throw error;
      });
      const diskBodyVisible = await page.getByText('Initial local input', { exact: true })
        .waitFor({ state: 'visible', timeout: 500 }).then(() => true, () => false);
      expect(diskBodyVisible).toBe(false);
      expect(JSON.stringify(await responseRows(page, account))).toBe(offResponseRows);
      holdOffRead.resolve();
      holdOffRead = undefined;
      await openEditor();

      postGate = gate();
      const textA = 'Confirmed local A';
      const textB = 'Pending local B';
      await setText(textA);
      await until(async () => heldStatus !== undefined, 'A server response held');
      expect(heldStatus).toBe(200);
      expect(postCount).toBe(1);
      await until(async () => (await snapshots()).some((value) => inputText(value) === textA), 'held A exact checkpoint');
      const tokenA = exactToken((await snapshots()).find((value) => inputText(value) === textA));
      // This isolated probe holds B autosave while verifying its earlier
      // 300-ms checkpoint and late A. The production timer is not changed.
      await page.evaluate(() => {
        const schedule = window.setTimeout;
        (window as any).__b13NativeTimeout = schedule;
        window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) =>
          schedule(callback, delay === 1000 ? 60_000 : delay, ...args)) as typeof window.setTimeout;
      });
      await setText(textB);
      if (lane === 'idb') await until(async () => (await inputRows(page, account)).some(row => inputText(row.snapshot) === textB), 'B native checkpoint');
      else await until(async () => (await emergency(page, account, record.id)).some(row => row.key.endsWith(':head') && inputText(row.value) === textB), 'B Web Storage head');
      const tokenB = exactToken((await snapshots()).find((value) => inputText(value) === textB));
      expect(tokenB.nonce).not.toBe(tokenA.nonce);
      expect(tokenB).toMatchObject({ generation: tokenA.generation, writerId: tokenA.writerId });
      postGate.resolve();
      if (lane === 'idb') await until(async () => (await native()).some(row =>
        [row.snapshot,row.acknowledgedFallback].some(value => value?.acknowledged && inputText(value) === textA)), 'A native ACK');
      else await until(async () => (await web()).some(row =>
        row.key.endsWith(':ack-head') && row.value.acknowledged && inputText(row.value) === textA), 'A Web Storage ack-head');
      expect(exactToken((await snapshots()).find((value) => value.acknowledged && inputText(value) === textA))).toEqual(tokenA);
      expect(exactToken((await snapshots()).find((value) => inputText(value) === textB))).toEqual(tokenB);
      expect((await detailCache())?.data.entity.bodyRevision).toBe(savedRevision);
      await page.evaluate(() => {
        window.setTimeout = (window as any).__b13NativeTimeout;
        delete (window as any).__b13NativeTimeout;
      });
      await editor.press('ControlOrMeta+z');
      await until(async () => (await editor.innerText()).includes(textA), 'editor undo restores actual A');
      if (lane === 'idb') await until(async () => (await native()).every(row => inputText(row.snapshot) !== textB), 'B native cancelled');
      else await until(async () => {
        const copies = await web();
        return copies.some((row) => row.value.acknowledged && inputToken(row.value)?.nonce === tokenA.nonce) &&
          copies.every((row) => inputToken(row.value)?.nonce === tokenA.nonce);
      }, 'B cancelled without a live unacknowledged replacement');
      console.log(JSON.stringify({ scenario: 'editor-cancel-B', before: tokenB,
        heads: (await rawWeb()).map(({ key, value, finished }) => ({
          suffix: key.endsWith(':ack-head') ? 'ack-head' : 'head', token: inputToken(value),
          acknowledged: value.acknowledged ?? false, finished, text: inputText(value),
        })), sends: postCount }));
      expect((await snapshots()).some((value) => inputToken(value)?.nonce === tokenB.nonce)).toBe(false);
      expect(exactToken((await snapshots()).find((value) => value.acknowledged && inputText(value) === textA))).toEqual(tokenA);
      expect(postCount).toBe(1);

      await page.reload();
      await openEditor();
      await until(async () => (await editor.innerText()).includes(textA), 'off reload displays confirmed A');
      await Bun.sleep(1300);
      expect(postCount).toBe(1);
      expect((await detailCache())?.data.entity.bodyRevision).toBe(savedRevision);
      const current = await caller.entity.get({ id: record.id, include: ['body'] });
      const foreignText = 'Foreign confirmed edit while response cache is off';
      const foreign = await caller.entity.update({
        id: record.id, body: foreignText, expectedBodyRevision: current.entity.bodyRevision,
      });
      const recovery = page.getByTestId('draft-banner');
      const ackCandidates = async () => {
        const snapshots = lane === 'idb'
          ? (await native()).flatMap((row) => [row.snapshot, row.acknowledgedFallback])
          : (await web()).map((row) => row.value);
        return snapshots.filter((value) => value?.acknowledged && inputText(value) === textA);
      };
      async function assertRecoveryOffer() {
        await page.reload();
        await openEditor();
        await until(async () => (await editor.innerText()).includes(foreignText), 'server body remains visible');
        await recovery.getByRole('button', { name: 'Оставить моё' }).waitFor();
        const acknowledgements = await ackCandidates();
        expect(acknowledgements).toHaveLength(1);
        expect(exactToken(acknowledgements[0])).toEqual(tokenA);
        expect(postCount).toBe(1);
        expect((await detailCache())?.data.entity.bodyRevision).toBe(savedRevision);
      }
      await assertRecoveryOffer();

      if (lane === 'web-storage') {
        // Exercise the reader for the earlier layout using the actual ACK bytes
        // written above. B was cancelled, so there is no pending head to replace.
        await page.evaluate(({ account, record }) => {
          const prefix = 'orbis:body-draft:' + account + ':' + record + ':';
          const ack = Object.keys(localStorage).find((key) =>
            key.startsWith(prefix) && key.endsWith(':ack-head'));
          if (!ack) throw Error('ACK-only Web Storage slot missing');
          const head = ack.replace(/:ack-head$/, ':head');
          const raw = localStorage.getItem(head);
          if (raw !== null) {
            const current = JSON.parse(raw);
            const confirmed = JSON.parse(localStorage.getItem(ack)!);
            const retired = localStorage.getItem(
              'orbis:body-draft-finished:' + account + ':' + record + ':' + current.slot);
            if (retired === null && current.slot !== confirmed.slot) throw Error('Unretired independent head');
          }
          localStorage.setItem(head, localStorage.getItem(ack)!);
          localStorage.removeItem(ack);
        }, { account, record: record.id });
        await assertRecoveryOffer();
      }
      await Bun.sleep(1300);
      expect(postCount).toBe(1);
      expect(JSON.stringify(await responseRows(page, account))).toBe(offResponseRows);
      const restored = await caller.entity.update({
        id: record.id, body: textA, expectedBodyRevision: foreign.bodyRevision,
      });
      mode = 'primary';
      await page.reload();
      await openEditor();
      await until(async () => (await detailCache())?.data.entity.bodyRevision === restored.bodyRevision,
        'normal response DB resumes with actual server revision');
      expect((await editor.innerText()).includes(textA)).toBe(true);
      // Recovery may first check before the GET's asynchronous response commit.
      // Reopen with the exact confirmed bytes already durable, preserving the send count.
      if ((await ackCandidates()).length !== 0) {
        await page.reload();
        await openEditor();
      }
      await until(async () => (await ackCandidates()).length === 0,
        'matching strict response retires the acknowledged copy');
      expect(postCount).toBe(1);
      console.log(JSON.stringify({ scenario: 'response-off', lane, primaryRevision: savedRevision,
        currentRevision: (await detailCache())?.data.entity.bodyRevision,
        oldResponseUntouchedInFallback: true, acknowledgedCopyKept: true, recoveryFromStorageUnderDivergence: true,
        tokenA, tokenB, noResponseRestoreBeforeOffGet: true,
        legacyAckInHead: lane === 'web-storage', noResend: true,
        serviceWorker: 'blocked to isolate same-SHA flag' }));
      await context.close();
    }
  } finally {
    postGate?.resolve();
    holdOffRead?.resolve();
    await browser.close();
    server.stop(true);
    await client.end();
  }
}, 95_000);

test('two real compatible build SHAs switch response buster and preserve exact input', async () => {
  const dsn = new URL(process.env.DATABASE_URL ?? '');
  expect([dsn.hostname, dsn.port]).toEqual(['127.0.0.1', '54339']);
  const previousDist = process.env.B13_PREVIOUS_DIST;
  const previousSha = process.env.B13_PREVIOUS_SHA;
  const candidateSha = process.env.B13_CANDIDATE_SHA;
  if (!previousDist?.startsWith('/private/tmp/') || !previousSha || !candidateSha)
    throw Error('Two exact compatible 0.7 builds required');
  expect(previousSha).toMatch(/^[0-9a-f]{40}$/);
  expect(candidateSha).toMatch(/^[0-9a-f]{40}$/);
  expect(previousSha).not.toBe(candidateSha);

  const { db, client } = makeDb();
  const previous = createApp({ db, ai: {} as AiDeps, webDistDir: previousDist });
  const candidate = createApp({ db, ai: {} as AiDeps });
  let active = previous;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      return active.fetch(req);
    },
  });
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  try {
    const account = await freshGraph();
    const caller = appRouter.createCaller({
      identity: personal(account), actorKind: 'owner', db, clientVersion: '0.7.0',
    });
    await caller.user.seedOnboarding();
    const record = await caller.entity.create({
      source: 'ui', input: {
        title: 'Compatible buster local fixture', body: 'Before build switch',
        tags: [], aspects: ['orbis/note'],
      },
    });
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(account)
      .setAudience('authenticated').setExpirationTime(expires)
      .sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!));
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(({ origin, account, jwt, expires }) => {
      if (location.origin !== origin) return;
      const key = 'sb-localhost-auth-token';
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
        access_token: jwt, refresh_token: 'local-only', expires_at: expires, expires_in: 3600,
        token_type: 'bearer',
        user: { id: account, role: 'authenticated', app_metadata: {}, user_metadata: {} },
      }));
    }, { origin: server.url.origin, account, jwt, expires });
    const previousVersions = new Set<string>();
    const candidateVersions = new Set<string>();
    let candidateSaves = 0;
    await context.route('**/*', (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== server.url.origin) return route.abort();
      if (url.pathname.startsWith('/trpc/')) {
        const version = request.headers()['x-orbis-client-version'];
        if (version) (active === candidate ? candidateVersions : previousVersions).add(version);
      }
      if (request.method() === 'POST' && url.pathname.includes('entity.update')) {
        if (active === candidate) candidateSaves += 1;
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    const address = new URL('/r/' + record.id, server.url).href;
    const editor = page.getByTestId('body-editor').locator('[contenteditable=true]');
    const openEditor = async () => {
      const preview = page.getByTestId('editor-preview');
      await editor.or(preview).first().waitFor();
      if (await preview.isVisible()) {
        await preview.click({ timeout: 1_000 }).catch(async (error) => {
          if (!(await editor.isVisible())) throw error;
        });
      }
      await editor.waitFor();
    };
    const recordResponse = async () => (await responseRows(page, account)).find((row) =>
      row.data?.entity?.id === record.id && row.data.entity.bodyDoc != null);
    const pending = 'Input from compatible previous build';
    const draft = async () => (await inputRows(page, account)).map((row) => row.snapshot)
      .find((value) => inputText(value) === pending);
    await page.goto(address);
    await openEditor();
    await until(async () => !!(await recordResponse()), 'previous build persisted body');
    expect(JSON.parse((await recordResponse()).buster)[0]).toBe(previousSha);
    await editor.evaluate((node, text) => {
      (node as HTMLElement).focus();
      window.getSelection()?.selectAllChildren(node);
      if (!document.execCommand('insertText', false, text)) throw Error('insertText');
    }, pending);
    await until(async () => !!(await draft()), 'previous build durable pending input');
    const original = exactToken(await draft());
    const current = await caller.entity.get({ id: record.id, include: ['body'] });
    const foreignBody = 'Server body during compatible switch';
    const foreign = await caller.entity.update({
      id: record.id, body: foreignBody, expectedBodyRevision: current.entity.bodyRevision,
    });

    active = candidate;
    await page.reload();
    await openEditor();
    await until(async () => {
      const response = await recordResponse();
      return response?.data.entity.bodyRevision === foreign.bodyRevision &&
        JSON.parse(response.buster)[0] === candidateSha;
    }, 'new real SHA replaced compatible response buster');
    expect((await editor.innerText()).includes(foreignBody)).toBe(true);
    await page.getByTestId('draft-banner').getByRole('button', { name: 'Оставить моё' }).waitFor();
    expect(exactToken(await draft())).toEqual(original);
    expect(await responseRows(page, account)).not.toContainEqual(
      expect.objectContaining({ buster: expect.stringContaining(previousSha) }),
    );
    expect(candidateSaves).toBe(0);
    expect([...previousVersions]).toEqual(['0.7.0']);
    expect([...candidateVersions]).toEqual(['0.7.0']);
    console.log(JSON.stringify({ scenario: 'compatible-real-build-buster',
      previousSha, candidateSha, inputToken: original, bodyRevision: foreign.bodyRevision,
      previousVersions: [...previousVersions], candidateVersions: [...candidateVersions], candidateSaves, serviceWorker: 'blocked' }));
    await context.close();
  } finally {
    await browser.close();
    server.stop(true);
    await client.end();
  }
}, 60_000);
