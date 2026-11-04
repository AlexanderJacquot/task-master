// The board (plan section 6): a pure function of the store's entities + a view spec, like the
// list rows. Columns are statuses in workflow order, cards keep their manual rank order, and
// optional swimlanes split every column by project, epic or priority.

import { rankBetween } from "./rank";
import type {
  Epic,
  Priority,
  Project,
  Status,
  Swimlane,
  Task,
  TaskChange,
  ViewSpec,
} from "./types";
import { childrenByParent, compareRank, isOpen, matchesQuery, type ViewContext } from "./views";

export type { Swimlane };

/**
 * The spec fields a board uses. `show_subtasks` shows subtasks as their own cards (hidden
 * by default when their parent is on the board). A status filter limits the columns.
 */
export type BoardQuery = Pick<
  ViewSpec,
  "scope" | "filter" | "swimlane" | "show_subtasks" | "show_cancelled"
>;

export interface Card {
  task: Task;
  /** Subtask progress over all live children. */
  childCount: number;
  childDone: number;
}

export interface Column {
  status: Status;
  /** Cards in the column over every lane. */
  count: number;
  overLimit: boolean;
}

export interface Lane {
  /** Stable id: `all`, or `project:<id|none>`, `epic:<id|none>`, `priority:<value>`. */
  key: string;
  label: string;
  color: string | null;
  /** What a card dropped into this lane takes (none for the single `all` lane). */
  changes: TaskChange[];
  /** Cards per status id, in rank order. */
  cells: Record<string, Card[]>;
}

export interface Board {
  columns: Column[];
  lanes: Lane[];
}

export interface BoardLookups {
  projects: Record<string, Project>;
  epics: Record<string, Epic>;
}

const PRIORITY_LANES: Array<{ value: Priority; label: string }> = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
];

interface LaneSpec {
  key: string;
  label: string;
  color: string | null;
  changes: TaskChange[];
  order: string;
}

function laneOf(task: Task, swimlane: Swimlane, lookups: BoardLookups): LaneSpec {
  switch (swimlane) {
    case "none":
      return { key: "all", label: "", color: null, changes: [], order: "" };
    case "project": {
      const project = task.project_id ? lookups.projects[task.project_id] : undefined;
      if (!project) {
        return {
          key: "project:none",
          label: "No project",
          color: null,
          changes: [{ project_id: null }],
          order: "￿",
        };
      }
      return {
        key: `project:${project.id}`,
        label: project.name,
        color: project.color,
        changes: [{ project_id: project.id }],
        order: project.rank,
      };
    }
    case "epic": {
      const epic = task.epic_id ? lookups.epics[task.epic_id] : undefined;
      if (!epic) {
        return {
          key: "epic:none",
          label: "No epic",
          color: null,
          changes: [{ epic_id: null }],
          order: "￿",
        };
      }
      return {
        key: `epic:${epic.id}`,
        label: epic.name,
        color: null,
        changes: [{ epic_id: epic.id }],
        order: epic.rank,
      };
    }
    case "priority": {
      const index = PRIORITY_LANES.findIndex((p) => p.value === task.priority);
      const lane = PRIORITY_LANES[index] ?? { value: task.priority, label: task.priority };
      return {
        key: `priority:${lane.value}`,
        label: lane.label,
        color: null,
        changes: [{ priority: lane.value }],
        order: String(index),
      };
    }
  }
}

export function buildBoard(
  tasks: Iterable<Task>,
  query: BoardQuery,
  ctx: ViewContext,
  statuses: Status[],
  lookups: BoardLookups,
): Board {
  const all = Array.from(tasks);
  const children = childrenByParent(all);
  // Unlike the list, a card dropped on Done in the Inbox or Today stays for the day.
  const visible = new Set(
    all.filter((t) => matchesQuery(query, t, ctx, { keepClosedToday: true })).map((t) => t.id),
  );
  const { status_ids } = query.filter;
  const shownStatuses = statuses.filter(
    (s) =>
      (s.category !== "cancelled" || query.show_cancelled || status_ids.includes(s.id)) &&
      (!status_ids.length || status_ids.includes(s.id)),
  );
  const shownStatusIds = new Set(shownStatuses.map((s) => s.id));

  const lanes = new Map<string, LaneSpec & { cells: Record<string, Card[]> }>();
  const counts = new Map<string, number>();
  for (const task of all) {
    if (!visible.has(task.id) || !shownStatusIds.has(task.status_id)) continue;
    const parentShown = task.parent_id !== null && visible.has(task.parent_id);
    if (parentShown && !query.show_subtasks) continue;
    const spec = laneOf(task, query.swimlane, lookups);
    let lane = lanes.get(spec.key);
    if (!lane) {
      lane = { ...spec, cells: {} };
      lanes.set(spec.key, lane);
    }
    const kids = children.get(task.id) ?? [];
    const card: Card = {
      task,
      childCount: kids.length,
      childDone: kids.filter((k) => !isOpen(k, ctx)).length,
    };
    const cell = lane.cells[task.status_id];
    if (cell) cell.push(card);
    else lane.cells[task.status_id] = [card];
    counts.set(task.status_id, (counts.get(task.status_id) ?? 0) + 1);
  }

  for (const lane of lanes.values()) {
    for (const cell of Object.values(lane.cells)) cell.sort((a, b) => compareRank(a.task, b.task));
  }
  const ordered = Array.from(lanes.values()).sort((a, b) =>
    a.order < b.order ? -1 : a.order > b.order ? 1 : a.label.localeCompare(b.label),
  );
  if (ordered.length === 0) {
    ordered.push({ key: "all", label: "", color: null, changes: [], order: "", cells: {} });
  }

  return {
    columns: shownStatuses.map((status) => {
      const count = counts.get(status.id) ?? 0;
      return {
        status,
        count,
        overLimit: status.wip_limit !== null && count > status.wip_limit,
      };
    }),
    lanes: ordered.map(({ order: _order, ...lane }) => lane),
  };
}

/**
 * New ranks after dropping `movedId` so that a cell reads `order` (ids, top to bottom,
 * the moved card included). Usually one key between the new neighbours. When those
 * neighbours share a rank (or are out of order), the whole cell is renumbered so the drop
 * still lands where it was shown. Returns only the ranks that change.
 */
export function ranksForDrop(
  order: string[],
  movedId: string,
  ranks: Record<string, string>,
): Record<string, string> {
  const at = order.indexOf(movedId);
  if (at < 0) throw new Error(`card ${movedId} is not in the drop order`);
  const before = at > 0 ? ranks[order[at - 1] as string] : undefined;
  const after = at < order.length - 1 ? ranks[order[at + 1] as string] : undefined;
  if (before === undefined || after === undefined || before < after) {
    return { [movedId]: rankBetween(before ?? null, after ?? null) };
  }
  const out: Record<string, string> = {};
  let prev: string | null = null;
  for (const id of order) {
    const key = rankBetween(prev, null);
    if (ranks[id] !== key || id === movedId) out[id] = key;
    prev = key;
  }
  return out;
}

/** The status a keyboard move (`Alt+←/→`) lands in, or null at the board's edge. */
export function adjacentStatus(columns: Column[], statusId: string, step: -1 | 1): string | null {
  const index = columns.findIndex((c) => c.status.id === statusId);
  if (index < 0) return null;
  return columns[index + step]?.status.id ?? null;
}
