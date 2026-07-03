# Orbis Implementation Foundation - 03: Quality, Security, and Delivery

| Field | Value |
|---|---|
| Date | 2026-06-13 |
| Status | Superseded draft - partial content only |
| Depends on | Superseded; use `00-decision-ledger.md` |

Some quality guidance may survive, but this draft references the old Dexie architecture. It is not a source of truth until rewritten.

## 1. Quality gates

Every merge to the main branch must pass:

1. formatting and linting;
2. TypeScript strict typecheck for all workspaces;
3. unit and package integration tests;
4. query SQL/JS parity fixtures;
5. sync conflict and rebase fixtures;
6. database migration from a clean local Supabase instance;
7. pgTAP RLS/constraint tests;
8. production builds for web and API;
9. a focused Playwright smoke suite.

Full multi-device, offline, import, and AI-provider tests may run in a slower CI job, but they are required before a tagged production release.

## 2. Test layers

### 2.1 Pure domain tests - Vitest

Fast tests without browser or database cover:

- decimal normalization and arithmetic;
- date/time-zone and recurrence functions;
- UUIDv5 naming inputs;
- command validation and inverse generation;
- budget formulas and envelope selection;
- CSV normalization and duplicate scoring;
- aspect validation adapters;
- entitlements and rate-limit decisions;
- AI context selection and prompt fixtures.

Time, randomness, provider clients, and current user settings are injected. Tests must not depend on the developer machine time zone.

### 2.2 Query contract tests - Vitest plus PostgreSQL

One fixture corpus is evaluated by:

- the parser and JS evaluator over an in-memory/local representation;
- the SQL compiler against PostgreSQL;
- expected ordered IDs and aggregates.

Every grammar feature, invalid query, null ordering rule, enum ordering rule, decimal comparison, relation filter, and relative date token has parity cases. A query feature is incomplete until both backends pass the same fixtures.

### 2.3 Client database tests - Vitest

Dexie repository and migration tests use a controlled IndexedDB implementation for most cases. Tests that depend on browser transaction scheduling, service workers, storage quotas, or cross-tab observation run in Playwright with a real browser.

Each Dexie version migration is tested from the oldest supported local schema and from the immediately previous schema. Migration failure must preserve the original database.

### 2.4 Server integration tests - Vitest plus local Supabase

Tests run tRPC/application services against a disposable database and verify:

- transaction rollback;
- user advisory-lock serialization;
- revision ordering and pagination;
- idempotent command retries;
- action/audit creation;
- AI tool execution with a fake provider;
- PAT authentication and rate limiting;
- server restart between commit and client retry.

### 2.5 Database security tests - pgTAP

Supabase CLI runs SQL tests for:

- RLS ownership on every table;
- indirect ownership for relations and chat messages;
- insertion and update `WITH CHECK` behavior;
- one global/entity thread constraints;
- live relation uniqueness;
- custom application role cannot bypass RLS;
- migration role can perform migrations but is not used by requests.

Supabase officially supports database tests through its CLI and pgTAP; these tests are part of CI, not a manual checklist.

### 2.6 Browser end-to-end tests - Playwright

Critical projects:

- Chromium desktop as the main fast lane;
- WebKit for installed-PWA-sensitive and IndexedDB lifecycle behavior;
- mobile viewport coverage for primary workflows.

Critical scenarios:

- first sign-in and deterministic seeding;
- create/edit offline, reload, reconnect, converge;
- two browser contexts editing the same record;
- queued AI message and cancellation;
- fast-path transaction under two seconds in a production build fixture;
- CSV review/import/idempotent retry;
- atomic rollover and Undo;
- app update with an IndexedDB migration;
- auth expiry while pending actions exist.

Real provider calls are excluded from deterministic E2E. A separate opt-in smoke check validates the configured provider with strict spend limits.

## 3. Security model

### 3.1 Trust boundaries

- Browser input, local database contents, CSV files, AI output, and MCP input are untrusted.
- The API verifies Supabase JWTs; decoding without signature verification is prohibited.
- PostgreSQL RLS is a second authorization boundary for normal request transactions.
- The tool executor validates ownership and domain invariants even when called internally.
- AI providers never receive credentials or unrestricted query access.

### 3.2 Secrets

Browser-visible configuration contains only Supabase project URL and publishable key. The following remain server-only:

- database credentials;
- provider API keys;
- PAT hashing secret, if used;
- Sentry/observability server credentials;
- migration credentials.

Secrets are injected through environment variables or the hosting secret manager. They are never stored in repository `.env` files.

### 3.3 PAT design

An MCP token is a high-entropy random secret with a public token ID/prefix. The database stores only a cryptographic hash of the secret plus user ID, creation time, last-used time, and revocation time. Authentication performs constant-time hash comparison. Raw tokens are displayed once at generation and never logged.

Even though MVP exposes one full-access token, the row shape includes a future-compatible scope field. Runtime behavior treats it as full access until scoped tokens enter product scope.

### 3.4 Web security

The PWA uses:

- strict Content Security Policy with explicit API/Auth/provider origins;
- no inline script requirement in production;
- secure, same-site cookies only where a server cookie is introduced;
- escaped markdown rendering and an allowlist for links;
- no arbitrary HTML in entity bodies;
- file size and row count limits before CSV parsing;
- formula-injection escaping on any future CSV export.

Entity links and query blocks are parsed as syntax nodes, not rendered through raw HTML replacement.

### 3.5 AI and tool safety

- Tool schemas reject unknown fields by default.
- Tool results contain only data needed by the current request.
- Prompt text and entity bodies are data, not executable instructions.
- Destructive-looking bulk actions require the same product confirmation rules regardless of whether initiated by user, AI, or MCP.
- Every mutation has actor, request, action, and audit identifiers.
- Provider logs and tracing redact prompts and tool payloads by default.

## 4. Environments

### 4.1 Local

- Supabase CLI for Auth/PostgreSQL parity;
- Bun API with local secrets;
- Vite dev server;
- deterministic fake AI provider by default;
- optional real provider enabled explicitly.

Local startup must be one documented command after dependencies and Docker are available. Seed data is deterministic and rerunnable.

### 4.2 CI

CI creates a fresh local Supabase stack, applies committed migrations, runs database and integration tests, then destroys it. CI does not depend on a shared remote development database.

### 4.3 Production

- static PWA hosting with immutable hashed assets and SPA fallback;
- one persistent OCI-compatible Bun service;
- managed Supabase project;
- separate migration job using migration credentials;
- provider and observability secrets in platform secret storage.

The first deployment spike chooses a concrete web/API host based on region reachability, IPv6/session-pool support, persistent container behavior, logs, backups, and cost. Application design must not depend on provider-specific functions.

## 5. Database migrations

Drizzle schema is the TypeScript schema source, while reviewed SQL migrations are the deployment artifacts committed to `supabase/migrations`.

Rules:

- never use schema push against production;
- migrations are forward-only after production use begins;
- destructive changes use expand/migrate/contract across releases;
- every migration enables/verifies RLS for exposed tables;
- constraints and indexes are named;
- data migrations are idempotent or guarded by an explicit migration marker;
- rollback means application rollback plus a forward repair migration, not automatic down SQL on live user data.

## 6. Release flow

1. Merge to main after quality gates.
2. Build immutable web and API artifacts from one commit SHA.
3. Apply database migration job.
4. Deploy API and verify health plus database compatibility.
5. Deploy PWA assets and manifest.
6. Run production smoke checks without mutating real user data, except an isolated synthetic account.
7. Monitor error rate, sync rejection rate, and migration diagnostics.

The API exposes a minimum compatible client schema version. A client that is too old receives an explicit upgrade-required response rather than attempting an incompatible sync.

## 7. Observability

### 7.1 Structured events

Server events include:

- request completed/failed;
- sync cycle summary;
- action accepted/rejected/retried;
- AI request usage and normalized provider error;
- MCP authentication and tool result status;
- migration and startup compatibility status.

Logs carry IDs and counts, not user content. Local client diagnostics use the same error codes.

### 7.2 Initial metrics

- API latency/error rate by procedure;
- sync push/pull latency and row counts;
- pending and rejected outbox actions;
- conflict-copy count;
- AI request/token/cost count by model;
- tool validation failures;
- query duration and result count;
- local migration failures;
- CSV duplicate/manual correction rates.

The product metrics in PRD 00 remain separate from operational metrics.

### 7.3 Initial tooling decision

Use a small logger interface producing JSON to stdout and a browser/API error tracker behind adapters. Do not introduce a full OpenTelemetry stack before there is an operational consumer. The hosting choice may provide log retention; the application event shape remains portable.

## 8. Performance budgets

Initial measurable budgets:

- app shell usable from warm cache without network;
- fast-path command visible in under two seconds, with a target under 500 ms on the reference device;
- common local list queries under 100 ms for 10,000 entities;
- local mutation transaction under 50 ms excluding heavy CSV batches;
- sync batches bounded by row count and payload size so the UI thread remains responsive;
- large CSV parse and duplicate scoring run in a Web Worker;
- no full entity collection copied into React or Zustand memory.

These are test targets, not guarantees for all devices. The implementation plan must add representative data generators and measurement scripts before optimization work.

## 9. Dependency policy

Add a dependency when it owns a difficult boundary or removes substantial code. Prefer small focused libraries over frameworks that take control of persistence or orchestration.

Required checks before adding a dependency:

- browser/Bun compatibility as applicable;
- active maintenance and license;
- ESM support;
- bundle/runtime impact;
- whether persisted or wire formats become library-specific;
- replacement cost.

Security update automation may open pull requests, but lockfile changes merge only after the full quality gates.

## 10. Primary references

- [Supabase database testing](https://supabase.com/docs/guides/database/testing) defines CLI and pgTAP support.
- [Playwright test documentation](https://playwright.dev/docs/test-intro) covers isolated browser contexts and multi-browser execution.
- [Vitest guide](https://vitest.dev/guide/) is the selected Vite-native unit/integration runner.
- [Vite PWA guide](https://vite-pwa-org.netlify.app/guide/) documents the app-shell/service-worker integration used by the web client.
