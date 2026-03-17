# ORBIS

API Design — Technical Specification

| **Field**  | **Value**                          |
|------------|------------------------------------|
| Version    | 1.0                                |
| Date       | March 2026                         |
| Stack      | Bun + tRPC + Drizzle + Supabase    |
| Parent Doc | Orbis PRD v2.2, DB Schema v1.0     |

---

# 1. Overview

## 1.1 Architecture

```
┌─────────────────────────────────┐
│         React Frontend          │
│   (Vite PWA, Zustand stores)    │
│                                 │
│   tRPC Client (type-safe)       │
└──────────────┬──────────────────┘
               │ HTTP/WebSocket
┌──────────────▼──────────────────┐
│          Bun Server             │
│                                 │
│   tRPC Router                   │
│   ├── entity.*                  │
│   ├── relation.*                │
│   ├── aspect.*                  │
│   ├── user.*                    │
│   ├── sync.*                    │
│   └── ai.*                     │
│                                 │
│   Drizzle ORM ──► PostgreSQL    │
│   AI Service  ──► Claude API    │
│   Auth        ──► Supabase Auth │
└─────────────────────────────────┘
```

## 1.2 Design Principles

- **End-to-end type-safety**: tRPC shares types between client and server. Change a field → TypeScript catches all affected code at compile time.
- **Thin server**: most logic runs client-side (IndexedDB queries, query block evaluation, UI state). Server handles: persistence, sync, AI orchestration, and auth.
- **Offline-first compatible**: every mutation returns the updated entity. Client can optimistically apply changes before server confirms.
- **AI as a router**: AI requests go through `ai.chat` procedure. The AI layer decides which entity/relation mutations to execute. The client never calls entity CRUD directly from AI responses — the server orchestrates.

## 1.3 Project Structure

```
orbis/
├── packages/
│   └── shared/              # Shared types (tRPC inference)
│       ├── src/
│       │   ├── types.ts     # Entity, Relation, Aspect types
│       │   └── schemas.ts   # Zod schemas for validation
│       └── package.json
├── apps/
│   ├── server/              # Bun backend
│   │   ├── src/
│   │   │   ├── index.ts     # Server entry, tRPC adapter
│   │   │   ├── router.ts    # Root router (merges all sub-routers)
│   │   │   ├── routers/
│   │   │   │   ├── entity.ts
│   │   │   │   ├── relation.ts
│   │   │   │   ├── aspect.ts
│   │   │   │   ├── user.ts
│   │   │   │   ├── sync.ts
│   │   │   │   └── ai.ts
│   │   │   ├── services/
│   │   │   │   ├── ai.service.ts
│   │   │   │   ├── sync.service.ts
│   │   │   │   └── migration.service.ts
│   │   │   ├── db/
│   │   │   │   ├── schema.ts    # Drizzle schema (from DB Schema doc)
│   │   │   │   ├── client.ts    # Drizzle client init
│   │   │   │   └── migrations/
│   │   │   └── middleware/
│   │   │       └── auth.ts      # Supabase JWT verification
│   │   └── package.json
│   └── web/                 # React frontend
│       ├── src/
│       │   ├── trpc.ts      # tRPC client setup
│       │   ├── stores/      # Zustand stores
│       │   ├── views/       # View components
│       │   └── ...
│       └── package.json
└── package.json             # Monorepo root (workspaces)
```

---

# 2. Shared Types

Types used by both client and server. Defined once, inferred everywhere via tRPC.

## 2.1 Core Entity Types

```typescript
// packages/shared/src/types.ts

import { z } from 'zod';

// ─── Body ───
// Body is a markdown string with extensions:
//   [[entity:uuid|Display Text]] — inline entity reference
//   {{query: tags=x, aspect=y, display=compact}} — dynamic entity query block
// body_refs is auto-extracted array of entity UUIDs from [[entity:...]] syntax

// ─── Entity ───
export const entitySchema = z.object({
  id:        z.string().uuid(),
  userId:    z.string().uuid(),
  title:     z.string().min(1),
  emoji:     z.string().nullable().default(null),
  body:      z.string().default(''),
  bodyRefs:  z.array(z.string().uuid()).default([]),
  tags:      z.array(z.string()).default([]),
  meta:      z.record(z.any()).default({}),
  aspects:   z.record(z.any()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  syncedAt:  z.string().datetime().nullable(),
  archived:  z.boolean().default(false),
});

export type Entity = z.infer<typeof entitySchema>;

// ─── Relation ───
export const relationTypeEnum = z.enum([
  'parent', 'blocks', 'related_to', 'derived_from'
]);

export const relationSchema = z.object({
  id:           z.string().uuid(),
  sourceId:     z.string().uuid(),
  targetId:     z.string().uuid(),
  relationType: relationTypeEnum,
  meta:         z.record(z.any()).default({}),
  createdAt:    z.string().datetime(),
});

export type Relation = z.infer<typeof relationSchema>;

// ─── Aspect Definition ───
export const aspectDefinitionSchema = z.object({
  id:             z.string(),
  userId:         z.string().uuid().nullable(),
  name:           z.string(),
  namespace:      z.string(),
  schema:         z.record(z.any()),
  aiInstructions: z.string().nullable(),
  tagMappings:    z.array(z.string()).default([]),
  aggregations:   z.record(z.any()).default({}),
  viewConfig:     z.record(z.any()).default({}),
  createdAt:      z.string().datetime(),
});

export type AspectDefinition = z.infer<typeof aspectDefinitionSchema>;
```

## 2.2 Input Schemas

```typescript
// packages/shared/src/schemas.ts

import { z } from 'zod';
import { relationTypeEnum } from './types';

// ─── Entity CRUD ───
export const createEntityInput = z.object({
  id:      z.string().uuid().optional(),   // Client can pre-generate UUIDv7
  title:   z.string().min(1),
  emoji:   z.string().optional(),
  body:    z.string().default(''),
  tags:    z.array(z.string()).default([]),
  meta:    z.record(z.any()).default({}),
  aspects: z.record(z.any()).default({}),
});

export const updateEntityInput = z.object({
  id:       z.string().uuid(),
  title:    z.string().min(1).optional(),
  emoji:    z.string().nullable().optional(),
  body:     z.string().optional(),
  tags:     z.array(z.string()).optional(),
  meta:     z.record(z.any()).optional(),
  aspects:  z.record(z.any()).optional(),
  archived: z.boolean().optional(),
});

export const entityQueryInput = z.object({
  tags:       z.array(z.string()).optional(),
  aspects:    z.array(z.string()).optional(),    // Aspect IDs to filter by (has aspect)
  search:     z.string().optional(),             // Full-text search on title + body
  parentId:   z.string().uuid().optional(),      // Children of entity
  archived:   z.boolean().default(false),
  limit:      z.number().int().min(1).max(200).default(50),
  offset:     z.number().int().min(0).default(0),
  sortBy:     z.enum(['created_at', 'updated_at', 'title']).default('updated_at'),
  sortOrder:  z.enum(['asc', 'desc']).default('desc'),
});

// ─── Relation CRUD ───
export const createRelationInput = z.object({
  sourceId:     z.string().uuid(),
  targetId:     z.string().uuid(),
  relationType: relationTypeEnum,
  meta:         z.record(z.any()).default({}),
});

export const deleteRelationInput = z.object({
  sourceId:     z.string().uuid(),
  targetId:     z.string().uuid(),
  relationType: relationTypeEnum,
});

// ─── Aspect CRUD ───
export const createAspectInput = z.object({
  id:             z.string().regex(/^[a-z]+\/[a-z0-9-]+$/),  // namespace/id format
  name:           z.string().min(1),
  schema:         z.record(z.any()),
  aiInstructions: z.string().optional(),
  tagMappings:    z.array(z.string()).default([]),
  viewConfig:     z.record(z.any()).default({}),
});

// ─── User Settings ───
export const updateSettingsInput = z.object({
  displayName:       z.string().optional(),
  timezone:          z.string().optional(),
  defaultCurrency:   z.string().optional(),
  weekStartDay:      z.string().optional(),
  tagColors:         z.record(z.string()).optional(),
  installedViews:    z.array(z.string()).optional(),
  pinnedEntities:    z.array(z.object({ id: z.string().uuid(), order: z.number() })).optional(),
  statusStripMetrics: z.array(z.any()).optional(),
  aspectStatuses:    z.record(z.enum(['active', 'passive', 'inactive'])).optional(),
  viewPreferences:   z.record(z.any()).optional(),
});

// ─── AI Chat ───
export const aiChatInput = z.object({
  message:    z.string().min(1),
  context:    z.object({
    activeView:  z.string().optional(),        // Which view user is in
    selectedEntity: z.string().uuid().optional(), // Entity user is looking at
    recentEntityIds: z.array(z.string().uuid()).max(10).optional(),
  }).optional(),
});

// ─── Sync ───
export const syncPushInput = z.object({
  deviceId:     z.string(),
  lastSyncAt:   z.string().datetime().nullable(),
  changes: z.object({
    entities:  z.array(z.any()).default([]),
    relations: z.array(z.any()).default([]),
  }),
});
```

---

# 3. tRPC Routers

## 3.1 Root Router

```typescript
// apps/server/src/router.ts

import { router } from './trpc';
import { entityRouter } from './routers/entity';
import { relationRouter } from './routers/relation';
import { aspectRouter } from './routers/aspect';
import { userRouter } from './routers/user';
import { syncRouter } from './routers/sync';
import { aiRouter } from './routers/ai';

export const appRouter = router({
  entity:   entityRouter,
  relation: relationRouter,
  aspect:   aspectRouter,
  user:     userRouter,
  sync:     syncRouter,
  ai:       aiRouter,
});

export type AppRouter = typeof appRouter;
```

## 3.2 Entity Router

```typescript
// apps/server/src/routers/entity.ts

import { router, protectedProcedure } from '../trpc';
import { createEntityInput, updateEntityInput, entityQueryInput } from '@orbis/shared';

export const entityRouter = router({

  // Create a new entity
  create: protectedProcedure
    .input(createEntityInput)
    .mutation(async ({ input, ctx }) => {
      // Generate UUIDv7 if not provided
      // Set userId from auth context
      // INSERT into entities
      // Parse body for [[entity:uuid|...]] → extract UUIDs into body_refs
      // Create implicit related_to relations from body_refs
      // Return created entity
    }),

  // Get entity by ID
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // SELECT entity WHERE id = input.id AND user_id = ctx.userId
      // Include: relations (as separate field), children count
    }),

  // Update entity (partial)
  update: protectedProcedure
    .input(updateEntityInput)
    .mutation(async ({ input, ctx }) => {
      // Merge input fields into existing entity
      // If aspects changed: check for aspect activation triggers
      // If body changed: re-extract body_refs from [[entity:uuid|...]], update implicit relations
      // If orbis/task.status → done: trigger dependency unblocking
      // Return updated entity
    }),

  // Archive entity (soft delete)
  archive: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // SET archived = true
      // Return updated entity
    }),

  // Query entities (filtered list)
  list: protectedProcedure
    .input(entityQueryInput)
    .query(async ({ input, ctx }) => {
      // Build dynamic query from filters
      // tags → WHERE tags @> ARRAY[...]
      // aspects → WHERE aspects ? 'orbis/task'
      // search → WHERE to_tsvector(title) @@ to_tsquery(...)
      // parentId → JOIN relations WHERE type = parent
      // Return { items: Entity[], total: number }
    }),

  // Get entity with all relations and children
  getDetail: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Entity + all relations (both directions) + child entities
      // Return { entity, relations, children, backlinks }
    }),
});
```

## 3.3 Relation Router

```typescript
// apps/server/src/routers/relation.ts

export const relationRouter = router({

  // Create relation
  create: protectedProcedure
    .input(createRelationInput)
    .mutation(async ({ input, ctx }) => {
      // Validate: both entities belong to user
      // Validate: no self-relation
      // If type = 'blocks': validate no circular dependency (recursive CTE)
      // INSERT into relations
      // Return created relation
    }),

  // Delete relation
  delete: protectedProcedure
    .input(deleteRelationInput)
    .mutation(async ({ input, ctx }) => {
      // DELETE WHERE source_id, target_id, relation_type match
      // If was 'blocks': re-evaluate blocked status of target entity
      // Return { success: true }
    }),

  // Get relations for entity (both directions)
  forEntity: protectedProcedure
    .input(z.object({ entityId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // SELECT WHERE source_id = entityId OR target_id = entityId
      // Group by direction: outgoing (source), incoming (target)
      // Include related entity titles for display
      // Return { outgoing: Relation[], incoming: Relation[] }
    }),

  // Check if adding a blocks relation would create a cycle
  checkCycle: protectedProcedure
    .input(z.object({ sourceId: z.string().uuid(), targetId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Recursive CTE from DB Schema section 5.6
      // Return { wouldCreateCycle: boolean, path?: string[] }
    }),
});
```

## 3.4 Aspect Router

```typescript
// apps/server/src/routers/aspect.ts

export const aspectRouter = router({

  // List all available aspects for user
  list: protectedProcedure
    .query(async ({ ctx }) => {
      // SELECT from aspect_definitions WHERE user_id IS NULL OR user_id = ctx.userId
      // Merge with user's aspectStatuses from user_settings
      // Return AspectDefinition[] with per-user status
    }),

  // Create custom aspect
  create: protectedProcedure
    .input(createAspectInput)
    .mutation(async ({ input, ctx }) => {
      // Namespace must be 'user' for custom aspects
      // INSERT into aspect_definitions with user_id = ctx.userId
      // Set aspectStatuses[input.id] = 'active' in user_settings
      // Return created aspect
    }),

  // Activate aspect (passive → active)
  activate: protectedProcedure
    .input(z.object({ aspectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Update user_settings.aspectStatuses[aspectId] = 'active'
      // Trigger retroactive migration (see migration.service.ts)
      // Return { migrated: number } — count of entities that got the aspect attached
    }),

  // Deactivate aspect (active → inactive)
  deactivate: protectedProcedure
    .input(z.object({ aspectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Update user_settings.aspectStatuses[aspectId] = 'inactive'
      // Entities keep their aspect data (not deleted)
      // Return { success: true }
    }),
});
```

## 3.5 User Router

```typescript
// apps/server/src/routers/user.ts

export const userRouter = router({

  // Get current user settings
  getSettings: protectedProcedure
    .query(async ({ ctx }) => {
      // SELECT from user_settings WHERE user_id = ctx.userId
      // If not exists: create with defaults (including default aspectStatuses)
      // Also create built-in entities (Daily Planning, Upcoming, All Tasks)
      //   with {{query:...}} blocks in body, pre-pinned in user_settings.pinnedEntities
      // Return UserSettings
    }),

  // Update settings (partial merge)
  updateSettings: protectedProcedure
    .input(updateSettingsInput)
    .mutation(async ({ input, ctx }) => {
      // Deep merge: tagColors, aspectStatuses, viewPreferences merged at key level
      // installedViews: replace entirely
      // Return updated settings
    }),

  // Install a view
  installView: protectedProcedure
    .input(z.object({ viewId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Add viewId to installedViews array
      // Activate linked aspect(s) — e.g., installing orbis-budget activates orbis/financial
      // Trigger retroactive migration for newly activated aspects
      // Return { installed: true, migrated: number }
    }),

  // Uninstall a view
  uninstallView: protectedProcedure
    .input(z.object({ viewId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Remove viewId from installedViews
      // Set linked aspect status to 'inactive' (NOT delete aspect data from entities)
      // Return { uninstalled: true }
    }),
});
```

## 3.6 Sync Router

```typescript
// apps/server/src/routers/sync.ts

export const syncRouter = router({

  // Full sync: push local changes, pull server changes
  push: protectedProcedure
    .input(syncPushInput)
    .mutation(async ({ input, ctx }) => {
      // 1. Apply client changes to server (conflict resolution per DB Schema section 6.2)
      //    - For each entity: compare updated_at, apply LWW per field level
      //    - Tags: array merge (union)
      //    - Aspects: aspect-level LWW
      //    - Body: atomic LWW
      // 2. Query server changes since lastSyncAt
      // 3. Log sync event to sync_log
      // Return { serverChanges: { entities: Entity[], relations: Relation[] }, newSyncAt: string }
    }),

  // Pull only: get changes since last sync (no push)
  pull: protectedProcedure
    .input(z.object({
      lastSyncAt: z.string().datetime().nullable(),
      deviceId:   z.string(),
    }))
    .query(async ({ input, ctx }) => {
      // SELECT entities WHERE updated_at > lastSyncAt
      // SELECT relations WHERE created_at > lastSyncAt
      // Return { entities: Entity[], relations: Relation[], syncAt: string }
    }),
});
```

## 3.7 AI Router

```typescript
// apps/server/src/routers/ai.ts

export const aiRouter = router({

  // Main chat endpoint
  chat: protectedProcedure
    .input(aiChatInput)
    .mutation(async ({ input, ctx }) => {
      // 1. Load user's active aspects → generate tool definitions
      // 2. Load recent conversation context
      // 3. Build system prompt with aspect instructions
      // 4. Call LLM with message + tools
      // 5. Execute tool calls (entity.create, entity.update, relation.create, etc.)
      // 6. Return { response: string, actions: ActionResult[], cards: Card[] }
    }),

  // Voice transcription → chat
  voice: protectedProcedure
    .input(z.object({ audio: z.string() }))  // Base64 encoded audio
    .mutation(async ({ input, ctx }) => {
      // 1. Send audio to Whisper API → get text
      // 2. Forward text to ai.chat
      // Return same as chat + { transcript: string }
    }),
});
```

---

# 4. Server Entry & Middleware

## 4.1 Server Entry

```typescript
// apps/server/src/index.ts

import { Hono } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { appRouter } from './router';
import { createContext } from './trpc';

const app = new Hono();

// tRPC handler
app.use('/trpc/*', trpcServer({
  router: appRouter,
  createContext,
}));

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

export default {
  port: process.env.PORT || 3001,
  fetch: app.fetch,
};
```

## 4.2 tRPC Context & Auth

```typescript
// apps/server/src/trpc.ts

import { initTRPC, TRPCError } from '@trpc/server';
import { createClient } from '@supabase/supabase-js';
import { db } from './db/client';

interface Context {
  userId: string | null;
  db: typeof db;
}

export async function createContext({ req }): Promise<Context> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  let userId: string | null = null;

  if (token) {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!
    );
    const { data } = await supabase.auth.getUser(token);
    userId = data.user?.id ?? null;
  }

  return { userId, db };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

// Protected: requires auth
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
```

---

# 5. AI Service

The most complex service. Orchestrates LLM calls with dynamic tool generation.

## 5.1 Architecture

```
User message
    │
    ▼
┌─────────────────────┐
│  ai.chat procedure   │
│                     │
│  1. Load aspects    │──► aspect_definitions + user aspectStatuses
│  2. Build tools     │──► Dynamic tool list from active aspects
│  3. Build prompt    │──► System prompt + aspect instructions
│  4. Call LLM        │──► Claude API (or other provider)
│  5. Execute actions  │──► entity.create/update, relation.create, etc.
│  6. Format response  │──► Text + action results + UI cards
└─────────────────────┘
```

## 5.2 Dynamic Tool Generation

```typescript
// apps/server/src/services/ai.service.ts

function generateTools(aspects: AspectDefinition[], statuses: Record<string, string>) {
  const tools = [
    // Core tools (always available)
    {
      name: 'entity_create',
      description: 'Create a new entity with title, tags, meta, and aspects',
      input_schema: { /* ... Zod-derived JSON Schema ... */ }
    },
    {
      name: 'entity_update',
      description: 'Update an existing entity',
      input_schema: { /* ... */ }
    },
    {
      name: 'entity_query',
      description: 'Search entities by tags, aspects, text, date range',
      input_schema: { /* ... */ }
    },
    {
      name: 'relation_create',
      description: 'Create a relation between two entities',
      input_schema: { /* ... */ }
    },
    {
      name: 'relation_delete',
      description: 'Remove a relation between two entities',
      input_schema: { /* ... */ }
    },
  ];

  // Dynamic tools from active aspects
  for (const aspect of aspects) {
    const status = statuses[aspect.id];
    if (status === 'active') {
      // Full tool: AI can create/modify this aspect freely
      tools.push({
        name: `aspect_attach_${aspect.id.replace('/', '_')}`,
        description: `Attach ${aspect.name} aspect to an entity. ${aspect.aiInstructions}`,
        input_schema: aspect.schema,
      });
    } else if (status === 'passive') {
      // Recognition only: AI saves tags+meta, asks before attaching aspect
      // No tool generated — AI uses entity_create with tags+meta only
    }
    // inactive: completely ignored
  }

  return tools;
}
```

## 5.3 System Prompt Structure

```typescript
function buildSystemPrompt(
  aspects: AspectDefinition[],
  statuses: Record<string, string>,
  settings: UserSettings
): string {
  return `
You are Orbis AI — the intelligent core of a life operating system.

## Your Capabilities
- Create, update, query entities (the universal data unit in Orbis)
- Each entity can have: title, emoji, body (rich text), tags, meta (key-value), and aspects (structured domain data)
- Create relations between entities: parent, blocks, related_to, derived_from

## Active Aspects (you can freely attach these)
${aspects
  .filter(a => statuses[a.id] === 'active')
  .map(a => `- ${a.id}: ${a.aiInstructions}`)
  .join('\n')}

## Passive Aspects (save tags+meta, ask before attaching)
${aspects
  .filter(a => statuses[a.id] === 'passive')
  .map(a => `- ${a.id}: recognized but not active. Save relevant tags and meta. Ask user before structuring.`)
  .join('\n')}

## Tag Normalization Rules
- Always normalize to canonical English lowercase
- Semantic dedup: "cost"/"expense"/"spending" → "expense"
- ${settings.defaultCurrency} is the default currency

## User Context
- Timezone: ${settings.timezone}
- Currency: ${settings.defaultCurrency}
- Week starts: ${settings.weekStartDay}

## Response Format
- Be concise. Action-oriented.
- When creating entities, always include tags and meta even if no aspect is active.
- For financial inputs, always extract: amount, currency, direction, category into meta.
- For time inputs, always extract: date, time, duration into meta.
`.trim();
}
```

## 5.4 Action Execution

```typescript
// After LLM returns tool calls, execute them:

async function executeToolCalls(
  toolCalls: ToolCall[],
  ctx: Context
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  for (const call of toolCalls) {
    switch (call.name) {
      case 'entity_create': {
        const entity = await entityRouter.create({ input: call.input, ctx });
        results.push({ type: 'entity_created', entity });
        break;
      }
      case 'entity_update': {
        const entity = await entityRouter.update({ input: call.input, ctx });
        results.push({ type: 'entity_updated', entity });
        break;
      }
      case 'entity_query': {
        const { items } = await entityRouter.list({ input: call.input, ctx });
        results.push({ type: 'entity_list', entities: items });
        break;
      }
      case 'relation_create': {
        const relation = await relationRouter.create({ input: call.input, ctx });
        results.push({ type: 'relation_created', relation });
        break;
      }
      // aspect_attach_* tools: create/update entity with aspect data
      default: {
        if (call.name.startsWith('aspect_attach_')) {
          const aspectId = call.name.replace('aspect_attach_', '').replace('_', '/');
          // Merge aspect data into target entity's aspects field
          results.push({ type: 'aspect_attached', aspectId, entityId: call.input.entityId });
        }
      }
    }
  }

  return results;
}
```

## 5.5 Response Format

```typescript
interface AIChatResponse {
  // AI's text response to the user
  response: string;

  // Actions that were executed (entity created, relation added, etc.)
  actions: ActionResult[];

  // UI cards to render in chat (entity cards, list cards, chart cards)
  cards: Card[];

  // Suggested follow-up actions (chips below the message)
  suggestions: string[];
}

type Card =
  | { type: 'entity'; entity: Entity }
  | { type: 'entity_list'; entities: Entity[]; title: string }
  | { type: 'budget_summary'; data: BudgetSummary }
  | { type: 'progress_chart'; data: ChartData }
  | { type: 'day_plan'; data: DayPlan };
```

---

# 6. Migration Service

Handles retroactive aspect activation — finding existing entities that should have an aspect and attaching it.

```typescript
// apps/server/src/services/migration.service.ts

async function migrateEntitiesForAspect(
  userId: string,
  aspectDef: AspectDefinition,
  db: Database
): Promise<number> {
  // 1. Find candidate entities by tag_mappings
  const candidates = await db.select()
    .from(entities)
    .where(and(
      eq(entities.userId, userId),
      // Entity has at least one matching tag
      sql`${entities.tags} && ${aspectDef.tagMappings}`,
      // Entity doesn't already have this aspect
      sql`NOT (${entities.aspects} ? ${aspectDef.id})`,
      eq(entities.archived, false),
    ));

  // 2. For each candidate: map meta fields to aspect fields
  let migrated = 0;
  for (const entity of candidates) {
    const aspectData = mapMetaToAspect(entity.meta, aspectDef.schema);
    if (aspectData) {
      await db.update(entities)
        .set({
          aspects: sql`jsonb_set(${entities.aspects}, ${`{${aspectDef.id}}`}, ${JSON.stringify(aspectData)}::jsonb)`,
          updatedAt: new Date(),
        })
        .where(eq(entities.id, entity.id));
      migrated++;
    }
  }

  return migrated;
}

function mapMetaToAspect(
  meta: Record<string, any>,
  aspectSchema: Record<string, any>
): Record<string, any> | null {
  // Map meta keys to aspect fields using naming conventions:
  // meta.amount → orbis/financial.amount
  // meta.start_at → orbis/schedule.start_at
  // etc.
  const result: Record<string, any> = {};
  const properties = aspectSchema.properties || {};

  for (const [key, schemaDef] of Object.entries(properties)) {
    if (meta[key] !== undefined) {
      result[key] = meta[key];
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}
```

---

# 7. Client tRPC Setup

```typescript
// apps/web/src/trpc.ts

import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@orbis/server';

export const trpc = createTRPCReact<AppRouter>();

export function createTRPCClient(getToken: () => Promise<string>) {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: `${import.meta.env.VITE_API_URL}/trpc`,
        headers: async () => {
          const token = await getToken();
          return { authorization: `Bearer ${token}` };
        },
      }),
    ],
  });
}
```

### Client Usage Examples

```typescript
// In a React component:

// Create entity
const createEntity = trpc.entity.create.useMutation();
await createEntity.mutateAsync({
  title: 'Buy groceries',
  tags: ['task', 'errand'],
  aspects: { 'orbis/task': { status: 'inbox', priority: 'none' } },
});

// Query entities
const { data } = trpc.entity.list.useQuery({
  aspects: ['orbis/task'],
  tags: ['work'],
  sortBy: 'updated_at',
});

// AI chat
const chat = trpc.ai.chat.useMutation();
const result = await chat.mutateAsync({
  message: 'Lunch 340₽',
  context: { activeView: 'orbis-budget' },
});
// result.response = "Recorded! 340₽ on food..."
// result.actions = [{ type: 'entity_created', entity: {...} }]
// result.cards = [{ type: 'entity', entity: {...} }]
```

---

# 8. Error Handling

## 8.1 Error Codes

| Code | tRPC Code | Meaning |
|------|-----------|---------|
| UNAUTHORIZED | UNAUTHORIZED | Missing or invalid auth token |
| NOT_FOUND | NOT_FOUND | Entity/relation/aspect not found |
| FORBIDDEN | FORBIDDEN | Entity belongs to another user |
| VALIDATION | BAD_REQUEST | Input validation failed (Zod) |
| CONFLICT | CONFLICT | Duplicate relation, circular dependency |
| AI_ERROR | INTERNAL_SERVER_ERROR | LLM API failure |
| SYNC_CONFLICT | CONFLICT | Unresolvable sync conflict |

## 8.2 Error Response Format

```typescript
// tRPC errors include structured data:
throw new TRPCError({
  code: 'CONFLICT',
  message: 'This would create a circular dependency',
  cause: {
    type: 'circular_dependency',
    path: ['entity-a', 'entity-b', 'entity-c', 'entity-a'],
  },
});
```

---

# 9. Rate Limits & Performance

## 9.1 Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| entity.* | 100 requests | per minute |
| ai.chat | 30 requests | per minute |
| ai.voice | 10 requests | per minute |
| sync.push | 10 requests | per minute |

## 9.2 Performance Targets

| Operation | Target | Notes |
|-----------|--------|-------|
| entity.create | < 50ms | Single INSERT |
| entity.list | < 100ms | With GIN indexes |
| ai.chat | < 3s | Dominated by LLM latency |
| sync.push | < 500ms | Batch upsert + conflict resolution |
| entity.getDetail | < 100ms | Entity + relations + children |

---

# 10. API Evolution

- **New field on entity**: add to Zod schema, add to Drizzle schema, generate migration. TypeScript catches all call sites.
- **New router**: add to root router merge. Client auto-discovers via type inference.
- **New AI tool**: add to generateTools function. No client change needed — AI tools are server-side.
- **New relation type**: add to `relationTypeEnum` Zod enum. TypeScript catches all usages.
- **Breaking change**: tRPC versioning — add `/v2` router alongside `/v1`. Gradual migration.
