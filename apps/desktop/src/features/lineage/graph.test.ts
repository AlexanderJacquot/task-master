import { expect, it } from "vitest";
import { task } from "../../test/fixtures";
import { layoutGraph, wouldCycle } from "./graph";

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
