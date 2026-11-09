import { describe, expect, it } from "vitest";
import { atMinute } from "../../lib/calendar";
import { STATUS, statuses, task } from "../../test/fixtures";
import { burnDown, taskMetrics } from "./metrics";

const today = "2026-11-05";
const at = (date: string) => atMinute(date, 12 * 60);

describe("task metrics", () => {
  it("counts creations and completions independently with inclusive local start and exclusive end", () => {
    const tasks = [
      task({ created_at: atMinute("2026-10-30", 0) }),
      task({
        created_at: at("2026-10-29"),
        completed_at: at(today),
        status_id: STATUS.done,
        tag_ids: ["ai", "bug"],
      }),
      task({ created_at: at(today), completed_at: at(today), status_id: STATUS.cancelled }),
      task({ created_at: at(today), deleted_at: at(today) }),
      task({ created_at: atMinute("2026-11-06", 0) }),
      task({
        created_at: at("2026-10-01"),
        completed_at: atMinute("2026-11-06", 0),
        status_id: STATUS.done,
      }),
      task({ created_at: at("2026-10-01"), completed_at: at(today), status_id: STATUS.todo }),
    ];
    const result = taskMetrics(tasks, statuses, today, 7, "ai");
    expect(result.created).toBe(2);
    expect(result.completed).toBe(1);
    expect(result.aiCompleted).toBe(1);
    expect(result.trend[0]).toEqual({ date: "2026-10-30", created: 1, completed: 0 });
    expect(result.trend.at(-1)).toEqual({ date: today, created: 1, completed: 1 });
    expect(result.medianDays).toBe(7);
  });

  it("counts stale and overdue only for open tasks, and uses a true median", () => {
    const result = taskMetrics(
      [
        task({ updated_at: at("2026-10-06"), due_date: "2026-11-04" }),
        task({ updated_at: at("2026-10-07"), due_date: today }),
        ...[2, 4].map((days) =>
          task({
            status_id: STATUS.done,
            created_at: at(today) - days * 86_400_000,
            completed_at: at(today),
          }),
        ),
        task({ status_id: STATUS.cancelled, due_date: "2026-10-01" }),
      ],
      statuses,
      today,
      30,
      "",
    );
    expect(result).toMatchObject({
      open: 2,
      stale: 1,
      overdue: 1,
      medianDays: 3,
      aiCompleted: null,
    });
  });

  it("returns zero filled days and no invented AI or completion duration for empty data", () => {
    const result = taskMetrics([], statuses, today, 30, "");
    expect(result).toMatchObject({
      created: 0,
      completed: 0,
      open: 0,
      medianDays: null,
      aiCompleted: null,
    });
    expect(result.trend).toHaveLength(30);
    expect(result.trend.every((b) => b.created === 0 && b.completed === 0)).toBe(true);
  });
});

describe("burn-down", () => {
  it("counts open tasks at the end of each day and projects the pace to zero", () => {
    const tasks = [
      // Open throughout.
      task({ created_at: at("2026-10-01") }),
      // Open before the period, done on the third day.
      task({
        created_at: at("2026-10-01"),
        status_id: STATUS.done,
        completed_at: at("2026-11-01"),
      }),
      // Open before the period, cancelled on the fourth day (by its last update).
      task({
        created_at: at("2026-10-01"),
        status_id: STATUS.cancelled,
        updated_at: at("2026-11-02"),
      }),
      // Created on the last day and still open.
      task({ created_at: at(today) }),
      // Deleted tasks never count.
      task({ created_at: at("2026-10-01"), deleted_at: at(today) }),
      // Created and done before the period.
      task({
        created_at: at("2026-10-01"),
        status_id: STATUS.done,
        completed_at: at("2026-10-02"),
      }),
    ];
    const result = burnDown(tasks, statuses, today, 7);
    expect(result.points.map((p) => p.date)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      today,
    ]);
    expect(result.points.map((p) => p.open)).toEqual([3, 3, 2, 1, 1, 1, 2]);
    expect(result).toMatchObject({ before: 3, now: 2, peak: 3 });
    expect(result.netPerDay).toBeCloseTo(1 / 7);
    expect(result.clearInDays).toBe(14);
  });

  it("has no projection while the backlog grows, and zero once it is empty", () => {
    expect(burnDown([task({ created_at: at(today) })], statuses, today, 7)).toMatchObject({
      before: 0,
      now: 1,
      clearInDays: null,
    });
    expect(burnDown([], statuses, today, 7)).toMatchObject({ now: 0, clearInDays: 0, peak: 0 });
  });
});
