// The Roadmap's time arithmetic (ADR 031): calendar days as whole numbers, bars from due
// dates and the roadmap's own starts, the visible range, the scale's ticks, and the rows.
// The core has a port of the bars, rows and links (`crates/core/src/roadmap.rs`, for the
// sync server's images, ADR 035): both pass `crates/core/test-vectors/roadmap.json`.

import type { Epic, RoadmapGroup, RoadmapZoom, Task } from "../../lib/types";
import { compareStrings, FILTER_NONE } from "../../lib/views";

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

/** What a bar stands for: an epic on the roadmap, or a task on an epic's timeline. */
export type Item = {
  id: string;
  title: string;
  rank: string;
  bar: Bar | null;
  /** Working days a bar drawn with one click takes. */
  length: number;
  /** A done task, or an epic that is done or dropped. */
  done: boolean;
  /** The share of an epic's tasks that are done, 0 to 1; `null` for a task. */
  progress: number | null;
  color: string | null;
  /** Where it is listed: a project id, `FILTER_NONE`, or "" without groups. */
  group: string;
  /** A subtask's parent, when it is on the timeline too. */
  parent: string | null;
  /** What it waits on: a task's prerequisites, or the epics an epic's tasks wait on. */
  after: string[];
  /** An epic's tasks, from the first start to the last end: a guide while it has no bar. */
  span: Bar | null;
};

/** Working days a new epic bar takes, and how early an epic without tasks starts. */
export const EPIC_DAYS = 10;

export function taskItem(task: Task, bar: Bar | null, done: boolean): Item {
  return {
    id: task.id,
    title: task.title,
    rank: task.rank,
    bar,
    length: estimateDays(task.estimate_min),
    done,
    progress: null,
    color: null,
    group: "",
    parent: task.parent_id,
    after: [...(task.dependency_ids ?? [])],
    span: null,
  };
}

/**
 * An epic's bar: it ends on its target date and starts on the roadmap's start for it, else
 * where its earliest task starts, else two working weeks before. No target date, no bar.
 */
export function epicBar(
  epic: Epic,
  starts: Readonly<Record<string, string>>,
  taskBars: Bar[],
): Bar | null {
  const end = epic.target_date;
  if (!end) return null;
  const first = taskBars.length ? taskBars.map((bar) => bar.start).reduce(earlier) : null;
  const start = starts[epic.id] ?? first ?? addWorkingDays(end, -(EPIC_DAYS - 1));
  return { start: earlier(start, end), end };
}

/**
 * The epics as roadmap items: their bars, their progress (done tasks out of the ones not
 * cancelled), and which epics they wait on, from their tasks' prerequisites in other epics.
 */
export function epicItems(
  epics: Epic[],
  tasks: Task[],
  starts: Readonly<Record<string, string>>,
  status: { done: ReadonlySet<string>; cancelled: ReadonlySet<string> },
  groupOf: (epic: Epic) => string,
): Item[] {
  const shown = new Set(epics.map((epic) => epic.id));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const members = new Map<string, Task[]>();
  const after = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!task.epic_id || !shown.has(task.epic_id)) continue;
    members.set(task.epic_id, [...(members.get(task.epic_id) ?? []), task]);
    for (const id of task.dependency_ids ?? []) {
      const other = byId.get(id)?.epic_id;
      if (other && other !== task.epic_id && shown.has(other))
        after.set(task.epic_id, (after.get(task.epic_id) ?? new Set()).add(other));
    }
  }
  return epics.map((epic) => {
    const list = (members.get(epic.id) ?? []).filter((task) => !status.cancelled.has(task.id));
    const done = list.filter((task) => status.done.has(task.id)).length;
    const bars = list.flatMap((task) => barOf(task, starts) ?? []);
    return {
      id: epic.id,
      title: epic.name,
      rank: epic.rank,
      bar: epicBar(epic, starts, bars),
      length: EPIC_DAYS,
      done: epic.state !== "active",
      progress: list.length ? done / list.length : 0,
      color: epic.color,
      group: groupOf(epic),
      parent: null,
      after: [...(after.get(epic.id) ?? [])].sort(),
      span: bars.length
        ? {
            start: bars.map((bar) => bar.start).reduce(earlier),
            end: bars.map((bar) => bar.end).reduce(later),
          }
        : null,
    };
  });
}

/** One line of the roadmap: a group's header, or an epic or task. */
export type Row =
  | {
      kind: "group";
      key: string;
      label: string;
      color: string | null;
      /** Items under it (scheduled or not), shown or folded. */
      count: number;
      collapsed: boolean;
      /** From the first bar's start to the last bar's end. */
      span: Bar | null;
    }
  | { kind: "item"; item: Item; depth: number };

/** Scheduled items first, by start, then by rank. */
function byStart(a: Item, b: Item): number {
  if (a.bar && b.bar && a.bar.start !== b.bar.start) return a.bar.start < b.bar.start ? -1 : 1;
  if (!!a.bar !== !!b.bar) return a.bar ? -1 : 1;
  return compareStrings(a.rank, b.rank) || compareStrings(a.id, b.id);
}

/** Items in order, each followed by its subtasks (one level indented, deeper ones too). */
function nested(items: Item[]): Row[] {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string, Item[]>();
  const top: Item[] = [];
  for (const item of items) {
    if (item.parent && ids.has(item.parent))
      children.set(item.parent, [...(children.get(item.parent) ?? []), item]);
    else top.push(item);
  }
  const rows: Row[] = [];
  const seen = new Set<string>();
  const add = (item: Item, depth: number) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    rows.push({ kind: "item", item, depth });
    for (const child of (children.get(item.id) ?? []).sort(byStart)) add(child, depth + 1);
  };
  for (const item of top.sort(byStart)) add(item, 0);
  return rows;
}

type Groupable = { name: string; color: string | null; rank: string };

/**
 * The rows: items under their group (by the owner's rank, "none" last) or in one list,
 * each list by start then rank, unscheduled ones last. A folded group keeps its header.
 */
export function rowsOf(
  items: Item[],
  owners: Readonly<Record<string, Groupable | undefined>> | null,
  noneLabel: string,
  collapsed: ReadonlySet<string>,
): Row[] {
  if (!owners) return nested(items);
  const members = new Map<string, Item[]>();
  for (const item of items) members.set(item.group, [...(members.get(item.group) ?? []), item]);
  const keys = [...members.keys()].sort((a, b) => {
    if (a === FILTER_NONE || b === FILTER_NONE) return a === FILTER_NONE ? 1 : -1;
    return compareStrings(owners[a]?.rank ?? "", owners[b]?.rank ?? "") || compareStrings(a, b);
  });
  const rows: Row[] = [];
  for (const key of keys) {
    const list = members.get(key) ?? [];
    const spans = list.flatMap((item) => item.bar ?? []);
    rows.push({
      kind: "group",
      key,
      label: owners[key]?.name ?? noneLabel,
      color: owners[key]?.color ?? null,
      count: list.length,
      collapsed: collapsed.has(key),
      span: spans.length
        ? {
            start: spans.map((bar) => bar.start).reduce(earlier),
            end: spans.map((bar) => bar.end).reduce(later),
          }
        : null,
    });
    if (!collapsed.has(key)) rows.push(...nested(list));
  }
  return rows;
}

/** A dependency arrow between two shown bars; `late` when the dependent starts too early. */
export type Link = { from: string; to: string; late: boolean };

/** Links between bars: what an item waits on should end before it starts. */
export function linksOf(items: Item[]): Link[] {
  const bars = new Map(items.flatMap((item) => (item.bar ? [[item.id, item.bar] as const] : [])));
  const links: Link[] = [];
  for (const item of items) {
    if (!item.bar) continue;
    for (const id of item.after) {
      const from = bars.get(id);
      if (from) links.push({ from: id, to: item.id, late: item.bar.start <= from.end });
    }
  }
  return links;
}
