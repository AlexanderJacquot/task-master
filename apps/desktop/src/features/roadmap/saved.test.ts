// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { FILTER_NONE } from "../../lib/views";
import {
  DEFAULT_FILTER,
  filterOf,
  LAYOUT_KEY,
  layoutOf,
  loadFilter,
  loadLayout,
  type RoadmapFilter,
  roadmapSpec,
  sameFilter,
  saveFilter,
} from "./saved";

afterEach(() => localStorage.clear());

const filter: RoadmapFilter = {
  project: "p1",
  epics: ["e1", FILTER_NONE],
  tags: ["t1"],
  completion: "ready",
  subtasks: false,
  unscheduled: false,
  group: "project",
  zoom: "month",
};

describe("saved roadmaps", () => {
  it("keep the filters, the timescale and the starts of the bars shown", () => {
    const spec = roadmapSpec(
      filter,
      { starts: { a: "2026-12-01", gone: "2026-01-01" }, collapsed: [FILTER_NONE] },
      new Set(["a"]),
    );
    expect(spec.scope).toEqual({ kind: "all" });
    expect(spec.filter.project_ids).toEqual(["p1"]);
    expect(spec.filter.epic_ids).toEqual(["e1", FILTER_NONE]);
    expect(spec.show_subtasks).toBe(false);
    expect(spec.lineage).toBeNull();
    expect(spec.roadmap).toEqual({
      completion: "ready",
      group: "project",
      zoom: "month",
      starts: { a: "2026-12-01" },
      collapsed: [FILTER_NONE],
      hide_unscheduled: true,
    });
    expect(filterOf(spec)).toEqual(filter);
    expect(sameFilter(filterOf(spec), filter)).toBe(true);
    expect(layoutOf(spec)).toEqual({ starts: { a: "2026-12-01" }, collapsed: [FILTER_NONE] });
    expect(sameFilter(filter, { ...filter, epics: [FILTER_NONE, "e1"] })).toBe(true);
    expect(sameFilter(filter, { ...filter, zoom: "week" })).toBe(false);
  });

  it("start from the defaults and ignore what this machine kept that does not parse", () => {
    expect(loadFilter()).toEqual(DEFAULT_FILTER);
    saveFilter(filter);
    expect(loadFilter()).toEqual(filter);
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ starts: { a: "2026-12-01", b: "soon", c: 3 }, collapsed: ["x", 1] }),
    );
    expect(loadLayout()).toEqual({ starts: { a: "2026-12-01" }, collapsed: ["x"] });
    localStorage.setItem(LAYOUT_KEY, "{not json");
    expect(loadLayout()).toEqual({ starts: {}, collapsed: [] });
  });
});
