// The work timers: one per task, several can run at once, remembered in localStorage so
// they survive a restart. Stopping one logs the time as `worked` time blocks (ADR 013), so
// logged time stays the sum of done and worked blocks and shows on the calendar.

import { useSyncExternalStore } from "react";
import type { TimeBlock } from "./types";

export interface RunningTimer {
  task_id: string;
  /** Unix ms. */
  started_at: number;
  /** The agent session this timer follows: it stops when that session ends. */
  session_id?: string;
}

export interface LoggedSpan {
  start_at: number;
  end_at: number;
}

export const TIMER_KEY = "task-master.timers";
/** The single-timer key of earlier versions, read once and migrated. */
const LEGACY_KEY = "task-master.timer";
/** Shorter runs are dropped on stop (a timer started by mistake). */
export const MIN_LOGGED_MS = 60_000;
/** A block lasts at most 24 hours (core rule), so longer runs are split. */
export const MAX_BLOCK_MS = 24 * 60 * 60_000;

function parseTimer(v: Partial<RunningTimer> | null): RunningTimer | null {
  if (v && typeof v.task_id === "string" && typeof v.started_at === "number") {
    const timer: RunningTimer = { task_id: v.task_id, started_at: v.started_at };
    if (typeof v.session_id === "string") timer.session_id = v.session_id;
    return timer;
  }
  return null;
}

function load(): RunningTimer[] {
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    if (raw) {
      const list = JSON.parse(raw) as unknown;
      if (!Array.isArray(list)) return [];
      const seen = new Set<string>();
      const timers: RunningTimer[] = [];
      for (const v of list) {
        const t = parseTimer(v);
        if (t && !seen.has(t.task_id)) {
          seen.add(t.task_id);
          timers.push(t);
        }
      }
      return timers;
    }
    const old = localStorage.getItem(LEGACY_KEY);
    if (old) {
      const t = parseTimer(JSON.parse(old));
      return t ? [t] : [];
    }
  } catch {
    // Unreadable: no timers.
  }
  return [];
}

let current: RunningTimer[] | undefined;
const listeners = new Set<() => void>();

/** The running timers, one per task, oldest first. Same array until they change. */
export function getTimers(): RunningTimer[] {
  if (current === undefined) current = load();
  return current;
}

/** The timer running on a task, if any. */
export function timerOf(taskId: string): RunningTimer | null {
  return getTimers().find((t) => t.task_id === taskId) ?? null;
}

export function setTimers(timers: RunningTimer[]) {
  current = timers;
  try {
    localStorage.removeItem(LEGACY_KEY);
    if (timers.length) localStorage.setItem(TIMER_KEY, JSON.stringify(timers));
    else localStorage.removeItem(TIMER_KEY);
  } catch {
    // Not remembered across restarts; fine.
  }
  for (const l of listeners) l();
}

/** Adds or replaces the timer of its task. */
export function putTimer(timer: RunningTimer) {
  setTimers([...getTimers().filter((t) => t.task_id !== timer.task_id), timer]);
}

/** Removes the timer of a task. */
export function dropTimer(taskId: string) {
  setTimers(getTimers().filter((t) => t.task_id !== taskId));
}

/** Forgets the cached timers (tests reset localStorage between cases). */
export function reloadTimers() {
  current = undefined;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  // Another window of the app (the quick-capture editor) started or stopped one.
  const onStorage = (e: StorageEvent) => {
    if (e.key === TIMER_KEY || e.key === LEGACY_KEY || e.key === null) {
      current = undefined;
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTimers(): RunningTimer[] {
  return useSyncExternalStore(subscribe, getTimers, getTimers);
}

/** The current time, ticking every `everyMs` while `active`. */
export function useNow(active: boolean, everyMs = 1000): number {
  return useSyncExternalStore(
    (l) => {
      if (!active) return () => {};
      const id = setInterval(l, everyMs);
      return () => clearInterval(id);
    },
    () => (active ? Math.floor(Date.now() / everyMs) * everyMs : 0),
  );
}

/**
 * The blocks a run from `start` to `end` is logged as: none under a minute, else
 * back-to-back pieces of at most 24 hours.
 */
export function runToBlocks(start: number, end: number): LoggedSpan[] {
  if (end - start < MIN_LOGGED_MS) return [];
  const pieces: LoggedSpan[] = [];
  for (let at = start; at < end; at += MAX_BLOCK_MS) {
    pieces.push({ start_at: at, end_at: Math.min(end, at + MAX_BLOCK_MS) });
  }
  return pieces;
}

/** Logged time of a task, in ms: its live `done` and `worked` blocks. */
export function loggedMs(blocks: Iterable<TimeBlock>, taskId: string): number {
  let total = 0;
  for (const b of blocks) {
    if (b.task_id !== taskId || b.deleted_at !== null) continue;
    if (b.outcome === "done" || b.outcome === "worked") total += b.end_at - b.start_at;
  }
  return total;
}

/** A running timer's clock: "4:07", "1:02:03". */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** A logged total: "45 min", "2 h", "3 h 20 min" (rounded to the minute). */
export function formatLogged(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}
