# ORBIS

### Entity Browser

Core OS Component — Detailed Specification

| **Field**  | **Value**                   |
|------------|-----------------------------|
| Component  | Core OS (cannot be removed) |
| Type       | Entity file manager         |
| Version    | 1.0                         |
| Date       | March 2026                  |
| Parent Doc | Orbis PRD v2.2              |

# 1. Overview

## 1.1 Purpose

The Entity Browser is the file manager of Orbis. It is a core OS component (alongside Chat and Calendar) that provides universal access to the entity graph: browsing, filtering, organizing, editing, and managing all entities regardless of their aspects.

It is NOT a view. Views are installable, aspect-specific visualizations (Budget charts, Fitness progress). Entity Browser is always present and works with all entities equally. It is the foundation on which the entire system rests.

## 1.2 Design Philosophy

- Universal: every entity is accessible through Browser, regardless of aspects or tags
- GTD-inspired: Inbox for capture, pinned entities with query blocks for actionable surfaces, projects for organization
- Aspect-aware: Browser natively understands orbis/task (checkboxes, priorities, dependencies) and orbis/schedule (date display). Other aspects shown as compact cards.
- Notion-like body: every entity has rich content with inline references and dynamic query blocks
- Trust the system: blocked tasks hidden from Today. Recurring tasks auto-generate. Dependencies auto-resolve.

## 1.3 What Entity Browser Is vs. What Views Are

| **Entity Browser (Core)**                                    | **Views (Installable)**                                     |
|--------------------------------------------------------------|-------------------------------------------------------------|
| Shows ALL entities, filtered by tags/aspects/dates/relations | Shows entities with ONE specific aspect in a specialized UI |
| Generic rendering: list, hierarchy, entity detail            | Domain-specific rendering: timeline, charts, progress bars  |
| Always available. Cannot be removed.                         | User installs what they need. Can be removed.               |
| Pinned entities with query blocks in sidebar                     | Specialized surfaces (Budget breakdown, Fitness log)        |
| Entity detail screen with body editor                        | Aspect-specific editors (workout builder, meal planner)     |

# 2. Native Aspect Awareness

Entity Browser treats most aspects generically (compact card in entity detail). But two built-in aspects get native, first-class treatment:

## 2.1 orbis/task — Full Task Management

When an entity has orbis/task, Browser renders it with task-specific UI:

- Checkbox — left side. Tap to complete (status → done). Color indicates priority: red=urgent, orange=high, yellow=medium, gray=low/none.
- Status badge — inbox/planned/in_progress/waiting as colored label
- Priority sort — entities with orbis/task sort by priority within their group
- Due date — shown right-aligned. Red if overdue.
- Dependency indicators — lock icon if blocked. Blocker name on hover/tap.
- Sidebar with pinned entities: any entity can be pinned. Entities with {{query:...}} in body act as dynamic lists (see section 4)
- Subtask progress — "2/5" counter showing completed/total children
- Swipe actions — right: complete. Left: set priority, move, archive.

This means full task management works in Entity Browser without any installed view. Entity Browser IS the task manager.

## 2.2 orbis/schedule — Date Awareness

When an entity has orbis/schedule, Browser shows:

- Date/time label inline in the entity row
- Recurrence indicator (repeat icon)
- "Open in Calendar" shortcut button on entity detail

Calendar view adds the domain-specific visualization (timeline, week grid). Browser adds the data.

## 2.3 All Other Aspects — Generic Cards

Any aspect that Browser doesn’t natively understand is rendered as a compact card on the entity detail screen: aspect name, key fields as label-value pairs, and "Open in \[View\]" button if that view is installed.

# 3. Hierarchy & Navigation

## 3.1 Entity List

The default view: a scrollable list of entities. Can be grouped and sorted.

| **Grouping Mode** | **How It Works**                                                        | **When Useful**                                     |
|-------------------|-------------------------------------------------------------------------|-----------------------------------------------------|
| By Project        | Top-level parents as sections. Children nested within.                  | Organizing work. Default for "all entities" view.   |
| By Tag            | Entities grouped by a selected tag.                                     | Cross-project grouping: all \#work, all \#personal. |
| By Aspect         | Entities grouped by which aspects they have.                            | Understanding what data exists.                     |
| By Date           | Grouped by created_at or due_date: today, this week, this month, older. | Chronological browsing.                             |
| Flat              | No grouping. Sorted by chosen field.                                    | Quick search results.                               |

## 3.2 Hierarchy Rendering

- Level 0 (root entities / projects): shown as sections with collapsible headers
- Level 1 (children): shown as list items within sections
- Level 2 (grandchildren): indented, collapsed by default
- Level 3+: hidden by default. "Show more" button reveals next level.
- Orphan entities (no parent): shown in a "No Project" section
- Drag-and-drop: reparent entities between projects, reorder within level

## 3.3 Breadcrumb Navigation

When drilling into a project or entity, a breadcrumb trail shows the path: Root → Project → Task → Subtask. Tap any breadcrumb to jump back. Provides orientation in deep hierarchies.

## 3.4 Filter Bar

Persistent filter bar below the header. Allows stacking multiple filters:

- By tags: \#work, \#personal, \#fitness (multi-select)
- By aspect: has orbis/task, has orbis/financial (multi-select)
- By status: inbox, planned, in_progress, waiting, done, cancelled (multi-select, only for entities with orbis/task)
- By priority: low, medium, high, urgent
- By date range: created/due within a period
- By relation: children of \[entity\], blocked by \[entity\]

Filters are combinable (AND logic). Saved filter combinations can be saved as new entities with query blocks in body ("Save as Smart List" creates entity + pins to sidebar).

# 4. Pinned Entities & Query Blocks

There is no separate "smart list" concept in Orbis. Instead, smart lists emerge from two existing mechanisms:

**1. `{{query:...}}` blocks in body** — any entity can contain dynamic query blocks that render live entity lists. An entity "Daily Planning" with body `{{query: aspect=orbis/task, due=today, excludeBlocked=true}}` IS a smart list.

**2. Pinned entities in sidebar** — any entity can be pinned to the Entity Browser sidebar via `user_settings.pinnedEntities`. Pinned entities with query blocks in body serve as navigation entry points.

### Example: "Daily Planning" entity

```
{
  title: "Daily Planning",
  emoji: "📌",
  tags: ["planning"],
  body: "## Today\n{{query: aspect=orbis/task, due=today|overdue, status=!done&!cancelled&!waiting, excludeBlocked=true, sortBy=priority:desc|due_date:asc}}\n\n## Inbox\n{{query: aspect=orbis/task, status=inbox, sortBy=created_at:desc}}\n\n## Waiting\n{{query: aspect=orbis/task, status=waiting, sortBy=updated_at:desc}}"
}
```

This single entity replaces three separate "smart lists" (Today, Inbox, Waiting). User taps it in sidebar → sees all three query results as sections in body. Can add notes, references to other entities, or additional query blocks.

### Built-in Entities

Pre-created on user registration and pre-pinned in sidebar:

| Entity Title | Body Content | Purpose |
|---|---|---|
| Daily Planning | {{query: today}} + {{query: inbox}} + {{query: waiting}} | Primary daily surface |
| Upcoming | {{query: due=next_7d, sortBy=due_date:asc}} | Week ahead view |
| All Tasks | {{query: aspect=orbis/task, status=!done, sortBy=updated_at:desc}} | Everything |

Users can unpin built-in entities, edit their body (add/remove query blocks), or archive them. They are regular entities with no special treatment.

## 4.1 Built-in Entity: "Daily Planning"

Pre-created entity with body containing three query blocks:

```markdown
## Inbox
{{query: aspect=orbis/task, status=inbox, sortBy=created_at:desc, title=Inbox}}

## Today
{{query: aspect=orbis/task, due=today|overdue, status=!done&!cancelled&!waiting, excludeBlocked=true, sortBy=priority:desc|due_date:asc, title=Today}}

## Waiting
{{query: aspect=orbis/task, status=waiting, sortBy=updated_at:desc, title=Waiting}}
```

This is the primary daily surface. "Inbox" shows unprocessed items (GTD capture point). "Today" shows actionable tasks — blocked tasks excluded via `excludeBlocked=true`, surfaces automatically when blocker completes. "Waiting" shows delegated/blocked items.

Badge in sidebar: combined count of Inbox + Today items.

## 4.2 Built-in Entity: "Upcoming"

```markdown
## Next 7 Days
{{query: aspect=orbis/task, due=next_7d, status=!done&!cancelled, excludeBlocked=true, sortBy=due_date:asc|priority:desc, title=Next 7 days}}

## Later
{{query: aspect=orbis/task, due=after_7d, status=!done&!cancelled, sortBy=due_date:asc, limit=30, title=Later}}
```

Week-ahead planning view.

## 4.3 Built-in Entity: "All Tasks"

```markdown
{{query: aspect=orbis/task, status=!done&!cancelled, sortBy=updated_at:desc, title=All active tasks}}
```

Full task list. Universal browser mode. Users can edit this entity's body to add custom grouping or additional query blocks.

## 4.7 Creating Custom "Smart Lists"

Users create entities with query blocks through:

- **Filter Bar → "Save as Smart List"**: configure filters → tap "Save" → enter name + emoji → new entity created with {{query:...}} in body, auto-pinned to sidebar.
- **AI Chat**: "Create a list for all urgent work tasks" → AI creates entity with {{query:...}} in body, pins to sidebar.
- **Manual**: create any entity, write {{query:...}} in body, pin to sidebar.

Pinned entities appear in sidebar, ordered by position in `user_settings.pinnedEntities`. User can drag to reorder, unpin, or archive.

# 5. Entity Detail Screen

Tap any entity to open full detail. This is the universal entity editor — works for any entity regardless of aspects.

## 5.1 Layout

- Title (editable, large font) + emoji picker
- Tags (inline editing, auto-complete from existing tags)
- Body editor (markdown with extensions: formatted text, inline `[[entity:uuid|name]]` references, `{{query:...}}` dynamic query blocks). Collapsed if empty, expandable. MVP: textarea with markdown preview. Future: Lexical rich editor.
- Aspect cards — one compact card per attached aspect. Each card shows key fields and is editable inline:
  - orbis/task card: status selector, priority dots, due date, effort estimate, waiting_for, context
  - orbis/schedule card: date/time picker, duration, recurrence, location. "Open in Calendar" button.
  - orbis/financial card: amount, direction, category. "Open in Budget" button (if installed).
  - Other aspects: generic key-value card with "Open in \[View\]" if view installed.
- Subtasks — inline list of children with add button. Same rendering as main list.
- Dependencies — "Blocked by" and "Blocks" sections with add button
- Related entities panel — aggregated from: explicit relations, body references, backlinks, query appearances. Grouped by type.
- Activity log — timestamps of changes (future: who modified for multi-user)

## 5.2 Adding Aspects

At the bottom of the detail screen: "+Add aspect" button. Shows available aspects (both built-in and custom). Attaching an aspect adds its card to the detail screen. The entity now appears in the corresponding view (if installed).

Example: entity "Monday Workout" has orbis/task. User taps +Add aspect → orbis/fitness. Now it has a fitness card with exercises fields, and appears in Fitness view.

## 5.3 Quick Capture

Persistent input bar at the bottom of Entity Browser. Typing creates a new entity:

- In pinned entity context (viewing Daily Planning): new entity gets orbis/task with appropriate status
- In project context (viewing a project): new entity becomes child of that project
- In All Entities: new entity with minimal fields, goes to Inbox if orbis/task active
- Hold-press for expanded creation: set tags, aspects, parent in one step

# 6. Dependencies

## 6.1 Data Model

Dependencies use the "blocks" relation: {source_id: A, target_id: B, relation_type: "blocks"} means A blocks B.

## 6.2 Chains

A → B → C → D. Completing A unblocks B (not C,D). Completing B unblocks C. System computes: directly blocked, available, critical path.

## 6.3 UI

- Entity detail: "Blocked by" and "Blocks" sections
- Entity list: blocked entities show lock icon + dimmed. Blocker name on tap.
- Today: blocked entities completely hidden (not dimmed — hidden). Appear when unblocked.
- Creating: via Chat ("B depends on A") or via UI (link picker in dependency section)
- Circular prevention: system rejects cycles with error message

## 6.4 Auto-Unblocking

- Entity completed → system finds all entities it blocks
- For each: check if ALL blockers now complete → if yes: unblocked
- If unblocked entity has due_date = today → appears in Today instantly
- AI notifies: "Design API done. Build API is now unblocked and due tomorrow."

## 6.5 Cross-Aspect Dependencies

A task with orbis/schedule that is blocked still shows in Calendar (it’s scheduled). But Entity Browser marks it blocked. AI warns: "Build API is scheduled Wednesday but blocked by Design API. Reschedule?"

# 7. Recurring Entities

## 7.1 Data Model

Recurrence lives in orbis/schedule.recurrence field: {freq: daily|weekly|monthly|yearly, interval, days[], until}. This is the single source of truth for "when does an entity repeat". orbis/task does NOT have a recurrence field — scheduling belongs in orbis/schedule.

## 7.2 Template + Instances

- Template: the recurring entity definition. Has orbis/schedule with recurrence field.
- Instances: auto-generated for upcoming dates. Each is a new entity with derived_from relation to template.
- Instances inherit: title, tags, priority, effort, other aspects from template.
- Instances are independent: completing one doesn’t affect others.
- Generation: background job generates next 2 weeks of instances.

## 7.3 Modifications

- Edit template: changes apply to future instances (not past completed)
- Edit single instance: detaches from template for modified fields
- Skip instance: status → cancelled. Next instance still generates.
- Stop recurrence: remove recurrence from orbis/schedule. Existing instances remain.

## 7.4 Recurring + Other Aspects

A recurring entity with orbis/schedule gets time-blocked instances: "Every MWF at 08:00, 90 min". Each instance gets its own schedule. Appears in both Browser and Calendar.

# 8. UI Specification

## 8.1 Main Screen Layout

- **Header:** "Orbis" title + search icon + settings gear.
- **Sidebar:** Collapsible left panel (drawer on mobile). Contains: pinned entities (Daily Planning, Upcoming, projects, any entity) with badges for query results. "Pin entity" button. Tap item → loads entity detail with body (query blocks render live results) in main area.
- **Filter bar:** Below tabs. Collapsible. Shows active filters as removable chips.
- **Main area:** Shows the selected sidebar entity’s detail (body with query results), or filtered entity list when no sidebar item is selected.
- **Quick add bar:** Bottom. Persistent input for fast entity creation.

## 8.2 Entity Row Rendering

Each entity in the list:

- Checkbox (left, only if has orbis/task) — priority-colored
- Emoji (if set)
- Title (center) — strikethrough if done
- Metadata row: parent project name (dimmed), due date (red if overdue), tag pills (first 2-3), aspect icons (small, showing which aspects are attached)
- Subtask counter (right) if has children: "2/5"
- Blocked indicator: lock icon + dimmed if blocked
- Recurring indicator: repeat icon if has recurrence

## 8.3 Entity Row for Non-Task Entities

Entities without orbis/task (pure notes, expenses, etc.):

- No checkbox (not actionable)
- Aspect icons shown prominently: ₽ for financial, 🏋 for fitness, etc.
- Same metadata row: tags, parent, date
- Tap opens same Entity Detail screen

## 8.4 UI States

| **State**          | **Appearance**                          | **Behavior**                                |
|--------------------|-----------------------------------------|---------------------------------------------|
| Normal entity      | Full opacity. Aspect icons shown.       | Tap to open detail.                         |
| Task entity        | Checkbox + priority color.              | Checkbox to complete. Tap title for detail. |
| Blocked task       | Dimmed + lock icon. Blocker name.       | Can edit but not complete. Hidden in Today. |
| Waiting task       | Dimmed + clock icon. Waiting_for shown. | Only in Waiting list.                       |
| Overdue task       | Red due date. Elevated position.        | At top of Today.                            |
| Completed task     | Strikethrough. Checked. Faded.          | In done section (collapsed).                |
| Recurring template | Repeat icon next to title.              | Tap opens template editor.                  |
| Non-task entity    | No checkbox. Aspect icons prominent.    | Tap opens detail. Full body editor.         |

# 9. AI Scenarios

## 9.1 Quick Capture

- ***"Buy groceries"*** → entity.create(tags:\["task","errand"\], aspects:{"orbis/task":{status:"inbox"}}). Appears in Inbox.
- ***"Finish API by Friday"*** → entity.create(aspects:{"orbis/task":{status:"planned", priority:"high", due_date:"2026-03-20"}}). AI links as child of Orbis project.
- ***"Note: consider using GraphQL"*** → entity.create(tags:\["note","tech","orbis"\], aspects:{"orbis/note":{}}). Body populated with text. No orbis/task — it’s a note, not actionable.

## 9.2 Entity Management

- ***"What’s in my inbox?"*** → query from Daily Planning entity. Response: task list card.
- ***"Process my inbox"*** → AI reads inbox items, suggests project/priority/due_date for each.
- ***"Show me everything tagged \#work"*** → entity.query(tags:\["work"\]). All entities, not just tasks.
- ***"What did I work on this week?"*** → entity.query(aspects:"orbis/task", status:"done", completed_at: this_week). Summary card.

## 9.3 Dependencies

- ***"Build API depends on Design API"*** → entity.link(source: design_api, target: build_api, type: blocks)
- ***"What’s blocking the release?"*** → Traverse dependency graph. Critical path card.
- ***"Done with Design API"*** → Complete. AI: "Build API now unblocked and due Thursday."

## 9.4 Body & Content

- ***"Add a description to Build API"*** → AI appends text blocks to entity body.
- ***"In Orbis project, add a live list of all blocked tasks"*** → AI inserts entity_query block into Orbis body.
- ***"Link this to Design API in the description"*** → AI adds inline entity_ref mark. Implicit relation auto-created.

## 9.5 Cross-Aspect Intelligence

- ***"Plan my work week"*** → Reads tasks + schedule + fitness + habits. Creates time-blocked plan respecting dependencies and effort.
- ***"Break down Orbis into tasks"*** → Creates child entities with dependencies. Links with derived_from.
- ***"Every MWF at 8am: workout"*** → Recurring entity with orbis/task + orbis/schedule + orbis/fitness.

# 10. Key Data Flows

## 10.1 Completing an Entity

- User taps checkbox or says "done with X"
- orbis/task.status → done, completed_at → now()
- System checks outgoing blocks relations
- Each blocked entity: if all blockers done → unblocked → may appear in Today
- If parent has orbis/goal: update goal.current_value
- If recurring: check if next instance needs generation

## 10.2 Today Computation

SELECT e FROM entities e

WHERE e.aspects ? 'orbis/task'

AND e.aspects-\>'orbis/task'-\>\>'status' NOT IN ('done','cancelled')

AND (

(e.aspects-\>'orbis/task'-\>\>'due_date')::date \<= CURRENT_DATE

OR e.aspects-\>'orbis/task'-\>\>'status' = 'in_progress'

)

AND e.aspects-\>'orbis/task'-\>\>'status' != 'waiting'

AND NOT EXISTS (

SELECT 1 FROM relations r JOIN entities b ON r.source_id = b.id

WHERE r.target_id = e.id AND r.relation_type = 'blocks'

AND b.aspects-\>'orbis/task'-\>\>'status' NOT IN ('done','cancelled')

)

ORDER BY priority_order(e), due_date, created_at

# 11. Edge Cases

| **Scenario**                         | **Behavior**                                                                  |
|--------------------------------------|-------------------------------------------------------------------------------|
| Circular dependency                  | System rejects with error. Validates full chain before creating relation.     |
| Complete parent with active children | AI asks: complete all children, cancel remaining, or just mark parent?        |
| Blocked task becomes overdue         | Hidden from Today. Flagged in Upcoming. AI alerts proactively.                |
| Recurring task with dependencies     | Template dependencies copied to instances. Each instance independent.         |
| Entity in multiple projects          | One parent (primary). Additional related_to relations for secondary projects. |
| Move between projects                | Parent relation changes. Children move with it. Tags and aspects preserved.   |
| Offline completion                   | Computed locally. Synced on reconnect. Aspect-level LWW for conflicts.        |
| Entity with no aspects               | Valid. Shows in All Entities with title + tags + body. A pure note or idea.   |

# 12. Status Strip Metrics

| **Metric**  | **Computation**                       | **Display**                   |
|-------------|---------------------------------------|-------------------------------|
| Inbox count | COUNT WHERE orbis/task.status = inbox | Badge number. Red if \> 10.   |
| Today count | COUNT from Today query block           | "3 today" with progress ring. |

# 13. MVP vs Future

## 13.1 MVP

- Pinned entities in sidebar with {{query:...}} blocks. Built-in entities pre-created + pre-pinned. Custom via Filter Bar / AI / manual.
- Hierarchy: unlimited depth, UI optimized for 3 levels
- Dependencies: blocks relation, circular prevention, auto-unblocking
- Recurring entities: template + instances, basic frequencies
- Entity detail: body editor, aspect cards, tags, relations, subtasks
- Grouping: by project, by tag, by date, flat
- Filter bar: tags, aspects, status, priority, date range
- Native orbis/task + orbis/schedule rendering

## 13.2 Future

- Extended query syntax (excludeBlocked, complex sort)
- Kanban view (optional view package, not core)
- Eisenhower matrix (optional view package)
- Gantt chart (optional view package)
- Time tracking (start/stop timer on entities)
- AI auto-prioritization
- AI inbox processing (batch)
- Project templates with pre-defined structure
- Multi-user delegation (assign to others)
