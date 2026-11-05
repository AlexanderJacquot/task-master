# ADR 004: Kanban board, drag and drop, rank rebalancing

Date: 2026-11-04 · Status: accepted

## Context

M3 adds the board (plan section 6): columns per status, drag and drop within and between
columns, keyboard moves, swimlanes, WIP warnings and a subtask toggle. The plan names
dnd-kit and the "rebalance when a key exceeds 32 chars" mitigation (section 10) but not
how the board shares code with the list or where layout choices live.

## Decisions

**Library.** `@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0 and `@dnd-kit/utilities`
3.2.2 (the `CSS` transform helper the sortable docs use), pinned exactly. Approved before
being added.

**Board model.** `lib/board.ts` is a pure function like `buildRows`: same `ViewKey` and
`inView` filter, columns in workflow order, cards in manual `rank` order (the list keeps
its smart default sort). A subtask is hidden as a card when its parent is on the board,
unless the toggle is on. In the Inbox and Today, which list open tasks only, the board also keeps
tasks closed today (`inView(..., { keepClosedToday: true })`), so a card dropped on Done
stays visible until tomorrow instead of vanishing. The list keeps its open-only rule.
Swimlanes group by project, epic or priority; each lane carries
the change a drop into it makes (`project_id`, `epic_id` or `priority`).

**Drops.** One drop is one undoable batch: `move_task` with a rank between the new
visible neighbours, or a single `update_task` with status, rank and the lane change. A key
between visible neighbours keeps the visible order even with hidden tasks in the same
status. When the neighbours share a rank (possible because subtasks rank among siblings),
the action renumbers the target cell in the same batch instead of failing.

**Drag state.** During a drag the board keeps local cell orders so a card can visit other
cells (dnd-kit's multi-container pattern) and renders a `DragOverlay`; the store changes
only on drop. A cross-cell move is held for one animation frame and collisions keep the
last target while the layout settles (pointer, then overlap, then the closest card in the
cell), as in dnd-kit's multiple-containers example. Without it, shaking a card between
columns made the target flip every render until React stopped with "Maximum update depth
exceeded" (seen in the WebKitGTK window, not reproducible in headless Chrome). Cells are virtualized (TanStack Virtual, fixed 92 px card slot), so a
column with thousands of cards stays cheap; a cell in a swimlane has its own capped scroll.

**Keyboard.** A focused card moves to the top of the previous or next column of its lane
with `Alt+←/→`. Space picks a card up for dnd-kit's keyboard dragging; Enter opens it.

**Layout per view.** List or board, swimlane and toggles are remembered per view in
`localStorage` (`useViewPrefs`), a per-machine convenience until saved views carry a
layout (M4).

**Rank rebalancing (core).** When a command writes a task rank longer than
`MAX_RANK_LEN` (32), the core rewrites every live rank in that status with short
sequential keys, in the same batch: one undo reverts the drag and the rebalance together,
and `execute` returns every rewritten task so the UI reconciles. Rebalance ops carry only
`rank` (no `updated_at`), which `task_activity` uses to keep them out of the feed.

**Perf tooling.** `crates/core/examples/seed.rs` fills a database through `execute_all`.
Debug builds of the app open `TASK_MASTER_DB` instead of the app data file when it is set.

## Consequences

- WIP limits are displayed but cannot be edited until status commands land (M6).
- The 50-drag check runs twice: against the core (`tests/store.rs`) and against the store
  and board model (`src/store/board.test.ts`).

## Addendum (2026-11-05): collapsible and resizable columns

- A column can be **collapsed** to a 44 px strip (the header's `«` button). Without
  swimlanes the strip shows the name and count and expands on click; with swimlanes the
  header keeps an expand button and each lane's strip shows that cell's count. A strip is
  still a drop target, and a card dropped there (or moved with `Alt+←/→`) goes on top.
- A column is **resized** from the handle on its header's right edge (drag; ←/→ by 16 px,
  Shift by 64, Home/End to the limits; double-click resets). Widths are 224–960 px,
  default 280. From 512 px a column lays its cards out in two lanes, from 768 px in three
  (rank order left to right, then down); rows stay virtualized, with dnd-kit's
  `rectSortingStrategy` instead of the vertical one.
- Both are kept per status in `localStorage` (`task-master.board.columns`,
  `useBoardColumns`) and shared by every board, since statuses are global. Like the other
  layout conveniences they are per machine and not part of saved views.
