import { describe, expect, it } from "vitest";
import { atMinute } from "../../lib/calendar";
import { STATUS, statuses, task } from "../../test/fixtures";
import { taskMetrics } from "./metrics";

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
