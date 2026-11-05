import { addDays, atMinute } from "../../lib/calendar";
import { daysFrom, isoDate } from "../../lib/dates";
import type { Status, Task } from "../../lib/types";

export function taskMetrics(
  tasks: Task[],
  statuses: Status[],
  today: string,
  days: number,
  aiTag: string,
) {
  const start = atMinute(addDays(today, 1 - days), 0);
  const end = atMinute(addDays(today, 1), 0);
  const categories = new Map(statuses.map((s) => [s.id, s.category]));
  const live = tasks.filter((t) => t.deleted_at === null);
  const open = live.filter(
    (t) => !["done", "cancelled"].includes(categories.get(t.status_id) ?? ""),
  );
  const completed = live.filter(
    (t) =>
      categories.get(t.status_id) === "done" &&
      t.completed_at !== null &&
      t.completed_at >= start &&
      t.completed_at < end,
  );
  const created = live.filter((t) => t.created_at >= start && t.created_at < end);
  const trend = Array.from({ length: days }, (_, i) => ({
    date: addDays(today, i + 1 - days),
    created: 0,
    completed: 0,
  }));
  const buckets = new Map(trend.map((b) => [b.date, b]));
  for (const t of created) {
    const b = buckets.get(isoDate(new Date(t.created_at)));
    if (b) b.created++;
  }
  for (const t of completed) {
    const b = buckets.get(isoDate(new Date(t.completed_at as number)));
    if (b) b.completed++;
  }
  const cycleDays = completed
    .map((t) => Math.max(0, ((t.completed_at as number) - t.created_at) / 86_400_000))
    .sort((a, b) => a - b);
  const middle = Math.floor(cycleDays.length / 2);
  return {
    created: created.length,
    completed: completed.length,
    open: open.length,
    overdue: open.filter((t) => t.due_date !== null && t.due_date < today).length,
    stale: open.filter((t) => daysFrom(isoDate(new Date(t.updated_at)), today) >= 30).length,
    aiCompleted: aiTag ? completed.filter((t) => t.tag_ids.includes(aiTag)).length : null,
    medianDays: cycleDays.length
      ? ((cycleDays[middle] ?? 0) + (cycleDays[(cycleDays.length - 1) >> 1] ?? 0)) / 2
      : null,
    trend,
  };
}
