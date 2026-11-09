import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useMemo, useRef, useState } from "react";
import {
  ArrowRightIcon as ArrowRight,
  LineageIcon as GitBranch,
  SearchIcon as Search,
  CloseIcon as X,
} from "../../components/TaskIcons";
import { cx, FOCUS, IconButton, Select } from "../../components/ui";
import type { Task } from "../../lib/types";
import { FILTER_NONE } from "../../lib/views";
import { copyBelonging, createTask, setParent, updateTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { MultiPick } from "../shell/FilterBar";
import { useOpenTask } from "../shell/useOpenTask";
import { parentCandidates, subtaskCandidates } from "../task-detail/hierarchy";
import type { Connector } from "./canvas";
import {
  type Completion,
  closedTaskIds,
  downstream,
  filterLineage,
  layoutGraph,
  openBlockers,
  wouldCycle,
} from "./graph";
import { LineageCanvas } from "./LineageCanvas";
import type { Arrange, LaneSpec } from "./lanes";

const control = "rounded-lg border border-line-strong bg-raised px-3 py-2 text-sm text-ink";

/** Filters survive leaving the page, like the canvas layout (a local view preference). */
const FILTER_KEY = "task-master.lineage-filter";
type SavedFilter = {
  project: string;
  /** Epic ids, or `FILTER_NONE` for tasks without an epic; empty shows all. */
  epics: string[];
  /** Tag ids, or `FILTER_NONE` for tasks without tags; empty shows all. */
  tags: string[];
  completion: Completion;
  linkedOnly: boolean;
  /** Show subtasks (tasks with a parent) on the canvas. */
  subtasks: boolean;
  arrange: Arrange;
};
function loadFilter(): SavedFilter {
  const fallback: SavedFilter = {
    project: "",
    epics: [],
    tags: [],
    completion: "all",
    linkedOnly: false,
    subtasks: true,
    arrange: "free",
  };
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}");
    return {
      project: typeof raw?.project === "string" ? raw.project : "",
      epics: savedIds(raw?.epics, raw?.epic),
      tags: savedIds(raw?.tags, raw?.tag),
      completion: ["all", "open", "ready"].includes(raw?.completion) ? raw.completion : "all",
      linkedOnly: raw?.linkedOnly === true,
      subtasks: raw?.subtasks !== false,
      arrange: ["free", "epic", "project"].includes(raw?.arrange) ? raw.arrange : "free",
    };
  } catch {
    return fallback;
  }
}

/** A saved list of ids; filters saved before 0.10.1 held a single id ("" for all). */
function savedIds(list: unknown, single: unknown): string[] {
  if (Array.isArray(list)) return list.filter((id): id is string => typeof id === "string");
  return typeof single === "string" && single ? [single] : [];
}

/** A task created from the side panel, to place beside the card it was linked to. */
type Placement = { id: string; near: string; side: Connector["side"] };

/** Whether the side panel is open survives leaving the page (open by default). */
const PANEL_KEY = "task-master.lineage-panel";
function loadPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) !== "closed";
  } catch {
    return true;
  }
}

function LinkChip({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={disabled ? "Already linked, or the link would make a circular chain" : label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "shrink-0 rounded-md border border-line-strong px-1.5 py-0.5 text-[11px] text-ink-2 hover:border-accent hover:text-accent disabled:opacity-35 disabled:hover:border-line-strong disabled:hover:text-ink-2",
        FOCUS,
      )}
    >
      + {children}
    </button>
  );
}

/** `around`: open on one task's lineage (from a task's "Lineage" button). */
export function LineagePage({ around }: { around?: string } = {}) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const tags = useStoreState((s) => s.tags);
  const epics = useStoreState((s) => s.epics);
  const statuses = useStoreState((s) => s.statuses);
  const pending = useStoreState((s) => s.pending);
  const openTask = useOpenTask();
  const [selected, setSelected] = useState<string | null>(around ?? null);
  const [connecting, setConnecting] = useState<Connector | null>(null);
  const [filter, setFilter] = useState(loadFilter);
  const { project, completion, linkedOnly, subtasks, arrange } = filter;
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [panelOpen, setPanelOpen] = useState(loadPanelOpen);
  const [reveal, setReveal] = useState<{ id: string; seq: number } | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [wholeChain, setWholeChain] = useState(false);
  const all = useMemo(
    () =>
      Object.values(tasks).sort((a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id)),
    [tasks],
  );
  const closed = useMemo(() => closedTaskIds(all, statuses), [all, statuses]);
  const focus = around && tasks[around] ? tasks[around] : undefined;
  const graph = useMemo(
    () =>
      layoutGraph(
        filterLineage(all, tasks, closed, {
          project,
          epics: filter.epics,
          tags: filter.tags,
          completion,
          linkedOnly,
          subtasks,
          around: focus?.id,
        }),
      ),
    [
      all,
      tasks,
      closed,
      project,
      filter.epics,
      filter.tags,
      completion,
      linkedOnly,
      subtasks,
      focus?.id,
    ],
  );
  /** Lanes in order: epics (or projects) by rank, the "none" lane last. */
  const laneSpecs = useMemo((): LaneSpec[] => {
    if (arrange === "free") return [];
    const present = new Set(
      graph.nodes.map((node) => (arrange === "epic" ? node.task.epic_id : node.task.project_id)),
    );
    const byRank = <T extends { rank: string }>(a: T, b: T) => (a.rank < b.rank ? -1 : 1);
    const picked = filter.epics.filter((id) => id !== FILTER_NONE);
    const specs: LaneSpec[] =
      arrange === "epic"
        ? Object.values(epics)
            .filter(
              (e) =>
                present.has(e.id) ||
                // Empty lanes for active epics in view, to drop cards into.
                (e.state === "active" &&
                  !focus &&
                  (picked.length ? picked.includes(e.id) : !filter.epics.length) &&
                  (!project || !e.project_id || e.project_id === project)),
            )
            .sort(byRank)
            .map((e) => ({ key: e.id, label: e.name, color: e.color }))
        : Object.values(projects)
            .filter((p) => present.has(p.id) || (!focus && p.id === project))
            .sort(byRank)
            .map((p) => ({ key: p.id, label: p.name, color: p.color }));
    const showNone =
      present.has(null) ||
      (!focus &&
        (arrange === "epic"
          ? !filter.epics.length || filter.epics.includes(FILTER_NONE)
          : !project));
    if (showNone)
      specs.push({
        key: FILTER_NONE,
        label: arrange === "epic" ? "No epic" : "No project",
        color: null,
      });
    return specs;
  }, [arrange, graph.nodes, epics, projects, filter.epics, project, focus]);
  const blocked = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of all) {
      const count = closed.has(task.id) ? 0 : openBlockers(task, tasks, closed).length;
      if (count) counts[task.id] = count;
    }
    return counts;
  }, [all, tasks, closed]);
  /** Epics shown under a project filter: that project's, plus epics without a project. */
  const epicFits = (id: string, projectId: string) =>
    id === FILTER_NONE || !epics[id]?.project_id || epics[id]?.project_id === projectId;
  /** Arranging keeps the selection: the same cards stay, only their places change. */
  function changeArrange(value: Arrange) {
    const next = { ...filter, arrange: value };
    setFilter(next);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(next));
    } catch {
      /* Arranging still works without storage. */
    }
  }
  function changeFilter(next: Partial<SavedFilter>) {
    const value = { ...filter, ...next };
    setFilter(value);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(value));
    } catch {
      /* Filters still work without storage. */
    }
    setSelected(null);
    setConnecting(null);
    setError("");
  }
  const current = selected ? tasks[selected] : undefined;
  const prerequisites = current?.dependency_ids ?? [];
  const dependents = all.filter((task) => task.dependency_ids?.includes(selected ?? ""));
  const search = query.trim().toLowerCase();
  const results = search ? all.filter((task) => task.title.toLowerCase().includes(search)) : [];
  const onCanvas = useMemo(() => new Set(graph.nodes.map((node) => node.task.id)), [graph.nodes]);
  /**
   * Tasks to browse without typing. With a card selected: its epic's tasks, then its
   * project's. Otherwise: tasks the filters match that the canvas doesn't show (only its
   * connected tasks, or one task's lineage).
   */
  const browse = useMemo((): { title: string; tasks: Task[] } | null => {
    if (search) return null;
    const mine = all.filter((task) => task.owner !== "agent");
    if (current) {
      const rank = (task: Task) =>
        current.epic_id && task.epic_id === current.epic_id
          ? 0
          : current.project_id && task.project_id === current.project_id
            ? 1
            : 2;
      const list = mine
        .filter((task) => task.id !== current.id && rank(task) < 2)
        .sort((a, b) => rank(a) - rank(b) || Number(closed.has(a.id)) - Number(closed.has(b.id)));
      return {
        title: current.epic_id ? "Same epic, then same project" : "Same project",
        tasks: list,
      };
    }
    const inScope = filterLineage(mine, tasks, closed, {
      project,
      epics: filter.epics,
      tags: filter.tags,
      completion,
      linkedOnly: false,
      subtasks,
    }).filter((task) => !onCanvas.has(task.id));
    return { title: "Not on the canvas", tasks: inScope };
  }, [
    search,
    all,
    current,
    closed,
    tasks,
    project,
    filter.epics,
    filter.tags,
    completion,
    subtasks,
    onCanvas,
  ]);
  const canLink = (from: string, to: string) =>
    from !== to && !tasks[to]?.dependency_ids?.includes(from) && !wouldCycle(tasks, from, to);
  const canParent = useMemo(
    () => ({
      parents: new Set(selected ? parentCandidates(selected, tasks).map((t) => t.id) : []),
      subtasks: new Set(selected ? subtaskCandidates(selected, tasks).map((t) => t.id) : []),
    }),
    [selected, tasks],
  );
  /** Dependents that don't share the selected task's project, epic or tags yet. */
  const followers = current
    ? (wholeChain ? downstream(current.id, all) : dependents.map((task) => task.id))
        .map((id) => tasks[id])
        .filter(
          (task): task is Task =>
            !!task &&
            ((task.project_id ?? null) !== (current.project_id ?? null) ||
              (task.epic_id ?? null) !== (current.epic_id ?? null) ||
              current.tag_ids.some((tag) => !task.tag_ids.includes(tag))),
        )
    : [];

  function togglePanel(open: boolean) {
    setPanelOpen(open);
    try {
      localStorage.setItem(PANEL_KEY, open ? "open" : "closed");
    } catch {
      /* The panel still toggles without storage. */
    }
  }
  /** A search result: select it and bring its card into view, or open its lineage. */
  function show(id: string) {
    setSelected(id);
    setConnecting(null);
    setError("");
    if (onCanvas.has(id)) setReveal({ id, seq: Date.now() });
    else void navigate({ to: "/lineage", search: { around: id } });
  }
  async function createFromPanel(side: Connector["side"]) {
    if (!current || !query.trim()) return;
    const id = await addLinked(current.id, side, { title: query.trim() });
    if (id) {
      setPlacement({ id, near: current.id, side });
      setQuery("");
    }
  }
  async function copyToFollowers() {
    if (!current || !followers.length) return;
    const result = await copyBelonging(
      store,
      current.id,
      followers.map((task) => task.id),
    );
    if (!result) setError(store.getState().lastError ?? "Could not update the dependents.");
  }

  async function connect(from: string, to: string) {
    if (store.getState().pending > 0) return;
    const tasks = store.getState().tasks;
    if (!tasks[from] || !tasks[to]) return;
    if (wouldCycle(tasks, from, to)) {
      setError("This link would create a circular chain. Choose another task.");
      return;
    }
    if (tasks[to]?.dependency_ids?.includes(from)) {
      setError("These tasks are already connected.");
      return;
    }
    const result = await updateTask(store, to, [
      { dependency_ids: [...(tasks[to]?.dependency_ids ?? []), from] },
    ]);
    if (result) {
      setConnecting(null);
      setError("");
    } else {
      setError(store.getState().lastError ?? "Could not save the connection. Please try again.");
    }
  }
  /** A plus button on a card: link a new task (by title) or an existing one. */
  async function addLinked(
    id: string,
    side: Connector["side"],
    pick: { title: string } | { existing: string },
  ): Promise<string | null> {
    const source = store.getState().tasks[id];
    if (!source) return null;
    if ("existing" in pick) {
      const [from, to] = side === "out" ? [id, pick.existing] : [pick.existing, id];
      await connect(from, to);
      return null;
    }
    const created = await createTask(
      store,
      {
        title: pick.title,
        // A linked task belongs where its card does: same project, epic and tags,
        // moved inside the current filters when its card is only shown as a focus.
        project_id: project || source.project_id,
        epic_id: insideEpics(source.epic_id),
        tag_ids: insideTags(source.tag_ids),
      },
      { link: side === "out" ? { dependentOf: id } : { prerequisiteOf: id } },
    );
    if (!created) setError(store.getState().lastError ?? "Could not create the task.");
    return created;
  }
  function insideEpics(epicId: string | null): string | null {
    const picked = filter.epics;
    if (!picked.length || picked.includes(epicId ?? FILTER_NONE)) return epicId;
    return picked.includes(FILTER_NONE) ? null : (picked[0] ?? epicId);
  }
  function insideTags(tagIds: string[]): string[] {
    const picked = filter.tags;
    if (!picked.length) return tagIds;
    if (tagIds.length ? tagIds.some((id) => picked.includes(id)) : picked.includes(FILTER_NONE))
      return tagIds;
    const first = picked.find((id) => id !== FILTER_NONE);
    return first ? [...tagIds, first] : tagIds;
  }
  /** A card dropped into another lane takes that lane's epic or project. */
  function moveToLane(id: string, key: string) {
    if (arrange === "free") return;
    const value = key === FILTER_NONE ? null : key;
    void updateTask(
      store,
      id,
      arrange === "epic" ? [{ epic_id: value }] : [{ project_id: value }],
    ).then((result) => {
      if (!result) setError(store.getState().lastError ?? "Could not move the task.");
    });
  }
  /** Makes `child` a subtask of `parent`, or a top-level task when null. */
  async function adopt(child: string, parent: string | null) {
    if (store.getState().pending > 0) return;
    const result = await setParent(store, child, parent);
    if (result) setError("");
    else setError(store.getState().lastError ?? "Could not change the parent.");
  }
  function remove(from: string, to: string) {
    void updateTask(store, to, [
      { dependency_ids: (tasks[to]?.dependency_ids ?? []).filter((id) => id !== from) },
    ]);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-6 py-5">
        <div className="flex items-center gap-3">
          <GitBranch size={24} className="text-rubric" />
          <h1 className="font-display text-3xl text-ink">Lineage</h1>
        </div>
        <p className="mt-2 text-sm text-ink-3">
          Arrange tasks on the canvas. Drag a connector between cards to link a prerequisite to its
          dependent.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {focus && (
            <span className="flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 py-1 pr-1 pl-3 text-sm text-ink">
              <span className="max-w-64 truncate">Lineage of “{focus.title}”</span>
              <IconButton
                label="Show all tasks"
                className="size-6"
                onClick={() => void navigate({ to: "/lineage", search: {} })}
              >
                <X size={13} />
              </IconButton>
            </span>
          )}
          <Select
            aria-label="Filter lineage by project"
            className={cx(control, FOCUS)}
            value={project}
            onValueChange={(value) =>
              changeFilter({
                project: value,
                // Drop picked epics that belong to another project.
                epics: filter.epics.filter((id) => !value || epicFits(id, value)),
              })
            }
            options={[
              { value: "", label: "All projects" },
              ...Object.values(projects).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          <MultiPick
            label="Epic"
            ariaLabel="Filter lineage by epic"
            options={[
              { value: FILTER_NONE, label: "No epic" },
              ...Object.values(epics)
                .filter((e) => !project || epicFits(e.id, project))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((e) => ({ value: e.id, label: e.name, color: e.color })),
            ]}
            selected={filter.epics}
            onChange={(next) => changeFilter({ epics: next })}
          />
          <MultiPick
            label="Tags"
            ariaLabel="Filter lineage by tag"
            options={[
              { value: FILTER_NONE, label: "No tag" },
              ...Object.values(tags)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((t) => ({ value: t.id, label: `#${t.name}`, color: t.color })),
            ]}
            selected={filter.tags}
            onChange={(next) => changeFilter({ tags: next })}
          />
          <Select<Completion>
            aria-label="Filter lineage by completion"
            className={cx(control, FOCUS)}
            value={completion}
            onValueChange={(value) => changeFilter({ completion: value })}
            options={[
              { value: "all", label: "Open and done" },
              { value: "open", label: "Open only" },
              { value: "ready", label: "Ready (not blocked)" },
            ]}
          />
          <Select<Arrange>
            aria-label="Arrange lineage"
            className={cx(control, FOCUS)}
            value={arrange}
            onValueChange={(value) => changeArrange(value)}
            options={[
              { value: "free", label: "Freeform" },
              { value: "epic", label: "Lanes by epic" },
              { value: "project", label: "Lanes by project" },
            ]}
          />
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={linkedOnly}
              onChange={(e) => changeFilter({ linkedOnly: e.target.checked })}
            />
            Connected tasks only
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={subtasks}
              onChange={(e) => changeFilter({ subtasks: e.target.checked })}
            />
            Show subtasks
          </label>
          <span className="text-xs text-ink-3">
            {graph.nodes.length} tasks · {graph.edges.length} links
          </span>
        </div>
      </header>
      {error && (
        <p role="alert" className="px-6 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <LineageCanvas
          graph={graph}
          scope={`${project}:${filter.epics.join(",")}:${filter.tags.join(",")}:${completion}:${linkedOnly}:${subtasks}:${focus?.id ?? ""}:${arrange}`}
          arrange={arrange}
          laneSpecs={laneSpecs}
          epics={epics}
          onMoveToLane={moveToLane}
          fitOnOpen={!!focus}
          statuses={statuses}
          closed={closed}
          blocked={blocked}
          tasks={all}
          onAddLinked={addLinked}
          projects={projects}
          selected={selected}
          connecting={connecting}
          pending={pending > 0}
          onSelect={(id) => {
            setSelected(id);
            setError("");
          }}
          reveal={reveal}
          placement={placement}
          onOpen={openTask}
          onStartConnection={(connector) => {
            setConnecting(connector);
            setError("");
          }}
          onCancelConnection={() => {
            setConnecting(null);
            setError("");
          }}
          onConnect={(from, to) => {
            void connect(from, to);
          }}
          onDisconnect={remove}
          canConnect={(from, to) =>
            !tasks[to]?.dependency_ids?.includes(from) && !wouldCycle(tasks, from, to)
          }
        />
        {!panelOpen && (
          <div className="shrink-0 border-l border-line bg-raised p-2">
            <IconButton label="Show the lineage panel" onClick={() => togglePanel(true)}>
              <Search size={16} />
            </IconButton>
          </div>
        )}
        {panelOpen && (
          <aside
            aria-label="Lineage panel"
            className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-line bg-raised p-5"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-ink">Find a task</h2>
              <IconButton label="Hide the lineage panel" onClick={() => togglePanel(false)}>
                <X size={15} />
              </IconButton>
            </div>
            <input
              type="search"
              aria-label="Search tasks"
              placeholder="Search tasks…"
              className={cx(control, "mt-2 w-full", FOCUS)}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
            />
            <p className="mt-2 text-xs text-ink-3">
              {current
                ? `Click a result to select it, or link it to “${current.title}”: as a prerequisite, a dependent, its parent or a subtask.`
                : "Click a result to find it on the canvas, or select a card to link tasks to it."}
            </p>
            {search && (
              <div className="mt-2 flex max-h-80 flex-col overflow-y-auto">
                {current &&
                  (["in", "out"] as const).map((side) => (
                    <button
                      key={side}
                      type="button"
                      disabled={pending > 0}
                      className={cx(
                        "truncate rounded-lg px-2 py-1.5 text-left text-sm text-ink hover:bg-hover disabled:opacity-50",
                        FOCUS,
                      )}
                      onClick={() => void createFromPanel(side)}
                    >
                      + New {side === "in" ? "prerequisite" : "dependent"} “{query.trim()}”
                    </button>
                  ))}
                <ul aria-label="Search results" className="mt-1 border-t border-line">
                  {results.slice(0, 50).map((task) => (
                    <SearchResult
                      key={task.id}
                      task={task}
                      current={current}
                      selected={task.id === current?.id}
                      done={closed.has(task.id)}
                      visible={onCanvas.has(task.id)}
                      busy={pending > 0}
                      canLink={canLink}
                      canParent={canParent}
                      onShow={show}
                      onConnect={(from, to) => void connect(from, to)}
                      onSetParent={(child, parent) => void adopt(child, parent)}
                    />
                  ))}
                </ul>
                {!results.length && <p className="mt-2 text-xs text-ink-3">No matching tasks.</p>}
                {results.length > 50 && (
                  <p className="mt-2 text-xs text-ink-3">
                    Showing 50 of {results.length}. Type more to narrow.
                  </p>
                )}
              </div>
            )}
            {browse && browse.tasks.length > 0 && (
              <section aria-label="Browse tasks" className="mt-4">
                <h3 className="text-xs font-medium tracking-wide text-ink-3 uppercase">
                  {browse.title}
                </h3>
                <ul aria-label={browse.title} className="mt-1 max-h-72 overflow-y-auto">
                  {browse.tasks.slice(0, 40).map((task) => (
                    <SearchResult
                      key={task.id}
                      task={task}
                      current={current}
                      selected={false}
                      done={closed.has(task.id)}
                      visible={onCanvas.has(task.id)}
                      busy={pending > 0}
                      canLink={canLink}
                      canParent={canParent}
                      onShow={show}
                      onConnect={(from, to) => void connect(from, to)}
                      onSetParent={(child, parent) => void adopt(child, parent)}
                    />
                  ))}
                </ul>
                {browse.tasks.length > 40 && (
                  <p className="mt-1 text-xs text-ink-3">
                    Showing 40 of {browse.tasks.length}. Search to narrow.
                  </p>
                )}
              </section>
            )}
            {current && (
              <section aria-label="Dependency editor" className="mt-6 border-t border-line pt-5">
                <DependencyEditor
                  current={current}
                  isFocus={focus?.id === current.id}
                  tasks={tasks}
                  prerequisites={prerequisites}
                  dependents={dependents.map((task) => task.id)}
                  closed={closed}
                  blockers={blocked[current.id] ?? 0}
                  busy={pending > 0}
                  followers={followers.length}
                  wholeChain={wholeChain}
                  onWholeChain={setWholeChain}
                  onCopy={() => void copyToFollowers()}
                  onClear={() => setSelected(null)}
                  onOpen={() => openTask(current.id)}
                  onShowLineage={() =>
                    void navigate({ to: "/lineage", search: { around: current.id } })
                  }
                  onRemove={remove}
                  onSetParent={(child, parent) => void adopt(child, parent)}
                  onConnectOnGraph={() => {
                    setConnecting({ id: current.id, side: "out" });
                    setError("");
                  }}
                />
              </section>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

/** A row of the side panel's search: show the task, or link it to the selected one. */
function SearchResult({
  task,
  current,
  selected,
  done,
  visible,
  busy,
  canLink,
  canParent,
  onShow,
  onConnect,
  onSetParent,
}: {
  task: Task;
  current: Task | undefined;
  selected: boolean;
  done: boolean;
  visible: boolean;
  busy: boolean;
  canLink: (from: string, to: string) => boolean;
  /** Tasks that can become the selected task's parent, or its subtasks. */
  canParent: { parents: Set<string>; subtasks: Set<string> };
  onShow: (id: string) => void;
  onConnect: (from: string, to: string) => void;
  onSetParent: (child: string, parent: string) => void;
}) {
  return (
    <li className="flex h-10 items-center gap-1 border-b border-line last:border-b-0">
      <button
        type="button"
        title={visible ? "Show on the canvas" : "Open its lineage"}
        className={cx(
          "min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-sm hover:bg-hover",
          selected ? "font-medium text-accent" : "text-ink-2",
          done && "text-ink-3 line-through",
          FOCUS,
        )}
        onClick={() => onShow(task.id)}
      >
        {task.title}
      </button>
      {current && !selected && (
        <>
          <LinkChip
            label={`Add ${task.title} as a prerequisite`}
            disabled={busy || !canLink(task.id, current.id)}
            onClick={() => onConnect(task.id, current.id)}
          >
            Prereq
          </LinkChip>
          <LinkChip
            label={`Add ${task.title} as a dependent`}
            disabled={busy || !canLink(current.id, task.id)}
            onClick={() => onConnect(current.id, task.id)}
          >
            Dependent
          </LinkChip>
          <LinkChip
            label={`Make ${task.title} the parent`}
            disabled={busy || !canParent.parents.has(task.id)}
            onClick={() => onSetParent(current.id, task.id)}
          >
            Parent
          </LinkChip>
          <LinkChip
            label={`Make ${task.title} a subtask`}
            disabled={busy || !canParent.subtasks.has(task.id)}
            onClick={() => onSetParent(task.id, current.id)}
          >
            Subtask
          </LinkChip>
        </>
      )}
    </li>
  );
}

/** The selected task: its links, and making its dependents follow its project, epic and tags. */
function DependencyEditor({
  current,
  isFocus,
  tasks,
  prerequisites,
  dependents,
  closed,
  blockers,
  busy,
  followers,
  wholeChain,
  onWholeChain,
  onCopy,
  onClear,
  onOpen,
  onShowLineage,
  onRemove,
  onSetParent,
  onConnectOnGraph,
}: {
  current: Task;
  /** The page already shows only this task's lineage. */
  isFocus: boolean;
  tasks: Record<string, Task>;
  prerequisites: string[];
  dependents: string[];
  closed: Set<string>;
  blockers: number;
  busy: boolean;
  /** How many dependents the copy would change. */
  followers: number;
  wholeChain: boolean;
  onWholeChain: (value: boolean) => void;
  onCopy: () => void;
  onClear: () => void;
  onOpen: () => void;
  onShowLineage: () => void;
  onRemove: (from: string, to: string) => void;
  onSetParent: (child: string, parent: string | null) => void;
  onConnectOnGraph: () => void;
}) {
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-display text-xl text-ink">{current.title}</h2>
        <IconButton label="Clear selection" onClick={onClear}>
          <X size={15} />
        </IconButton>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <button
          type="button"
          className={cx("text-sm text-accent underline", FOCUS)}
          onClick={onOpen}
        >
          Open task details
        </button>
        {!isFocus && (
          <button
            type="button"
            className={cx("text-sm text-accent underline", FOCUS)}
            onClick={onShowLineage}
          >
            Show only its lineage
          </button>
        )}
      </div>
      {current.parent_id && (
        <div className="mt-3 flex items-center gap-2 text-sm text-ink-2">
          <span className="shrink-0 text-ink-3">Subtask of</span>
          <span className="min-w-0 flex-1 truncate" title={tasks[current.parent_id]?.title}>
            {tasks[current.parent_id]?.title ?? "Deleted task"}
          </span>
          <IconButton
            label="Make it a top-level task"
            disabled={busy}
            onClick={() => onSetParent(current.id, null)}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}
      <h3 className="mt-6 text-sm font-medium text-ink">Prerequisites ({prerequisites.length})</h3>
      <p className="mt-1 text-xs text-ink-3">
        {closed.has(current.id)
          ? "Done."
          : blockers
            ? `Blocked by ${blockers} open ${blockers === 1 ? "task" : "tasks"}.`
            : "Ready: nothing blocks it."}
      </p>
      <RelationshipList
        ids={prerequisites}
        render={(id) => (
          <div className="flex h-11 items-center gap-2 border-b border-line text-sm text-ink-2">
            <span
              className={cx("min-w-0 flex-1 truncate", closed.has(id) && "text-ink-3 line-through")}
              title={tasks[id]?.title}
            >
              {tasks[id]?.title ?? "Deleted task"}
            </span>
            <IconButton
              label={`Remove prerequisite ${tasks[id]?.title ?? "Deleted task"}`}
              disabled={busy}
              onClick={() => onRemove(id, current.id)}
            >
              <X size={14} />
            </IconButton>
          </div>
        )}
      />
      {!prerequisites.length && <p className="mt-2 text-xs text-ink-3">No prerequisites.</p>}
      <h3 className="mt-5 text-sm font-medium text-ink">Dependents ({dependents.length})</h3>
      <RelationshipList
        ids={dependents}
        render={(id) => (
          <div className="flex h-11 items-center gap-2 border-b border-line text-sm text-ink-2">
            <span className="min-w-0 flex-1 truncate" title={tasks[id]?.title}>
              {tasks[id]?.title}
            </span>
            <IconButton
              label={`Remove dependent ${tasks[id]?.title}`}
              disabled={busy}
              onClick={() => onRemove(current.id, id)}
            >
              <X size={14} />
            </IconButton>
          </div>
        )}
      />
      {!dependents.length && <p className="mt-2 text-xs text-ink-3">No dependents.</p>}
      <button
        type="button"
        disabled={busy}
        className={cx(control, "mt-5 flex w-full items-center justify-center gap-2", FOCUS)}
        onClick={onConnectOnGraph}
      >
        <ArrowRight size={15} />
        Connect on graph
      </button>
      <h3 className="mt-6 text-sm font-medium text-ink">Dependents follow this task</h3>
      <p className="mt-1 text-xs text-ink-3">
        Copy its project, epic and tags onto its dependents (tags they already have stay).
      </p>
      <label className="mt-2 flex items-center gap-2 text-xs text-ink-2">
        <input
          type="checkbox"
          checked={wholeChain}
          onChange={(e) => onWholeChain(e.target.checked)}
        />
        Include their dependents too (the whole chain)
      </label>
      <button
        type="button"
        disabled={busy || !followers}
        className={cx(control, "mt-2 w-full disabled:opacity-50", FOCUS)}
        onClick={onCopy}
      >
        {!dependents.length
          ? "No dependents"
          : followers
            ? `Apply to ${followers} ${followers === 1 ? "dependent" : "dependents"}`
            : "Dependents already match"}
      </button>
    </>
  );
}

function RelationshipList({ ids, render }: { ids: string[]; render(id: string): ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 44,
    overscan: 4,
    enabled: ids.length > 100,
  });
  return (
    <div ref={ref} className="mt-2 max-h-52 overflow-auto">
      {ids.length <= 100 ? (
        ids.map((id) => <div key={id}>{render(id)}</div>)
      ) : (
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const id = ids[row.index];
            return id ? (
              <div
                key={id}
                className="absolute inset-x-0 top-0"
                style={{ height: row.size, transform: `translateY(${row.start}px)` }}
              >
                {render(id)}
              </div>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}
