# Orbis Implementation Decisions

| Field | Value |
|---|---|
| Date | 2026-06-14 |
| Status | **SUPERSEDED (2026-07-02)** — см. ниже |
| Authority | Архив; действующий журнал решений — [`docs/prd/04-decision-log.md`](../prd/04-decision-log.md) |

> **⚠️ SUPERSEDED.** Этот файл больше не является source of truth. Направление пересмотрено спекой `docs/superpowers/specs/2026-07-02-prd-v3.1-online-first-agent-loop-design.md` (онлайн-первый разрез + агентная петля): PowerSync/offline-first/Yjs/нормализация DATA-01…08 отменены (решения D1–D4), часть решений перенесена как carried (политика подтверждений AI-09…14, RLS-механика AUTH-08…10, конвейер executor'а, retention и др. — полный список в спеке §2). Живые решения перенесены в [`docs/prd/04-decision-log.md`](../prd/04-decision-log.md) (D1–D11 + carried-список); этот файл остаётся историческим архивом.

Historical text below (do not apply without checking the v3.1 spec):

This was the source of truth for decisions accepted after PRD v3. If this file conflicts with another document in `docs/implementation`, this file wins until the thematic documents are rewritten. It does not silently override `docs/prd`: section 12 lists the PRD amendments required before implementation.

Status vocabulary:

- **Accepted**: explicitly agreed during discussion.
- **Baseline**: inherited from PRD and not challenged yet.
- **Deferred**: intentionally postponed.
- **Open**: still requires a decision or executable spike.
- **Superseded**: an earlier decision replaced by a later one.

## 1. Product boundary

| ID | Status | Decision |
|---|---|---|
| PROD-01 | Accepted | Users can create and edit domain records offline. Network-only capabilities may degrade explicitly. |
| PROD-02 | Accepted | A view does not own domain storage. Removing a view must not remove the entities, aspects, tags, relations, origins, or assets it displayed. |
| PROD-03 | Accepted | A view may own UI, routes, badges, read models, workflows, and command orchestration. Domain schemas and invariants remain available to Chat, Browser, AI, MCP, and other views. |
| PROD-04 | Deferred | Marketplace execution of third-party backend code, sandboxing, capabilities, signing, AI/static review, and manual moderation are deferred until marketplace work begins. AI review alone will not be treated as a security boundary. |

## 2. Local-first and synchronization

| ID | Status | Decision |
|---|---|---|
| SYNC-01 | Accepted | Use PowerSync instead of a hand-written replication protocol or Dexie-based mirror. The client data store is PowerSync-managed SQLite in the browser. |
| SYNC-02 | Accepted | PowerSync handles local SQLite, reactive reads, upload queue, checkpoints, delivery, and reconciliation with PostgreSQL. Orbis owns command semantics, authorization, invariants, audit, and Undo/Redo. |
| SYNC-03 | Accepted | UI reads and offline-capable writes use the local PowerSync database. Network calls are not part of local SQLite transactions. |
| SYNC-04 | Accepted | Domain mutations upload as typed command envelopes. Low-level CRUD records produced by the optimistic local transaction are not trusted as server instructions. |
| SYNC-05 | Accepted | One local transaction writes optimistic domain rows, the optimistic action projection, and one `command_outbox` envelope. The uploader sends the envelope to the Bun executor. |
| SYNC-06 | Accepted | `command_outbox` is a pending-only PowerSync table: it participates in upload but is absent from download streams. |
| SYNC-07 | Accepted | The Bun executor validates and applies the whole command in one PostgreSQL transaction, writes the canonical action and command receipt, then returns success. |
| SYNC-08 | Accepted | Business rejection is returned as an acknowledged outcome rather than a retryable transport failure. `command_outcomes` is synchronized to the originating device to explain the rejection. |
| SYNC-09 | Accepted | PowerSync reconciliation restores server-authoritative rows after rejection. Orbis must not create a second manual rollback mutation on top of PowerSync reconciliation. |
| SYNC-10 | Accepted | Upload transactions are processed in order. Dependent commands are not reordered. A rejected prerequisite may cause later dependent commands to be rejected as well. |
| SYNC-11 | Accepted | Yjs updates, asset upload, AI requests, and telemetry use specialized flows rather than domain command upload. |
| SYNC-12 | Superseded | Manual `server_revision`, `sync_log`, base snapshots, custom pull cursor, and hand-written diff/rebase are no longer the selected implementation. |
| SYNC-13 | Accepted | The device permanently mirrors the user's core graph: entities, aspects, tag registry and links, origins, relations, body refs, asset metadata and attachments, settings, and built-in aspect definitions. |
| SYNC-14 | Accepted | Yjs update history is dynamically subscribed for recently opened/edited entities and any entity with pending local body edits. Future snapshots replace replaying full history. |
| SYNC-15 | Accepted | Global and installed-view threads plus their most recent 200 messages are local by default. Entity threads subscribe on first open with a recent 50-message window; older chat history loads through API pagination. |
| SYNC-16 | Accepted | Local action data includes the current device Undo window, actions referenced by visible chat cards, and recent synchronized AI/MCP actions. Full audit remains server-side. |
| SYNC-17 | Accepted | PowerSync distributes asset metadata only. Binary content is fetched on demand or retained from local creation; a future explicit offline-download feature may pin assets. |
| SYNC-18 | Accepted | Opening an entity may create dynamic streams for its Yjs updates, entity thread, relevant action cards, and attachment metadata. Streams may remain warm briefly after navigation and then be released. |

## 3. Entity data model

| ID | Status | Decision |
|---|---|---|
| DATA-01 | Accepted | `entities` contains only common entity fields and the materialized Markdown body projection. It does not contain `tags`, `meta`, `aspects`, or `body_refs` collections. |
| DATA-02 | Accepted | `entity_aspects` stores one aspect per row. Aspect fields remain in JSONB `data`; there is no table per aspect type. |
| DATA-03 | Accepted | `entity_aspects` includes `schema_version`; its ID is deterministic from entity and aspect IDs; removal uses a tombstone; re-adding revives the same logical row. |
| DATA-04 | Accepted | Remove `entities.meta` completely. |
| DATA-05 | Accepted | `meta.import_ids` is replaced by universal `entity_origins`. |
| DATA-06 | Accepted | `meta.raw_input` belongs to the source chat message/action context, not to the entity. |
| DATA-07 | Accepted | Retroactive migration analyzes title, body, tags, current aspects, and relations against the known schema of a newly introduced aspect. Speculative extraction into permanent `meta` is removed. |
| DATA-08 | Accepted | Failed retroactive migration is a computed review state, not a system tag such as `needs-review`. |

## 4. Tags

| ID | Status | Decision |
|---|---|---|
| TAG-01 | Accepted | Tags provide free cross-domain themes and context. They do not replace aspects, financial categories, relations, or application state. |
| TAG-02 | Accepted | Add a `tags` registry with stable ID, owner, normalized name, display name, color, archive state, and timestamps. |
| TAG-03 | Accepted | `entity_tags` is a join table between entities and registered tags. It contains a deletion tombstone. |
| TAG-04 | Accepted | Unicode and spaces are allowed. Matching normalization is Unicode NFKC, trim, lowercase, and collapsed repeated whitespace. No automatic translation is performed. |
| TAG-05 | Accepted | Renaming a tag does not rewrite entity links. Renaming into an existing normalized name becomes an explicit merge operation. |
| TAG-06 | Accepted | Archiving a tag hides it globally but preserves its entity links so restoration restores the classification. |
| TAG-07 | Accepted | System state is not encoded as tags. |
| TAG-08 | Accepted | Tag color and display preferences live in the `tags` registry, not `user_settings.tag_preferences`. |

## 5. Origins and provenance

| ID | Status | Decision |
|---|---|---|
| ORIGIN-01 | Accepted | Use universal `entity_origins`, not a Budget-specific import table. |
| ORIGIN-02 | Accepted | An origin contains entity, namespace, external ID, optional namespaced context, owner, and creation time. `(owner, namespace, external_id)` is unique. |
| ORIGIN-03 | Accepted | Origins represent infrastructure-level provenance and external identity for CSV, bank APIs, calendars, GitHub, and future integrations. |
| ORIGIN-04 | Accepted | Origins are immutable. Undo of an import physically removes its origins so the source can be imported again. |

## 6. Relations and body references

| ID | Status | Decision |
|---|---|---|
| REL-01 | Accepted | Body links and semantic relations are separate concepts and separate tables. |
| REL-02 | Accepted | `entity_body_refs` is a derived projection parsed from Markdown entity links. It is not edited directly, has no tombstones, and is used for backlinks and AI context. |
| REL-03 | Accepted | Remove `entities.body_refs` and do not create `related_to` relations from body links. |
| REL-04 | Accepted | `relations` contains explicit semantic facts only: `parent`, `blocks`, `related_to`, and `derived_from`. |
| REL-05 | Accepted | Remove `relations.meta`; action history records who created or changed a relation. |
| REL-06 | Accepted | Relation IDs are deterministic from source, relation type, and target. Re-creation clears the tombstone of the same logical fact. |
| REL-07 | Accepted | `related_to` is symmetric and canonicalizes the two entity UUIDs before ID generation. Other relation types remain directed. |
| REL-08 | Accepted | Relation deletion uses a tombstone. |

## 7. Body and Yjs

| ID | Status | Decision |
|---|---|---|
| BODY-01 | Accepted | Canonical editable body content is Markdown stored in `Y.Text`, not a rich-text document tree. |
| BODY-02 | Accepted | The MVP editor is Markdown-oriented. A concrete editor library remains open; adopting Tiptap/ProseMirror as the storage schema is rejected for MVP. |
| BODY-03 | Accepted | Yjs updates are persisted as append-only `entity_body_updates` rows and delivered through PowerSync. Do not add a second `y-indexeddb` persistence layer. |
| BODY-04 | Accepted | `entities.body` is a materialized Markdown projection for search, AI context, query blocks, previews, and body-reference extraction. It is not edited directly. |
| BODY-05 | Accepted | Editor Undo/Redo uses `Y.UndoManager` and is separate from domain History Manager. Ordinary typing does not create domain actions. |
| BODY-06 | Accepted | Updates are batched with a short debounce and flushed on relevant editor lifecycle events. |
| BODY-07 | Accepted | MVP uses normal PowerSync delivery without presence, live cursors, or a separate collaborative WebSocket provider. |
| BODY-08 | Accepted | Start without Yjs compaction. Add snapshots and safe update pruning after measured thresholds justify it. |
| BODY-09 | Accepted | After each debounced editor update, the client optimistically derives Markdown, body refs, and body asset refs in the same local SQLite transaction as the Yjs update so local UI and search update immediately. |
| BODY-10 | Accepted | Client-derived body projections are not authoritative. The Bun service applies each accepted Yjs update to the canonical Y.Doc and recomputes Markdown and derived refs in the same PostgreSQL transaction. |
| BODY-11 | Accepted | Client and server use the same Markdown parser/projection package. The server serializes updates per entity and may keep a bounded short-lived Y.Doc cache; on cache miss it reconstructs from persisted updates until snapshots are introduced. |
| BODY-12 | Accepted | PowerSync distributes canonical `entities.body`, `entity_body_refs`, and `entity_body_asset_refs` to other devices. Projection discrepancies reconcile to the server result. |

## 8. Assets and attachments

| ID | Status | Decision |
|---|---|---|
| FILE-01 | Accepted | File support is a core infrastructure capability, not data owned by a view. |
| FILE-02 | Accepted | Binary data is stored in private object storage; PowerSync synchronizes metadata only. Supabase Storage is the current intended provider. |
| FILE-03 | Accepted | `assets` stores file metadata and lifecycle state. `entity_attachments` explicitly attaches assets to entities. |
| FILE-04 | Accepted | `entity_body_asset_refs` is a derived projection of `asset:<id>` Markdown references. |
| FILE-05 | Accepted | Files selected offline are retained locally in OPFS and uploaded/resumed when the network returns. Unsynced user files are never evicted automatically. |
| FILE-06 | Accepted | Previously uploaded local copies are a cache and may be evicted under storage pressure. |
| FILE-07 | Accepted | MVP previews images and PDFs. Video and other allowed formats are downloadable without requiring advanced preview or processing. |
| FILE-08 | Accepted | Signed URLs, MIME/size/hash validation, private storage, and delayed orphan garbage collection are required. |
| FILE-09 | Accepted | Undoing an attachment removes the attachment, not necessarily the asset. An asset is garbage-collected only when it has no active attachment/body references or upload session and its retention window has elapsed. |

## 8A. Deletion semantics

| ID | Status | Decision |
|---|---|---|
| DELETE-01 | Accepted | `entities.archived` is a user-visible reversible state. Entities are not physically deleted in MVP. |
| DELETE-02 | Accepted | `deleted_at` is an implementation field; when retained after logical deletion it acts as a technical tombstone, not as user-visible archive state. |
| DELETE-03 | Accepted | `entity_aspects`, `entity_tags`, `relations`, and `entity_attachments` use tombstones to prevent stale offline intent from reviving deleted logical facts. |
| DELETE-04 | Accepted | `entity_origins` are immutable and physically removed only by Undo/controlled cleanup rather than tombstoned. |
| DELETE-05 | Accepted | Derived projections such as `entity_body_refs` and `entity_body_asset_refs` are rebuilt from canonical body content and can be physically removed immediately; they do not need tombstones or History actions. |

## 9. Commands, actions, Undo, and Redo

| ID | Status | Decision |
|---|---|---|
| HIST-01 | Accepted | Action history is a dedicated subsystem. It is not stored in `chat_messages.metadata`. |
| HIST-02 | Accepted | One command or atomic batch produces one action containing typed `before/after` changes. Inverse operations are derivable from those transitions. |
| HIST-03 | Accepted | Implement a small Orbis History Manager with `execute`, `undo`, `redo`, and `prune`; do not adopt Redux/MobX history as canonical persistence. |
| HIST-04 | Accepted | History is an immutable action graph within a bounded retention window, plus a mutable local `history_head`. Strict eternal append-only storage was superseded. |
| HIST-05 | Accepted | Each action references its parent. Undo moves the device head to the parent; Redo moves it to the selected child. A new command after Undo creates a new branch and makes the old redo branch unavailable. |
| HIST-06 | Accepted | Domain Undo/Redo is local to the current device's history stack. Body Undo/Redo remains in Yjs. |
| HIST-07 | Accepted | AI and MCP actions can be reverted explicitly from their result cards. Chat command “undo last” acts on eligible synchronized global history, not an unavailable offline action from another device. |
| HIST-08 | Accepted | A batch is one history item and is applied or rejected atomically. |
| HIST-09 | Accepted | Rejected optimistic actions disappear from the valid Undo chain and remain only as diagnostics/outcomes. |
| HIST-10 | Accepted | The server stores canonical actions; `action_entities` records affected entities for authorization and future sharing. Local `history_heads` do not synchronize. |
| HIST-11 | Accepted | `command_receipts` provides idempotency beyond the retention period of full action payloads. |

## 10. Ownership, sharing, and security direction

| ID | Status | Decision |
|---|---|---|
| AUTH-01 | Accepted | Use `owner_id` where a row represents ownership and `actor_user_id` where it represents the initiator. Avoid ambiguous `user_id` names for those meanings. |
| AUTH-02 | Accepted | Entity-owned synchronized child rows denormalize `owner_id` to simplify PowerSync streams, RLS, indexes, and same-owner foreign keys. |
| AUTH-03 | Accepted | In MVP, access means `owner_id = auth.uid()`. The client cannot choose the authoritative owner; it is derived from the verified identity. |
| AUTH-04 | Accepted | Future sharing adds a general access/membership layer without changing ownership semantics. `owner_id` remains the owner. |
| AUTH-05 | Accepted | A relation is visible only when the viewer can access both endpoints; editing requires sufficient access to both. |
| AUTH-06 | Accepted | MCP PATs live in a server-only `agent_tokens` table as hashes with prefix, scopes, timestamps, and revocation metadata. Raw tokens are shown once and never persisted. |
| AUTH-07 | Accepted | PowerSync download authorization uses the verified Supabase subject and direct `owner_id` filters for MVP. Denormalized owner fields are treated as authorization data and protected by same-owner foreign keys/server writes. |
| AUTH-08 | Accepted | The Bun upload/API path verifies JWT signature, issuer, audience, expiry, and subject; it derives actor/owner context and ignores authoritative ownership values supplied by the client. |
| AUTH-09 | Accepted | Normal Bun request transactions use a PostgreSQL role without `BYPASSRLS` and install verified identity transaction-locally so RLS is exercised on the real application path. Migration, cleanup, and projection workers use separate privileged credentials. |
| AUTH-10 | Accepted | A phase-zero integration spike must prove Bun JWT verification, transaction-local `auth.uid()`, pooled connection isolation, cross-user RLS rejection, PowerSync identity consistency, and absence of service-role use in ordinary requests. |
| AUTH-11 | Accepted | MCP PAT authorization is scope-based from the first schema version. Scopes are stored server-side in `agent_tokens`, not encoded as immutable claims in the raw token, so they can be changed or revoked. |
| AUTH-12 | Accepted | MVP issues one token with `entities:read`, `entities:write`, `chat:read`, `actions:revert`, and `assets:read`. Token/permission management and destructive asset scopes are not granted to ordinary MCP tools. |
| AUTH-13 | Accepted | MCP read results are minimized: queries return compact projections; full body/thread/asset metadata requires explicit tools. Binary assets require scoped, short-lived signed URLs. |
| AUTH-14 | Accepted | MCP request rate, query cost, mutation count, AI use, and asset downloads are metered separately. Rate limits protect infrastructure; entitlements define allowed product usage. |

## 11. Aspect registry and views

| ID | Status | Decision |
|---|---|---|
| ASP-01 | Accepted | `aspect_definitions` remains a universal JSON Schema registry. `entity_aspects` stores `schema_version`. |
| ASP-02 | Accepted | MVP exposes only built-in aspects. User-created custom aspects and schema editing UI are deferred. |
| ASP-03 | Accepted | Built-in aspect migrations are deterministic TypeScript migrations covered by fixtures. |
| ASP-04 | Accepted | Future custom aspects require draft/publish versions, compatibility classification, migration preview, and deterministic migration chains. Declarative migration storage is deferred until custom aspects are implemented. |
| ASP-05 | Accepted | The generic renderer reads JSON Schema plus `ui_schema`. |
| VIEW-01 | Accepted | View IDs and aspect IDs are distinct. A view declares required aspects but does not own them. |
| VIEW-02 | Accepted | First-party views may add registered commands, validators/invariants, read models, and specialized UI, but no private domain tables. |
| VIEW-03 | Accepted | Initial installable generic views are declarative and cannot execute arbitrary backend code. Sandboxed backend extensions are deferred with marketplace work. |

## 12. Chat

| ID | Status | Decision |
|---|---|---|
| CHAT-01 | Accepted | Persistent thread scopes are `global`, `entity`, and `view`. |
| CHAT-02 | Accepted | There is one deterministic thread per owner and scope. Budget receives its own persistent view thread. |
| CHAT-03 | Accepted | Current screen, period, and filter state are per-message runtime context, not persistent thread identity. |
| CHAT-04 | Accepted | Uninstalling a view hides but does not delete its thread. Reinstalling restores the thread. |
| CHAT-05 | Accepted | Chat messages may reference actions for result cards but do not store the action journal. |
| CHAT-06 | Accepted | Offline AI messages use a separate local queue. Fast-path commands do not enter the AI queue. |
| CHAT-07 | Accepted | Canonical chat messages are append-only after creation. |
| CHAT-08 | Accepted | Known presentation fields such as action references, cards, suggestions, and model identity use explicit/versioned message fields rather than becoming an unbounded action journal inside generic metadata. |

## 12A. LLM integration

| ID | Status | Decision |
|---|---|---|
| AI-01 | Accepted | Orbis exposes its own application-level `LlmProvider`/AI gateway interface, implemented internally on top of Vercel AI SDK Core. Application and domain packages do not depend directly on AI SDK types. |
| AI-02 | Accepted | Vercel AI SDK Core provides normalized provider/model adapters, `generateText`/`streamText`, structured output, streaming events, tool-call protocol, provider errors, cancellation, and usage data. |
| AI-03 | Accepted | Orbis owns model routing, prompt/context construction, memory selection, tool registry, command execution, confirmation policy, persistence, audit links, entitlements, and durable metering. These responsibilities are not delegated to AI SDK. |
| AI-04 | Accepted | Anthropic is the initial/default provider through the corresponding AI SDK provider package. Model IDs and routing rules remain runtime configuration rather than PRD constants. |
| AI-05 | Accepted | Orbis tool definitions are adapted to AI SDK tools from the canonical tool registry. AI SDK input validation and strict mode, where supported, are additional checks; the Orbis executor always revalidates calls authoritatively. |
| AI-06 | Accepted | AI SDK tool approval events may transport approval requests, but Orbis policy decides whether confirmation is required and Orbis UI/persistence owns the approval lifecycle. |
| AI-07 | Accepted | Multi-step loops have explicit Orbis limits for steps, tool calls, time, and token/cost budget. Provider/SDK defaults are not the product safety boundary. |
| AI-08 | Open | Whether the web client uses AI SDK UI (`useChat` and its stream protocol) or a thin Orbis-specific tRPC/SSE transport remains undecided. This does not change the server-side AI SDK Core decision. |
| AI-09 | Accepted | Confirmation level is determined by Orbis policy after tool-call validation, never by the model. The policy result is `execute`, `preview`, `explicit-confirmation`, or `forbidden`. |
| AI-10 | Accepted | Policy inputs include explicit versus inferred intent, reversibility, scope (`single`, `bounded`, `bulk`), external side effects, and sensitivity. Explicit, bounded, reversible internal actions may execute immediately and show Undo. |
| AI-11 | Accepted | Bulk, ambiguous, inferred, structurally consequential, or high-impact internal changes require a preview. External irreversible actions, permission changes, PAT lifecycle changes, file destruction, and third-party data release require explicit confirmation or remain unavailable in MVP. |
| AI-12 | Accepted | MCP applies the same policy with a stricter default. Read tools and scoped single reversible writes may execute; bulk/ambiguous actions return `confirmation_required`. |
| AI-13 | Accepted | A pending approval stores the exact immutable command payload, actor/source, affected entities, preview, expiry, and state/version assumptions. Approval executes that stored command, not a regenerated model call. |
| AI-14 | Accepted | Before approved execution, the server revalidates current state. If assumptions changed, the approval is invalidated and a new preview is required. |

## 13. Validation and invariants

| ID | Status | Decision |
|---|---|---|
| INV-01 | Accepted | Local executor validates command shape, aspect schema, deterministic normalization, and invariants against known local state before an optimistic transaction. |
| INV-02 | Accepted | Server executor repeats validation against canonical state and is authoritative for ownership, current schema, cross-row invariants, entitlements, idempotency, and batch atomicity. |
| INV-03 | Accepted | PostgreSQL RLS, foreign keys, checks, and unique constraints protect authorization and simple critical integrity even if application code fails. |
| INV-04 | Accepted | Complex domain rules such as graph cycle detection stay in executor code rather than being forced into opaque SQL triggers. |
| INV-05 | Accepted | Server technical normalization is allowed; silent changes to user meaning are not. |
| INV-06 | Accepted | A rejected command is all-or-nothing and yields a structured, user-visible explanation. |

Examples of accepted invariants include aspect schema validity, exact decimal format, schedule end not before start, one live aspect row per entity/type, one live entity/tag link, one budget parent, acyclic `blocks`, same-owner relation endpoints, atomic batches, idempotent command IDs, and unique origins.

## 14. Retention and cleanup defaults

These are operational defaults rather than permanent product promises.

| ID | Status | Decision |
|---|---|---|
| RET-01 | Accepted | Device Undo stack: last 100 actions or 30 days. |
| RET-02 | Accepted | Full server audit actions: 90 days; rejected command diagnostics: 30 days; command receipts: 180 days. |
| RET-03 | Accepted | Tombstones for aspects, entity-tag links, relations, and attachments: 90 days. |
| RET-04 | Accepted | A device offline longer than the supported tombstone window performs full reconciliation rather than trusting stale state. |
| RET-05 | Accepted | Chat messages have no automatic server deletion in MVP. Local windows are bounded and older history loads through API pagination. |
| RET-06 | Accepted | Pending uploads without activity: 7 days; failed uploads: 30 days; orphan ready assets: 30 days; deleted asset metadata/tombstones: 90 days. |
| RET-07 | Accepted | Yjs updates are retained until snapshot/compaction is implemented and proven safe. |
| RET-08 | Accepted | Add a server-side `devices` registry for last-seen diagnostics, revocation, and full-reconciliation decisions. |

## 14A. PWA and future native shell

| ID | Status | Decision |
|---|---|---|
| PLATFORM-01 | Accepted | MVP remains a React PWA. Infrastructure-specific browser APIs are hidden behind platform adapters rather than imported by feature/domain code. |
| PLATFORM-02 | Accepted | Define adapters for the PowerSync database factory, local file storage, app lifecycle, singleton/background coordination, secure storage, cache management, and future notifications. |
| PLATFORM-03 | Accepted | Web uses PowerSync Web with an OPFS/WASM implementation selected by compatibility testing, plus OPFS for pending/local asset data. Feature code does not depend directly on OPFS paths or Web Worker APIs. |
| PLATFORM-04 | Accepted | Correctness does not depend on service workers or Background Sync. The service worker owns app-shell/network caching and update lifecycle only. |
| PLATFORM-05 | Accepted | The preferred future path that preserves the React DOM UI is a Capacitor/WebView shell using PowerSync Capacitor/native SQLite and a native file-store adapter. Capacitor is not an MVP dependency. |
| PLATFORM-06 | Accepted | A native installation is treated as a new device: it creates a fresh local SQLite and restores synchronized state through PowerSync rather than attempting to copy the PWA OPFS database. |
| PLATFORM-07 | Accepted | Unsynchronized commands, Yjs updates, queued AI messages, and pending local assets require an explicit migration/export path or must be synchronized before switching shells. Silent loss is prohibited. |
| PLATFORM-08 | Accepted | The PWA diagnostics UI exposes pending local state and supports a future encrypted export/transfer package. Exact transfer UX and format are deferred until a native shell is planned. |
| PLATFORM-09 | Accepted | Domain commands, query parser/AST, History Manager, Yjs model, backend contracts, and PowerSync schema remain platform-independent. React Native is a possible but more expensive future path because it requires a UI rewrite. |

## 15. Query engine

| ID | Status | Decision |
|---|---|---|
| QUERY-01 | Accepted | Use one parser and typed AST. Compile to PostgreSQL SQL on the server and SQLite SQL on the PowerSync client. The old JS-over-IndexedDB evaluator is superseded. |
| QUERY-02 | Accepted | Query field types come from aspect JSON Schema, never value-name or content heuristics. |
| QUERY-03 | Accepted | Support fully qualified aspect fields as an unambiguous form. |
| QUERY-04 | Accepted | In MVP, SQLite narrows candidates by non-decimal predicates; exact decimal comparison, ordering, ranges, and aggregation run in TypeScript with `decimal.js`, and `limit` is applied afterward. PostgreSQL uses exact `numeric`. Shared fixtures must prove equivalent results. |
| QUERY-05 | Open | Index/projection strategy for high-volume aspect fields remains measurement-driven. No universal typed-value index has been accepted. |
| QUERY-06 | Accepted | Use SQLite/PowerSync indexes and JSON expression indexes for measured non-decimal predicates first. A financial or generic field projection is added only after profiling proves it necessary; such a projection optimizes an aspect, not a view. |

## 15A. Testing strategy

| ID | Status | Decision |
|---|---|---|
| TEST-01 | Accepted | Vitest covers pure domain logic, typed commands, local/server validators, History Manager, query parser/AST, decimal behavior, aspect migrations, Yjs projection functions, AI confirmation policy, and provider/tool adapters with fakes. |
| TEST-02 | Accepted | PostgreSQL integration tests and pgTAP cover transactions, constraints, RLS, same-owner integrity, command idempotency/receipts, executor rejection, and privileged-worker separation. |
| TEST-03 | Accepted | Playwright covers real browser PowerSync SQLite/OPFS behavior, offline reload, multiple browser contexts as devices, service-worker updates, storage pressure behavior where testable, asset upload interruption, and end-to-end workflows. |
| TEST-04 | Accepted | Most synchronization tests use a deterministic fake connector/server so they are fast and reproducible. A separate integration suite exercises a real PowerSync environment and Sync Streams. |
| TEST-05 | Accepted | Shared fixture corpora prove PostgreSQL/SQLite query parity, exact decimal results, conflict/tombstone behavior, deterministic IDs, command acceptance/rejection reconciliation, Yjs convergence, and projection parity. |
| TEST-06 | Accepted | Real LLM provider calls are excluded from deterministic CI. AI flows use fake AI SDK models/providers; a separately gated smoke test may call the configured provider under a strict spend limit. |
| TEST-07 | Accepted | Release-gate scenarios include offline create/edit/reload/reconnect, two-device aspect edits, non-resurrection after tombstones, rejected optimistic command reconciliation, atomic multi-table batches, lost-response idempotency, branched Undo/Redo, offline Yjs convergence/projections, PostgreSQL/SQLite query parity, exact decimal behavior, cross-user isolation, interrupted asset upload, AI validation/approval/actions, MCP scopes/approval, and PWA update preservation. |
| TEST-08 | Accepted | Every merge runs format, lint, strict typecheck, unit tests, query parity, PostgreSQL integration, pgTAP RLS, deterministic fake-PowerSync tests, production builds, and a Playwright smoke suite. |
| TEST-09 | Accepted | Production release additionally requires real PowerSync/Sync Streams tests, full multi-device Playwright, WebKit/iOS-oriented checks, a gated real-provider AI smoke test, and migration tests from the previous supported server/local schema. |

## 15B. Deployment topology

| ID | Status | Decision |
|---|---|---|
| DEPLOY-01 | Accepted | Use PowerSync Cloud for MVP rather than self-hosting the synchronization service. |
| DEPLOY-02 | Accepted | Preserve portability: endpoints/credentials are configuration, Sync Streams are versioned in the repository, command upload belongs to the Bun API, product flows do not depend on proprietary management APIs, and infrastructure metrics sit behind an Orbis adapter. |
| DEPLOY-03 | Accepted | MVP topology is a static PWA host, one persistent OCI-compatible Bun API service, Supabase Auth/PostgreSQL/Storage, and PowerSync Cloud. |
| DEPLOY-04 | Accepted | Concrete PWA/API hosting providers are selected by a deployment spike covering region latency, IPv6 or session-pool connectivity, persistent container behavior, logs, secret management, backups, and cost. |
| DEPLOY-05 | Accepted | Keep a documented path to self-hosted PowerSync, including configuration, Sync Stream deployment, monitoring requirements, and migration/export procedure; implementing it is not MVP work. |

## 15C. Observability and recovery

| ID | Status | Decision |
|---|---|---|
| OBS-01 | Accepted | All major operations propagate safe correlation identifiers such as request, command, action, device, actor, entity, thread, and provider request IDs where applicable. |
| OBS-02 | Accepted | Logs and telemetry exclude body text, prompts, CSV rows, Yjs update payloads, PAT secrets, signed URLs, and file contents by default. |
| OBS-03 | Accepted | Initial operational metrics cover API latency/errors, PowerSync state/lag, command acceptance/rejection/retry and pending age, idempotent duplicate hits, Yjs projection failures, query duration/candidate count, AI usage/tool errors, asset upload state, local migration failures, RLS denials, and suspicious PAT activity. |
| OBS-04 | Accepted | User diagnostics expose device ID/last seen, PowerSync state, last successful sync, pending/rejected commands, pending AI messages/assets, local application/schema version, and an exportable redacted diagnostic report. |
| OBS-05 | Accepted | Recovery supports retry, auth refresh, asset resume, acknowledged-outcome cleanup, device revocation, encrypted pending-data export, and mirror rebuild only when no local pending data exists. Automatic SQLite/OPFS clearing is prohibited. |
| OBS-06 | Accepted | Define an application telemetry adapter with OTel-compatible span, metric, error, context, and attribute semantics so domain/application code does not depend on a vendor SDK. |
| OBS-07 | Accepted | MVP uses structured JSON logging, correlation IDs, web/API error tracking, hosting/PowerSync/Supabase native metrics, and safe application events. It does not deploy a full OpenTelemetry Collector plus traces/metrics/logs storage stack. |
| OBS-08 | Accepted | OpenTelemetry instrumentation and a Collector/managed tracing backend may be introduced after measured sync/AI debugging needs justify sampling, retention, privacy review, dashboards, and cost. |

## 15D. Technical MVP boundary

| ID | Status | Decision |
|---|---|---|
| MVP-01 | Accepted | MVP implements PowerSync Cloud command upload, offline entity/aspect/tag/relation CRUD, local/server invariants, History Manager Undo/Redo, Yjs Markdown without compaction, origins, PostgreSQL/SQLite queries, RLS/ownership, diagnostics, Vercel AI SDK integration, and MCP with one scoped PAT. |
| MVP-02 | Accepted | Attachments are in MVP after the first Core OS vertical slice: offline attach, resumed upload, image/PDF preview, safe download for other allowed types, detail attachments, and body asset refs. OCR, video processing, and AI file analysis are excluded. |
| MVP-03 | Accepted | MVP does not offer a free-form global chat command “undo last”. It offers device-local Undo/Redo and explicit Undo/Revert on a specific AI/MCP action card or action ID. Global-last semantics are deferred until multi-device behavior is validated. |
| MVP-04 | Accepted | First dogfood keeps the whole core graph and all Yjs updates for the user's entities locally. Global/view chat keeps 200 recent messages; an entity thread loads on first open and then remains local; older chat history loads through API. Stream eviction is deferred until measured size requires it. |
| MVP-05 | Accepted | Action audit compaction is not implemented in MVP. Full action records remain for the 90-day retention window and are then deleted by cleanup. |
| MVP-06 | Accepted | Personal dogfood file safety uses MIME sniffing, size/type allowlists, private storage, and no inline rendering of SVG, HTML, executable, or otherwise active formats. Malware scanning or a stricter type ban is required before public registration. |
| MVP-07 | Accepted | Custom aspects/schema UI, sharing, native shell transfer, self-hosted PowerSync, Yjs compaction, offline pinning of cloud assets, marketplace backend sandbox, full OTel stack, advanced video preview, and PAT scope management UI remain deferred but preserve explicit architectural boundaries. |

## 16. Tables discussed and accepted conceptually

Exact DDL remains subject to schema review. The accepted conceptual tables are:

```text
Domain:
  entities
  entity_aspects
  tags
  entity_tags
  entity_origins
  relations

Body projections and CRDT:
  entity_body_updates
  entity_body_refs
  entity_body_asset_refs
  entity_body_snapshots        future, when compaction is introduced

Files:
  assets
  entity_attachments
  asset_uploads                optional server implementation detail

Commands and history:
  actions
  action_entities
  command_receipts
  command_outcomes
  history_heads                local only
  command_outbox               pending-only PowerSync upload

Chat and AI:
  chat_threads
  chat_messages
  pending_ai_messages          local only
  ai_usage                     server only

System:
  aspect_definitions
  user_settings
  agent_tokens                 server only
  devices                      server only/settings API
```

## 17. Open decisions and required spikes

These items were not accepted and must not be inferred from the discussion:

1. Exact browser SQLite VFS and Safari/iOS compatibility behavior.
2. Exact Markdown editor library and Yjs binding.
3. Yjs snapshot format, thresholds, and safe update deletion protocol.
4. Exact DDL, index set, and RLS policies for the conceptual schema.
5. Exact semantics and UX of global chat “undo last” when actions originate on multiple devices.
6. Concrete hosting providers for PWA, Bun API, and observability.
7. Asset size/type limits, resumable upload protocol, and malware scanning requirements.
8. Whether `action_entities` should be synchronous canonical data or a derived projection.
9. Whether full action payloads are compacted into separate summaries after Undo retention.
10. Whether the web chat transport uses AI SDK UI or an Orbis-specific tRPC/SSE protocol.
11. Exact encrypted export/transfer format for unsynchronized state when introducing a native shell.

## 18. Required PRD amendments

The current PRD still contains incompatible decisions. Before implementation planning it must be updated to:

- replace embedded `tags`, `meta`, `aspects`, and `body_refs` with normalized tables;
- remove `entities.meta`, `raw_input`, `import_ids`, and meta-based retroactive migration;
- replace body last-write-wins/conflict copies with Yjs updates and Markdown projection;
- replace actions in `chat_messages.metadata` with dedicated actions/history;
- add tags registry, origins, assets/attachments, body refs, body asset refs, command receipts/outcomes, PAT tokens, and devices;
- replace hand-written revision/cursor conflict semantics with PowerSync plus command-based upload;
- describe local device Undo/Redo and explicit AI/MCP action revert behavior;
- change ambiguous ownership fields from `user_id` to `owner_id`/`actor_user_id` where appropriate;
- add view-scoped chat threads;
- revise query storage paths for normalized aspects/tags and PostgreSQL/SQLite compilation;
- remove system tags used as hidden state;
- document retention and the supported offline window.
