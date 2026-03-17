# ORBIS

Database Schema — Technical Specification

| **Field**  | **Value**                        |
|------------|----------------------------------|
| Version    | 1.0                              |
| Date       | March 2026                       |
| Stack      | PostgreSQL (Supabase) + Drizzle  |
| Parent Doc | Orbis Data Model v3.1            |

---

# 1. Overview

This document translates the Orbis Data Model v3.1 into concrete PostgreSQL tables, Drizzle ORM schema definitions, indexes, constraints, and Row Level Security (RLS) policies. It is the implementation-ready companion to the conceptual data model.

## 1.1 Design Principles

- **JSONB-heavy**: aspects and meta are dynamic JSONB columns. Body is a markdown text field with extension syntax. The schema is intentionally sparse — structured data lives inside JSONB, not in dedicated columns per aspect.
- **Offline-first friendly**: UUIDv7 primary keys (time-ordered, client-generated). `synced_at` for delta sync. No auto-increment IDs.
- **RLS from day one**: every table has row-level security policies. Supabase Auth provides `auth.uid()`.
- **Drizzle as source of truth**: schema defined in TypeScript. SQL migrations generated from Drizzle.

## 1.2 Tables

| Table                | Purpose                                              |
|----------------------|------------------------------------------------------|
| `entities`           | Core entity table. Every piece of data in Orbis.     |
| `relations`          | Typed links between entities.                        |
| `aspect_definitions` | Registry of available aspects (built-in + custom).   |
| `user_settings`      | Per-user preferences, targets, tag colors.           |
| `sync_log`           | Client sync cursors and conflict metadata.           |

**Reference data** (exercises, foods) is NOT stored in the database. Pre-seeded catalogs are client-side JSON files bundled with the frontend. User-created custom foods/exercises are regular entities with appropriate aspects. See section 9.

---

# 2. Drizzle Schema

## 2.1 entities

```typescript
import { pgTable, uuid, text, jsonb, timestamp, boolean, index } from 'drizzle-orm/pg-core';

export const entities = pgTable('entities', {
  id:         uuid('id').primaryKey(),                          // UUIDv7, client-generated
  userId:     uuid('user_id').notNull(),                        // FK → auth.users
  title:      text('title').notNull(),                          // Display name
  emoji:      text('emoji'),                                    // Visual identifier
  body:       text('body').notNull().default(''),                // Markdown with extensions (entity refs, query blocks)
  bodyRefs:   text('body_refs').array().notNull().default([]),    // Extracted entity UUIDs from body (for fast backlink queries)
  tags:       text('tags').array().notNull().default([]),        // AI-normalized tag array
  meta:       jsonb('meta').notNull().default({}),               // Unstructured parsed KV
  aspects:    jsonb('aspects').notNull().default({}),            // namespace/aspect_id → data
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  syncedAt:   timestamp('synced_at', { withTimezone: true }),    // NULL = pending sync
  archived:   boolean('archived').notNull().default(false),
}, (table) => ({
  // Indexes defined in section 3
}));
```

### Column Notes

- **id**: UUIDv7 generated client-side. Time-ordered: natural chronological sort by PK. Format: `018e4a2c-...` (timestamp prefix enables efficient range queries).
- **body**: Markdown string with custom extensions. Default empty string `''`. Extensions: `[[entity:uuid|Display Text]]` for inline entity references, `{{query: tags=backend, display=compact}}` for embedded entity query blocks. Standard markdown for formatting (headings, bold, lists, code). AI generates this format natively. Future: Lexical rich editor with markdown ↔ Lexical JSON migration.
- **bodyRefs**: Extracted array of entity UUIDs referenced in body (from `[[entity:uuid|...]]` syntax). Auto-computed on every save. Enables fast backlink queries via GIN index without parsing markdown.
- **tags**: PostgreSQL text array. AI normalizes to canonical English lowercase. Semantic dedup by AI (`cost`/`expense`/`spending` → always `expense`).
- **meta**: AI-extracted key-value data (proto-aspect layer). AI extracts structured data from user input before formal aspect activation. Keys match aspect schemas for easy migration (`meta.amount` → `orbis/financial.amount`). NOT for application state — board coordinates, view preferences belong in aspects. Smart list logic belongs in body as {{query:...}} blocks.
- **aspects**: JSONB map keyed by namespaced aspect ID. Example: `{"orbis/task": {"status": "inbox", "priority": "high"}, "orbis/schedule": {"start_at": "2026-03-16T08:00"}}`.

## 2.2 relations

```typescript
export const relations = pgTable('relations', {
  id:           uuid('id').primaryKey(),
  sourceId:     uuid('source_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  targetId:     uuid('target_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  relationType: text('relation_type').notNull(),               // parent | blocks | related_to | derived_from
  meta:         jsonb('meta').notNull().default({}),           // {source: 'body_ref', auto: true} for implicit
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueRelation: unique().on(table.sourceId, table.targetId, table.relationType),
}));
```

### Relation Types

| Type           | Meaning                          | Example                                    |
|----------------|----------------------------------|--------------------------------------------|
| `parent`       | source is parent of target       | Project → Task (tree hierarchy)            |
| `blocks`       | source blocks target             | Task A blocks Task B (dependency)          |
| `related_to`   | soft link between entities       | Explicit or implicit (from body refs)      |
| `derived_from` | target was generated from source | Recurring template → instance              |

### Constraint: No Self-Relations

```sql
ALTER TABLE relations ADD CONSTRAINT no_self_relation CHECK (source_id != target_id);
```

## 2.3 aspect_definitions

```typescript
export const aspectDefinitions = pgTable('aspect_definitions', {
  id:             text('id').primaryKey(),                      // Namespaced: "orbis/task", "user/sleep"
  userId:         uuid('user_id'),                              // NULL for built-in (orbis/*), user ID for custom
  name:           text('name').notNull(),                       // Display name: "Task", "Sleep Tracker"
  namespace:      text('namespace').notNull(),                  // "orbis", "user", or author name
  schema:         jsonb('schema').notNull(),                    // JSON Schema for aspect fields
  aiInstructions: text('ai_instructions'),                     // Prompt fragment for AI
  tagMappings:    text('tag_mappings').array().notNull().default([]),  // Tags that suggest this aspect
  aggregations:   jsonb('aggregations').default({}),            // How to aggregate for status strip
  viewConfig:     jsonb('view_config').default({}),             // Renderer hints for generic views
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Note: `status` (active/passive/inactive) is NOT on this table. It is per-user, stored in `user_settings.aspect_statuses`. See section 2.4.

### Built-in Aspect IDs

| ID                | Default Status | Description                  |
|-------------------|----------------|------------------------------|
| `orbis/schedule`  | active         | Time, duration, recurrence   |
| `orbis/task`      | active         | Status, priority, due date   |
| `orbis/financial` | passive        | Amount, direction, category  |
| `orbis/fitness`   | passive        | Workout, exercises, RPE      |
| `orbis/nutrition` | passive        | Meals, calories, macros      |
| `orbis/habit`     | passive        | Frequency, check-ins, streaks|
| `orbis/note`      | passive        | Content type marker          |
| `orbis/goal`      | passive        | Target, progress, milestones |

Default statuses are written to `user_settings.aspect_statuses` on user creation. Built-in entities (e.g., "Daily Planning" with query blocks for Today/Inbox) are pre-created and pre-pinned in `user_settings.pinnedEntities`.

## 2.4 user_settings

```typescript
export const userSettings = pgTable('user_settings', {
  userId:          uuid('user_id').primaryKey(),
  displayName:     text('display_name'),
  timezone:        text('timezone').notNull().default('Europe/Moscow'),
  defaultCurrency: text('default_currency').notNull().default('RUB'),
  weekStartDay:    text('week_start_day').notNull().default('monday'),

  // Aspect activation state per user (Fix: moved from aspect_definitions.status)
  aspectStatuses:  jsonb('aspect_statuses').notNull().default({}),
  // {"orbis/schedule": "active", "orbis/task": "active", "orbis/financial": "passive", ...}

  // UI preferences
  tagColors:       jsonb('tag_colors').notNull().default({}),   // {"work": "#6366f1", "personal": "#f97316"}
  installedViews:  text('installed_views').array().notNull().default([]),  // ["orbis-budget", "orbis-fitness"]
  pinnedEntities:  jsonb('pinned_entities').notNull().default([]),  // Ordered list of entity IDs pinned to sidebar
  // [{ "id": "uuid-daily-planning", "order": 0 }, { "id": "uuid-inbox", "order": 1 }, ...]
  statusStripMetrics: jsonb('status_strip_metrics').default([]), // Which metrics to show

  // Domain-specific settings — one JSONB blob, namespaced by aspect/view
  viewPreferences: jsonb('view_preferences').notNull().default({}),
  // {
  //   "orbis/nutrition": { calorieTarget: 2400, proteinTarget: 140, carbsTarget: 280, fatTarget: 70,
  //                        trainingCalorieBoost: 200, trainingProteinBoost: 20 },
  //   "orbis/fitness":   { activeProgram: "uuid-of-program" },
  //   "orbis/habit":     { defaultReminderTime: "08:00" },
  //   "orbis/financial": { monthlyIncomeEstimate: 150000 }
  // }

  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

### Design Note: viewPreferences

Each view reads/writes its own namespace inside `viewPreferences`. Adding a new view or aspect never requires a database migration — just a new key in the JSONB. This keeps user_settings domain-agnostic, following the same principle as the entity `aspects` field.

### Design Note: aspectStatuses

The `aspectStatuses` field stores per-user activation state for aspects. Built-in aspect definitions (`aspect_definitions` table) no longer have a `status` column — the status is per-user, not global. Default statuses (orbis/schedule and orbis/task = active, others = passive) are applied when a new user is created.

## 2.5 sync_log

```typescript
export const syncLog = pgTable('sync_log', {
  id:          uuid('id').primaryKey(),
  userId:      uuid('user_id').notNull(),
  deviceId:    text('device_id').notNull(),                    // Client device identifier
  lastSyncAt:  timestamp('last_sync_at', { withTimezone: true }).notNull(),
  entityCount: integer('entity_count'),                        // Entities synced in last batch
  conflicts:   jsonb('conflicts').default([]),                 // Conflict log for debugging
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

---

# 3. Indexes

## 3.1 entities Indexes

```sql
-- Primary lookup: user's non-archived entities, ordered by recency
CREATE INDEX idx_entities_user_updated
  ON entities (user_id, updated_at DESC)
  WHERE NOT archived;

-- Tag-based filtering (GIN for array containment)
CREATE INDEX idx_entities_tags
  ON entities USING GIN (tags);

-- Aspect existence queries (e.g., "has orbis/task")
CREATE INDEX idx_entities_aspects
  ON entities USING GIN (aspects);

-- Meta field queries (AI context lookups)
CREATE INDEX idx_entities_meta
  ON entities USING GIN (meta);

-- Body entity reference lookups (extracted UUIDs)
CREATE INDEX idx_entities_body_refs
  ON entities USING GIN (body_refs);

-- Full-text search on body content
CREATE INDEX idx_entities_body_search
  ON entities USING GIN (to_tsvector('simple', body));

-- Full-text search on title
CREATE INDEX idx_entities_title_search
  ON entities USING GIN (to_tsvector('simple', title));

-- Sync: find entities changed since last sync
CREATE INDEX idx_entities_sync
  ON entities (user_id, synced_at)
  WHERE synced_at IS NULL OR synced_at < updated_at;

-- Archived filter
CREATE INDEX idx_entities_archived
  ON entities (user_id, archived);
```

## 3.2 relations Indexes

```sql
-- Find children of an entity (parent relations)
CREATE INDEX idx_relations_source
  ON relations (source_id, relation_type);

-- Find parents/blockers of an entity
CREATE INDEX idx_relations_target
  ON relations (target_id, relation_type);

-- Unique constraint already creates index on (source_id, target_id, relation_type)
```

---

# 4. Row Level Security (RLS)

All tables have RLS enabled. Policies use Supabase `auth.uid()`.

## 4.1 entities RLS

```sql
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

-- Users can only see their own entities
CREATE POLICY entities_select ON entities
  FOR SELECT USING (user_id = auth.uid());

-- Users can only insert their own entities
CREATE POLICY entities_insert ON entities
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can only update their own entities
CREATE POLICY entities_update ON entities
  FOR UPDATE USING (user_id = auth.uid());

-- Users can only delete their own entities
CREATE POLICY entities_delete ON entities
  FOR DELETE USING (user_id = auth.uid());
```

## 4.2 relations RLS

```sql
ALTER TABLE relations ENABLE ROW LEVEL SECURITY;

-- Users can manage relations where they own both entities
CREATE POLICY relations_select ON relations
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM entities WHERE id = source_id AND user_id = auth.uid())
  );

CREATE POLICY relations_insert ON relations
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM entities WHERE id = source_id AND user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM entities WHERE id = target_id AND user_id = auth.uid())
  );

CREATE POLICY relations_delete ON relations
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM entities WHERE id = source_id AND user_id = auth.uid())
  );
```

## 4.3 aspect_definitions RLS

```sql
ALTER TABLE aspect_definitions ENABLE ROW LEVEL SECURITY;

-- Everyone can read built-in aspects (user_id IS NULL)
-- Users can read their own custom aspects
CREATE POLICY aspect_defs_select ON aspect_definitions
  FOR SELECT USING (user_id IS NULL OR user_id = auth.uid());

-- Users can only create/modify custom aspects
CREATE POLICY aspect_defs_insert ON aspect_definitions
  FOR INSERT WITH CHECK (user_id = auth.uid() AND namespace != 'orbis');

CREATE POLICY aspect_defs_update ON aspect_definitions
  FOR UPDATE USING (user_id = auth.uid());
```

---

# 5. Key Queries

Common query patterns translated from the Data Model and View PRDs into SQL.

## 5.1 Smart Lists (Entity Browser)

### Today

```sql
SELECT e.* FROM entities e
WHERE e.user_id = $1
  AND e.aspects ? 'orbis/task'
  AND NOT e.archived
  AND e.aspects->'orbis/task'->>'status' NOT IN ('done', 'cancelled')
  AND (
    (e.aspects->'orbis/task'->>'due_date')::date <= CURRENT_DATE
    OR e.aspects->'orbis/task'->>'status' = 'in_progress'
  )
  AND e.aspects->'orbis/task'->>'status' != 'waiting'
  AND NOT EXISTS (
    SELECT 1 FROM relations r
    JOIN entities blocker ON r.source_id = blocker.id
    WHERE r.target_id = e.id
      AND r.relation_type = 'blocks'
      AND blocker.aspects->'orbis/task'->>'status' NOT IN ('done', 'cancelled')
  )
ORDER BY
  CASE e.aspects->'orbis/task'->>'priority'
    WHEN 'urgent' THEN 1 WHEN 'high' THEN 2
    WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5
  END,
  (e.aspects->'orbis/task'->>'due_date')::date ASC NULLS LAST,
  e.created_at ASC;
```

### Inbox

```sql
SELECT * FROM entities
WHERE user_id = $1
  AND aspects->'orbis/task'->>'status' = 'inbox'
  AND NOT archived
ORDER BY created_at DESC;
```

## 5.2 Calendar Data

```sql
SELECT * FROM entities
WHERE user_id = $1
  AND aspects ? 'orbis/schedule'
  AND NOT archived
  AND (
    (aspects->'orbis/schedule'->>'start_at')::timestamptz
      BETWEEN $2 AND $3
    OR (
      (aspects->'orbis/schedule'->>'all_day')::boolean = true
      AND (aspects->'orbis/schedule'->>'start_at')::date
        BETWEEN $2::date AND $3::date
    )
  )
ORDER BY (aspects->'orbis/schedule'->>'start_at')::timestamptz;
```

## 5.3 Budget Envelopes

```sql
-- Current month envelopes
SELECT * FROM entities
WHERE user_id = $1
  AND aspects ? 'orbis/financial'
  AND aspects->'orbis/financial'->>'direction' = 'budget'
  AND (meta->>'period_start')::date <= CURRENT_DATE
  AND (meta->>'period_end')::date >= CURRENT_DATE
  AND NOT archived;

-- Spending per category this month
SELECT
  aspects->'orbis/financial'->>'category' AS category,
  SUM((aspects->'orbis/financial'->>'amount')::decimal) AS total
FROM entities
WHERE user_id = $1
  AND aspects ? 'orbis/financial'
  AND aspects->'orbis/financial'->>'direction' = 'expense'
  AND created_at >= date_trunc('month', CURRENT_DATE)
  AND NOT archived
GROUP BY aspects->'orbis/financial'->>'category';

-- Transactions linked to a specific budget envelope (via relations)
SELECT e.* FROM entities e
JOIN relations r ON r.target_id = e.id
WHERE r.source_id = $envelope_id
  AND r.relation_type = 'parent'
  AND NOT e.archived
ORDER BY e.created_at DESC;
```

## 5.4 Daily Nutrition Totals

```sql
SELECT
  SUM((aspects->'orbis/nutrition'->>'total_calories')::int) AS calories,
  SUM((aspects->'orbis/nutrition'->>'total_protein')::decimal) AS protein,
  SUM((aspects->'orbis/nutrition'->>'total_carbs')::decimal) AS carbs,
  SUM((aspects->'orbis/nutrition'->>'total_fat')::decimal) AS fat
FROM entities
WHERE user_id = $1
  AND aspects ? 'orbis/nutrition'
  AND created_at::date = CURRENT_DATE
  AND NOT archived;
```

## 5.5 Exercise History (Fitness)

```sql
SELECT
  e.id,
  e.created_at,
  ex->>'name' AS exercise_name,
  ex->'sets' AS sets
FROM entities e,
  jsonb_array_elements(e.aspects->'orbis/fitness'->'exercises') AS ex
WHERE e.user_id = $1
  AND e.aspects ? 'orbis/fitness'
  AND ex->>'exercise_id' = $2
  AND NOT e.archived
ORDER BY e.created_at DESC;
```

## 5.6 Dependency Graph (Circular Check)

```sql
-- Check if adding blocks relation from $source to $target would create a cycle
-- Traverse from $target following blocks relations, looking for $source
WITH RECURSIVE chain AS (
  SELECT target_id AS entity_id, 1 AS depth
  FROM relations
  WHERE source_id = $target AND relation_type = 'blocks'

  UNION ALL

  SELECT r.target_id, c.depth + 1
  FROM relations r
  JOIN chain c ON r.source_id = c.entity_id
  WHERE r.relation_type = 'blocks' AND c.depth < 100
)
SELECT EXISTS (
  SELECT 1 FROM chain WHERE entity_id = $source
) AS would_create_cycle;
```

## 5.7 Backlinks (Body References)

```sql
-- Find all entities whose body references entity $target_id
SELECT e.* FROM entities e
WHERE e.user_id = $1
  AND NOT e.archived
  AND $target_id = ANY(e.body_refs)
```

---

# 6. Sync Strategy

## 6.1 Mechanism

- Client tracks `lastSyncAt` per device
- On sync: `SELECT * FROM entities WHERE user_id = $1 AND updated_at > $lastSyncAt`
- Client sends local changes (entities with `synced_at IS NULL`)
- Server applies changes and returns merged result

## 6.2 Conflict Resolution

| Field    | Strategy                                        |
|----------|-------------------------------------------------|
| title    | LWW (last write wins by `updated_at`)           |
| emoji    | LWW                                             |
| tags     | Array merge (union of both versions)            |
| meta     | Key-level LWW (each key resolved independently) |
| aspects  | Aspect-level LWW (each aspect key independently)|
| body     | LWW (body as atomic markdown string — too complex to merge) |
| archived | LWW                                             |

## 6.3 Sync Flow

```
Client                                Server
  |                                      |
  |-- POST /sync ----------------------->|
  |   { lastSyncAt, changes: [...] }     |
  |                                      |-- Apply changes (conflict resolution)
  |                                      |-- Query updated entities since lastSyncAt
  |<-- { serverChanges, newSyncAt } -----|
  |                                      |
  |-- Apply server changes to IndexedDB  |
  |-- Update lastSyncAt                  |
```

---

# 7. IndexedDB Schema (Client)

Mirrors PostgreSQL schema for offline-first operation.

## 7.1 Object Stores

```typescript
const DB_NAME = 'orbis';
const DB_VERSION = 1;

const stores = {
  entities: {
    keyPath: 'id',
    indexes: [
      { name: 'by_user_updated', keyPath: ['userId', 'updatedAt'] },
      { name: 'by_synced', keyPath: 'syncedAt' },
      { name: 'by_tags', keyPath: 'tags', multiEntry: true },
      { name: 'by_body_refs', keyPath: 'bodyRefs', multiEntry: true },
    ]
  },
  relations: {
    keyPath: 'id',
    indexes: [
      { name: 'by_source', keyPath: ['sourceId', 'relationType'] },
      { name: 'by_target', keyPath: ['targetId', 'relationType'] },
    ]
  },
  aspect_definitions: { keyPath: 'id' },
  sync_meta: {
    keyPath: 'key',  // Stores: lastSyncAt, deviceId, etc.
  }
};
```

## 7.2 Client Query Patterns

IndexedDB is limited compared to PostgreSQL. Complex queries (JSONB path, GIN) run in JavaScript after loading entities from IndexedDB:

```typescript
// Smart List: Today
const allTasks = await db.entities
  .filter(e => e.aspects?.['orbis/task'] && !e.archived)
  .toArray();

const blocked = new Set(/* compute from relations */);

const today = allTasks.filter(e => {
  const task = e.aspects['orbis/task'];
  if (['done', 'cancelled', 'waiting'].includes(task.status)) return false;
  if (blocked.has(e.id)) return false;
  const isDue = task.due_date && new Date(task.due_date) <= new Date();
  const isActive = task.status === 'in_progress';
  return isDue || isActive;
});
```

---

# 8. Migrations

## 8.1 Initial Migration (V001)

```sql
-- V001: Core schema
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE entities (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id),
  title       TEXT NOT NULL,
  emoji       TEXT,
  body        TEXT NOT NULL DEFAULT '',
  body_refs   TEXT[] NOT NULL DEFAULT '{}',
  tags        TEXT[] NOT NULL DEFAULT '{}',
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  aspects     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at   TIMESTAMPTZ,
  archived    BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE relations (
  id              UUID PRIMARY KEY,
  source_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL,
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_id, target_id, relation_type),
  CHECK(source_id != target_id)
);

CREATE TABLE aspect_definitions (
  id              TEXT PRIMARY KEY,
  user_id         UUID REFERENCES auth.users(id),
  name            TEXT NOT NULL,
  namespace       TEXT NOT NULL,
  schema          JSONB NOT NULL,
  ai_instructions TEXT,
  tag_mappings    TEXT[] NOT NULL DEFAULT '{}',
  aggregations    JSONB DEFAULT '{}'::jsonb,
  view_config     JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_settings (
  user_id              UUID PRIMARY KEY REFERENCES auth.users(id),
  display_name         TEXT,
  timezone             TEXT NOT NULL DEFAULT 'Europe/Moscow',
  default_currency     TEXT NOT NULL DEFAULT 'RUB',
  week_start_day       TEXT NOT NULL DEFAULT 'monday',
  aspect_statuses      JSONB NOT NULL DEFAULT '{}'::jsonb,
  tag_colors           JSONB NOT NULL DEFAULT '{}'::jsonb,
  installed_views      TEXT[] NOT NULL DEFAULT '{}',
  pinned_entities      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status_strip_metrics JSONB DEFAULT '[]'::jsonb,
  view_preferences     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sync_log (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES auth.users(id),
  device_id    TEXT NOT NULL,
  last_sync_at TIMESTAMPTZ NOT NULL,
  entity_count INTEGER,
  conflicts    JSONB DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 8.2 Auto-Update Trigger

```sql
-- Auto-update updated_at on entity modification
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entities_updated_at
  BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER user_settings_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

## 8.3 Seed Data

Built-in aspect definitions are seeded via migration (not user-created):

```sql
INSERT INTO aspect_definitions (id, name, namespace, schema, ai_instructions, tag_mappings)
VALUES
  ('orbis/schedule', 'Schedule', 'orbis',
    '{"type":"object","properties":{"start_at":{"type":"string"},"end_at":{"type":"string"},"duration_min":{"type":"integer"},"all_day":{"type":"boolean"},"recurrence":{"type":"object"},"location":{"type":"string"},"timezone":{"type":"string"},"color_override":{"type":"string"}}}',
    'Attach when user mentions a specific time, date, or scheduling. Recurrence (daily, weekly, monthly) is defined here — this is the single source of truth for "when does it repeat".',
    '{schedule,event,meeting,appointment,deadline}'),

  ('orbis/task', 'Task', 'orbis',
    '{"type":"object","properties":{"status":{"type":"string","enum":["inbox","planned","in_progress","waiting","done","cancelled"]},"priority":{"type":"string","enum":["none","low","medium","high","urgent"]},"due_date":{"type":"string"},"completed_at":{"type":"string"},"effort_min":{"type":"integer"},"waiting_for":{"type":"string"},"context":{"type":"string"}}}',
    'Attach when user describes an actionable item that can be completed. Note: recurrence is NOT in this aspect — it belongs in orbis/schedule.',
    '{task,todo,action,deadline,project,subtask}'),

  ('orbis/financial', 'Financial', 'orbis',
    '{"type":"object","properties":{"amount":{"type":"number"},"currency":{"type":"string"},"direction":{"type":"string","enum":["income","expense","budget"]},"category":{"type":"string"},"recurring":{"type":"boolean"},"payment_method":{"type":"string"},"counterparty":{"type":"string"}}}',
    'Attach when user mentions money, prices, expenses, income, or budgets. Link transactions to budget envelopes via relations (type: parent), not via aspect fields.',
    '{expense,income,payment,budget,cost,price,salary}'),

  ('orbis/fitness', 'Fitness', 'orbis',
    '{"type":"object","properties":{"workout_type":{"type":"string"},"exercises":{"type":"array"},"program_ref":{"type":"string"},"program_day":{"type":"string"},"duration_actual_min":{"type":"integer"},"total_volume_kg":{"type":"number"},"perceived_effort":{"type":"integer"},"body_metrics":{"type":"object"},"notes":{"type":"string"}}}',
    'Attach when user describes a workout, exercise, or training session.',
    '{workout,fitness,gym,training,exercise,strength}'),

  ('orbis/nutrition', 'Nutrition', 'orbis',
    '{"type":"object","properties":{"meal_type":{"type":"string","enum":["breakfast","lunch","dinner","snack"]},"items":{"type":"array"},"total_calories":{"type":"integer"},"total_protein":{"type":"number"},"total_carbs":{"type":"number"},"total_fat":{"type":"number"},"recipe_ref":{"type":"string"},"ai_estimated":{"type":"boolean"}}}',
    'Attach when user describes eating, meals, food, or nutrition.',
    '{food,meal,calories,protein,nutrition,breakfast,lunch,dinner,snack}'),

  ('orbis/habit', 'Habit', 'orbis',
    '{"type":"object","properties":{"frequency":{"type":"object"},"habit_type":{"type":"string","enum":["binary","quantitative"]},"target_value":{"type":"number"},"unit":{"type":"string"},"check_ins":{"type":"array"},"current_streak":{"type":"integer"},"best_streak":{"type":"integer"},"active":{"type":"boolean"},"color":{"type":"string"},"started_at":{"type":"string"}}}',
    'Attach when user describes a recurring behavioral pattern they want to track for consistency. Note: frequency here defines streak logic (how many times per week counts as success), not when to generate instances — that is orbis/schedule.recurrence.',
    '{habit,routine,streak,daily,weekly}'),

  ('orbis/note', 'Note', 'orbis',
    '{"type":"object","properties":{"content_type":{"type":"string","enum":["markdown","plain","checklist"]},"pinned":{"type":"boolean"}}}',
    'Attach when the primary purpose of the entity is textual content (notes, thoughts, journal entries).',
    '{note,thought,idea,journal,memo}'),

  ('orbis/goal', 'Goal', 'orbis',
    '{"type":"object","properties":{"target_value":{"type":"number"},"current_value":{"type":"number"},"unit":{"type":"string"},"deadline":{"type":"string"},"milestones":{"type":"array"}}}',
    'Attach when user sets a measurable target to achieve by a specific date.',
    '{goal,target,objective,milestone}')
ON CONFLICT (id) DO NOTHING;
```

---

# 9. Client-Side Reference Data

Exercise and food catalogs are NOT stored in the database. This keeps the schema domain-agnostic — the database knows about entities, relations, and aspects, but not about specific view domains.

## 9.1 Approach

| Data | Storage | Format | Size |
|------|---------|--------|------|
| Exercise catalog (~100 exercises) | Client-side JSON | `exercises.json` bundled with Fitness view | ~30KB |
| Food catalog (~500 foods) | Client-side JSON | `foods.json` bundled with Nutrition view | ~80KB |
| User-created exercises | Regular entities | Entity with orbis/fitness, tagged `#exercise-template` | In entities table |
| User-created foods | Regular entities | Entity with orbis/nutrition, tagged `#food-template` | In entities table |

## 9.2 JSON File Structure

### exercises.json

```json
{
  "barbell-bench-press": {
    "name": "Bench Press",
    "aliases": ["жим лёжа", "chest press"],
    "muscleGroup": "chest",
    "secondaryMuscles": ["triceps", "front-delts"],
    "equipment": "barbell",
    "defaultRestSec": 120
  }
}
```

### foods.json

```json
{
  "chicken-breast-raw": {
    "name": "Chicken breast",
    "aliases": ["куриная грудка", "курица"],
    "category": "meat",
    "per100g": { "calories": 110, "protein": 23, "carbs": 0, "fat": 1.3 },
    "servings": [{ "amount": 150, "unit": "g", "label": "1 breast" }]
  }
}
```

## 9.3 Client-Side Search

Both catalogs are loaded into memory when the respective view is opened. Search is performed client-side:

- Fuzzy matching on name + aliases (handles both Russian and English input)
- AI uses these catalogs as context for meal/exercise estimation (passed as tool context, not full list)
- When AI estimates a food not in the catalog, it uses LLM knowledge as fallback

## 9.4 User Custom Entries

When a user creates a custom exercise or food, it becomes a regular entity:

```
Custom exercise: Entity with orbis/fitness aspect, tagged #exercise-template
Custom food: Entity with orbis/nutrition aspect, tagged #food-template
```

These entities are queried alongside the static JSON catalog. User custom entries take priority over system catalog entries with the same name. Over time, the user builds a personal catalog through their own entities.

## 9.5 Update Strategy

- System catalogs update with app deployments (new version → updated JSON files)
- No database migration needed for catalog updates
- Each view bundles its own catalog — installing Fitness view adds exercises.json to the client

---

# 10. Schema Evolution Notes

- **Adding a new aspect**: INSERT into `aspect_definitions`. Zero migration needed on `entities` table — new aspect data stored in JSONB `aspects` column.
- **Adding fields to an aspect**: Update the `schema` JSON in `aspect_definitions`. Existing entities with the old version of the aspect are unaffected (JSONB is schema-less). New fields default to null/undefined.
- **New body extension syntax**: Add parsing support in markdown renderer. Existing body strings unaffected (unknown extensions render as plain text). Future migration to Lexical: parse markdown → Lexical EditorState JSON on first open.
- **New relation type**: Just use a new string in `relation_type`. No migration.
- **Removing an aspect**: Set aspect status to `inactive` in `user_settings.aspect_statuses`. Data preserved in entities. Can be reactivated.
- **New view with reference data**: Add JSON catalog file to client bundle. No database changes.

---

# 11. Known Limitations & Future Migration Paths

## 11.1 check_ins Array Growth (orbis/habit)

**Issue:** `orbis/habit.check_ins` is an array inside entity JSONB. A daily habit accumulates 365 entries/year. Every check-in rewrites the entire `aspects` JSONB column (including all other aspects and the full check_ins history).

**MVP impact:** Negligible. 365 check-in objects ≈ 15KB. JSONB update speed is fine at this scale.

**Scale concern:** At 3+ years (1000+ entries) with multiple habits, the JSONB write amplification becomes wasteful. Same concern for `orbis/fitness.exercises` (rewritten on every set during active workout).

**Future migration path:** Check-ins become child entities of the habit entity:
- Each check-in: `{ title: "2026-03-14", tags: ["check-in"], aspects: { "orbis/habit": { date: "2026-03-14", completed: true, value: 2.3 } } }`
- Linked via `parent` relation to the habit entity
- Heatmap query: `SELECT children WHERE parent = habit_id AND has orbis/habit`
- Streak computation: same logic, different data source (child entities instead of embedded array)
- Same pattern applicable to workout sets (child entities of workout entity)

This migration is backward-compatible: new check-ins create child entities, old check-ins in the array still work. Gradual migration on read.

## 11.2 JSONB Write Amplification (General)

**Issue:** Any update to `aspects`, `meta`, `body`, or `tags` rewrites the entire column. PostgreSQL MVCC creates a full row copy on every UPDATE.

**MVP impact:** Negligible for single user with moderate data volume.

**Future mitigation:**
- For hot-path updates (workout sets, habit check-ins): move to child entities (see 11.1)
- For large body content: markdown string is efficient (no JSONB overhead). Future Lexical migration stores EditorState JSON instead.
- PostgreSQL TOAST handles large JSONB columns efficiently for reads, but writes remain full-column
