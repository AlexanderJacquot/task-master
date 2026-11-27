import { describe, expect, it } from "vitest";
import vectors from "../../../../../crates/core/test-vectors/roadmap.json";
import type { ImageTheme, RoadmapImage, ViewSpec } from "../../lib/types";
import { asOfLabel, imageFromSpec, type RoadmapData } from "./model";
import { DEFAULT_FILTER, roadmapSpec } from "./saved";

// The cases are shared with the core's port (`crates/core/src/roadmap.rs`), which the sync
// server draws its roadmap images with (ADR 035): both must build the same image model.
type Case = {
  name: string;
  spec: ViewSpec;
  options: { view_name: string | null; today: string; theme: ImageTheme };
  expected: RoadmapImage;
};

const data = vectors.data as unknown as RoadmapData;
const cases = vectors.cases as unknown as Case[];

describe("the roadmap shared with the core", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(imageFromSpec(data, c.spec, c.options, "en-US")).toEqual(c.expected);
  });

  it("starts from the page's defaults", () => {
    const empty = { starts: {}, collapsed: [] };
    const epic = (vectors.defaults.tasks as unknown as ViewSpec).roadmap?.epic ?? null;
    expect(epic).not.toBeNull();
    expect(roadmapSpec(DEFAULT_FILTER.epics, empty, new Set(), null)).toEqual(
      vectors.defaults.epics,
    );
    expect(roadmapSpec(DEFAULT_FILTER.tasks, empty, new Set(), epic)).toEqual(
      vectors.defaults.tasks,
    );
  });

  it("dates the image in English for the fixture", () => {
    expect(asOfLabel("2027-01-04", "en-US")).toBe("Jan 4, 2027");
  });
});
