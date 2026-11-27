import { describe, expect, it } from "vitest";
import { agentSession, task, terminalSession } from "../../test/fixtures";
import {
  countedSessions,
  dollarsText,
  formatReset,
  inFilter,
  limitStatuses,
  parseDollars,
  periodStart,
  planTone,
  sessionProject,
  terminalProject,
  usageByProject,
  usageOf,
} from "./usage";

// Wednesday 2026-11-11, 15:30 local time.
const NOW = new Date(2026, 10, 11, 15, 30).getTime();
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe("periods", () => {
  it("start at local midnight of the day, the Monday, and the 1st", () => {
    expect(periodStart("day", NOW)).toBe(new Date(2026, 10, 11).getTime());
    expect(periodStart("week", NOW)).toBe(new Date(2026, 10, 9).getTime());
    expect(periodStart("month", NOW)).toBe(new Date(2026, 10, 1).getTime());
    expect(periodStart("all", NOW)).toBeNull();
  });

  it("a Sunday belongs to the week that began the Monday before", () => {
    const sunday = new Date(2026, 10, 15, 9).getTime();
    expect(periodStart("week", sunday)).toBe(new Date(2026, 10, 9).getTime());
  });
});

describe("usage", () => {
  const app = task({ project_id: "p1" });
  const loose = task({ project_id: null });
  const tasks = { [app.id]: app, [loose.id]: loose };

  const today = agentSession({
    task_id: app.id,
    updated_at: at(2026, 11, 11),
    cost_usd_micros: 1_500_000,
    duration_ms: 120_000,
    turns: 4,
  });
  const monday = agentSession({
    task_id: loose.id,
    updated_at: at(2026, 11, 9),
    cost_usd_micros: 500_000,
    duration_ms: 60_000,
    turns: 2,
  });
  const lastMonth = agentSession({
    task_id: app.id,
    updated_at: at(2026, 10, 28),
    cost_usd_micros: 9_000_000,
  });
  const gone = agentSession({ task_id: "deleted", updated_at: at(2026, 11, 10) });
  // Run in a terminal: counted when it was last active (`ended_at`).
  const site = terminalSession({
    project_id: "p1",
    ended_at: at(2026, 11, 11, 9),
    cost_usd_micros: 250_000,
    duration_ms: 30_000,
    turns: 3,
  });
  const loose2 = terminalSession({ project_id: null, ended_at: at(2026, 10, 2) });
  const orphan = terminalSession({ project_id: "gone", ended_at: at(2026, 11, 10) });
  const projects = { p1: {} };
  const all = countedSessions(
    [today, monday, lastMonth, gone],
    [site, loose2, orphan],
    tasks,
    projects,
  );
  const ids = (list: { id: string }[]) => list.map((s) => s.id);

  it("knows each session's project, the inbox, or a deleted task or project", () => {
    expect(sessionProject(today, tasks)).toBe("p1");
    expect(sessionProject(monday, tasks)).toBe("inbox");
    expect(sessionProject(gone, tasks)).toBe("");
    expect(terminalProject(site, projects)).toBe("p1");
    expect(terminalProject(loose2, projects)).toBe("inbox");
    expect(terminalProject(orphan, projects)).toBe("");
  });

  it("filters by project, source, and when a session was last active", () => {
    const pick = (
      project: string,
      period: "day" | "week" | "month" | "all",
      source: "all" | "app" | "terminal" = "all",
    ) => ids(all.filter((s) => inFilter(s, { project, period, source }, NOW)));
    expect(pick("", "day")).toEqual([today.id, site.id]);
    expect(pick("", "day", "app")).toEqual([today.id]);
    expect(pick("", "week", "terminal")).toEqual([site.id, orphan.id]);
    expect(pick("", "week")).toEqual([today.id, monday.id, gone.id, site.id, orphan.id]);
    expect(pick("p1", "all")).toEqual([today.id, lastMonth.id, site.id]);
    expect(pick("inbox", "all")).toEqual([monday.id, loose2.id]);
  });

  it("adds up cost, agent time, sessions and turns, counting missing ones as zero", () => {
    const some = all.filter((s) => [today.id, monday.id, gone.id, site.id].includes(s.id));
    expect(usageOf(some)).toEqual({
      costMicros: 2_250_000,
      durationMs: 210_000,
      sessions: 4,
      turns: 9,
    });
  });

  it("breaks usage down by project, most expensive first", () => {
    expect(usageByProject(all).map((r) => [r.project, r.usage.costMicros])).toEqual([
      ["p1", 10_750_000],
      ["inbox", 500_000],
      ["", 0],
    ]);
  });

  it("shows each set limit against all projects' spend in its period, terminal too", () => {
    const limits = {
      day_usd_micros: 1_000_000,
      week_usd_micros: null,
      month_usd_micros: 5_000_000,
    };
    expect(limitStatuses(all, limits, NOW)).toEqual([
      {
        period: "day",
        limitMicros: 1_000_000,
        spentMicros: 1_750_000,
        leftMicros: -750_000,
        over: true,
      },
      {
        period: "month",
        limitMicros: 5_000_000,
        spentMicros: 2_250_000,
        leftMicros: 2_750_000,
        over: false,
      },
    ]);
    expect(limitStatuses(all, null, NOW)).toEqual([]);
  });
});

describe("dollar amounts", () => {
  it("reads typed dollars into micros, blank or nonsense as none", () => {
    expect(parseDollars("12.5")).toBe(12_500_000);
    expect(parseDollars(" $3 ")).toBe(3_000_000);
    expect(parseDollars("")).toBeNull();
    expect(parseDollars("0")).toBeNull();
    expect(parseDollars("-2")).toBeNull();
    expect(parseDollars("lots")).toBeNull();
  });

  it("shows micros as dollars, to the cent", () => {
    expect(dollarsText(12_500_000)).toBe("12.5");
    expect(dollarsText(null)).toBe("");
  });
});

describe("plan windows", () => {
  it("say when they reset", () => {
    expect(formatReset(null, NOW)).toBe("Starts with your next message");
    expect(formatReset(NOW - 1, NOW)).toBe("Resetting now");
    expect(formatReset(NOW + 90_000, NOW)).toBe("Resets in 2 min");
    expect(formatReset(NOW + (2 * 60 + 5) * 60_000, NOW)).toBe("Resets in 2 h 05");
    expect(formatReset(at(2026, 11, 16, 9), NOW)).toMatch(/^Resets \S+/);
  });

  it("warn as they fill", () => {
    expect(planTone(10)).toBe("ok");
    expect(planTone(80)).toBe("close");
    expect(planTone(100)).toBe("full");
  });
});
