// The Roadmap's time arithmetic (ADR 030): calendar days as whole numbers, bars from due
// dates and the roadmap's own starts, the visible range, the scale's ticks, and the rows.

import type { Epic, Project, RoadmapGroup, RoadmapZoom, Task } from "../../lib/types";
import { FILTER_NONE } from "../../lib/views";

export type Zoom = RoadmapZoom;
export type Group = RoadmapGroup;

/** Pixels per day at each zoom. */
export const DAY_WIDTH: Record<Zoom, number> = { day: 40, week: 18, month: 5, quarter: 2 };

const MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01 for a `YYYY-MM-DD` date (UTC, so no daylight-saving drift). */
export function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / MS_PER_DAY);
}

export function isoOf(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return isoOf(dayNumber(iso) + days);
}

/** 0 is Sunday, 6 is Saturday. 1970-01-01 was a Thursday. */
export function weekday(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

export function isWeekend(day: number): boolean {
  const d = weekday(day);
  return d === 0 || d === 6;
}

/** Working days an estimate takes, at eight hours a day; at least one. */
export function estimateDays(minutes: number | null | undefined): number {
  return Math.max(1, Math.ceil((minutes ?? 0) / 480));
}

/** The day `count` working days away (weekends skipped); `count` 0 is the day itself. */
export function addWorkingDays(iso: string, count: number): string {
  let day = dayNumber(iso);
  const step = count < 0 ? -1 : 1;
  for (let left = Math.abs(count); left > 0; ) {
    day += step;
    if (!isWeekend(day)) left--;
  }
  return isoOf(day);
}

/** The earlier of two `YYYY-MM-DD` dates (they sort as text; `Math.min` would not). */
export function earlier(a: string, b: string): string {
  if (b < a) return b;
  return a;
}

/** The later of two `YYYY-MM-DD` dates. */
export function later(a: string, b: string): string {
  if (b > a) return b;
  return a;
}

/** A bar: from its first day to its last, both included. */
export type Bar = { start: string; end: string };

/**
 * A task's bar: it ends on the due date and starts on the roadmap's start for it, or as
 * many working days earlier as its estimate takes. A start after the end is pulled back to
 * the end (the due date moved earlier elsewhere). No due date, no bar.
 */
export function barOf(task: Task, starts: Readonly<Record<string, string>>): Bar | null {
  const end = task.due_date;
  if (!end) return null;
  const start = starts[task.id] ?? addWorkingDays(end, -(estimateDays(task.estimate_min) - 1));
  return { start: earlier(start, end), end };
}

/** A new bar for an unscheduled task, starting on `start` and as long as its estimate. */
export function newBar(task: Task, start: string): Bar {
  return { start, end: addWorkingDays(start, estimateDays(task.estimate_min) - 1) };
}

/** The bar moved by `days`, or one of its ends moved (never past the other end). */
export function shiftBar(bar: Bar, mode: "move" | "start" | "end", days: number): Bar {
  if (mode === "move") return { start: addDays(bar.start, days), end: addDays(bar.end, days) };
  if (mode === "start") {
    const start = addDays(bar.start, days);
    return { start: earlier(start, bar.end), end: bar.end };
  }
  const end = addDays(bar.end, days);
  return { start: bar.start, end: later(end, bar.start) };
}

/** The bar drawn from one day to another, in either direction. */
export function spanBetween(a: string, b: string): Bar {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** The days the timeline shows: every bar and date, today, and some room on both sides. */
export type Range = { from: string; days: number };

const PAD: Record<Zoom, number> = { day: 7, week: 21, month: 60, quarter: 120 };
const MIN_DAYS: Record<Zoom, number> = { day: 42, week: 120, month: 400, quarter: 800 };

export function rangeOf(dates: Iterable<string>, today: string, zoom: Zoom): Range {
  let first = dayNumber(today);
  let last = first;
  for (const iso of dates) {
    const day = dayNumber(iso);
    if (day < first) first = day;
    if (day > last) last = day;
  }
  first -= PAD[zoom];
  last += PAD[zoom];
  if (last - first + 1 < MIN_DAYS[zoom]) {
    // Keep today a third of the way in when there is little to show.
    const extra = MIN_DAYS[zoom] - (last - first + 1);
    first -= Math.floor(extra / 3);
    last += extra - Math.floor(extra / 3);
  }
  // Start on a Monday (day and week zooms) or the first of a month (month and quarter).
  if (zoom === "day" || zoom === "week") first -= (weekday(first) + 6) % 7;
  else first = dayNumber(`${isoOf(first).slice(0, 7)}-01`);
  return { from: isoOf(first), days: last - first + 1 };
}

/** A labelled stretch of the scale, in days from the range's start. */
export type Tick = { key: string; label: string; offset: number; length: number };

function utc(day: number): Date {
  return new Date(day * MS_PER_DAY);
}
function label(day: number, options: Intl.DateTimeFormatOptions): string {
  return utc(day).toLocaleDateString(undefined, { ...options, timeZone: "UTC" });
}

/** Splits the range wherever `key` changes; `name` labels each piece. */
function split(range: Range, key: (day: number) => string, name: (day: number) => string) {
  const from = dayNumber(range.from);
  const out: Tick[] = [];
  for (let i = 0; i < range.days; i++) {
    const day = from + i;
    const k = key(day);
    const last = out.at(-1);
    if (last && last.key === k) last.length++;
    else out.push({ key: k, label: name(day), offset: i, length: 1 });
  }
  return out;
}

/** Two rows of labels: the coarse one above (months or years), the fine one below. */
export function ticksOf(range: Range, zoom: Zoom): { top: Tick[]; bottom: Tick[] } {
  const month = (day: number) => isoOf(day).slice(0, 7);
  const year = (day: number) => isoOf(day).slice(0, 4);
  const monday = (day: number) => isoOf(day - ((weekday(day) + 6) % 7));
  const quarter = (day: number) => `${year(day)}-Q${Math.floor((utc(day).getUTCMonth() + 3) / 3)}`;
  switch (zoom) {
    case "day":
      return {
        top: split(range, month, (d) => label(d, { month: "long", year: "numeric" })),
        bottom: split(range, isoOf, (d) => String(utc(d).getUTCDate())),
      };
    case "week":
      return {
        top: split(range, month, (d) => label(d, { month: "short", year: "numeric" })),
        bottom: split(range, monday, (d) => String(utc(d).getUTCDate())),
      };
    case "month":
      return {
        top: split(range, year, year),
        bottom: split(range, month, (d) => label(d, { month: "short" })),
      };
    case "quarter":
      return {
        top: split(range, year, year),
        bottom: split(range, quarter, (d) => quarter(d).slice(5)),
      };
  }
}

/** One line of the roadmap: a group's header, or a task. */
export type Row =
  | {
      kind: "group";
      key: string;
      label: string;
      color: string | null;
      /** Tasks under it (scheduled or not), shown or folded. */
      count: number;
      collapsed: boolean;
      /** From the first bar's start to the last bar's end. */
      span: Bar | null;
      /** The epic it stands for, whose target date is its milestone. */
      epic: Epic | null;
    }
  | { kind: "task"; task: Task; bar: Bar | null; group: string };

type Groupable = { id: string; name: string; color: string | null; rank: string };

/**
 * The rows: tasks under their epic or project (by rank, "none" last), each group's tasks
 * by start then rank, unscheduled ones last. A folded group keeps its header only.
 */
export function rowsOf(
  tasks: Task[],
  bars: ReadonlyMap<string, Bar>,
  group: Group,
  epics: Readonly<Record<string, Epic>>,
  projects: Readonly<Record<string, Project>>,
  collapsed: ReadonlySet<string>,
): Row[] {
  const order = (a: Task, b: Task) => {
    const x = bars.get(a.id);
    const y = bars.get(b.id);
    if (x && y && x.start !== y.start) return x.start < y.start ? -1 : 1;
    if (!!x !== !!y) return x ? -1 : 1;
    return a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id);
  };
  const taskRow = (task: Task, key: string): Row => ({
    kind: "task",
    task,
    bar: bars.get(task.id) ?? null,
    group: key,
  });
  if (group === "none") return [...tasks].sort(order).map((task) => taskRow(task, ""));

  const keyOf = (task: Task) => (group === "epic" ? task.epic_id : task.project_id) ?? FILTER_NONE;
  const members = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = keyOf(task);
    members.set(key, [...(members.get(key) ?? []), task]);
  }
  const owners: Record<string, Groupable | undefined> = group === "epic" ? epics : projects;
  const keys = [...members.keys()].sort((a, b) => {
    if (a === FILTER_NONE || b === FILTER_NONE) return a === FILTER_NONE ? 1 : -1;
    return (owners[a]?.rank ?? "").localeCompare(owners[b]?.rank ?? "") || a.localeCompare(b);
  });
  const rows: Row[] = [];
  for (const key of keys) {
    const list = (members.get(key) ?? []).sort(order);
    const spans = list.flatMap((task) => bars.get(task.id) ?? []);
    const owner = owners[key];
    rows.push({
      kind: "group",
      key,
      label: owner?.name ?? (group === "epic" ? "No epic" : "No project"),
      color: owner?.color ?? null,
      count: list.length,
      collapsed: collapsed.has(key),
      span: spans.length
        ? {
            start: spans.map((bar) => bar.start).reduce(earlier),
            end: spans.map((bar) => bar.end).reduce(later),
          }
        : null,
      epic: group === "epic" ? (epics[key] ?? null) : null,
    });
    if (!collapsed.has(key)) for (const task of list) rows.push(taskRow(task, key));
  }
  return rows;
}

/** A dependency arrow between two shown bars; `late` when the dependent starts too early. */
export type Link = { from: string; to: string; late: boolean };

/** Links between bars on the roadmap: a prerequisite should end before its dependent starts. */
export function linksOf(tasks: Task[], bars: ReadonlyMap<string, Bar>): Link[] {
  const links: Link[] = [];
  for (const task of tasks) {
    const to = bars.get(task.id);
    if (!to) continue;
    for (const id of task.dependency_ids ?? []) {
      const from = bars.get(id);
      if (from) links.push({ from: id, to: task.id, late: to.start <= from.end });
    }
  }
  return links;
}
