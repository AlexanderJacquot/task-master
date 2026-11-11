// The work timer: one running timer per machine, remembered in localStorage so it
// survives a restart. Stopping it logs the time as `worked` time blocks (ADR 013), so
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

export const TIMER_KEY = "task-master.timer";
/** Shorter runs are dropped on stop (a timer started by mistake). */
export const MIN_LOGGED_MS = 60_000;
/** A block lasts at most 24 hours (core rule), so longer runs are split. */
export const MAX_BLOCK_MS = 24 * 60 * 60_000;

function load(): RunningTimer | null {
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<RunningTimer>;
    if (typeof v.task_id === "string" && typeof v.started_at === "number") {
      const timer: RunningTimer = { task_id: v.task_id, started_at: v.started_at };
      if (typeof v.session_id === "string") timer.session_id = v.session_id;
      return timer;
    }
  } catch {
    // Unreadable: no timer.
  }
  return null;
}

let current: RunningTimer | null | undefined;
const listeners = new Set<() => void>();

export function getTimer(): RunningTimer | null {
  if (current === undefined) current = load();
  return current;
}

export function setTimer(timer: RunningTimer | null) {
  current = timer;
  try {
    if (timer) localStorage.setItem(TIMER_KEY, JSON.stringify(timer));
    else localStorage.removeItem(TIMER_KEY);
  } catch {
    // Not remembered across restarts; fine.
  }
  for (const l of listeners) l();
}

/** Forgets the cached timer (tests reset localStorage between cases). */
export function reloadTimer() {
  current = undefined;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  // Another window of the app (the quick-capture editor) started or stopped it.
  const onStorage = (e: StorageEvent) => {
    if (e.key === TIMER_KEY || e.key === null) {
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

export function useTimer(): RunningTimer | null {
  return useSyncExternalStore(subscribe, getTimer, getTimer);
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
