import { describe, expect, it } from "vitest";
import { task, timeBlock } from "../test/fixtures";
import {
  addDays,
  atMinute,
  blockMinutes,
  dragId,
  dropId,
  formatDuration,
  layoutDay,
  loggedMinutes,
  minuteOfDay,
  monthWeeks,
  nextSlot,
  resolveDrop,
  segmentsOn,
  shiftPeriod,
  startOfWeek,
  visibleDays,
} from "./calendar";

const at = (iso: string, h: number, m = 0) => atMinute(iso, h * 60 + m);

describe("dates", () => {
  it("adds days across months and years", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("starts weeks on Monday", () => {
    expect(startOfWeek("2026-11-05")).toBe("2026-11-02"); // Thursday
    expect(startOfWeek("2026-11-02")).toBe("2026-11-02"); // Monday
    expect(startOfWeek("2026-11-08")).toBe("2026-11-02"); // Sunday
    expect(visibleDays("week", "2026-11-05")).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ]);
    expect(visibleDays("day", "2026-11-05")).toEqual(["2026-11-05"]);
  });

  it("covers a month with whole weeks", () => {
    const weeks = monthWeeks("2026-11-17");
    expect(weeks).toHaveLength(6); // Nov 2026 starts on a Sunday
    expect(weeks[0]?.[0]).toBe("2026-10-26");
    expect(weeks[0]?.[6]).toBe("2026-11-01");
    expect(weeks[5]?.[6]).toBe("2026-12-06");
    expect(monthWeeks("2021-02-10")).toHaveLength(4); // Feb 2021: Monday 1st to Sunday 28th
  });

  it("moves by a period", () => {
    expect(shiftPeriod("day", "2026-11-05", 1)).toBe("2026-11-06");
    expect(shiftPeriod("week", "2026-11-05", -1)).toBe("2026-10-29");
    expect(shiftPeriod("month", "2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftPeriod("month", "2026-01-15", -1)).toBe("2025-12-01");
  });

  it("converts between times and minutes of the day", () => {
    expect(minuteOfDay(at("2026-11-05", 9, 30))).toBe(570);
    expect(atMinute("2026-11-05", 24 * 60)).toBe(at("2026-11-06", 0));
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 h");
    expect(formatDuration(90)).toBe("1 h 30");
  });
});

describe("blocks", () => {
  it("uses the estimate for a new block's length", () => {
    expect(blockMinutes(task({ estimate_min: null }))).toBe(60);
    expect(blockMinutes(task({ estimate_min: 25 }))).toBe(30);
    expect(blockMinutes(task({ estimate_min: 5 }))).toBe(15);
    expect(blockMinutes(task({ estimate_min: 0 }))).toBe(60);
  });

  it("logs done and worked time only", () => {
    const start_at = at("2026-11-05", 9);
    expect(
      loggedMinutes([
        timeBlock({ start_at, end_at: start_at + 30 * 60_000, outcome: "done" }),
        timeBlock({ start_at, end_at: start_at + 45 * 60_000, outcome: "worked" }),
        timeBlock({ start_at, end_at: start_at + 60 * 60_000, outcome: "planned" }),
        timeBlock({ start_at, end_at: start_at + 60 * 60_000, outcome: "cancelled" }),
      ]),
    ).toBe(75);
  });

  it("clips blocks to the day they show on", () => {
    const late = timeBlock({ start_at: at("2026-11-05", 23), end_at: at("2026-11-06", 1) });
    const other = timeBlock({ start_at: at("2026-11-07", 9) });
    const [today] = segmentsOn([late, other], "2026-11-05");
    expect(today).toMatchObject({ startMin: 23 * 60, endMin: 24 * 60, continuesAfter: true });
    const [tomorrow] = segmentsOn([late, other], "2026-11-06");
    expect(tomorrow).toMatchObject({ startMin: 0, endMin: 60, continuesBefore: true });
    expect(segmentsOn([late, other], "2026-11-08")).toEqual([]);
  });

  it("lays overlapping blocks side by side", () => {
    const iso = "2026-11-05";
    const a = timeBlock({ id: "a", start_at: at(iso, 9), end_at: at(iso, 11) });
    const b = timeBlock({ id: "b", start_at: at(iso, 10), end_at: at(iso, 12) });
    const c = timeBlock({ id: "c", start_at: at(iso, 11), end_at: at(iso, 13) });
    const d = timeBlock({ id: "d", start_at: at(iso, 14), end_at: at(iso, 15) });
    const placed = layoutDay(segmentsOn([d, c, b, a], iso));
    const byId = Object.fromEntries(placed.map((p) => [p.item.id, [p.column, p.columns]]));
    // a and b overlap; c reuses a's column after it ends; d is alone.
    expect(byId).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] });
  });
});

describe("drops", () => {
  const iso = "2026-11-05";
  const t = task({ id: "t1", estimate_min: 45, today_on: null });
  const block = timeBlock({ id: "b1", task_id: "t1", start_at: at(iso, 9), end_at: at(iso, 10) });
  const entities = { tasks: { t1: t }, time_blocks: { b1: block } };

  it("schedules a task at the snapped pointer time, for its estimate", () => {
    expect(
      resolveDrop(
        { active: dragId.task("t1"), over: dropId.time(iso), pointerMinute: 14 * 60 + 8 },
        entities,
      ),
    ).toEqual({
      kind: "schedule",
      taskId: "t1",
      start_at: at(iso, 14, 15),
      end_at: at(iso, 15),
    });
  });

  it("moves a block by where it was grabbed, keeping its length", () => {
    expect(
      resolveDrop(
        {
          active: dragId.block("b1"),
          over: dropId.time("2026-11-06"),
          pointerMinute: 13 * 60 + 20,
          grabMinute: 20,
        },
        entities,
      ),
    ).toEqual({
      kind: "move",
      blockId: "b1",
      start_at: at("2026-11-06", 13),
      end_at: at("2026-11-06", 14),
    });
  });

  it("keeps drops inside the day", () => {
    const early = resolveDrop(
      { active: dragId.task("t1"), over: dropId.time(iso), pointerMinute: -50 },
      entities,
    );
    expect(early).toMatchObject({ start_at: at(iso, 0) });
    const late = resolveDrop(
      { active: dragId.task("t1"), over: dropId.time(iso), pointerMinute: 24 * 60 + 30 },
      entities,
    );
    expect(late).toMatchObject({ start_at: at(iso, 23, 45) });
  });

  it("plans a task for a day, or moves a block to it at the same time", () => {
    expect(resolveDrop({ active: dragId.task("t1"), over: dropId.day(iso) }, entities)).toEqual({
      kind: "plan",
      taskId: "t1",
      date: iso,
    });
    expect(
      resolveDrop({ active: dragId.block("b1"), over: dropId.day("2026-11-10") }, entities),
    ).toEqual({
      kind: "move",
      blockId: "b1",
      start_at: at("2026-11-10", 9),
      end_at: at("2026-11-10", 10),
    });
  });

  it("ignores drops that change nothing", () => {
    const planned = { ...entities, tasks: { t1: { ...t, today_on: iso } } };
    expect(resolveDrop({ active: dragId.task("t1"), over: dropId.day(iso) }, planned)).toBeNull();
    expect(
      resolveDrop(
        { active: dragId.block("b1"), over: dropId.time(iso), pointerMinute: 9 * 60 + 5 },
        entities,
      ),
    ).toBeNull();
    expect(resolveDrop({ active: dragId.block("b1"), over: null }, entities)).toBeNull();
    expect(
      resolveDrop({ active: dragId.task("gone"), over: dropId.day(iso) }, entities),
    ).toBeNull();
  });

  it("suggests the next quarter hour today and 09:00 on other days", () => {
    const now = at(iso, 10, 7);
    expect(nextSlot(iso, now)).toBe(at(iso, 10, 15));
    expect(nextSlot(iso, at(iso, 10, 15))).toBe(at(iso, 10, 30));
    expect(nextSlot("2026-11-06", now)).toBe(at("2026-11-06", 9));
  });
});
