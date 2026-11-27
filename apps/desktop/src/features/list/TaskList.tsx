import {
  DndContext,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cx, Dot } from "../../components/ui";
import { ZoomDragOverlay } from "../../components/ZoomDragOverlay";
import type { Task } from "../../lib/types";
import type { Row } from "../../lib/views";
import { useTaskStore } from "../../store/context";
import { applyTaskDrop, finishTaskDrag, startTaskDrag } from "../shell/taskDrop";
import { isEditable } from "../shell/useShortcuts";
import { type RowHandlers, type RowLookups, TaskRow } from "./TaskRow";

interface Props extends RowHandlers, RowLookups {
  rows: Row[];
  selectedId: string | null;
  /** The multi-selection; while it has tasks, they are marked instead of the open one. */
  picked: ReadonlySet<string>;
  onToggleGroup(groupKey: string): void;
}

const ROW_HEIGHT = 36;
const GROUP_HEIGHT = 44;

/**
 * The tasks dragged together when `id` is dragged: the selection in list order, when `id`
 * is in a selection of several; else null (just `id`).
 */
export function listDragGroup(
  rows: readonly Row[],
  picked: ReadonlySet<string>,
  id: string,
): string[] | null {
  if (picked.size < 2 || !picked.has(id)) return null;
  const shown = rows.flatMap((r) =>
    r.type === "task" && picked.has(r.task.id) ? [r.task.id] : [],
  );
  // Picked tasks under a folded row or group still go along, after the ones on screen.
  const ids = [...shown, ...[...picked].filter((other) => !shown.includes(other))];
  return ids.length > 1 ? ids : null;
}

/**
 * Virtualized rows: only what is on screen is rendered, however long the list. Rows drag
 * onto the targets outside the list (`taskDrop`): the sidebar's Today, projects and epics,
 * the Today panel, the open task's panel. The list keeps its own order (no drop in it).
 */
export function TaskList({ rows, selectedId, picked, onToggleGroup, ...rowProps }: Props) {
  const store = useTaskStore();
  const picking = picked.size > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === "group" ? GROUP_HEIGHT : ROW_HEIGHT),
    getItemKey: (i) => {
      const row = rows[i];
      if (!row) return i;
      return row.type === "group" ? `g:${row.group.key}` : `t:${row.task.id}`;
    },
    overscan: 12,
  });

  // A short travel before a drag starts keeps clicks (open, check, rename) working.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [dragged, setDragged] = useState<{ task: Task; count: number } | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const group = useRef<string[]>([]);
  // Read at drag start, so the handler stays stable.
  const latest = useRef({ rows, picked });
  latest.current = { rows, picked };

  const onDragStart = useCallback(({ active }: DragStartEvent) => {
    const id = String(active.id);
    const { rows: now, picked: chosen } = latest.current;
    const row = now.find((r) => r.type === "task" && r.task.id === id);
    if (row?.type !== "task") return;
    const together = listDragGroup(now, chosen, id);
    group.current = together ?? [id];
    setWidth(active.rect.current.initial?.width ?? null);
    setDragged({ task: row.task, count: group.current.length });
    startTaskDrag(id, together ?? []);
  }, []);
  const onDragEnd = useCallback(() => {
    const target = finishTaskDrag();
    setDragged(null);
    if (target) void applyTaskDrop(store, group.current, target);
  }, [store]);
  const onDragCancel = useCallback(() => {
    finishTaskDrag();
    setDragged(null);
  }, []);
  // Unmounted mid-drag (route change): stop tracking the pointer.
  useEffect(() => () => void finishTaskDrag(), []);

  return (
    <DndContext
      sensors={sensors}
      // Nothing to drop on inside the list: the targets are outside it (`taskDrop`).
      collisionDetection={() => []}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pb-8">
        <ul style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <li
                key={item.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row.type === "group" ? (
                  <button
                    type="button"
                    onClick={() => onToggleGroup(row.group.key)}
                    aria-expanded={!row.collapsed}
                    className="mx-6 flex h-full w-[calc(100%-3rem)] items-end gap-2.5 px-2 pb-1.5 text-left"
                  >
                    <span className="mb-[3px] flex w-4 justify-center text-ink-3">
                      {row.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </span>
                    <Dot color={row.group.color} className="mb-[5px]" />
                    <span className="font-display text-[15px] tracking-wide text-rubric">
                      {row.group.label}
                    </span>
                    <span className="mb-px text-[12.5px] text-ink-3 tabular-nums">{row.count}</span>
                    <span className="mb-[9px] h-px flex-1 bg-line" />
                  </button>
                ) : (
                  <DraggableRow
                    id={row.task.id}
                    along={!!dragged && dragged.count > 1 && picked.has(row.task.id)}
                  >
                    <TaskRow
                      {...rowProps}
                      task={row.task}
                      depth={row.depth}
                      childCount={row.childCount}
                      childDone={row.childDone}
                      visibleChildren={row.visibleChildren}
                      expanded={row.expanded}
                      selected={!picking && row.task.id === selectedId}
                      picked={picked.has(row.task.id)}
                    />
                  </DraggableRow>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <ZoomDragOverlay dropAnimation={null}>
        {dragged && <DragFace task={dragged.task} count={dragged.count} width={width} />}
      </ZoomDragOverlay>
    </DndContext>
  );
}

/** A row's drag handle: the whole row, except its inputs and what its menus portal out. */
function DraggableRow({
  id,
  along,
  children,
}: {
  id: string;
  /** Dragged along with another picked row: dimmed like the dragged one. */
  along: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id });
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // React bubbles events from portals (a Select's options, the date picker) through here.
    if (!e.currentTarget.contains(e.target as Node) || isEditable(e.target)) return;
    listeners?.onPointerDown?.(e);
  };
  return (
    <div
      ref={setNodeRef}
      onPointerDown={onPointerDown}
      data-dragging={isDragging || along || undefined}
      className={cx("h-full", (isDragging || along) && "opacity-40")}
    >
      {children}
    </div>
  );
}

/** What follows the pointer: the dragged task's title, and how many go along. */
function DragFace({ task, count, width }: { task: Task; count: number; width: number | null }) {
  return (
    <div className="relative" style={{ width: width ? Math.min(width, 420) : undefined }}>
      <div className="flex h-[34px] cursor-grabbing items-center gap-2 truncate rounded-[9px] border border-line-strong bg-raised px-3 text-ink shadow-lg shadow-black/20">
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
      </div>
      {count > 1 && (
        <span
          data-testid="drag-count"
          className="absolute -top-2 -right-2 min-w-6 rounded-full bg-accent px-1.5 py-0.5 text-center font-semibold text-[12px] text-accent-ink tabular-nums shadow-md"
        >
          {count}
        </span>
      )}
    </div>
  );
}
