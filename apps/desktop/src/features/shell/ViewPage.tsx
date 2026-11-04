import { useNavigate, useSearch } from "@tanstack/react-router";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { cx, InlineInput, Select } from "../../components/ui";
import { buildBoard } from "../../lib/board";
import { isoDate } from "../../lib/dates";
import type { GroupBy, SortBy, Swimlane, TaskChange, View, ViewScope } from "../../lib/types";
import { buildRows, type ViewContext } from "../../lib/views";
import {
  createView,
  deleteView,
  type NewTaskInput,
  toggleDone,
  updateTask,
  updateView,
} from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import type { CardLookups } from "../board/BoardCard";
import { BoardView } from "../board/BoardView";
import { CaptureBox } from "../capture/CaptureBox";
import { TaskList } from "../list/TaskList";
import { EditableTitle } from "./EditableTitle";
import { FilterBar } from "./FilterBar";
import { useOpenTask } from "./useOpenTask";
import { NEW_TASK_INPUT_ID } from "./useShortcuts";
import { displayOf, specOf, useViewPrefs, type ViewDisplay } from "./useViewPrefs";

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

const GROUPS: Array<{ value: GroupBy; label: string }> = [
  { value: "status", label: "Group by status" },
  { value: "project", label: "Group by project" },
  { value: "epic", label: "Group by epic" },
  { value: "priority", label: "Group by priority" },
  { value: "due", label: "Group by due date" },
];

const SORTS: Array<{ value: SortBy; label: string }> = [
  { value: "default", label: "Smart order" },
  { value: "manual", label: "Manual order" },
  { value: "due", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "created", label: "Newest first" },
  { value: "updated", label: "Recently updated" },
];

/** What a task captured in this scope gets, so it shows up where it was typed. */
function captureDefaults(scope: ViewScope, today: string): Omit<NewTaskInput, "title"> {
  switch (scope.kind) {
    case "project":
      return { project_id: scope.id };
    case "epic":
      return { epic_id: scope.id };
    case "tag":
      return { tag_ids: [scope.id] };
    case "today":
      return { today_on: today };
    default:
      return {};
  }
}

/** A built-in view (Inbox, Today, a project...): display choices are kept per machine. */
export function ViewPage({
  scope,
  title,
  actions,
  details,
}: {
  scope: ViewScope;
  title: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
}) {
  const [display, setDisplay] = useViewPrefs(scope);
  return (
    <ViewBody
      scope={scope}
      title={title}
      display={display}
      setDisplay={setDisplay}
      actions={actions}
      details={details}
    />
  );
}

/** A saved view: edits are a draft until saved, so the view reopens as it was saved. */
export function SavedViewPage({ view }: { view: View }) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const saved = useMemo(() => displayOf(view.spec), [view.spec]);
  const [draft, setDraft] = useState<ViewDisplay>(saved);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const setDisplay = useCallback(
    (patch: Partial<ViewDisplay>) => setDraft((d) => ({ ...d, ...patch })),
    [],
  );

  const title = (
    <EditableTitle
      value={view.name}
      placeholder="View name"
      onRename={(name) => void updateView(store, view.id, [{ name }])}
    />
  );

  return (
    <ViewBody
      scope={view.spec.scope}
      title={title}
      display={draft}
      setDisplay={setDisplay}
      actions={
        <>
          {dirty && (
            <>
              <HeaderButton onClick={() => setDraft(saved)}>Revert</HeaderButton>
              <HeaderButton
                primary
                onClick={() =>
                  void updateView(store, view.id, [{ spec: specOf(view.spec.scope, draft) }])
                }
              >
                Save view
              </HeaderButton>
            </>
          )}
          <HeaderButton
            onClick={async () => {
              if ((await deleteView(store, view.id)) !== null) void navigate({ to: "/inbox" });
            }}
          >
            Delete view
          </HeaderButton>
        </>
      }
    />
  );
}

export function HeaderButton({
  onClick,
  primary,
  children,
}: {
  onClick(): void;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "rounded px-2 py-0.5 text-xs",
        primary
          ? "bg-blue-600 text-white hover:bg-blue-700"
          : "border border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900",
      )}
    >
      {children}
    </button>
  );
}

/** A view's tasks as a list (grouped) or a board, with filters and a capture input. */
function ViewBody({
  scope,
  title,
  display,
  setDisplay,
  actions,
  details,
}: {
  scope: ViewScope;
  title: ReactNode;
  display: ViewDisplay;
  setDisplay(patch: Partial<ViewDisplay>): void;
  /** Extra header buttons (saved views: save, revert, delete). */
  actions?: ReactNode;
  /** Shown under the header (an epic's fields and progress). */
  details?: ReactNode;
}) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const epics = useStoreState((s) => s.epics);
  const tags = useStoreState((s) => s.tags);
  const statuses = useStoreState((s) => s.statuses);
  const { task: selectedId } = useSearch({ strict: false }) as { task?: string };
  const openTask = useOpenTask();
  const board = display.layout === "board";
  const [savingAs, setSavingAs] = useState(false);

  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [collapsedTasks, setCollapsedTasks] = useState<ReadonlySet<string>>(new Set());
  const today = isoDate();
  // Route components pass a fresh scope literal each render; key the memos on its content.
  const scopeKey = JSON.stringify(scope);
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable by content (scopeKey)
  const stableScope = useMemo(() => scope, [scopeKey]);
  const showProject = scope.kind !== "project";

  const ctx: ViewContext = useMemo(
    () => ({
      today,
      statuses: Object.fromEntries(statuses.map((s) => [s.id, s])),
      projects,
      epics,
    }),
    [today, statuses, projects, epics],
  );
  const spec = useMemo(() => specOf(stableScope, display), [stableScope, display]);
  const rows = useMemo(
    () =>
      board
        ? []
        : buildRows(Object.values(tasks), spec, ctx, statuses, { collapsedGroups, collapsedTasks }),
    [board, tasks, spec, ctx, statuses, collapsedGroups, collapsedTasks],
  );
  const boardModel = useMemo(
    () =>
      board ? buildBoard(Object.values(tasks), spec, ctx, statuses, { projects, epics }) : null,
    [board, tasks, spec, ctx, statuses, projects, epics],
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
        <h1 className="flex min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
        <span className="text-xs text-neutral-500">
          {taskCount} {taskCount === 1 ? "task" : "tasks"}
        </span>
        {board ? (
          <>
            <Select
              aria-label="Swimlanes"
              value={display.swimlane}
              onChange={(e) => setDisplay({ swimlane: e.target.value as Swimlane })}
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
                checked={display.show_subtasks}
                onChange={(e) => setDisplay({ show_subtasks: e.target.checked })}
              />
              Subtasks
            </label>
          </>
        ) : (
          <>
            <Select
              aria-label="Group by"
              value={display.group_by}
              onChange={(e) => setDisplay({ group_by: e.target.value as GroupBy })}
              className="text-xs text-neutral-600 dark:text-neutral-400"
            >
              {GROUPS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Sort"
              value={display.sort}
              onChange={(e) => setDisplay({ sort: e.target.value as SortBy })}
              className="text-xs text-neutral-600 dark:text-neutral-400"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </>
        )}
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          <input
            type="checkbox"
            checked={display.show_cancelled}
            onChange={(e) => setDisplay({ show_cancelled: e.target.checked })}
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
              aria-pressed={display.layout === layout}
              onClick={() => setDisplay({ layout })}
              className={cx(
                "px-2 py-0.5 capitalize",
                display.layout === layout
                  ? "bg-neutral-200 font-medium dark:bg-neutral-800"
                  : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900",
              )}
            >
              {layout}
            </button>
          ))}
        </fieldset>
        {actions}
        {savingAs ? (
          <InlineInput
            initial=""
            placeholder="Name of the new view"
            className="w-48"
            onCommit={async (name) => {
              setSavingAs(false);
              const id = await createView(store, name, spec);
              if (id) void navigate({ to: "/view/$viewId", params: { viewId: id } });
            }}
            onCancel={() => setSavingAs(false)}
          />
        ) : (
          <HeaderButton onClick={() => setSavingAs(true)}>Save as view</HeaderButton>
        )}
      </header>
      {details}
      <FilterBar
        filter={display.filter}
        onChange={(filter) => setDisplay({ filter })}
        statuses={statuses}
        projects={projects}
        epics={epics}
        tags={tags}
      />
      <div className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <CaptureBox id={NEW_TASK_INPUT_ID} defaults={captureDefaults(scope, today)} />
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
          {scope.kind === "inbox" ? "Inbox zero. Nothing to triage." : "No tasks here yet."}
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
