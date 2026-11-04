// Views are pure functions of the store's entities + a view key (plan, section 5), so the
// list, the board (M3) and the calendar (later) share filtering and sorting.

import { isoDate } from "./dates";
import type { Priority, Project, Status, StatusCategory, Task } from "./types";

export type ViewKey =
  | { kind: "inbox" }
  | { kind: "today" }
  | { kind: "all" }
  | { kind: "project"; id: string }
  | { kind: "epic"; id: string };

export interface ViewContext {
  today: string;
  statuses: Record<string, Status>;
  projects: Record<string, Project>;
}

const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function categoryOf(task: Task, ctx: Pick<ViewContext, "statuses">): StatusCategory {
  return ctx.statuses[task.status_id]?.category ?? "todo";
}

export function isOpen(task: Task, ctx: Pick<ViewContext, "statuses">): boolean {
  const category = categoryOf(task, ctx);
  return category !== "done" && category !== "cancelled";
}

export function isOverdue(task: Task, ctx: ViewContext): boolean {
  return task.due_date !== null && task.due_date < ctx.today && isOpen(task, ctx);
}

/** Done or cancelled on `ctx.today` (cancelled tasks have no `completed_at`). */
export function closedToday(task: Task, ctx: ViewContext): boolean {
  if (isOpen(task, ctx)) return false;
  return isoDate(new Date(task.completed_at ?? task.updated_at)) === ctx.today;
}

export interface InViewOptions {
  /**
   * Keep tasks closed today in views that otherwise show open tasks only (Inbox, Today),
   * so a card dropped on the board's Done column stays there until tomorrow.
   */
  keepClosedToday?: boolean;
}

/** Whether `task` belongs in a view, ignoring the tree. */
export function inView(
  view: ViewKey,
  task: Task,
  ctx: ViewContext,
  options: InViewOptions = {},
): boolean {
  const open = () => isOpen(task, ctx) || (!!options.keepClosedToday && closedToday(task, ctx));
  switch (view.kind) {
    case "inbox":
      return task.project_id === null && open();
    case "today":
      // Picked for today (even once done), or due today or earlier and still open.
      return (
        task.today_on === ctx.today ||
        (task.due_date !== null && task.due_date <= ctx.today && open())
      );
    case "all":
      return true;
    case "project": {
      if (task.project_id === null) return false;
      if (task.project_id === view.id) return true;
      // An area shows the tasks of the projects inside it.
      return ctx.projects[task.project_id]?.parent_id === view.id;
    }
    case "epic":
      return task.epic_id === view.id;
  }
}

/** Default order: picked for today, overdue, priority, due date, then manual rank. */
export function compareTasks(a: Task, b: Task, ctx: ViewContext): number {
  const today = (t: Task) => (t.today_on === ctx.today ? 0 : 1);
  const overdue = (t: Task) => (isOverdue(t, ctx) ? 0 : 1);
  return (
    today(a) - today(b) ||
    overdue(a) - overdue(b) ||
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
    compareNullable(a.due_date, b.due_date) ||
    compareStrings(a.rank, b.rank) ||
    compareStrings(a.id, b.id)
  );
}

/** Manual order only, for subtask checklists. */
export function compareRank(a: Task, b: Task): number {
  return compareStrings(a.rank, b.rank) || compareStrings(a.id, b.id);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareStrings(a, b);
}

/** Live children of every task, in manual order. */
export function childrenByParent(tasks: Iterable<Task>): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parent_id === null) continue;
    const list = map.get(task.parent_id);
    if (list) list.push(task);
    else map.set(task.parent_id, [task]);
  }
  for (const list of map.values()) list.sort(compareRank);
  return map;
}

export type Row =
  | { type: "group"; status: Status; count: number; collapsed: boolean }
  | {
      type: "task";
      task: Task;
      depth: 0 | 1;
      /** Subtask progress over all live children. */
      childCount: number;
      childDone: number;
      /** Children shown under this row in the view. */
      visibleChildren: number;
    };

export interface RowOptions {
  showCancelled: boolean;
  collapsedGroups: ReadonlySet<string>;
  collapsedTasks: ReadonlySet<string>;
}

/**
 * Rows for the list view: grouped by status (in workflow order), top-level tasks in default
 * order, each followed by its visible subtasks. A task whose parent is not in the view is
 * shown at the top level. Two levels are shown; deeper subtasks live in the detail panel.
 */
export function buildRows(
  tasks: Iterable<Task>,
  view: ViewKey,
  ctx: ViewContext,
  statuses: Status[],
  options: RowOptions,
): Row[] {
  const all = Array.from(tasks);
  const children = childrenByParent(all);
  const visible = new Set(all.filter((t) => inView(view, t, ctx)).map((t) => t.id));

  const roots = new Map<string, Task[]>();
  for (const task of all) {
    if (!visible.has(task.id)) continue;
    if (task.parent_id !== null && visible.has(task.parent_id)) continue;
    const list = roots.get(task.status_id);
    if (list) list.push(task);
    else roots.set(task.status_id, [task]);
  }

  const taskRow = (task: Task, depth: 0 | 1, shownChildren: Task[]): Row => {
    const kids = children.get(task.id) ?? [];
    return {
      type: "task",
      task,
      depth,
      childCount: kids.length,
      childDone: kids.filter((k) => !isOpen(k, ctx)).length,
      visibleChildren: shownChildren.length,
    };
  };

  const rows: Row[] = [];
  for (const status of statuses) {
    if (status.category === "cancelled" && !options.showCancelled) continue;
    const list = roots.get(status.id);
    if (!list?.length) continue;
    list.sort((a, b) => compareTasks(a, b, ctx));
    const collapsed = options.collapsedGroups.has(status.id);
    rows.push({ type: "group", status, count: list.length, collapsed });
    if (collapsed) continue;
    for (const task of list) {
      const shown = (children.get(task.id) ?? []).filter((c) => visible.has(c.id));
      rows.push(taskRow(task, 0, shown));
      if (options.collapsedTasks.has(task.id)) continue;
      for (const child of shown) {
        rows.push(taskRow(child, 1, []));
      }
    }
  }
  return rows;
}

/** Live descendants of a task, at any depth. */
export function descendantIds(taskId: string, children: Map<string, Task[]>): string[] {
  const out: string[] = [];
  const stack = [taskId];
  while (stack.length) {
    const id = stack.pop() as string;
    for (const child of children.get(id) ?? []) {
      out.push(child.id);
      stack.push(child.id);
    }
  }
  return out;
}
