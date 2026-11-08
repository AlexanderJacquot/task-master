import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useMemo, useRef, useState } from "react";
import {
  ArrowRightIcon as ArrowRight,
  LineageIcon as GitBranch,
  CloseIcon as X,
} from "../../components/TaskIcons";
import { cx, FOCUS, IconButton, Select } from "../../components/ui";
import { createTask, updateTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { useOpenTask } from "../shell/useOpenTask";
import type { Connector } from "./canvas";
import {
  type Completion,
  closedTaskIds,
  filterLineage,
  layoutGraph,
  openBlockers,
  wouldCycle,
} from "./graph";
import { LineageCanvas } from "./LineageCanvas";

const control = "rounded-lg border border-line-strong bg-raised px-3 py-2 text-sm text-ink";

/** Filters survive leaving the page, like the canvas layout (a local view preference). */
const FILTER_KEY = "task-master.lineage-filter";
type SavedFilter = { project: string; tag: string; completion: Completion; linkedOnly: boolean };
function loadFilter(): SavedFilter {
  const fallback: SavedFilter = { project: "", tag: "", completion: "all", linkedOnly: false };
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}");
    return {
      project: typeof raw?.project === "string" ? raw.project : "",
      tag: typeof raw?.tag === "string" ? raw.tag : "",
      completion: ["all", "open", "ready"].includes(raw?.completion) ? raw.completion : "all",
      linkedOnly: raw?.linkedOnly === true,
    };
  } catch {
    return fallback;
  }
}

/** `around`: open on one task's lineage (from a task's "Lineage" button). */
export function LineagePage({ around }: { around?: string } = {}) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const tags = useStoreState((s) => s.tags);
  const statuses = useStoreState((s) => s.statuses);
  const pending = useStoreState((s) => s.pending);
  const openTask = useOpenTask();
  const [selected, setSelected] = useState<string | null>(around ?? null);
  const [connecting, setConnecting] = useState<Connector | null>(null);
  const [filter, setFilter] = useState(loadFilter);
  const { project, tag, completion, linkedOnly } = filter;
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState<"prerequisite" | "dependent">("prerequisite");
  const [error, setError] = useState("");
  const all = useMemo(
    () =>
      Object.values(tasks).sort((a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id)),
    [tasks],
  );
  const closed = useMemo(() => closedTaskIds(all, statuses), [all, statuses]);
  const focus = around && tasks[around] ? tasks[around] : undefined;
  const graph = useMemo(
    () => layoutGraph(filterLineage(all, tasks, closed, { ...filter, around: focus?.id })),
    [all, tasks, closed, filter, focus?.id],
  );
  const blocked = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of all) {
      const count = closed.has(task.id) ? 0 : openBlockers(task, tasks, closed).length;
      if (count) counts[task.id] = count;
    }
    return counts;
  }, [all, tasks, closed]);
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
  const candidates = current
    ? all.filter((task) => {
        const [from, to] =
          direction === "prerequisite" ? [task.id, current.id] : [current.id, task.id];
        return (
          !tasks[to]?.dependency_ids?.includes(from) &&
          !wouldCycle(tasks, from, to) &&
          task.title.toLowerCase().includes(query.toLowerCase())
        );
      })
    : [];

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
        // Keep the new card inside the current filters.
        project_id: project || source.project_id,
        epic_id: source.epic_id,
        ...(tag && { tag_ids: [tag] }),
      },
      { link: side === "out" ? { dependentOf: id } : { prerequisiteOf: id } },
    );
    if (!created) setError(store.getState().lastError ?? "Could not create the task.");
    return created;
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
            onValueChange={(value) => changeFilter({ project: value })}
            options={[
              { value: "", label: "All projects" },
              ...Object.values(projects).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          <Select
            aria-label="Filter lineage by tag"
            className={cx(control, FOCUS)}
            value={tag}
            onValueChange={(value) => changeFilter({ tag: value })}
            options={[
              { value: "", label: "All tags" },
              ...Object.values(tags)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((t) => ({ value: t.id, label: `#${t.name}` })),
            ]}
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
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={linkedOnly}
              onChange={(e) => changeFilter({ linkedOnly: e.target.checked })}
            />
            Connected tasks only
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
          scope={`${project}:${tag}:${completion}:${linkedOnly}:${focus?.id ?? ""}`}
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
            setQuery("");
            setError("");
          }}
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
          canConnect={(from, to) =>
            !tasks[to]?.dependency_ids?.includes(from) && !wouldCycle(tasks, from, to)
          }
        />
        {current && (
          <aside
            aria-label="Dependency editor"
            className="w-72 shrink-0 overflow-y-auto border-l border-line bg-raised p-5"
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-display text-xl text-ink">{current.title}</h2>
              <IconButton label="Clear selection" onClick={() => setSelected(null)}>
                <X size={15} />
              </IconButton>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              <button
                type="button"
                className={cx("text-sm text-accent underline", FOCUS)}
                onClick={() => openTask(current.id)}
              >
                Open task details
              </button>
              {focus?.id !== current.id && (
                <button
                  type="button"
                  className={cx("text-sm text-accent underline", FOCUS)}
                  onClick={() => void navigate({ to: "/lineage", search: { around: current.id } })}
                >
                  Show only its lineage
                </button>
              )}
            </div>
            <h3 className="mt-6 text-sm font-medium text-ink">
              Prerequisites ({prerequisites.length})
            </h3>
            <p className="mt-1 text-xs text-ink-3">
              {closed.has(current.id)
                ? "Done."
                : blocked[current.id]
                  ? `Blocked by ${blocked[current.id]} open ${blocked[current.id] === 1 ? "task" : "tasks"}.`
                  : "Ready: nothing blocks it."}
            </p>
            <RelationshipList
              ids={prerequisites}
              render={(id) => (
                <div className="flex h-11 items-center gap-2 border-b border-line text-sm text-ink-2">
                  <span
                    className={cx(
                      "min-w-0 flex-1 truncate",
                      closed.has(id) && "text-ink-3 line-through",
                    )}
                    title={tasks[id]?.title}
                  >
                    {tasks[id]?.title ?? "Deleted task"}
                  </span>
                  <IconButton
                    label={`Remove prerequisite ${tasks[id]?.title ?? "Deleted task"}`}
                    disabled={pending > 0}
                    onClick={() => remove(id, current.id)}
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              )}
            />
            {!prerequisites.length && <p className="mt-2 text-xs text-ink-3">No prerequisites.</p>}
            <h3 className="mt-5 text-sm font-medium text-ink">Dependents ({dependents.length})</h3>
            <RelationshipList
              ids={dependents.map((task) => task.id)}
              render={(id) => (
                <div className="flex h-11 items-center gap-2 border-b border-line text-sm text-ink-2">
                  <span className="min-w-0 flex-1 truncate" title={tasks[id]?.title}>
                    {tasks[id]?.title}
                  </span>
                  <IconButton
                    label={`Remove dependent ${tasks[id]?.title}`}
                    disabled={pending > 0}
                    onClick={() => remove(current.id, id)}
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              )}
            />
            {!dependents.length && <p className="mt-2 text-xs text-ink-3">No dependents.</p>}
            <button
              type="button"
              disabled={pending > 0}
              className={cx(control, "mt-5 flex w-full items-center justify-center gap-2", FOCUS)}
              onClick={() => {
                setConnecting({ id: current.id, side: "out" });
                setError("");
              }}
            >
              <ArrowRight size={15} />
              Connect on graph
            </button>
            <h3 className="mt-6 text-sm font-medium text-ink">Add a connection</h3>
            <Select<typeof direction>
              aria-label="Connection type"
              className={cx(control, "mt-2 w-full", FOCUS)}
              value={direction}
              onValueChange={setDirection}
              options={[
                { value: "prerequisite", label: "Add prerequisite" },
                { value: "dependent", label: "Add dependent" },
              ]}
            />
            <input
              aria-label="Find task to connect"
              placeholder="Search tasks…"
              className={cx(control, "mt-2 w-full", FOCUS)}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="mt-2 flex flex-col gap-1">
              {candidates.slice(0, 50).map((task) => (
                <button
                  type="button"
                  key={task.id}
                  disabled={pending > 0}
                  className={cx(
                    "rounded-lg px-2 py-2 text-left text-sm text-ink-2 hover:bg-hover disabled:opacity-50",
                    FOCUS,
                  )}
                  onClick={() =>
                    void (direction === "prerequisite"
                      ? connect(task.id, current.id)
                      : connect(current.id, task.id))
                  }
                >
                  + {task.title}
                </button>
              ))}
            </div>
            {!candidates.length && (
              <p className="mt-3 text-xs text-ink-3">
                No matching tasks available. Existing connections and circular chains are excluded.
              </p>
            )}
            {candidates.length > 50 && (
              <p className="mt-3 text-xs text-ink-3">Search to narrow {candidates.length} tasks.</p>
            )}
          </aside>
        )}
      </div>
    </div>
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
