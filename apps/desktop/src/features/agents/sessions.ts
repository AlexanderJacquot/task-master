// Pure helpers for agent sessions (ADR 017): which session a task shows, where a new one
// starts, and how numbers read.

import { daysFrom, isoDate } from "../../lib/dates";
import type {
  AgentRuntime,
  AgentSession,
  Project,
  ProjectFolder,
  SessionState,
  Task,
} from "../../lib/types";

/** Still going: a headless run, or a conversation continued in a terminal. */
export function isActive(session: AgentSession): boolean {
  return session.state === "running" || session.state === "terminal";
}

/** The follow-up the Resume button sends to an interrupted session. */
export const RESUME_MESSAGE =
  "You were interrupted before you finished. Check your notes and agent subtasks on this " +
  "task, then pick up where you left off.";

/** A task's live sessions, newest first. */
export function sessionsOf(sessions: Record<string, AgentSession>, taskId: string): AgentSession[] {
  return Object.values(sessions)
    .filter((s) => s.task_id === taskId)
    .sort((a, b) => b.started_at - a.started_at || (a.id < b.id ? 1 : -1));
}

/** The session a task's chip shows: an active one, else the newest. */
export function shownSession(
  sessions: Record<string, AgentSession>,
  taskId: string,
): AgentSession | undefined {
  const list = sessionsOf(sessions, taskId);
  return list.find(isActive) ?? list[0];
}

/** Every session, active ones first, then newest first. */
export function sortedSessions(sessions: Record<string, AgentSession>): AgentSession[] {
  return Object.values(sessions).sort(
    (a, b) => Number(isActive(b)) - Number(isActive(a)) || b.started_at - a.started_at,
  );
}

export interface SessionDay {
  /** Local calendar date the sessions started on, `YYYY-MM-DD`. */
  day: string;
  sessions: AgentSession[];
}

/** Sessions (sorted newest first) split by the local day they started on. */
export function sessionsByDay(sessions: AgentSession[]): SessionDay[] {
  const days: SessionDay[] = [];
  for (const s of sessions) {
    const day = isoDate(new Date(s.started_at));
    const last = days[days.length - 1];
    if (last?.day === day) last.sessions.push(s);
    else days.push({ day, sessions: [s] });
  }
  return days;
}

/** A day divider's label: "Today", "Yesterday", "Monday, Nov 9", with the year if not this one. */
export function formatDayHeading(day: string, today: string): string {
  const days = daysFrom(today, day);
  if (days === 0) return "Today";
  if (days === -1) return "Yesterday";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  });
}

/** Folders of earlier sessions for this runtime, newest first, without repeats. */
export function recentFolders(
  sessions: Record<string, AgentSession>,
  runtime: AgentRuntime,
  limit = 6,
): string[] {
  const out: string[] = [];
  for (const s of Object.values(sessions).sort((a, b) => b.started_at - a.started_at)) {
    if (s.runtime !== runtime || out.includes(s.folder)) continue;
    out.push(s.folder);
    if (out.length === limit) break;
  }
  return out;
}

/**
 * Where a new session on `task` starts: the folder of its last session, else its project's
 * folder on this device (or its area's), else the most recent folder, else nothing.
 */
export function defaultFolder(
  task: Task,
  sessions: Record<string, AgentSession>,
  folders: ProjectFolder[],
  projects: Record<string, Project>,
  runtime: AgentRuntime,
): string {
  const own = sessionsOf(sessions, task.id).find((s) => s.runtime === runtime);
  if (own) return own.folder;
  const byProject = new Map(
    folders.filter((f) => f.runtime === runtime).map((f) => [f.project_id, f.path]),
  );
  if (task.project_id) {
    const direct = byProject.get(task.project_id);
    if (direct) return direct;
    const area = projects[task.project_id]?.parent_id;
    const fromArea = area ? byProject.get(area) : undefined;
    if (fromArea) return fromArea;
  }
  return recentFolders(sessions, runtime, 1)[0] ?? "";
}

export const STATE_LABEL: Record<SessionState, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
  terminal: "In terminal",
};

/** Models offered when sending to an agent; the values are Claude Code `--model` aliases. */
export const MODELS: Array<{ value: string; label: string }> = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/** Value of the "use the configured default" entry (an empty string is not a valid option). */
export const DEFAULT_MODEL = "default";

export const PERMISSION_MODES: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "acceptEdits",
    label: "Edit files",
    hint: "Reads and edits files in the folder; other commands that need approval are skipped.",
  },
  { value: "plan", label: "Plan only", hint: "Explores and proposes a plan; changes nothing." },
  {
    value: "default",
    label: "Ask first",
    hint: "Anything that needs approval is skipped, since nobody can approve it in the background.",
  },
  {
    value: "bypassPermissions",
    label: "Everything",
    hint: "Runs any command without asking. Only in folders you can afford to lose.",
  },
];

/** `$0.0045`, `$1.20`, `$0.00`. */
export function formatCost(micros: number | null | undefined): string | null {
  if (micros === null || micros === undefined) return null;
  if (micros === 0) return "$0.00";
  const dollars = micros / 1_000_000;
  return `$${dollars < 0.1 ? dollars.toFixed(4) : dollars.toFixed(2)}`;
}

/** `45 s`, `3 min`, `1 h 05`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** The last part of a folder path, for compact labels. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
