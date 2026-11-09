import { ChevronDown, ChevronRight, GripVertical, Pin } from "lucide-react";
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
import type { Epic, Project, Status, Task } from "../../lib/types";
import { EpicMark } from "../organize/EpicMark";
import { ProjectMark } from "../organize/ProjectMark";
import {
  anyInView,
  type Camera,
  type Connector,
  centerOn,
  connectionPath,
  connectorPoint,
  fitCamera,
  freeSlot,
  loadCanvas,
  type Point,
  type Positions,
  type SavedCanvas,
  saveCanvas,
  worldPoint,
  zoomAt,
} from "./canvas";
import { type layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "./graph";
import {
  type Arrange,
  avoidPinned,
  LANE_HEADER,
  type Lane,
  type LaneSpec,
  laneAt,
  laneKey,
  layoutLanes,
} from "./lanes";

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
  fitOnOpen = false,
  closed,
  blocked,
  tasks,
  onAddLinked,
  reveal = null,
  placement = null,
  arrange = "free",
  laneSpecs = [],
  epics = {},
  onMoveToLane,
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
  /** Frame the cards on open instead of restoring the saved camera (a task's lineage). */
  fitOnOpen?: boolean;
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
  /** Center the camera on this card; `seq` changes on every request. */
  reveal?: { id: string; seq: number } | null;
  /** A task just linked to `near` from elsewhere (the side panel): placed beside its card. */
  placement?: { id: string; near: string; side: Connector["side"] } | null;
  /** Freeform, or one lane per epic or project. */
  arrange?: Arrange;
  /** The lanes to draw, in order (empty ones included, to drop cards into). */
  laneSpecs?: LaneSpec[];
  epics?: Record<string, Epic>;
  /** A card dropped into another lane: give it that lane's epic or project. */
  onMoveToLane?: (id: string, key: string) => void;
}) {
  const [saved] = useState(loadCanvas);
  const [positions, setPositions] = useState<Positions>(() => ({
    ...Object.fromEntries(graph.nodes.map((node) => [node.task.id, { x: node.x, y: node.y }])),
    ...saved.positions,
  }));
  const [camera, setCamera] = useState<Camera>(saved.camera ?? { x: 40, y: 40, zoom: 1 });
  const [laneRel, setLaneRel] = useState(saved.lanes);
  const [pinned, setPinned] = useState(() => new Set(saved.pinned));
  const [collapsed, setCollapsed] = useState(saved.collapsed);
  /** A card being dragged in lanes: drawn here until it is dropped into a lane. */
  const [dragOverride, setDragOverride] = useState<{ id: string; point: Point } | null>(null);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [draft, setDraft] = useState<{ point: Point; target: string | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [adding, setAdding] = useState<Connector | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const positionsRef = useRef(positions);
  const cameraRef = useRef(camera);
  const laneRef = useRef(laneRel);
  const pinnedRef = useRef(pinned);
  const collapsedRef = useRef(collapsed);
  const fitNext = useRef(false);
  const dragPoint = useRef<Point | null>(null);
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
  function snapshot(): SavedCanvas {
    return {
      positions: positionsRef.current,
      camera: cameraRef.current,
      pinned: [...pinnedRef.current],
      lanes: laneRef.current,
      collapsed: collapsedRef.current,
    };
  }
  function persist() {
    saveCanvas(snapshot());
  }
  function updateLanes(next: SavedCanvas["lanes"]) {
    laneRef.current = next;
    setLaneRel(next);
  }

  const lanesMode = arrange === "free" ? null : arrange;
  const laneView = useMemo(
    () =>
      lanesMode
        ? layoutLanes(
            graph.nodes,
            lanesMode,
            laneSpecs,
            laneRel[lanesMode],
            new Set(collapsed[lanesMode]),
          )
        : null,
    [graph.nodes, lanesMode, laneSpecs, laneRel, collapsed],
  );
  /** Where every card is now, in canvas coordinates (lanes resolved). */
  const world: Positions = laneView ? laneView.world : positions;
  const worldRef = useRef(world);
  worldRef.current = world;
  const laneViewRef = useRef(laneView);
  laneViewRef.current = laneView;
  const hiddenLanes = useMemo(
    () => new Set(lanesMode ? collapsed[lanesMode] : []),
    [lanesMode, collapsed],
  );
  const isHidden = (task: Task) => !!lanesMode && hiddenLanes.has(laneKey(task, lanesMode));

  /** Moves a card to a canvas point: freely, or inside its lane. */
  function setWorld(id: string, point: Point) {
    const view = laneViewRef.current;
    const task = graph.nodes.find((node) => node.task.id === id)?.task;
    if (!lanesMode || !view || !task) {
      updatePositions({ ...positionsRef.current, [id]: point });
      return;
    }
    const lane = view.lanes.find((l) => l.key === laneKey(task, lanesMode));
    const top = lane?.top ?? 0;
    updateLanes({
      ...laneRef.current,
      [lanesMode]: {
        ...laneRef.current[lanesMode],
        [id]: { x: point.x, y: Math.max(LANE_HEADER, point.y - top) },
      },
    });
  }
  function togglePin(id: string) {
    const next = new Set(pinnedRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    pinnedRef.current = next;
    setPinned(next);
    persist();
  }
  function toggleLane(key: string) {
    if (!lanesMode) return;
    const current = collapsedRef.current[lanesMode];
    const next = {
      ...collapsedRef.current,
      [lanesMode]: current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    };
    collapsedRef.current = next;
    setCollapsed(next);
    persist();
  }
  /** Lays the cards out again; pinned cards stay where they are. */
  function arrangeAgain() {
    const ids = graph.nodes.map((node) => node.task.id).filter((id) => !pinnedRef.current.has(id));
    if (lanesMode) {
      const kept = { ...laneRef.current[lanesMode] };
      for (const id of ids) delete kept[id];
      updateLanes({ ...laneRef.current, [lanesMode]: kept });
    } else {
      const fixed = Object.fromEntries(
        graph.nodes
          .filter((node) => pinnedRef.current.has(node.task.id))
          .map((node) => [node.task.id, positionsRef.current[node.task.id] ?? node]),
      );
      const fresh = Object.fromEntries(
        graph.nodes
          .filter((node) => !pinnedRef.current.has(node.task.id))
          .map((node) => [node.task.id, { x: node.x, y: node.y }]),
      );
      updatePositions({ ...positionsRef.current, ...avoidPinned(fresh, fixed) });
    }
    fitNext.current = true;
  }
  function relativePoint(event: { clientX: number; clientY: number }): Point {
    const rect = canvas.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }
  function fitView() {
    updateCamera(
      fitCamera(
        graph.nodes
          .filter((node) => !isHidden(node.task))
          .map((node) => worldRef.current[node.task.id] ?? node),
        size.width,
        size.height,
      ),
    );
    persist();
  }
  // After "Arrange": frame the cards once the new layout has rendered.
  useEffect(() => {
    if (!fitNext.current) return;
    fitNext.current = false;
    fitView();
  });
  // New cards placed in their lane: keep that placement.
  useEffect(() => {
    if (!lanesMode || !laneView) return;
    const saved = laneRef.current[lanesMode];
    if (Object.keys(laneView.relative).length === Object.keys(saved).length) return;
    updateLanes({ ...laneRef.current, [lanesMode]: laneView.relative });
    persist();
  });
  function zoom(next: number, anchor = { x: size.width / 2, y: size.height / 2 }) {
    updateCamera(zoomAt(cameraRef.current, anchor, next));
    persist();
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: persist reads refs only.
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
      saveTimer = setTimeout(persist, 180);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", wheel);
      clearTimeout(saveTimer);
      persist();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reads the current layout from refs.
  useEffect(() => {
    const missing = lanesMode
      ? []
      : graph.nodes.filter((node) => !positionsRef.current[node.task.id]);
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
      const opening = !initialized.current;
      initialized.current = true;
      const bounds = canvas.current?.getBoundingClientRect();
      const width = bounds?.width || size.width;
      const height = bounds?.height || size.height;
      const points = graph.nodes
        .filter((node) => !isHidden(node.task))
        .map((node) => (lanesMode ? worldRef.current : next)[node.task.id] ?? node);
      // The saved camera belongs to whatever view was open last: on open it can point at an
      // area with none of these cards (a task's lineage, or other filters).
      if (
        scopeChanged ||
        (opening && (fitOnOpen || !anyInView(points, cameraRef.current, width, height))) ||
        (!saved.camera && graph.nodes.length <= 30)
      ) {
        const fitted = fitCamera(points, width, height);
        cameraRef.current = fitted;
        setCamera(fitted);
      }
    }
    persist();
  }, [graph.nodes, saved.camera, size.width, size.height, scope, fitOnOpen]);

  const placed = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: placeBeside reads refs only.
  useEffect(() => {
    if (!placement || placed.current === placement.id) return;
    if (!graph.nodes.some((node) => node.task.id === placement.id)) return;
    placed.current = placement.id;
    placeBeside(placement.id, placement.near, placement.side);
  }, [placement, graph.nodes]);

  // Only a new request moves the camera, not resizes or edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    if (!reveal) return;
    const point = worldRef.current[reveal.id];
    if (!point) return;
    const bounds = canvas.current?.getBoundingClientRect();
    const width = bounds?.width || size.width;
    const height = bounds?.height || size.height;
    updateCamera(centerOn(point, cameraRef.current, width, height));
    persist();
  }, [reveal]);

  const nodes = useMemo(
    () =>
      graph.nodes
        .filter((node) => !(lanesMode && hiddenLanes.has(laneKey(node.task, lanesMode))))
        .map((node) => ({
          ...node,
          ...(world[node.task.id] ?? {}),
          ...(dragOverride?.id === node.task.id ? dragOverride.point : {}),
        })),
    [graph.nodes, world, dragOverride, lanesMode, hiddenLanes],
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
    if (event.button !== 0 || connecting || pinnedRef.current.has(node.task.id)) return;
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
      const point = {
        x: active.position.x + dx / cameraRef.current.zoom,
        y: active.position.y + dy / cameraRef.current.zoom,
      };
      if (lanesMode) {
        dragPoint.current = point;
        setDragOverride({ id: active.id, point });
      } else updatePositions({ ...positionsRef.current, [active.id]: point });
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
    } else if (active.moved) {
      if (active.kind === "move" && lanesMode) dropInLane(active.id);
      persist();
    } else if (active.kind === "pan") {
      onSelect(null);
      onCancelConnection();
    }
  }
  /** Ends a drag in lanes: the card lands in the lane under it, changing epic or project. */
  function dropInLane(id: string) {
    const view = laneViewRef.current;
    const task = graph.nodes.find((node) => node.task.id === id)?.task;
    const dropped = dragPoint.current;
    dragPoint.current = null;
    setDragOverride(null);
    if (!lanesMode || !view || !task || !dropped) return;
    const lane = laneAt(view.lanes, dropped.y + NODE_HEIGHT / 2);
    if (!lane) return;
    updateLanes({
      ...laneRef.current,
      [lanesMode]: {
        ...laneRef.current[lanesMode],
        [id]: { x: dropped.x, y: Math.max(LANE_HEADER, dropped.y - lane.top) },
      },
    });
    if (lane.key !== laneKey(task, lanesMode)) onMoveToLane?.(id, lane.key);
  }
  function cancel() {
    const active = gesture.current;
    gesture.current = null;
    dragPoint.current = null;
    setDragOverride(null);
    if (active?.kind === "move" && !lanesMode)
      updatePositions({ ...positionsRef.current, [active.id]: active.position });
    if (active?.kind === "pan") updateCamera(active.camera);
    if (active) captor.current?.releasePointerCapture?.(active.pointerId);
    captor.current = null;
    setDragging(false);
    setDraft(null);
    if (!active && !connecting) onSelect(null);
    onCancelConnection();
  }
  /** Puts a new card one column beside `near`, in the first row no card covers. */
  function placeBeside(id: string, near: string, side: Connector["side"]) {
    const origin = worldRef.current[near];
    if (!origin) return;
    const taken = Object.entries(worldRef.current)
      .filter(([other]) => other !== id && graph.nodes.some((node) => node.task.id === other))
      .map(([, point]) => point);
    setWorld(id, freeSlot(origin, side, taken));
    persist();
  }
  async function addLinked(connector: Connector, pick: { title: string } | { existing: string }) {
    setAdding(null);
    const id = await onAddLinked(connector.id, connector.side, pick);
    if (id) placeBeside(id, connector.id, connector.side);
  }
  function selectNode(id: string) {
    if (connecting) {
      const [from, to] = connecting.side === "out" ? [connecting.id, id] : [id, connecting.id];
      onConnect(from, to);
    } else onSelect(id);
  }

  // Whole pixels: a layer at a fractional offset is resampled, which blurs its text.
  const shift = { x: Math.round(camera.x), y: Math.round(camera.y) };
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
        onPointerDownCapture={(event) => {
          // A click anywhere else on the canvas (cards included, which stop their pointer
          // events) closes the plus button's popover, even with text typed in it.
          if (adding && !(event.target as Element).closest("[data-add-linked]")) setAdding(null);
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
          <g transform={`translate(${shift.x} ${shift.y}) scale(${camera.zoom})`}>
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
        {/* The cards zoom with CSS `zoom`, not `scale()`: WebKitGTK rasterizes a scaled layer
            once and stretches the bitmap, which blurs the text at most zoom levels. `zoom`
            lays the cards out at their real size, so the text stays crisp. The pan is a
            whole-pixel translate on its own element (a fractional one blurs the text too). */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{ transform: `translate(${shift.x}px, ${shift.y}px)` }}
        >
          <div className="absolute inset-0" style={{ zoom: camera.zoom }}>
            {laneView && (
              <LaneBands
                lanes={laneView.lanes}
                left={Math.min(-camera.x / camera.zoom, ...nodes.map((node) => node.x - 60))}
                right={Math.max(
                  (size.width - camera.x) / camera.zoom,
                  ...nodes.map((node) => node.x + NODE_WIDTH + 60),
                )}
                viewLeft={-camera.x / camera.zoom}
                arrange={lanesMode ?? "epic"}
                epics={epics}
                onToggle={toggleLane}
              />
            )}
            {visible.map((node) => {
              const task = node.task;
              const status = statusById.get(task.status_id);
              const project = task.project_id ? projects[task.project_id] : undefined;
              const isClosed = closed.has(task.id);
              const blockers = blocked[task.id] ?? 0;
              const isPinned = pinned.has(task.id);
              const epic = task.epic_id && lanesMode !== "epic" ? epics[task.epic_id] : undefined;
              return (
                <div
                  key={task.id}
                  data-lineage-node={task.id}
                  data-closed={isClosed || undefined}
                  data-pinned={isPinned || undefined}
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
                      if (!event.altKey || !offset || isPinned) return;
                      event.preventDefault();
                      event.stopPropagation();
                      const current = worldRef.current[task.id] ?? node;
                      setWorld(task.id, { x: current.x + offset.x, y: current.y + offset.y });
                      persist();
                    }}
                    title={
                      isPinned
                        ? "Pinned: stays where it is · Double-click to open"
                        : "Drag to move · Double-click to open · Alt + arrows to nudge"
                    }
                    className={cx(
                      "flex size-full flex-col justify-between rounded-xl border bg-raised px-4 py-3 text-left shadow-md shadow-black/5 transition-colors",
                      isPinned ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
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
                      <span className="min-w-0 flex-1">
                        {epic && (
                          <span
                            data-card-epic
                            className="mb-0.5 flex items-center gap-1 truncate text-[11px] font-medium text-violet-800 dark:text-violet-300"
                            style={epic.color ? { color: epic.color } : undefined}
                          >
                            <EpicMark epic={epic} size={10} />
                            <span className="truncate">{epic.name}</span>
                          </span>
                        )}
                        <span
                          className={cx(
                            "text-[13px] font-medium leading-snug",
                            epic ? "line-clamp-1" : "line-clamp-2",
                            isClosed ? "text-ink-3 line-through" : "text-ink",
                          )}
                        >
                          {task.title}
                        </span>
                      </span>
                      {/* Room for the pin button, laid over the card. */}
                      <span className="size-[13px] shrink-0" />
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
                      {project && lanesMode !== "project" && (
                        <span className="ml-auto flex min-w-0 items-center gap-1 truncate">
                          <ProjectMark project={project} />
                          <span className="truncate">{project.name}</span>
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={isPinned ? `Unpin ${task.title}` : `Pin ${task.title}`}
                    aria-pressed={isPinned}
                    title={
                      isPinned ? "Unpin: it can move again" : "Pin: keep this card where it is"
                    }
                    onClick={() => togglePin(task.id)}
                    className={cx(
                      "group/pin absolute top-2.5 right-2.5 flex size-6 items-center justify-center rounded-md hover:bg-hover",
                      isPinned ? "text-accent" : "text-ink-3/50 hover:text-accent",
                      FOCUS,
                    )}
                  >
                    {isPinned ? (
                      <Pin size={13} className="fill-current" />
                    ) : (
                      <>
                        <GripVertical
                          size={13}
                          className="group-hover/node:hidden group-focus-visible/pin:hidden"
                        />
                        <Pin
                          size={13}
                          className="hidden group-hover/node:block group-focus-visible/pin:block"
                        />
                      </>
                    )}
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
          title={
            pinned.size
              ? "Lay the cards out again; pinned cards stay where they are"
              : "Lay the cards out again"
          }
          onClick={arrangeAgain}
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

/** The lanes behind the cards; each header stays at the left edge of the view. */
function LaneBands({
  lanes,
  left,
  right,
  viewLeft,
  arrange,
  epics,
  onToggle,
}: {
  lanes: Lane[];
  left: number;
  right: number;
  viewLeft: number;
  arrange: "epic" | "project";
  epics: Record<string, Epic>;
  onToggle: (key: string) => void;
}) {
  const headerX = Math.max(left, viewLeft) - left + 12;
  return (
    <>
      {lanes.map((lane) => {
        const epic = arrange === "epic" ? epics[lane.key] : undefined;
        const Chevron = lane.collapsed ? ChevronRight : ChevronDown;
        return (
          <section
            key={lane.key}
            data-lane={lane.key}
            aria-label={`Lane ${lane.label}`}
            className="absolute rounded-xl border border-line bg-ink/[0.025]"
            style={{
              left,
              top: lane.top,
              width: right - left,
              height: lane.height,
              borderLeft: `4px solid ${lane.color ?? "var(--tm-line-strong)"}`,
            }}
          >
            <button
              type="button"
              aria-expanded={!lane.collapsed}
              aria-label={`${lane.collapsed ? "Expand" : "Collapse"} lane ${lane.label}`}
              onClick={() => onToggle(lane.key)}
              className={cx(
                "pointer-events-auto absolute top-2 flex max-w-80 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] font-medium text-ink-2 hover:bg-hover",
                FOCUS,
              )}
              style={{ left: headerX, ...(lane.color && { color: lane.color }) }}
            >
              <Chevron size={14} className="shrink-0" />
              {epic ? <EpicMark epic={epic} size={11} /> : <Dot color={lane.color} />}
              <span className="truncate">{lane.label}</span>
              <span className="shrink-0 text-xs font-normal text-ink-3">{lane.count}</span>
            </button>
          </section>
        );
      })}
    </>
  );
}

const ADD_WIDTH = 260;

/**
 * Tasks to link without typing: same epic first, then same project. Open tasks only, never
 * agent tasks.
 */
export function suggestions(origin: Task, tasks: Task[], canLink: (id: string) => boolean) {
  const near = (t: Task) =>
    origin.epic_id && t.epic_id === origin.epic_id
      ? 0
      : origin.project_id && t.project_id === origin.project_id
        ? 1
        : 2;
  return tasks
    .filter(
      (t) =>
        t.id !== origin.id &&
        t.owner !== "agent" &&
        near(t) < 2 &&
        t.completed_at === null &&
        canLink(t.id),
    )
    .sort((a, b) => near(a) - near(b))
    .slice(0, 6);
}

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
    : suggestions(origin.task, tasks, canLink);
  const label = side === "out" ? "New task after" : "New task before";
  return (
    <form
      data-add-linked
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
      {(title || matches.length > 0) && (
        <div className="mt-1 flex flex-col">
          {title ? (
            <button
              type="submit"
              className={cx(
                "truncate rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-hover",
                FOCUS,
              )}
            >
              + Create “{title}”
            </button>
          ) : (
            <p className="px-2 pt-1 pb-0.5 text-[11px] text-ink-3">
              {origin.task.epic_id ? "From the same epic or project" : "From the same project"}
            </p>
          )}
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
