# ADR 022: Saved Lineage views

Date: 2026-11-11 · Status: proposed (implemented on `worktree-save-lineage-views`)

## Context

The Lineage page keeps its filters and its canvas layout (card positions, lane positions,
pinned cards, folded lanes, camera) in this machine's `localStorage`, one layout for the
whole page. After arranging a set of tasks, there was no way to keep that arrangement
under a name and come back to it, next to the saved lists and boards.

## Decisions

**A lineage view is a saved view.** It is a row of `views` like any other (ADR 005): named,
ranked, soft-deleted, undoable, synced, listed under "Saved views" in the sidebar (with the
Lineage icon) and in the command palette. `ViewSpec` gains `lineage: Option<LineageSpec>`
(serde default, so older specs load unchanged; older apps ignore the key and show such a
view as an "All tasks" list). When it is set, `/view/$viewId` opens the Lineage page.

**What it holds.** The project, epic and tag filters go in the spec's `filter`
(`project_ids` holds one project at most) and "Show subtasks" in `show_subtasks`; the scope
is `All`. `LineageSpec` adds the rest of the page: `around` (one task's lineage),
`completion`, `linked_only`, `arrange`, and the layout: `positions`, `lanes` (per
arrangement), `pinned`, `collapsed`. Points are whole pixels (`i32`), which keeps the spec
`Eq` like the rest of the model. Only the cards on the canvas when saving keep a position.
The core rejects a lineage spec with another scope or more than one project, and an
`around` that is not a live task.

**Cards follow the filters.** The view stores filters, not a frozen list of task ids: a
task created later that matches shows up (placed by the automatic layout until moved).

**No camera.** The camera depends on the window size; a saved view opens framed on its
cards. Panning and zooming are not edits.

**Draft until saved.** As with list and board views, changing a filter, the arrangement or
the focused task, moving, nudging, pinning, re-arranging cards or folding a lane shows
"Revert" and "Save view". Revert remounts the page from the stored view. In a view,
"Show only its lineage" and the focus chip's × change the draft instead of leaving the view.
A view's edits never touch the machine-local layout of the plain Lineage page.

**Saving.** The Lineage page header has "Save as view" (name field); the view page's title
renames it, and "Delete view" removes it and returns to the Lineage page.

## Consequences

- Layouts now sync between devices for saved views, while the plain Lineage page's layout
  stays per machine.
- Saving a large canvas writes every visible card's position into one spec (and one op).
  Fine for hundreds of cards; revisit if specs grow large.
- A view saved around a task that is later deleted opens on all tasks matching its filters.
