// What agents cost and how long they worked (ADR 017), for the Agents page and the spend
// limits in Settings → Agents. Pure functions of the sessions; periods are local calendar
// days, weeks (from Monday) and months.
//
// Two kinds of session count: the app's own agent sessions, and the Claude Code sessions
// run in a terminal, read from their transcripts (M21, ADR 028). Both become a `Counted`.
//
// A session's cost and working time are running totals, so the whole session counts in
// the period it was last active; a session continued over several days lands on its
// latest day. An agent session's cost arrives when a run ends.

import type { AgentSession, SpendLimits, Task, TerminalSession } from "../../lib/types";

export type Period = "day" | "week" | "month";
export type PeriodFilter = Period | "all";
/** Where sessions come from: the app (Send to agent) or a terminal. */
export type Source = "app" | "terminal";
export type SourceFilter = Source | "all";

export const PERIOD_LABEL: Record<PeriodFilter, string> = {
  day: "Today",
  week: "This week",
  month: "This month",
  all: "All time",
};

export const SOURCE_LABEL: Record<SourceFilter, string> = {
  all: "All sessions",
  app: "Sent from tasks",
  terminal: "Run in a terminal",
};

/** Where `period` began, local time, as Unix ms; `null` for all time. */
export function periodStart(period: PeriodFilter, now: number): number | null {
  if (period === "all") return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (period === "month") d.setDate(1);
  return d.getTime();
}

/** The session's project id, `"inbox"` for a task without one, `""` for a deleted task. */
export function sessionProject(session: AgentSession, tasks: Record<string, Task>): string {
  const task = tasks[session.task_id];
  if (!task) return "";
  return task.project_id ?? "inbox";
}

/**
 * A terminal session's project id, `"inbox"` for none, `""` for a deleted project.
 * `projects` holds the live ones.
 */
export function terminalProject(
  session: TerminalSession,
  projects: Record<string, unknown>,
): string {
  if (!session.project_id) return "inbox";
  return projects[session.project_id] ? session.project_id : "";
}

/** A session as the totals see it. */
export interface Counted {
  id: string;
  source: Source;
  /** As `sessionProject` gives it. */
  project: string;
  /** When it was last active. */
  at: number;
  costMicros: number;
  durationMs: number;
  turns: number;
}

/** Every session that counts, the app's and the terminal's. */
export function countedSessions(
  agentSessions: AgentSession[],
  terminalSessions: TerminalSession[],
  tasks: Record<string, Task>,
  projects: Record<string, unknown>,
): Counted[] {
  return [
    ...agentSessions.map(
      (s): Counted => ({
        id: s.id,
        source: "app",
        project: sessionProject(s, tasks),
        at: s.updated_at,
        costMicros: s.cost_usd_micros ?? 0,
        durationMs: s.duration_ms ?? 0,
        turns: s.turns ?? 0,
      }),
    ),
    ...terminalSessions.map(
      (s): Counted => ({
        id: s.id,
        source: "terminal",
        project: terminalProject(s, projects),
        at: s.ended_at,
        costMicros: s.cost_usd_micros ?? 0,
        durationMs: s.duration_ms ?? 0,
        turns: s.turns ?? 0,
      }),
    ),
  ];
}

export interface UsageFilter {
  /** A project id, `"inbox"` (no project), or `""` for all. */
  project: string;
  period: PeriodFilter;
  /** All when absent. */
  source?: SourceFilter;
}

export function inFilter(session: Counted, filter: UsageFilter, now: number): boolean {
  if (filter.project && session.project !== filter.project) return false;
  if (filter.source && filter.source !== "all" && session.source !== filter.source) return false;
  const since = periodStart(filter.period, now);
  return since === null || session.at >= since;
}

export interface Usage {
  /** Millionths of a dollar. */
  costMicros: number;
  /** Time the agent worked, summed over runs. */
  durationMs: number;
  sessions: number;
  turns: number;
}

export const NO_USAGE: Usage = { costMicros: 0, durationMs: 0, sessions: 0, turns: 0 };

export function usageOf(sessions: Counted[]): Usage {
  return sessions.reduce<Usage>(
    (u, s) => ({
      costMicros: u.costMicros + s.costMicros,
      durationMs: u.durationMs + s.durationMs,
      sessions: u.sessions + 1,
      turns: u.turns + s.turns,
    }),
    NO_USAGE,
  );
}

/** Usage per project (`Counted.project` keys), most expensive first. */
export function usageByProject(sessions: Counted[]): Array<{ project: string; usage: Usage }> {
  const groups = new Map<string, Counted[]>();
  for (const s of sessions) groups.set(s.project, [...(groups.get(s.project) ?? []), s]);
  return [...groups.entries()]
    .map(([project, list]) => ({ project, usage: usageOf(list) }))
    .sort(
      (a, b) =>
        b.usage.costMicros - a.usage.costMicros ||
        b.usage.durationMs - a.usage.durationMs ||
        b.usage.sessions - a.usage.sessions,
    );
}

export interface LimitStatus {
  period: Period;
  limitMicros: number;
  spentMicros: number;
  /** What is left; negative when over. */
  leftMicros: number;
  over: boolean;
}

const LIMIT_FIELD: Record<Period, keyof SpendLimits> = {
  day: "day_usd_micros",
  week: "week_usd_micros",
  month: "month_usd_micros",
};

/**
 * Each limit that is set, against what every session (all projects, the terminal's too)
 * spent in its period.
 */
export function limitStatuses(
  sessions: Counted[],
  limits: SpendLimits | null | undefined,
  now: number,
): LimitStatus[] {
  if (!limits) return [];
  const out: LimitStatus[] = [];
  for (const period of ["day", "week", "month"] as const) {
    const limitMicros = limits[LIMIT_FIELD[period]];
    if (!limitMicros || limitMicros <= 0) continue;
    const since = periodStart(period, now) ?? 0;
    const spentMicros = usageOf(sessions.filter((s) => s.at >= since)).costMicros;
    const leftMicros = limitMicros - spentMicros;
    out.push({ period, limitMicros, spentMicros, leftMicros, over: leftMicros <= 0 });
  }
  return out;
}

/** `$12.50` from a dollar amount typed in Settings; `null` for blank, zero or not a number. */
export function parseDollars(text: string): number | null {
  const value = Number(text.trim().replace(/^\$/, ""));
  if (!text.trim() || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 1_000_000);
}

/** The amount Settings shows for a limit: `12.5`, or blank for none. */
export function dollarsText(micros: number | null | undefined): string {
  return micros ? String(Math.round(micros / 10_000) / 100) : "";
}

/** When a plan window resets: "Resets in 2 h 05" within a day, else "Resets Mon 09:00". */
export function formatReset(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "Starts with your next message";
  const left = resetsAt - now;
  if (left <= 0) return "Resetting now";
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `Resets in ${minutes} min`;
  if (minutes < 24 * 60) {
    return `Resets in ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
  }
  const when = new Date(resetsAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Resets ${when}`;
}

/** How full a plan window is: calm, close (75%+), or at the limit (95%+). */
export function planTone(percent: number): "ok" | "close" | "full" {
  return percent >= 95 ? "full" : percent >= 75 ? "close" : "ok";
}
