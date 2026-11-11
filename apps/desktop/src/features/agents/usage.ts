// What agents cost and how long they worked (ADR 017), for the Agents page and the spend
// limits in Settings → Agents. Pure functions of the sessions; periods are local calendar
// days, weeks (from Monday) and months.
//
// A session's cost and working time are running totals over its runs, so the whole
// session counts in the period it was last active (`updated_at`); a session continued
// over several days lands on its latest day. Costs arrive when a run ends.

import type { AgentSession, SpendLimits, Task } from "../../lib/types";

export type Period = "day" | "week" | "month";
export type PeriodFilter = Period | "all";

export const PERIOD_LABEL: Record<PeriodFilter, string> = {
  day: "Today",
  week: "This week",
  month: "This month",
  all: "All time",
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

export interface UsageFilter {
  /** A project id, `"inbox"` (no project), or `""` for all. */
  project: string;
  period: PeriodFilter;
}

export function inFilter(
  session: AgentSession,
  tasks: Record<string, Task>,
  filter: UsageFilter,
  now: number,
): boolean {
  if (filter.project && sessionProject(session, tasks) !== filter.project) return false;
  const since = periodStart(filter.period, now);
  return since === null || session.updated_at >= since;
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

export function usageOf(sessions: AgentSession[]): Usage {
  return sessions.reduce<Usage>(
    (u, s) => ({
      costMicros: u.costMicros + (s.cost_usd_micros ?? 0),
      durationMs: u.durationMs + (s.duration_ms ?? 0),
      sessions: u.sessions + 1,
      turns: u.turns + (s.turns ?? 0),
    }),
    NO_USAGE,
  );
}

/** Usage per project (`sessionProject` keys), most expensive first. */
export function usageByProject(
  sessions: AgentSession[],
  tasks: Record<string, Task>,
): Array<{ project: string; usage: Usage }> {
  const groups = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    const key = sessionProject(s, tasks);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
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

/** Each limit that is set, against what every session (all projects) spent in its period. */
export function limitStatuses(
  sessions: AgentSession[],
  limits: SpendLimits | null | undefined,
  now: number,
): LimitStatus[] {
  if (!limits) return [];
  const out: LimitStatus[] = [];
  for (const period of ["day", "week", "month"] as const) {
    const limitMicros = limits[LIMIT_FIELD[period]];
    if (!limitMicros || limitMicros <= 0) continue;
    const since = periodStart(period, now) ?? 0;
    const spentMicros = usageOf(sessions.filter((s) => s.updated_at >= since)).costMicros;
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
