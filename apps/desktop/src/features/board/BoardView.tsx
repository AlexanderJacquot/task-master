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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx, Dot } from "../../components/ui";
import { adjacentStatus, type Board, type Card, type Lane } from "../../lib/board";
import { moveCard } from "../../store/actions";
import { useTaskStore } from "../../store/context";
import { CARD_SLOT, CardFace, type CardLookups } from "./BoardCard";

interface Props {
  board: Board;
  /** Memoized by the caller so cards only re-render when their task changes. */
  lookups: CardLookups;
  selectedId: string | null;
  onOpen(id: string): void;
}

type Cells = Record<string, string[]>;

const SEP = "|";
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
 * card moves to the previous or next column with `Alt+←/→`.
 */
export function BoardView({ board, selectedId, onOpen, lookups }: Props) {
  const store = useTaskStore();
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
    setActiveId(String(active.id));
    setDragCells(boardCells);
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
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
    setDragCells(null);
    setActiveId(null);
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
    const origin = findCell(id, boardCells);
    if (origin === to && sameOrder(order, boardCells[to])) return;
    drop(id, to, order);
  };

  const onDragCancel = () => {
    setDragCells(null);
    setActiveId(null);
  };

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

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className={cx("min-h-0 flex-1 overflow-auto", lanes ? "" : "flex")} data-testid="board">
        <div className={cx("flex min-w-max flex-col", !lanes && "flex-1")}>
          <div className="sticky top-0 z-10 flex gap-3.5 bg-canvas px-7 pt-2 pb-2">
            {board.columns.map((column) => (
              <div key={column.status.id} className="flex w-[17.5rem] items-center gap-2 px-2.5">
                <Dot color={column.status.color} />
                <span className="font-display text-[15px] tracking-wide text-rubric">
                  {column.status.name}
                </span>
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
              </div>
            ))}
          </div>
          {board.lanes.map((lane) => (
            <section
              key={lane.key}
              aria-label={lanes ? `Lane ${lane.label}` : undefined}
              className={cx("flex flex-col", !lanes && "min-h-0 flex-1")}
            >
              {lanes && (
                <h2 className="flex items-center gap-2 px-9 pt-4 pb-1.5 font-display text-[15px] tracking-wide text-rubric">
                  {lane.color !== null && <Dot color={lane.color} />}
                  {lane.label}
                </h2>
              )}
              <div className={cx("flex gap-3.5 px-7 pb-4", !lanes && "min-h-0 flex-1")}>
                {board.columns.map((column) => {
                  const id = cellId(lane, column.status.id);
                  return (
                    <BoardCell
                      key={id}
                      id={id}
                      label={lanes ? `${column.status.name}, ${lane.label}` : column.status.name}
                      ids={cells[id] ?? []}
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
            </section>
          ))}
        </div>
      </div>
      <DragOverlay>
        {active && (
          <div className="w-[17.5rem]">
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

interface CellProps {
  id: string;
  label: string;
  ids: string[];
  cards: Map<string, Card>;
  /** In a swimlane: a capped height with its own scroll. Otherwise the full column. */
  bounded: boolean;
  activeId: string | null;
  selectedId: string | null;
  onOpen(id: string): void;
  onCardKey(e: KeyboardEvent, id: string): boolean;
  lookups: CardLookups;
}

/** One column (or lane × column): a drop target with a virtualized, sortable card list. */
function BoardCell(p: CellProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { setNodeRef, isOver } = useDroppable({ id: p.id });
  const virtualizer = useVirtualizer({
    count: p.ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_SLOT,
    getItemKey: (i) => p.ids[i] ?? i,
    overscan: 6,
  });

  return (
    <SortableContext id={p.id} items={p.ids} strategy={verticalListSortingStrategy}>
      <div
        ref={(el) => {
          scrollRef.current = el;
          setNodeRef(el);
        }}
        className={cx(
          "w-[17.5rem] shrink-0 overflow-y-auto rounded-[14px] border border-line bg-hover/60 p-2",
          p.bounded ? "max-h-[28rem] min-h-16" : "min-h-0",
          isOver && "ring-2 ring-accent/60",
        )}
      >
        <ul
          aria-label={p.label}
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const card = p.cards.get(p.ids[item.index] as string);
            if (!card) return null;
            return (
              <li
                key={item.key}
                style={{ position: "absolute", top: item.start, left: 0, right: 0 }}
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
          })}
        </ul>
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
