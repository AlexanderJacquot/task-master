import type { Status, Task } from "../../lib/types";
import { FILTER_NONE } from "../../lib/views";

export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 100;
export const COLUMN_GAP = 90;
export const ROW_GAP = 32;

export function wouldCycle(tasks: Record<string, Task>, prerequisite: string, dependent: string) {
  const pending = [prerequisite];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop() as string;
    if (id === dependent) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(tasks[id]?.dependency_ids ?? []));
  }
  return false;
}

/** Every task that depends on `id`, directly or through other dependents. */
export function downstream(id: string, tasks: Task[]): string[] {
  const dependents = new Map<string, string[]>();
  for (const task of tasks)
    for (const prerequisite of task.dependency_ids ?? [])
      dependents.set(prerequisite, [...(dependents.get(prerequisite) ?? []), task.id]);
  const seen = new Set<string>();
  const pending = [...(dependents.get(id) ?? [])];
  while (pending.length) {
    const next = pending.pop() as string;
    if (next === id || seen.has(next)) continue;
    seen.add(next);
    pending.push(...(dependents.get(next) ?? []));
  }
  return [...seen];
}

/** Longest-path columns keep chains and joins flowing from left to right. */
export function layoutGraph(tasks: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const levels = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const task of tasks) {
    const dependencies = (task.dependency_ids ?? []).filter((id) => byId.has(id));
    remaining.set(task.id, dependencies.length);
    for (const id of dependencies) {
      outgoing.set(id, [...(outgoing.get(id) ?? []), task.id]);
    }
  }
  const queue = tasks.filter((t) => remaining.get(t.id) === 0).map((t) => t.id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    const level = levels.get(id) ?? 0;
    levels.set(id, level);
    for (const next of outgoing.get(id) ?? []) {
      levels.set(next, Math.max(levels.get(next) ?? 0, level + 1));
      remaining.set(next, (remaining.get(next) ?? 1) - 1);
      if (remaining.get(next) === 0) queue.push(next);
    }
  }
  // Concurrent sync edits can introduce cycles; still show every task so links can be removed.
  const rows = new Map<number, number>();
  const isolated = tasks.filter(
    (task) => !((task.dependency_ids ?? []).some((id) => byId.has(id)) || outgoing.has(task.id)),
  );
  const isolatedIds = new Set(isolated.map((task) => task.id));
  const nodes = tasks
    .filter((task) => !isolatedIds.has(task.id))
    .map((task) => {
      const level = levels.get(task.id) ?? 0;
      const row = rows.get(level) ?? 0;
      rows.set(level, row + 1);
      return {
        task,
        x: 40 + level * (NODE_WIDTH + COLUMN_GAP),
        y: 40 + row * (NODE_HEIGHT + ROW_GAP),
      };
    });
  // Unconnected tasks form a loose grid instead of an increasingly tall single column.
  const startY = nodes.length
    ? Math.max(...nodes.map((node) => node.y)) + NODE_HEIGHT + ROW_GAP * 2
    : 40;
  isolated.forEach((task, index) => {
    nodes.push({
      task,
      x: 40 + (index % 3) * (NODE_WIDTH + COLUMN_GAP),
      y: startY + Math.floor(index / 3) * (NODE_HEIGHT + ROW_GAP),
    });
  });
  const positions = new Map(nodes.map((node) => [node.task.id, node]));
  const edges = tasks.flatMap((task) =>
    (task.dependency_ids ?? []).flatMap((id) => {
      const from = positions.get(id);
      const to = positions.get(task.id);
      return from && to ? [{ from, to }] : [];
    }),
  );
  return {
    nodes,
    edges,
    width: Math.max(700, ...nodes.map((node) => node.x + NODE_WIDTH + 60)),
    height: Math.max(400, ...nodes.map((node) => node.y + NODE_HEIGHT + 60)),
  };
}

/** Done and cancelled tasks no longer block anything. */
export function closedTaskIds(tasks: Iterable<Task>, statuses: Status[]): Set<string> {
  const closed = new Set(
    statuses.filter((s) => s.category === "done" || s.category === "cancelled").map((s) => s.id),
  );
  const ids = new Set<string>();
  for (const task of tasks) if (closed.has(task.status_id)) ids.add(task.id);
  return ids;
}

/** Prerequisites still open: the tasks that block this one. Deleted ones are ignored. */
export function openBlockers(task: Task, tasks: Record<string, Task>, closed: Set<string>) {
  return (task.dependency_ids ?? []).flatMap((id) => {
    const prerequisite = tasks[id];
    return prerequisite && !closed.has(id) ? [prerequisite] : [];
  });
}

/** A task with every ancestor and descendant through dependency links. */
export function lineageOf(tasks: Task[], id: string): Set<string> {
  const dependents = new Map<string, string[]>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks)
    for (const dep of task.dependency_ids ?? [])
      dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
  const seen = new Set<string>([id]);
  const walk = (next: (id: string) => string[]) => {
    const pending = [id];
    while (pending.length) {
      for (const other of next(pending.pop() as string))
        if (!seen.has(other)) {
          seen.add(other);
          pending.push(other);
        }
    }
  };
  walk((current) => byId.get(current)?.dependency_ids ?? []);
  walk((current) => dependents.get(current) ?? []);
  return seen;
}

export type Completion = "all" | "open" | "ready";

export interface LineageFilter {
  project: string;
  /** Any of these epics; `FILTER_NONE` matches tasks without an epic. Empty: all. */
  epics: string[];
  /** Any of these tags; `FILTER_NONE` matches tasks without tags. Empty: all. */
  tags: string[];
  completion: Completion;
  linkedOnly: boolean;
  /** Show subtasks (tasks with a parent). Missing: shown. */
  subtasks?: boolean;
  /** Only this task's lineage (ancestors and descendants). */
  around?: string | undefined;
}

/**
 * The tasks the canvas shows. `open` hides done and cancelled tasks; `ready` also hides
 * tasks still waiting on an open prerequisite. `subtasks: false` hides tasks with a parent.
 */
export function filterLineage(
  all: Task[],
  tasks: Record<string, Task>,
  closed: Set<string>,
  filter: LineageFilter,
): Task[] {
  const linked = new Set(
    all.flatMap((task) =>
      (task.dependency_ids ?? []).length ? [task.id, ...(task.dependency_ids ?? [])] : [],
    ),
  );
  const around = filter.around && tasks[filter.around] ? lineageOf(all, filter.around) : null;
  const matches = (task: Task) =>
    (!around || around.has(task.id)) &&
    (!filter.project || task.project_id === filter.project) &&
    (!filter.epics.length || filter.epics.includes(task.epic_id ?? FILTER_NONE)) &&
    (!filter.tags.length ||
      (task.tag_ids.length
        ? task.tag_ids.some((id) => filter.tags.includes(id))
        : filter.tags.includes(FILTER_NONE))) &&
    (!filter.linkedOnly || linked.has(task.id)) &&
    (filter.subtasks !== false || !task.parent_id) &&
    (filter.completion === "all" || !closed.has(task.id)) &&
    (filter.completion !== "ready" || !openBlockers(task, tasks, closed).length);
  // The task whose lineage is open stays, whatever the saved filters say.
  return all.filter((task) => (around !== null && task.id === filter.around) || matches(task));
}
