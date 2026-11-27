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
  projects: ["p1", FILTER_NONE],
  tags: [],
  completion: "all",
  subtasks: true,
  unscheduled: false,
  group: "none",
  zoom: "quarter",
};

describe("saved roadmaps", () => {
  it("keep the projects, the timescale and the starts of the bars shown", () => {
    const spec = roadmapSpec(
      filter,
      { starts: { e1: "2026-12-01", gone: "2026-01-01" }, collapsed: [FILTER_NONE] },
      new Set(["e1"]),
      null,
    );
    expect(spec.scope).toEqual({ kind: "all" });
    expect(spec.filter.project_ids).toEqual(["p1", FILTER_NONE]);
    expect(spec.lineage).toBeNull();
    expect(spec.roadmap).toEqual({
      epic: null,
      completion: "all",
      group: "none",
      zoom: "quarter",
      starts: { e1: "2026-12-01" },
      collapsed: [FILTER_NONE],
      hide_unscheduled: true,
    });
    expect(filterOf(spec)).toEqual(filter);
    expect(layoutOf(spec)).toEqual({ starts: { e1: "2026-12-01" }, collapsed: [FILTER_NONE] });
    expect(sameFilter(filter, { ...filter, projects: [FILTER_NONE, "p1"] })).toBe(true);
    expect(sameFilter(filter, { ...filter, zoom: "week" })).toBe(false);
  });

  it("keep an epic's timeline with its tag filter and subtasks, not projects", () => {
    const timeline = { ...filter, tags: ["t1"], subtasks: false, completion: "ready" as const };
    const spec = roadmapSpec(timeline, { starts: {}, collapsed: [] }, new Set(), "e1");
    expect(spec.roadmap?.epic).toBe("e1");
    expect(spec.filter.project_ids).toEqual([]);
    expect(spec.filter.tag_ids).toEqual(["t1"]);
    expect(spec.show_subtasks).toBe(false);
    expect(filterOf(spec)).toMatchObject({ tags: ["t1"], subtasks: false, completion: "ready" });
  });

  it("start from each level's defaults and ignore what does not parse", () => {
    expect(loadFilter("epics")).toEqual(DEFAULT_FILTER.epics);
    expect(loadFilter("tasks")).toEqual(DEFAULT_FILTER.tasks);
    saveFilter("epics", filter);
    expect(loadFilter("epics")).toEqual(filter);
    expect(loadFilter("tasks")).toEqual(DEFAULT_FILTER.tasks);
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ starts: { a: "2026-12-01", b: "soon", c: 3 }, collapsed: ["x", 1] }),
    );
    expect(loadLayout()).toEqual({ starts: { a: "2026-12-01" }, collapsed: ["x"] });
    localStorage.setItem(LAYOUT_KEY, "{not json");
    expect(loadLayout()).toEqual({ starts: {}, collapsed: [] });
  });
});
