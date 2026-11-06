// One-shot readonly codec boundary. This process never owns a browser or a DB connection.
import assert from 'node:assert/strict';
import { join } from 'node:path';
assert(process.versions.bun, 'Production TS validators run only in the explicit Bun child');
assert(!process.env.DATABASE_URL && !process.env.DATABASE_URL_ADMIN && !process.env.SUPABASE_JWT_SECRET);
const [tree, manifestPath, manifestSha] = Bun.argv.slice(2);
assert(tree?.startsWith('/private/tmp/orbis-') && manifestPath && manifestSha);
const digest = (value: string | ArrayBuffer) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
const bytes = await Bun.file(manifestPath).arrayBuffer();
assert.equal(digest(bytes), manifestSha);
const manifest = JSON.parse(new TextDecoder().decode(bytes));
assert.equal(manifest.tree, tree);
for (const path of ['apps/web/src/lib/local-data/input-slot.ts',
  'apps/web/src/features/entity-editor/draft-storage.ts', 'apps/web/src/features/entity-editor/draft-mirror.ts',
  'apps/web/src/lib/local-data/input-store.ts', 'apps/web/src/lib/local-data/input-access.ts',
  'apps/web/src/lib/local-data/database.ts', 'apps/web/src/lib/local-data/device-control.ts'])
  assert.equal(digest(await Bun.file(join(tree, path)).arrayBuffer()), manifest.source[path]);
const { createDeviceControl, DEVICE_CONTROL_KEY } = await import(join(tree, 'apps/web/src/lib/local-data/device-control.ts'));
const { validInputSlot, visibleInputs, validInputToken } = await import(join(tree, 'apps/web/src/lib/local-data/input-slot.ts'));
const { listDraftsIn, isDraftSlotFinishedIn } = await import(join(tree, 'apps/web/src/features/entity-editor/draft-storage.ts'));
const input = JSON.parse(await Bun.stdin.text());
const { observed, owner, id, expected, previousTokens } = input;
const key = (value: string) => 'orbis:body-draft:' + owner + ':' + value;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const fields = Object.entries(value).filter(([, item]) => item !== undefined);
  return Object.fromEntries(fields.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
}
const canonicalSha = (value: unknown) => digest(JSON.stringify(canonical(value)));
function validate() {
  assert(observed.controlRaw === null || typeof observed.controlRaw === 'string', 'Observed device control bytes');
  const rows = new Map([...observed.legacy, ...observed.finished]
    .filter(row => row.raw !== null).map(row => [row.key, row.raw!]));
  const readonlyStorage = {
    getItem: (key: string) => key === DEVICE_CONTROL_KEY ? observed.controlRaw : rows.get(key) ?? null,
    keys: () => [...rows.keys()],
    setItem: () => { throw new Error('Readonly proof storage'); },
    removeItem: () => { throw new Error('Readonly proof storage'); },
  };
  // The real codec defines absence as initial generation; malformed bytes still fail.
  const device = createDeviceControl(readonlyStorage);
  const control = device.read();
  assert(control && typeof control.inputGeneration === 'string' && control.accountInput &&
    typeof control.accountInput === 'object' && !Array.isArray(control.accountInput), 'Current input generation metadata');
  const account = Object.hasOwn(control.accountInput, owner) ? control.accountInput[owner] : '0';
  assert.equal(typeof account, 'string');
  const scope = { accountId: owner, graphId: owner,
    generation: device.inputGeneration(owner, control) };
  const tokenValid = (token: any) => validInputToken(token) &&
    token.accountId === scope.accountId && token.graphId === scope.graphId && token.entityId === id &&
    token.generation === scope.generation && token.basis.revision === expected.baseRevision;
  const semantic = (doc: unknown, revision: unknown) => {
    try { assert.deepEqual({ doc, baseRevision: revision }, expected); return true; }
    catch { return false; }
  };
  const matchingTokens: unknown[] = [];
  let legacyMatch = false;
  // Public codec owns legacy parse, TTL, finished filtering and exact-input dedup.
  for (const { draft: value } of listDraftsIn(readonlyStorage, owner, '', id)) {
    if (value.acknowledged || !semantic(value.doc, value.baseRevision)) continue;
    if (value.inputToken) {
      if (!tokenValid(value.inputToken) || value.slot !== value.inputToken.nonce) continue;
      matchingTokens.push(value.inputToken);
    } else legacyMatch = true;
  }
  for (const slot of observed.slots) {
    if (!validInputSlot(slot, scope)) continue;
    for (const value of visibleInputs(slot, observed.at)) {
      if (value.acknowledged || !tokenValid(value.token) ||
        isDraftSlotFinishedIn(readonlyStorage, owner, id, value.token.nonce) ||
        !semantic(value.doc, value.token.basis.revision)) continue;
      matchingTokens.push(value.token);
    }
  }
  assert(legacyMatch || matchingTokens.length > 0,
    'Retained input must match doc/basis and own account/graph/entity/generation');
  const previous = previousTokens;
  if (previous) for (const token of previous) assert(matchingTokens.some(candidate =>
    canonicalSha(candidate) === canonicalSha(token)), 'Previously retained exact input token disappeared');
  return matchingTokens.length ? previous ?? matchingTokens : undefined;
}
try { console.log(JSON.stringify({ ok: true, retainedTokens: validate() })); }
catch (error) {
  console.log(JSON.stringify({ ok: false, name: error instanceof Error ? error.name : typeof error,
    message: String(error), stack: error instanceof Error ? error.stack : undefined }));
  process.exitCode = 1;
}
