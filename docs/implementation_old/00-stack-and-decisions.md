# Orbis Implementation Foundation - 00: Stack and Decisions

| Field | Value |
|---|---|
| Date | 2026-06-13 |
| Status | Superseded draft - do not use |
| Scope | Implementation foundation for PRD v3 |
| Source | `docs/prd/00-product.md` through `03-budget.md` |

This early draft predates the PowerSync/Yjs/data-model discussion and is not a source of truth. Use `00-decision-ledger.md`. This file will be rewritten after the discussion closes.

## 1. Decision criteria

The stack is evaluated in this order:

1. Offline correctness and recoverability.
2. One implementation of domain rules across UI, sync, AI, and MCP.
3. Deterministic behavior for money, dates, IDs, queries, and conflicts.
4. A small operational surface suitable for a personal MVP.
5. Portability: Supabase is used as managed Postgres and Auth, not as the only possible runtime.
6. Type safety where types are static, runtime validation at every process and storage boundary.

The system is deliberately not optimized for team collaboration, real-time co-editing, marketplace isolation, or heavy analytical workloads. Those remain outside MVP.

## 2. Recommended stack

| Area | Decision | Role |
|---|---|---|
| Language | TypeScript, strict mode | Shared language for web, API, domain, sync, and MCP |
| Package manager and server runtime | Bun | Workspaces, scripts, API runtime, MCP runtime |
| Repository | Bun workspaces, no monorepo orchestrator initially | The repository is too small to justify Turborepo or Nx |
| Web | React + Vite PWA | Installable browser client and offline shell |
| Routing | TanStack Router | Typed routes, search params, nested detail screens, deep links |
| Persistent client data | IndexedDB through Dexie | Local source of truth, transactions, indexes, reactive queries |
| React data binding | `dexie-react-hooks` | Components subscribe directly to local queries |
| Ephemeral UI state | Zustand | Draft UI, navigation chrome, dialogs, selection; never canonical entities |
| Styling | Tailwind CSS + Radix UI primitives | Fast product UI without adopting a large component framework |
| Forms | React Hook Form | Aspect and settings forms; validation delegated to shared schemas |
| API transport | tRPC over the fetch adapter | Typed internal client-server transport |
| API host | `Bun.serve` | Long-lived service with HTTP endpoints for tRPC, health, and MCP |
| Database | Supabase PostgreSQL | Cloud replica, cross-device exchange, auth ownership, full-text search |
| Server data access | Drizzle ORM with `postgres.js` | Schema, migrations, typed SQL, explicit transactions |
| Authentication | Supabase Auth | Browser session and JWT issuance |
| Fixed API schemas | Zod | tRPC inputs/outputs, command envelopes, config |
| Dynamic aspect schemas | JSON Schema + Ajv | Runtime-defined aspects cannot be represented by compile-time Zod alone |
| Money | `decimal.js` | Exact base-10 arithmetic and normalized decimal strings |
| Dates and time zones | `@js-temporal/polyfill` | Shared deterministic date/time behavior with IANA zones |
| IDs | `uuid` | UUIDv7 for client-created records, UUIDv5 for deterministic records |
| AI provider | Direct provider adapters; Anthropic adapter first | Avoid framework lock-in; tool executor stays provider-independent |
| MCP | Official Model Context Protocol TypeScript SDK | Streamable HTTP adapter over the same tool registry |
| Unit and integration tests | Vitest | Vite-compatible runner for shared, web, and server modules |
| Browser tests | Playwright | PWA, IndexedDB, multi-tab, offline, and end-to-end scenarios |
| Database policy tests | pgTAP via Supabase CLI | RLS, constraints, functions, and migrations |
| CI | GitHub Actions | Typecheck, lint, tests, migration verification, production build |

Exact package versions are not fixed in architecture documents. The first implementation change creates a lockfile and records exact versions there. Major upgrades require a short ADR if they change persistence, wire contracts, or runtime behavior.

## 3. Clarification of the existing PRD stack

### 3.1 Zustand is not the application database

The PRD line `State: Zustand` is retained with a narrower meaning. Entities, relations, messages, settings, sync state, and queued operations live in Dexie. Copying those collections into Zustand would create two client-side sources of truth and make cross-tab updates unreliable.

Zustand is allowed for state that can be discarded without data loss:

- open sidebar and dialog state;
- current selection and temporary filters;
- unsaved form drafts when they do not need crash recovery;
- transient progress and error presentation.

### 3.2 Supabase is not the application runtime

Supabase provides PostgreSQL and Auth. The Bun API is deployed separately as a persistent container or VM. Supabase Edge Functions are not selected because they use a different runtime and would split the server implementation between Bun and Deno.

The production connection uses a direct PostgreSQL connection when IPv6 is available, otherwise Supavisor session mode. Transaction-pool mode is not the default for the persistent API because the implementation relies on explicit transactions, transaction-local identity context, and advisory locks.

### 3.3 tRPC is a transport, not a domain boundary

tRPC routers authenticate requests, validate envelopes, and call application services. They do not contain budget formulas, sync merge logic, tool behavior, or query semantics. The same application services are called by:

- tRPC procedures;
- the AI tool executor;
- the MCP adapter;
- offline client commands where the rule can execute locally.

### 3.4 JSON Schema remains canonical for aspects

Built-in and future dynamic aspects are persisted as JSON Schema in `aspect_definitions`. Ajv is therefore the canonical runtime validator for aspect payloads. Zod remains appropriate for fixed TypeScript-owned contracts but does not replace the persisted aspect schema.

## 4. Decisions that reduce complexity

### 4.1 No generic local-first framework

ElectricSQL, PowerSync, RxDB sync plugins, Dexie Cloud, and CRDT frameworks are not selected for MVP. The PRD specifies a custom revision cursor, field/aspect merge matrix, body conflict copies, deterministic recurring materialization, and shared atomic actions. Adapting a generic replication product would still require custom conflict and action layers while introducing a second protocol.

Dexie is used only as the IndexedDB abstraction. Orbis owns the sync protocol.

### 4.2 No LangChain-style orchestration framework

The AI layer has a small provider interface, prompt/context builder, tool registry, executor, and usage meter. Direct provider SDKs preserve provider features and keep the domain executor testable without an agent framework.

### 4.3 No event-sourced primary model

The primary model remains current-state rows from the PRD. The action journal supports Undo and audit but is not replayed to rebuild the database. Full event sourcing would multiply migration and sync complexity without an MVP requirement.

### 4.4 No service worker dependency for correctness

The service worker caches the app shell and may request best-effort sync. Correctness does not depend on background execution because browser and iOS PWA scheduling is not guaranteed. Foreground lifecycle triggers are authoritative.

### 4.5 No separate read cache such as TanStack Query for entities

Entity reads come from Dexie. A second cache would make optimistic updates and pull-merge harder to reason about. Remote-only operations such as AI requests may use tRPC client state directly; they do not become canonical entity storage.

## 5. Alternatives retained as escape hatches

| Current decision | Revisit when | Likely alternative |
|---|---|---|
| Custom sync | Team editing or high device concurrency becomes a goal | CRDT or managed local-first replication |
| JSONB aspects | Aggregations become a measured bottleneck | Generated projection tables/materialized views from `aggregations` |
| React PWA | OS integrations become core workflows | Native shell around shared domain packages |
| Single Bun API | Independent scaling or reliability boundaries are demonstrated | Separate AI/MCP workers, not before |
| Direct provider SDKs | More than two providers require materially different orchestration | Small internal capability layer first; framework only if it removes code |
| Tailwind + Radix | Design system stabilizes and repeated patterns are measured | Local component package, still owned by the repository |

## 6. Decision status

Recommended for acceptance now:

- Bun workspaces without an extra monorepo tool;
- Dexie as persistent and reactive client state;
- Zustand only for ephemeral UI state;
- separate persistent Bun API;
- Drizzle plus `postgres.js`;
- Zod for fixed contracts and Ajv for aspect JSON Schema;
- shared command executor and query AST;
- custom sync owned by Orbis;
- Vitest, Playwright, and pgTAP as three test layers.

Provider-specific hosting remains intentionally open until a phase-zero connectivity and deployment spike. The deployable contract is fixed: static PWA plus one OCI-compatible Bun service plus Supabase.

## 7. Primary references

- [Dexie `useLiveQuery`](https://dexie.org/docs/dexie-react-hooks/useLiveQuery()) documents reactive IndexedDB queries and cross-context observation for Dexie writes.
- [Dexie transactions](https://dexie.org/docs/Dexie/Dexie.transaction()) define the transaction scope and the restriction against awaiting network work inside an IndexedDB transaction.
- [Supabase database connections](https://supabase.com/docs/guides/database/connecting-to-postgres) distinguishes direct, session-pool, and transaction-pool use cases.
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) documents ownership policies and the fact that service credentials can bypass RLS.
- [Bun workspaces](https://bun.sh/docs/pm/workspaces) supports the selected repository layout.
- [tRPC fetch adapter](https://trpc.io/docs/server/adapters/fetch) keeps transport independent of a Node-specific framework.
- [Ajv](https://ajv.js.org/guide/why-ajv.html) is the runtime validator for persisted JSON Schema.
- [MCP SDKs](https://modelcontextprotocol.io/docs/sdk) lists the official TypeScript SDK used by the adapter.
