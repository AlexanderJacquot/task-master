import { describe, expect, it } from "vitest";
import { STATUS, statuses, task } from "../test/fixtures";
import { planCandidates } from "./planDay";
import type { ViewContext } from "./views";

const ctx: ViewContext = {
  today: "2026-11-04",
  statuses: Object.fromEntries(statuses.map((s) => [s.id, s])),
  projects: {},
};

describe("planCandidates", () => {
  it("suggests pressing open tasks, most pressing first, with reasons", () => {
    const tasks = [
      task({ title: "Calm" }),
      task({ title: "Urgent", priority: "urgent" }),
      task({ title: "Late", due_date: "2026-11-01" }),
      task({ title: "Soon", due_date: "2026-11-05" }),
      task({ title: "Started", status_id: STATUS.inProgress }),
      task({ title: "Picked", priority: "urgent", today_on: "2026-11-04" }),
      task({ title: "Closed", priority: "urgent", status_id: STATUS.done }),
      task({ title: "Far", due_date: "2026-12-01" }),
    ];
    const out = planCandidates(tasks, ctx);
    expect(out.map((c) => c.task.title)).toEqual(["Late", "Soon", "Urgent", "Started"]);
    expect(out[0]?.reasons).toEqual(["Overdue 3d"]);
    expect(out[1]?.reasons).toEqual(["Due tomorrow"]);
  });

  it("stops at the limit", () => {
    const tasks = Array.from({ length: 12 }, () => task({ priority: "high" }));
    expect(planCandidates(tasks, ctx)).toHaveLength(9);
  });
});
