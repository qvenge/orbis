# Day and Inbox Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make daily planning and raw capture directly usable in Orbis while keeping all existing graph records.

**Architecture:** Add two lazy page blocks backed by ordinary graph entities. Reuse the registry, date-only values, atomic graph commands and shared Undo. Update the user's page configuration separately after compatible code is deployed.

**Tech Stack:** TypeScript, React, tRPC, Bun, Vitest, existing Tailwind tokens and Radix controls.

**Spec:** `docs/superpowers/specs/2026-10-18-day-and-inbox-design.md`

## Global Constraints

- No independent task store, new runtime dependencies or credential changes.
- Preserve existing record IDs, bodies, relationships and unrelated properties.
- Planned day and deadline are distinct fields.
- Use the owner's time zone for Today/Tomorrow and explicit date-only storage.
- Keep heavy interactive blocks lazy and do not mutate from preview.
- Do not modify production pages until the deployed release supports the new blocks.

## Review Focus

- Changing day or editing the draft during a slow/failed create must not lose input or schedule on the wrong day (Task 2).
- Existing completed, waiting, deferred and aspect-less records must not disappear or be accidentally reactivated during triage (Task 3).
- Two equal ordering values and moving to a populated day must retain a deterministic order (Tasks 1/2).
- Server error/unknown outcomes must retain input and retry identity instead of duplicating entities (Task 2).
- Date boundaries, browser/owner time-zone differences and archived records must not leak into the wrong day/inbox (Tasks 1/3).

### Task 1: Graph and page contracts

**Files:** `packages/shared/src/registry/builtin-properties.ts`, `builtin-aspects.ts`, `builtin.test.ts`; `packages/shared/src/doc/page-grammar.ts` and tests; `apps/web/src/features/entity-editor/layout-parts.tsx`; new `apps/web/src/features/planning/model.ts` and `model.test.ts`.

**Interfaces:** Export planned/inbox property keys, `planningDayOffset(day, offset)`, `sortPlannedTasks(rows)`, safe inbox query construction and update builders consumed by Tasks 2/3. New host names are `day-planner` and `inbox`.

- [x] Add failing tests for registration, page parse/print/placement, date-only leap/month boundaries, deterministic ordering and mutation patches that never write due_date.
- [x] Run targeted Bun/shared and Vitest/model tests; verify expected failures.
- [x] Register properties and task fields; extend host-block vocabulary and editor labels; implement model helpers.
- [x] Run targeted tests and typecheck.

### Task 2: Day list

**Files:** new `apps/web/src/features/planning/DayPlanner.tsx`, `PlanningCapture.tsx`, `PlannedTaskRow.tsx`, `TaskPicker.tsx`, `PlanningBlockSlot.tsx`, tests; `apps/web/src/features/page/Renderer.tsx`.

**Interfaces:** `DayPlanner()` rendered by lazy `PlanningBlockSlot({kind:'day-planner'|'inbox'})`; graph input/output types come from existing trpc. Use existing create with a stable retry id and updateBatch for reorder/updates.

- [x] Add interaction tests for date selection, repeated Enter capture, completion, adjacent reorder/shared Undo and uncertain save retry after date/draft changes; verify move/existing-task patches in model/server checks.
- [x] Implement the date selector, inline capture, open/completed lists, row menu with move and reorder, existing-task picker.
- [x] Keep form text on failure, bind create identity to original day/text, prevent duplicate submissions and avoid swallowing date changes during pending writes.
- [x] Mount lazy blocks in the page renderer; run targeted interaction and page tests.

### Task 3: Inbox and raw capture

**Files:** new `apps/web/src/features/planning/Inbox.tsx`, `InboxRow.tsx`, tests; `apps/web/src/features/browser/QuickCapture.tsx` and impacted tests.

**Interfaces:** Inbox combines explicitly pending records, legacy aspect-less records and unprocessed inbox tasks with deduplication. Later is a separate query. Actions update the same entity using existing graph commands.

- [x] Add tests for raw multiline capture, legacy entry classification, task/note conversion without content loss and stale status protection; check Later/return in the browser.
- [x] Implement the surface and triage actions; mark global raw capture pending while retaining existing child-task behavior.
- [x] Test that deferred/reference/archived records are excluded from pending and remain retrievable in their appropriate view.
- [x] Run relevant capture, planning and page tests, full typecheck and scoped lint; build production bundles and run lazy-boundary checks.

### Task 4: Reviewable delivery and personal migration

**Files:** spec/plan status; a local backed-up Orbis migration outside source; optional local synthetic preview fixture kept out of production routes.

- [x] Run a focused code review, resolve material issues and run appropriate regression checks.
- [x] Inspect the real components in a local browser at desktop and phone widths, checking keyboard and persistence behavior with synthetic data clearly separated from production.
- [ ] Prepare a reviewable commit/PR and compatible deployment through the repository's normal flow. Do not claim the live app changed from local verification.
- [ ] Re-read and back up current Orbis pages; migrate navigation and page bodies after release; remove only known numeric prefixes and smoke template copy, preserve all other user edits.
- [ ] Verify the live pages, Inbox and day workflow and provide the direct starting link with any remaining limitation.

## Validation and release status (2026-10-19)

One final fresh review reported two Important findings: uncertain creation could change identity after a date/draft change, and cached Inbox status could overwrite another writer. Both are addressed in the fix pass. Creation retains an immutable unresolved intent and exposes explicit retry; task promotion carries a narrow UI-only expected status checked atomically by the existing executor.

Targeted results: 216 shared contract/parser/registry tests; 12 planning model/UI tests; 20 PostgreSQL planning/seeding tests; 68 existing page/preview/browser tests passed. The overloaded parallel full run was stopped after widespread timeouts; it is not recorded as green. Full CI remains the release gate. Production pages are unchanged. The backed-up personal navigation migration is prepared outside this public repository and must be re-read/reconciled after compatible deployment.
