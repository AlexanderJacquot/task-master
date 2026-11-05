import type { Task } from "../../lib/types";

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
  const nodes = tasks.map((task) => {
    const level = levels.get(task.id) ?? 0;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    return {
      task,
      x: 40 + level * (NODE_WIDTH + COLUMN_GAP),
      y: 40 + row * (NODE_HEIGHT + ROW_GAP),
    };
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
