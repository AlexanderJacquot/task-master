// /agents (ADR 017): what agents cost and how long they worked, against the spend limits;
// what they are doing and did; and the agents' own tasks, kept apart from the user's views.
// Filtered by project and period. Lists are capped (50 sessions, 100 tasks), so none is
// virtualized.

import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AgentsIcon as Bot, StopIcon } from "../../components/TaskIcons";
import { cx, FOCUS, IconButton, SectionLabel, Select, TaskCheck } from "../../components/ui";
import { formatAgo } from "../../lib/dates";
import type { AgentSession, Project, SpendLimits, Task } from "../../lib/types";
import { isOpen } from "../../lib/views";
import { adoptTask, toggleDone } from "../../store/actions";
import { useApi, useStoreState, useTaskStore } from "../../store/context";
import { useNow } from "../calendar/TimeGrid";
import { ProjectMark } from "../organize/ProjectMark";
import { useOpenTask } from "../shell/useOpenTask";
import { STATE_TONE } from "./SessionChip";
import {
  folderName,
  formatCost,
  formatDuration,
  isActive,
  STATE_LABEL,
  sortedSessions,
} from "./sessions";
import {
  inFilter,
  type LimitStatus,
  limitStatuses,
  PERIOD_LABEL,
  type PeriodFilter,
  sessionProject,
  type UsageFilter,
  usageByProject,
  usageOf,
} from "./usage";

const MAX_SESSIONS = 50;
const MAX_TASKS = 100;
const FILTER_KEY = "task-master.agents.filter";
const panel = "rounded-xl border border-line bg-raised p-4";

function loadFilter(): UsageFilter {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}") as Partial<UsageFilter>;
    const period =
      saved.period && Object.hasOwn(PERIOD_LABEL, saved.period) ? saved.period : "month";
    return { project: typeof saved.project === "string" ? saved.project : "", period };
  } catch {
    return { project: "", period: "month" };
  }
}

/** Spend limits from this device's agent settings; none outside the desktop app. */
function useLimits(): SpendLimits | null {
  const api = useApi().agents;
  const [limits, setLimits] = useState<SpendLimits | null>(null);
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.settings().then(
      (s) => live && setLimits(s.limits ?? null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);
  return limits;
}

export function AgentsPage() {
  const sessions = useStoreState((s) => s.agent_sessions);
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const statuses = useStoreState((s) => s.statuses);
  const now = useNow();
  const limits = useLimits();
  const [filter, setFilterState] = useState(loadFilter);
  const [showClosed, setShowClosed] = useState(false);
  const setFilter = (patch: Partial<UsageFilter>) => {
    const next = { ...filter, ...patch };
    setFilterState(next);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(next));
    } catch {
      // Not kept; the filter still applies.
    }
  };
  const ctx = useMemo(
    () => ({ statuses: Object.fromEntries(statuses.map((s) => [s.id, s])) }),
    [statuses],
  );
  const projectOptions = Object.values(projects)
    .filter((p) => !p.deleted_at)
    .sort((a, b) => a.name.localeCompare(b.name));
  // A focused project that was deleted falls back to all.
  const project = filter.project === "inbox" || projects[filter.project] ? filter.project : "";
  const view = { ...filter, project };

  const all = sortedSessions(sessions);
  const inProject = all.filter((s) => !project || sessionProject(s, tasks) === project);
  const active = inProject.filter(isActive);
  const ended = inProject.filter((s) => !isActive(s) && inFilter(s, tasks, view, now));
  const recent = ended.slice(0, MAX_SESSIONS);
  const counted = all.filter((s) => inFilter(s, tasks, view, now));
  const usage = usageOf(counted);
  const byProject = project ? [] : usageByProject(counted, tasks);
  const meters = limitStatuses(all, limits, now);

  // Agent tasks under the user's task they belong to (the nearest non-agent ancestor).
  const { groups, totalTasks } = useMemo(() => {
    const matching = Object.values(tasks)
      .filter(
        (t) =>
          t.owner === "agent" &&
          (showClosed || isOpen(t, ctx)) &&
          (!project || (t.project_id ?? "inbox") === project),
      )
      .sort((a, b) => b.updated_at - a.updated_at);
    const agentTasks = matching.slice(0, MAX_TASKS);
    const owner = (t: Task): Task | undefined => {
      let parent = t.parent_id ? tasks[t.parent_id] : undefined;
      for (let i = 0; parent && parent.owner === "agent" && i < 64; i++) {
        parent = parent.parent_id ? tasks[parent.parent_id] : undefined;
      }
      return parent;
    };
    const map = new Map<string, { root: Task | undefined; items: Task[] }>();
    for (const task of agentTasks) {
      const root = owner(task);
      const key = root?.id ?? "";
      const group = map.get(key) ?? { root, items: [] };
      group.items.push(task);
      map.set(key, group);
    }
    return { groups: [...map.values()], totalTasks: matching.length };
  }, [tasks, ctx, showClosed, project]);

  const periodName = PERIOD_LABEL[view.period].toLowerCase();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-10 py-7">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 font-display text-[34px] font-normal tracking-wide">
            <Bot size={28} className="text-rubric" />
            Agents
          </h1>
          <p className="mt-1 text-sm text-ink-3">
            What agents cost and did, and the tasks they keep for themselves.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="text-xs text-ink-3">
            Project
            <Select
              aria-label="Project"
              value={project}
              onValueChange={(p) => setFilter({ project: p })}
              options={[
                { value: "", label: "All projects" },
                { value: "inbox", label: "Inbox" },
                ...projectOptions.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </div>
          <div className="text-xs text-ink-3">
            Period
            <Select
              aria-label="Period"
              value={view.period}
              onValueChange={(period) => setFilter({ period: period as PeriodFilter })}
              options={(Object.keys(PERIOD_LABEL) as PeriodFilter[]).map((p) => ({
                value: p,
                label: PERIOD_LABEL[p],
              }))}
            />
          </div>
        </div>
      </header>

      <section aria-label="Usage" className="mb-7 flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Tile
            label="Spent"
            value={formatCost(usage.costMicros) ?? ""}
            detail={
              usage.sessions
                ? `${formatCost(Math.round(usage.costMicros / usage.sessions))} per session`
                : `Nothing ${periodName === "all time" ? "yet" : periodName}`
            }
          />
          <Tile
            label="Agent time"
            value={formatDuration(usage.durationMs)}
            detail="Time the agent worked, not waiting"
          />
          <Tile
            label="Sessions"
            value={String(usage.sessions)}
            detail={`${active.length} running now`}
          />
          <Tile label="Turns" value={String(usage.turns)} detail="Round trips with the model" />
        </div>
        <p className="text-xs text-ink-3">
          {PERIOD_LABEL[view.period]}
          {project && `, ${project === "inbox" ? "Inbox" : projects[project]?.name}`}. A session
          counts when it was last active; its cost arrives when a run ends.
        </p>
      </section>

      <Limits meters={meters} />

      {byProject.length > 1 && (
        <ProjectBreakdown
          rows={byProject}
          projects={projects}
          onFocus={(id) => setFilter({ project: id })}
        />
      )}

      <section aria-label="Active" className="mb-7 flex flex-col gap-2">
        <SectionLabel>Active</SectionLabel>
        {active.length === 0 ? (
          <p className="text-xs text-ink-3">Nothing running. Use "Send to agent" on a task.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {active.map((s) => (
              <SessionRow key={s.id} session={s} task={tasks[s.task_id]} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Recent sessions" className="mb-7 flex flex-col gap-2">
        <SectionLabel>Recent sessions</SectionLabel>
        {recent.length === 0 ? (
          <p className="text-xs text-ink-3">No finished sessions {periodName}.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {recent.map((s) => (
              <SessionRow key={s.id} session={s} task={tasks[s.task_id]} />
            ))}
          </ul>
        )}
        {ended.length > MAX_SESSIONS && (
          <p className="text-xs text-ink-3">
            The latest {MAX_SESSIONS} of {ended.length}; older ones stay on their tasks.
          </p>
        )}
      </section>

      <section aria-label="Agent tasks" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <SectionLabel>Agent tasks</SectionLabel>
          <label className="flex items-center gap-2 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
              className="accent-accent"
            />
            Show finished
          </label>
        </div>
        {groups.length === 0 ? (
          <p className="text-xs text-ink-3">Agents add tasks here to plan and track their work.</p>
        ) : (
          groups.map((group) => (
            <AgentTaskGroup key={group.root?.id ?? "none"} root={group.root} items={group.items} />
          ))
        )}
        {totalTasks > MAX_TASKS && (
          <p className="text-xs text-ink-3">
            The {MAX_TASKS} most recently updated of {totalTasks}; search finds the others.
          </p>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className={panel}>
      <p className="text-xs font-medium text-ink-2">{label}</p>
      <p className="my-1 font-display text-3xl tabular-nums">{value}</p>
      <p className="text-xs text-ink-3">{detail}</p>
    </div>
  );
}

const LIMIT_NAME = { day: "Today", week: "This week", month: "This month" } as const;

/** Each spend limit: spent of the limit, a meter, and what is left (all projects). */
function Limits({ meters }: { meters: LimitStatus[] }) {
  return (
    <section aria-label="Spend limits" className="mb-7 flex flex-col gap-2">
      <SectionLabel>Spend limits</SectionLabel>
      {meters.length === 0 ? (
        <p className="text-xs text-ink-3">
          No limits set.{" "}
          <Link to="/settings" hash="agents" className="text-accent hover:underline">
            Set a daily, weekly or monthly limit
          </Link>{" "}
          to see what is left.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {meters.map((m) => {
            const share = Math.min(1, m.spentMicros / m.limitMicros);
            return (
              <li key={m.period} className={panel}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="font-medium text-ink-2">{LIMIT_NAME[m.period]}</span>
                  <span className="text-ink-3 tabular-nums">
                    {formatCost(m.spentMicros)} of {formatCost(m.limitMicros)}
                  </span>
                </div>
                <div
                  role="meter"
                  aria-label={`${LIMIT_NAME[m.period]} spend`}
                  aria-valuemin={0}
                  aria-valuemax={m.limitMicros / 1_000_000}
                  aria-valuenow={Math.min(m.spentMicros, m.limitMicros) / 1_000_000}
                  className="my-2 h-2 overflow-hidden rounded-full bg-hover"
                >
                  <div
                    className={cx("h-full rounded-full", m.over ? "bg-rubric" : "bg-accent")}
                    style={{ width: `${share * 100}%` }}
                  />
                </div>
                <p className={cx("text-sm tabular-nums", m.over ? "text-rubric" : "text-ink")}>
                  {m.over
                    ? m.leftMicros === 0
                      ? "Limit reached"
                      : `Over by ${formatCost(-m.leftMicros)}`
                    : `${formatCost(m.leftMicros)} left`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ProjectBreakdown({
  rows,
  projects,
  onFocus,
}: {
  rows: ReturnType<typeof usageByProject>;
  projects: Record<string, Project>;
  onFocus(id: string): void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.usage.costMicros));
  const name = (id: string) =>
    id === "inbox" ? "Inbox" : id ? (projects[id]?.name ?? "A deleted project") : "Deleted tasks";
  return (
    <section aria-label="By project" className="mb-7 flex flex-col gap-2">
      <SectionLabel>By project</SectionLabel>
      <table className="w-full text-left text-[13px] tabular-nums">
        <thead className="text-xs text-ink-3">
          <tr>
            <th className="pb-2 font-normal">Project</th>
            <th className="w-1/3 pb-2 font-normal">
              <span className="sr-only">Share of the cost</span>
            </th>
            {["Spent", "Agent time", "Sessions"].map((h) => (
              <th key={h} className="pb-2 pl-3 text-right font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ project: id, usage }) => {
            const p = projects[id];
            const focusable = id === "inbox" || !!p;
            return (
              <tr key={id || "deleted"} className="border-t border-line">
                <th scope="row" className="py-2 pr-3 font-normal">
                  <span className="flex items-center gap-2">
                    {p && <ProjectMark project={p} dotClass="size-2.5" className="text-[15px]" />}
                    {focusable ? (
                      <button
                        type="button"
                        title={`Show only ${name(id)}`}
                        onClick={() => onFocus(id)}
                        className={`rounded text-left underline-offset-4 hover:text-rubric hover:underline ${FOCUS}`}
                      >
                        {name(id)}
                      </button>
                    ) : (
                      <span className="text-ink-3">{name(id)}</span>
                    )}
                  </span>
                </th>
                <td className="py-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-hover" aria-hidden>
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${(usage.costMicros / max) * 100}%` }}
                    />
                  </div>
                </td>
                <td className="py-2 pl-3 text-right">{formatCost(usage.costMicros)}</td>
                <td className="py-2 pl-3 text-right">{formatDuration(usage.durationMs)}</td>
                <td className="py-2 pl-3 text-right">{usage.sessions}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function SessionRow({ session, task }: { session: AgentSession; task: Task | undefined }) {
  const api = useApi().agents;
  const openTask = useOpenTask();
  const activity = useStoreState((s) => s.agentActivity[session.id]);
  const running = session.state === "running";
  const cost = formatCost(session.cost_usd_micros);
  const worked = session.duration_ms ? formatDuration(session.duration_ms) : null;
  const detail = running
    ? (activity ?? "Running on another device")
    : session.state === "terminal"
      ? (session.summary ?? "Continuing in a terminal")
      : (session.summary ?? session.error ?? "");
  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-[13px] hover:bg-hover">
      <span
        className={cx(
          "w-24 shrink-0 rounded-md px-1.5 text-center text-[12px] leading-5",
          STATE_TONE[session.state],
        )}
      >
        {STATE_LABEL[session.state]}
      </span>
      <button
        type="button"
        onClick={() => openTask(session.task_id)}
        className="w-64 shrink-0 truncate text-left text-ink hover:underline"
        title={task?.title}
      >
        {task?.title ?? "A deleted task"}
      </button>
      <span className="min-w-0 flex-1 truncate text-ink-3" title={detail}>
        {detail.split("\n")[0]}
      </span>
      <span className="shrink-0 text-xs text-ink-3 tabular-nums" title={session.folder}>
        {folderName(session.folder)} · {formatAgo(session.started_at)}
        {worked && ` · ${worked}`}
        {cost && ` · ${cost}`}
      </span>
      {running && api && (
        <IconButton label="Stop" onClick={() => void api.cancel(session.id)}>
          <StopIcon size={14} />
        </IconButton>
      )}
    </li>
  );
}

function AgentTaskGroup({ root, items }: { root: Task | undefined; items: Task[] }) {
  const store = useTaskStore();
  const openTask = useOpenTask();
  const statuses = useStoreState((s) => s.statuses);
  const name = (t: Task) => statuses.find((s) => s.id === t.status_id)?.name ?? "";
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        disabled={!root}
        onClick={() => root && openTask(root.id)}
        className="self-start text-xs text-ink-2 enabled:hover:underline"
      >
        {root ? `For “${root.title}”` : "Not under one of your tasks"}
      </button>
      <ul className="flex flex-col">
        {items.map((task) => {
          const status = statuses.find((s) => s.id === task.status_id);
          const category = status?.category;
          return (
            <li
              key={task.id}
              className="group flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] hover:bg-hover"
            >
              <TaskCheck
                checked={category === "done"}
                onChange={() => void toggleDone(store, task.id)}
                label={`Mark “${task.title}” done`}
                color={status?.color ?? null}
              />
              <button
                type="button"
                onClick={() => openTask(task.id)}
                className="min-w-0 flex-1 truncate text-left text-ink"
              >
                {task.title}
              </button>
              <span className="text-xs text-ink-3">{name(task)}</span>
              <button
                type="button"
                onClick={() => void adoptTask(store, task.id)}
                className="text-xs text-accent opacity-0 group-hover:opacity-100 hover:underline focus:opacity-100"
              >
                Make it mine
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
