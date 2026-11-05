import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { SignJWT } from 'jose';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import type { AiDeps } from '../../../../apps/server/src/ai/send-message';
import { createApp } from '../../../../apps/server/src/app';
import { makeDb } from '../../../../apps/server/src/db/client';
import { identityOfPerson, parseAccountId } from '../../../../apps/server/src/identity';
import { appRouter } from '../../../../apps/server/src/router';

const pins = JSON.parse(readFileSync(new URL('./reviewed-pins.json', import.meta.url), 'utf8'));
const expectedSource = pins.sourceSha;
const expectedManifest = pins.artifactManifestSha256;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function must(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

must(typeof expectedSource === 'string' && /^[0-9a-f]{40}$/.test(expectedSource), 'Reviewed source pin required');
must(typeof expectedManifest === 'string' && /^[0-9a-f]{64}$/.test(expectedManifest), 'Reviewed artifact pin required');
must(Number.isInteger(pins.artifactFileCount) && pins.artifactFileCount > 0, 'Reviewed artifact count required');
const cwd = realpathSync(process.cwd());
must(cwd.startsWith('/private/tmp/'), 'Run in the accepted isolated local clone');
const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd });
must(source.exitCode === 0 && new TextDecoder().decode(source.stdout).trim() === expectedSource, 'Unexpected source SHA');
const clean = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd });
must(clean.exitCode === 0 && clean.stdout.length === 0, 'Tracked or untracked source differs');

for (const [name, role] of [['DATABASE_URL', 'orbis_app'], ['DATABASE_URL_ADMIN', 'postgres']] as const) {
  const raw = process.env[name] ?? '';
  const url = new URL(raw);
  must(url.protocol === 'postgres:' || url.protocol === 'postgresql:', 'Unexpected DSN protocol');
  must(url.search === '' && url.hash === '' && !raw.includes('?') && !raw.includes('#'),
    'DSN query and fragment overrides are forbidden');
  must(url.hostname === '127.0.0.1' && url.port === '54339' &&
    url.username === role && url.pathname === '/postgres', 'Unexpected local DSN or role');
}
must(!process.env.SUPABASE_URL && !process.env.SUPABASE_JWKS_URL, 'External auth validation must be absent');
const secret = process.env.SUPABASE_JWT_SECRET;
must(secret, 'Local JWT fixture key required');
must(process.env.SAFARI_FIXTURE_OUT?.startsWith('/private/tmp/'), 'Temporary evidence directory required');
const out = resolve(process.env.SAFARI_FIXTURE_OUT);
mkdirSync(out, { recursive: true });
const dist = realpathSync(process.env.WEB_DIST_DIR ?? '');
const manifestPath = realpathSync(process.env.SAFARI_DIST_MANIFEST ?? '');
must(dist.startsWith('/private/tmp/') && manifestPath.startsWith('/private/tmp/'), 'Unexpected artifact path');
const manifest = readFileSync(manifestPath);
must(digest(manifest) === expectedManifest, 'Unexpected accepted 356 build manifest');
const entries = manifest.toString().trim().split('\n');
must(entries.length === pins.artifactFileCount, 'Unexpected accepted artifact file count');
for (const entry of entries) {
  const match = /^([0-9a-f]{64})  (.+)$/.exec(entry);
  must(match && !match[2].startsWith('/') && !match[2].split('/').includes('..'), 'Invalid manifest entry');
  const file = realpathSync(join(dist, match[2]));
  must(file.startsWith(dist + '/') && digest(readFileSync(file)) === match[1], 'Artifact bytes differ');
}

const owner = randomUUID();
const nonce = randomUUID();
const admin = postgres(process.env.DATABASE_URL_ADMIN!, { max: 1 });
const { db, client } = makeDb({ max: 3 });
const [adminRole] = await admin`select current_user as role, current_database() as database`;
must(adminRole?.role === 'postgres' && adminRole?.database === 'postgres', 'Unexpected admin session');
const runtimeRoles = await db.execute(sql`select session_user as role, current_database() as database`);
must(runtimeRoles[0]?.role === 'orbis_app' && runtimeRoles[0]?.database === 'postgres', 'Unexpected runtime session');
await admin`with created as (
  insert into graphs (id, owner_kind, owner_ref) values (${owner}::uuid, 'person', ${owner}::uuid)
  returning id
)
insert into graph_members (id, graph_id, account_id, grant_kind, issued_by)
select gen_random_uuid(), id, id, 'owner', id from created`;
await admin.end();

const caller = appRouter.createCaller({
  identity: identityOfPerson(parseAccountId(owner)), actorKind: 'owner', db, clientVersion: '0.7.0',
});
await caller.user.seedOnboarding();
const initial = 'Safari local initial body';
const record = await caller.entity.create({
  source: 'ui', input: { title: 'Safari synthetic record ' + nonce.slice(0, 8),
    body: initial, tags: [], aspects: ['orbis/note'] },
});
const current = () => caller.entity.get({ id: record.id, include: ['body'] });
const starting = await current();
const expires = Math.floor(Date.now() / 1000) + 3600;
const jwt = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' })
  .setSubject(owner).setAudience('authenticated').setExpirationTime(expires)
  .sign(new TextEncoder().encode(secret));
const session = {
  access_token: jwt, refresh_token: 'local-safari-only', token_type: 'bearer',
  expires_at: expires, expires_in: 3600,
  user: { id: owner, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} },
};
type Fields = Record<string, any>;
const fields = (value: unknown): Fields | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const object = fields(value);
  if (object) return '{' + Object.keys(object).sort().map((key) =>
    JSON.stringify(key) + ':' + canonical(object[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const jsonHash = (value: unknown) => digest(canonical(value));
function operationInput(payload: unknown, index: number, batched: boolean): Fields | undefined {
  const part = batched ? (payload as Fields | undefined)?.[String(index)] : payload;
  const input = fields(part);
  return fields(input?.json) ?? input;
}
let unavailable = false;
let ungatedRecordGets = 0;
let ackPhase: {
  id: string;
  armed: boolean;
  readGate: Promise<void>;
  openReads: () => void;
  readsReleased: boolean;
  readsHeld: number;
  preexistingAtArm: number;
  sent?: Fields;
  receipt?: Fields;
  releaseSave?: () => void;
  saveReleased: boolean;
  observedInput?: Fields;
  durableSnapshotSha256?: string;
} | undefined;
const events: object[] = [];
const emit = (event: object) => {
  const value = { at: new Date().toISOString(), ...event };
  events.push(value);
  appendFileSync(join(out, 'http.ndjson'), JSON.stringify(value) + '\n');
};
const prefix = '/__safari/' + nonce;
const app = createApp({ db, ai: {} as AiDeps, webDistDir: dist });
const noStore = { 'cache-control': 'no-store' };
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('origin') && request.headers.get('origin') !== server.url.origin)
      return new Response('Unrelated origin', { status: 403, headers: noStore });
    if (url.pathname === prefix + '/bootstrap' && request.method === 'GET') {
      const body = '<!doctype html><meta charset="utf-8"><title>Local Safari fixture</title><script>' +
        'localStorage.setItem("sb-localhost-auth-token",' + JSON.stringify(JSON.stringify(session)) + ');' +
        'location.replace(' + JSON.stringify('/r/' + record.id) + ');</script>';
      return new Response(body, { headers: { ...noStore, 'content-type': 'text/html',
        'content-security-policy': "connect-src 'self'; frame-ancestors 'none'" } });
    }
    if (url.pathname === prefix + '/state' && request.method === 'GET') {
      const value = await current();
      return Response.json({ owner, recordId: record.id, body: value.entity.body,
        bodyDoc: value.entity.bodyDoc, bodyRevision: value.entity.bodyRevision, unavailable,
        ackPhase: ackPhase ? {
          id: ackPhase.id, armed: ackPhase.armed, preexistingAtArm: ackPhase.preexistingAtArm,
          preexistingRecordGetsRemaining: ungatedRecordGets, drained: ungatedRecordGets === 0,
          readsReleased: ackPhase.readsReleased, readsHeld: ackPhase.readsHeld,
          sent: ackPhase.sent ?? null, receipt: ackPhase.receipt ?? null,
          saveReleased: ackPhase.saveReleased, observedInput: ackPhase.observedInput ?? null,
          durableSnapshotSha256: ackPhase.durableSnapshotSha256 ?? null,
        } : null, events }, { headers: noStore });
    }
    if (url.pathname === prefix + '/control' && request.method === 'POST') {
      if (Number(request.headers.get('content-length') ?? '0') > 65536) return new Response(null, { status: 413 });
      const input = await request.json() as {
        unavailable?: boolean; holdNextSave?: true; releaseSave?: true; releaseReads?: true;
        bindInput?: Fields; confirmDurable?: Fields; foreignBody?: string;
      };
      if (input.unavailable !== undefined) unavailable = input.unavailable;
      if (input.holdNextSave) {
        if (ackPhase && !ackPhase.readsReleased) return new Response('ACK phase already active', { status: 409 });
        let openReads!: () => void;
        const readGate = new Promise<void>((resolve) => { openReads = resolve; });
        ackPhase = {
          id: randomUUID(), armed: true, readGate, openReads, readsReleased: false,
          readsHeld: 0, preexistingAtArm: ungatedRecordGets, saveReleased: false,
        };
        emit({ kind: 'ack-phase-armed', phase: ackPhase.id, preexistingRecordGets: ungatedRecordGets });
      }
      if (input.bindInput) {
        const phase = ackPhase;
        const token = fields(input.bindInput.token) ?? fields(input.bindInput.inputToken);
        const sent = phase?.sent;
        if (!phase?.receipt || phase.saveReleased || !token || !sent ||
            token.accountId !== owner || token.graphId !== owner || token.entityId !== record.id ||
            typeof token.nonce !== 'string' || !token.nonce ||
            typeof token.writerId !== 'string' || !token.writerId ||
            !Number.isInteger(token.sequence) || token.sequence < 1 ||
            !['string', 'number'].includes(typeof token.generation) ||
            token.basis?.revision !== sent.expectedBodyRevision ||
            jsonHash(input.bindInput.doc) !== sent.bodyDocSha256 || input.bindInput.acknowledged === true)
          return new Response('Input snapshot does not match the held body request', { status: 409 });
        phase.observedInput = { token, doc: input.bindInput.doc, snapshotSha256: jsonHash(input.bindInput) };
        emit({ kind: 'input-bound', phase: phase.id, token, snapshotSha256: phase.observedInput.snapshotSha256 });
      }
      if (input.releaseSave) {
        const phase = ackPhase;
        if (!phase?.releaseSave || !phase.observedInput || ungatedRecordGets !== 0)
          return new Response('Capture the matching token after draining old reads', { status: 409 });
        phase.saveReleased = true;
        phase.releaseSave();
        emit({ kind: 'body-ack-released', phase: phase.id, readsStillHeld: !phase.readsReleased });
      }
      if (input.confirmDurable) {
        const phase = ackPhase;
        const snapshot = input.confirmDurable;
        const token = phase?.observedInput?.token;
        const receipt = phase?.receipt;
        const durable = snapshot.responses?.rows?.some((row: Fields) =>
          row.data?.entity?.id === record.id && row.data.entity.bodyRevision === receipt?.bodyRevision &&
          jsonHash(row.data.entity.bodyDoc) === receipt?.bodyDocSha256);
        const stillNative = snapshot.inputs?.rows?.some((row: Fields) =>
          [row.snapshot, row.acknowledgedFallback].some((copy) => copy?.token?.nonce === token?.nonce));
        const stillEmergency = snapshot.emergency?.some((copy: Fields) =>
          (copy.draft?.inputToken?.nonce ?? copy.draft?.slot) === token?.nonce && !copy.finished);
        if (!phase?.saveReleased || phase.readsReleased || !token || !receipt ||
            snapshot.origin !== server.url.origin || !snapshot.responses?.available ||
            !snapshot.inputs?.available || snapshot.emergencyError ||
            !Array.isArray(snapshot.emergency) || !durable || stillNative || stillEmergency)
          return new Response('Exact durable body and token retirement not established', { status: 409 });
        phase.durableSnapshotSha256 = jsonHash(snapshot);
        emit({ kind: 'durable-before-get-release', phase: phase.id,
          token, receiptSha256: receipt.sha256, snapshotSha256: phase.durableSnapshotSha256 });
      }
      if (input.releaseReads) {
        const phase = ackPhase;
        if (!phase?.durableSnapshotSha256)
          return new Response('Record durable state before releasing target reads', { status: 409 });
        phase.readsReleased = true;
        phase.openReads();
        emit({ kind: 'record-get-gate-released', phase: phase.id, heldRequests: phase.readsHeld });
      }
      if (input.foreignBody !== undefined) {
        must(typeof input.foreignBody === 'string' && input.foreignBody.length < 1024, 'Invalid fixture body');
        const value = await current();
        const updated = await caller.entity.update({
          id: record.id, body: input.foreignBody, expectedBodyRevision: value.entity.bodyRevision,
        });
        emit({ kind: 'fixture-foreign-write', id: record.id, txId: updated.txId, bodyRevision: updated.bodyRevision });
      }
      return Response.json({ ok: true, unavailable, phase: ackPhase?.id ?? null }, { headers: noStore });
    }
    if (url.pathname.startsWith('/__safari/')) return new Response(null, { status: 404, headers: noStore });
    const paths = url.pathname.startsWith('/trpc/') ? decodeURIComponent(url.pathname.slice(6)).split(',') : [];
    if (paths.includes('changes.watch')) server.timeout(request, 60);
    if (paths.length) {
      emit({ kind: 'request', paths, method: request.method, credentialed: request.headers.has('authorization') });
      if (unavailable) return new Response(null, { status: 503, headers: noStore });
    }
    let payload: unknown;
    if (paths.includes('entity.get') || paths.includes('entity.update')) {
      try {
        payload = request.method === 'GET' ? JSON.parse(url.searchParams.get('input') ?? 'null')
          : await request.clone().json();
      } catch {
        emit({ kind: 'request-input-observation-failed', paths });
        return new Response('Fixture cannot identify the request input', { status: 503, headers: noStore });
      }
    }
    const batched = url.searchParams.has('batch');
    const readIndex = paths.indexOf('entity.get');
    const targetRead = readIndex >= 0 && request.headers.has('authorization') &&
      operationInput(payload, readIndex, batched)?.id === record.id;
    const writeIndex = paths.indexOf('entity.update');
    const bodyInput = writeIndex >= 0 && request.method === 'POST'
      ? operationInput(payload, writeIndex, batched) : undefined;
    const ownBody = bodyInput?.id === record.id && fields(bodyInput.bodyDoc) &&
      Number.isInteger(bodyInput.expectedBodyRevision) && bodyInput.expectedBodyRevision > 0;
    const phase = ackPhase;
    const holdingReads = targetRead && phase && !phase.readsReleased;
    const ungated = targetRead && !holdingReads;
    if (ungated) ungatedRecordGets++;
    if (holdingReads) {
      phase.readsHeld++;
      emit({ kind: 'record-get-held', phase: phase.id, method: request.method });
      server.timeout(request, 60);
      await phase.readGate;
    }
    let capturesThisBody = false;
    if (ownBody && phase?.armed) {
      if (ungatedRecordGets !== 0) return new Response('Drain prior record reads before typing', { status: 409 });
      phase.armed = false;
      capturesThisBody = true;
      phase.sent = {
        id: bodyInput.id, bodyDoc: bodyInput.bodyDoc, expectedBodyRevision: bodyInput.expectedBodyRevision,
        bodyDocSha256: jsonHash(bodyInput.bodyDoc), requestSha256: jsonHash(bodyInput),
      };
      emit({ kind: 'body-request-captured', phase: phase.id, sent: phase.sent });
    }
    const response = await app.fetch(request).finally(() => {
      if (ungated) {
        ungatedRecordGets--;
        emit({ kind: 'ungated-record-get-completed', remaining: ungatedRecordGets });
      }
    });
    if (ownBody && response.ok) {
      const raw = await response.clone().json();
      const item = Array.isArray(raw) ? raw[writeIndex] : raw;
      const data = item?.result?.data?.json ?? item?.result?.data;
      must(data?.id === record.id && fields(data.bodyDoc) &&
        Number.isInteger(data.bodyRevision) && typeof data.txId === 'string',
        'Reply is not a successful own body ACK');
      const receipt = {
        id: data.id, txId: data.txId, bodyRevision: data.bodyRevision, status: response.status,
        bodyDoc: data.bodyDoc, bodyDocSha256: jsonHash(data.bodyDoc), sha256: jsonHash(data),
      };
      emit({ kind: 'body-ack', receipt });
      if (capturesThisBody) {
        must(phase?.sent && data.bodyRevision > phase.sent.expectedBodyRevision,
          'Held body ACK did not advance its submitted revision');
        phase.receipt = receipt;
        emit({ kind: 'body-ack-held', phase: phase.id, receipt });
        server.timeout(request, 60);
        let releaseSave!: () => void;
        const wait = new Promise<void>((resolve) => { releaseSave = resolve; });
        phase.releaseSave = releaseSave;
        await wait;
      }
    }
    if (response.headers.get('content-type')?.includes('text/html')) {
      const headers = new Headers(response.headers);
      headers.set('content-security-policy', "connect-src 'self'; frame-ancestors 'none'");
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
});
const descriptor = {
  source: expectedSource, artifactManifest: expectedManifest, origin: server.url.origin,
  bootstrapURL: new URL(prefix + '/bootstrap', server.url).href,
  stateURL: new URL(prefix + '/state', server.url).href,
  controlURL: new URL(prefix + '/control', server.url).href,
  recordURL: new URL('/r/' + record.id, server.url).href,
  owner, recordId: record.id, initialBody: initial, initialRevision: starting.entity.bodyRevision,
  expiresAt: expires, auth: 'scoped synthetic storage seed; connect-src self blocks occupied auth origin',
};
writeFileSync(join(out, 'fixture.json'), JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ event: 'safari-fixture-ready', evidence: join(out, 'fixture.json'),
  origin: descriptor.origin, owner, recordId: record.id, source: expectedSource }));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  ackPhase?.releaseSave?.();
  ackPhase?.openReads();
  server.stop(true);
  await client.end();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
