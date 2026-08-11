# Браузерная аутентификация Orbis MCP — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** подключение Orbis к Claude Code сводится к `claude mcp add --transport http orbis <url>/mcp` и команде `/mcp` — вход происходит в браузере, а выданные доступы видны в настройках и отзываются одной кнопкой.

**Architecture:** Orbis становится собственным authorization server (OAuth 2.1): метаданные RFC 9728/8414, динамическая регистрация клиентов, одноразовый код с PKCE, обмен на непрозрачные токены, от которых в БД лежит только `sha256`. Экран согласия — страница SPA, потому что сессия Supabase живёт в `localStorage` веб-клиента; серверного роута под неё не нужно, `GET /oauth/authorize` уже доходит до SPA-fallback. Транспорт `/mcp` и весь конвейер тулов не меняются: после проверки токена всё идёт прежним путём через `dispatchTool`.

**Tech Stack:** Hono + Bun, drizzle-orm/postgres, `@modelcontextprotocol/sdk` 1.29.0, tRPC, React 19 + TanStack Query, bun:test (сервер) и vitest (web), pgTAP (RLS).

Спека: `docs/superpowers/specs/2026-08-10-mcp-oauth-browser-auth-design.md` (решения Р1–Р8).

## Global Constraints

- Ветка `worktree-slice4b-mcp-oauth`, работа только в worktree `/Users/birzhan/projects/orbis/.claude/worktrees/slice4b-mcp-oauth`; основное дерево не трогать.
- Комментарии, сообщения об ошибках и коммиты — по-русски, как во всём репозитории.
- Полный прогон — `bun run test` из корня; голый `bun test` из корня **зависает**. Один серверный файл — `bun test --env-file apps/server/.env <путь>` (без `--env-file` тесты не видят `DATABASE_URL`).
- `bun run lint` — отдельным вызовом, код возврата снимать без пайпа (пайп подменяет код возврата).
- Серверные сьюты делят локальную базу с другими сессиями: перед прогоном убедиться, что чужой прогон не идёт.
- Префиксы токенов: `orbis_at_` (access), `orbis_rt_` (refresh), `orbis_ac_` (код), `orbis_pat_` (PAT); тело — 64 hex-символа. В БД хранится только `sha256` в hex.
- Сроки: access — 3600 секунд, refresh — 30 дней, код — 60 секунд. PKCE — только `S256`.
- Новые серверные роуты регистрируются в `app.ts` **до** статики.
- Мутации через tRPC — только `ownerOnlyProcedure` (`apps/server/src/trpc.ts:105`).
- Коммит после каждой задачи; в сообщении — `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` и строка `Claude-Session:`.

---

### Task 1: Таблицы грантов и клиентов

**Files:**
- Modify: `apps/server/src/db/schema.ts` (добавить в конец)
- Create: `apps/server/src/db/migrations/0004_oauth_grants.sql` (генерируется drizzle-kit)
- Create: `apps/server/src/db/migrations/0005_oauth_rls.sql` (пишется руками)
- Modify: `apps/server/test/helpers.ts:35-41` (`truncateAll`)
- Test: `apps/server/test/rls/rls.pgtap.sql`

**Interfaces:**
- Produces: `oauthClients`, `agentGrants` — drizzle-таблицы; поля перечислены в шаге 3.

- [ ] **Step 1: Добавить проверки RLS в pgTAP (падающий тест)**

В `apps/server/test/rls/rls.pgtap.sql` поднять план на 4: `SELECT plan(35);`.

К фикстурам под суперпользователем (после блока `INSERT INTO entity_origins …`) добавить:

```sql
INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES
  ('pgtap-client', 'Claude Code', ARRAY['http://localhost:8080/callback']);
INSERT INTO agent_grants (id, owner_id, client_id, kind, label, access_hash) VALUES
  ('00000000-0000-7000-8000-0000000000a7', '00000000-0000-4000-8000-00000000000a',
   'pgtap-client', 'oauth', 'Claude Code', 'hash-a'),
  ('00000000-0000-7000-8000-0000000000b7', '00000000-0000-4000-8000-00000000000b',
   'pgtap-client', 'oauth', 'Claude Code', 'hash-b');
```

В блок «Как пользователь A» (после `SET LOCAL ROLE authenticated;`) добавить:

```sql
SELECT results_eq('SELECT count(*)::int FROM agent_grants', ARRAY[1],
  'A видит ровно свой грант');
SELECT results_eq(
  $$SELECT count(*)::int FROM agent_grants WHERE owner_id = '00000000-0000-4000-8000-00000000000b'$$,
  ARRAY[0], 'чужой грант невидим');
SELECT throws_ok(
  $$INSERT INTO agent_grants (id, owner_id, kind, label)
    VALUES ('00000000-0000-7000-8000-0000000000c7',
            '00000000-0000-4000-8000-00000000000b', 'pat', 'подлог')$$,
  '42501', NULL, 'грант с чужим owner_id отклоняется WITH CHECK');
```

И в проверку №1 (ENABLE+FORCE) добавить обе таблицы в список `c.relname IN (…)`, а ожидание поднять с `8` до `10`.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `bun run test:rls`
Expected: FAIL — `psql` завершится ошибкой `relation "oauth_clients" does not exist`.

- [ ] **Step 3: Описать таблицы в схеме**

В конец `apps/server/src/db/schema.ts`:

```ts
// §9.3 (D34): регистрации внешних агентов (DCR) и выданные им доступы.
// Девятая и десятая таблицы — PRD §4 расширен решением D34.
export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name').notNull(),
  redirectUris: text('redirect_uris').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Одна строка — весь жизненный цикл доступа: выданный код, текущий access и refresh.
// Код и токены хранятся ТОЛЬКО хешем (sha256 hex) — контракт hash-only §9.3.
export const agentGrants = pgTable(
  'agent_grants',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    // NULL у PAT: у headless-доступа нет зарегистрированного клиента
    clientId: text('client_id').references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // oauth | pat
    label: text('label').notNull(),
    scope: text('scope').notNull().default('full'), // Р6: значение пока одно
    codeHash: text('code_hash'),
    codeChallenge: text('code_challenge'),
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
    codeUsedAt: timestamp('code_used_at', { withTimezone: true }),
    redirectUri: text('redirect_uri'),
    accessHash: text('access_hash'),
    // NULL у PAT: заголовочный доступ не истекает, отзывается строкой
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
    refreshHash: text('refresh_hash'),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('agent_grants_access_hash').on(t.accessHash),
    uniqueIndex('agent_grants_refresh_hash').on(t.refreshHash),
    uniqueIndex('agent_grants_code_hash').on(t.codeHash),
    index('agent_grants_owner').on(t.ownerId),
    check('agent_grants_kind', sql`${t.kind} IN ('oauth','pat')`),
  ],
);
```

`index` добавить в импорт из `drizzle-orm/pg-core` (`uniqueIndex` и `check` там уже есть).

- [ ] **Step 4: Сгенерировать миграцию**

Run: `cd apps/server && bun run db:generate`
Expected: появился `src/db/migrations/0004_*.sql` и запись в `meta/_journal.json`. Если drizzle дал файлу случайное имя — переименовать файл и `tag` в журнале в `0004_oauth_grants`.

- [ ] **Step 5: Написать миграцию RLS руками**

Создать `apps/server/src/db/migrations/0005_oauth_rls.sql`:

```sql
-- 0005_oauth_rls.sql
-- RLS для таблиц §9.3 (D34). Особенность против остальных восьми таблиц:
-- аутентификация ищет грант по хешу ДО того, как владелец известен (withIdentity
-- ставит identity только когда владелец уже есть), поэтому политик две —
-- владельцу под authenticated его строки, серверной роли orbis_app полный доступ
-- для лукапа, отметки last_used_at и регистрации клиентов (клиент на момент DCR ничей).
ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE oauth_clients FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_owns_row ON agent_grants FOR ALL TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
-- Клиенты DCR не принадлежат никому: владелец видит их только через свой грант,
-- поэтому под authenticated таблица закрыта целиком (политики для этой роли нет).
CREATE POLICY server_manages_grants ON agent_grants FOR ALL TO orbis_app
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY server_manages_clients ON oauth_clients FOR ALL TO orbis_app
  USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_grants, oauth_clients TO orbis_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_grants TO authenticated;
```

Дописать запись в `apps/server/src/db/migrations/meta/_journal.json` по образцу предыдущих (`idx: 5`, `tag: "0005_oauth_rls"`, `version: "7"`, `breakpoints: true`, `when` — текущий timestamp в миллисекундах).

- [ ] **Step 6: Накатить миграции и прогнать RLS**

Run: `cd apps/server && DATABASE_URL=$DATABASE_URL_ADMIN bun run db:migrate`, затем из корня `bun run test:rls`
Expected: PASS, 35 из 35.

- [ ] **Step 7: Добавить новые таблицы в зачистку между сьютами**

В `apps/server/test/helpers.ts` в `truncateAll` дописать таблицы в тот же `TRUNCATE`:

```ts
  await db.execute(sql`TRUNCATE entities, relations, user_settings, chat_threads,
    chat_messages, ai_usage, entity_origins, agent_grants, oauth_clients RESTART IDENTITY CASCADE`);
```

- [ ] **Step 8: Убедиться, что существующие сьюты не сломались**

Run: `bun run test`
Expected: столько же зелёных, сколько было до задачи (848), без новых падений. Перф-тест под нагрузкой флакует — при его падении перепроверить одиночным прогоном `bun test --env-file apps/server/.env apps/server/src/perf.test.ts`.

- [ ] **Step 9: Коммит**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations apps/server/test/helpers.ts apps/server/test/rls/rls.pgtap.sql
git commit -m "feat(oauth): таблицы грантов и клиентов под RLS

Лукап по хешу идёт до identity — отсюда вторая политика для orbis_app.
pgTAP: 35 проверок." -- apps/server
```

---

### Task 2: Сырьё токенов и модуль грантов

**Files:**
- Create: `apps/server/src/oauth/tokens.ts`
- Create: `apps/server/src/oauth/errors.ts`
- Create: `apps/server/src/oauth/grants.ts`
- Test: `apps/server/src/oauth/grants.test.ts`

**Interfaces:**
- Consumes: `agentGrants`, `oauthClients` (Task 1).
- Produces:
  - `mintToken(prefix: string): string`, `hashToken(token: string): string`
  - `OAuthError` с полями `code: string`, `description: string`
  - `verifyBearer(db: Db, token: string): Promise<GrantIdentity | null>` где `GrantIdentity = { grantId: string; ownerId: string }`
  - `createAuthorizationCode(db, input: { ownerId, clientId, label, redirectUri, codeChallenge }): Promise<string>`
  - `exchangeAuthorizationCode(db, input: { code, codeVerifier, redirectUri, clientId }): Promise<TokenPair>` где `TokenPair = { accessToken: string; refreshToken: string; expiresIn: number }`
  - `rotateRefresh(db, input: { refreshToken, clientId }): Promise<TokenPair>`
  - `issuePatGrant(db, input: { ownerId, label }): Promise<string>`
  - `listGrants(db, ownerId: string): Promise<GrantSummary[]>` где `GrantSummary = { id, kind, label, createdAt, lastUsedAt, revokedAt }`
  - `revokeGrant(db, input: { ownerId, grantId }): Promise<boolean>`

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/server/src/oauth/grants.test.ts`. Обвязка — по образцу `apps/server/src/mcp/mcp.test.ts:1-30` (реальная БД, `requireEnv`, `truncateAll`):

```ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { oauthClients } from '../db/schema';
import {
  createAuthorizationCode, exchangeAuthorizationCode, issuePatGrant,
  listGrants, revokeGrant, rotateRefresh, verifyBearer,
} from './grants';

requireEnv();
const { db, client: dbClient } = appDb();
const owner = freshUserId();
const REDIRECT = 'http://localhost:8080/callback';

/** PKCE-пара по RFC 7636: challenge = base64url(sha256(verifier)). */
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function seedClient(): Promise<string> {
  await db.insert(oauthClients).values({
    clientId: 'test-client', clientName: 'Claude Code', redirectUris: [REDIRECT],
  }).onConflictDoNothing();
  return 'test-client';
}

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await dbClient.end(); });

test('код меняется на пару токенов, access пускает', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner, clientId, label: 'Claude Code', redirectUri: REDIRECT, codeChallenge: challenge,
  });
  const pair = await exchangeAuthorizationCode(db, {
    code, codeVerifier: verifier, redirectUri: REDIRECT, clientId,
  });
  expect(pair.accessToken.startsWith('orbis_at_')).toBe(true);
  expect(pair.expiresIn).toBe(3600);
  expect(await verifyBearer(db, pair.accessToken)).toMatchObject({ ownerId: owner });
});

test('код одноразовый: повторный обмен отвергнут и грант отозван', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner, clientId, label: 'Claude Code', redirectUri: REDIRECT, codeChallenge: challenge,
  });
  const pair = await exchangeAuthorizationCode(db, {
    code, codeVerifier: verifier, redirectUri: REDIRECT, clientId,
  });
  await expect(exchangeAuthorizationCode(db, {
    code, codeVerifier: verifier, redirectUri: REDIRECT, clientId,
  })).rejects.toMatchObject({ code: 'invalid_grant' });
  // Повторный код — признак перехвата: выданный по нему доступ обязан умереть
  expect(await verifyBearer(db, pair.accessToken)).toBeNull();
});

test('неверный verifier не проходит', async () => {
  const clientId = await seedClient();
  const { challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner, clientId, label: 'Claude Code', redirectUri: REDIRECT, codeChallenge: challenge,
  });
  await expect(exchangeAuthorizationCode(db, {
    code, codeVerifier: 'не тот verifier', redirectUri: REDIRECT, clientId,
  })).rejects.toMatchObject({ code: 'invalid_grant' });
});

test('refresh ротируется, старый больше не работает', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner, clientId, label: 'Claude Code', redirectUri: REDIRECT, codeChallenge: challenge,
  });
  const first = await exchangeAuthorizationCode(db, {
    code, codeVerifier: verifier, redirectUri: REDIRECT, clientId,
  });
  const second = await rotateRefresh(db, { refreshToken: first.refreshToken, clientId });
  expect(second.refreshToken).not.toBe(first.refreshToken);
  expect(await verifyBearer(db, second.accessToken)).toMatchObject({ ownerId: owner });
  expect(await verifyBearer(db, first.accessToken)).toBeNull();
  await expect(rotateRefresh(db, { refreshToken: first.refreshToken, clientId }))
    .rejects.toMatchObject({ code: 'invalid_grant' });
});

test('PAT пускает бессрочно и отзывается', async () => {
  const pat = await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  expect(pat.startsWith('orbis_pat_')).toBe(true);
  const identity = await verifyBearer(db, pat);
  expect(identity).toMatchObject({ ownerId: owner });
  expect(await revokeGrant(db, { ownerId: owner, grantId: identity!.grantId })).toBe(true);
  expect(await verifyBearer(db, pat)).toBeNull();
});

test('чужой владелец не отзывает грант', async () => {
  const pat = await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  const identity = await verifyBearer(db, pat);
  expect(await revokeGrant(db, { ownerId: freshUserId(), grantId: identity!.grantId })).toBe(false);
  expect(await verifyBearer(db, pat)).not.toBeNull();
});

test('listGrants отдаёт свои гранты и не отдаёт хеши', async () => {
  await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  await issuePatGrant(db, { ownerId: freshUserId(), label: 'чужой' });
  const grants = await listGrants(db, owner);
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ kind: 'pat', label: 'CI' });
  expect(JSON.stringify(grants)).not.toContain('hash');
});

test('мусорный токен и токен без префикса отвергаются', async () => {
  expect(await verifyBearer(db, 'orbis_at_' + 'ff'.repeat(32))).toBeNull();
  expect(await verifyBearer(db, 'eyJhbGciOiJIUzI1NiJ9.подделка')).toBeNull();
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bun test --env-file apps/server/.env apps/server/src/oauth/grants.test.ts`
Expected: FAIL — модуль `./grants` не найден.

- [ ] **Step 3: Написать сырьё токенов**

`apps/server/src/oauth/tokens.ts`:

```ts
// apps/server/src/oauth/tokens.ts
// Сырьё токенов §9.3: генерация и хеширование. Отдельный модуль от grants.ts,
// потому что этим же кодом пользуется scripts/issue-pat.ts, которому база грантов
// не нужна — ему нужен только формат.
import { createHash, randomBytes } from 'node:crypto';

export const ACCESS_PREFIX = 'orbis_at_';
export const REFRESH_PREFIX = 'orbis_rt_';
export const CODE_PREFIX = 'orbis_ac_';
export const PAT_PREFIX = 'orbis_pat_';

/** Все префиксы, которые /mcp принимает как Bearer (JWT Supabase — не отсюда). */
export const BEARER_PREFIXES = [ACCESS_PREFIX, PAT_PREFIX] as const;

export const ACCESS_TTL_SECONDS = 3600;
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
export const CODE_TTL_SECONDS = 60;

/** Префикс + 32 случайных байта в hex. 256 бит энтропии — перебор бессмыслен. */
export function mintToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('hex')}`;
}

/** Единственная форма, в которой токен попадает в базу. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

- [ ] **Step 4: Написать ошибки**

`apps/server/src/oauth/errors.ts`:

```ts
// apps/server/src/oauth/errors.ts
// Ошибки OAuth-поверхности: коды — из OAuth 2.1 (invalid_grant, invalid_request,
// invalid_client, invalid_target, unsupported_grant_type), форма ответа —
// { error, error_description } по спеке. Структурная форма { error: { code } },
// которой отвечают /mcp и tRPC, здесь НЕ применяется: это другой протокол,
// и клиент разбирает именно спецификационные поля.
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(`${code}: ${description}`);
    this.name = 'OAuthError';
  }

  toResponseBody(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
```

- [ ] **Step 5: Написать модуль грантов**

`apps/server/src/oauth/grants.ts` — ключевые части:

```ts
// apps/server/src/oauth/grants.ts
// Жизненный цикл доступа внешнего агента (§9.3, D34): выдача кода, обмен на пару
// токенов, ротация refresh, лукап по хешу, отзыв. Всё под ролью orbis_app (политика
// server_manages_grants): аутентификация происходит ДО того, как владелец известен,
// поэтому withIdentity здесь неприменим — RLS скоупит эти запросы не по auth.uid(),
// а самим условием на хеш.
import { createHash } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { newId } from '@orbis/shared';
import type { Db } from '../db/client';
import { agentGrants } from '../db/schema';
import { OAuthError } from './errors';
import {
  ACCESS_PREFIX, ACCESS_TTL_SECONDS, CODE_PREFIX, CODE_TTL_SECONDS,
  hashToken, mintToken, PAT_PREFIX, REFRESH_PREFIX, REFRESH_TTL_SECONDS,
} from './tokens';

export interface GrantIdentity {
  grantId: string;
  ownerId: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface GrantSummary {
  id: string;
  kind: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const secondsFromNow = (s: number) => new Date(Date.now() + s * 1000);

/**
 * Bearer → владелец. Живым считается неотозванный грант, у которого срок либо не
 * наступил, либо не задан вовсе (PAT бессрочен — отзывается строкой, не временем).
 * Отметка last_used_at питает экран настроек; она же делает видимым доступ, о котором
 * владелец забыл.
 */
export async function verifyBearer(db: Db, token: string): Promise<GrantIdentity | null> {
  if (!token.startsWith(ACCESS_PREFIX) && !token.startsWith(PAT_PREFIX)) return null;
  const rows = await db
    .update(agentGrants)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(agentGrants.accessHash, hashToken(token)),
        isNull(agentGrants.revokedAt),
        or(isNull(agentGrants.accessExpiresAt), gt(agentGrants.accessExpiresAt, new Date())),
      ),
    )
    .returning({ id: agentGrants.id, ownerId: agentGrants.ownerId });
  const row = rows[0];
  return row ? { grantId: row.id, ownerId: row.ownerId } : null;
}

/** Согласие владельца: строка гранта с одноразовым кодом, токенов ещё нет. */
export async function createAuthorizationCode(
  db: Db,
  input: { ownerId: string; clientId: string; label: string; redirectUri: string; codeChallenge: string },
): Promise<string> {
  const code = mintToken(CODE_PREFIX);
  await db.insert(agentGrants).values({
    id: newId(),
    ownerId: input.ownerId,
    clientId: input.clientId,
    kind: 'oauth',
    label: input.label,
    codeHash: hashToken(code),
    codeChallenge: input.codeChallenge,
    codeExpiresAt: secondsFromNow(CODE_TTL_SECONDS),
    redirectUri: input.redirectUri,
  });
  return code;
}

/**
 * Обмен кода на пару токенов. Одноразовость — не проверкой в коде, а самим UPDATE
 * с условием `code_used_at IS NULL`: двум одновременным обменам строку отдаст ровно
 * один. Предъявленный повторно код — признак перехвата (OAuth 2.1 §7.5), поэтому
 * второй обмен не просто отказывает, а отзывает уже выданный по этому коду доступ.
 */
export async function exchangeAuthorizationCode(
  db: Db,
  input: { code: string; codeVerifier: string; redirectUri: string; clientId: string },
): Promise<TokenPair> {
  const codeHash = hashToken(input.code);
  const existing = await db
    .select()
    .from(agentGrants)
    .where(eq(agentGrants.codeHash, codeHash))
    .limit(1);
  const grant = existing[0];
  if (!grant) throw new OAuthError('invalid_grant', 'код неизвестен');

  if (grant.codeUsedAt !== null) {
    await db.update(agentGrants).set({ revokedAt: new Date() }).where(eq(agentGrants.id, grant.id));
    throw new OAuthError('invalid_grant', 'код уже использован — выданный по нему доступ отозван');
  }
  if (grant.clientId !== input.clientId) throw new OAuthError('invalid_grant', 'код выдан другому клиенту');
  if (grant.redirectUri !== input.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri не совпадает');
  if (grant.codeExpiresAt !== null && grant.codeExpiresAt.getTime() <= Date.now()) {
    throw new OAuthError('invalid_grant', 'код просрочен');
  }
  const challenge = createHash('sha256').update(input.codeVerifier).digest('base64url');
  if (challenge !== grant.codeChallenge) throw new OAuthError('invalid_grant', 'PKCE не сошёлся');

  const pair = mintPair();
  const claimed = await db
    .update(agentGrants)
    .set({ codeUsedAt: new Date(), ...pairColumns(pair) })
    .where(and(eq(agentGrants.id, grant.id), isNull(agentGrants.codeUsedAt)))
    .returning({ id: agentGrants.id });
  if (claimed.length === 0) throw new OAuthError('invalid_grant', 'код уже использован');
  return pair;
}

/**
 * Ротация refresh (OAuth 2.1 требует её для публичных клиентов). Предъявленный
 * повторно старый refresh — тот же признак перехвата, что и повторный код: грант
 * отзывается целиком.
 */
export async function rotateRefresh(
  db: Db,
  input: { refreshToken: string; clientId: string },
): Promise<TokenPair> {
  const pair = mintPair();
  const rows = await db
    .update(agentGrants)
    .set(pairColumns(pair))
    .where(
      and(
        eq(agentGrants.refreshHash, hashToken(input.refreshToken)),
        eq(agentGrants.clientId, input.clientId),
        isNull(agentGrants.revokedAt),
        gt(agentGrants.refreshExpiresAt, new Date()),
      ),
    )
    .returning({ id: agentGrants.id });
  if (rows.length === 0) {
    // Токен мог быть уже ротирован — тогда его хеша в живой строке нет. Ищем
    // отозванный/просроченный след и, если он есть, гасим грант.
    await db
      .update(agentGrants)
      .set({ revokedAt: new Date() })
      .where(eq(agentGrants.refreshHash, hashToken(input.refreshToken)));
    throw new OAuthError('invalid_grant', 'refresh-токен недействителен');
  }
  return pair;
}

/** Headless-доступ (Р4): та же таблица, без клиента и без срока. */
export async function issuePatGrant(
  db: Db,
  input: { ownerId: string; label: string },
): Promise<string> {
  const token = mintToken(PAT_PREFIX);
  await db.insert(agentGrants).values({
    id: newId(),
    ownerId: input.ownerId,
    kind: 'pat',
    label: input.label,
    accessHash: hashToken(token),
  });
  return token;
}

/** Для экрана настроек: ни одного хеша наружу. */
export async function listGrants(db: Db, ownerId: string): Promise<GrantSummary[]> {
  return db
    .select({
      id: agentGrants.id,
      kind: agentGrants.kind,
      label: agentGrants.label,
      createdAt: agentGrants.createdAt,
      lastUsedAt: agentGrants.lastUsedAt,
      revokedAt: agentGrants.revokedAt,
    })
    .from(agentGrants)
    .where(eq(agentGrants.ownerId, ownerId))
    .orderBy(sql`${agentGrants.createdAt} DESC`);
}

/** Отзыв: условие на owner_id — вторая линия к RLS, а не замена ей. */
export async function revokeGrant(
  db: Db,
  input: { ownerId: string; grantId: string },
): Promise<boolean> {
  const rows = await db
    .update(agentGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentGrants.id, input.grantId), eq(agentGrants.ownerId, input.ownerId)))
    .returning({ id: agentGrants.id });
  return rows.length > 0;
}

function mintPair(): TokenPair {
  return {
    accessToken: mintToken(ACCESS_PREFIX),
    refreshToken: mintToken(REFRESH_PREFIX),
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

function pairColumns(pair: TokenPair) {
  return {
    accessHash: hashToken(pair.accessToken),
    accessExpiresAt: secondsFromNow(ACCESS_TTL_SECONDS),
    refreshHash: hashToken(pair.refreshToken),
    refreshExpiresAt: secondsFromNow(REFRESH_TTL_SECONDS),
  };
}
```

- [ ] **Step 6: Прогнать тесты**

Run: `bun test --env-file apps/server/.env apps/server/src/oauth/grants.test.ts`
Expected: PASS, 8 из 8.

- [ ] **Step 7: Коммит**

```bash
git commit -m "feat(oauth): гранты — выдача кода, обмен, ротация, отзыв

Одноразовость кода держит UPDATE с условием code_used_at IS NULL, а не
проверка в коде: гонка двух обменов отдаёт строку ровно одному. Повторный
код и повторный refresh гасят грант целиком — это признак перехвата." -- apps/server/src/oauth
```

---

### Task 3: `/mcp` принимает токены из таблицы; PAT уезжает из env

**Files:**
- Modify: `apps/server/src/mcp/transport.ts:65-83`
- Delete: `apps/server/src/pat.ts`, `apps/server/src/pat.test.ts`
- Modify: `scripts/issue-pat.ts`
- Modify: `apps/server/src/mcp/mcp.test.ts:26-76` (обвязка: токен выдаётся в базу, а не в env)

**Interfaces:**
- Consumes: `verifyBearer`, `issuePatGrant` (Task 2).

- [ ] **Step 1: Переписать обвязку теста MCP под таблицу (падающий тест)**

В `apps/server/src/mcp/mcp.test.ts` убрать блок `savedEnv`/`process.env.ORBIS_PAT_*` и получать токен из базы:

```ts
import { issuePatGrant } from '../oauth/grants';
import { revokeGrant, verifyBearer } from '../oauth/grants';

let TOKEN: string;

beforeAll(async () => {
  await truncateAll();
  TOKEN = await issuePatGrant(db, { ownerId: owner, label: 'тестовый агент' });
  // …дальше без изменений: поднятие main и gated
});
```

Добавить два новых теста в блок «PAT-аутентификация»:

```ts
test('отозванный токен больше не пускает', async () => {
  const token = await issuePatGrant(db, { ownerId: owner, label: 'на отзыв' });
  const identity = await verifyBearer(db, token);
  await revokeGrant(db, { ownerId: owner, grantId: identity!.grantId });
  const res = await fetch(mainUrl(), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(res.status).toBe(401);
});

test('401 указывает, где искать метаданные ресурса (RFC 9728)', async () => {
  const res = await fetch(mainUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bun test --env-file apps/server/.env apps/server/src/mcp/mcp.test.ts`
Expected: FAIL — токен из базы не аутентифицирует (транспорт всё ещё смотрит в env), `www-authenticate` без `resource_metadata`.

- [ ] **Step 3: Перевести транспорт на гранты**

В `apps/server/src/mcp/transport.ts` заменить блок PAT-проверки:

```ts
    // Аутентификация ДО ЛЮБОЙ MCP-логики (§9.3, fail-closed): /mcp — эндпоинт ТОЛЬКО
    // для внешних агентов. Принимаются два вида Bearer — access-токен OAuth (orbis_at_)
    // и headless-PAT (orbis_pat_); оба ищутся по sha256 в agent_grants. Supabase JWT
    // здесь не аутентифицирует: владельческие поверхности ходят в tRPC, смешение
    // транспортов не даёт обойти атрибуцию 'agent'.
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const identity = token === null ? null : await verifyBearer(deps.db, token);
    if (identity === null) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'требуется действительный токен агента' } },
        401,
        {
          // RFC 9728 §5.1: клиент отсюда узнаёт, где лежат метаданные ресурса,
          // и дальше сам находит authorization server — это и есть вход через браузер
          'WWW-Authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(c)}"`,
        },
      );
    }
```

и ниже `makeMcpServer(deps, identity.ownerId)`. Импорт `verifyPat`/`PAT_PREFIX` из `../pat` снять, добавить `verifyBearer` из `../oauth/grants` и `protectedResourceMetadataUrl` из `../oauth/metadata` (создаётся в Task 4 — до неё оставить локальную функцию, возвращающую `new URL('/.well-known/oauth-protected-resource', c.req.url).href`, и заменить её на импорт в Task 4).

- [ ] **Step 4: Удалить env-путь PAT**

```bash
git rm apps/server/src/pat.ts apps/server/src/pat.test.ts
```

Проверить, что `verifyPat` больше нигде не используется: `rg -n "verifyPat|ORBIS_PAT_" apps/server/src scripts` — должно остаться пусто (кроме `scripts/issue-pat.ts`, который правится следующим шагом).

- [ ] **Step 5: Перевести выпуск PAT на базу**

`scripts/issue-pat.ts` целиком:

```ts
// scripts/issue-pat.ts — выдача headless-токена внешнего агента (§9.3, Р4).
// С переездом на таблицу грантов (D34) скрипт пишет строку в базу сам: хеш в
// окружении больше не живёт, отзыв делается в настройках, а не передеплоем.
import { makeDb } from '../apps/server/src/db/client';
import { issuePatGrant } from '../apps/server/src/oauth/grants';

const ownerId = process.argv[2];
const label = process.argv[3] ?? 'headless-агент';
if (!ownerId) {
  console.error('Использование: bun scripts/issue-pat.ts <owner-uuid> [метка]');
  console.error('owner-uuid — из Supabase → Authentication → Users');
  process.exit(1);
}

const { db, client } = makeDb({ max: 1 });
try {
  const token = await issuePatGrant(db, { ownerId, label });
  console.log('Токен выдан. Показывается ОДИН раз — сохрани его в конфиге агента:');
  console.log(`  ${token}`);
  console.log('');
  console.log('Подключение:');
  console.log(`  claude mcp add --transport http orbis <url>/mcp --header "Authorization: Bearer ${token}"`);
  console.log('Отзыв — в Настройки → Агенты (или пометить revoked_at в agent_grants).');
} finally {
  await client.end();
}
```

- [ ] **Step 6: Прогнать тесты MCP**

Run: `bun test --env-file apps/server/.env apps/server/src/mcp/mcp.test.ts`
Expected: PASS, включая два новых теста.

- [ ] **Step 7: Коммит**

```bash
git commit -m "feat(oauth): /mcp пускает по гранту из таблицы, PAT уехал из env

401 теперь несёт resource_metadata — клиент отсюда сам находит
authorization server. Отзыв стал строкой в базе вместо передеплоя." -- apps/server scripts
```

---

### Task 4: Метаданные ресурса и authorization server

**Files:**
- Create: `apps/server/src/oauth/metadata.ts`
- Modify: `apps/server/src/app.ts:82-92` (роуты до статики)
- Modify: `apps/server/src/mcp/transport.ts` (заменить временную функцию на импорт)
- Test: `apps/server/src/oauth/metadata.test.ts`

**Interfaces:**
- Produces:
  - `publicOrigin(c: Context): string` — из `ORBIS_PUBLIC_URL`, иначе из запроса
  - `canonicalResource(c: Context): string` — `<origin>/mcp`
  - `protectedResourceMetadataUrl(c: Context): string`
  - `mountOAuthMetadata(app: Hono): void` — вешает три GET-роута

- [ ] **Step 1: Написать падающие тесты**

`apps/server/src/oauth/metadata.test.ts`:

```ts
import { afterEach, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { mountOAuthMetadata } from './metadata';

const saved = process.env.ORBIS_PUBLIC_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.ORBIS_PUBLIC_URL;
  else process.env.ORBIS_PUBLIC_URL = saved;
});

function app() {
  const a = new Hono();
  mountOAuthMetadata(a);
  return a;
}

test('метаданные ресурса называют канонический URI и наш AS', async () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com';
  const res = await app().request('/.well-known/oauth-protected-resource');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.resource).toBe('https://orbis.example.com/mcp');
  expect(body.authorization_servers).toEqual(['https://orbis.example.com']);
});

test('path-aware адрес метаданных ресурса отдаёт то же самое (RFC 9728 §3.1)', async () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com';
  const res = await app().request('/.well-known/oauth-protected-resource/mcp');
  expect((await res.json()).resource).toBe('https://orbis.example.com/mcp');
});

test('метаданные AS перечисляют эндпоинты, S256 и DCR', async () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com';
  const body = await (await app().request('/.well-known/oauth-authorization-server')).json();
  expect(body.issuer).toBe('https://orbis.example.com');
  expect(body.authorization_endpoint).toBe('https://orbis.example.com/oauth/authorize');
  expect(body.token_endpoint).toBe('https://orbis.example.com/oauth/token');
  expect(body.registration_endpoint).toBe('https://orbis.example.com/oauth/register');
  expect(body.code_challenge_methods_supported).toEqual(['S256']);
  expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
});

test('без ORBIS_PUBLIC_URL база берётся из запроса (локальный стенд)', async () => {
  delete process.env.ORBIS_PUBLIC_URL;
  const body = await (await app().request('http://127.0.0.1:3020/.well-known/oauth-protected-resource')).json();
  expect(body.resource).toBe('http://127.0.0.1:3020/mcp');
});

test('хвостовой слэш в ORBIS_PUBLIC_URL не даёт двойного слэша', async () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com/';
  const body = await (await app().request('/.well-known/oauth-protected-resource')).json();
  expect(body.resource).toBe('https://orbis.example.com/mcp');
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bun test apps/server/src/oauth/metadata.test.ts`
Expected: FAIL — модуля нет. (Этому файлу база не нужна, `--env-file` не обязателен.)

- [ ] **Step 3: Написать модуль метаданных**

`apps/server/src/oauth/metadata.ts`:

```ts
// apps/server/src/oauth/metadata.ts
// Метаданные, по которым MCP-клиент находит вход (спека MCP 2025-06-18):
// RFC 9728 для ресурса и RFC 8414 для authorization server. Оба документа —
// публичные и неаутентифицированные по построению: это точка входа ДО всякого токена.
import type { Context, Hono } from 'hono';

/**
 * База всех абсолютных URL. В production берётся ТОЛЬКО из ORBIS_PUBLIC_URL:
 * подменённый заголовок Host увёл бы клиента на чужой authorization server прямо
 * через наши же метаданные. На локальном стенде переменной нет — там база берётся
 * из запроса, и это безопасно: ни владельца, ни данных там нет.
 */
export function publicOrigin(c: Context): string {
  const configured = process.env.ORBIS_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ORBIS_PUBLIC_URL обязателен в production (метаданные OAuth)');
  }
  return new URL(c.req.url).origin;
}

/** Канонический URI ресурса (RFC 8707 §2): без хвостового слэша и без фрагмента. */
export function canonicalResource(c: Context): string {
  return `${publicOrigin(c)}/mcp`;
}

export function protectedResourceMetadataUrl(c: Context): string {
  return `${publicOrigin(c)}/.well-known/oauth-protected-resource`;
}

export function mountOAuthMetadata(app: Hono): void {
  const resource = (c: Context) =>
    c.json({
      resource: canonicalResource(c),
      authorization_servers: [publicOrigin(c)],
      bearer_methods_supported: ['header'],
      resource_name: 'Orbis',
    });

  app.get('/.well-known/oauth-protected-resource', resource);
  // RFC 9728 §3.1 разрешает вставлять путь ресурса в адрес метаданных; клиенты
  // пробуют оба варианта, поэтому отдаём и path-aware форму.
  app.get('/.well-known/oauth-protected-resource/mcp', resource);

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const origin = publicOrigin(c);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // plain намеренно не поддержан: RFC его допускает, мы — нет
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['full'],
    });
  });
}
```

- [ ] **Step 4: Смонтировать роуты и убрать временную функцию из транспорта**

В `apps/server/src/app.ts` сразу после строки с `app.all('/mcp', …)`:

```ts
  // Метаданные OAuth (§9.3): публичные, до статики — иначе их съест SPA-fallback
  mountOAuthMetadata(app);
```

В `apps/server/src/mcp/transport.ts` заменить локальную функцию на импорт
`protectedResourceMetadataUrl` из `../oauth/metadata`.

- [ ] **Step 5: Прогнать тесты**

Run: `bun test apps/server/src/oauth/metadata.test.ts` и `bun test --env-file apps/server/.env apps/server/src/mcp/mcp.test.ts`
Expected: PASS в обоих.

- [ ] **Step 6: Коммит**

```bash
git commit -m "feat(oauth): метаданные ресурса и authorization server

ORBIS_PUBLIC_URL обязателен в production: подменённый Host увёл бы клиента
на чужой AS прямо через наши метаданные." -- apps/server
```

---

### Task 5: Динамическая регистрация клиентов

**Files:**
- Create: `apps/server/src/oauth/register.ts`
- Modify: `apps/server/src/app.ts` (роут `POST /oauth/register`)
- Test: `apps/server/src/oauth/register.test.ts`

**Interfaces:**
- Produces: `registerClient(db: Db, input: { clientName: string; redirectUris: string[] }): Promise<{ clientId: string }>`, `makeRegisterHandler(deps: { db: Db })` — Hono-хендлер.
- Consumes: `oauthClients` (Task 1), `OAuthError` (Task 2).

- [ ] **Step 1: Написать падающие тесты**

`apps/server/src/oauth/register.test.ts` — обвязка как в `grants.test.ts` (реальная БД):

```ts
test('регистрация возвращает client_id и запоминает redirect_uris', async () => {
  const res = await post({ client_name: 'Claude Code', redirect_uris: ['http://localhost:8080/callback'] });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(typeof body.client_id).toBe('string');
  expect(body.redirect_uris).toEqual(['http://localhost:8080/callback']);
  expect(body.token_endpoint_auth_method).toBe('none');
});

test('redirect_uri не localhost и не https отвергается', async () => {
  const res = await post({ client_name: 'X', redirect_uris: ['http://evil.example.com/cb'] });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('invalid_redirect_uri');
});

test('пустой список redirect_uris отвергается', async () => {
  const res = await post({ client_name: 'X', redirect_uris: [] });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('invalid_client_metadata');
});

test('регистрации ограничены потолком в сутки', async () => {
  for (let i = 0; i < 50; i++) {
    await post({ client_name: `клиент ${i}`, redirect_uris: ['http://localhost:8080/callback'] });
  }
  const res = await post({ client_name: 'лишний', redirect_uris: ['http://localhost:8080/callback'] });
  expect(res.status).toBe(429);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bun test --env-file apps/server/.env apps/server/src/oauth/register.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Написать регистрацию**

`apps/server/src/oauth/register.ts`:

```ts
// apps/server/src/oauth/register.ts
// Динамическая регистрация клиентов (RFC 7591). Эндпоинт публичный по построению —
// именно он избавляет владельца от ручного client_id. Регистрация сама по себе не даёт
// ничего: без согласия владельца на /oauth/authorize клиент не получит ни кода, ни
// токена. Единственный реальный риск — засорение таблицы, поэтому стоит суточный потолок.
import { randomBytes } from 'node:crypto';
import { count, gte } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Db } from '../db/client';
import { oauthClients } from '../db/schema';

/** Потолок регистраций в сутки на весь сервис: у одного владельца агентов единицы. */
export const MAX_REGISTRATIONS_PER_DAY = 50;

/**
 * Куда разрешено возвращать код. Локальная петля — это Claude Code и родня
 * (они слушают http://localhost:PORT/callback), https — размещённые клиенты.
 * Всё остальное — способ увести код на чужой хост.
 */
function isAllowedRedirect(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
}

export function makeRegisterHandler(deps: { db: Db }) {
  return async (c: Context): Promise<Response> => {
    const body = (await c.req.json().catch(() => null)) as
      | { client_name?: unknown; redirect_uris?: unknown }
      | null;
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    const name = typeof body?.client_name === 'string' && body.client_name.trim() ? body.client_name.trim() : 'внешний агент';

    if (uris.length === 0) {
      return c.json({ error: 'invalid_client_metadata', error_description: 'redirect_uris обязателен' }, 400);
    }
    if (!uris.every(isAllowedRedirect)) {
      return c.json(
        { error: 'invalid_redirect_uri', error_description: 'разрешены только https и локальная петля' },
        400,
      );
    }

    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [{ value: recent }] = await deps.db
      .select({ value: count() })
      .from(oauthClients)
      .where(gte(oauthClients.createdAt, since));
    if (recent >= MAX_REGISTRATIONS_PER_DAY) {
      return c.json({ error: 'invalid_client_metadata', error_description: 'слишком много регистраций' }, 429);
    }

    const clientId = randomBytes(16).toString('hex');
    await deps.db.insert(oauthClients).values({ clientId, clientName: name, redirectUris: uris });
    return c.json(
      {
        client_id: clientId,
        client_name: name,
        redirect_uris: uris,
        // Публичный клиент: секрета нет, защита обмена — на PKCE
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    );
  };
}
```

В `apps/server/src/app.ts` рядом с метаданными: `app.post('/oauth/register', makeRegisterHandler({ db }));`

- [ ] **Step 4: Прогнать тесты**

Run: `bun test --env-file apps/server/.env apps/server/src/oauth/register.test.ts`
Expected: PASS, 4 из 4.

- [ ] **Step 5: Коммит**

```bash
git commit -m "feat(oauth): динамическая регистрация клиентов с потолком в сутки

Регистрация ничего не даёт без согласия владельца, поэтому единственная
защита, которая тут нужна, — от засорения таблицы." -- apps/server
```

---

### Task 6: Эндпоинт обмена токенов

**Files:**
- Create: `apps/server/src/oauth/token-endpoint.ts`
- Modify: `apps/server/src/app.ts` (роут `POST /oauth/token`)
- Test: `apps/server/src/oauth/token-endpoint.test.ts`

**Interfaces:**
- Consumes: `exchangeAuthorizationCode`, `rotateRefresh`, `OAuthError` (Task 2).
- Produces: `makeTokenHandler(deps: { db: Db })` — Hono-хендлер.

- [ ] **Step 1: Написать падающие тесты**

`apps/server/src/oauth/token-endpoint.test.ts` — форма запроса `application/x-www-form-urlencoded`, как требует OAuth:

```ts
test('authorization_code отдаёт пару токенов в форме OAuth', async () => {
  const { code, verifier, clientId } = await seedCode();
  const res = await postForm({
    grant_type: 'authorization_code', code, code_verifier: verifier,
    redirect_uri: REDIRECT, client_id: clientId, resource: `${ORIGIN}/mcp`,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.token_type).toBe('Bearer');
  expect(body.expires_in).toBe(3600);
  expect(typeof body.access_token).toBe('string');
  expect(typeof body.refresh_token).toBe('string');
  expect(res.headers.get('cache-control')).toBe('no-store');
});

test('чужой resource отвергается как invalid_target', async () => {
  const { code, verifier, clientId } = await seedCode();
  const res = await postForm({
    grant_type: 'authorization_code', code, code_verifier: verifier,
    redirect_uri: REDIRECT, client_id: clientId, resource: 'https://evil.example.com/mcp',
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('invalid_target');
});

test('неизвестный grant_type отвергается', async () => {
  const res = await postForm({ grant_type: 'password', username: 'a', password: 'b' });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('unsupported_grant_type');
});

test('refresh_token выдаёт новую пару', async () => {
  const first = await exchangeSeeded();
  const res = await postForm({
    grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: first.clientId,
  });
  expect(res.status).toBe(200);
  expect((await res.json()).access_token).not.toBe(first.access_token);
});

test('ошибка домена не течёт стеком — только форма OAuth', async () => {
  const res = await postForm({
    grant_type: 'authorization_code', code: 'orbis_ac_' + 'ab'.repeat(32),
    code_verifier: 'x', redirect_uri: REDIRECT, client_id: 'нет такого',
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('invalid_grant');
  expect(JSON.stringify(body)).not.toContain('at ');
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bun test --env-file apps/server/.env apps/server/src/oauth/token-endpoint.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Написать эндпоинт**

`apps/server/src/oauth/token-endpoint.ts`:

```ts
// apps/server/src/oauth/token-endpoint.ts
// POST /oauth/token — единственная точка, где код и refresh превращаются в доступ.
// Тело — application/x-www-form-urlencoded (OAuth 2.1 §4.1.3), ответ — no-store:
// токены не должны осесть ни в одном кэше по пути.
import type { Context } from 'hono';
import type { Db } from '../db/client';
import { OAuthError } from './errors';
import { exchangeAuthorizationCode, rotateRefresh } from './grants';
import { canonicalResource } from './metadata';

export function makeTokenHandler(deps: { db: Db }) {
  return async (c: Context): Promise<Response> => {
    try {
      const form = await c.req.parseBody();
      const field = (k: string): string => (typeof form[k] === 'string' ? (form[k] as string) : '');

      // RFC 8707: клиент обязан назвать ресурс, для которого просит токен. Пустое
      // значение терпим (не все клиенты его шлют), чужое — нет: токен, выписанный
      // «для другого сервера», у нас не действует по определению.
      const resource = field('resource');
      if (resource && resource.replace(/\/+$/, '') !== canonicalResource(c)) {
        throw new OAuthError('invalid_target', 'токен запрошен для другого ресурса');
      }

      const grantType = field('grant_type');
      const clientId = field('client_id');
      if (!clientId) throw new OAuthError('invalid_client', 'client_id обязателен');

      const pair =
        grantType === 'authorization_code'
          ? await exchangeAuthorizationCode(deps.db, {
              code: field('code'),
              codeVerifier: field('code_verifier'),
              redirectUri: field('redirect_uri'),
              clientId,
            })
          : grantType === 'refresh_token'
            ? await rotateRefresh(deps.db, { refreshToken: field('refresh_token'), clientId })
            : (() => {
                throw new OAuthError('unsupported_grant_type', `grant_type «${grantType}» не поддержан`);
              })();

      return c.json(
        {
          access_token: pair.accessToken,
          token_type: 'Bearer',
          expires_in: pair.expiresIn,
          refresh_token: pair.refreshToken,
          scope: 'full',
        },
        200,
        { 'Cache-Control': 'no-store' },
      );
    } catch (e) {
      if (e instanceof OAuthError) return c.json(e.toResponseBody(), e.status as 400);
      // Инфраструктурный сбой наружу не течёт: клиенту — обезличенная ошибка,
      // оригинал — в серверный лог (та же гигиена, что у /mcp).
      console.error('[oauth] сбой обмена токена:', e);
      return c.json({ error: 'server_error', error_description: 'внутренняя ошибка сервера' }, 500);
    }
  };
}
```

В `apps/server/src/app.ts`: `app.post('/oauth/token', makeTokenHandler({ db }));`

- [ ] **Step 4: Прогнать тесты**

Run: `bun test --env-file apps/server/.env apps/server/src/oauth/token-endpoint.test.ts`
Expected: PASS, 5 из 5.

- [ ] **Step 5: Коммит**

```bash
git commit -m "feat(oauth): эндпоинт обмена кода и refresh на токены

resource сверяется с каноническим URI: токен «для другого сервера» у нас
не действует по определению." -- apps/server
```

---

### Task 7: tRPC-роутер согласия и управления доступами

**Files:**
- Create: `apps/server/src/routers/oauth.ts`
- Modify: `apps/server/src/router.ts:14-26`
- Test: `apps/server/src/routers/oauth.test.ts`

**Interfaces:**
- Produces: процедуры `oauth.describeRequest` (query), `oauth.consent`, `oauth.listGrants` (query), `oauth.revokeGrant`.
  - `describeRequest({ clientId, redirectUri, resource })` → `{ clientName: string }`; бросает `BAD_REQUEST`, если клиент неизвестен, `redirect_uri` не зарегистрирован или `resource` чужой.
  - `consent({ clientId, redirectUri, codeChallenge, codeChallengeMethod, state })` → `{ redirectTo: string }`.
  - `listGrants()` → `GrantSummary[]`.
  - `revokeGrant({ grantId })` → `{ revoked: boolean }`.

- [ ] **Step 1: Написать падающие тесты**

`apps/server/src/routers/oauth.test.ts` через `createCallerFactory` (образец — `mcp.test.ts:45-52`):

```ts
test('описание запроса отдаёт имя клиента', async () => {
  const clientId = await seedClient();
  const out = await ownerCaller.oauth.describeRequest({
    clientId, redirectUri: REDIRECT, resource: `${ORIGIN}/mcp`,
  });
  expect(out.clientName).toBe('Claude Code');
});

test('незарегистрированный redirect_uri отвергается до показа кнопки', async () => {
  const clientId = await seedClient();
  await expect(ownerCaller.oauth.describeRequest({
    clientId, redirectUri: 'http://localhost:9999/callback', resource: `${ORIGIN}/mcp`,
  })).rejects.toThrow();
});

test('согласие выдаёт код и возвращает адрес с state', async () => {
  const clientId = await seedClient();
  const { redirectTo } = await ownerCaller.oauth.consent({
    clientId, redirectUri: REDIRECT, codeChallenge: 'x'.repeat(43),
    codeChallengeMethod: 'S256', state: 'st-1',
  });
  const url = new URL(redirectTo);
  expect(url.origin + url.pathname).toBe(REDIRECT);
  expect(url.searchParams.get('state')).toBe('st-1');
  expect(url.searchParams.get('code')?.startsWith('orbis_ac_')).toBe(true);
});

test('метод plain отвергается', async () => {
  const clientId = await seedClient();
  await expect(ownerCaller.oauth.consent({
    clientId, redirectUri: REDIRECT, codeChallenge: 'x'.repeat(43),
    codeChallengeMethod: 'plain', state: 'st-1',
  })).rejects.toThrow();
});

test('агент не управляет доступами через tRPC', async () => {
  const agentCaller = createCaller({ actorUserId: owner, actorKind: 'agent', db, clientVersion: null });
  await expect(agentCaller.oauth.listGrants()).rejects.toThrow();
});

test('отзыв гасит грант владельца', async () => {
  const token = await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  const [grant] = await ownerCaller.oauth.listGrants();
  expect(await ownerCaller.oauth.revokeGrant({ grantId: grant.id })).toEqual({ revoked: true });
  expect(await verifyBearer(db, token)).toBeNull();
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bun test --env-file apps/server/.env apps/server/src/routers/oauth.test.ts`
Expected: FAIL — роутера нет.

- [ ] **Step 3: Написать роутер**

`apps/server/src/routers/oauth.ts`:

```ts
// apps/server/src/routers/oauth.ts
// Владельческая половина OAuth-флоу (§9.3): экран согласия в SPA ходит сюда под JWT.
// Всё — ownerOnlyProcedure: выдача доступа агенту и управление им — операции владельца
// аккаунта, и агент, уже имеющий грант, не должен выписывать себе новые.
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { oauthClients } from '../db/schema';
import { createAuthorizationCode, listGrants, revokeGrant } from '../oauth/grants';
import { ownerOnlyProcedure, router } from '../trpc';

const REQUEST_SHAPE = {
  clientId: z.string().min(1),
  redirectUri: z.string().url(),
  resource: z.string().optional(),
};

/**
 * Общая проверка запроса агента: клиент известен, redirect_uri в точности тот, что
 * он зарегистрировал, ресурс — наш. Она нужна ДО показа кнопки: владелец не должен
 * жать «Разрешить», чтобы узнать, что запрос негодный.
 *
 * Канонический ресурс сверяем по ORBIS_PUBLIC_URL напрямую: у tRPC-процедуры нет
 * Hono-контекста, а подставлять сюда хост из запроса нельзя по тем же причинам,
 * по которым он не годится для метаданных.
 */
async function requireValidRequest(
  db: Parameters<typeof listGrants>[0],
  input: { clientId: string; redirectUri: string; resource?: string },
): Promise<{ clientName: string }> {
  const rows = await db.select().from(oauthClients).where(eq(oauthClients.clientId, input.clientId)).limit(1);
  const client = rows[0];
  if (!client) throw new TRPCError({ code: 'BAD_REQUEST', message: 'клиент не зарегистрирован' });
  if (!client.redirectUris.includes(input.redirectUri)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'redirect_uri не зарегистрирован этим клиентом' });
  }
  const origin = process.env.ORBIS_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (input.resource && origin && input.resource.replace(/\/+$/, '') !== `${origin}/mcp`) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'запрошен доступ к другому ресурсу' });
  }
  return { clientName: client.clientName };
}

export const oauthRouter = router({
  describeRequest: ownerOnlyProcedure
    .input(z.object(REQUEST_SHAPE))
    .query(({ ctx, input }) => requireValidRequest(ctx.db, input)),

  consent: ownerOnlyProcedure
    .input(
      z.object({
        ...REQUEST_SHAPE,
        codeChallenge: z.string().min(43).max(128),
        // plain отвергаем схемой: значение вне литерала не пройдёт валидацию
        codeChallengeMethod: z.literal('S256'),
        state: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { clientName } = await requireValidRequest(ctx.db, input);
      const code = await createAuthorizationCode(ctx.db, {
        ownerId: ctx.actorUserId,
        clientId: input.clientId,
        label: clientName,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
      });
      const url = new URL(input.redirectUri);
      url.searchParams.set('code', code);
      if (input.state !== undefined) url.searchParams.set('state', input.state);
      return { redirectTo: url.href };
    }),

  listGrants: ownerOnlyProcedure.query(({ ctx }) => listGrants(ctx.db, ctx.actorUserId)),

  revokeGrant: ownerOnlyProcedure
    .input(z.object({ grantId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => ({
      revoked: await revokeGrant(ctx.db, { ownerId: ctx.actorUserId, grantId: input.grantId }),
    })),
});
```

В `apps/server/src/router.ts` добавить импорт и ключ `oauth: oauthRouter`.

- [ ] **Step 4: Прогнать тесты**

Run: `bun test --env-file apps/server/.env apps/server/src/routers/oauth.test.ts`
Expected: PASS, 6 из 6.

- [ ] **Step 5: Коммит**

```bash
git commit -m "feat(oauth): tRPC-роутер согласия и управления доступами

Проверка запроса живёт до кнопки: владелец не должен жать «Разрешить»,
чтобы узнать, что redirect_uri агенту не принадлежит." -- apps/server
```

---

### Task 8: Экран согласия в веб-клиенте

**Files:**
- Create: `apps/web/src/features/oauth/ConsentScreen.tsx`
- Create: `apps/web/src/features/oauth/authorize-request.ts`
- Modify: `apps/web/src/main.tsx:23-37`
- Test: `apps/web/src/features/oauth/ConsentScreen.test.tsx`

**Interfaces:**
- Consumes: `oauth.describeRequest`, `oauth.consent` (Task 7); `renderWithProviders` из `apps/web/src/test/harness.tsx`.
- Produces: `parseAuthorizeRequest(search: string): AuthorizeRequest | null` где `AuthorizeRequest = { clientId, redirectUri, codeChallenge, codeChallengeMethod, state, resource }`; `denialUrl(request: AuthorizeRequest): string`; компонент `ConsentScreen({ search?: string; navigate?: (url: string) => void })`.

Переход браузера — проп `navigate` с дефолтом `window.location.assign`, а адрес — проп `search` с дефолтом `window.location.search`. Так тест не ломает `window.location` в jsdom (в проекте такого приёма нет ни разу), а компонент остаётся чистой функцией от входа.

- [ ] **Step 1: Написать падающие тесты**

`apps/web/src/features/oauth/ConsentScreen.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { parseAuthorizeRequest } from './authorize-request';
import { ConsentScreen } from './ConsentScreen';

const SEARCH =
  '?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback' +
  `&code_challenge=${'x'.repeat(43)}&code_challenge_method=S256&state=st-1`;

const HANDLER = (path: string) => {
  if (path === 'oauth.describeRequest') return { clientName: 'Claude Code' };
  if (path === 'oauth.consent') {
    return { redirectTo: 'http://localhost:8080/callback?code=orbis_ac_1&state=st-1' };
  }
  return undefined;
};

test('показывает имя клиента и по «Разрешить» уходит на redirect_uri', async () => {
  const navigate = vi.fn();
  renderWithProviders(<ConsentScreen search={SEARCH} navigate={navigate} />, HANDLER);
  expect(await screen.findByText(/Claude Code/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Разрешить' }));
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith('http://localhost:8080/callback?code=orbis_ac_1&state=st-1'),
  );
});

test('«Отклонить» уводит с access_denied — без обращения к серверу', async () => {
  const navigate = vi.fn();
  const { calls } = renderWithProviders(
    <ConsentScreen search={SEARCH} navigate={navigate} />,
    HANDLER,
  );
  await screen.findByText(/Claude Code/);
  await userEvent.click(screen.getByRole('button', { name: 'Отклонить' }));
  await waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(navigate.mock.calls[0][0]).toContain('error=access_denied');
  expect(navigate.mock.calls[0][0]).toContain('state=st-1');
  expect(calls.some((c) => c.path === 'oauth.consent')).toBe(false);
});

test('негодный запрос показывает отказ и не даёт кнопки', async () => {
  const { calls } = renderWithProviders(
    <ConsentScreen search="?client_id=abc" navigate={vi.fn()} />,
    HANDLER,
  );
  expect(await screen.findByText(/запрос неполон/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Разрешить' })).toBeNull();
  // Негодный запрос не должен даже спрашивать сервер
  expect(calls).toHaveLength(0);
});

test('метод plain не принимается клиентом', () => {
  const search =
    `?client_id=a&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&code_challenge=${'x'.repeat(43)}` +
    '&code_challenge_method=plain';
  expect(parseAuthorizeRequest(search)).toBeNull();
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bun run --filter '@orbis/web' test src/features/oauth`
Expected: FAIL — файлов нет.

- [ ] **Step 3: Написать разбор запроса**

`apps/web/src/features/oauth/authorize-request.ts`:

```ts
// Разбор параметров /oauth/authorize. Половинчатого запроса не бывает: не хватает
// любого обязательного поля — считаем запрос негодным целиком и не показываем кнопку.
// Проверка здесь — вежливость к пользователю, а не защита: настоящая проверка
// (клиент, redirect_uri, ресурс) делается на сервере в oauth.describeRequest.
export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  state: string | null;
  resource: string | null;
}

export function parseAuthorizeRequest(search: string): AuthorizeRequest | null {
  const p = new URLSearchParams(search);
  const clientId = p.get('client_id');
  const redirectUri = p.get('redirect_uri');
  const codeChallenge = p.get('code_challenge');
  // plain не поддержан сервером — отсекаем здесь, чтобы не гонять владельца зря
  const method = p.get('code_challenge_method');
  if (!clientId || !redirectUri || !codeChallenge || method !== 'S256') return null;
  if (p.get('response_type') !== null && p.get('response_type') !== 'code') return null;
  return {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: 'S256',
    state: p.get('state'),
    resource: p.get('resource'),
  };
}

/** Отказ владельца — тоже ответ агенту (OAuth 2.1 §4.1.2.1), а не тупик. */
export function denialUrl(request: AuthorizeRequest): string {
  const url = new URL(request.redirectUri);
  url.searchParams.set('error', 'access_denied');
  if (request.state !== null) url.searchParams.set('state', request.state);
  return url.href;
}
```

- [ ] **Step 4: Написать экран**

`apps/web/src/features/oauth/ConsentScreen.tsx`. Компонент разделён надвое: внешний решает,
годен ли запрос, внутренний спрашивает сервер. Так негодный запрос не порождает ни одного
обращения — `useQuery` в нём попросту не монтируется (`skipToken` в проекте не используется
ни разу, и заводить его ради одного места не нужно).

```tsx
import { useMemo } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { type AuthorizeRequest, denialUrl, parseAuthorizeRequest } from './authorize-request';

/** Переход браузера — проп: тест подменяет его, не ломая window.location в jsdom. */
export function ConsentScreen({
  search = window.location.search,
  navigate = (url: string) => window.location.assign(url),
}: {
  search?: string;
  navigate?: (url: string) => void;
}) {
  const request = useMemo(() => parseAuthorizeRequest(search), [search]);
  if (request === null) {
    return (
      <Notice>Запрос неполон — вернись в агента и повтори подключение.</Notice>
    );
  }
  return <ConsentPrompt request={request} navigate={navigate} />;
}

function ConsentPrompt({
  request,
  navigate,
}: {
  request: AuthorizeRequest;
  navigate: (url: string) => void;
}) {
  const describe = trpc.oauth.describeRequest.useQuery({
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    ...(request.resource !== null && { resource: request.resource }),
  });
  const consent = trpc.oauth.consent.useMutation({
    onSuccess: (r) => navigate(r.redirectTo),
  });

  if (describe.isError) return <Notice>{describe.error.message}</Notice>;
  if (!describe.data) return <Skeleton className="mx-auto mt-10 h-24 w-full max-w-md" />;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="font-medium text-lg">{describe.data.clientName} просит доступ к Orbis</h1>
      <p className="text-sm text-text-secondary">
        Агент сможет читать и изменять твои сущности от твоего имени. Действия попадут в
        журнал, опасные — потребуют подтверждения в чате. Доступ отзывается в разделе
        «Настройки → Агенты».
      </p>
      <div className="flex gap-2">
        <Button
          disabled={consent.isPending}
          onClick={() =>
            consent.mutate({
              clientId: request.clientId,
              redirectUri: request.redirectUri,
              codeChallenge: request.codeChallenge,
              codeChallengeMethod: 'S256',
              ...(request.state !== null && { state: request.state }),
              ...(request.resource !== null && { resource: request.resource }),
            })
          }
        >
          Разрешить
        </Button>
        <Button variant="ghost" onClick={() => navigate(denialUrl(request))}>
          Отклонить
        </Button>
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="mx-auto max-w-md p-6 text-sm text-text-secondary">{children}</p>;
}
```

`variant="ghost"` — существующий вариант `apps/web/src/ui/Button.tsx:13`, тот же, которым в
проекте рисуются второстепенные действия.

- [ ] **Step 5: Смонтировать экран**

В `apps/web/src/main.tsx` — внутри `AuthProvider` (незалогиненного он сам уведёт на вход), но **вне** `OnboardingGate`: согласие не требует пройденного онбординга.

```tsx
        <AuthProvider>
          {window.location.pathname === '/oauth/authorize' ? (
            <ConsentScreen />
          ) : (
            <OnboardingGate>
              <App />
            </OnboardingGate>
          )}
          <Toaster />
        </AuthProvider>
```

- [ ] **Step 6: Прогнать тесты**

Run: `bun run --filter '@orbis/web' test src/features/oauth`
Expected: PASS, 4 из 4.

- [ ] **Step 7: Коммит**

```bash
git commit -m "feat(oauth): экран согласия в веб-клиенте

Экран монтируется внутри AuthProvider — незалогиненного он сам уводит на
вход magic link'ом, и второго способа логина не появляется." -- apps/web
```

---

### Task 9: Раздел «Агенты» в настройках

**Files:**
- Create: `apps/web/src/features/settings/ConnectedAgents.tsx`
- Modify: `apps/web/src/features/settings/SettingsScreen.tsx:22-40`
- Test: `apps/web/src/features/settings/ConnectedAgents.test.tsx`

**Interfaces:**
- Consumes: `oauth.listGrants`, `oauth.revokeGrant` (Task 7).

- [ ] **Step 1: Написать падающие тесты**

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { ConnectedAgents } from './ConnectedAgents';

const OAUTH_GRANT = {
  id: '00000000-0000-7000-8000-000000000g01'.replace('g', 'a'),
  kind: 'oauth',
  label: 'Claude Code',
  createdAt: '2026-08-01T10:00:00.000Z',
  lastUsedAt: '2026-08-10T09:00:00.000Z',
  revokedAt: null,
};

test('показывает выданные доступы', async () => {
  renderWithProviders(<ConnectedAgents />, (path) =>
    path === 'oauth.listGrants' ? [OAUTH_GRANT] : undefined,
  );
  expect(await screen.findByText('Claude Code')).toBeInTheDocument();
});

test('отзыв дёргает мутацию и перезапрашивает список', async () => {
  const { calls } = renderWithProviders(<ConnectedAgents />, (path) =>
    path === 'oauth.listGrants' ? [OAUTH_GRANT] : path === 'oauth.revokeGrant' ? { revoked: true } : undefined,
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Отозвать' }));
  await waitFor(() => expect(calls.some((c) => c.path === 'oauth.revokeGrant')).toBe(true));
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'oauth.listGrants').length).toBeGreaterThan(1),
  );
});

test('пустой список объясняет, как подключить агента', async () => {
  renderWithProviders(<ConnectedAgents />, (path) => (path === 'oauth.listGrants' ? [] : undefined));
  expect(await screen.findByText(/claude mcp add/)).toBeInTheDocument();
});

test('отозванный доступ помечен и кнопки не имеет', async () => {
  renderWithProviders(<ConnectedAgents />, (path) =>
    path === 'oauth.listGrants'
      ? [{ ...OAUTH_GRANT, kind: 'pat', label: 'CI', revokedAt: '2026-08-05T10:00:00.000Z' }]
      : undefined,
  );
  expect(await screen.findByText(/отозван/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Отозвать' })).toBeNull();
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bun run --filter '@orbis/web' test src/features/settings/ConnectedAgents`
Expected: FAIL — компонента нет.

- [ ] **Step 3: Написать компонент**

`apps/web/src/features/settings/ConnectedAgents.tsx`:

```tsx
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';

/** Подключённые агенты (§9.3): что выдано, когда пользовались, кнопка отзыва. */
export function ConnectedAgents() {
  const utils = trpc.useUtils();
  const grants = trpc.oauth.listGrants.useQuery();
  const revoke = trpc.oauth.revokeGrant.useMutation({
    onSuccess: () => utils.oauth.listGrants.invalidate(),
  });

  if (!grants.data) return <Skeleton className="m-3 h-20" />;
  if (grants.data.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-3 text-sm text-text-secondary">
        <p>Ни одного доступа не выдано. Чтобы подключить Claude Code:</p>
        <code className="rounded bg-surface-2 p-2 text-xs">
          claude mcp add --transport http orbis {location.origin}/mcp
        </code>
        <p>Дальше — команда /mcp в агенте: вход откроется в браузере.</p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2 p-3">
      {grants.data.map((g) => (
        <li key={g.id} className="flex items-center justify-between gap-3 rounded border border-line p-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm">{g.label}</span>
            <span className="text-xs text-text-secondary">
              {g.kind === 'pat' ? 'токен для CI' : 'браузерный вход'} · подключён{' '}
              {new Date(g.createdAt).toLocaleDateString('ru-RU')}
              {g.lastUsedAt !== null &&
                ` · последний вызов ${new Date(g.lastUsedAt).toLocaleDateString('ru-RU')}`}
            </span>
          </div>
          {g.revokedAt === null ? (
            <Button variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate({ grantId: g.id })}>
              Отозвать
            </Button>
          ) : (
            <span className="text-xs text-text-secondary">отозван</span>
          )}
        </li>
      ))}
    </ul>
  );
}
```

Классы `border-line`, `bg-surface-2`, `text-text-secondary` — те же, что в вариантах
`apps/web/src/ui/Button.tsx:12-16` и на соседних экранах настроек.

- [ ] **Step 3b: Добавить вкладку**

В `apps/web/src/features/settings/SettingsScreen.tsx` между «Views» и «Экспорт»:

```tsx
              { value: 'agents', label: 'Агенты', content: <ConnectedAgents /> },
```

- [ ] **Step 4: Прогнать тесты**

Run: `bun run --filter '@orbis/web' test src/features/settings`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git commit -m "feat(oauth): раздел «Агенты» в настройках — список доступов и отзыв" -- apps/web
```

---

### Task 10: Сквозная приёмка настоящим MCP-клиентом

**Files:**
- Create: `apps/server/src/oauth/oauth.e2e.test.ts`

**Interfaces:**
- Consumes: всё, собранное в Task 1–7.

- [ ] **Step 1: Написать сквозной тест**

Тест поднимает полное приложение (`createApp`) на свободном порту и проходит путь клиента целиком, подменяя только браузерный шаг — вместо человека на кнопку жмёт tRPC-caller владельца.

Обвязка (по образцу `mcp.test.ts:26-76`, но приложение собирается настоящее — нужны роуты
`/oauth/*` и `/.well-known/*`, а не один `/mcp`):

```ts
requireEnv();
const { db, client: dbClient } = appDb();
const owner = freshUserId();
const REDIRECT = 'http://localhost:8080/callback';

const ownerCaller = createCallerFactory(appRouter)({
  actorUserId: owner, actorKind: 'owner', db, clientVersion: null,
});

let server: ReturnType<typeof Bun.serve>;
let origin: string;
const savedPublicUrl = process.env.ORBIS_PUBLIC_URL;

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

beforeAll(async () => {
  await truncateAll();
  // webDistDir — несуществующий каталог: статика этому тесту не нужна, а SPA-fallback
  // не должен перехватывать /.well-known/*, что и проверяется заодно.
  // ai: {} as AiDeps — тот же приём, что в static.test.ts:38; AI-слой этому тесту не нужен
  const app = createApp({ db, ai: {} as AiDeps, webDistDir: '/nonexistent-web-dist' });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  origin = `http://127.0.0.1:${server.port}`;
  // Метаданные обязаны называть тот же origin, на котором мы слушаем
  process.env.ORBIS_PUBLIC_URL = origin;
});

afterAll(async () => {
  server?.stop(true);
  if (savedPublicUrl === undefined) delete process.env.ORBIS_PUBLIC_URL;
  else process.env.ORBIS_PUBLIC_URL = savedPublicUrl;
  await dbClient.end();
});
```

```ts
test('путь агента целиком: 401 → метаданные → DCR → согласие → токен → тулы → отзыв', async () => {
  // 1. Без токена — 401 и адрес метаданных
  const unauth = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  expect(unauth.status).toBe(401);
  const metaUrl = /resource_metadata="([^"]+)"/.exec(unauth.headers.get('www-authenticate') ?? '')?.[1];
  expect(metaUrl).toBeTruthy();

  // 2. Метаданные ресурса → метаданные AS
  const prm = await (await fetch(metaUrl!)).json();
  const asMeta = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();

  // 3. Регистрация клиента
  const reg = await (await fetch(asMeta.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT] }),
  })).json();

  // 4. Браузерный шаг: владелец соглашается
  const { verifier, challenge } = pkce();
  const { redirectTo } = await ownerCaller.oauth.consent({
    clientId: reg.client_id, redirectUri: REDIRECT,
    codeChallenge: challenge, codeChallengeMethod: 'S256', state: 'st-1',
  });
  const code = new URL(redirectTo).searchParams.get('code')!;

  // 5. Обмен кода на токены
  const tokens = await (await fetch(asMeta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri: REDIRECT, client_id: reg.client_id, resource: prm.resource,
    }),
  })).json();

  // 6. Настоящий SDK-клиент с полученным токеном работает
  const agent = new Client({ name: 'e2e-agent', version: '0.0.0' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
  }));
  const { tools } = await agent.listTools();
  expect(tools.map((t) => t.name)).toContain('entity_query');
  const created = await agent.callTool({ name: 'entity_create', arguments: { title: 'из агента по OAuth' } });
  expect((created as { isError?: boolean }).isError).toBeFalsy();

  // 7. Владелец отзывает доступ — следующий вызов не проходит
  const [grant] = await ownerCaller.oauth.listGrants();
  await ownerCaller.oauth.revokeGrant({ grantId: grant.id });
  const after = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  expect(after.status).toBe(401);
});

test('созданное агентом действие попало в журнал с атрибуцией agent/mcp', async () => {
  // Предыдущий тест уже создал сущность через OAuth-токен. Проверяем, что путь через
  // новый транспорт не потерял атрибуцию: карточка действия обязана лежать в ГЛОБАЛЬНОМ
  // треде владельца с actor_kind=agent и source=mcp (§7.8, D11) — иначе владелец не
  // увидит, что натворил агент, и Undo будет не над чем делать.
  const rows = await withIdentity(db, owner, (tx) =>
    tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, globalThreadId(owner)))
      .orderBy(chatMessages.createdAt, chatMessages.id),
  );
  const actions = rows
    .filter((r) => r.role === 'system')
    .map((r) => (r.metadata as { actions?: ActionRecord[] }).actions?.[0])
    .filter((a): a is ActionRecord => a !== undefined);

  const created = actions.find((a) => a.tool === 'entity_create');
  expect(created).toBeDefined();
  expect(created).toMatchObject({ actorKind: 'agent', source: 'mcp' });
});
```

Ключи `actorKind` и `source` — те самые, что объявлены в `ActionRecord`
(`apps/server/src/executor/types.ts:13-14`).

- [ ] **Step 2: Прогнать**

Run: `bun test --env-file apps/server/.env apps/server/src/oauth/oauth.e2e.test.ts`
Expected: PASS, 2 из 2.

- [ ] **Step 3: Полный прогон и линт**

Run: `bun run test`, затем отдельным вызовом `bun run lint`
Expected: все сьюты зелёные (перф-тест при флаке перепроверить одиночным прогоном), lint без замечаний.

- [ ] **Step 4: Коммит**

```bash
git commit -m "test(oauth): сквозная приёмка — от 401 до отозванного доступа

Браузерный шаг подменён вызовом согласия под JWT владельца; остальное
проходит настоящий MCP-клиент из SDK." -- apps/server
```

---

### Task 11: Документация и конфигурация прода

**Files:**
- Modify: `docs/prd/01-architecture.md` (§4 — состав таблиц, §9.3 — аутентификация)
- Modify: `docs/prd/04-decision-log.md` (добавить D34)
- Modify: `docs/implementation/02-ops-runbook.md` (§2 — переменные, §3 — подключение агента)
- Modify: `render.yaml` (добавить `ORBIS_PUBLIC_URL`, снять `ORBIS_PAT_*`)
- Modify: `apps/server/.env.example`

- [ ] **Step 1: Записать решение D34**

В `docs/prd/04-decision-log.md` после D33, в том же формате, что соседние: что решено (Orbis — свой authorization server; две новые таблицы; токены hash-only; PAT переезжает из env), какие альтернативы отвергнуты и почему (Supabase как AS — нет DCR и чужая аудитория; JWT — отзыв всё равно через базу), что это стоило (PRD §4 расширен с восьми таблиц до десяти).

- [ ] **Step 2: Привести PRD к факту**

§4 — добавить `oauth_clients` и `agent_grants` в состав таблиц со ссылкой на D34. §9.3 — переписать абзац про аутентификацию: основной путь — OAuth 2.1 с браузерным входом, PAT остаётся для headless; отзыв — в настройках; скоупы по-прежнему Future.

- [ ] **Step 3: Обновить runbook**

§2 — строка про `ORBIS_PUBLIC_URL` (обязательна в production, значение `https://orbis-64q4.onrender.com`); строки `ORBIS_PAT_HASH`/`ORBIS_PAT_OWNER_ID` убрать. §3 переписать: подключение через `claude mcp add --transport http orbis https://orbis-64q4.onrender.com/mcp` + `/mcp`, headless — через `bun scripts/issue-pat.ts <owner-uuid> [метка]`, отзыв — «Настройки → Агенты».

- [ ] **Step 4: Обновить render.yaml и .env.example**

Добавить `ORBIS_PUBLIC_URL` (не секрет — значение прямо в файле), убрать `ORBIS_PAT_HASH` и `ORBIS_PAT_OWNER_ID`.

- [ ] **Step 5: Коммит**

```bash
git commit -m "docs(oauth): PRD, D34 и runbook к факту браузерного входа

PRD §4 расширен с восьми таблиц до десяти — это цена одноразового кода и
отзыва, которых без состояния в базе не бывает." -- docs render.yaml apps/server/.env.example
```

---

## Приёмка фазы

После Task 11 — живой смоук на проде, до мержа:

1. Задеплоить ветку, выставить `ORBIS_PUBLIC_URL` в Render, снять `ORBIS_PAT_*`.
2. `claude mcp add --transport http orbis https://orbis-64q4.onrender.com/mcp`, затем `/mcp` — пройти вход в браузере.
3. Из Claude Code дёрнуть `entity_query`, убедиться, что действие видно в чате Orbis карточкой с атрибуцией агента.
4. В «Настройки → Агенты» отозвать доступ; следующий вызов из Claude Code обязан попросить войти заново.
5. Проверить headless: `bun scripts/issue-pat.ts <owner-uuid> CI`, вызов `/mcp` заголовком, затем отзыв той же кнопкой.

Перед смоуком снять service worker (`getRegistrations().unregister()` + `caches.delete`), иначе проверяется старый бандл.
