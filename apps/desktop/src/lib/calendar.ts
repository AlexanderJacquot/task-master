// Calendar model (M9, ADR 013): pure date math, the overlap layout of a day's blocks and
// what a drop on the calendar means. Days are local `YYYY-MM-DD` dates; times are Unix ms.
// Minutes within a day are computed from local wall time, so DST days stay correct.

import { isoDate } from "./dates";
import type { CalendarEvent, EventRange, Task, TimeBlock } from "./types";

export type CalendarMode = "day" | "week" | "month";

/** Height of one hour in the day and week grids. */
export const HOUR_PX = 48;
/** Drops and resizes land on quarter hours. */
export const SNAP_MIN = 15;
/** Length of a block made from a task without an estimate. */
export const DEFAULT_BLOCK_MIN = 60;
export const DAY_MIN = 24 * 60;
/** Weeks start on Monday. */
const WEEK_STARTS_ON = 1;

export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function addDays(iso: string, days: number): string {
  const date = parseIso(iso);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

export function startOfWeek(iso: string): string {
  const day = parseIso(iso).getDay();
  return addDays(iso, -((day - WEEK_STARTS_ON + 7) % 7));
}

/** The days a day or week view shows. */
export function visibleDays(mode: "day" | "week", iso: string): string[] {
  if (mode === "day") return [iso];
  const first = startOfWeek(iso);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/** Whole weeks covering the month of `iso` (4 to 6 rows of 7 days). */
export function monthWeeks(iso: string): string[][] {
  const first = `${iso.slice(0, 7)}-01`;
  const month = first.slice(0, 7);
  const weeks: string[][] = [];
  let day = startOfWeek(first);
  while (weeks.length === 0 || day.slice(0, 7) === month) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(day, i)));
    day = addDays(day, 7);
  }
  return weeks;
}

/** The same place one period earlier (-1) or later (+1). */
export function shiftPeriod(mode: CalendarMode, iso: string, direction: -1 | 1): string {
  if (mode === "day") return addDays(iso, direction);
  if (mode === "week") return addDays(iso, 7 * direction);
  const date = parseIso(`${iso.slice(0, 7)}-01`);
  date.setMonth(date.getMonth() + direction);
  return isoDate(date);
}

/** Header label: "Thursday, November 5, 2026", "Nov 2 – 8, 2026", "November 2026". */
export function periodLabel(mode: CalendarMode, iso: string): string {
  const date = parseIso(iso);
  if (mode === "day") {
    return date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
  if (mode === "month") {
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  const days = visibleDays("week", iso);
  const first = parseIso(days[0] as string);
  const last = parseIso(days[6] as string);
  const short = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${short(first)} – ${short(last)}, ${last.getFullYear()}`;
}

/** Local time for a minute of a day (minutes past 24:00 roll into the next day). */
export function atMinute(iso: string, minute: number): number {
  const date = parseIso(iso);
  date.setMinutes(minute);
  return date.getTime();
}

/** Minutes since local midnight. */
export function minuteOfDay(ms: number): number {
  const date = new Date(ms);
  return date.getHours() * 60 + date.getMinutes();
}

export function snapMinute(minute: number, step = SNAP_MIN): number {
  return Math.round(minute / step) * step;
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Hour label for the grid's gutter: "9 AM" or "09". */
export function formatHour(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric" });
}

export function formatRange(start: number, end: number): string {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

/** "45 min", "1 h", "1 h 30". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}

/** The length of a block made from this task. */
export function blockMinutes(task: Pick<Task, "estimate_min">): number {
  const estimate = task.estimate_min ?? 0;
  if (estimate <= 0) return DEFAULT_BLOCK_MIN;
  return Math.min(Math.max(snapMinute(estimate), SNAP_MIN), DAY_MIN);
}

/** Minutes spent: the sum of `done` and `worked` blocks. */
export function loggedMinutes(blocks: Iterable<TimeBlock>): number {
  let total = 0;
  for (const b of blocks) {
    if (b.outcome === "done" || b.outcome === "worked") total += (b.end_at - b.start_at) / 60_000;
  }
  return Math.round(total);
}

/** Something with a time span on the calendar (a block now; calendar events in M10). */
export interface Span {
  id: string;
  start_at: number;
  end_at: number;
}

/** The part of a span inside one day, in minutes since that day's midnight. */
export interface Segment<T extends Span> {
  item: T;
  startMin: number;
  endMin: number;
  /** Starts before this day / ends after it. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** Spans overlapping the day, clipped to it, by start. */
export function segmentsOn<T extends Span>(items: Iterable<T>, iso: string): Array<Segment<T>> {
  const dayStart = parseIso(iso).getTime();
  const dayEnd = parseIso(addDays(iso, 1)).getTime();
  const dayLength = (dayEnd - dayStart) / 60_000; // 23 or 25 hours on DST days
  const out: Array<Segment<T>> = [];
  for (const item of items) {
    if (item.end_at <= dayStart || item.start_at >= dayEnd) continue;
    const continuesBefore = item.start_at < dayStart;
    const continuesAfter = item.end_at > dayEnd;
    const startMin = continuesBefore ? 0 : minuteOfDay(item.start_at);
    const shown = (item.end_at - Math.max(item.start_at, dayStart)) / 60_000;
    out.push({
      item,
      startMin,
      endMin: continuesAfter ? DAY_MIN : Math.min(startMin + shown, dayLength, DAY_MIN),
      continuesBefore,
      continuesAfter,
    });
  }
  return out.sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin || (a.item.id < b.item.id ? -1 : 1),
  );
}

export interface Placed<T extends Span> extends Segment<T> {
  /** Column within its overlap group, from 0. */
  column: number;
  /** Columns in its overlap group. */
  columns: number;
}

/**
 * Side-by-side layout: segments that overlap, directly or through others, share the width
 * of the day; each takes the first column free at its start.
 */
export function layoutDay<T extends Span>(segments: Array<Segment<T>>): Array<Placed<T>> {
  const sorted = [...segments].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out: Array<Placed<T>> = [];
  let group: Array<Placed<T>> = [];
  let columnEnds: number[] = [];
  let groupEnd = -1;
  const close = () => {
    for (const p of group) p.columns = columnEnds.length;
    group = [];
    columnEnds = [];
  };
  for (const segment of sorted) {
    if (segment.startMin >= groupEnd) close();
    // Very short segments still take some height, so they must not share it.
    const end = Math.max(segment.endMin, segment.startMin + SNAP_MIN);
    let column = columnEnds.findIndex((e) => e <= segment.startMin);
    if (column < 0) {
      column = columnEnds.length;
      columnEnds.push(end);
    } else {
      columnEnds[column] = end;
    }
    groupEnd = Math.max(groupEnd, end);
    const placed: Placed<T> = { ...segment, column, columns: 1 };
    group.push(placed);
    out.push(placed);
  }
  close();
  return out;
}

// ---------------------------------------------------------------------------------------
// Drag and drop

/** Drag ids: a task (side list, day chips) or an existing block. */
export const dragId = {
  task: (id: string) => `task:${id}`,
  block: (id: string) => `block:${id}`,
};

/** Drop ids: a day's time column, or a whole day (all-day lane, month cell). */
export const dropId = {
  time: (iso: string) => `time:${iso}`,
  day: (iso: string) => `day:${iso}`,
};

function split(id: string): [string, string] {
  const at = id.indexOf(":");
  return [id.slice(0, at), id.slice(at + 1)];
}

/** What a drop does; `null` when nothing changes. */
export type DropAction =
  | { kind: "schedule"; taskId: string; start_at: number; end_at: number }
  | { kind: "move"; blockId: string; start_at: number; end_at: number }
  | { kind: "plan"; taskId: string; date: string };

export interface DropInput {
  active: string;
  over: string | null;
  /** For time columns: the minute of the day under the pointer. */
  pointerMinute?: number;
  /** For blocks: how far below the block's start it was grabbed, in minutes. */
  grabMinute?: number;
}

/** Turns a finished drag into the change it asks for, against the current entities. */
export function resolveDrop(
  input: DropInput,
  entities: { tasks: Record<string, Task>; time_blocks: Record<string, TimeBlock> },
): DropAction | null {
  if (!input.over) return null;
  const [what, id] = split(input.active);
  const [where, iso] = split(input.over);
  const task = what === "task" ? entities.tasks[id] : undefined;
  const block = what === "block" ? entities.time_blocks[id] : undefined;
  if (!task && !block) return null;

  if (where === "day") {
    if (task) return task.today_on === iso ? null : { kind: "plan", taskId: task.id, date: iso };
    if (!block) return null;
    // Another day, same time of day and length.
    const start_at = atMinute(iso, minuteOfDay(block.start_at));
    if (start_at === block.start_at) return null;
    return {
      kind: "move",
      blockId: block.id,
      start_at,
      end_at: start_at + (block.end_at - block.start_at),
    };
  }

  if (where !== "time" || input.pointerMinute === undefined) return null;
  const wanted = snapMinute(input.pointerMinute - (input.grabMinute ?? 0));
  const startMin = Math.min(Math.max(wanted, 0), DAY_MIN - SNAP_MIN);
  const start_at = atMinute(iso, startMin);
  if (task) {
    const end_at = start_at + blockMinutes(task) * 60_000;
    return { kind: "schedule", taskId: task.id, start_at, end_at };
  }
  if (!block || start_at === block.start_at) return null;
  const end_at = start_at + (block.end_at - block.start_at);
  return { kind: "move", blockId: block.id, start_at, end_at };
}

/** The minute of the day at `clientY` in a time column whose top is at `columnTop`. */
export function minuteAt(clientY: number, columnTop: number): number {
  return ((clientY - columnTop) / HOUR_PX) * 60;
}

/** Where "Schedule" puts a task: the next quarter hour today, 09:00 on other days. */
export function nextSlot(iso: string, now: number = Date.now()): number {
  if (iso !== isoDate(new Date(now))) return atMinute(iso, 9 * 60);
  const minute = Math.ceil((minuteOfDay(now) + 1) / SNAP_MIN) * SNAP_MIN;
  return atMinute(iso, Math.min(minute, DAY_MIN - SNAP_MIN));
}

// ---------------------------------------------------------------------------------------
// Events of the user's calendars (M10, ADR 014): read-only, shown beside blocks.

/** The span a view shows, as the core's `calendar_events` takes it. */
export function viewRange(mode: CalendarMode, iso: string): EventRange {
  const days = mode === "month" ? monthWeeks(iso).flat() : visibleDays(mode, iso);
  const first = days[0] ?? iso;
  const after = addDays(days[days.length - 1] ?? iso, 1);
  return {
    from: parseIso(first).getTime(),
    to: parseIso(after).getTime(),
    from_date: first,
    to_date: after,
  };
}

/** A timed event placed like a block. */
export interface EventSpan extends Span {
  event: CalendarEvent;
}

export function timedSpans(events: CalendarEvent[]): EventSpan[] {
  const out: EventSpan[] = [];
  for (const event of events) {
    if (event.start_at === null || event.end_at === null) continue;
    out.push({
      id: `event:${event.calendar_id}:${event.id}`,
      start_at: event.start_at,
      end_at: event.end_at,
      event,
    });
  }
  return out;
}

/** All-day events covering a day (their end date is exclusive). */
export function allDayOn(events: CalendarEvent[], iso: string): CalendarEvent[] {
  return events.filter(
    (e) => e.start_date !== null && e.end_date !== null && e.start_date <= iso && iso < e.end_date,
  );
}
