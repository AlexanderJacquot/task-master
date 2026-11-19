// Views are pure functions of the store's entities + a view spec (plan, section 5), so the
// list, the board and later the calendar share filtering, grouping and sorting. Built-in
// routes and saved views use the same `ViewSpec` (generated from the Rust core).

import { daysFrom, isoDate } from "./dates";
import type {
  DueFilter,
  Epic,
  GroupBy,
  Priority,
  Project,
  SortBy,
  Status,
  StatusCategory,
  Task,
  ViewFilter,
  ViewScope,
  ViewSpec,
} from "./types";

/** The task set a view starts from; same shape as `ViewScope` in the core. */
export type ViewKey = ViewScope;

/** The parts of a spec that decide which tasks show and in what order. */
export type ViewQuery = Pick<
  ViewSpec,
  "scope" | "filter" | "group_by" | "sort" | "show_cancelled" | "show_agent_tasks"
> &
  Partial<Pick<ViewSpec, "show_subtasks">>;

export interface ViewContext {
  today: string;
  statuses: Record<string, Status>;
  projects: Record<string, Project>;
  /** Needed only to group by epic. */
  epics?: Record<string, Epic>;
}

export const EMPTY_FILTER: ViewFilter = {
  status_ids: [],
  priorities: [],
  project_ids: [],
  epic_ids: [],
  tag_ids: [],
  due: null,
};

/** In `epic_ids` / `tag_ids` of a filter: tasks without an epic / without tags (core's `FILTER_NONE`). */
export const FILTER_NONE = "none";

const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

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
  /** Agents' own tasks (ADR 017) are left out of the user's views unless asked for. */
  showAgentTasks?: boolean;
}

/** An agent's own task, kept apart from the user's (ADR 017). */
export function isAgentTask(task: Task): boolean {
  return task.owner === "agent";
}

/** Whether `task` belongs in a view's scope, ignoring filters and the tree. */
export function inView(
  view: ViewKey,
  task: Task,
  ctx: ViewContext,
  options: InViewOptions = {},
): boolean {
  if (isAgentTask(task) && !options.showAgentTasks) return false;
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
    case "tag":
      return task.tag_ids.includes(view.id);
  }
}

function matchesDue(due: DueFilter, task: Task, ctx: ViewContext): boolean {
  switch (due) {
    case "overdue":
      return isOverdue(task, ctx);
    case "today":
      return task.due_date !== null && task.due_date <= ctx.today;
    case "week":
      return task.due_date !== null && daysFrom(ctx.today, task.due_date) <= 7;
    case "none":
      return task.due_date === null;
  }
}

/** A task matches every non-empty list of the filter (any value within a list). */
export function matchesFilter(filter: ViewFilter, task: Task, ctx: ViewContext): boolean {
  if (filter.status_ids.length && !filter.status_ids.includes(task.status_id)) return false;
  if (filter.priorities.length && !filter.priorities.includes(task.priority)) return false;
  if (
    filter.project_ids.length &&
    !(task.project_id !== null && filter.project_ids.includes(task.project_id))
  )
    return false;
  if (filter.epic_ids.length && !filter.epic_ids.includes(task.epic_id ?? FILTER_NONE))
    return false;
  if (
    filter.tag_ids.length &&
    !(task.tag_ids.length === 0
      ? filter.tag_ids.includes(FILTER_NONE)
      : task.tag_ids.some((t) => filter.tag_ids.includes(t)))
  )
    return false;
  if (filter.due && !matchesDue(filter.due, task, ctx)) return false;
  return true;
}

export function filterIsEmpty(filter: ViewFilter): boolean {
  return (
    !filter.status_ids.length &&
    !filter.priorities.length &&
    !filter.project_ids.length &&
    !filter.epic_ids.length &&
    !filter.tag_ids.length &&
    !filter.due
  );
}

/** Scope and filter together. */
export function matchesQuery(
  query: Pick<ViewQuery, "scope" | "filter">,
  task: Task,
  ctx: ViewContext,
  options: InViewOptions = {},
): boolean {
  return inView(query.scope, task, ctx, options) && matchesFilter(query.filter, task, ctx);
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

/** Manual order only, for subtask checklists and board columns. */
export function compareRank(a: Task, b: Task): number {
  return compareStrings(a.rank, b.rank) || compareStrings(a.id, b.id);
}

export function comparator(sort: SortBy, ctx: ViewContext): (a: Task, b: Task) => number {
  switch (sort) {
    case "default":
      return (a, b) => compareTasks(a, b, ctx);
    case "manual":
      return compareRank;
    case "due":
      return (a, b) => compareNullable(a.due_date, b.due_date) || compareRank(a, b);
    case "priority":
      return (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || compareTasks(a, b, ctx);
    case "created":
      return (a, b) => b.created_at - a.created_at || compareStrings(a.id, b.id);
    case "updated":
      return (a, b) => b.updated_at - a.updated_at || compareStrings(a.id, b.id);
  }
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

export interface Group {
  /** Stable within a grouping: a status/project/epic id, a priority, a due bucket, `none`. */
  key: string;
  label: string;
  color: string | null;
}

export type Row =
  | { type: "group"; group: Group; count: number; collapsed: boolean }
  | {
      type: "task";
      task: Task;
      /** 0 for a top-level row, 1 for its subtasks, and so on. */
      depth: number;
      /** Subtask progress over all live children. */
      childCount: number;
      childDone: number;
      /** Children in the view under this row (shown or folded). */
      visibleChildren: number;
      /** Its subtasks are unrolled under it. */
      expanded: boolean;
    };

export interface RowOptions {
  collapsedGroups: ReadonlySet<string>;
  /** Tasks folded by hand (overrides the default). */
  collapsedTasks: ReadonlySet<string>;
  /** Tasks unrolled by hand (overrides the default). */
  expandedTasks?: ReadonlySet<string>;
}

/**
 * Whether a row's subtasks are unrolled: a hand choice wins; otherwise top-level rows
 * are, and deeper ones only with "Show subtasks".
 */
export function isRowExpanded(
  id: string,
  depth: number,
  showSubtasks: boolean,
  options: Pick<RowOptions, "collapsedTasks" | "expandedTasks">,
): boolean {
  if (options.collapsedTasks.has(id)) return false;
  if (options.expandedTasks?.has(id)) return true;
  return showSubtasks || depth === 0;
}

const DUE_BUCKETS: Group[] = [
  { key: "overdue", label: "Overdue", color: "#ef4444" },
  { key: "today", label: "Today", color: "#f59e0b" },
  { key: "week", label: "Next 7 days", color: "#3b82f6" },
  { key: "later", label: "Later", color: null },
  { key: "none", label: "No due date", color: null },
];

function dueBucket(task: Task, ctx: ViewContext): string {
  if (task.due_date === null) return "none";
  const days = daysFrom(ctx.today, task.due_date);
  if (days < 0) return isOpen(task, ctx) ? "overdue" : "today";
  if (days === 0) return "today";
  return days <= 7 ? "week" : "later";
}

/** Group key of a task and the groups in display order, for a grouping. */
function grouping(
  by: GroupBy,
  ctx: ViewContext,
  statuses: Status[],
): { keyOf: (t: Task) => string; groups: (keys: Set<string>) => Group[] } {
  const byRank = <T extends { rank: string; id: string }>(a: T, b: T) =>
    compareStrings(a.rank, b.rank) || compareStrings(a.id, b.id);
  switch (by) {
    case "status":
      return {
        keyOf: (t) => t.status_id,
        groups: () => statuses.map((s) => ({ key: s.id, label: s.name, color: s.color })),
      };
    case "project":
      return {
        keyOf: (t) => (t.project_id && ctx.projects[t.project_id] ? t.project_id : "none"),
        groups: (keys) => [
          ...Object.values(ctx.projects)
            .filter((p) => keys.has(p.id))
            .sort(byRank)
            .map((p) => ({ key: p.id, label: p.name, color: p.color })),
          { key: "none", label: "No project", color: null },
        ],
      };
    case "epic":
      return {
        keyOf: (t) => (t.epic_id && ctx.epics?.[t.epic_id] ? t.epic_id : "none"),
        groups: (keys) => [
          ...Object.values(ctx.epics ?? {})
            .filter((e) => keys.has(e.id))
            .sort(byRank)
            .map((e) => ({ key: e.id, label: e.name, color: null })),
          { key: "none", label: "No epic", color: null },
        ],
      };
    case "priority":
      return {
        keyOf: (t) => t.priority,
        groups: () =>
          (Object.keys(PRIORITY_ORDER) as Priority[]).map((p) => ({
            key: p,
            label: PRIORITY_LABELS[p],
            color: null,
          })),
      };
    case "due":
      return { keyOf: (t) => dueBucket(t, ctx), groups: () => DUE_BUCKETS };
  }
}

/** Ids of the tasks a list view shows, folded groups and subtasks included. */
export function listedIds(tasks: Iterable<Task>, query: ViewQuery, ctx: ViewContext): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (
      matchesQuery(query, t, ctx, { showAgentTasks: query.show_agent_tasks }) &&
      (query.show_cancelled || categoryOf(t, ctx) !== "cancelled")
    )
      ids.add(t.id);
  }
  return ids;
}

/**
 * Rows for the list view: grouped (status in workflow order by default), top-level tasks
 * sorted by the spec, each followed by its visible subtasks in manual order. A task whose
 * parent is not in the view is shown at the top level. Subtasks nest at any depth: a
 * top-level row is unrolled by default, deeper ones when `show_subtasks` is on, and any
 * row can be folded or unrolled by hand. Cancelled tasks only show when asked for.
 */
export function buildRows(
  tasks: Iterable<Task>,
  query: ViewQuery,
  ctx: ViewContext,
  statuses: Status[],
  options: RowOptions,
): Row[] {
  const all = Array.from(tasks);
  const children = childrenByParent(all);
  const visible = listedIds(all, query, ctx);
  const { keyOf, groups } = grouping(query.group_by, ctx, statuses);

  const roots = new Map<string, Task[]>();
  for (const task of all) {
    if (!visible.has(task.id)) continue;
    if (task.parent_id !== null && visible.has(task.parent_id)) continue;
    const key = keyOf(task);
    const list = roots.get(key);
    if (list) list.push(task);
    else roots.set(key, [task]);
  }

  const showSubtasks = query.show_subtasks ?? false;
  const compare = comparator(query.sort, ctx);
  const rows: Row[] = [];
  // Depth first; `path` guards against a parent cycle in corrupt data.
  const pushTree = (task: Task, depth: number, path: Set<string>) => {
    const kids = children.get(task.id) ?? [];
    const shownKids = kids.filter((c) => visible.has(c.id) && !path.has(c.id));
    const expanded = isRowExpanded(task.id, depth, showSubtasks, options);
    rows.push({
      type: "task",
      task,
      depth,
      childCount: kids.length,
      childDone: kids.filter((k) => !isOpen(k, ctx)).length,
      visibleChildren: shownKids.length,
      expanded,
    });
    if (!expanded) return;
    path.add(task.id);
    for (const child of shownKids) pushTree(child, depth + 1, path);
    path.delete(task.id);
  };

  for (const group of groups(new Set(roots.keys()))) {
    const list = roots.get(group.key);
    if (!list?.length) continue;
    list.sort(compare);
    const collapsed = options.collapsedGroups.has(group.key);
    rows.push({ type: "group", group, count: list.length, collapsed });
    if (collapsed) continue;
    for (const task of list) pushTree(task, 0, new Set());
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
