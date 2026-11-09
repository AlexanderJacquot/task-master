import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  getFirstCollision,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  type UniqueIdentifier,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  SpearsLeftIcon as ChevronsLeft,
  SpearsRightIcon as ChevronsRight,
} from "../../components/TaskIcons";
import { cx, Dot } from "../../components/ui";
import { adjacentStatus, type Board, type Card, type Column, type Lane } from "../../lib/board";
import { moveCard } from "../../store/actions";
import { useTaskStore } from "../../store/context";
import { CARD_SLOT, CardFace, type CardLookups } from "./BoardCard";
import {
  type BoardColumns,
  COLLAPSED_WIDTH,
  lanesFor,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  useBoardColumns,
} from "./useBoardColumns";
import { useCollapsedLanes } from "./useCollapsedLanes";
import { useMiddleDragPan } from "./useMiddleDragPan";

interface Props {
  board: Board;
  /** Memoized by the caller so cards only re-render when their task changes. */
  lookups: CardLookups;
  selectedId: string | null;
  onOpen(id: string): void;
}

type Cells = Record<string, string[]>;

const SEP = "|";
/** Gap between cards side by side in a wide column. */
const LANE_GAP = 8;
/** Hovering a dragged card this long over a collapsed swimlane opens it until the drop. */
export const SPRING_OPEN_MS = 1000;
const cellId = (lane: Lane, statusId: string) => `${lane.key}${SEP}${statusId}`;

function cellsOf(board: Board): Cells {
  const cells: Cells = {};
  for (const lane of board.lanes) {
    for (const column of board.columns) {
      cells[cellId(lane, column.status.id)] = (lane.cells[column.status.id] ?? []).map(
        (c) => c.task.id,
      );
    }
  }
  return cells;
}

function sameOrder(a: string[] | undefined, b: string[] | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Columns per status, optionally split into swimlanes. Cards drag within and between cells
 * (dnd-kit); a drop is one `move_task` with a rank between the new neighbours. A focused
 * card moves to the previous or next column with `Alt+←/→`. Columns can be collapsed to a
 * strip (still a drop target) and resized; a wide column lays its cards out side by side.
 */
export function BoardView({ board, selectedId, onOpen, lookups }: Props) {
  const store = useTaskStore();
  const [available, setAvailable] = useState(0);
  const columns = useBoardColumns({
    available,
    statusIds: board.columns.map((c) => c.status.id),
  });
  const [overlayWidth, setOverlayWidth] = useState<number | null>(null);
  const cards = useMemo(() => {
    const map = new Map<string, Card>();
    for (const lane of board.lanes) {
      for (const cell of Object.values(lane.cells))
        for (const card of cell) map.set(card.task.id, card);
    }
    return map;
  }, [board]);
  const lanesByKey = useMemo(() => new Map(board.lanes.map((l) => [l.key, l])), [board]);
  const boardCells = useMemo(() => cellsOf(board), [board]);

  // While dragging, cells are local so the card can visit other cells before the drop.
  const [dragCells, setDragCells] = useState<Cells | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const cells = dragCells ?? boardCells;

  // Collapsed swimlanes show a strip of drop targets. Holding a dragged card over one for
  // a moment opens that lane until the drag ends, so the card can be placed among its cards.
  const collapsedLanes = useCollapsedLanes();
  const [hoverLane, setHoverLane] = useState<string | null>(null);
  const [springOpen, setSpringOpen] = useState<ReadonlySet<string>>(new Set());
  const laneOpen = (key: string) => !collapsedLanes.isCollapsed(key) || springOpen.has(key);
  const hoverCollapsed =
    activeId !== null &&
    hoverLane !== null &&
    collapsedLanes.isCollapsed(hoverLane) &&
    !springOpen.has(hoverLane);
  useEffect(() => {
    if (!hoverCollapsed || hoverLane === null) return;
    const timer = setTimeout(
      () => setSpringOpen((prev) => new Set(prev).add(hoverLane)),
      SPRING_OPEN_MS,
    );
    return () => clearTimeout(timer);
  }, [hoverCollapsed, hoverLane]);
  const endDrag = () => {
    setDragCells(null);
    setActiveId(null);
    setHoverLane(null);
    setSpringOpen(new Set());
  };

  // Moving a card to another cell shifts the layout, which can make the next collision
  // point back at the cell it came from, then forward again: shaking a card between
  // columns looped until React gave up ("Maximum update depth exceeded"). As in dnd-kit's
  // multiple-containers example, a cross-cell move is held for one frame and the last
  // target is kept while the layout settles.
  const lastOverId = useRef<UniqueIdentifier | null>(null);
  const recentlyMoved = useRef(false);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after every cell change
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      recentlyMoved.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [dragCells]);

  /** Pointer first, then overlap; over a cell, its closest card. */
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      const byPointer = pointerWithin(args);
      const hits = byPointer.length > 0 ? byPointer : rectIntersection(args);
      let overId = getFirstCollision(hits, "id");
      if (overId != null) {
        const items = cellsRef.current[String(overId)];
        if (items && items.length > 0) {
          const inside = closestCenter({
            ...args,
            droppableContainers: args.droppableContainers.filter((c) =>
              items.includes(String(c.id)),
            ),
          });
          overId = inside[0]?.id ?? overId;
        }
        lastOverId.current = overId;
        return [{ id: overId }];
      }
      if (recentlyMoved.current) lastOverId.current = activeId;
      return lastOverId.current != null ? [{ id: lastOverId.current }] : [];
    },
    [activeId],
  );

  const sensors = useSensors(
    // A short travel before a drag starts keeps clicks (open the card) working.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const findCell = useCallback(
    (id: string, from: Cells): string | undefined =>
      id in from ? id : Object.keys(from).find((key) => from[key]?.includes(id)),
    [],
  );

  const drop = useCallback(
    (id: string, cell: string, order: string[]) => {
      const [laneKey, statusId] = cell.split(SEP) as [string, string];
      void moveCard(store, {
        id,
        statusId,
        order,
        laneChanges: lanesByKey.get(laneKey)?.changes ?? [],
      });
    },
    [store, lanesByKey],
  );

  const onDragStart = ({ active }: DragStartEvent) => {
    lastOverId.current = null;
    setOverlayWidth(active.rect.current.initial?.width ?? null);
    setActiveId(String(active.id));
    setDragCells(boardCells);
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    const overCell = over ? findCell(String(over.id), cellsRef.current) : undefined;
    setHoverLane(overCell ? (overCell.split(SEP)[0] as string) : null);
    if (!over || recentlyMoved.current) return;
    setDragCells((prev) => {
      const current = prev ?? boardCells;
      const activeKey = String(active.id);
      const overKey = String(over.id);
      const from = findCell(activeKey, current);
      const to = findCell(overKey, current);
      if (!from || !to || from === to) return current;
      const target = [...(current[to] ?? [])];
      const overIndex = target.indexOf(overKey);
      const translated = active.rect.current.translated;
      const below = !!translated && translated.top > over.rect.top + over.rect.height / 2;
      const index = overIndex < 0 ? target.length : overIndex + (below ? 1 : 0);
      target.splice(index, 0, activeKey);
      recentlyMoved.current = true;
      return {
        ...current,
        [from]: (current[from] ?? []).filter((id) => id !== activeKey),
        [to]: target,
      };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const current = dragCells ?? boardCells;
    const opened = springOpen;
    endDrag();
    if (!over) return;
    const id = String(active.id);
    const to = findCell(String(over.id), current);
    if (!to) return;
    let order = current[to] ?? [];
    const oldIndex = order.indexOf(id);
    const newIndex = order.indexOf(String(over.id));
    if (oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex) {
      order = arrayMove(order, oldIndex, newIndex);
    }
    // Dropped on a collapsed column or lane: on top, where it shows once it is expanded.
    const [toLane, toStatus] = to.split(SEP) as [string, string];
    const laneShut = collapsedLanes.isCollapsed(toLane) && !opened.has(toLane);
    if (columns.isCollapsed(toStatus) || laneShut) {
      order = [id, ...order.filter((other) => other !== id)];
    }
    const origin = findCell(id, boardCells);
    if (origin === to && sameOrder(order, boardCells[to])) return;
    drop(id, to, order);
  };

  const onDragCancel = endDrag;

  /** Alt+←/→: to the top of the same lane in the previous or next column. */
  const onCardKey = useCallback(
    (e: KeyboardEvent, id: string) => {
      if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return false;
      e.preventDefault();
      const from = findCell(id, boardCells);
      if (!from) return true;
      const [laneKey, statusId] = from.split(SEP) as [string, string];
      const target = adjacentStatus(board.columns, statusId, e.key === "ArrowLeft" ? -1 : 1);
      if (!target) return true;
      const to = `${laneKey}${SEP}${target}`;
      drop(id, to, [id, ...(boardCells[to] ?? [])]);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)?.focus();
      });
      return true;
    },
    [board.columns, boardCells, drop, findCell],
  );

  const active = activeId ? cards.get(activeId) : undefined;
  const lanes = board.lanes.length > 1 || board.lanes[0]?.key !== "all";
  const panRef = useMiddleDragPan<HTMLDivElement>();
  // Columns without a chosen width share the board's width, so nothing scrolls sideways.
  useEffect(() => {
    const el = panRef.current;
    if (!el) return;
    const measure = () => setAvailable(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [panRef]);

  const laneCount = (lane: Lane) =>
    board.columns.reduce((sum, c) => sum + (cells[cellId(lane, c.status.id)] ?? []).length, 0);

  /** A collapsed lane: one low drop strip per column, aligned with the columns. */
  const laneStrips = (lane: Lane) => (
    <div className="flex gap-3.5 px-7 pb-2">
      {board.columns.map((column) => {
        const id = cellId(lane, column.status.id);
        const statusId = column.status.id;
        return (
          <LaneStrip
            key={id}
            id={id}
            label={`${column.status.name}, ${lane.label}`}
            count={(cells[id] ?? []).length}
            width={columns.isCollapsed(statusId) ? COLLAPSED_WIDTH : columns.widthOf(statusId)}
            dragging={activeId !== null}
          />
        );
      })}
    </div>
  );

  const laneCells = (lane: Lane) => (
    <div className={cx("flex gap-3.5 px-7 pb-4", !lanes && "min-h-0 flex-1")}>
      {board.columns.map((column) => {
        const id = cellId(lane, column.status.id);
        if (columns.isCollapsed(column.status.id)) {
          return (
            <CollapsedCell
              key={id}
              id={id}
              column={column}
              count={(cells[id] ?? []).length}
              inLane={lanes}
              onExpand={() => columns.setCollapsed(column.status.id, false)}
            />
          );
        }
        return (
          <BoardCell
            key={id}
            id={id}
            label={lanes ? `${column.status.name}, ${lane.label}` : column.status.name}
            ids={cells[id] ?? []}
            width={columns.widthOf(column.status.id)}
            cards={cards}
            bounded={lanes}
            activeId={activeId}
            selectedId={selectedId}
            onOpen={onOpen}
            onCardKey={onCardKey}
            lookups={lookups}
          />
        );
      })}
    </div>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div
        ref={panRef}
        className={cx("min-h-0 flex-1 overflow-auto", lanes ? "" : "flex")}
        data-testid="board"
      >
        <div className={cx("flex min-w-max flex-col", !lanes && "flex-1")}>
          <div className="tex-canvas-pinned sticky top-0 z-10 flex gap-3.5 bg-canvas px-7 pt-2 pb-2">
            {board.columns.map((column) => (
              <ColumnHeader
                key={column.status.id}
                column={column}
                columns={columns}
                expandHere={lanes}
              />
            ))}
          </div>
          {board.lanes.map((lane) => (
            <section
              key={lane.key}
              aria-label={lanes ? `Lane ${lane.label}` : undefined}
              className={cx("flex flex-col", !lanes && "min-h-0 flex-1")}
            >
              {lanes && (
                <LaneHeader
                  lane={lane}
                  collapsed={collapsedLanes.isCollapsed(lane.key)}
                  count={laneCount(lane)}
                  onToggle={(collapsed) => collapsedLanes.setCollapsed(lane.key, collapsed)}
                />
              )}
              {lanes && !laneOpen(lane.key) ? laneStrips(lane) : laneCells(lane)}
            </section>
          ))}
        </div>
      </div>
      <DragOverlay>
        {active && (
          <div style={{ width: overlayWidth ?? undefined }}>
            <CardFace
              {...lookups}
              task={active.task}
              childCount={active.childCount}
              childDone={active.childDone}
              overlay
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function ColumnCount({ column }: { column: Column }) {
  return (
    <span
      className={cx(
        "text-[12.5px] tabular-nums",
        column.overLimit ? "rounded-md bg-danger/15 px-1.5 text-danger" : "text-ink-3",
      )}
      title={column.overLimit ? "Over the WIP limit" : undefined}
    >
      {column.status.wip_limit !== null
        ? `${column.count}/${column.status.wip_limit}`
        : column.count}
    </span>
  );
}

/**
 * A column's sticky header: name, count, a collapse button and a resize handle on its right
 * edge. Collapsed, it keeps the strip's width; with swimlanes it holds the expand button
 * (without lanes, the strip below is the button).
 */
function ColumnHeader({
  column,
  columns,
  expandHere,
}: {
  column: Column;
  columns: BoardColumns;
  expandHere: boolean;
}) {
  const { id, name } = column.status;
  if (columns.isCollapsed(id)) {
    return (
      <div className="flex shrink-0 items-center justify-center" style={{ width: COLLAPSED_WIDTH }}>
        {expandHere ? (
          <button
            type="button"
            aria-label={`Expand ${name}`}
            title={`Expand ${name}`}
            onClick={() => columns.setCollapsed(id, false)}
            className="flex items-center gap-1 rounded-md px-1 py-0.5 text-ink-3 hover:bg-hover hover:text-ink"
          >
            <Dot color={column.status.color} />
            <ChevronsRight size={14} />
          </button>
        ) : (
          <Dot color={column.status.color} />
        )}
      </div>
    );
  }
  const width = columns.widthOf(id);
  return (
    <div className="group relative flex shrink-0 items-center gap-2 px-2.5" style={{ width }}>
      <Dot color={column.status.color} />
      <span className="truncate font-display text-[15px] tracking-wide text-rubric">{name}</span>
      <ColumnCount column={column} />
      <button
        type="button"
        aria-label={`Collapse ${name}`}
        title={`Collapse ${name}`}
        onClick={() => columns.setCollapsed(id, true)}
        className="ml-auto rounded-md p-0.5 text-ink-3 opacity-0 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
      >
        <ChevronsLeft size={14} />
      </button>
      <ResizeHandle label={name} width={width} onResize={(w) => columns.setWidth(id, w)} />
    </div>
  );
}

/**
 * Drag to resize a column, double-click to reset; when focused, ←/→ step by 16 px (Shift:
 * 64), Home and End jump to the limits. Sits in the gap to the right of the column.
 */
function ResizeHandle({
  label,
  width,
  onResize,
}: {
  label: string;
  width: number;
  onResize(width: number | null): void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const end = (e: PointerEvent<HTMLDivElement>) => {
    start.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter (WAI-ARIA separator); <hr> cannot take focus
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuenow={width}
      aria-valuemin={MIN_COLUMN_WIDTH}
      aria-valuemax={MAX_COLUMN_WIDTH}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className="absolute inset-y-0 -right-[11px] w-2 cursor-col-resize touch-none rounded-full bg-rubric/20 outline-none transition-colors hover:bg-rubric/40 focus-visible:bg-rubric/60"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        if (start.current) onResize(start.current.width + e.clientX - start.current.x);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onResize(null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const next =
          e.key === "ArrowLeft"
            ? width - step
            : e.key === "ArrowRight"
              ? width + step
              : e.key === "Home"
                ? MIN_COLUMN_WIDTH
                : e.key === "End"
                  ? MAX_COLUMN_WIDTH
                  : null;
        if (next === null) return;
        e.preventDefault();
        onResize(next);
      }}
    />
  );
}

/**
 * A collapsed column (or lane × column): a narrow strip that still takes drops. Without
 * swimlanes it shows the column's name and count and expands on click; in a lane, only the
 * lane's count (the header holds the expand button).
 */
function CollapsedCell({
  id,
  column,
  count,
  inLane,
  onExpand,
}: {
  id: string;
  column: Column;
  count: number;
  inLane: boolean;
  onExpand(): void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const className = cx(
    "flex shrink-0 flex-col items-center gap-2 rounded-[14px] border border-line bg-hover/60 py-3",
    inLane ? "min-h-16" : "min-h-0",
    isOver && "ring-2 ring-accent/60",
  );
  if (inLane) {
    return (
      <div
        ref={setNodeRef}
        className={className}
        style={{ width: COLLAPSED_WIDTH }}
        title={`${column.status.name} (collapsed)`}
      >
        <span className="text-[12.5px] text-ink-3 tabular-nums">{count}</span>
      </div>
    );
  }
  return (
    <button
      ref={setNodeRef}
      type="button"
      aria-label={`Expand ${column.status.name}`}
      title={`Expand ${column.status.name}`}
      onClick={onExpand}
      className={cx(className, "text-ink-3 hover:border-line-strong hover:text-ink")}
      style={{ width: COLLAPSED_WIDTH }}
    >
      <ChevronsRight size={14} />
      <span className="font-display text-[15px] tracking-wide text-rubric [writing-mode:vertical-rl]">
        {column.status.name}
      </span>
      <ColumnCount column={column} />
    </button>
  );
}

/** A swimlane's title; a click collapses the lane to a strip (with its count) or opens it. */
function LaneHeader({
  lane,
  collapsed,
  count,
  onToggle,
}: {
  lane: Lane;
  collapsed: boolean;
  count: number;
  onToggle(collapsed: boolean): void;
}) {
  return (
    <h2 className="px-7 pt-4 pb-1.5">
      <button
        type="button"
        aria-expanded={!collapsed}
        title={collapsed ? `Expand ${lane.label}` : `Collapse ${lane.label}`}
        onClick={() => onToggle(!collapsed)}
        className="flex items-center gap-2 rounded-md px-2 py-0.5 font-display text-[15px] tracking-wide text-rubric hover:bg-hover"
      >
        <ChevronsRight
          size={14}
          className={cx("text-ink-3 transition-transform", !collapsed && "rotate-90")}
        />
        {lane.color !== null && <Dot color={lane.color} />}
        {lane.label}
        {collapsed && (
          <span className="font-sans text-[12.5px] tracking-normal text-ink-3 tabular-nums">
            {count}
          </span>
        )}
      </button>
    </h2>
  );
}

/**
 * A cell of a collapsed swimlane: a low strip with the cell's count that still takes drops
 * (on top of the cell). While a card is dragged, it says that holding it there opens the lane.
 */
function LaneStrip({
  id,
  label,
  count,
  width,
  dragging,
}: {
  id: string;
  label: string;
  count: number;
  width: number;
  dragging: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    // biome-ignore lint/a11y/useSemanticElements: a drop strip, not a form control group; <fieldset> would be wrong
    <div
      ref={setNodeRef}
      role="group"
      aria-label={`${label} (collapsed)`}
      data-testid="lane-strip"
      className={cx(
        "flex h-9 shrink-0 items-center justify-center rounded-[14px] border border-dashed border-line bg-hover/40 text-[12.5px] text-ink-3 tabular-nums",
        isOver && "border-solid ring-2 ring-accent/60",
      )}
      style={{ width }}
    >
      {isOver && dragging && width > COLLAPSED_WIDTH ? "Hold to open" : count > 0 ? count : ""}
    </div>
  );
}

interface CellProps {
  id: string;
  label: string;
  ids: string[];
  /** Column width in px; a wide column places cards side by side (`lanesFor`). */
  width: number;
  cards: Map<string, Card>;
  /** In a swimlane: a capped height with its own scroll. Otherwise the full column. */
  bounded: boolean;
  activeId: string | null;
  selectedId: string | null;
  onOpen(id: string): void;
  onCardKey(e: KeyboardEvent, id: string): boolean;
  lookups: CardLookups;
}

/**
 * One column (or lane × column): a drop target with a virtualized, sortable card list.
 * Rows are virtualized; a row holds one card per lane, in rank order left to right.
 */
function BoardCell(p: CellProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { setNodeRef, isOver } = useDroppable({ id: p.id });
  const lanes = lanesFor(p.width);
  const virtualizer = useVirtualizer({
    count: Math.ceil(p.ids.length / lanes),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_SLOT,
    getItemKey: (row) => `${lanes}:${p.ids[row * lanes] ?? row}`,
    overscan: 6,
  });

  return (
    <SortableContext
      id={p.id}
      items={p.ids}
      strategy={lanes > 1 ? rectSortingStrategy : verticalListSortingStrategy}
    >
      <div
        ref={setNodeRef}
        className={cx(
          "flex shrink-0 flex-col overflow-hidden rounded-[14px] border border-line bg-hover/60 p-2",
          p.bounded ? "max-h-[28rem] min-h-16" : "min-h-0",
          isOver && "ring-2 ring-accent/60",
        )}
        style={{ width: p.width }}
      >
        {/* Grow the scrollport into the cell's padding (cards stay put) so a selected or
            focused card's ring, drawn outside the card, is not clipped at the top and left;
            the right inset also keeps native scrollbars clear of the rounded border. */}
        <div ref={scrollRef} className="-mx-1 -mt-1 min-h-0 flex-1 overflow-y-auto px-1 pt-1">
          <ul
            aria-label={p.label}
            data-lanes={lanes}
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().flatMap((row) =>
              p.ids.slice(row.index * lanes, (row.index + 1) * lanes).map((cardId, lane) => {
                const card = p.cards.get(cardId);
                if (!card) return null;
                return (
                  <li
                    key={cardId}
                    style={{
                      position: "absolute",
                      top: row.start,
                      left: `calc((100% + ${LANE_GAP}px) * ${lane} / ${lanes})`,
                      width: `calc((100% - ${LANE_GAP * (lanes - 1)}px) / ${lanes})`,
                    }}
                  >
                    <SortableCard
                      card={card}
                      placeholder={card.task.id === p.activeId}
                      selected={card.task.id === p.selectedId}
                      onOpen={p.onOpen}
                      onCardKey={p.onCardKey}
                      lookups={p.lookups}
                    />
                  </li>
                );
              }),
            )}
          </ul>
        </div>
      </div>
    </SortableContext>
  );
}

const SortableCard = memo(function SortableCard({
  card,
  placeholder,
  selected,
  onOpen,
  onCardKey,
  lookups,
}: {
  card: Card;
  placeholder: boolean;
  selected: boolean;
  onOpen(id: string): void;
  onCardKey(e: KeyboardEvent, id: string): boolean;
  lookups: CardLookups;
}) {
  const id = card.task.id;
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  // A div, not a <button>: the card face holds block content. dnd-kit's attributes already
  // set role and tabIndex; they are repeated so the linter sees them.
  return (
    // biome-ignore lint/a11y/useSemanticElements: see above
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      aria-label={card.task.title}
      data-card-id={id}
      data-testid="board-card"
      onClick={() => onOpen(id)}
      onKeyDown={(e) => {
        if (onCardKey(e, id)) return;
        if (e.key === "Enter" && !e.altKey) {
          onOpen(id);
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
      className="cursor-grab rounded-md pb-2 outline-none focus-visible:[&>div]:ring-2 focus-visible:[&>div]:ring-accent"
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <CardFace
        {...lookups}
        task={card.task}
        childCount={card.childCount}
        childDone={card.childDone}
        selected={selected}
        placeholder={placeholder}
      />
    </div>
  );
});
