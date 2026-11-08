import { GripVertical } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ExpandIcon as Expand,
  BranchIcon as GitBranch,
  GridIcon as LayoutGrid,
  MinusIcon as Minus,
  PointerIcon as MousePointer2,
  AddIcon as Plus,
  CloseIcon as X,
} from "../../components/TaskIcons";
import { Button, cx, Dot, FOCUS, IconButton } from "../../components/ui";
import type { Project, Status, Task } from "../../lib/types";
import { ProjectMark } from "../organize/ProjectMark";
import {
  type Camera,
  type Connector,
  connectionPath,
  connectorPoint,
  fitCamera,
  freeSlot,
  loadCanvas,
  type Point,
  type Positions,
  saveCanvas,
  worldPoint,
  zoomAt,
} from "./canvas";
import { type layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "./graph";

type Graph = ReturnType<typeof layoutGraph>;
type Node = Graph["nodes"][number];
type Gesture = {
  pointerId: number;
  start: Point;
  moved: boolean;
} & (
  | { kind: "pan"; camera: Camera }
  | { kind: "move"; id: string; position: Point }
  | { kind: "connect"; connector: Connector }
);

export function LineageCanvas({
  graph,
  statuses,
  projects,
  selected,
  connecting,
  pending,
  onSelect,
  onOpen,
  onStartConnection,
  onCancelConnection,
  onConnect,
  canConnect,
  scope,
  closed,
  blocked,
  tasks,
  onAddLinked,
}: {
  graph: Graph;
  statuses: Status[];
  projects: Record<string, Project>;
  selected: string | null;
  connecting: Connector | null;
  pending: boolean;
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
  onStartConnection: (connector: Connector) => void;
  onCancelConnection: () => void;
  onConnect: (from: string, to: string) => void;
  canConnect: (from: string, to: string) => boolean;
  scope: string;
  /** Done or cancelled: drawn faded. */
  closed: Set<string>;
  /** Open prerequisites per task (absent when none). */
  blocked: Record<string, number>;
  /** Every task, for picking an existing one from a plus button. */
  tasks: Task[];
  /** Resolves to the new task's id when one was created (to place its card). */
  onAddLinked: (
    id: string,
    side: Connector["side"],
    pick: { title: string } | { existing: string },
  ) => Promise<string | null>;
}) {
  const [saved] = useState(loadCanvas);
  const [positions, setPositions] = useState<Positions>(() => ({
    ...Object.fromEntries(graph.nodes.map((node) => [node.task.id, { x: node.x, y: node.y }])),
    ...saved.positions,
  }));
  const [camera, setCamera] = useState<Camera>(saved.camera ?? { x: 40, y: 40, zoom: 1 });
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [draft, setDraft] = useState<{ point: Point; target: string | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [adding, setAdding] = useState<Connector | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const positionsRef = useRef(positions);
  const cameraRef = useRef(camera);
  const gesture = useRef<Gesture | null>(null);
  const captor = useRef<Element | null>(null);
  const suppressClick = useRef(false);
  const initialized = useRef(false);
  const previousScope = useRef(scope);
  const marker = useId();

  function updateCamera(next: Camera) {
    cameraRef.current = next;
    setCamera(next);
  }
  function updatePositions(next: Positions) {
    positionsRef.current = next;
    setPositions(next);
  }
  function persist() {
    saveCanvas(positionsRef.current, cameraRef.current);
  }
  function relativePoint(event: { clientX: number; clientY: number }): Point {
    const rect = canvas.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }
  function fitView() {
    updateCamera(
      fitCamera(
        graph.nodes.map((node) => positionsRef.current[node.task.id] ?? node),
        size.width,
        size.height,
      ),
    );
    persist();
  }
  function zoom(next: number, anchor = { x: size.width / 2, y: size.height / 2 }) {
    updateCamera(zoomAt(cameraRef.current, anchor, next));
    persist();
  }

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let lastSize: { width: number; height: number } | undefined;
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      if (lastSize && (width !== lastSize.width || height !== lastSize.height)) {
        const current = cameraRef.current;
        const next = {
          ...current,
          x: current.x + (width - lastSize.width) / 2,
          y: current.y + (height - lastSize.height) / 2,
        };
        cameraRef.current = next;
        setCamera(next);
      }
      lastSize = { width, height };
      setSize({ width, height });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    let saveTimer: ReturnType<typeof setTimeout>;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = cameraRef.current;
      const rect = element.getBoundingClientRect();
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      const next =
        event.ctrlKey || event.metaKey
          ? zoomAt(
              current,
              { x: event.clientX - rect.left, y: event.clientY - rect.top },
              current.zoom * Math.exp(-event.deltaY * factor * 0.006),
            )
          : {
              ...current,
              x: current.x - event.deltaX * factor,
              y: current.y - event.deltaY * factor,
            };
      cameraRef.current = next;
      setCamera(next);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveCanvas(positionsRef.current, cameraRef.current), 180);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", wheel);
      clearTimeout(saveTimer);
      saveCanvas(positionsRef.current, cameraRef.current);
    };
  }, []);

  useEffect(() => {
    const missing = graph.nodes.filter((node) => !positionsRef.current[node.task.id]);
    let next = positionsRef.current;
    if (missing.length) {
      next = {
        ...next,
        ...Object.fromEntries(missing.map((node) => [node.task.id, { x: node.x, y: node.y }])),
      };
      positionsRef.current = next;
      setPositions(next);
    }
    const scopeChanged = previousScope.current !== scope;
    previousScope.current = scope;
    if ((!initialized.current || scopeChanged) && graph.nodes.length) {
      initialized.current = true;
      if (scopeChanged || (!saved.camera && graph.nodes.length <= 30)) {
        const bounds = canvas.current?.getBoundingClientRect();
        const fitted = fitCamera(
          graph.nodes.map((node) => next[node.task.id] ?? node),
          bounds?.width ?? size.width,
          bounds?.height ?? size.height,
        );
        cameraRef.current = fitted;
        setCamera(fitted);
      }
    }
    saveCanvas(next, cameraRef.current);
  }, [graph.nodes, saved.camera, size.width, size.height, scope]);

  const nodes = useMemo(
    () => graph.nodes.map((node) => ({ ...node, ...(positions[node.task.id] ?? {}) })),
    [graph.nodes, positions],
  );
  const byId = useMemo(() => new Map(nodes.map((node) => [node.task.id, node])), [nodes]);
  const visible = nodes.filter(
    (node) =>
      (node.x + NODE_WIDTH) * camera.zoom + camera.x > -300 &&
      node.x * camera.zoom + camera.x < size.width + 300 &&
      (node.y + NODE_HEIGHT) * camera.zoom + camera.y > -300 &&
      node.y * camera.zoom + camera.y < size.height + 300,
  );
  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.id, status])),
    [statuses],
  );

  function capture(event: ReactPointerEvent, next: Gesture) {
    event.stopPropagation();
    gesture.current = next;
    suppressClick.current = false;
    captor.current = event.currentTarget;
    captor.current.setPointerCapture?.(event.pointerId);
  }
  function startMove(event: ReactPointerEvent, node: Node) {
    if (event.button !== 0 || connecting) return;
    capture(event, {
      kind: "move",
      pointerId: event.pointerId,
      start: relativePoint(event),
      position: { x: node.x, y: node.y },
      id: node.task.id,
      moved: false,
    });
  }
  function startConnect(event: ReactPointerEvent, node: Node, side: Connector["side"]) {
    if (event.button !== 0 || pending) return;
    event.preventDefault();
    const connector = { id: node.task.id, side };
    capture(event, {
      kind: "connect",
      pointerId: event.pointerId,
      start: relativePoint(event),
      connector,
      moved: false,
    });
    onStartConnection(connector);
    setDraft({ point: connectorPoint(node, side), target: null });
  }
  function targetAt(point: Point): string | null {
    const target = [...nodes]
      .reverse()
      .find(
        (node) =>
          point.x >= node.x - 16 &&
          point.x <= node.x + NODE_WIDTH + 16 &&
          point.y >= node.y - 8 &&
          point.y <= node.y + NODE_HEIGHT + 8,
      );
    return target?.task.id ?? null;
  }
  function move(event: ReactPointerEvent) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const point = relativePoint(event);
    const dx = point.x - active.start.x;
    const dy = point.y - active.start.y;
    active.moved ||= Math.hypot(dx, dy) > 4;
    if (!active.moved) return;
    suppressClick.current = true;
    if (active.kind === "pan") {
      setDragging(true);
      updateCamera({ ...active.camera, x: active.camera.x + dx, y: active.camera.y + dy });
    } else if (active.kind === "move") {
      setDragging(true);
      updatePositions({
        ...positionsRef.current,
        [active.id]: {
          x: active.position.x + dx / cameraRef.current.zoom,
          y: active.position.y + dy / cameraRef.current.zoom,
        },
      });
    } else {
      const world = worldPoint(point, cameraRef.current);
      setDraft({ point: world, target: targetAt(world) });
    }
  }
  function finish(event: ReactPointerEvent) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null;
    captor.current?.releasePointerCapture?.(event.pointerId);
    captor.current = null;
    setDragging(false);
    if (active.kind === "connect") {
      setDraft(null);
      if (active.moved) {
        const target = targetAt(worldPoint(relativePoint(event), cameraRef.current));
        if (target) {
          const [from, to] =
            active.connector.side === "out"
              ? [active.connector.id, target]
              : [target, active.connector.id];
          onConnect(from, to);
        } else onCancelConnection();
      }
    } else if (active.moved) persist();
    else if (active.kind === "pan") {
      onSelect(null);
      onCancelConnection();
    }
  }
  function cancel() {
    const active = gesture.current;
    gesture.current = null;
    if (active?.kind === "move")
      updatePositions({ ...positionsRef.current, [active.id]: active.position });
    if (active?.kind === "pan") updateCamera(active.camera);
    if (active) captor.current?.releasePointerCapture?.(active.pointerId);
    captor.current = null;
    setDragging(false);
    setDraft(null);
    if (!active && !connecting) onSelect(null);
    onCancelConnection();
  }
  async function addLinked(connector: Connector, pick: { title: string } | { existing: string }) {
    const origin = positionsRef.current[connector.id];
    setAdding(null);
    const id = await onAddLinked(connector.id, connector.side, pick);
    if (!id || !origin) return;
    const taken = Object.entries(positionsRef.current)
      .filter(([other]) => other !== id && graph.nodes.some((node) => node.task.id === other))
      .map(([, point]) => point);
    updatePositions({
      ...positionsRef.current,
      [id]: freeSlot(origin, connector.side, taken),
    });
    persist();
  }
  function selectNode(id: string) {
    if (connecting) {
      const [from, to] = connecting.side === "out" ? [connecting.id, id] : [id, connecting.id];
      onConnect(from, to);
    } else onSelect(id);
  }

  const origin = connecting ? byId.get(connecting.id) : undefined;
  const target = draft?.target ? byId.get(draft.target) : undefined;
  const valid =
    !!connecting &&
    !!target &&
    (connecting.side === "out"
      ? canConnect(connecting.id, target.task.id)
      : canConnect(target.task.id, connecting.id));
  const end =
    target && connecting
      ? connectorPoint(target, connecting.side === "out" ? "in" : "out")
      : draft?.point;
  const start = origin && connecting ? connectorPoint(origin, connecting.side) : undefined;

  return (
    <div className="relative min-h-64 min-w-0 flex-1">
      <div
        ref={canvas}
        role="application"
        aria-label="Task canvas"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas accepts arrow keys to pan and +/-/0 to zoom and fit.
        tabIndex={0}
        className={cx(
          "absolute inset-0 touch-none overflow-hidden outline-none select-none",
          dragging ? "cursor-grabbing" : "cursor-grab",
          connecting && "cursor-crosshair",
          "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40",
        )}
        style={{
          backgroundImage: "radial-gradient(circle, var(--tm-line-strong) 1px, transparent 1px)",
          backgroundSize: `${24 * camera.zoom}px ${24 * camera.zoom}px`,
          backgroundPosition: `${camera.x}px ${camera.y}px`,
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 && event.button !== 1) return;
          if (event.button === 0 && (event.target as HTMLElement).closest("button")) return;
          event.preventDefault();
          event.currentTarget.focus();
          capture(event, {
            kind: "pan",
            pointerId: event.pointerId,
            start: relativePoint(event),
            camera: cameraRef.current,
            moved: false,
          });
        }}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onLostPointerCapture={() => {
          if (gesture.current) cancel();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
            return;
          }
          if (event.target !== event.currentTarget) return;
          const deltas: Record<string, Point> = {
            ArrowLeft: { x: 60, y: 0 },
            ArrowRight: { x: -60, y: 0 },
            ArrowUp: { x: 0, y: 60 },
            ArrowDown: { x: 0, y: -60 },
          };
          const delta = deltas[event.key];
          if (delta) {
            event.preventDefault();
            updateCamera({
              ...cameraRef.current,
              x: cameraRef.current.x + delta.x,
              y: cameraRef.current.y + delta.y,
            });
            persist();
          }
          if (["+", "=", "-", "0"].includes(event.key)) {
            event.preventDefault();
            if (event.key === "0") fitView();
            else zoom(cameraRef.current.zoom * (event.key === "-" ? 1 / 1.2 : 1.2));
          }
        }}
      >
        <svg
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
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
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>
            {graph.edges.map((edge) => {
              const from = byId.get(edge.from.task.id);
              const to = byId.get(edge.to.task.id);
              if (!from || !to) return null;
              // Cull offscreen connections as well as cards; include the backward bend.
              if (
                (Math.max(from.x, to.x) + NODE_WIDTH + 180) * camera.zoom + camera.x < -300 ||
                (Math.min(from.x, to.x) - 180) * camera.zoom + camera.x > size.width + 300 ||
                (Math.max(from.y, to.y) + NODE_HEIGHT + 90) * camera.zoom + camera.y < -300 ||
                Math.min(from.y, to.y) * camera.zoom + camera.y > size.height + 300
              )
                return null;
              const highlighted = from.task.id === selected || to.task.id === selected;
              // A done prerequisite no longer blocks: its link fades and dashes.
              const satisfied = closed.has(from.task.id);
              return (
                <path
                  key={`${from.task.id}:${to.task.id}`}
                  data-lineage-edge={`${from.task.id}:${to.task.id}`}
                  d={connectionPath(connectorPoint(from, "out"), connectorPoint(to, "in"))}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={highlighted ? 2.5 : 1.8}
                  strokeDasharray={satisfied ? "5 5" : undefined}
                  data-satisfied={satisfied || undefined}
                  className={cx(
                    highlighted ? "text-accent" : "text-ink-3/55",
                    satisfied && "opacity-45",
                  )}
                  markerEnd={`url(#${marker})`}
                />
              );
            })}
            {draft && start && end && connecting && (
              <path
                data-testid="connection-preview"
                d={
                  connecting.side === "out"
                    ? connectionPath(start, end)
                    : connectionPath(end, start)
                }
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeDasharray={target ? undefined : "6 5"}
                className={target ? (valid ? "text-done" : "text-danger") : "text-accent"}
                markerEnd={`url(#${marker})`}
              />
            )}
          </g>
        </svg>
        <div
          className="pointer-events-none absolute inset-0 origin-top-left"
          style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}
        >
          {visible.map((node) => {
            const task = node.task;
            const status = statusById.get(task.status_id);
            const project = task.project_id ? projects[task.project_id] : undefined;
            const isClosed = closed.has(task.id);
            const blockers = blocked[task.id] ?? 0;
            return (
              <div
                key={task.id}
                data-lineage-node={task.id}
                data-closed={isClosed || undefined}
                className={cx(
                  "group/node pointer-events-auto absolute transition-opacity",
                  // Done work stays visible as context, faded and colorless.
                  isClosed &&
                    selected !== task.id &&
                    "opacity-45 grayscale hover:opacity-80 focus-within:opacity-80",
                )}
                style={{
                  left: node.x,
                  top: node.y,
                  width: NODE_WIDTH,
                  height: NODE_HEIGHT,
                  zIndex:
                    gesture.current?.kind === "move" && gesture.current.id === task.id
                      ? 10
                      : selected === task.id
                        ? 5
                        : undefined,
                }}
              >
                <button
                  type="button"
                  aria-label={`Select ${task.title}`}
                  aria-pressed={selected === task.id}
                  onPointerDown={(event) => startMove(event, node)}
                  onClick={() => selectNode(task.id)}
                  onDoubleClick={() => {
                    if (!connecting && !suppressClick.current) onOpen(task.id);
                  }}
                  onKeyDown={(event) => {
                    const delta: Record<string, Point> = {
                      ArrowLeft: { x: -16, y: 0 },
                      ArrowRight: { x: 16, y: 0 },
                      ArrowUp: { x: 0, y: -16 },
                      ArrowDown: { x: 0, y: 16 },
                    };
                    const offset = delta[event.key];
                    if (!event.altKey || !offset) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const current = positionsRef.current[task.id] ?? node;
                    updatePositions({
                      ...positionsRef.current,
                      [task.id]: { x: current.x + offset.x, y: current.y + offset.y },
                    });
                    persist();
                  }}
                  title="Drag to move · Double-click to open · Alt + arrows to nudge"
                  className={cx(
                    "flex size-full cursor-grab flex-col justify-between rounded-xl border bg-raised px-4 py-3 text-left shadow-md shadow-black/5 transition-colors active:cursor-grabbing",
                    FOCUS,
                    selected === task.id
                      ? "border-accent ring-2 ring-accent/15"
                      : "border-line-strong hover:border-accent/50",
                    draft?.target === task.id &&
                      (valid
                        ? "border-done ring-2 ring-done/30"
                        : "border-danger ring-2 ring-danger/30"),
                    connecting?.id === task.id && "border-accent",
                  )}
                >
                  <span className="flex w-full items-start gap-2">
                    <span
                      className={cx(
                        "line-clamp-2 min-w-0 flex-1 text-[13px] font-medium leading-snug",
                        isClosed ? "text-ink-3 line-through" : "text-ink",
                      )}
                    >
                      {task.title}
                    </span>
                    <GripVertical size={13} className="mt-0.5 shrink-0 text-ink-3/50" />
                  </span>
                  <span className="flex w-full items-center gap-1.5 text-[11px] text-ink-3">
                    <Dot color={status?.color ?? null} />
                    <span className="min-w-0 truncate">{status?.name}</span>
                    {blockers > 0 && (
                      <span
                        className="shrink-0 rounded-full bg-danger/10 px-1.5 text-danger"
                        title={`Waiting on ${blockers} open ${blockers === 1 ? "task" : "tasks"}`}
                      >
                        Blocked · {blockers}
                      </span>
                    )}
                    {project && (
                      <span className="ml-auto flex min-w-0 items-center gap-1 truncate">
                        <ProjectMark project={project} />
                        <span className="truncate">{project.name}</span>
                      </span>
                    )}
                  </span>
                </button>
                {(["in", "out"] as const).map((side) => (
                  <button
                    key={side}
                    type="button"
                    aria-label={
                      side === "out" ? `Connect from ${task.title}` : `Connect to ${task.title}`
                    }
                    disabled={pending}
                    onPointerDown={(event) => startConnect(event, node, side)}
                    onClick={() => {
                      if (connecting && connecting.id !== task.id) selectNode(task.id);
                      else onStartConnection({ id: task.id, side });
                    }}
                    title={
                      side === "out"
                        ? "Drag to a task that depends on this one"
                        : "Drag to a prerequisite task"
                    }
                    className={cx(
                      "absolute top-1/2 flex size-7 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full disabled:cursor-default",
                      side === "in" ? "-left-3.5" : "-right-3.5",
                      FOCUS,
                    )}
                  >
                    <span
                      className={cx(
                        "size-3 rounded-full border-2 border-ink-3/50 bg-raised transition-all group-hover/node:size-3.5 group-hover/node:border-accent group-focus-within/node:border-accent",
                        connecting && "border-accent bg-accent/20",
                        draft?.target === task.id &&
                          (valid ? "border-done bg-done/20" : "border-danger bg-danger/20"),
                      )}
                    />
                  </button>
                ))}
                {(["in", "out"] as const).map((side) => (
                  <button
                    key={`add-${side}`}
                    type="button"
                    aria-label={
                      side === "out"
                        ? `Add a task after ${task.title}`
                        : `Add a task before ${task.title}`
                    }
                    title={
                      side === "out"
                        ? "Add a task that depends on this one"
                        : "Add a prerequisite of this task"
                    }
                    disabled={pending}
                    onClick={() => {
                      onCancelConnection();
                      setAdding({ id: task.id, side });
                    }}
                    className={cx(
                      "absolute -top-3 flex size-6 items-center justify-center rounded-full border border-line-strong bg-raised text-ink-2 opacity-0 shadow-sm transition-opacity hover:border-accent hover:text-accent focus-visible:opacity-100 group-hover/node:opacity-100 disabled:hidden",
                      side === "in" ? "-left-3" : "-right-3",
                      (selected === task.id || adding?.id === task.id) && "opacity-100",
                      FOCUS,
                    )}
                  >
                    <Plus size={13} />
                  </button>
                ))}
              </div>
            );
          })}
          {adding &&
            (() => {
              const origin = byId.get(adding.id);
              if (!origin) return null;
              return (
                <AddLinked
                  key={`${adding.id}:${adding.side}`}
                  origin={origin}
                  side={adding.side}
                  tasks={tasks}
                  canLink={(other) =>
                    other !== adding.id &&
                    (adding.side === "out"
                      ? canConnect(adding.id, other)
                      : canConnect(other, adding.id))
                  }
                  onPick={(pick) => void addLinked(adding, pick)}
                  onCancel={() => setAdding(null)}
                />
              );
            })()}
        </div>
        {!nodes.length && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center p-10 text-center text-ink-3">
            <GitBranch size={32} className="mb-3" />
            <p>No tasks to display.</p>
            <p className="mt-2 text-sm">Add tasks from Inbox, or change the filters above.</p>
          </div>
        )}
      </div>
      {connecting && origin && (
        <div
          role="status"
          className="absolute top-4 left-1/2 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border border-accent/30 bg-overlay px-4 py-2 text-xs text-ink shadow-lg"
        >
          <MousePointer2 size={14} className="shrink-0 text-accent" />
          <span>
            {connecting.side === "out"
              ? `Connect “${origin.task.title}” to a dependent task`
              : `Choose a prerequisite for “${origin.task.title}”`}
          </span>
          <IconButton label="Cancel" onClick={cancel}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      <div className="absolute bottom-4 left-4 flex flex-wrap items-center gap-1 rounded-xl border border-line-strong bg-overlay p-1.5 shadow-lg shadow-black/5">
        <IconButton label="Zoom out" onClick={() => zoom(camera.zoom / 1.2)}>
          <Minus size={15} />
        </IconButton>
        <button
          type="button"
          aria-label="Reset zoom"
          onClick={() => zoom(1)}
          className={cx(
            "min-w-12 rounded-md py-1 text-center text-xs text-ink-2 tabular-nums hover:bg-hover",
            FOCUS,
          )}
        >
          {Math.round(camera.zoom * 100)}%
        </button>
        <IconButton label="Zoom in" onClick={() => zoom(camera.zoom * 1.2)}>
          <Plus size={15} />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton label="Fit view" onClick={fitView}>
          <Expand size={15} />
        </IconButton>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            updatePositions({
              ...positionsRef.current,
              ...Object.fromEntries(
                graph.nodes.map((node) => [node.task.id, { x: node.x, y: node.y }]),
              ),
            });
            fitView();
          }}
        >
          <LayoutGrid size={14} /> Auto arrange
        </Button>
      </div>
      <p className="pointer-events-none absolute right-4 bottom-5 hidden rounded-lg bg-canvas/90 px-3 py-1.5 text-[11px] text-ink-3 xl:block">
        Drag to pan · Ctrl + scroll to zoom
      </p>
    </div>
  );
}

const ADD_WIDTH = 260;

/** The plus button's popover: type a title to create a task, or pick an existing one. */
function AddLinked({
  origin,
  side,
  tasks,
  canLink,
  onPick,
  onCancel,
}: {
  origin: Point & { task: Task };
  side: Connector["side"];
  tasks: Task[];
  canLink: (id: string) => boolean;
  onPick: (pick: { title: string } | { existing: string }) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const title = query.trim();
  const matches = title
    ? tasks
        .filter((t) => t.title.toLowerCase().includes(title.toLowerCase()) && canLink(t.id))
        .slice(0, 6)
    : [];
  const label = side === "out" ? "New task after" : "New task before";
  return (
    <form
      aria-label={`${label} ${origin.task.title}`}
      className="pointer-events-auto absolute z-20 rounded-xl border border-accent/40 bg-overlay p-2 shadow-xl shadow-black/10"
      style={{
        left: side === "out" ? origin.x + NODE_WIDTH + 28 : origin.x - 28 - ADD_WIDTH,
        top: origin.y,
        width: ADD_WIDTH,
      }}
      // The canvas pans on pointer down; typing and clicking here must not.
      onPointerDown={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        if (title) onPick({ title });
      }}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: the popover opens to type a title.
        autoFocus
        aria-label={side === "out" ? "Title of the dependent task" : "Title of the prerequisite"}
        placeholder={
          side === "out" ? "Then… (new or existing task)" : "First… (new or existing task)"
        }
        className={cx(
          "w-full rounded-lg border border-line-strong bg-raised px-2.5 py-1.5 text-sm text-ink",
          FOCUS,
        )}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        onBlur={(event) => {
          if (!title && !event.currentTarget.form?.contains(event.relatedTarget as Element | null))
            onCancel();
        }}
      />
      {title && (
        <div className="mt-1 flex flex-col">
          <button
            type="submit"
            className={cx(
              "truncate rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-hover",
              FOCUS,
            )}
          >
            + Create “{title}”
          </button>
          {matches.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => onPick({ existing: t.id })}
              className={cx(
                "truncate rounded-md px-2 py-1.5 text-left text-sm text-ink-2 hover:bg-hover",
                FOCUS,
              )}
            >
              Link “{t.title}”
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
