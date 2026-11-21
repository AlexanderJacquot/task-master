# ADR 031: Roadmap (Gantt) of epics and epic timelines, with saved views

Date: 2026-11-20 · Status: proposed (implemented on branch `roadmap`)

## Context

Lineage shows which tasks wait on which, but not when. Planning needed a timeline at two
heights: the epics across projects (what ships when), and inside one epic, its tasks lined
up against the epic's target date. Both should be savable as views, like Lineage (ADR 022).
Tasks have a due date and an estimate; epics have a target date. Nothing has a start date.

## Decisions

**Two levels on one Roadmap page.** `/roadmap`, in the sidebar under Lineage, the collapsed
rail and the command palette.

- *The roadmap of epics* (`/roadmap`): one row per epic, grouped by its home project (or not
  grouped). Projects filter (any number; an epic without a home project shows with the
  projects of its tasks), active epics or all, timescale, epics without a target date.
- *An epic's timeline* (`/roadmap?epic=<id>`): its tasks, subtasks under their parent. Tags,
  completion, timescale, unscheduled tasks, subtasks. Opened from an epic's row on the
  roadmap or the epic page's "Timeline" button.

Agents' own tasks stay off both.

**Bars end on dates the items already have.** An epic's bar ends on its target date; a
task's on its due date. Moving a bar or its end edits that field through `execute`
(optimistic, undoable, synced). On an epic's timeline, the epic's target date is a dashed
line with a draggable handle on the scale; tasks ending after it are flagged.

**The start belongs to the roadmap.** Neither epics nor tasks have a start date, and adding
one (migration, sync, the MCP tools, the task page) is more than a roadmap needs to start.
A bar's start is kept by the roadmap: on this machine for the plain pages (like Lineage's
card positions; one layout for both levels, since epic and task ids never collide), in the
view's spec for a saved roadmap. Without one, a task starts as many working days before its
end as its estimate takes (8 hours a day, at least one day); an epic starts where its
earliest task starts, else two working weeks before its target date. A start after the end
(moved earlier elsewhere) is pulled back to it. If starts turn out to matter outside the
roadmap, a `start_date` field can replace the roadmap's starts later.

**Scheduling from the roadmap.** An epic without a target date, or a task without a due
date, is an empty row: drag across it to draw its bar, or use its Schedule button (from
today, as long as its estimate; two working weeks for an epic). An unscheduled epic shows a
dashed outline where its tasks are planned, as a guide.

**Dependencies.** Arrows go from a prerequisite's end to its dependent's start. Between
epics they are derived: epic B waits on epic A when a task of B waits on a task of A, so
there is nothing new to keep. A bar that starts on or before the last day of what it waits
on is flagged (red dashed arrow, a ring on its bar, a count in the header). Nothing moves
dependents automatically.

**Progress.** An epic's bar fills with the share of its tasks that are done (cancelled ones
left out).

**A roadmap view is a saved view.** `ViewSpec` gains `roadmap: Option<RoadmapSpec>` (serde
default; older apps ignore it and show such a view as an "All tasks" list). `RoadmapSpec`:
`epic` (set for an epic's timeline), `completion`, `group` (`project` or `none`), `zoom`,
`starts` (epic or task id → `YYYY-MM-DD`, only for bars shown when saving), `collapsed`
groups, `hide_unscheduled`. The projects are the spec's `filter.project_ids` (any number),
an epic timeline's tags `filter.tag_ids` and its subtasks `show_subtasks`. The core rejects
a roadmap spec with another scope than `All`, a lineage spec beside it, an `epic` that is
not a live epic, or a start that is not a date. `/view/$viewId` opens it on the Roadmap
page; Save, Revert, rename and delete work as on Lineage. Filters, timescale, starts and
folds are a draft until "Save view"; target and due dates change at once, since they are
the epics' and tasks' own. In `ViewSpec` the spec is boxed, which keeps `Command` small.

**Keyboard.** A bar: ←/→ move it a day (Shift: a week), Alt+←/→ move its start, Ctrl/⌘+←/→
its end, Enter opens it (the task, or the epic's timeline). The target date handle: ←/→
(Shift: a week).

## Consequences

- No schema change and nothing for the sync server, which relays ops. An older app shows a
  roadmap view as an "All tasks" list, and drops `roadmap` if it saves that view.
- The same epic or task can start on different days in two saved roadmaps; its end is the
  same everywhere.
- Rows are virtualized; the scale, weekend shading, guides and arrows are one element per
  tick, weekend day, row or link (no repeating gradients, per docs/rendering-performance.md).
- Exporting a roadmap as an image: ADR 034 (a data → SVG renderer in the core, which a
  server endpoint can reuse).
