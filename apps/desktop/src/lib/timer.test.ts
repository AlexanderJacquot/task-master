import { describe, expect, it } from "vitest";
import { timeBlock } from "../test/fixtures";
import {
  formatClock,
  formatLogged,
  loggedMs,
  MAX_BLOCK_MS,
  MIN_LOGGED_MS,
  runToBlocks,
} from "./timer";

const HOUR = 3_600_000;

describe("runToBlocks", () => {
  it("drops runs under a minute", () => {
    expect(runToBlocks(1000, 1000 + MIN_LOGGED_MS - 1)).toEqual([]);
    expect(runToBlocks(1000, 1000 + MIN_LOGGED_MS)).toEqual([
      { start_at: 1000, end_at: 1000 + MIN_LOGGED_MS },
    ]);
  });

  it("splits runs longer than a day into back-to-back blocks", () => {
    const end = 30 * HOUR;
    expect(runToBlocks(0, end)).toEqual([
      { start_at: 0, end_at: MAX_BLOCK_MS },
      { start_at: MAX_BLOCK_MS, end_at: end },
    ]);
    expect(runToBlocks(0, MAX_BLOCK_MS)).toHaveLength(1);
  });
});

describe("loggedMs", () => {
  it("sums the task's live done and worked blocks", () => {
    const blocks = [
      timeBlock({ task_id: "a", start_at: 0, end_at: HOUR, outcome: "worked" }),
      timeBlock({ task_id: "a", start_at: 2 * HOUR, end_at: 2.5 * HOUR, outcome: "done" }),
      timeBlock({ task_id: "a", start_at: 0, end_at: HOUR, outcome: "planned" }),
      timeBlock({ task_id: "a", start_at: 0, end_at: HOUR, outcome: "cancelled" }),
      timeBlock({ task_id: "a", start_at: 0, end_at: HOUR, outcome: "worked", deleted_at: 5 }),
      timeBlock({ task_id: "b", start_at: 0, end_at: HOUR, outcome: "worked" }),
    ];
    expect(loggedMs(blocks, "a")).toBe(1.5 * HOUR);
  });
});

describe("formatting", () => {
  it("shows a running clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(247_000)).toBe("4:07");
    expect(formatClock(HOUR + 2 * 60_000 + 3000)).toBe("1:02:03");
  });

  it("shows a logged total", () => {
    expect(formatLogged(45 * 60_000)).toBe("45 min");
    expect(formatLogged(2 * HOUR)).toBe("2 h");
    expect(formatLogged(3 * HOUR + 20 * 60_000)).toBe("3 h 20 min");
  });
});
