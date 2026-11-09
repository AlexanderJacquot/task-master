import { expect, it } from "vitest";
import { FILTER_NONE } from "../../lib/views";
import { STATUS, statuses, task } from "../../test/fixtures";
import {
  closedTaskIds,
  downstream,
  filterLineage,
  type LineageFilter,
  layoutGraph,
  lineageOf,
  openBlockers,
  wouldCycle,
} from "./graph";

it("lists every task downstream of one, once, ignoring unrelated tasks", () => {
  const a = task();
  const b = task({ dependency_ids: [a.id] });
  const c = task({ dependency_ids: [a.id, b.id] });
  const d = task({ dependency_ids: [c.id] });
  const other = task();
  expect(downstream(a.id, [a, b, c, d, other]).sort()).toEqual([b.id, c.id, d.id].sort());
  expect(downstream(d.id, [a, b, c, d, other])).toEqual([]);
});

it("lays out branching and joining chains in dependency order", () => {
  const a = task();
  const b = task({ dependency_ids: [a.id] });
  const c = task({ dependency_ids: [a.id] });
  const d = task({ dependency_ids: [b.id, c.id] });
  const graph = layoutGraph([d, c, b, a]);
  const positions = new Map(graph.nodes.map((n) => [n.task.id, n]));
  for (const edge of graph.edges) expect(edge.from.x).toBeLessThan(edge.to.x);
  expect(graph.edges).toHaveLength(4);
  expect(positions.get(b.id)?.x).toBe(positions.get(c.id)?.x);
  expect(positions.get(b.id)?.y).not.toBe(positions.get(c.id)?.y);
  const tasks = Object.fromEntries([a, b, c, d].map((t) => [t.id, t]));
  expect(wouldCycle(tasks, d.id, a.id)).toBe(true);
  expect(wouldCycle(tasks, a.id, a.id)).toBe(true);
  expect(wouldCycle(tasks, b.id, c.id)).toBe(false);
});

it("keeps disconnected tasks, ignores missing endpoints and tolerates synced cycles", () => {
  const a = task({ id: "a", dependency_ids: ["b", "deleted"] });
  const b = task({ id: "b", dependency_ids: ["a"] });
  const c = task();
  const graph = layoutGraph([a, b, c]);
  expect(graph.nodes).toHaveLength(3);
  expect(graph.edges).toHaveLength(2);
  expect(graph.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
});

it("spreads unconnected tasks across a grid without overlapping the dependency chains", () => {
  const a = task();
  const b = task({ dependency_ids: [a.id] });
  const unconnected = Array.from({ length: 7 }, () => task());
  const graph = layoutGraph([a, b, ...unconnected]);
  const nodes = graph.nodes.filter((node) => unconnected.some((task) => task.id === node.task.id));
  expect(new Set(nodes.map((node) => node.x)).size).toBe(3);
  expect(new Set(nodes.map((node) => node.y)).size).toBe(3);
  expect(Math.min(...nodes.map((node) => node.y))).toBeGreaterThan(
    Math.max(
      ...graph.nodes.filter((node) => [a.id, b.id].includes(node.task.id)).map((node) => node.y),
    ) + 100,
  );
});

it("filters by completion, epic, tag, project and a task's lineage", () => {
  const done = task({ title: "Done", status_id: STATUS.done });
  const open = task({ title: "Open", epic_id: "e" });
  const waiting = task({ title: "Waiting", dependency_ids: [open.id], tag_ids: ["tag"] });
  const free = task({ title: "Free", dependency_ids: [done.id], project_id: "p" });
  const loner = task({ title: "Loner" });
  const all = [done, open, waiting, free, loner];
  const tasks = Object.fromEntries(all.map((t) => [t.id, t]));
  const closed = closedTaskIds(all, statuses);
  expect([...closed]).toEqual([done.id]);
  expect(openBlockers(waiting, tasks, closed)).toEqual([open]);
  expect(openBlockers(free, tasks, closed)).toEqual([]);
  const titles = (filter: Partial<LineageFilter>) =>
    filterLineage(all, tasks, closed, {
      project: "",
      epics: [],
      tags: [],
      completion: "all",
      linkedOnly: false,
      ...filter,
    }).map((t) => t.title);
  expect(titles({})).toHaveLength(5);
  expect(titles({ completion: "open" })).toEqual(["Open", "Waiting", "Free", "Loner"]);
  expect(titles({ completion: "ready" })).toEqual(["Open", "Free", "Loner"]);
  expect(titles({ tags: ["tag"] })).toEqual(["Waiting"]);
  expect(titles({ tags: [FILTER_NONE] })).toEqual(["Done", "Open", "Free", "Loner"]);
  expect(titles({ tags: [FILTER_NONE, "tag"] })).toHaveLength(5);
  expect(titles({ epics: ["e"] })).toEqual(["Open"]);
  expect(titles({ epics: [FILTER_NONE] })).toEqual(["Done", "Waiting", "Free", "Loner"]);
  expect(titles({ epics: ["e"], tags: ["tag"] })).toEqual([]);
  expect(titles({ project: "p" })).toEqual(["Free"]);
  expect(titles({ linkedOnly: true })).toEqual(["Done", "Open", "Waiting", "Free"]);
  expect(titles({ around: waiting.id })).toEqual(["Open", "Waiting"]);
  expect(titles({ around: done.id })).toEqual(["Done", "Free"]);
  expect([...lineageOf(all, loner.id)]).toEqual([loner.id]);
  // The focused task survives filters that would hide it; its lineage still filters.
  expect(titles({ around: loner.id, linkedOnly: true, project: "p" })).toEqual(["Loner"]);
  expect(titles({ around: done.id, completion: "open" })).toEqual(["Done", "Free"]);
  expect(titles({ around: waiting.id, tags: ["tag"] })).toEqual(["Waiting"]);
});

it("hides subtasks on request, but keeps a focused subtask", () => {
  const parent = task({ title: "Parent" });
  const child = task({ title: "Child", parent_id: parent.id, dependency_ids: [parent.id] });
  const all = [parent, child];
  const tasks = Object.fromEntries(all.map((t) => [t.id, t]));
  const titles = (filter: Partial<LineageFilter>) =>
    filterLineage(all, tasks, new Set(), {
      project: "",
      epics: [],
      tags: [],
      completion: "all",
      linkedOnly: false,
      ...filter,
    }).map((t) => t.title);
  expect(titles({})).toEqual(["Parent", "Child"]);
  expect(titles({ subtasks: true })).toEqual(["Parent", "Child"]);
  expect(titles({ subtasks: false })).toEqual(["Parent"]);
  expect(titles({ subtasks: false, around: child.id })).toEqual(["Parent", "Child"]);
});
