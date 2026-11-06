import { useNavigate, useSearch } from "@tanstack/react-router";
import { Columns3, Filter, List, SlidersHorizontal } from "lucide-react";
import { Popover } from "radix-ui";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { BookmarkIcon as Bookmark, SearchIcon as Search } from "../../components/TaskIcons";
import { Button, cx, FOCUS, InlineInput, Select } from "../../components/ui";
import { buildBoard } from "../../lib/board";
import { loadOpenInPanel } from "../../lib/capturePrefs";
import { isoDate } from "../../lib/dates";
import type { GroupBy, SortBy, Swimlane, TaskChange, View, ViewScope } from "../../lib/types";
import { buildRows, filterIsEmpty, type ViewContext } from "../../lib/views";
import {
  createView,
  deleteView,
  type NewTaskInput,
  toggleDone,
  updateTask,
  updateView,
} from "../../store/actions";
import { useApi, useStoreState, useTaskStore } from "../../store/context";
import type { CardLookups } from "../board/BoardCard";
import { BoardView } from "../board/BoardView";
import { CAPTURE_HINT, CaptureBox } from "../capture/CaptureBox";
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
  eyebrow,
}: {
  scope: ViewScope;
  title: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
  eyebrow?: ReactNode;
}) {
  const [display, setDisplay] = useViewPrefs(scope);
  return (
    <ViewBody
      scope={scope}
      title={title}
      eyebrow={eyebrow}
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
    <Button size="sm" variant={primary ? "primary" : "secondary"} onClick={onClick}>
      {children}
    </Button>
  );
}

function DisplayRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-ink-2">{label}</span>
      {children}
    </div>
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
  eyebrow,
}: {
  scope: ViewScope;
  title: ReactNode;
  /** Small line above the title (a project's area). */
  eyebrow?: ReactNode;
  display: ViewDisplay;
  setDisplay(patch: Partial<ViewDisplay>): void;
  /** Extra header buttons (saved views: save, revert, delete). */
  actions?: ReactNode;
  /** Shown under the header (an epic's fields and progress). */
  details?: ReactNode;
}) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const api = useApi();
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [searchIds, setSearchIds] = useState<Set<string> | null>(null);
  const [searchError, setSearchError] = useState(false);
  const [searching, setSearching] = useState(false);
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const epics = useStoreState((s) => s.epics);
  const tags = useStoreState((s) => s.tags);
  const statuses = useStoreState((s) => s.statuses);
  const { task: selectedId } = useSearch({ strict: false }) as { task?: string };
  const openTask = useOpenTask();
  const board = display.layout === "board";
  const [savingAs, setSavingAs] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const filtersShown = showFilters || !filterIsEmpty(display.filter);

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
  const searchingAll = scope.kind === "all" && !!query;
  useEffect(() => {
    if (!searchingAll) {
      setSearchIds(null);
      setSearchError(false);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(false);
    api.search(query, Math.max(1, Object.keys(tasks).length)).then(
      (ids) => {
        if (!cancelled) {
          setSearchIds(new Set(ids));
          setSearching(false);
        }
      },
      () => {
        if (!cancelled) {
          setSearchIds(new Set());
          setSearchError(true);
          setSearching(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, query, searchingAll, tasks]);
  const visibleTasks = useMemo(
    () => Object.values(tasks).filter((task) => !searchingAll || searchIds?.has(task.id)),
    [tasks, searchingAll, searchIds],
  );
  const rows = useMemo(
    () =>
      board
        ? []
        : buildRows(visibleTasks, spec, ctx, statuses, { collapsedGroups, collapsedTasks }),
    [board, visibleTasks, spec, ctx, statuses, collapsedGroups, collapsedTasks],
  );
  const boardModel = useMemo(
    () => (board ? buildBoard(visibleTasks, spec, ctx, statuses, { projects, epics }) : null),
    [board, visibleTasks, spec, ctx, statuses, projects, epics],
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
  const onOpenPage = useCallback(
    (id: string) => void navigate({ to: "/task/$taskId", params: { taskId: id }, search: {} }),
    [navigate],
  );
  const onToggleCollapse = useCallback((id: string) => setCollapsedTasks((s) => toggle(s, id)), []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-end gap-x-4 gap-y-3 px-10 pt-7 pb-4">
        <div className="min-w-0 flex-1">
          {eyebrow && <div className="mb-0.5 text-[13px] text-ink-3">{eyebrow}</div>}
          <h1 className="flex min-w-0 items-center gap-3 font-display text-[34px] leading-tight font-normal tracking-wide">
            {title}
          </h1>
          <div className="mt-1 text-[13.5px] text-ink-2">
            {taskCount} {taskCount === 1 ? "task" : "tasks"}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <fieldset aria-label="Layout" className="flex rounded-[9px] bg-hover p-0.5 text-[13px]">
            {(["list", "board"] as const).map((layout) => (
              <button
                key={layout}
                type="button"
                aria-pressed={display.layout === layout}
                onClick={() => setDisplay({ layout })}
                className={cx(
                  "flex items-center gap-1.5 rounded-[7px] px-3 py-1 capitalize transition-colors",
                  FOCUS,
                  display.layout === layout
                    ? "bg-selected text-ink shadow-sm"
                    : "text-ink-2 hover:text-ink",
                )}
              >
                {layout === "list" ? <List size={14} /> : <Columns3 size={14} />}
                {layout}
              </button>
            ))}
          </fieldset>
          <Popover.Root>
            <Popover.Trigger asChild>
              <Button size="sm">
                <SlidersHorizontal size={14} />
                Display
              </Button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="end"
                sideOffset={6}
                className="z-40 flex w-64 flex-col gap-3 rounded-xl border border-line-strong bg-overlay p-3 text-sm shadow-xl"
              >
                {board ? (
                  <>
                    <DisplayRow label="Swimlanes">
                      <Select
                        aria-label="Swimlanes"
                        value={display.swimlane}
                        onValueChange={(swimlane) => setDisplay({ swimlane })}
                        className="w-36 border-line-strong"
                        options={SWIMLANES}
                      />
                    </DisplayRow>
                    <label className="flex items-center justify-between gap-2 text-ink-2">
                      Show subtasks
                      <input
                        type="checkbox"
                        checked={display.show_subtasks}
                        onChange={(e) => setDisplay({ show_subtasks: e.target.checked })}
                        className="accent-accent"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <DisplayRow label="Group">
                      <Select
                        aria-label="Group by"
                        value={display.group_by}
                        onValueChange={(group_by) => setDisplay({ group_by })}
                        className="w-36 border-line-strong"
                        options={GROUPS}
                      />
                    </DisplayRow>
                    <DisplayRow label="Sort">
                      <Select
                        aria-label="Sort"
                        value={display.sort}
                        onValueChange={(sort) => setDisplay({ sort })}
                        className="w-36 border-line-strong"
                        options={SORTS}
                      />
                    </DisplayRow>
                  </>
                )}
                <label className="flex items-center justify-between gap-2 text-ink-2">
                  Show cancelled
                  <input
                    type="checkbox"
                    checked={display.show_cancelled}
                    onChange={(e) => setDisplay({ show_cancelled: e.target.checked })}
                    className="accent-accent"
                  />
                </label>
                <label className="flex items-center justify-between gap-2 text-ink-2">
                  Show agent tasks
                  <input
                    type="checkbox"
                    checked={display.show_agent_tasks}
                    onChange={(e) => setDisplay({ show_agent_tasks: e.target.checked })}
                    className="accent-accent"
                  />
                </label>
                <div className="h-px bg-line" />
                {savingAs ? (
                  <InlineInput
                    initial=""
                    autoFocus
                    placeholder="Name of the new view"
                    onCommit={async (name) => {
                      setSavingAs(false);
                      const id = await createView(store, name, spec);
                      if (id) void navigate({ to: "/view/$viewId", params: { viewId: id } });
                    }}
                    onCancel={() => setSavingAs(false)}
                  />
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setSavingAs(true)}>
                    <Bookmark size={14} />
                    Save as view
                  </Button>
                )}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <Button
            size="sm"
            aria-pressed={filtersShown}
            onClick={() => setShowFilters((v) => !v)}
            className={cx(!filterIsEmpty(display.filter) && "border-accent text-accent")}
          >
            <Filter size={14} />
            Filter
          </Button>
          {actions}
        </div>
      </header>
      {details}
      {filtersShown && (
        <FilterBar
          filter={display.filter}
          onChange={(filter) => setDisplay({ filter })}
          statuses={statuses}
          projects={projects}
          epics={epics}
          tags={tags}
        />
      )}
      <div
        className={cx(
          "grid items-start gap-3 px-10 pt-1 pb-2",
          scope.kind === "all" && "grid-cols-2",
        )}
      >
        <CaptureBox
          id={NEW_TASK_INPUT_ID}
          className={scope.kind === "all" ? "min-w-0" : undefined}
          defaults={captureDefaults(scope, today)}
          placeholder={`Add a task${typeof title === "string" ? ` to ${title}` : ""}…   ${CAPTURE_HINT}`}
          onCaptured={(id, how) => {
            if (how.open)
              void navigate({
                to: "/task/$taskId",
                params: { taskId: id },
                search: { focus: "description" },
              });
            // Settings → Adding tasks: the new task opens in the side panel, ready to write.
            else if (loadOpenInPanel())
              void navigate({
                to: ".",
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  task: id,
                  focus: "description" as const,
                }),
              });
          }}
        />
        {scope.kind === "all" && (
          <form
            aria-label="Search all tasks"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(searchText.trim());
            }}
            className="flex min-w-0 flex-col gap-1.5"
          >
            <div className="flex items-center gap-3 rounded-[10px] border border-line-strong px-3.5 py-1.5 focus-within:border-accent focus-within:bg-raised/60">
              <Search size={16} className="shrink-0 text-rubric" aria-hidden />
              <input
                type="search"
                aria-label="Search all tasks"
                placeholder="Search task titles and descriptions…"
                value={searchText}
                onChange={(event) => {
                  setSearchText(event.target.value);
                  if (!event.target.value.trim()) setQuery("");
                }}
                className="min-w-0 flex-1 bg-transparent py-0.5 text-ink placeholder:text-ink-3 focus:outline-none"
              />
              <Button size="sm" type="submit">
                Search
              </Button>
            </div>
            <div aria-live="polite" className="px-1 text-xs text-ink-3">
              {searching
                ? "Searching…"
                : searchingAll && !searchError
                  ? `${taskCount} matching ${taskCount === 1 ? "task" : "tasks"}`
                  : null}
            </div>
            {searchError && (
              <p role="alert" className="px-1 text-xs text-danger">
                Could not search tasks. Clear the search and try again.
              </p>
            )}
          </form>
        )}
      </div>
      {boardModel ? (
        <BoardView
          board={boardModel}
          lookups={lookups}
          selectedId={selectedId ?? null}
          onOpen={openTask}
        />
      ) : rows.length === 0 ? (
        <p className="p-10 text-center font-display text-lg text-ink-3">
          {searchingAll
            ? searching
              ? "Searching…"
              : searchError
                ? "Search unavailable."
                : "No matching tasks."
            : scope.kind === "inbox"
              ? "Inbox zero. Nothing to triage."
              : "No tasks here yet."}
        </p>
      ) : (
        <TaskList
          rows={rows}
          selectedId={selectedId ?? null}
          collapsedTasks={collapsedTasks}
          onToggleGroup={(id) => setCollapsedGroups((s) => toggle(s, id))}
          onOpen={openTask}
          onOpenPage={onOpenPage}
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
