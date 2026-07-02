# Orbis Implementation Foundation - 02: Offline and Sync

| Field | Value |
|---|---|
| Date | 2026-06-13 |
| Status | Superseded draft - do not use |
| Normative source | Superseded; use `00-decision-ledger.md` |

This early custom-sync/Dexie draft is incompatible with the accepted PowerSync command-upload design. It will be rewritten and must not guide implementation.

## 1. Goal and non-goals

The local client must remain useful without network access and converge across a small number of devices when network returns. The design implements the exact PRD conflict matrix. It does not attempt collaborative text editing, arbitrary CRDT merging, or guaranteed background execution while the PWA is closed.

## 2. Client database

Dexie stores server mirrors and client-only control data.

### 2.1 Mirrored stores

| Store | Notes |
|---|---|
| `entities` | Server row plus nullable `server_revision`, local delivery state |
| `relations` | Includes tombstones |
| `aspect_definitions` | Built-ins plus user definitions |
| `user_settings` | One cached row |
| `chat_threads` | Global, opened entity threads, and recent threads |
| `chat_messages` | Recent/open thread window and audit messages required for Undo |

### 2.2 Client-only stores

| Store | Purpose |
|---|---|
| `outbox` | Ordered actions/diffs waiting for server acknowledgement |
| `entity_bases` | Last acknowledged server state for dirty entities |
| `relation_bases` | Last acknowledged server state for dirty relations |
| `sync_state` | Device ID, pull cursor, last attempt/success, backoff, diagnostics |
| `ai_queue` | User messages waiting for network/AI availability |
| `action_index` | Local projection for fast Undo lookup; reconstructable from audit messages |
| `app_meta` | Local schema version, seed state, migration markers |

The outbox is required even though PRD describes `synced_at`: a nullable timestamp alone cannot preserve action boundaries, batch atomicity, idempotency, ordering, or a rejected-operation diagnostic. `synced_at` remains a derived compatibility field on mirrored rows.

## 3. Local mutation transaction

An offline-capable mutation executes entirely inside one Dexie transaction:

1. Read affected rows and base snapshots.
2. Validate the command and local invariants.
3. Apply current-state row changes.
4. Create base snapshots for rows that were previously clean.
5. Append one outbox action with ordered operations and base revisions.
6. Append/update the local action projection and inverse.
7. Commit, causing subscribed UI to update.

Network calls are never awaited inside the transaction. Dexie documents that IndexedDB transactions auto-commit when the event loop leaves active database work; mixing fetch into the scope would make atomicity unreliable.

## 4. Outbox model

Each outbox record contains:

- `action_id` and idempotency key;
- monotonically increasing local sequence for this device;
- actor and source metadata;
- one operation or an ordered atomic group;
- affected row IDs and their `base_server_revision` values;
- explicit state diffs, including deletions;
- inverse operations for local rollback/rebase diagnostics;
- status: pending, sending, rejected, or acknowledged;
- retry metadata and last structured error.

Only one sync leader sends a given device outbox. Server idempotency remains mandatory because browser retries, tab crashes, and lost responses can still duplicate transport attempts.

## 5. Sync cycle

A cycle has four stages:

1. Acquire a cross-tab sync lease.
2. Push pending actions in local sequence order.
3. Pull all server rows after the current revision cursor, with pagination.
4. Apply acknowledgements, pulled rows, cursor movement, and pending-action rebase in one or more bounded Dexie transactions.

Push happens before pull as required by the PRD. A final pull is still required after a successful push because server execution may create audit messages, conflict copies, relations, recurring instances, or normalized values not present in the submitted diff.

The server processes an atomic action in one PostgreSQL transaction:

1. authenticate actor and resolve user;
2. acquire the transaction-level per-user advisory lock;
3. return the stored result if the idempotency key already exists;
4. validate current server state and all operations;
5. apply merge rules and domain invariants;
6. assign revisions to every changed sync row;
7. append the permanent action/audit message;
8. commit before returning the result.

## 6. Pull cursor and pagination

The pull response contains rows ordered by `server_revision`, a response high-water mark, and a continuation token when capped. The client advances `last_server_revision` only after the corresponding rows have committed to IndexedDB.

When a response is paginated, the cursor advances to the last committed row of each page, not to a server maximum that the client has not received. Empty pages may advance only to an explicitly returned safe high-water mark produced under the same server ordering rules.

All syncable tables participate in one revision order. The client dispatches rows by table type but preserves cursor semantics globally.

## 7. Merge and rebase

The implementation follows PRD 01 section 5.2 exactly:

- scalar and atomic-array conflicts use later server application order;
- `meta` merges by key;
- `meta.import_ids` merges element operations;
- aspects merge by aspect ID as atomic values;
- body conflicts create an archived conflict copy;
- relations use row tombstones;
- messages merge by ID.

After pull, a dirty local row cannot simply be overwritten. The client performs a rebase:

1. Treat the pulled row as the new acknowledged base.
2. Remove operations acknowledged by the server.
3. Replay still-pending local diffs in local sequence order using the same merge semantics.
4. Replace the visible local row with the replay result.
5. Update its stored base and delivery markers.

This makes foreground UI represent `latest acknowledged server state + pending local intent`.

If the server rejects an action due to a concurrent invariant, the client removes that action from replay, rebuilds affected rows from the new base plus later pending actions, and creates a visible error card. It must not blindly execute the old inverse against a row that may have later local edits.

## 8. Conflict copies

The server creates the canonical body conflict copy because it knows the accepted ordering and can make creation atomic with the winning update. Its ID is deterministic from original entity ID, losing action ID, and conflict kind so a retry cannot create duplicates.

The response and subsequent pull include both the winning entity and conflict copy. A client may show a temporary conflict indicator before pull, but it does not invent a second permanent copy.

## 9. Atomic batches and Undo

An outbox record preserves a `batch_execute` group as one action. The server either accepts all operations or none. A successful retry returns the original stored result.

Undo is a new command, not local history manipulation. It references the original action ID and submits its stored inverse operations through the same executor. Offline Undo can run against the local action projection and enter the outbox; server acceptance remains authoritative.

The client must retain enough audit data for the PRD promise `Undo last action` even if ordinary chat history is partially mirrored. At minimum, non-undone actions and undo markers for the configured Undo window remain local. Eviction of chat content cannot evict required action metadata.

## 10. Sync triggers

Authoritative foreground triggers:

- successful sign-in/session restoration;
- application start after local database migration;
- transition to online;
- page visibility/focus return;
- debounce after a local mutation;
- periodic timer while an authenticated tab remains visible;
- explicit retry from sync diagnostics.

Best-effort triggers:

- service worker Background Sync where supported;
- service worker wake caused by application update or fetch activity.

Retries use exponential backoff with jitter. Authentication errors pause sync until session refresh. Validation or invariant errors are not retried unchanged. Network and server-unavailable errors are retried.

## 11. Multi-tab coordination

One tab is elected sync leader with the Web Locks API where available. A lease with heartbeat and expiry is the fallback. BroadcastChannel announces sync completion, auth changes, and update readiness, while Dexie change observation refreshes actual data.

Correctness cannot depend on perfect leader election. Duplicate leaders remain safe because every action is idempotent and server user locks serialize commits.

## 12. Recurring materialization

Materialization is a system command produced before a query that needs a date range. It:

- resolves dates using the template IANA zone or user zone;
- caps the future horizon at 14 days;
- generates deterministic UUIDv5 instance IDs;
- creates only missing instances;
- records `derived_from` relations in the same atomic action;
- is idempotent locally and on the server.

When two devices materialize the same instance offline, identical IDs converge. The server merges equivalent creation and rejects incompatible payloads as a structured deterministic-ID collision, which is treated as a bug rather than a user conflict.

Financial planned-to-fact posting is another deterministic system command keyed by instance ID. It may run on app/query lifecycle; no cron is required for MVP correctness.

## 13. AI offline queue

An offline LLM message is persisted separately from `chat_messages` until sent. The UI displays it as queued, allows cancellation, and does not pretend an assistant response exists.

On network recovery:

1. queued messages are sent in thread order;
2. each request has an idempotency key;
3. resulting user/assistant/tool messages are stored server-side;
4. sync pulls canonical messages and action results;
5. queue entries are removed only after acknowledgement.

Fast-path commands never enter the AI queue.

## 14. Recovery and diagnostics

The settings diagnostics screen exposes:

- device ID;
- last successful sync and cursor;
- pending/rejected action counts;
- last structured error;
- local database version;
- a user-initiated export of local diagnostic metadata without entity bodies.

Recovery actions are additive and explicit: retry, refresh auth, export diagnostics, or rebuild the local mirror after confirming no pending actions. Automatic clearing of IndexedDB is prohibited.

## 15. Required parity fixtures

The sync package ships shared fixtures covering:

- every cell of the conflict matrix;
- clock skew;
- response lost after server commit;
- pull pagination and crash before cursor commit;
- two tabs sending one outbox;
- concurrent budget-parent assignment;
- body conflict copy idempotency;
- batch rejection and replay of later pending actions;
- recurring materialization on two offline devices;
- exact decimal values through push, PostgreSQL JSONB, and pull.
