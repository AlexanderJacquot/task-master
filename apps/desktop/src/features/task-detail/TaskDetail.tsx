import { type ReactNode, useMemo } from "react";
import { cx, PRIORITIES, PRIORITY_STYLE, Select } from "../../components/ui";
import { isoDate } from "../../lib/dates";
import type { Priority, TaskChange } from "../../lib/types";
import { deleteTask, setParent, updateTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { useOpenTask } from "../shell/useOpenTask";
import { ActivityFeed } from "./ActivityFeed";
import { DescriptionEditor } from "./DescriptionEditor";
import { SubtaskList } from "./SubtaskList";
import { TagPicker } from "./TagPicker";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] items-center gap-2 py-0.5">
      <span className="text-xs text-neutral-500">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const fieldInput =
  "w-full rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-neutral-300 focus:border-blue-500 focus:outline-none dark:hover:border-neutral-700";

/** Right-hand panel for one task, opened with `?task=<id>`. Every field saves on change. */
export function TaskDetail({ taskId }: { taskId: string }) {
  const store = useTaskStore();
  const task = useStoreState((s) => s.tasks[taskId]);
  const statuses = useStoreState((s) => s.statuses);
  const projects = useStoreState((s) => s.projects);
  const epics = useStoreState((s) => s.epics);
  const parent = useStoreState((s) => (task?.parent_id ? s.tasks[task.parent_id] : undefined));
  const openTask = useOpenTask();
  const today = isoDate();

  const projectOptions = useMemo(() => {
    const list = Object.values(projects).filter(
      (p) => p.archived_at === null || p.id === task?.project_id,
    );
    const areas = list
      .filter((p) => p.parent_id === null)
      .sort((a, b) => (a.rank < b.rank ? -1 : 1));
    return areas.flatMap((area) => [
      { id: area.id, label: area.name },
      ...list
        .filter((p) => p.parent_id === area.id)
        .sort((a, b) => (a.rank < b.rank ? -1 : 1))
        .map((p) => ({ id: p.id, label: `  ${area.name} / ${p.name}` })),
    ]);
  }, [projects, task?.project_id]);

  if (!task) {
    return (
      <aside className="flex w-[28rem] shrink-0 flex-col items-center justify-center gap-2 border-l border-neutral-200 p-6 text-neutral-500 dark:border-neutral-800">
        This task no longer exists.
        <button
          type="button"
          onClick={() => openTask(null)}
          className="text-blue-600 hover:underline"
        >
          Close
        </button>
      </aside>
    );
  }

  const change = (changes: TaskChange[]) => void updateTask(store, task.id, changes);
  const pickedToday = task.today_on === today;

  return (
    <aside
      aria-label="Task details"
      className="flex w-[28rem] shrink-0 flex-col overflow-y-auto border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
    >
      <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-800">
        {parent ? (
          <button
            type="button"
            onClick={() => openTask(parent.id)}
            className="min-w-0 truncate hover:underline"
          >
            ↑ {parent.title}
          </button>
        ) : (
          <span>Task</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            void deleteTask(store, task.id);
            openTask(null);
          }}
          className="rounded px-2 py-1 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
          title="Delete (Ctrl+Z to undo)"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={() => openTask(null)}
          aria-label="Close"
          className="rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-4 p-4">
        <textarea
          key={`title-${task.updated_at}`}
          defaultValue={task.title}
          aria-label="Title"
          rows={2}
          className="w-full resize-none rounded border border-transparent bg-transparent px-1 text-lg font-semibold hover:border-neutral-300 focus:border-blue-500 focus:outline-none dark:hover:border-neutral-700"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            const title = e.currentTarget.value.trim();
            if (!title) e.currentTarget.value = task.title;
            else if (title !== task.title) change([{ title }]);
          }}
        />

        <div>
          <Field label="Status">
            <Select
              value={task.status_id}
              onChange={(e) => change([{ status_id: e.target.value }])}
              aria-label="Status"
              className="w-full"
            >
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select
              value={task.priority}
              onChange={(e) => change([{ priority: e.target.value as Priority }])}
              aria-label="Priority"
              className={cx("w-full", PRIORITY_STYLE[task.priority])}
            >
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due">
            <input
              type="date"
              aria-label="Due date"
              value={task.due_date ?? ""}
              onChange={(e) => change([{ due_date: e.target.value || null }])}
              className={fieldInput}
            />
          </Field>
          <Field label="Today">
            <button
              type="button"
              aria-pressed={pickedToday}
              onClick={() => change([{ today_on: pickedToday ? null : today }])}
              className={cx(
                "rounded px-2 py-0.5 text-xs",
                pickedToday
                  ? "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100"
                  : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800",
              )}
            >
              {pickedToday ? "★ Picked for today" : "☆ Add to today"}
            </button>
          </Field>
          <Field label="Estimate">
            <input
              key={`estimate-${task.updated_at}`}
              type="number"
              min={0}
              step={5}
              aria-label="Estimate in minutes"
              placeholder="minutes"
              defaultValue={task.estimate_min ?? ""}
              onBlur={(e) => {
                const raw = e.currentTarget.value;
                const value = raw === "" ? null : Math.max(0, Math.round(Number(raw)));
                if (value !== task.estimate_min && !Number.isNaN(value))
                  change([{ estimate_min: value }]);
              }}
              className={fieldInput}
            />
          </Field>
          <Field label="Project">
            <Select
              value={task.project_id ?? ""}
              onChange={(e) => change([{ project_id: e.target.value || null }])}
              aria-label="Project"
              className="w-full"
            >
              <option value="">Inbox (no project)</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Epic">
            <Select
              value={task.epic_id ?? ""}
              onChange={(e) => change([{ epic_id: e.target.value || null }])}
              aria-label="Epic"
              className="w-full"
            >
              <option value="">None</option>
              {Object.values(epics)
                .filter((e) => e.state === "active" || e.id === task.epic_id)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </Select>
          </Field>
          {parent && (
            <Field label="Parent">
              <button
                type="button"
                onClick={() => void setParent(store, task.id, null)}
                className="text-xs text-blue-600 hover:underline"
              >
                Promote to a top-level task
              </button>
            </Field>
          )}
          <Field label="Tags">
            <TagPicker task={task} />
          </Field>
        </div>

        <section>
          <h2 className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
            Description
          </h2>
          <DescriptionEditor
            value={task.description}
            onSave={(description) => change([{ description }])}
          />
        </section>

        <section>
          <h2 className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
            Subtasks
          </h2>
          <SubtaskList parent={task} />
        </section>

        <section>
          <h2 className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
            Activity
          </h2>
          <ActivityFeed task={task} />
        </section>
      </div>
    </aside>
  );
}
