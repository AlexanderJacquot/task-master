import { useSearch } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { cx, InlineInput, Select } from "../../components/ui";
import { buildBoard, type Swimlane } from "../../lib/board";
import { isoDate } from "../../lib/dates";
import type { TaskChange } from "../../lib/types";
import { buildRows, type ViewContext, type ViewKey } from "../../lib/views";
import { createTask, type NewTaskInput, toggleDone, updateTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import type { CardLookups } from "../board/BoardCard";
import { BoardView } from "../board/BoardView";
import { TaskList } from "../list/TaskList";
import { useOpenTask } from "./useOpenTask";
import { NEW_TASK_INPUT_ID } from "./useShortcuts";
import { useViewPrefs } from "./useViewPrefs";

function toggle(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

const SWIMLANES: Array<{ value: Swimlane; label: string }> = [
  { value: "none", label: "No swimlanes" },
  { value: "project", label: "Lanes by project" },
  { value: "epic", label: "Lanes by epic" },
  { value: "priority", label: "Lanes by priority" },
];

/** A view's tasks as a list (grouped by status) or a board, with a capture input on top. */
export function ViewPage({
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
  const epics = useStoreState((s) => s.epics);
  const tags = useStoreState((s) => s.tags);
  const statuses = useStoreState((s) => s.statuses);
  const { task: selectedId } = useSearch({ strict: false }) as { task?: string };
  const openTask = useOpenTask();
  const [prefs, setPrefs] = useViewPrefs(view);
  const board = prefs.layout === "board";

  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [collapsedTasks, setCollapsedTasks] = useState<ReadonlySet<string>>(new Set());
  const today = isoDate();
  // Route components pass a fresh literal each render; key the memos on its content.
  const viewKey = JSON.stringify(view);
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable by content (viewKey)
  const stableView = useMemo(() => view, [viewKey]);
  const showProject = view.kind !== "project";

  const ctx: ViewContext = useMemo(
    () => ({ today, statuses: Object.fromEntries(statuses.map((s) => [s.id, s])), projects }),
    [today, statuses, projects],
  );
  const rows = useMemo(
    () =>
      board
        ? []
        : buildRows(Object.values(tasks), stableView, ctx, statuses, {
            showCancelled: prefs.showCancelled,
            collapsedGroups,
            collapsedTasks,
          }),
    [board, tasks, stableView, ctx, statuses, prefs.showCancelled, collapsedGroups, collapsedTasks],
  );
  const boardModel = useMemo(
    () =>
      board
        ? buildBoard(
            Object.values(tasks),
            stableView,
            ctx,
            statuses,
            { projects, epics },
            {
              swimlane: prefs.swimlane,
              showSubtasks: prefs.showSubtasks,
              showCancelled: prefs.showCancelled,
            },
          )
        : null,
    [board, tasks, stableView, ctx, statuses, projects, epics, prefs],
  );
  const lookups: CardLookups = useMemo(
    () => ({ statuses, projects, epics, tags, today, showProject }),
    [statuses, projects, epics, tags, today, showProject],
  );
  const taskCount = boardModel
    ? boardModel.columns.reduce((n, c) => n + c.count, 0)
    : rows.reduce((n, r) => n + (r.type === "task" ? 1 : 0), 0);

  const onChange = useCallback(
    (id: string, changes: TaskChange[]) => void updateTask(store, id, changes),
    [store],
  );
  const onToggleDone = useCallback((id: string) => void toggleDone(store, id), [store]);
  const onToggleCollapse = useCallback((id: string) => setCollapsedTasks((s) => toggle(s, id)), []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <h1 className="flex-1 truncate text-lg font-semibold">{title}</h1>
        <span className="text-xs text-neutral-500">
          {taskCount} {taskCount === 1 ? "task" : "tasks"}
        </span>
        {board && (
          <>
            <Select
              aria-label="Swimlanes"
              value={prefs.swimlane}
              onChange={(e) => setPrefs({ swimlane: e.target.value as Swimlane })}
              className="text-xs text-neutral-600 dark:text-neutral-400"
            >
              {SWIMLANES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-1 text-xs text-neutral-500">
              <input
                type="checkbox"
                checked={prefs.showSubtasks}
                onChange={(e) => setPrefs({ showSubtasks: e.target.checked })}
              />
              Subtasks
            </label>
          </>
        )}
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          <input
            type="checkbox"
            checked={prefs.showCancelled}
            onChange={(e) => setPrefs({ showCancelled: e.target.checked })}
          />
          Show cancelled
        </label>
        <fieldset
          aria-label="Layout"
          className="flex overflow-hidden rounded border border-neutral-300 text-xs dark:border-neutral-700"
        >
          {(["list", "board"] as const).map((layout) => (
            <button
              key={layout}
              type="button"
              aria-pressed={prefs.layout === layout}
              onClick={() => setPrefs({ layout })}
              className={cx(
                "px-2 py-0.5 capitalize",
                prefs.layout === layout
                  ? "bg-neutral-200 font-medium dark:bg-neutral-800"
                  : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900",
              )}
            >
              {layout}
            </button>
          ))}
        </fieldset>
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
      {boardModel ? (
        <BoardView
          board={boardModel}
          lookups={lookups}
          selectedId={selectedId ?? null}
          onOpen={openTask}
        />
      ) : rows.length === 0 ? (
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
          showProject={showProject}
        />
      )}
    </div>
  );
}
