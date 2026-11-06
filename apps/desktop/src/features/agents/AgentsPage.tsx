// /agents (ADR 017): what Claude is doing and did, and the agents' own tasks, kept apart
// from the user's views. Lists are capped (50 sessions, 100 tasks), so none is virtualized.

import { Square } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentsIcon as Bot } from "../../components/TaskIcons";
import { cx, IconButton, SectionLabel, TaskCheck } from "../../components/ui";
import { formatAgo } from "../../lib/dates";
import type { AgentSession, Task } from "../../lib/types";
import { isOpen } from "../../lib/views";
import { adoptTask, toggleDone } from "../../store/actions";
import { useApi, useStoreState, useTaskStore } from "../../store/context";
import { useOpenTask } from "../shell/useOpenTask";
import { STATE_TONE } from "./SessionChip";
import { folderName, formatCost, isActive, STATE_LABEL, sortedSessions } from "./sessions";

const MAX_SESSIONS = 50;
const MAX_TASKS = 100;

export function AgentsPage() {
  const sessions = useStoreState((s) => s.agent_sessions);
  const tasks = useStoreState((s) => s.tasks);
  const statuses = useStoreState((s) => s.statuses);
  const [showClosed, setShowClosed] = useState(false);
  const ctx = useMemo(
    () => ({ statuses: Object.fromEntries(statuses.map((s) => [s.id, s])) }),
    [statuses],
  );
  const all = sortedSessions(sessions);
  const active = all.filter(isActive);
  const ended = all.filter((s) => !isActive(s));
  const recent = ended.slice(0, MAX_SESSIONS);

  // Agent tasks under the user's task they belong to (the nearest non-agent ancestor).
  const { groups, totalTasks } = useMemo(() => {
    const matching = Object.values(tasks)
      .filter((t) => t.owner === "agent" && (showClosed || isOpen(t, ctx)))
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
  }, [tasks, ctx, showClosed]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-10 py-7">
      <header className="mb-6">
        <h1 className="flex items-center gap-3 font-display text-[34px] font-normal tracking-wide">
          <Bot size={28} className="text-rubric" />
          Agents
        </h1>
        <p className="mt-1 text-sm text-ink-3">
          Claude sessions started from your tasks, and the tasks agents keep for themselves.
        </p>
      </header>

      <section aria-label="Active" className="mb-7 flex flex-col gap-2">
        <SectionLabel>Active</SectionLabel>
        {active.length === 0 ? (
          <p className="text-xs text-ink-3">Nothing running. Use "Send to Claude" on a task.</p>
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
          <p className="text-xs text-ink-3">No finished sessions yet.</p>
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

function SessionRow({ session, task }: { session: AgentSession; task: Task | undefined }) {
  const api = useApi().agents;
  const openTask = useOpenTask();
  const activity = useStoreState((s) => s.agentActivity[session.id]);
  const running = session.state === "running";
  const cost = formatCost(session.cost_usd_micros);
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
      <span className="shrink-0 text-xs text-ink-3" title={session.folder}>
        {folderName(session.folder)} · {formatAgo(session.started_at)}
        {cost && ` · ${cost}`}
      </span>
      {running && api && (
        <IconButton label="Stop" onClick={() => void api.cancel(session.id)}>
          <Square size={14} />
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
