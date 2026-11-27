// "Plan my day" (plan section 6): candidates to pick for today, best first.

import { daysFrom } from "./dates";
import type { Task } from "./types";
import { categoryOf, isOpen, type ViewContext } from "./views";

export interface Candidate {
  task: Task;
  /** Why it is suggested, most pressing first: "Overdue 3d", "Due tomorrow", "Urgent"... */
  reasons: string[];
}

const PRIORITY_WEIGHT = { urgent: 30, high: 20, normal: 0, low: 0 } as const;

/**
 * Open tasks not yet picked for today that are overdue or due within 3 days, urgent or
 * high priority, or in progress. Ordered by how pressing they are.
 */
export function planCandidates(tasks: Iterable<Task>, ctx: ViewContext, limit = 9): Candidate[] {
  const scored: Array<Candidate & { score: number }> = [];
  for (const task of tasks) {
    if (!isOpen(task, ctx) || task.today_on === ctx.today) continue;
    const reasons: string[] = [];
    let score = 0;
    if (task.due_date !== null) {
      const days = daysFrom(ctx.today, task.due_date);
      if (days < 0) {
        reasons.push(`Overdue ${-days}d`);
        score += 50 + Math.min(-days, 30);
      } else if (days === 0) {
        reasons.push("Due today");
        score += 45;
      } else if (days <= 3) {
        reasons.push(days === 1 ? "Due tomorrow" : `Due in ${days}d`);
        score += 40 - days * 5;
      }
    }
    if (task.priority === "urgent" || task.priority === "high") {
      reasons.push(task.priority === "urgent" ? "Urgent" : "High priority");
      score += PRIORITY_WEIGHT[task.priority];
    }
    if (categoryOf(task, ctx) === "in_progress") {
      reasons.push("In progress");
      score += 15;
    }
    if (reasons.length) scored.push({ task, reasons, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || (a.task.rank < b.task.rank ? -1 : a.task.rank > b.task.rank ? 1 : 0),
  );
  return scored.slice(0, limit).map(({ task, reasons }) => ({ task, reasons }));
}
