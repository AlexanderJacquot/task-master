// Replanning a block that did not finish its task (ADR 013): where "Later today" and
// "Tomorrow" put the next block. Pure: the free time comes from the planner's
// `freeSlots`, within the working hours set in Plan mode.

import { addDays, atMinute, parseIso, SNAP_MIN, type Span } from "./calendar";
import { freeSlots, type PlanHours } from "./planner";
import type { Task, TimeBlock } from "./types";

export interface ReplanInput {
  today: string;
  now: number;
  hours: PlanHours;
  blocks: TimeBlock[];
  events: Span[];
  /** Length of the new block. */
  minutes: number;
}

export interface ReplanSlot {
  iso: string;
  start_at: number;
  end_at: number;
}

/** How many days ahead "Tomorrow" looks for a working day with room. */
const LOOKAHEAD_DAYS = 14;

/** The first free stretch of `minutes` on `iso`, within working hours and after now. */
export function firstFit(input: ReplanInput, iso: string): ReplanSlot | null {
  const length = Math.max(input.minutes, SNAP_MIN) * 60_000;
  const slot = freeSlots({ ...input, days: [iso] }).find((s) => s.end - s.start >= length);
  return slot ? { iso, start_at: slot.start, end_at: slot.start + length } : null;
}

/** "Later today": the first free stretch left today, or null when none fits. */
export function laterToday(input: ReplanInput): ReplanSlot | null {
  return firstFit(input, input.today);
}

/** "Tomorrow": the first working day after today with a free stretch (weekends per hours). */
export function nextWorkday(input: ReplanInput): ReplanSlot | null {
  for (let d = 1; d <= LOOKAHEAD_DAYS; d++) {
    const iso = addDays(input.today, d);
    const weekday = parseIso(iso).getDay();
    if (!input.hours.weekends && (weekday === 0 || weekday === 6)) continue;
    const slot = firstFit(input, iso);
    if (slot) return slot;
  }
  return null;
}

/** "Tomorrow" for the next day, else the weekday's name ("Monday"), for a slot's label. */
export function dayLabel(iso: string, today: string): string {
  if (iso === addDays(today, 1)) return "Tomorrow";
  return parseIso(iso).toLocaleDateString(undefined, { weekday: "long" });
}

/** How far back the daily review looks for blocks left as planned. */
export const REVIEW_DAYS = 7;

/**
 * Blocks to review: ended, still `planned` (no outcome given), of a live task, and started
 * within the last week (today included). Oldest first.
 */
export function blocksToReview(
  blocks: Iterable<TimeBlock>,
  tasks: Record<string, Task>,
  today: string,
  now: number,
): TimeBlock[] {
  const since = atMinute(addDays(today, -(REVIEW_DAYS - 1)), 0);
  const due: TimeBlock[] = [];
  for (const b of blocks) {
    if (b.deleted_at !== null || b.outcome !== "planned") continue;
    if (b.end_at > now || b.start_at < since) continue;
    const task = tasks[b.task_id];
    if (!task || task.deleted_at !== null) continue;
    due.push(b);
  }
  return due.sort((a, b) => a.start_at - b.start_at);
}
