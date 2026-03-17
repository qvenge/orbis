# ORBIS

### Entity-Aspect Data Model

Technical Specification v3.1

| **Field**  | **Value**                             |
|------------|---------------------------------------|
| Version    | 3.1 (Tags + Meta + Body + Namespaces) |
| Date       | March 2026                            |
| Status     | Draft                                 |
| Parent Doc | Orbis PRD v2.2                        |

# 1. Three-Layer Data Architecture

## 1.1 Overview

Every entity in Orbis has four data layers:

| **Layer**   | **What It Stores**                     | **Purpose**                                                                                 |
|-------------|----------------------------------------|---------------------------------------------------------------------------------------------|
| Entity Core | id, title, emoji, timestamps           | Identity. Every entity has this.                                                            |
| Body        | Markdown string with extensions          | Rich text, inline entity references `[[entity:uuid|text]]`, dynamic query blocks `{{query:...}}`. Every entity has a body (may be empty). |
| Tags + Meta | Normalized tags + AI-extracted JSONB    | Proto-aspect layer. AI extracts key-value data from user input before formal structuring. Migrates to aspects when activated. |
| Aspects     | Structured data per domain schema      | Full structured data for views. Validated against aspect schema.                            |

Tags and meta serve as a "proto-aspect" layer: temporary storage for AI-extracted data before formal aspect structuring. When AI processes "spent 500₽ on lunch", it creates tags (#expense, \#food) and meta ({amount: 500, currency: "RUB", category: "food"}) regardless of whether orbis/financial is active. When the aspect activates, meta fields migrate into the typed aspect schema. Meta should NOT be used for application state (board coordinates, view preferences) — those belong in aspects. Smart list logic belongs in body as {{query:...}} blocks. Body provides Notion-like rich content on any entity: formatted text, links to other entities, and dynamic query blocks.

## 1.2 Why Three Layers?

- **Progressive structuring:** User can start with just chat + tags. Add aspects when ready. No data loss either way.
- **Retroactive aspects:** Install Budget view after 2 weeks → system finds entities with financial tags + meta → migrates to structured aspect:financial → full history appears.
- **Flexible organization:** Aspects are vertical slices (domains). Tags are horizontal slices (contexts, projects, people). Together = 2D navigation.
- **AI resilience:** Even if AI can’t determine the right aspect, tags + meta preserve the intent. A human or smarter AI can structure it later.

# 2. Entity Schema

## 2.1 entities Table

| **Column** | **Type**    | **Null** | **Description**                                                                    |
|------------|-------------|----------|------------------------------------------------------------------------------------|
| id         | UUID (v7)   | NO       | Primary key. Time-ordered. Generated client-side.                                  |
| user_id    | UUID        | NO       | Owner. FK to auth.users.                                                           |
| title      | text        | NO       | Display name. Primary search field.                                                |
| emoji      | text        | YES      | Visual identifier.                                                                 |
| body       | text        | NO       | Markdown with extensions. Default: empty string. See section 3.                     |
| body_refs  | text\[\]   | NO       | Extracted entity UUIDs from body. Auto-computed on save. Default: {}. See section 3. |
| tags       | text\[\]    | NO       | Normalized tag array. AI auto-assigns. Default: {}. See section 4.                 |
| meta       | JSONB       | NO       | AI-extracted key-value data (proto-aspect). NOT for application state — use aspects for structured data. Default: {}. See section 5. |
| aspects    | JSONB       | NO       | Map of namespace/aspect_id → structured data. Default: {}. See section 6.          |
| created_at | timestamptz | NO       | Creation time.                                                                     |
| updated_at | timestamptz | NO       | Last modification.                                                                 |
| synced_at  | timestamptz | YES      | Last sync. NULL = pending.                                                         |
| archived   | boolean     | NO       | Soft delete. Default false.                                                        |

## 2.2 relations Table

| **Column**    | **Type**    | **Null** | **Description**                                 |
|---------------|-------------|----------|-------------------------------------------------|
| id            | UUID        | NO       | Primary key.                                    |
| source_id     | UUID        | NO       | FK to entities.id.                              |
| target_id     | UUID        | NO       | FK to entities.id.                              |
| relation_type | text        | NO       | parent \| blocks \| related_to \| derived_from. |
| metadata      | JSONB       | YES      | Optional context.                               |
| created_at    | timestamptz | NO       | When created.                                   |

# 3. Body: Markdown with Extensions

## 3.1 What Body Is

Body is a markdown text string stored on every entity. It provides rich content capabilities: formatted text, inline references to other entities, and dynamic query blocks that render live lists of entities matching a filter.

Body is part of entity core, not an aspect. Every entity has a body (defaulting to an empty string). A task, a project, a workout, a budget item — anything can have formatted text, entity links, and embedded query results.

The orbis/note aspect is no longer the only place for text. It becomes a marker that says "this entity's primary purpose is textual content" — showing it in the Notes filter. But any entity can have a body regardless of orbis/note.

## 3.2 Body Format

Body is a standard markdown string with two custom extensions:

### Standard Markdown

All standard markdown formatting: `# headings`, `**bold**`, `*italic*`, `- bullet lists`, `1. numbered lists`, `` `code` ``, `> blockquotes`, `---` dividers, `[links](url)`.

### Extension: Inline Entity References

Syntax: `[[entity:UUID|Display Text]]`

Example:
```
This depends on [[entity:a1b2c3|Build API]] which is blocked by [[entity:d4e5f6|Design API]].
```

Renders as: "This depends on **Build API** which is blocked by **Design API**." — where Build API and Design API are clickable chips/links that navigate to those entities.

AI generates these natively when referencing other entities. Autocomplete triggers when user types `[[` in the editor.

### Extension: Entity Query Blocks

Syntax: `{{query: <filter_params>}}`

Example — all active backend tasks:
```
## Backend Tasks
{{query: tags=backend, aspect=orbis/task, status=planned|in_progress, display=compact, title=Active backend tasks}}
```

Example — this week's expenses:
```
{{query: aspect=orbis/financial, direction=expense, date=this_week, display=table, title=This week's expenses}}
```

### Extended Query Syntax

Full filter capabilities:

| Feature | Syntax | Example |
|---------|--------|---------|
| Tag inclusion (OR) | `tags=work\|personal` | Entities with tag work OR personal |
| Tag exclusion | `excludeTags=archived` | Exclude entities with tag |
| Aspect existence | `aspect=orbis/task` | Must have this aspect |
| Aspect field match | `status=planned\|in_progress` | Field value (OR) |
| Negation | `status=!done&!cancelled` | NOT these values |
| Date-relative | `due=today\|overdue` | Relative date filters |
| Numeric comparison | `amount>1000` | Aspect field > value |
| Numeric range | `amount=500..2000` | Field between values |
| Relation-based | `parent_of=this` | Children of current entity |
| Relation-based | `child_of=<uuid>` | Parents of specific entity |
| Dependency exclusion | `excludeBlocked=true` | Traverses blocks relations |
| Multi-field sort | `sortBy=priority:desc\|due_date:asc` | Ordered sort fields |
| Full-text search | `search=API` | Search in title + body |
| Limit | `limit=20` | Max results |
| Display mode | `display=compact\|list\|table` | Rendering style |
| Title | `title=My Tasks` | Header above results |

Relation-based filters use the generic relation system: `parent_of=this` means "show entities where THIS entity is the parent", i.e., show my children. This is how project entities show their tasks, and budget envelopes show their transactions.

Query blocks re-evaluate on every render. Adding a new entity that matches the filter → it appears in all matching query blocks. This makes entity bodies "living documents".

## 3.3 Body Refs (Extracted Entity References)

Every entity has a `body_refs` field (text[] array) that stores UUIDs extracted from `[[entity:UUID|...]]` syntax in body. This is auto-computed on every save:

- Body contains `[[entity:a1b2c3|Build API]]` → body_refs includes "a1b2c3"
- Reference removed from body → UUID removed from body_refs
- GIN index on body_refs enables fast backlink queries: "find all entities that reference entity X" → `WHERE 'uuid-x' = ANY(body_refs)`

These extracted references also create implicit `related_to` relations with metadata `{source: "body_ref", auto: true}`.

## 3.4 Related Entities Panel

Every entity's detail screen shows a "Related" section that aggregates connections from all sources:

| **Source**        | **Relation Types**                           | **Display**                                                   |
|-------------------|----------------------------------------------|---------------------------------------------------------------|
| Explicit relations | parent, blocks, related_to, derived_from | Grouped by type. Editable.                              |
| Body references    | entity_ref in body (implicit related_to)    | Listed as 'Referenced in body'. Click to scroll to reference. |
| Backlinks          | Other entities whose body_refs include THIS entity | Listed as 'Referenced by'. Bidirectional visibility.   |
| Query appearances  | This entity appears in other entities' query blocks | Listed as 'Appears in queries of'. Dynamic.            |

This creates a complete graph view of any entity's connections.

## 3.5 Body + AI

AI interacts with body naturally since body is markdown:

- When creating entities via chat, AI populates body with markdown content (descriptions, notes, analysis)
- AI generates `[[entity:uuid|text]]` references when mentioning other entities
- User can ask: "Add a section to the Orbis project with all blocked tasks" → AI appends a `{{query:...}}` block to the project's body
- AI can read body content for context by receiving the raw markdown (no conversion needed)
- AI can search across body content via PostgreSQL full-text search index

## 3.6 Body + orbis/note Aspect

Clarification of roles:

- **body:** Core field on every entity. Stores markdown string. Can be empty or rich.
- **orbis/note aspect:** Marker that says "this entity's primary purpose is textual content". Makes the entity filterable as a "note" in Entity Browser. Has additional fields: pinned (boolean), content_type (markdown|plain|checklist).

A task can have rich body content (description, links, queries) without orbis/note. A note entity has orbis/note for filtering plus a rich body for its content.

## 3.7 Editor Strategy

- **MVP:** Simple textarea with markdown preview. `[[` triggers entity search autocomplete. `{{query:` shows query builder. Renders via react-markdown with custom plugins for extensions.
- **Future:** Migration to Lexical rich editor. Custom nodes: EntityRefNode (inline clickable chip), EntityQueryNode (live query block). Storage migrates from markdown string to Lexical EditorState JSON on first edit. Backward-compatible: markdown entities render in Lexical via built-in markdown import.

# 4. Tags System

## 10.1 What Tags Are

Tags are lightweight normalized labels that AI assigns to every entity. They capture semantic meaning without requiring a formal schema. Think of them as the entity’s "about" keywords.

Example: user says "bought gym membership for 3500₽". AI creates entity with tags: \["expense", "fitness", "subscription", "gym"\]. No aspect needed — tags alone capture the intent.

## 10.2 AI Auto-Normalization

AI normalizes tags to canonical English lowercase forms automatically:

| **User Input**             | **AI Normalized Tags**                      | **Rationale**                              |
|----------------------------|---------------------------------------------|--------------------------------------------|
| потратил 500₽ на обед      | \["expense", "food", "lunch"\]              | Russian → English canonical form           |
| workout at the gym         | \["fitness", "workout", "gym", "strength"\] | Extracts domain + specifics                |
| bought coffee at Starbucks | \["expense", "food", "coffee"\]             | Brand not tagged (not useful for grouping) |
| meeting with Dima tomorrow | \["meeting", "schedule", "work"\]           | Context-dependent (AI infers work)         |

Normalization rules:

- Always English lowercase, even if user writes in another language
- Singular form ("expenses" → "expense")
- AI checks existing tags before creating new ones — prefers reusing over inventing
- Semantic dedup: AI avoids synonyms ("cost", "expense", "spending" → always "expense")
- System maintains a tag registry per user with usage counts for AI reference

## 10.3 Tag Categories

Tags naturally fall into categories. AI uses these categories when suggesting tags:

| **Category** | **Examples**                               | **Used For**                                |
|--------------|--------------------------------------------|---------------------------------------------|
| Domain       | expense, fitness, food, sleep, work        | Primary subject. Maps to potential aspects. |
| Activity     | workout, meeting, cooking, reading         | What happened. Useful for time analysis.    |
| Context      | personal, work, family, social             | Life area. Cross-cutting organizer.         |
| Project      | orbis, apartment-renovation, vacation-2026 | Groups related entities across domains.     |
| Frequency    | daily, weekly, one-time, recurring         | Temporal pattern.                           |

Categories are not enforced in the schema — a tag is just a string. But AI is instructed to think in these categories when assigning tags.

# 5. Meta: Structured-but-Schemaless Data

## 10.1 What Meta Is

Meta is a JSONB field where AI stores parsed key-value data that doesn’t (yet) belong to a formal aspect. When AI processes user input, it extracts every meaningful data point and saves it in meta — even if no aspect is active.

This is the critical innovation: meta ensures that when an aspect is activated later, migration can be precise (field-to-field mapping) rather than lossy (re-parsing from title).

## 10.2 Examples

**"Spent 500₽ on lunch" without financial aspect:**

{

title: "Обед",

tags: \["expense", "food", "lunch"\],

meta: {

amount: 500,

currency: "RUB",

direction: "expense",

category: "food"

},

aspects: {} // no financial aspect active

}

When financial aspect activates → meta.amount, meta.currency, meta.direction, meta.category map directly to aspect:financial fields. Zero data loss.

**"Slept at 11pm, woke at 7, felt good" without sleep aspect:**

{

title: "Sleep",

tags: \["sleep", "health", "rest"\],

meta: {

bedtime: "23:00",

wake_time: "07:00",

quality_text: "good",

duration_hours: 8

},

aspects: {}

}

## 10.3 Meta vs Aspects

| **Property** | **Meta**                                   | **Aspect**                                              |
|--------------|--------------------------------------------|---------------------------------------------------------|
| Schema       | No formal schema. AI writes any key-value. | Validated against aspect definition JSON schema.        |
| Data quality | Best-effort. May have inconsistent keys.   | Guaranteed structure. Consistent fields.                |
| View access  | Not directly rendered in views.            | Defines which view shows the entity.                    |
| AI use       | AI reads meta for context in any query.    | AI reads aspects for structured operations.             |
| Persistence  | Always written. Never lost.                | Added when aspect activated. Can be migrated from meta. |

## 10.4 AI Instructions for Meta

AI is instructed to always extract and save structured data in meta, following these rules:

- Parse numbers: amounts, durations, quantities, ratings → numeric values in meta
- Parse dates/times: "tomorrow at 3pm" → meta.start_at as ISO 8601
- Parse categories: infer category from context ("Starbucks" → meta.category: "coffee")
- Use consistent keys: AI prefers keys that match known aspect schemas (meta.amount matches financial.amount)
- Keep original text: meta.raw_input preserves the original user message for future re-parsing

# 6. Aspect System

## 10.1 Aspect Namespaces

Every aspect ID is namespaced to avoid conflicts between built-in, user-created, and community aspects:

| **Namespace** | **Format**           | **Examples**                                               |
|---------------|----------------------|------------------------------------------------------------|
| orbis/        | Built-in aspects     | orbis/schedule, orbis/task, orbis/financial, orbis/fitness |
| user/         | User-created aspects | user/sleep, user/garden, user/reading                      |
| \<author\>/   | Community packages   | sleeplab/advanced-sleep, fitpro/running-plan               |

Namespaces prevent conflicts: a user’s user/sleep and a marketplace sleeplab/advanced-sleep are distinct aspects. Data is never mixed accidentally.

In the aspects JSONB map on entities, keys are full namespaced IDs:

{

aspects: {

"orbis/schedule": { start_at: "2026-03-16T08:00", duration_min: 90 },

"orbis/task": { status: "planned", priority: "high" },

"user/sleep": { bedtime: "23:00", wake_time: "07:00", quality: 8 }

}

}

## 10.2 aspect_definitions Table

| **Column**      | **Type**    | **Null** | **Description**                                                                                             |
|-----------------|-------------|----------|-------------------------------------------------------------------------------------------------------------|
| id              | text        | NO       | Namespaced ID: 'orbis/schedule', 'user/sleep'. PK.                                                          |
| user_id         | UUID        | YES      | NULL for orbis/ aspects. Set for user/ aspects.                                                             |
| name            | text        | NO       | Display name.                                                                                               |
| description     | text        | NO       | Human-readable. Also AI context.                                                                            |
| icon            | text        | YES      | Emoji or icon.                                                                                              |
| schema          | JSONB       | NO       | JSON Schema for field validation and form generation.                                                       |
| ai_instructions | text        | YES      | When to attach, cross-aspect rules.                                                                         |
| view_config     | JSONB       | YES      | UI rendering hints: default_view, sort, group, color.                                                       |
| built_in        | boolean     | NO       | True for orbis/ aspects.                                                                                    |
| tag_mappings    | text\[\]    | YES      | Tags that suggest this aspect (e.g., \["expense", "income", "payment"\] for financial). Used for migration. |
| aggregations    | JSONB       | YES      | Computed metrics.                                                                                           |

| created_at      | timestamptz | NO       | When defined.                                                                                               |

## 10.3 Built-in Aspect Schemas (orbis/ namespace)

Eight pre-seeded aspects in three categories. An aspect is any structured facet of an entity that needs typed schema, AI instructions, and per-entity JSONB storage.

### Aspect Categories

| Category | Purpose | Examples | When to Use |
|----------|---------|----------|-------------|
| **Domain** | Life domains with dedicated views | orbis/financial, orbis/fitness, orbis/nutrition, orbis/habit | Entity represents something in a real-world domain (money, exercise, food, behavior) |
| **System** | Core platform concepts | orbis/schedule, orbis/task, orbis/note, orbis/goal | Entity needs system-level behavior (time, actionability, text, targets) |
| **View** (future) | Per-entity layout data for specialized views | orbis/board (x/y coordinates) | View needs to store rendering metadata on each entity |

### When to Use Aspect vs Meta vs Body

| Data Type | Store In | Example |
|-----------|----------|---------|
| AI-extracted data before structuring | **meta** | "spent 500₽" → meta: {amount: 500} (before orbis/financial active) |
| Typed domain/system data | **aspect** | orbis/financial: {amount: 500, direction: "expense", category: "food"} |
| View-specific layout | **aspect** | orbis/board: {x: 340, y: 120} (future) |
| Dynamic query / filter | **body** | {{query: aspect=orbis/task, due=today}} |
| Rich text content | **body** | Markdown descriptions, notes |
| Per-user preferences | **user_settings.viewPreferences** | {calorieTarget: 2400} |

Summary:

| **Aspect ID**   | **Key Fields**                                         | **Tag Mappings**                                        |
|-----------------|--------------------------------------------------------|---------------------------------------------------------|
| orbis/schedule  | start_at\*, end_at, duration_min, recurrence, location | \["schedule", "event", "meeting", "appointment"\]       |
| orbis/task      | status\*, priority, due_date, effort_min, waiting_for  | \["task", "todo", "action", "deadline"\]                |
| orbis/financial | amount\*, direction\*, category\*, currency            | \["expense", "income", "payment", "budget", "cost"\]    |
| orbis/fitness   | workout_type, exercises\[\], perceived_effort          | \["workout", "exercise", "training", "fitness", "gym"\] |
| orbis/nutrition | meal_type, items\[\], total_calories\*, macros         | \["food", "meal", "calories", "diet", "nutrition"\]     |
| orbis/habit     | frequency\*, check_ins\[\], streak                     | \["habit", "routine", "streak", "daily"\]               |
| orbis/note      | content\*, content_type, attachments\[\]               | \["note", "thought", "idea", "journal"\]                |
| orbis/goal      | target_value\*, current_value, deadline                | \["goal", "target", "objective", "milestone"\]          |

# 7. User Settings

The `user_settings` table stores per-user configuration. Unlike entities and aspects, this is a single row per user — not an entity.

| **Field** | **Type** | **Description** |
|-----------|----------|-----------------|
| userId | UUID | PK, references auth.users |
| timezone | text | User's timezone (default: Europe/Moscow) |
| defaultCurrency | text | ISO 4217 currency code (default: RUB) |
| weekStartDay | text | monday \| sunday |
| aspectStatuses | JSONB | Per-user aspect activation state: {"orbis/schedule": "active", "orbis/financial": "passive", ...} |
| tagColors | JSONB | Tag → color mapping for UI |
| installedViews | text[] | Installed view IDs: ["orbis-budget", "orbis-fitness"] |
| pinnedEntities | JSONB | Ordered list of entity IDs pinned to Entity Browser sidebar: [{id, order}] |
| statusStripMetrics | JSONB | Which metrics to show in status strip |
| viewPreferences | JSONB | Domain-specific settings, namespaced by aspect/view. E.g., {"orbis/nutrition": {calorieTarget: 2400}, "orbis/fitness": {activeProgram: "uuid"}} |

### pinnedEntities

Any entity can be pinned to the Entity Browser sidebar. This is how "smart lists" work: an entity with `{{query:...}}` blocks in body is pinned → appears in sidebar → tap to see live query results. Built-in entities (Daily Planning, Upcoming, All Tasks) are pre-pinned on user creation.

```json
[
  { "id": "uuid-daily-planning", "order": 0 },
  { "id": "uuid-upcoming", "order": 1 },
  { "id": "uuid-project-orbis", "order": 2 }
]
```

### viewPreferences

Domain-specific settings namespaced by aspect/view. Adding a new view never requires schema migration.

```json
{
  "orbis/nutrition": { "calorieTarget": 2400, "proteinTarget": 140 },
  "orbis/fitness": { "activeProgram": "uuid-of-program" },
  "orbis/habit": { "defaultReminderTime": "08:00" }
}
```

# 8. Progressive Aspect Activation

## 8.1 The Three States

Every aspect has a per-user activation status stored in `user_settings.aspect_statuses` (not in the aspect_definitions table, since status is per-user). Three possible values:

| **Status** | **AI Behavior**                                                                                                      | **Description**                                                                                                        |
|------------|----------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| passive    | Recognizes context, saves tags + meta, but does NOT attach the aspect. Asks on first encounter: "Record as expense?" | Default for built-in aspects the user hasn’t interacted with yet. AI knows about the aspect but waits for user intent. |
| active     | Auto-attaches the aspect when context matches. No confirmation needed.                                               | Aspect has been confirmed by user. AI freely creates structured aspect data.                                           |
| inactive   | Ignores the aspect completely. No tags related to it, no meta extraction.                                            | User explicitly disabled or uninstalled. Not in AI tool list.                                                          |

## 8.2 Activation Flow

Example with orbis/financial aspect:

- **Day 1:** orbis/financial status = passive. User says "spent 500₽ on lunch". AI creates entity with tags \["expense", "food"\], meta {amount: 500, currency: "RUB", category: "food"}. AI asks: "Want me to start tracking your finances? I’ll add structured budget data to expenses.". User says "yes".
- **Activation:** orbis/financial status changes to active in user_settings.aspect_statuses. AI migrates this entity: meta data → aspects.orbis/financial. Also retroactively scans for entities with matching tags (expense, income, payment) and migrates their meta too.
- **Day 2+:** User says "taxi 340₽". AI auto-creates entity with tags \["expense", "transport"\] + meta + aspects.orbis/financial = {amount: 340, direction: "expense", category: "transport"}. No confirmation needed.

## 8.3 Initial States

| **Aspect Type**                                         | **Initial Status** | **Rationale**                                                                                                                   |
|---------------------------------------------------------|--------------------|---------------------------------------------------------------------------------------------------------------------------------|
| Core OS aspects (orbis/schedule, orbis/task)                   | active             | Calendar and Entity Browser work immediately.                                                                                  |
| Other built-in (orbis/financial, orbis/fitness, etc.)   | passive            | AI recognizes context, saves tags+meta, but asks before structuring. Activated on first confirmation or when view is installed. |
| User-created                                            | active             | User explicitly created it. Obviously wants it active.                                                                          |
| Community (on install)                                  | active             | User explicitly installed the package.                                                                                          |

Key behavior: installing a view automatically activates its linked aspect(s) AND triggers retroactive migration of entities with matching tags.

# 8. Migration: Tags + Meta → Aspects

## 10.1 Automatic Migration (on aspect activation)

When an aspect transitions from passive to active, the system performs retroactive migration:

- Step 1: Find entities with matching tags (using tag_mappings from aspect_definitions)
- Step 2: For each entity, attempt to map meta fields to aspect schema fields
- Step 3: Validate mapped data against the aspect’s JSON schema
- Step 4: If valid, attach the aspect. If not, flag for manual review.
- Step 5: Show migration summary to user: "Migrated 47 expenses. 3 entries need manual review."

## 10.2 Field Mapping

AI uses consistent meta keys that match aspect field names. This makes most migrations trivial:

| **Meta Key**              | **Aspect Field**                  | **Confidence**                                               |
|---------------------------|-----------------------------------|--------------------------------------------------------------|
| meta.amount               | orbis/financial.amount            | Exact match → auto-migrate                                   |
| meta.currency             | orbis/financial.currency          | Exact match → auto-migrate                                   |
| meta.start_at             | orbis/schedule.start_at           | Exact match → auto-migrate                                   |
| meta.quality_text ="good" | user/sleep.quality (integer 1-10) | Type mismatch → AI infers: "good" ≈ 7-8. Flagged for review. |
| meta.duration_hours = 8   | user/sleep.duration_hours         | Exact match → auto-migrate                                   |

## 10.3 Cross-Namespace Migration (Future)

When a user has user/sleep entities and installs a community package sleeplab/advanced-sleep with a richer schema:

- System detects both aspects have overlapping tag_mappings (\["sleep"\])
- Shows migration wizard: field-by-field mapping preview
- User confirms. Entities get the new aspect attached. Old aspect can be kept (read-only) or removed.
- Data from user/sleep fields mapped to sleeplab/advanced-sleep fields. Missing fields set to null.

# 9. Real-World Entity Examples

## 10.1 "Lunch expense" — passive financial aspect

User has not activated orbis/financial yet. Says "lunch 340₽":

{

title: "Обед",

tags: \["expense", "food", "lunch"\],

meta: { amount: 340, currency: "RUB", direction: "expense", category: "food",

raw_input: "обед 340₽" },

aspects: {

"orbis/schedule": { start_at: "2026-03-13T12:34:00Z" }

}

}

Note: orbis/schedule is active (pre-installed), so it gets a proper aspect. orbis/financial is passive, so data goes to meta only. Tags capture the semantics.

## 10.2 Same entity after financial activation

User activates orbis/financial. Migration runs:

{

title: "Обед",

tags: \["expense", "food", "lunch"\],

meta: { amount: 340, currency: "RUB", direction: "expense", category: "food",

raw_input: "обед 340₽" },

aspects: {

"orbis/schedule": { start_at: "2026-03-13T12:34:00Z" },

"orbis/financial": { amount: 340, currency: "RUB", direction: "expense", category: "food" }

}

}

Meta is preserved (never deleted). Aspect is added from meta fields. Entity now appears in Budget view.

## 10.3 "Monday Workout" — 3 active aspects

{

title: "Chest & Back",

emoji: "🏋️",

tags: \["workout", "strength", "gym", "fitness", "schedule"\],

meta: { workout_type: "strength", perceived_effort: 7, raw_input: "chest and back workout" },

aspects: {

"orbis/schedule": { start_at: "2026-03-16T08:00", duration_min: 90,

recurrence: { freq: "weekly", days: \["mon","wed","fri"\] } },

"orbis/fitness": { workout_type: "strength",

exercises: \[{ name: "Bench Press", sets: \[{ reps: 10, weight_kg: 80 }\] }\],

perceived_effort: 7 },

"orbis/task": { status: "planned", priority: "high" }

}

}

## 10.4 "Project Orbis" — parent + goal + rich body

{

title: "Orbis",

emoji: "∞",

tags: \["project", "work", "development", "goal"\],

meta: { project_type: "software", target_date: "2026-06-01" },

body: "## Overview\nAI-powered life OS. Main deliverable: MVP by June.\n\n## Key Dependencies\n[[entity:uuid-build-api|Build API]] depends on [[entity:uuid-design-dm|Design Data Model]] which is in progress.\n\n## Active Tasks\n{{query: parent_of=this, aspect=orbis/task, status=in_progress|planned, display=compact, title=In progress}}",

body_refs: ["uuid-build-api", "uuid-design-dm"],

aspects: {

"orbis/task": { status: "in_progress", priority: "high" },

"orbis/goal": { target_value: 100, current_value: 15, unit: "%",

deadline: "2026-06-01" }

}

}

This entity has: a markdown body with inline entity references (`[[entity:uuid|Build API]]` — clickable links) plus a live query block (`{{query:...}}` showing all active child tasks). The body_refs array enables fast backlink queries. Implicit related_to relations auto-created from body_refs. Children also linked via explicit parent relations.

# 10. Query Patterns

## 10.1 Tag-based Queries

-- All expense-related entities (even without financial aspect)

SELECT \* FROM entities WHERE 'expense' = ANY(tags) AND user_id = \$1

-- Entities with multiple tags (fitness + schedule = scheduled workouts)

SELECT \* FROM entities WHERE tags @\> ARRAY\['fitness', 'schedule'\] AND user_id = \$1

## 10.2 Aspect-based Queries (View Filters)

-- Calendar view: entities with schedule aspect in date range

SELECT \* FROM entities

WHERE aspects ? 'orbis/schedule'

AND (aspects-\>'orbis/schedule'-\>\>'start_at')::timestamptz BETWEEN \$2 AND \$3

## 10.3 Meta-based Queries (AI context)

-- Find entities with financial meta but no financial aspect (migration candidates)

SELECT \* FROM entities

WHERE meta ? 'amount' AND NOT aspects ? 'orbis/financial'

AND 'expense' = ANY(tags)

## 10.4 Combined Queries

-- AI: "How much did I spend on food this week?"

-- Works BOTH with and without financial aspect active:

SELECT

COALESCE(

(aspects-\>'orbis/financial'-\>\>'amount')::decimal,

(meta-\>\>'amount')::decimal

) as amount

FROM entities

WHERE user_id = \$1 AND 'expense' = ANY(tags) AND 'food' = ANY(tags)

AND created_at \>= date_trunc('week', now())

This query works regardless of aspect status — it falls back to meta if the aspect isn’t attached. AI can answer financial questions even before the user installs Budget view.

# 11. Indexing Strategy

| **Index**                       | **Purpose**                                                                 |
|---------------------------------|-----------------------------------------------------------------------------|
| GIN on tags                     | Tag array containment queries. Powers all tag-based filtering.              |
| GIN on meta                     | JSONB key lookups in meta for AI context queries.                           |
| GIN on aspects                  | Aspect key existence (? operator). Powers all view filtering.               |
| GIN on body_refs                | Array containment queries for backlink lookups (finding entities referencing a given UUID). |
| Full-text on body               | Text search across body markdown content.                                                  |
| Full-text on title + body text  | Text search across entity titles and body text content.                     |
| B-tree on (user_id, updated_at) | Sync: changed entities since last sync.                                     |
| B-tree on (user_id, archived)   | Filter archived entities.                                                   |

# 12. Offline Sync

Same protocol as before. Aspect-level conflict resolution extended to three layers:

- Tags: array merge (union of both tag sets)
- Meta: key-level LWW (last-write-wins per meta key)
- Aspects: key-level LWW per aspect namespace (orbis/schedule on client + orbis/task on server = merge both)

# 13. Schema Evolution

- New built-in aspect: INSERT into aspect_definitions. Zero migration.
- New fields in aspect: update schema in aspect_definitions. Existing entities unaffected (JSONB).
- New block type in body: add rendering support in UI. Existing body arrays unaffected (unknown types ignored).
- New custom aspect: user creates via AI or UI. INSERT into aspect_definitions. Instant.
- Aspect deprecation: set status = inactive. Data preserved. View hidden.
- Tag cleanup: merge duplicate tags, archive unused. Background job.
