import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type HTMLAttributes, type ReactNode, useEffect, useRef } from "react";
import { unzoomTransform, useRegionZoom } from "../lib/zoom";

/** What a row gets to wire its drag handle, when the list drags by a handle. */
export interface SortableRow {
  handleProps: HTMLAttributes<HTMLElement>;
  dragging: boolean;
}

/**
 * Marks a part of a row (a nested tree with its own drags) where a pointer press does not
 * start dragging the row.
 */
export const NO_ROW_DRAG = { "data-no-row-drag": "" } as const;

function Row<T extends string>({
  id,
  wholeRow,
  children,
}: {
  id: T;
  wholeRow: boolean;
  children(id: T, row: SortableRow): ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const zoom = useRegionZoom();
  const style = {
    transform: CSS.Translate.toString(unzoomTransform(transform, zoom)),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    position: "relative" as const,
    zIndex: isDragging ? 1 : undefined,
  };
  if (wholeRow)
    return (
      // Pointer drag anywhere on the row; the links inside keep the keyboard to themselves.
      <div
        ref={setNodeRef}
        style={style}
        onPointerDown={(e) => {
          if ((e.target as Element).closest("[data-no-row-drag]")) return;
          listeners?.onPointerDown?.(e);
        }}
      >
        {children(id, { handleProps: {}, dragging: isDragging })}
      </div>
    );
  return (
    <div ref={setNodeRef} style={style}>
      {children(id, {
        handleProps: { ...attributes, ...(listeners as HTMLAttributes<HTMLElement>) },
        dragging: isDragging,
      })}
    </div>
  );
}

/**
 * A vertical list reordered by dragging: the whole row with the pointer (`wholeRow`, for
 * rows that are links), or a handle the row places itself, which also takes the keyboard
 * (Space to pick up, arrows to move, Space to drop).
 */
export function SortableList<T extends string>({
  ids,
  onMove,
  wholeRow = false,
  className,
  children,
}: {
  ids: T[];
  onMove(id: T, over: T): void;
  wholeRow?: boolean;
  className?: string;
  children(id: T, row: SortableRow): ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // A drop ends with a click on the dragged row. dnd-kit stops that click's propagation at
  // the window but not its default action, so a link would still navigate: cancel it.
  const droppedAt = useRef(0);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (Date.now() - droppedAt.current < 250) e.preventDefault();
    };
    window.addEventListener("click", onClick, { capture: true });
    return () => window.removeEventListener("click", onClick, { capture: true });
  }, []);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    droppedAt.current = Date.now();
    if (over && active.id !== over.id) onMove(active.id as T, over.id as T);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={() => {
        // Armed for the whole drag: the drop's click can arrive before onDragEnd runs.
        droppedAt.current = Number.POSITIVE_INFINITY;
      }}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        droppedAt.current = Date.now();
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className={className}>
          {ids.map((id) => (
            <Row key={id} id={id} wholeRow={wholeRow}>
              {children}
            </Row>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
