// The calendar's planner: suggests time blocks that fill the free time of a day or a week
// with open tasks of a focus (a project, an epic, a status). Pure: the page passes the
// entities, the shown days, the clock and a random source, and approves the result as one
// batch of `create_time_block` commands.

import {
  addDays,
  atMinute,
  blockMinutes,
  DAY_MIN,
  holdsTime,
  parseIso,
  SNAP_MIN,
  type Span,
} from "./calendar";
import type { Priority, Status, Task, TimeBlock } from "./types";

/** Which tasks a plan draws from; `null` means any. */
export interface PlanFocus {
  /** A project id, or `"inbox"` for tasks without a project. */
  projectId: string | null;
  epicId: string | null;
  /** An open status; `null` is any open status. */
  statusId: string | null;
}

/** The part of each day a plan may fill, in minutes since midnight. */
export interface PlanHours {
  startMin: number;
  endMin: number;
  /** Plan Saturdays and Sundays too (week view; a shown single day is always planned). */
  weekends: boolean;
}

export const DEFAULT_FOCUS: PlanFocus = { projectId: null, epicId: null, statusId: null };
export const DEFAULT_HOURS: PlanHours = { startMin: 9 * 60, endMin: 17 * 60, weekends: false };

/** A suggested block, not yet written. `id` is a local key. */
export interface ProposedBlock extends Span {
  task_id: string;
}

export interface Plan {
  blocks: ProposedBlock[];
  /** Candidates left out: no free time was left for them. */
  unplaced: string[];
}

export interface PlanInput {
  days: string[];
  now: number;
  hours: PlanHours;
  focus: PlanFocus;
  tasks: Task[];
  statuses: Record<string, Status>;
  blocks: TimeBlock[];
  /** Timed events of the user's calendars, as busy time. */
  events: Span[];
  /** Returns a number in [0, 1). */
  random(): number;
}

/** Long tasks may be split across free slots, in pieces no shorter than this. */
const MIN_PIECE = 30;

const PRIORITY_WEIGHT: Record<Priority, number> = { urgent: 8, high: 4, normal: 2, low: 1 };

function isOpenTask(task: Task, statuses: Record<string, Status>): boolean {
  const category = statuses[task.status_id]?.category;
  return category !== "done" && category !== "cancelled";
}

export function matchesFocus(task: Task, focus: PlanFocus): boolean {
  if (
    focus.projectId === "inbox"
      ? task.project_id !== null
      : focus.projectId !== null && task.project_id !== focus.projectId
  )
    return false;
  if (focus.epicId !== null && task.epic_id !== focus.epicId) return false;
  if (focus.statusId !== null && task.status_id !== focus.statusId) return false;
  return true;
}

/**
 * Tasks a plan may place: the user's open tasks in the focus that are not on the
 * calendar from now on, and that have no open subtasks (the work is in those).
 */
export function planCandidates(
  input: Pick<PlanInput, "tasks" | "statuses" | "blocks" | "focus" | "now">,
): Task[] {
  const { tasks, statuses, blocks, focus, now } = input;
  const scheduled = new Set<string>();
  for (const b of blocks) {
    if (holdsTime(b) && b.end_at > now) scheduled.add(b.task_id);
  }
  const withOpenChildren = new Set<string>();
  for (const t of tasks) {
    if (t.parent_id && t.deleted_at === null && isOpenTask(t, statuses))
      withOpenChildren.add(t.parent_id);
  }
  return tasks.filter(
    (t) =>
      t.deleted_at === null &&
      t.owner !== "agent" &&
      isOpenTask(t, statuses) &&
      matchesFocus(t, focus) &&
      !scheduled.has(t.id) &&
      !withOpenChildren.has(t.id),
  );
}

interface Slot {
  iso: string;
  start: number;
  end: number;
}

const MS = 60_000;

/** Days the plan fills: shown, not past, and weekdays unless weekends are on. */
function planDays(days: string[], hours: PlanHours, now: number): string[] {
  return days.filter((iso) => {
    if (atMinute(iso, hours.endMin) <= now) return false;
    if (days.length === 1 || hours.weekends) return true;
    const weekday = parseIso(iso).getDay();
    return weekday !== 0 && weekday !== 6;
  });
}

/** Free time within working hours, from now on, around blocks and events, on quarter hours. */
export function freeSlots(
  input: Pick<PlanInput, "days" | "hours" | "now" | "blocks" | "events">,
): Slot[] {
  const { hours, now } = input;
  const busy: Span[] = [...input.blocks.filter(holdsTime), ...input.events].sort(
    (a, b) => a.start_at - b.start_at,
  );
  const quarter = SNAP_MIN * MS;
  const slots: Slot[] = [];
  for (const iso of planDays(input.days, hours, now)) {
    const startMin = Math.max(Math.min(hours.startMin, DAY_MIN), 0);
    const endMin = Math.max(Math.min(hours.endMin, DAY_MIN), startMin);
    let cursor = Math.max(atMinute(iso, startMin), Math.ceil(now / quarter) * quarter);
    const end = atMinute(iso, endMin);
    const push = (from: number, to: number) => {
      const a = Math.ceil(from / quarter) * quarter;
      const b = Math.floor(to / quarter) * quarter;
      if (b - a >= quarter) slots.push({ iso, start: a, end: b });
    };
    for (const span of busy) {
      if (span.end_at <= cursor || span.start_at >= end) continue;
      if (span.start_at > cursor) push(cursor, span.start_at);
      cursor = Math.max(cursor, span.end_at);
      if (cursor >= end) break;
    }
    if (cursor < end) push(cursor, end);
  }
  return slots;
}

export function freeMinutes(slots: Slot[]): number {
  return slots.reduce((sum, s) => sum + (s.end - s.start) / MS, 0);
}

/** How strongly a task asks to be planned now. */
export function planWeight(task: Task, input: Pick<PlanInput, "days" | "statuses">): number {
  const first = input.days[0] ?? "";
  const last = input.days[input.days.length - 1] ?? first;
  let weight = PRIORITY_WEIGHT[task.priority] ?? 1;
  if (input.statuses[task.status_id]?.category === "in_progress") weight *= 3;
  if (task.today_on !== null && task.today_on <= last) weight *= 3;
  if (task.due_date !== null) {
    if (task.due_date < first) weight *= 4;
    else if (task.due_date <= last) weight *= 3;
    else if (task.due_date <= addDays(last, 7)) weight *= 1.5;
  }
  return weight;
}

/**
 * A weighted random order (each task's key is u^(1/w): heavier tasks tend to come first),
 * then moved so that a task's prerequisites among the candidates come before it.
 */
function planOrder(candidates: Task[], input: PlanInput, open: Set<string>): Task[] {
  const ids = new Set(candidates.map((t) => t.id));
  const keyed = candidates.map((task) => {
    let weight = planWeight(task, input);
    // Waiting on open work that this plan does not include: later, if at all.
    if (task.dependency_ids.some((d) => open.has(d) && !ids.has(d))) weight *= 0.25;
    const u = Math.min(Math.max(input.random(), 1e-9), 1);
    return { task, key: u ** (1 / weight) };
  });
  keyed.sort((a, b) => b.key - a.key || (a.task.id < b.task.id ? -1 : 1));
  const order = keyed.map((k) => k.task);

  const out: Task[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const byId = new Map(order.map((t) => [t.id, t]));
  const visit = (task: Task) => {
    if (placed.has(task.id) || visiting.has(task.id)) return; // a cycle keeps its order
    visiting.add(task.id);
    for (const dep of task.dependency_ids) {
      const before = byId.get(dep);
      if (before) visit(before);
    }
    visiting.delete(task.id);
    placed.add(task.id);
    out.push(task);
  };
  for (const task of order) visit(task);
  return out;
}

/** How a plan spreads over its days: minutes placed per day, and each day's share. */
interface Load {
  placed: Map<string, number>;
  share: number;
}

/**
 * Takes `minutes` from the first fitting slot of a day still under its share (else of any
 * day), or splits it over several slots; null if there is no room.
 */
function take(
  slots: Slot[],
  minutes: number,
  lastDay: string | null,
  load: Load,
): Array<[number, number]> | null {
  const usable = (s: Slot) => lastDay === null || s.iso <= lastDay;
  const length = minutes * MS;
  const underShare = (s: Slot) => {
    const placed = load.placed.get(s.iso) ?? 0;
    return placed === 0 || placed + minutes <= load.share;
  };
  const fits = (s: Slot) => usable(s) && s.end - s.start >= length;
  const whole = slots.find((s) => fits(s) && underShare(s)) ?? slots.find(fits);
  if (whole) {
    const piece: [number, number] = [whole.start, whole.start + length];
    whole.start += length;
    load.placed.set(whole.iso, (load.placed.get(whole.iso) ?? 0) + minutes);
    return [piece];
  }
  if (minutes <= MIN_PIECE * 2) return null;
  const pieces = slots.filter((s) => usable(s) && s.end - s.start >= MIN_PIECE * MS);
  const room = pieces.reduce((sum, s) => sum + (s.end - s.start), 0);
  if (room < length) return null;
  const uses: Array<[Slot, number]> = [];
  let left = length;
  for (const s of pieces) {
    if (left <= 0) break;
    let use = Math.min(s.end - s.start, left);
    // Never leave a remainder too short to be a piece of its own.
    if (left - use > 0 && left - use < MIN_PIECE * MS) use = left - MIN_PIECE * MS;
    if (use < MIN_PIECE * MS) continue;
    uses.push([s, use]);
    left -= use;
  }
  if (left > 0) return null;
  return uses.map(([s, use]) => {
    const piece: [number, number] = [s.start, s.start + use];
    s.start += use;
    load.placed.set(s.iso, (load.placed.get(s.iso) ?? 0) + use / MS);
    return piece;
  });
}

/**
 * Suggests blocks for the shown days: candidates in weighted random order, each in the
 * earliest free slot that fits it (on or before its due date when that is shown), long
 * tasks split across slots when no single slot fits. When the tasks need less than the
 * free time, each day gets about an equal share, so a week's plan is spread over it.
 */
export function suggestPlan(input: PlanInput): Plan {
  const slots = freeSlots(input);
  const candidates = planCandidates(input);
  const open = new Set(
    input.tasks
      .filter((t) => t.deleted_at === null && isOpenTask(t, input.statuses))
      .map((t) => t.id),
  );
  const blocks: ProposedBlock[] = [];
  const unplaced: string[] = [];
  const first = input.days[0] ?? "";
  const demand = candidates.reduce((sum, t) => sum + blockMinutes(t), 0);
  const dayCount = new Set(slots.map((s) => s.iso)).size || 1;
  const load: Load = {
    placed: new Map(),
    share: Math.ceil(demand / dayCount / SNAP_MIN) * SNAP_MIN,
  };
  for (const task of planOrder(candidates, input, open)) {
    const minutes = blockMinutes(task);
    const due = task.due_date !== null && task.due_date >= first ? task.due_date : null;
    const pieces = (due && take(slots, minutes, due, load)) || take(slots, minutes, null, load);
    if (!pieces) {
      unplaced.push(task.id);
      continue;
    }
    for (const [start_at, end_at] of pieces) {
      blocks.push({ id: `${task.id}@${start_at}`, task_id: task.id, start_at, end_at });
    }
  }
  blocks.sort((a, b) => a.start_at - b.start_at);
  return { blocks, unplaced };
}

/** A small seeded random source, for tests and repeatable plans. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
