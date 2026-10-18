# День и Входящие

## Approved intent

The user approved replacing the overloaded personal dashboard with a simple daily task list and asked for an Inbox for unprocessed thoughts, links and tasks. Existing records, project links, knowledge and strategy must survive. The primary workflow is: choose Tomorrow, enter three tasks, reorder, reload, complete one and move another. No project, priority or deadline is required to capture a task.

## User experience

- Day: Today / Tomorrow / date selection; inline title entry with Enter; persisted ordering; completion directly in the list; collapsed completed section; move to another day; add existing project tasks without duplication. A planned day is separate from a deadline.
- Inbox: free-text capture with no mandatory categorization. Process the same record into a task (optionally add to a day), a note, Later, or Archive. Later is an accessible tab and records can return to Inbox. Existing unclassified records and inbox tasks remain discoverable. No automatic classification or automatic scheduling.
- Navigation: Day, Inbox, Projects, Knowledge, Strategy. Preserve cycle/reviews under Strategy and reserve under Projects. Simplify the user's existing task/project templates and remove smoke-test copy and numeric task-title prefixes.
- Appearance: reuse existing dark/light tokens and controls, clear list hierarchy, concise labels, no planning instructions above the list. Accessible buttons, keyboard operation and narrow viewport support.

## Implementation decisions

Implement native lazy page blocks `{{day-planner}}` and `{{inbox}}`, using existing page routing and graph entities. Do not add a separate database or task store. Register `orbis/planned_date` (date), `orbis/plan_order` (nonnegative integer), and `orbis/inbox_state` (pending / processed / later). Task planning fields belong to the task aspect; inbox state is a general optional property. Planning does not change due_date. Ordering is a stable numeric field with createdAt/id tie-breakers. Reordering adjacent tasks uses the existing atomic updateBatch command and Undo.

New global raw capture marks inbox_state=pending and does not attach a task aspect. Legacy inbox detection includes task_status=inbox and records with no aspects, excluding archived and explicitly deferred/reference records. Processing preserves content, tags and unrelated aspects, and moves the same entity out of the inbox. Knowledge attaches note and gtd-reference for the existing knowledge view; Later stays explicitly discoverable. Scheduling an existing task preserves waiting/in-progress states and project relations, while an inbox task becomes planned. Agent-assigned active work must not be silently duplicated or restarted.

Date boundaries use the owner's settings time zone; calendar arithmetic is date-only. Query result limits are visible and expandable. Errors preserve typed text; uncertain create retries use the same entity id; no success is reported before acknowledgement. Mutations use existing graph write paths and Undo. Page-only blocks are not executable inside record/template preview.

## Delivery and verification

Implement and test in an isolated worktree from current origin/main. Inspect desktop and narrow layouts in a local preview with clearly synthetic data, then validate connected behavior without creating fake production tasks. Personal navigation/content migration is backed up and applied only after the deployed app understands the new blocks. No secrets or production data go into code or fixtures. User files and other worktrees remain untouched.

## Out of scope

Automatic task generation, AI prioritization, recurring plans, a complete redesign of every Orbis surface, and automatic changes to the user's life strategy.
