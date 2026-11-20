import { describe, expect, it } from "vitest";
import type { Epic } from "../../lib/types";
import { FILTER_NONE } from "../../lib/views";
import { project, task } from "../../test/fixtures";
import {
  addWorkingDays,
  barOf,
  dayNumber,
  epicBar,
  epicItems,
  type Item,
  isoOf,
  linksOf,
  newBar,
  rangeOf,
  rowsOf,
  shiftBar,
  spanBetween,
  taskItem,
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

describe("epics", () => {
  const status = { done: new Set<string>(), cancelled: new Set<string>() };

  it("end on the target date and start where the roadmap says, their first task, or earlier", () => {
    const launch = epic({ id: "e1", target_date: "2026-12-18" });
    expect(epicBar(epic({ target_date: null }), {}, [])).toBeNull();
    expect(epicBar(launch, { e1: "2026-12-01" }, [])).toEqual({
      start: "2026-12-01",
      end: "2026-12-18",
    });
    expect(
      epicBar(launch, {}, [
        { start: "2026-12-10", end: "2026-12-11" },
        { start: "2026-12-09", end: "2026-12-10" },
      ]),
    ).toEqual({ start: "2026-12-09", end: "2026-12-18" });
    // No tasks scheduled: two working weeks before the target date.
    expect(epicBar(launch, {}, [])).toEqual({ start: "2026-12-07", end: "2026-12-18" });
  });

  it("count progress without cancelled tasks, and wait on the epics their tasks wait on", () => {
    const a = epic({ id: "a", name: "API", rank: "a1", target_date: "2026-12-04" });
    const b = epic({ id: "b", name: "App", rank: "a2", target_date: "2026-12-04" });
    const c = epic({ id: "c", name: "Hidden", rank: "a3" });
    const api = task({ epic_id: "a", due_date: "2026-12-04" });
    const done = task({ epic_id: "b" });
    const dropped = task({ epic_id: "b" });
    const app = task({ epic_id: "b", dependency_ids: [api.id] });
    const inner = task({ epic_id: "b", dependency_ids: [done.id] });
    const other = task({ epic_id: "c" });
    const outside = task({ epic_id: "b", dependency_ids: [other.id] });
    const items = epicItems(
      [a, b],
      [api, done, dropped, app, inner, other, outside],
      {},
      { done: new Set([done.id]), cancelled: new Set([dropped.id]) },
      (e) => e.project_id ?? FILTER_NONE,
    );
    expect(items.map((item) => [item.id, item.progress, item.after])).toEqual([
      ["a", 0, []],
      // 1 done of 4 (the cancelled one is left out); only shown epics are waited on.
      ["b", 0.25, ["a"]],
    ]);
    expect(items[0]?.group).toBe(FILTER_NONE);
    expect(items[0]?.span).toEqual({ start: "2026-12-04", end: "2026-12-04" });
    expect(items[1]?.span).toBeNull();
    // B starts with the two working weeks before its target, before A ends: late.
    expect(linksOf(items)).toEqual([{ from: "a", to: "b", late: true }]);
    expect(epicItems([c], [], {}, status, () => "")[0]?.done).toBe(false);
    expect(epicItems([{ ...c, state: "done" }], [], {}, status, () => "")[0]?.done).toBe(true);
  });
});

describe("rows", () => {
  const item = (overrides: Partial<Item>): Item => ({
    id: "x",
    title: "X",
    rank: "a",
    bar: null,
    length: 1,
    done: false,
    progress: null,
    color: null,
    group: "",
    parent: null,
    after: [],
    span: null,
    ...overrides,
  });

  it("groups items under their project by rank, no project last, scheduled ones by start", () => {
    const home = project({ name: "Home", rank: "a1" });
    const work = project({ name: "Work", rank: "a2" });
    const items = [
      item({ id: "loose", title: "Loose", group: home.id, rank: "a0" }),
      item({
        id: "late",
        title: "Late",
        group: home.id,
        bar: { start: "2026-12-10", end: "2026-12-11" },
      }),
      item({
        id: "early",
        title: "Early",
        group: home.id,
        bar: { start: "2026-12-01", end: "2026-12-02" },
      }),
      item({ id: "none", title: "None", group: FILTER_NONE }),
      item({ id: "work", title: "Work it", group: work.id }),
    ];
    const owners = { [home.id]: home, [work.id]: work };
    const rows = rowsOf(items, owners, "No project", new Set());
    expect(rows.map((row) => (row.kind === "group" ? `# ${row.label}` : row.item.title))).toEqual([
      "# Home",
      "Early",
      "Late",
      "Loose",
      "# Work",
      "Work it",
      "# No project",
      "None",
    ]);
    const first = rows[0];
    expect(first?.kind === "group" && first.span).toEqual({
      start: "2026-12-01",
      end: "2026-12-11",
    });

    const folded = rowsOf(items, owners, "No project", new Set([home.id, FILTER_NONE]));
    expect(folded.map((row) => (row.kind === "group" ? row.key : row.item.title))).toEqual([
      home.id,
      work.id,
      "Work it",
      FILTER_NONE,
    ]);
    expect(folded[0]?.kind === "group" && folded[0].count).toBe(3);
  });

  it("lists subtasks under their parent without groups", () => {
    const items = [
      item({
        id: "child",
        title: "Child",
        parent: "parent",
        bar: { start: "2026-12-01", end: "2026-12-01" },
      }),
      item({ id: "parent", title: "Parent", bar: { start: "2026-12-05", end: "2026-12-06" } }),
      item({
        id: "orphan",
        title: "Orphan",
        parent: "gone",
        bar: { start: "2026-12-03", end: "2026-12-03" },
      }),
    ];
    expect(
      rowsOf(items, null, "", new Set()).map((row) =>
        row.kind === "item" ? `${row.depth}:${row.item.title}` : "",
      ),
    ).toEqual(["0:Orphan", "0:Parent", "1:Child"]);
  });
});

describe("links", () => {
  it("flag a dependent that starts before its prerequisite ends", () => {
    const a = task({ due_date: "2026-11-25" });
    const b = task({ due_date: "2026-11-30", dependency_ids: [a.id] });
    const c = task({ due_date: "2026-11-25", dependency_ids: [a.id] });
    const d = task({ dependency_ids: [a.id] });
    const items = [a, b, c, d].map((t) => taskItem(t, barOf(t, {}), false));
    expect(linksOf(items)).toEqual([
      { from: a.id, to: b.id, late: false },
      { from: a.id, to: c.id, late: true },
    ]);
  });
});
