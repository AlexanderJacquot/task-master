import { useNavigate, useSearch } from "@tanstack/react-router";
import { Popover } from "radix-ui";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkIcon as Bookmark,
  ColumnsIcon as Columns3,
  FilterIcon as Filter,
  ListIcon as List,
  UndoIcon as Reset,
  SearchIcon as Search,
  OptionsIcon as SlidersHorizontal,
} from "../../components/TaskIcons";
import { Button, cx, FOCUS, InlineInput, Select } from "../../components/ui";
import { buildBoard, type Lane, laneFields } from "../../lib/board";
import { loadOpenInPanel, withDefaultProject } from "../../lib/capturePrefs";
import { isoDate } from "../../lib/dates";
import {
  type ClickMods,
  clickSelect,
  EMPTY_SELECTION,
  pruneSelection,
  type Selection,
  selectAll,
} from "../../lib/selection";
import type { GroupBy, SortBy, Swimlane, TaskChange, View, ViewScope } from "../../lib/types";
import { buildRows, filterIsEmpty, listedIds, type ViewContext } from "../../lib/views";
import {
  createTask,
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
import { clearColumnPrefs } from "../board/useBoardColumns";
import { clearLaneChoices } from "../board/useCollapsedLanes";
import { CAPTURE_HINT, CaptureBox } from "../capture/CaptureBox";
import { TaskList } from "../list/TaskList";
import { EmptyArt, TitleCrest, TitleFlourish } from "../ornaments/Ornaments";
import { BulkBar } from "./BulkBar";
import { EditableTitle } from "./EditableTitle";
import { FilterBar } from "./FilterBar";
import { useOpenTask } from "./useOpenTask";
import { isEditable, NEW_TASK_INPUT_ID } from "./useShortcuts";
import { DEFAULT_DISPLAY, displayOf, specOf, useViewPrefs, type ViewDisplay } from "./useViewPrefs";

function toggle(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** `set` with `id` in it or not; the same set when nothing changes. */
function setMember(set: ReadonlySet<string>, id: string, member: boolean): ReadonlySet<string> {
  if (set.has(id) === member) return set;
  const next = new Set(set);
  if (member) next.add(id);
  else next.delete(id);
  return next;
}

/** Keys pressed inside these belong to them (Esc closes the menu, not the selection). */
const MENUS_AND_DIALOGS = "[role=menu],[role=listbox],[role=dialog]";

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
  // Subtasks folded or unrolled by hand in the list (over the default of the row's depth).
  const [collapsedTasks, setCollapsedTasks] = useState<ReadonlySet<string>>(new Set());
  const [expandedTasks, setExpandedTasks] = useState<ReadonlySet<string>>(new Set());
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
  // Search narrows whichever view is open (list or board); the view's own filters still apply.
  const searchActive = !!query;
  // Filter live while typing: follow the input after a short pause (clearing is immediate).
  useEffect(() => {
    const text = searchText.trim();
    if (!text) {
      setQuery("");
      return;
    }
    const timer = setTimeout(() => setQuery(text), 150);
    return () => clearTimeout(timer);
  }, [searchText]);
  useEffect(() => {
    if (!searchActive) {
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
  }, [api, query, searchActive, tasks]);
  const visibleTasks = useMemo(
    () => Object.values(tasks).filter((task) => !searchActive || searchIds?.has(task.id)),
    [tasks, searchActive, searchIds],
  );
  const rows = useMemo(
    () =>
      board
        ? []
        : buildRows(visibleTasks, spec, ctx, statuses, {
            collapsedGroups,
            collapsedTasks,
            expandedTasks,
          }),
    [board, visibleTasks, spec, ctx, statuses, collapsedGroups, collapsedTasks, expandedTasks],
  );
  // Read by the chevron's handler, which stays stable so memoized rows do not re-render.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const boardModel = useMemo(
    () => (board ? buildBoard(visibleTasks, spec, ctx, statuses, { projects, epics }) : null),
    [board, visibleTasks, spec, ctx, statuses, projects, epics],
  );
  const lookups: CardLookups = useMemo(
    () => ({ statuses, projects, epics, tags, today, showProject }),
    [statuses, projects, epics, tags, today, showProject],
  );
  /** The "+" by a swimlane's name: the view's capture defaults, then the lane's field. */
  const addToLane = useCallback(
    (lane: Lane, title: string) => {
      const input: Omit<NewTaskInput, "title"> = {
        ...captureDefaults(stableScope, today),
        ...laneFields(lane),
      };
      // An epic lane outside a project: the task goes to the epic's home project.
      const home = input.epic_id ? epics[input.epic_id]?.project_id : null;
      if (input.project_id === undefined && home) input.project_id = home;
      void createTask(store, {
        ...withDefaultProject(input, projects, stableScope.kind === "inbox"),
        title,
      });
    },
    [store, stableScope, today, epics, projects],
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
  // Multi-select: Ctrl/Shift+click on rows or cards, Ctrl+A for all, Esc to clear.
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new scope starts empty
  useEffect(() => setSelection(EMPTY_SELECTION), [scopeKey]);
  /** The tasks on screen, top to bottom (the board: lane by lane, column by column). */
  const order = useMemo(
    () =>
      boardModel
        ? boardModel.lanes.flatMap((lane) =>
            boardModel.columns.flatMap((c) =>
              (lane.cells[c.status.id] ?? []).map((card) => card.task.id),
            ),
          )
        : rows.flatMap((r) => (r.type === "task" ? [r.task.id] : [])),
    [boardModel, rows],
  );
  // Tasks that leave the view (another status, filtered out, deleted) leave the selection.
  // Folding a group or a parent hides rows without taking them out of the view.
  const picking = selection.ids.size > 0;
  const inView = useMemo(() => {
    if (!picking) return null;
    return boardModel ? new Set(order) : listedIds(visibleTasks, spec, ctx);
  }, [picking, boardModel, order, visibleTasks, spec, ctx]);
  useEffect(() => {
    if (inView) setSelection((s) => pruneSelection(s, inView));
  }, [inView]);
  // Read by the stable click and key handlers, so memoized rows and cards do not re-render.
  const pickRef = useRef({ order, open: selectedId ?? null, picking });
  pickRef.current = { order, open: selectedId ?? null, picking };
  const onPick = useCallback((id: string, mods: ClickMods) => {
    const now = pickRef.current;
    setSelection((s) => clickSelect(s, id, mods, now.order, now.open));
  }, []);
  const clearSelection = useCallback(() => setSelection(EMPTY_SELECTION), []);
  /** A plain click opens the task and drops the selection, as in a file manager. */
  const onOpen = useCallback(
    (id: string) => {
      setSelection(EMPTY_SELECTION);
      openTask(id);
    },
    [openTask],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      if (e.target instanceof Element && e.target.closest(MENUS_AND_DIALOGS)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelection(selectAll(pickRef.current.order));
      } else if (e.key === "Escape" && !e.defaultPrevented && pickRef.current.picking) {
        // Clearing the selection is this Esc's whole job: the panel stays open.
        e.preventDefault();
        setSelection(EMPTY_SELECTION);
      }
    };
    // Capture: runs before the app-wide Esc (close the panel) on the window.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Bumped by Reset view: remounts the board so it reads its cleared column and lane layout.
  const [boardEpoch, setBoardEpoch] = useState(0);
  /**
   * Reset view: the default display (filters, grouping, sort, swimlanes, toggles) in the
   * same layout, no search, groups and subtasks folded as by default, and on the board every
   * column open and sharing the width equally, with lanes collapsed as by default.
   */
  const resetView = () => {
    if (boardModel) {
      clearColumnPrefs(boardModel.columns.map((c) => c.status.id));
      clearLaneChoices(boardModel.lanes.map((l) => l.key));
      setBoardEpoch((n) => n + 1);
    }
    setDisplay({ ...DEFAULT_DISPLAY, layout: display.layout, lineage: display.lineage });
    setSearchText("");
    setQuery("");
    setShowFilters(false);
    setCollapsedGroups(new Set());
    setCollapsedTasks(new Set());
    setExpandedTasks(new Set());
    setSelection(EMPTY_SELECTION);
  };

  const onToggleCollapse = useCallback((id: string) => {
    const row = rowsRef.current.find((r) => r.type === "task" && r.task.id === id);
    const expanded = row?.type === "task" && row.expanded;
    // Folding an unrolled row, or unrolling a folded one.
    setCollapsedTasks((s) => setMember(s, id, expanded));
    setExpandedTasks((s) => setMember(s, id, !expanded));
  }, []);
  /** "Show subtasks" sets every row's default again, so hand choices are dropped. */
  const setShowSubtasks = useCallback(
    (show_subtasks: boolean) => {
      setCollapsedTasks(new Set());
      setExpandedTasks(new Set());
      setDisplay({ show_subtasks });
    },
    [setDisplay],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-end gap-x-4 gap-y-3 px-10 pt-7 pb-4">
        <div className="min-w-0 flex-1">
          {eyebrow && <div className="mb-0.5 text-[13px] text-ink-3">{eyebrow}</div>}
          <h1 className="flex min-w-0 items-center gap-3 font-display text-[34px] leading-tight font-normal tracking-wide">
            <TitleCrest />
            {title}
          </h1>
          <TitleFlourish />
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
                  <DisplayRow label="Swimlanes">
                    <Select
                      aria-label="Swimlanes"
                      value={display.swimlane}
                      onValueChange={(swimlane) => setDisplay({ swimlane })}
                      className="w-36 border-line-strong"
                      options={SWIMLANES}
                    />
                  </DisplayRow>
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
                <label
                  className="flex items-center justify-between gap-2 text-ink-2"
                  title={
                    board
                      ? "Subtasks at every level get their own cards"
                      : "Unroll subtasks at every level"
                  }
                >
                  Show subtasks
                  <input
                    type="checkbox"
                    checked={display.show_subtasks}
                    onChange={(e) => setShowSubtasks(e.target.checked)}
                    className="accent-accent"
                  />
                </label>
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
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={resetView}
                  title={
                    board
                      ? "Clear filters and search; default display; every column open and sized to fit"
                      : "Clear filters and search; default grouping, sort and display"
                  }
                >
                  <Reset size={14} />
                  Reset view
                </Button>
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
      <div className="grid grid-cols-2 items-start gap-3 px-10 pt-1 pb-2">
        <CaptureBox
          id={NEW_TASK_INPUT_ID}
          className="min-w-0"
          defaults={withDefaultProject(
            captureDefaults(scope, today),
            projects,
            scope.kind === "inbox",
          )}
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
        <form
          aria-label="Search tasks"
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
              aria-label="Search tasks"
              placeholder="Search task titles and descriptions…"
              value={searchText}
              onChange={(event) => {
                setSearchText(event.target.value);
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
              : searchActive && !searchError
                ? `${taskCount} matching ${taskCount === 1 ? "task" : "tasks"}`
                : null}
          </div>
          {searchError && (
            <p role="alert" className="px-1 text-xs text-danger">
              Could not search tasks. Clear the search and try again.
            </p>
          )}
        </form>
      </div>
      {boardModel ? (
        <BoardView
          key={boardEpoch}
          board={boardModel}
          lookups={lookups}
          selectedId={selectedId ?? null}
          picked={selection.ids}
          onOpen={onOpen}
          onPick={onPick}
          onAdd={addToLane}
        />
      ) : rows.length === 0 ? (
        <EmptyArt>
          {searchActive
            ? searching
              ? "Searching…"
              : searchError
                ? "Search unavailable."
                : "No matching tasks."
            : scope.kind === "inbox"
              ? "Inbox zero. Nothing to triage."
              : "No tasks here yet."}
        </EmptyArt>
      ) : (
        <TaskList
          rows={rows}
          selectedId={selectedId ?? null}
          picked={selection.ids}
          onPick={onPick}
          onToggleGroup={(id) => setCollapsedGroups((s) => toggle(s, id))}
          onOpen={onOpen}
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
      {picking && <BulkBar ids={selection.ids} onClear={clearSelection} />}
    </div>
  );
}
