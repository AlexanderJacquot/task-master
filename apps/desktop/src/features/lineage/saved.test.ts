import { describe, expect, it } from "vitest";
import { FILTER_NONE } from "../../lib/views";
import type { SavedCanvas } from "./canvas";
import { canvasOf, filterOf, type LineageFilter, lineageSpec, sameFilter } from "./saved";

const filter: LineageFilter = {
  project: "p1",
  epics: ["e1", FILTER_NONE],
  tags: ["t1"],
  completion: "ready",
  linkedOnly: true,
  subtasks: false,
  arrange: "epic",
};

const canvas: SavedCanvas = {
  positions: { a: { x: 10.4, y: 19.6 }, b: { x: 300, y: 40 }, gone: { x: 1, y: 1 } },
  camera: { x: 5, y: 5, zoom: 1.5 },
  pinned: ["a", "gone"],
  lanes: { epic: { b: { x: 12, y: 50.5 }, gone: { x: 0, y: 0 } }, project: {} },
  collapsed: { epic: [FILTER_NONE], project: ["p2"] },
};

describe("saved lineage views", () => {
  it("keeps the filters and the places of the cards on the canvas, in whole pixels", () => {
    const spec = lineageSpec(filter, "a", canvas, new Set(["a", "b"]));
    expect(spec.scope).toEqual({ kind: "all" });
    expect(spec.filter.project_ids).toEqual(["p1"]);
    expect(spec.filter.epic_ids).toEqual(["e1", FILTER_NONE]);
    expect(spec.filter.tag_ids).toEqual(["t1"]);
    expect(spec.show_subtasks).toBe(false);
    expect(spec.lineage).toEqual({
      around: "a",
      completion: "ready",
      linked_only: true,
      arrange: "epic",
      positions: { a: { x: 10, y: 20 }, b: { x: 300, y: 40 } },
      lanes: { epic: { b: { x: 12, y: 51 } }, project: {} },
      pinned: ["a"],
      collapsed: { epic: [FILTER_NONE], project: ["p2"] },
    });
    // No camera: a saved view opens framed on its cards.
    expect(JSON.stringify(spec)).not.toContain("zoom");
  });

  it("reads back what it saved", () => {
    const spec = lineageSpec(filter, null, canvas, new Set(["a", "b"]));
    expect(filterOf(spec)).toEqual(filter);
    expect(canvasOf(spec)).toEqual({
      positions: { a: { x: 10, y: 20 }, b: { x: 300, y: 40 } },
      pinned: ["a"],
      lanes: { epic: { b: { x: 12, y: 51 } }, project: {} },
      collapsed: { epic: [FILTER_NONE], project: ["p2"] },
    });
  });

  it("an empty project filter saves no project", () => {
    const spec = lineageSpec({ ...filter, project: "" }, null, canvas, new Set());
    expect(spec.filter.project_ids).toEqual([]);
    expect(filterOf(spec).project).toBe("");
  });

  it("compares filters regardless of the order ids were picked in", () => {
    expect(sameFilter(filter, { ...filter, epics: [FILTER_NONE, "e1"] })).toBe(true);
    expect(sameFilter(filter, { ...filter, epics: ["e1"] })).toBe(false);
    expect(sameFilter(filter, { ...filter, arrange: "free" })).toBe(false);
    expect(sameFilter(filter, { ...filter, linkedOnly: false })).toBe(false);
  });
});
