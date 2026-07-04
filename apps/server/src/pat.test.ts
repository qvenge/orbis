// apps/server/src/pat.test.ts
// Юнит-тесты verifyPat (§9.3): hash-only, fail-closed при отсутствии ЛЮБОГО из env,
// битом hash в env и любом несовпадении. Constant-time не ассертим таймингом —
// он конструктивен (сравнение 32-байтных sha256-дайджестов через timingSafeEqual).
// Без моков crypto — реальное хеширование. Плюс контракт scripts/issue-pat.ts:
// напечатанный hash обязан совпадать с sha256 напечатанного токена.

import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PAT_PREFIX, verifyPat } from './pat';

const savedEnv = {
  ORBIS_PAT_HASH: process.env.ORBIS_PAT_HASH,
  ORBIS_PAT_OWNER_ID: process.env.ORBIS_PAT_OWNER_ID,
};

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const OWNER = crypto.randomUUID();
// Фиксированный «выданный» токен: формат как у issue-pat (префикс + 64 hex)
const TOKEN = `${PAT_PREFIX}${'ab'.repeat(32)}`;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  process.env.ORBIS_PAT_HASH = sha256hex(TOKEN);
  process.env.ORBIS_PAT_OWNER_ID = OWNER;
});

test('валидный токен → { ownerId } из ORBIS_PAT_OWNER_ID', () => {
  expect(verifyPat(TOKEN)).toEqual({ ownerId: OWNER });
});

test('битый токен (изменён последний символ) → null', () => {
  expect(verifyPat(`${TOKEN.slice(0, -1)}c`)).toBeNull();
});

test('чужой токен правильного формата → null', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const other = PAT_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  expect(verifyPat(other)).toBeNull();
});

test('fail-closed: нет ORBIS_PAT_HASH → null даже для «валидного» токена', () => {
  delete process.env.ORBIS_PAT_HASH;
  expect(verifyPat(TOKEN)).toBeNull();
});

test('fail-closed: нет ORBIS_PAT_OWNER_ID → null', () => {
  delete process.env.ORBIS_PAT_OWNER_ID;
  expect(verifyPat(TOKEN)).toBeNull();
});

test('fail-closed: оба env отсутствуют → null', () => {
  delete process.env.ORBIS_PAT_HASH;
  delete process.env.ORBIS_PAT_OWNER_ID;
  expect(verifyPat(TOKEN)).toBeNull();
});

test('fail-closed: битый ORBIS_PAT_HASH (пустой/короткий/не-hex/усечённый) → null', () => {
  const bads = ['', 'deadbeef', 'z'.repeat(64), sha256hex(TOKEN).slice(0, 62)];
  for (const bad of bads) {
    process.env.ORBIS_PAT_HASH = bad;
    expect(verifyPat(TOKEN)).toBeNull();
  }
});

test('issue-pat.ts: печатает токен `orbis_pat_<64 hex>` и совпадающий sha256; токены уникальны', () => {
  const repoRoot = join(import.meta.dir, '../../..');
  const run = (): string => {
    const p = Bun.spawnSync(['bun', 'scripts/issue-pat.ts'], { cwd: repoRoot });
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString();
    const token = out.match(/orbis_pat_[0-9a-f]{64}/)?.[0];
    const hash = out.match(/ORBIS_PAT_HASH=([0-9a-f]{64})/)?.[1];
    expect(token).toBeDefined();
    expect(hash).toBe(sha256hex(token as string));
    return token as string;
  };
  expect(run()).not.toBe(run());
});
