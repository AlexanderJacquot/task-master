import type { Status, Task } from "../../lib/types";
import { childrenByParent, descendantIds } from "../../lib/views";

/** How many matches a task picker lists at most. */
export const PICK_LIMIT = 30;

/** Ids of a task's ancestors, nearest first. Stops on a cycle or a missing parent. */
export function ancestorIds(taskId: string, tasks: Record<string, Task>): string[] {
  const out: string[] = [];
  const seen = new Set([taskId]);
  let parent = tasks[taskId]?.parent_id ?? null;
  while (parent && !seen.has(parent)) {
    const node = tasks[parent];
    if (!node) break;
    out.push(parent);
    seen.add(parent);
    parent = node.parent_id;
  }
  return out;
}

/**
 * Tasks that `taskId` can be moved under: every user task except itself, its own
 * subtasks at any depth (that would make a cycle) and its current parent.
 */
export function parentCandidates(taskId: string, tasks: Record<string, Task>): Task[] {
  const task = tasks[taskId];
  const excluded = new Set([
    taskId,
    ...descendantIds(taskId, childrenByParent(Object.values(tasks))),
  ]);
  if (task?.parent_id) excluded.add(task.parent_id);
  return Object.values(tasks).filter((t) => !excluded.has(t.id) && t.owner !== "agent");
}

/**
 * Tasks that can become subtasks of `parentId`: every user task except itself, its
 * ancestors (that would make a cycle) and its current direct subtasks.
 */
export function subtaskCandidates(parentId: string, tasks: Record<string, Task>): Task[] {
  const excluded = new Set([parentId, ...ancestorIds(parentId, tasks)]);
  return Object.values(tasks).filter(
    (t) => !excluded.has(t.id) && t.parent_id !== parentId && t.owner !== "agent",
  );
}

/**
 * Candidates whose title contains every word of `query`, open tasks first, then the
 * most recently updated; at most `PICK_LIMIT`.
 */
export function rankCandidates(candidates: Task[], query: string, statuses: Status[]): Task[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const category = new Map(statuses.map((s) => [s.id, s.category]));
  const closed = (t: Task) => {
    const c = category.get(t.status_id);
    return c === "done" || c === "cancelled" ? 1 : 0;
  };
  return candidates
    .filter((t) => {
      const title = t.title.toLowerCase();
      return words.every((w) => title.includes(w));
    })
    .sort((a, b) => closed(a) - closed(b) || b.updated_at - a.updated_at)
    .slice(0, PICK_LIMIT);
}
