# ADR 005: Saved views, view specs and organization UI

Date: 2026-11-04 · Status: accepted

## Context

M4 needs saved views (filter, group, sort, layout, swimlanes) that reopen identically, tag
views, and management UI for projects and epics. Migration 0001 created `views` without
timestamps or `deleted_at`, and `spec` was an opaque string "defined in M4".

## Decisions

**Migration 0002.** `views` gains `created_at`, `updated_at` and `deleted_at`, so views
follow the same rules as every other entity: soft delete, ops with inverses, undo/redo.
New commands `create_view`, `update_view` (name, spec, rank) and `delete_view`;
`Changes` and `EntityKind` include views.

**Typed, versioned spec.** `ViewSpec` is a Rust struct exported to TypeScript, stored as
JSON in `views.spec`: `version` (1), `scope` (inbox, today, all, project, epic, tag),
`filter` (status, priority, project, epic and tag id lists, due: overdue/today/week/none),
`group_by`, `sort`, `layout`, `swimlane`, `show_subtasks`, `show_cancelled`. Every field
but `scope` has a serde default so older specs keep loading as fields are added. The core
rejects an unknown version and ids that are not live entities or statuses. Compiling specs
to SQL for the CLI/MCP is deferred (progress.md, Later).

**One code path for every view.** Built-in routes and saved views both build a spec and go
through `lib/views.ts` (`matchesQuery`, `buildRows` with grouping and sort) and
`lib/board.ts` (`buildBoard`; a status filter limits the columns). `ViewKey` is now an
alias of `ViewScope`.

**Where display choices live.** Built-in views keep theirs per machine in `localStorage`
(`useViewPrefs`, which reads M3's keys). A saved view keeps them in its spec; edits are a
draft until "Save view", "Revert" discards them, and the page remounts when the stored
view changes (save, rename, undo) so it always reopens as saved. "Save as view" works from
any page and captures its current scope and display.

**Capture follows the scope.** A task typed into a project, epic, tag or Today view gets
that project, epic, tag or `today_on`, so it appears where it was typed.

**Projects and epics.** The project page header renames (double-click), colors, moves a
project into an area or out of one, archives/unarchives and deletes (the core refuses a
non-empty project; the toast explains). The sidebar lists archived projects and done or
dropped epics in collapsed sections, and reorders projects among siblings by pointer drag
(dnd-kit). After a drop, dnd-kit stops the click's propagation but not its default action,
so a native capture listener cancels the link's navigation. The epic page edits state,
target date, home project and description, and shows progress (done / non-cancelled).

## Consequences

- Specs referencing a later-deleted project, epic or tag still load; the scope shows as
  "not found" and filters on missing ids simply match nothing.
- Multi-select and bulk actions remain for later (plan section 6, list view).
