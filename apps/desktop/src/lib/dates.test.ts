import { describe, expect, it } from "vitest";
import { daysFrom, formatAgo, formatDue, isoDate } from "./dates";

describe("dates", () => {
  it("formats local dates as ISO", () => {
    expect(isoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("counts days across months and leap years", () => {
    expect(daysFrom("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysFrom("2026-11-04", "2026-11-01")).toBe(-3);
  });

  it("labels due dates relative to today", () => {
    expect(formatDue("2026-11-04", "2026-11-04")).toBe("Today");
    expect(formatDue("2026-11-05", "2026-11-04")).toBe("Tomorrow");
    expect(formatDue("2026-11-03", "2026-11-04")).toBe("Yesterday");
    expect(formatDue("2027-01-10", "2026-11-04")).toContain("2027");
  });

  it("formats relative times", () => {
    expect(formatAgo(1_000_000, 1_010_000)).toBe("just now");
    expect(formatAgo(0, 5 * 60_000)).toBe("5 min ago");
  });
});
