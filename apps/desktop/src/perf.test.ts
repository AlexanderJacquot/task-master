// Performance budget (plan section 5): with 10,000 tasks, filtering and rebuilding a board
// takes under 16 ms. Opt-in (timing-sensitive): `PERF=1 pnpm --filter desktop test perf`.
import { describe, expect, it } from "vitest";
import { buildBoard } from "./lib/board";
import { rankBetween } from "./lib/rank";
import type { Priority, Task } from "./lib/types";
import { buildRows, EMPTY_FILTER, type ViewContext } from "./lib/views";
import { STATUS, statuses, task } from "./test/fixtures";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const BUDGET_MS = 16;

function median(run: () => void): number {
  for (let i = 0; i < 3; i++) run();
  const times: number[] = [];
  for (let i = 0; i < 15; i++) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] as number;
}

describe.skipIf(!env?.PERF)("10k-task budget", () => {
  const ids = Object.values(STATUS);
  const priorities: Priority[] = ["urgent", "high", "normal", "low"];
  let key: string | null = null;
  const tasks: Task[] = Array.from({ length: 10_000 }, (_, i) => {
    key = rankBetween(key, null);
    return task({
      status_id: ids[i % ids.length],
      rank: key,
      priority: priorities[i % 4],
      project_id: `p${i % 20}`,
      tag_ids: [`g${i % 10}`],
      due_date: i % 4 === 0 ? "2026-12-01" : null,
    });
  });
  const ctx: ViewContext = {
    today: "2026-11-04",
    statuses: Object.fromEntries(statuses.map((s) => [s.id, s])),
    projects: {},
  };
  const base = {
    scope: { kind: "all" as const },
    filter: EMPTY_FILTER,
    show_cancelled: false,
  };

  it("rebuilds a filtered board with swimlanes within budget", () => {
    const ms = median(() =>
      buildBoard(
        tasks,
        {
          ...base,
          filter: { ...EMPTY_FILTER, tag_ids: ["g1", "g2"] },
          swimlane: "priority",
          show_subtasks: false,
        },
        ctx,
        statuses,
        { projects: {}, epics: {} },
      ),
    );
    console.log(`board, 10k tasks: ${ms.toFixed(2)} ms (median)`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("rebuilds grouped list rows within budget", () => {
    const ms = median(() =>
      buildRows(tasks, { ...base, group_by: "due", sort: "default" }, ctx, statuses, {
        collapsedGroups: new Set(),
        collapsedTasks: new Set(),
      }),
    );
    console.log(`list rows, 10k tasks: ${ms.toFixed(2)} ms (median)`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
