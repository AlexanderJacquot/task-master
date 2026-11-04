import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type ReactNode, useEffect, useRef } from "react";
import type { Project } from "../../lib/types";
import { moveProject } from "../../store/actions";
import { useTaskStore } from "../../store/context";

export interface AreaNode {
  area: Project;
  children: Project[];
}

function Sortable({ id, children }: { id: string; children: ReactNode }) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    // Pointer drag only: the links inside keep Enter/Space, and keyboard focus, to themselves.
    <div
      ref={setNodeRef}
      onPointerDown={listeners?.onPointerDown as React.PointerEventHandler | undefined}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : undefined,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Areas and their projects, each level reorderable by pointer drag (siblings only; the
 * project page's Area menu moves a project into another area).
 */
export function ProjectTree({
  nodes,
  renderProject,
}: {
  nodes: AreaNode[];
  renderProject(project: Project, children: Project[]): ReactNode;
}) {
  const store = useTaskStore();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const siblingsOf = (id: string): Project[] | null => {
    if (nodes.some((n) => n.area.id === id)) return nodes.map((n) => n.area);
    return nodes.find((n) => n.children.some((c) => c.id === id))?.children ?? null;
  };

  // A drop ends with a click on the dragged link. dnd-kit stops that click's propagation
  // at the window (so React handlers never see it) but not its default action, so the
  // link's href would still navigate. Cancel it natively, before dnd-kit's listener.
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
    if (!over || active.id === over.id) return;
    const siblings = siblingsOf(String(active.id));
    if (!siblings) return;
    const ids = siblings.map((p) => p.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const order = arrayMove(ids, from, to);
    const at = order.indexOf(String(active.id));
    const parent = siblings[0]?.parent_id ?? null;
    void moveProject(
      store,
      String(active.id),
      parent,
      order[at - 1] ?? null,
      order[at + 1] ?? null,
    );
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
      <SortableContext items={nodes.map((n) => n.area.id)} strategy={verticalListSortingStrategy}>
        {nodes.map(({ area, children }) => (
          <Sortable key={area.id} id={area.id}>
            {renderProject(area, children)}
            <SortableContext
              items={children.map((c) => c.id)}
              strategy={verticalListSortingStrategy}
            >
              {children.map((p) => (
                <Sortable key={p.id} id={p.id}>
                  <div className="pl-4">{renderProject(p, [])}</div>
                </Sortable>
              ))}
            </SortableContext>
          </Sortable>
        ))}
      </SortableContext>
    </DndContext>
  );
}
