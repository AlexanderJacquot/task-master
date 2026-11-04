import { useSearch } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { InlineInput } from "../../components/ui";
import { isoDate } from "../../lib/dates";
import type { TaskChange } from "../../lib/types";
import { buildRows, type ViewContext, type ViewKey } from "../../lib/views";
import { createTask, type NewTaskInput, toggleDone, updateTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { useOpenTask } from "../shell/useOpenTask";
import { NEW_TASK_INPUT_ID } from "../shell/useShortcuts";
import { TaskList } from "./TaskList";

function toggle(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** A list of tasks grouped by status, with a capture input on top. */
export function ListView({
  view,
  title,
  defaults,
}: {
  view: ViewKey;
  title: string;
  /** Applied to tasks created here (project, epic, picked for today). */
  defaults: Omit<NewTaskInput, "title">;
}) {
  const store = useTaskStore();
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const tags = useStoreState((s) => s.tags);
  const statuses = useStoreState((s) => s.statuses);
  const { task: selectedId } = useSearch({ strict: false }) as { task?: string };
  const openTask = useOpenTask();

  const [showCancelled, setShowCancelled] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [collapsedTasks, setCollapsedTasks] = useState<ReadonlySet<string>>(new Set());
  const today = isoDate();

  const ctx: ViewContext = useMemo(
    () => ({ today, statuses: Object.fromEntries(statuses.map((s) => [s.id, s])), projects }),
    [today, statuses, projects],
  );
  const rows = useMemo(
    () =>
      buildRows(Object.values(tasks), view, ctx, statuses, {
        showCancelled,
        collapsedGroups,
        collapsedTasks,
      }),
    [tasks, view, ctx, statuses, showCancelled, collapsedGroups, collapsedTasks],
  );
  const taskCount = rows.reduce((n, r) => n + (r.type === "task" ? 1 : 0), 0);

  const onChange = useCallback(
    (id: string, changes: TaskChange[]) => void updateTask(store, id, changes),
    [store],
  );
  const onToggleDone = useCallback((id: string) => void toggleDone(store, id), [store]);
  const onToggleCollapse = useCallback((id: string) => setCollapsedTasks((s) => toggle(s, id)), []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <h1 className="flex-1 truncate text-lg font-semibold">{title}</h1>
        <span className="text-xs text-neutral-500">
          {taskCount} {taskCount === 1 ? "task" : "tasks"}
        </span>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)}
          />
          Show cancelled
        </label>
      </header>
      <div className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <InlineInput
          id={NEW_TASK_INPUT_ID}
          initial=""
          clearOnCommit
          placeholder="New task… (press n)"
          onCommit={(text) => void createTask(store, { ...defaults, title: text })}
        />
      </div>
      {rows.length === 0 ? (
        <p className="p-8 text-center text-neutral-500">
          {view.kind === "inbox" ? "Inbox zero. Nothing to triage." : "No tasks here yet."}
        </p>
      ) : (
        <TaskList
          rows={rows}
          selectedId={selectedId ?? null}
          collapsedTasks={collapsedTasks}
          onToggleGroup={(id) => setCollapsedGroups((s) => toggle(s, id))}
          onOpen={openTask}
          onToggleDone={onToggleDone}
          onToggleCollapse={onToggleCollapse}
          onChange={onChange}
          statuses={statuses}
          projects={projects}
          tags={tags}
          today={today}
          showProject={view.kind !== "project"}
        />
      )}
    </div>
  );
}
