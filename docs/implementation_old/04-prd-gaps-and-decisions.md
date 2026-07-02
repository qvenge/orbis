# Orbis Implementation Foundation - 04: PRD Gaps and Required Decisions

| Field | Value |
|---|---|
| Date | 2026-06-13 |
| Status | Superseded draft - do not use |
| Purpose | Superseded by `00-decision-ledger.md` |

This gap list predates the accepted PowerSync, normalized data, Yjs, files, and History Manager decisions. It will be replaced after discussion.

The reviewed PRDs are sufficient for product behavior but not yet sufficient for several persistence and protocol details exposed by implementation design. This document separates implementation choices from changes that must return to the PRD source of truth.

## 1. Blocking PRD gaps

### GAP-01: PAT persistence is unspecified

PRD 01 requires one MCP PAT per user but defines no table or lifecycle fields. An environment-only token cannot safely support per-user ownership, hashing, last-used audit, revocation, or future scopes.

Required PRD amendment:

- add a server-only `agent_tokens` table;
- define token ID, user ID, secret hash, scopes, created/last-used/revoked timestamps;
- state that raw token material is shown once and never persisted;
- add RLS/service access policy and indexes;
- increase the stated table count.

Implementation recommendation: include future-compatible scopes in storage but expose only one full-access token in MVP.

### GAP-02: Permanent action journal storage is implicit

PRD 01 describes actions inside immutable `chat_messages.metadata` and Undo markers as system messages. It also says the journal is shared by chat, fast-path, import, and MCP. The implementation can make this work by writing audit messages to the global thread, but the contract should state this explicitly.

Required PRD amendment or confirmation:

- every action has exactly one permanent audit message in the global thread, even when initiated outside chat;
- its deterministic message ID is the idempotency record for the action;
- audit metadata is retained even when visible chat history is summarized or locally evicted;
- `batch_id`/`action_id` uniqueness is enforced per user, not only by convention.

If audit messages are not intended to be the permanent journal, a dedicated `actions` table is required instead. Implementing both without a decision would create competing sources of truth.

### GAP-03: Server rejection of an offline mutation is unspecified

The PRD defines optimistic local writes and server-side invariants but does not define the user-visible outcome when local validation passed and server validation later rejects due to concurrent state.

Required PRD amendment:

- rejected actions are removed from the pending overlay and affected local rows are rebased;
- later local actions are replayed, not discarded;
- the user receives an error/conflict card with retry or correction path;
- validation errors are not retried automatically;
- no silent loss or automatic IndexedDB reset is allowed.

### GAP-04: Pull pagination and cursor commit are unspecified

`server_revision > cursor` is defined, but response limits, continuation, high-water marks, and crash behavior are not. Without a contract, a client can skip rows or create unbounded responses.

Required PRD amendment:

- rows are returned in revision order with bounded pages;
- cursor advances only after local commit;
- continuation semantics are stable across syncable tables;
- the server may return a safe high-water mark only when it cannot skip unseen committed rows.

### GAP-05: Database role used by the Bun API is unspecified

The PRD requires RLS to reject cross-user access, while Drizzle usually connects with a database credential that may own tables or bypass RLS. This cannot be left to deployment configuration.

Required PRD amendment or security ADR:

- normal API transactions use a non-bypass role;
- verified JWT identity is installed transaction-locally;
- migration/admin credentials are separate;
- identity context is tested for leakage through connection pooling;
- service-role access is limited to explicit administrative jobs.

## 2. Non-blocking implementation decisions

These decisions do not change user-visible PRD behavior and can live only in implementation documentation:

| ID | Decision |
|---|---|
| IMP-01 | Dexie is the IndexedDB abstraction and reactive data source |
| IMP-02 | Zustand stores only ephemeral UI state |
| IMP-03 | The client has explicit outbox, base, sync-state, AI-queue, and action-index stores |
| IMP-04 | The Bun API is a persistent external service, not a Supabase Edge Function |
| IMP-05 | Direct DB or session-pool connection is preferred for the persistent API |
| IMP-06 | Zod validates fixed contracts; Ajv validates persisted aspect JSON Schema |
| IMP-07 | Query grammar uses a shared hand-written tokenizer/parser and AST |
| IMP-08 | Domain code is framework-free and reached through adapters |
| IMP-09 | Foreground sync triggers are authoritative; service-worker sync is best effort |
| IMP-10 | Vitest, Playwright, and pgTAP cover distinct test boundaries |
| IMP-11 | Deployment remains static PWA plus portable Bun container plus Supabase |
| IMP-12 | Direct provider SDK adapters are used instead of an AI orchestration framework |

## 3. Decisions to validate with phase-zero spikes

These have a recommendation but need executable proof before feature implementation.

### SPIKE-01: Supabase RLS through Drizzle

Prove on local and hosted Supabase:

- API connection can assume a non-bypass request role;
- transaction-local claims make `auth.uid()` return the verified user;
- RLS protects direct and joined reads/writes;
- advisory locks and revision assignment work in the same transaction;
- pooled reuse cannot leak identity.

Exit: automated integration and pgTAP tests, plus a short accepted ADR with the exact role setup.

### SPIKE-02: Dexie transaction and rebase model

Build a non-UI harness for two logical devices and a fake server. Demonstrate local atomic command, response loss, rejection, pull, rebase, and later-action replay.

Exit: all sync acceptance fixtures pass without clearing local storage.

### SPIKE-03: Query parity skeleton

Implement parser/AST interfaces and one representative filter for JS and SQL. The goal is to validate architecture, not complete grammar.

Exit: one shared fixture produces identical ordered IDs in both backends and invalid syntax produces the same error code.

### SPIKE-04: PWA lifecycle on target devices

Verify installation, offline reload, IndexedDB persistence, update prompt, storage behavior, and foreground sync triggers in Chromium and WebKit/iOS-equivalent testing.

Exit: documented compatibility limits and no correctness dependency on background sync.

### SPIKE-05: Deployment connectivity

Deploy a minimal Bun health/API container in candidate regions and connect it to hosted Supabase using the intended role and connection mode.

Exit: selected host, measured latency, working IPv6 or session pool, secret management, logs, and a repeatable deployment path.

## 4. Decisions explicitly deferred

- concrete web and API hosting provider;
- observability vendor;
- streaming assistant text before the first complete tool loop works;
- rich-text editor beyond markdown textarea/preview;
- generic UI component package beyond proven repeated components;
- managed background jobs or queues;
- CRDT or managed sync product;
- embeddings/vector search;
- split services for AI and MCP;
- native wrapper.

Deferral means implementation must preserve the boundary, not add placeholder infrastructure.

## 5. Acceptance checklist for this foundation

- The stack keeps the PRD's Bun, TypeScript, tRPC, Drizzle, Supabase, React PWA, IndexedDB, Claude-default, and MCP direction.
- Dexie and Zustand responsibilities do not overlap.
- Browser UI has one canonical read source.
- Domain rules are shared across local commands, server sync, AI, and MCP.
- Query parsing is shared; only execution backends differ.
- Offline batches never include network work inside IndexedDB transactions.
- Server retries are idempotent and serialized per user.
- RLS is enforced on the real API database path, not only tested through a separate path.
- Rejected offline actions have an explicit rebase and UX outcome.
- Service-worker scheduling is not required for convergence.
- Test strategy directly covers every critical invariant in PRD 01 section 13.
- No application source code is introduced by this document set.

## 6. Next document set after acceptance

The implementation plan should be phase-based and dependency-driven:

1. Foundation spikes and accepted ADRs.
2. Workspace, contracts, local/server database, and auth skeleton.
3. Shared command executor and action journal.
4. Query engine parity.
5. Sync and multi-device convergence.
6. Core OS vertical slices.
7. Budget vertical slices and CSV import.
8. AI and MCP adapters over the completed executor.
9. Reliability, performance, and production release.

Each phase must name files/packages, migrations, tests, exit criteria, and PRD acceptance checks. Calendar estimates should be added only after the phase-zero spikes remove the largest unknowns.
