import { describe, expect, it } from "vitest";
import type { Epic } from "../../lib/types";
import { FILTER_NONE } from "../../lib/views";
import { project, task } from "../../test/fixtures";
import {
  addWorkingDays,
  barOf,
  dayNumber,
  isoOf,
  linksOf,
  newBar,
  rangeOf,
  rowsOf,
  shiftBar,
  spanBetween,
  ticksOf,
  weekday,
} from "./timeline";

function epic(overrides: Partial<Epic>): Epic {
  return {
    id: "e",
    project_id: null,
    name: "Epic",
    color: null,
    icon: null,
    description: null,
    target_date: null,
    state: "active",
    rank: "a",
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    ...overrides,
  };
}

describe("days", () => {
  it("counts whole days without daylight-saving drift", () => {
    expect(isoOf(dayNumber("2026-03-29"))).toBe("2026-03-29");
    expect(dayNumber("2026-03-30") - dayNumber("2026-03-28")).toBe(2);
    expect(dayNumber("2027-01-01") - dayNumber("2026-12-31")).toBe(1);
    // 2026-11-20 is a Friday, 2026-11-22 a Sunday.
    expect(weekday(dayNumber("2026-11-20"))).toBe(5);
    expect(weekday(dayNumber("2026-11-22"))).toBe(0);
  });

  it("skips weekends when counting working days", () => {
    expect(addWorkingDays("2026-11-20", 1)).toBe("2026-11-23");
    expect(addWorkingDays("2026-11-23", -1)).toBe("2026-11-20");
    expect(addWorkingDays("2026-11-25", -2)).toBe("2026-11-23");
    expect(addWorkingDays("2026-11-25", 0)).toBe("2026-11-25");
  });
});

describe("bars", () => {
  it("end on the due date and start where the roadmap says, or as early as the estimate", () => {
    expect(barOf(task({ due_date: null }), {})).toBeNull();
    const t = task({ due_date: "2026-11-25", estimate_min: 3 * 480 });
    expect(barOf(t, {})).toEqual({ start: "2026-11-23", end: "2026-11-25" });
    expect(barOf(task({ due_date: "2026-11-25" }), {})).toEqual({
      start: "2026-11-25",
      end: "2026-11-25",
    });
    expect(barOf(t, { [t.id]: "2026-11-02" })).toEqual({ start: "2026-11-02", end: "2026-11-25" });
    // A due date moved before the start pulls the start back to it.
    expect(barOf(t, { [t.id]: "2026-12-01" })).toEqual({ start: "2026-11-25", end: "2026-11-25" });
  });

  it("move, resize without crossing their ends, and are drawn either way", () => {
    const bar = { start: "2026-11-23", end: "2026-11-25" };
    expect(shiftBar(bar, "move", 7)).toEqual({ start: "2026-11-30", end: "2026-12-02" });
    expect(shiftBar(bar, "start", -2)).toEqual({ start: "2026-11-21", end: "2026-11-25" });
    expect(shiftBar(bar, "start", 5)).toEqual({ start: "2026-11-25", end: "2026-11-25" });
    expect(shiftBar(bar, "end", -9)).toEqual({ start: "2026-11-23", end: "2026-11-23" });
    expect(spanBetween("2026-11-25", "2026-11-20")).toEqual({
      start: "2026-11-20",
      end: "2026-11-25",
    });
    expect(newBar(task({ estimate_min: 600 }), "2026-11-20")).toEqual({
      start: "2026-11-20",
      end: "2026-11-23",
    });
  });
});

describe("range and scale", () => {
  it("covers every date and today, with room around them, from a Monday", () => {
    const range = rangeOf(["2026-10-01", "2027-02-10"], "2026-11-20", "week");
    expect(weekday(dayNumber(range.from))).toBe(1);
    expect(range.from <= "2026-10-01").toBe(true);
    const last = isoOf(dayNumber(range.from) + range.days - 1);
    expect(last >= "2027-02-10").toBe(true);
    // Little to show still gives a useful width, today a third of the way in.
    const small = rangeOf([], "2026-11-20", "day");
    expect(small.days).toBeGreaterThanOrEqual(42);
    expect(dayNumber("2026-11-20") - dayNumber(small.from)).toBeLessThan(small.days / 2);
    expect(rangeOf([], "2026-11-20", "month").from.endsWith("-01")).toBe(true);
  });

  it("labels months over days, and years over quarters", () => {
    const range = { from: "2026-11-30", days: 3 };
    const day = ticksOf(range, "day");
    expect(day.top.map((t) => [t.offset, t.length])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(day.bottom.map((t) => t.label)).toEqual(["30", "1", "2"]);
    const quarters = ticksOf({ from: "2026-12-01", days: 62 }, "quarter");
    expect(quarters.top.map((t) => t.label)).toEqual(["2026", "2027"]);
    expect(quarters.bottom.map((t) => t.label)).toEqual(["Q4", "Q1"]);
    const weeks = ticksOf({ from: "2026-11-16", days: 14 }, "week");
    expect(weeks.bottom.map((t) => [t.label, t.length])).toEqual([
      ["16", 7],
      ["23", 7],
    ]);
  });
});

describe("rows", () => {
  const first = epic({ id: "e1", name: "Launch", rank: "a1", target_date: "2026-12-15" });
  const second = epic({ id: "e2", name: "Polish", rank: "a2", color: "#c00" });
  const epics = { e1: first, e2: second };

  it("groups tasks under their epic by rank, no epic last, scheduled ones by start", () => {
    const late = task({ title: "Late", epic_id: "e1", due_date: "2026-12-10" });
    const early = task({ title: "Early", epic_id: "e1", due_date: "2026-12-01" });
    const loose = task({ title: "Loose", epic_id: "e1" });
    const polish = task({ title: "Polish it", epic_id: "e2", due_date: "2026-12-05" });
    const none = task({ title: "None" });
    const list = [none, loose, late, polish, early];
    const bars = new Map(
      list.flatMap((t) => {
        const bar = barOf(t, {});
        return bar ? [[t.id, bar] as const] : [];
      }),
    );
    const rows = rowsOf(list, bars, "epic", epics, {}, new Set());
    expect(rows.map((row) => (row.kind === "group" ? `# ${row.label}` : row.task.title))).toEqual([
      "# Launch",
      "Early",
      "Late",
      "Loose",
      "# Polish",
      "Polish it",
      "# No epic",
      "None",
    ]);
    const launch = rows[0];
    expect(launch?.kind === "group" && launch.span).toEqual({
      start: "2026-12-01",
      end: "2026-12-10",
    });
    expect(launch?.kind === "group" && launch.epic?.target_date).toBe("2026-12-15");

    const folded = rowsOf(list, bars, "epic", epics, {}, new Set(["e1", FILTER_NONE]));
    expect(folded.map((row) => (row.kind === "group" ? row.key : row.task.title))).toEqual([
      "e1",
      "e2",
      "Polish it",
      FILTER_NONE,
    ]);
    expect(folded[0]?.kind === "group" && folded[0].count).toBe(3);
  });

  it("groups by project, or not at all", () => {
    const home = project({ name: "Home" });
    const a = task({ title: "A", project_id: home.id });
    const b = task({ title: "B" });
    const byProject = rowsOf([a, b], new Map(), "project", {}, { [home.id]: home }, new Set());
    expect(byProject.map((row) => (row.kind === "group" ? row.label : row.task.title))).toEqual([
      "Home",
      "A",
      "No project",
      "B",
    ]);
    expect(rowsOf([a, b], new Map(), "none", {}, {}, new Set())).toHaveLength(2);
  });
});

describe("links", () => {
  it("flags a dependent that starts before its prerequisite ends", () => {
    const a = task({ due_date: "2026-11-25" });
    const b = task({ due_date: "2026-11-30", dependency_ids: [a.id] });
    const c = task({ due_date: "2026-11-25", dependency_ids: [a.id] });
    const d = task({ dependency_ids: [a.id] });
    const list = [a, b, c, d];
    const bars = new Map(
      list.flatMap((t) => {
        const bar = barOf(t, {});
        return bar ? [[t.id, bar] as const] : [];
      }),
    );
    expect(linksOf(list, bars)).toEqual([
      { from: a.id, to: b.id, late: false },
      { from: a.id, to: c.id, late: true },
    ]);
  });
});
