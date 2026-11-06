import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRight, Minus, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { LineageIcon as GitBranch } from "../../components/TaskIcons";
import { cx, FOCUS, IconButton, Select } from "../../components/ui";
import { updateTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { useOpenTask } from "../shell/useOpenTask";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH, wouldCycle } from "./graph";

const control = "rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink";

export function LineagePage() {
  const store = useTaskStore();
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const statuses = useStoreState((s) => s.statuses);
  const pending = useStoreState((s) => s.pending);
  const openTask = useOpenTask();
  const [selected, setSelected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [project, setProject] = useState("");
  const [linkedOnly, setLinkedOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState<"prerequisite" | "dependent">("prerequisite");
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ x: 0, y: 0, width: 1400, height: 1000 });
  const canvas = useRef<HTMLDivElement>(null);
  const marker = useId();
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const update = () =>
      setViewport({
        x: element.scrollLeft,
        y: element.scrollTop,
        width: element.clientWidth,
        height: element.clientHeight,
      });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);
  const all = useMemo(
    () =>
      Object.values(tasks).sort((a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id)),
    [tasks],
  );
  const linked = useMemo(
    () =>
      new Set(
        all.flatMap((task) =>
          (task.dependency_ids ?? []).length ? [task.id, ...(task.dependency_ids ?? [])] : [],
        ),
      ),
    [all],
  );
  const graph = useMemo(
    () =>
      layoutGraph(
        all.filter(
          (task) =>
            (!project || task.project_id === project) && (!linkedOnly || linked.has(task.id)),
        ),
      ),
    [all, project, linkedOnly, linked],
  );
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
    }
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
          Connect tasks into chains and branches. Arrows run from prerequisite to dependent.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Select
            aria-label="Filter lineage by project"
            className={cx(control, FOCUS)}
            value={project}
            onValueChange={setProject}
            options={[
              { value: "", label: "All projects" },
              ...Object.values(projects).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={linkedOnly}
              onChange={(e) => setLinkedOnly(e.target.checked)}
            />
            Connected tasks only
          </label>
          <span className="text-xs text-ink-3">
            {graph.nodes.length} tasks · {graph.edges.length} links
          </span>
          <div className="ml-auto flex items-center gap-1">
            <IconButton label="Zoom out" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}>
              <Minus size={16} />
            </IconButton>
            <button
              type="button"
              className={cx("px-2 text-xs text-ink-2", FOCUS)}
              onClick={() => setZoom(1)}
              title="Reset zoom"
            >
              {Math.round(zoom * 100)}%
            </button>
            <IconButton label="Zoom in" onClick={() => setZoom((z) => Math.min(1.8, z + 0.2))}>
              <Plus size={16} />
            </IconButton>
          </div>
        </div>
      </header>
      {connecting && tasks[connecting] && (
        <div
          className="flex items-center gap-3 border-b border-line bg-accent/10 px-6 py-3 text-sm text-ink"
          role="status"
        >
          Select a task that depends on “{tasks[connecting].title}”.
          <button
            type="button"
            className={cx("underline", FOCUS)}
            onClick={() => {
              setConnecting(null);
              setError("");
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="px-6 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-wrap">
        <div
          ref={canvas}
          className="relative min-h-64 min-w-0 flex-1 overflow-auto bg-hover/30"
          onScroll={(e) =>
            setViewport({
              x: e.currentTarget.scrollLeft,
              y: e.currentTarget.scrollTop,
              width: e.currentTarget.clientWidth,
              height: e.currentTarget.clientHeight,
            })
          }
        >
          {!graph.nodes.length ? (
            <div className="p-10 text-center text-ink-3">
              <GitBranch className="mx-auto mb-3" size={32} />
              <p>No tasks to display.</p>
              <p className="mt-2 text-sm">Add tasks from Inbox, or change the filters above.</p>
            </div>
          ) : (
            <div style={{ width: graph.width * zoom, height: graph.height * zoom }}>
              <div
                className="relative origin-top-left"
                style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}
              >
                <svg
                  className="pointer-events-none absolute inset-0 text-ink-3"
                  width={graph.width}
                  height={graph.height}
                  aria-label="Dependency arrows"
                  role="img"
                >
                  <title>Arrows point from prerequisites to dependent tasks</title>
                  <defs>
                    <marker
                      id={marker}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                    </marker>
                  </defs>
                  {graph.edges.map(({ from, to }) => {
                    const x = from.x + NODE_WIDTH;
                    const y = from.y + NODE_HEIGHT / 2;
                    const endY = to.y + NODE_HEIGHT / 2;
                    const highlighted = from.task.id === selected || to.task.id === selected;
                    return (
                      <path
                        key={`${from.task.id}:${to.task.id}`}
                        d={`M ${x} ${y} C ${x + 45} ${y}, ${to.x - 45} ${endY}, ${to.x - 5} ${endY}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={highlighted ? 2.5 : 1.5}
                        className={highlighted ? "text-accent" : ""}
                        markerEnd={`url(#${marker})`}
                      />
                    );
                  })}
                </svg>
                {graph.nodes
                  .filter(
                    (node) =>
                      node.x * zoom < viewport.x + viewport.width + 400 &&
                      (node.x + NODE_WIDTH) * zoom > viewport.x - 400 &&
                      node.y * zoom < viewport.y + viewport.height + 400 &&
                      (node.y + NODE_HEIGHT) * zoom > viewport.y - 400,
                  )
                  .map(({ task, x, y }) => {
                    const status = statuses.find((s) => s.id === task.status_id);
                    return (
                      <button
                        key={task.id}
                        type="button"
                        aria-label={`Select ${task.title}`}
                        aria-pressed={selected === task.id}
                        onClick={() => {
                          if (connecting) void connect(connecting, task.id);
                          else {
                            setSelected(task.id);
                            setQuery("");
                            setError("");
                          }
                        }}
                        onDoubleClick={() => {
                          if (!connecting) openTask(task.id);
                        }}
                        className={cx(
                          "absolute flex flex-col justify-between rounded-xl border bg-surface p-4 text-left shadow-sm transition-colors hover:border-accent",
                          selected === task.id
                            ? "border-accent ring-2 ring-accent/20"
                            : "border-line-strong",
                          FOCUS,
                        )}
                        style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                      >
                        <span className="line-clamp-2 text-sm font-medium text-ink">
                          {task.title}
                        </span>
                        <span className="flex w-full items-center justify-between gap-2 text-xs text-ink-3">
                          <span>{status?.name}</span>
                          <span>{task.dependency_ids?.length ?? 0} prerequisites</span>
                        </span>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
        <aside
          aria-label="Dependency editor"
          className="w-72 shrink-0 overflow-y-auto border-l border-line bg-surface p-5"
        >
          {!current ? (
            <p className="text-sm text-ink-3">
              Select a task to edit its prerequisites and dependents. Double-click a task to open
              its details.
            </p>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-display text-xl text-ink">{current.title}</h2>
                <IconButton label="Clear selection" onClick={() => setSelected(null)}>
                  <X size={15} />
                </IconButton>
              </div>
              <button
                type="button"
                className={cx("mt-2 text-sm text-accent underline", FOCUS)}
                onClick={() => openTask(current.id)}
              >
                Open task details
              </button>
              <h3 className="mt-6 text-sm font-medium text-ink">
                Prerequisites ({prerequisites.length})
              </h3>
              <RelationshipList
                ids={prerequisites}
                render={(id) => (
                  <div className="flex h-11 items-center gap-2 border-b border-line text-sm text-ink-2">
                    <span className="min-w-0 flex-1 truncate" title={tasks[id]?.title}>
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
              {!prerequisites.length && (
                <p className="mt-2 text-xs text-ink-3">No prerequisites.</p>
              )}
              <h3 className="mt-5 text-sm font-medium text-ink">
                Dependents ({dependents.length})
              </h3>
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
                  setConnecting(current.id);
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
                  No matching tasks available. Existing connections and circular chains are
                  excluded.
                </p>
              )}
              {candidates.length > 50 && (
                <p className="mt-3 text-xs text-ink-3">
                  Search to narrow {candidates.length} tasks.
                </p>
              )}
            </>
          )}
        </aside>
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
