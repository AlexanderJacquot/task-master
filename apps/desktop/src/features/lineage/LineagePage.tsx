import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRight, X } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { LineageIcon as GitBranch } from "../../components/TaskIcons";
import { cx, FOCUS, IconButton, Select } from "../../components/ui";
import { updateTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { useOpenTask } from "../shell/useOpenTask";
import type { Connector } from "./canvas";
import { layoutGraph, wouldCycle } from "./graph";
import { LineageCanvas } from "./LineageCanvas";

const control = "rounded-lg border border-line-strong bg-raised px-3 py-2 text-sm text-ink";

export function LineagePage() {
  const store = useTaskStore();
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const statuses = useStoreState((s) => s.statuses);
  const pending = useStoreState((s) => s.pending);
  const openTask = useOpenTask();
  const [selected, setSelected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Connector | null>(null);
  const [project, setProject] = useState("");
  const [linkedOnly, setLinkedOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState<"prerequisite" | "dependent">("prerequisite");
  const [error, setError] = useState("");
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
          <Select
            aria-label="Filter lineage by project"
            className={cx(control, FOCUS)}
            value={project}
            onValueChange={(value) => {
              setProject(value);
              setSelected(null);
              setConnecting(null);
              setError("");
            }}
            options={[
              { value: "", label: "All projects" },
              ...Object.values(projects).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={linkedOnly}
              onChange={(e) => {
                setLinkedOnly(e.target.checked);
                setSelected(null);
                setConnecting(null);
                setError("");
              }}
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
          scope={`${project}:${linkedOnly}`}
          statuses={statuses}
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
