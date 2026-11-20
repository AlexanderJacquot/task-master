# ADR 030: Roadmap (Gantt) page and saved roadmap views

Date: 2026-11-20 · Status: proposed (implemented on branch `roadmap`)

## Context

Lineage shows which tasks wait on which, but not when. Planning a release or an epic needed
a timeline: tasks as bars, dependencies between them, and an epic's target date, with the
same "save this as a view" that Lineage has (ADR 022). Tasks have a due date and an
estimate; epics have a target date. Nothing has a start date.

## Decisions

**A Roadmap page next to Lineage.** `/roadmap`, in the sidebar, the collapsed rail and the
command palette. Rows are tasks grouped by epic (default), by project, or not grouped; a
group's header shows the span of its bars and, for an epic, its target date as a milestone.
Timescale: days, weeks (default), months or quarters. Filters as on Lineage (one project,
epics, tags, completion, subtasks) plus "Unscheduled tasks". Agents' own tasks stay off.
Done tasks are hidden by default ("Open only").

**A bar ends on the task's due date.** Moving a bar or its end edits the task's due date
through `execute` (optimistic, undoable, synced). Dragging an epic's milestone edits the
epic's target date. Nothing new in the tables.

**The start belongs to the roadmap, not the task.** Tasks have no start date and adding one
(a migration, sync, the MCP tools, the task page) is more than a roadmap needs to begin
with. A bar's start is kept by the roadmap: on this machine for the plain page (like
Lineage's card positions), in the view's spec for a saved roadmap. A bar without one
starts as many working days before its end as its estimate takes (8 hours a day, at
least one day). A start after the due date (moved earlier elsewhere) is pulled back to it.
If starts turn out to matter outside the roadmap, a `start_date` on tasks can replace the
roadmap's starts later: the roadmap would read it first.

**Scheduling from the roadmap.** An unscheduled task shows as an empty row: drag across it
to draw its bar, or use its Schedule button (from today, as long as its estimate).

**Dependencies.** Arrows go from a prerequisite's end to its dependent's start. A dependent
that starts on or before its prerequisite's last day is flagged (red dashed arrow, a ring on
its bar, a count in the header). The roadmap does not move dependents for you.

**A roadmap view is a saved view.** `ViewSpec` gains `roadmap: Option<RoadmapSpec>` (serde
default; older apps ignore it and show such a view as an "All tasks" list).
`RoadmapSpec` holds `completion`, `group`, `zoom`, `starts` (task id → `YYYY-MM-DD`, only
for bars shown when saving), `collapsed` groups and `hide_unscheduled`. Project, epic and
tag filters are the spec's `filter` and "Show subtasks" is `show_subtasks`, as for lineage
views. The core rejects a roadmap spec with another scope than `All`, more than one
project, a lineage spec beside it, or a start that is not a date. `/view/$viewId` opens it
on the Roadmap page; Save, Revert, rename and delete work as on Lineage. Edits to the
filters, timescale, starts and folds are a draft until "Save view"; due dates and target
dates change at once, since they are the tasks' own.

**Keyboard.** A bar: ←/→ move it a day (Shift: a week), Alt+←/→ move its start, Ctrl/⌘+←/→
its end, Enter opens the task. A milestone: ←/→ (Shift: a week).

## Consequences

- No schema change and nothing for the sync server, which relays ops. An older app shows a
  roadmap view as an "All tasks" list, and drops `roadmap` if it saves that view.
- The same task can start on different days in two saved roadmaps; its end is the same
  everywhere.
- The rows are virtualized; the scale, weekend shading and arrows are one element per
  tick, weekend day or link (no repeating gradients, per docs/rendering-performance.md).
