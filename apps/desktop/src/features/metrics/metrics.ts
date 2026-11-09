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

/** When a live task left the open workload, or null while it is open. Done tasks use their
 *  completion time; cancelled ones (which keep no completion time) their last update. */
function closedAt(t: Task, category: string | undefined): number | null {
  if (category === "done") return t.completed_at ?? t.updated_at;
  if (category === "cancelled") return t.updated_at;
  return null;
}

/**
 * Open tasks at the end of each day of the period (a burn-down), with the pace it moves at.
 * `before` is the open count when the period began; `netPerDay` is how many open tasks the
 * period removed per day (negative when the backlog grew); `clearInDays` projects that pace
 * to zero (0 when nothing is open), or is null when the backlog is not shrinking.
 */
export function burnDown(tasks: Task[], statuses: Status[], today: string, days: number) {
  const categories = new Map(statuses.map((s) => [s.id, s.category]));
  const spans = tasks
    .filter((t) => t.deleted_at === null)
    .map((t) => ({ from: t.created_at, to: closedAt(t, categories.get(t.status_id)) }));
  const openAt = (instant: number) =>
    spans.filter((s) => s.from < instant && (s.to === null || s.to >= instant)).length;
  const before = openAt(atMinute(addDays(today, 1 - days), 0));
  const points = Array.from({ length: days }, (_, i) => {
    const date = addDays(today, i + 1 - days);
    return { date, open: openAt(atMinute(addDays(date, 1), 0)) };
  });
  const now = points.at(-1)?.open ?? before;
  const netPerDay = (before - now) / days;
  let clearInDays: number | null = null;
  if (now === 0) clearInDays = 0;
  else if (before > now) clearInDays = Math.ceil((now * days) / (before - now));
  return {
    before,
    now,
    peak: Math.max(before, ...points.map((p) => p.open)),
    points,
    netPerDay,
    clearInDays,
  };
}
