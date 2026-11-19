import { describe, expect, it } from "vitest";
import { task, timeBlock } from "../test/fixtures";
import { atMinute } from "./calendar";
import { DEFAULT_HOURS } from "./planner";
import { blocksToReview, dayLabel, laterToday, nextWorkday, type ReplanInput } from "./replan";

// Thursday 2026-11-12; working hours 09:00 to 17:00, no weekends.
const THU = "2026-11-12";
const at = (iso: string, h: number, m = 0) => atMinute(iso, h * 60 + m);

function input(extra: Partial<ReplanInput> = {}): ReplanInput {
  return {
    today: THU,
    now: at(THU, 10, 5),
    hours: DEFAULT_HOURS,
    blocks: [],
    events: [],
    minutes: 60,
    ...extra,
  };
}

describe("laterToday", () => {
  it("takes the next free quarter hour after now", () => {
    expect(laterToday(input())).toEqual({
      iso: THU,
      start_at: at(THU, 10, 15),
      end_at: at(THU, 11, 15),
    });
  });

  it("skips blocks and events too short to fit between, but not missed or cancelled blocks", () => {
    const blocks = [
      timeBlock({ start_at: at(THU, 11), end_at: at(THU, 12) }),
      timeBlock({ start_at: at(THU, 12), end_at: at(THU, 13), outcome: "missed" }),
      timeBlock({ start_at: at(THU, 13), end_at: at(THU, 14), outcome: "cancelled" }),
    ];
    const events = [{ id: "e1", start_at: at(THU, 14), end_at: at(THU, 15) }];
    expect(laterToday(input({ blocks, events }))?.start_at).toBe(at(THU, 12));
    // 12:00 to 14:00 is free only because the missed and cancelled blocks do not hold it.
    expect(laterToday(input({ blocks, events, minutes: 120 }))?.start_at).toBe(at(THU, 12));
    expect(laterToday(input({ blocks, events, minutes: 150 }))).toBeNull();
  });

  it("is null when nothing fits before the end of the working day", () => {
    expect(laterToday(input({ now: at(THU, 16, 30) }))).toBeNull();
    expect(laterToday(input({ now: at(THU, 18) }))).toBeNull();
  });
});

describe("nextWorkday", () => {
  it("starts the next working day at the start of working hours", () => {
    expect(nextWorkday(input())).toEqual({
      iso: "2026-11-13",
      start_at: at("2026-11-13", 9),
      end_at: at("2026-11-13", 10),
    });
  });

  it("goes past the weekend unless weekends are on, and past full days", () => {
    const friday = input({ today: "2026-11-13", now: at("2026-11-13", 10) });
    expect(nextWorkday(friday)?.iso).toBe("2026-11-16");
    expect(nextWorkday({ ...friday, hours: { ...DEFAULT_HOURS, weekends: true } })?.iso).toBe(
      "2026-11-14",
    );
    const busy = [timeBlock({ start_at: at("2026-11-13", 9), end_at: at("2026-11-13", 17) })];
    expect(nextWorkday(input({ blocks: busy }))?.iso).toBe("2026-11-16");
  });
});

describe("dayLabel", () => {
  it("says Tomorrow for the next day and the weekday's name after", () => {
    expect(dayLabel("2026-11-13", THU)).toBe("Tomorrow");
    expect(dayLabel("2026-11-16", THU)).toBe(
      new Date(2026, 10, 16).toLocaleDateString(undefined, { weekday: "long" }),
    );
  });
});

describe("blocksToReview", () => {
  it("lists ended blocks still planned, of live tasks, over the last week, oldest first", () => {
    const live = task({ title: "Live" });
    const gone = task({ title: "Gone", deleted_at: 1 });
    const tasks = { [live.id]: live, [gone.id]: gone };
    const block = (iso: string, h: number, extra = {}) =>
      timeBlock({ task_id: live.id, start_at: at(iso, h), end_at: at(iso, h + 1), ...extra });
    const morning = block(THU, 8);
    const yesterday = block("2026-11-11", 14);
    const weekAgo = block("2026-11-06", 9);
    const tooOld = block("2026-11-05", 9);
    const running = block(THU, 10);
    const worked = block(THU, 7, { outcome: "worked" });
    const removed = block(THU, 6, { deleted_at: 1 });
    const ofGone = timeBlock({ task_id: gone.id, start_at: at(THU, 5), end_at: at(THU, 6) });
    const all = [morning, yesterday, weekAgo, tooOld, running, worked, removed, ofGone];
    expect(blocksToReview(all, tasks, THU, at(THU, 10, 30)).map((b) => b.id)).toEqual([
      weekAgo.id,
      yesterday.id,
      morning.id,
    ]);
  });
});
