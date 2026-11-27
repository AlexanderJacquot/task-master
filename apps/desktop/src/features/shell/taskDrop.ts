/**
 * Dropping a dragged task outside the view it comes from: on a sidebar project, epic or
 * Today, or on the open task's detail panel (as a subtask or as its parent).
 *
 * Each view keeps its own dnd-kit `DndContext`, and droppables only collide with the
 * context they are registered in, so these targets are plain elements marked with
 * `data-task-drop` and hit-tested at the pointer. A view's drag calls `startTaskDrag` /
 * `finishTaskDrag` and checks `taskDropOver()` before its own collision detection.
 */
import { useSyncExternalStore } from "react";
import { isoDate } from "../../lib/dates";
import type { Task } from "../../lib/types";
import { setParent, setParents, updateTasks } from "../../store/actions";
import { useTaskStore } from "../../store/context";
import type { TaskStore } from "../../store/store";
import { ancestorIds } from "../task-detail/hierarchy";

export type TaskDropTarget =
  | { kind: "project"; id: string }
  | { kind: "epic"; id: string }
  | { kind: "today" }
  /** The dragged task becomes a subtask of `id`. */
  | { kind: "subtask-of"; id: string }
  /** The dragged task becomes the parent of `id`. */
  | { kind: "parent-of"; id: string };

export const DROP_ATTR = "data-task-drop";

/** Classes for a target row under a dragged task. */
export const DROP_OVER_CLASS = "bg-accent/15 text-ink ring-2 ring-accent/60";

export function dropKey(target: TaskDropTarget): string {
  return target.kind === "today" ? "today" : `${target.kind}:${target.id}`;
}

export function parseDropKey(key: string): TaskDropTarget | null {
  if (key === "today") return { kind: "today" };
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (at < 0 || !id) return null;
  if (kind === "project" || kind === "epic" || kind === "subtask-of" || kind === "parent-of")
    return { kind, id };
  return null;
}

/** False when the drop would change nothing or make a cycle in the task tree. */
export function canDrop(target: TaskDropTarget, taskId: string, tasks: Record<string, Task>) {
  const task = tasks[taskId];
  if (!task) return false;
  switch (target.kind) {
    case "project":
      return task.project_id !== target.id;
    case "epic":
      return task.epic_id !== target.id;
    case "today":
      return task.today_on !== isoDate();
    case "subtask-of":
      return (
        !!tasks[target.id] &&
        target.id !== taskId &&
        task.parent_id !== target.id &&
        !ancestorIds(target.id, tasks).includes(taskId)
      );
    case "parent-of": {
      const other = tasks[target.id];
      return (
        !!other &&
        target.id !== taskId &&
        other.parent_id !== taskId &&
        !ancestorIds(taskId, tasks).includes(target.id)
      );
    }
  }
}

/**
 * The dragged tasks a target takes: those `canDrop` allows. A task has one parent, so
 * "parent of" takes a single dragged task only.
 */
export function droppable(
  target: TaskDropTarget,
  taskIds: readonly string[],
  tasks: Record<string, Task>,
): string[] {
  if (target.kind === "parent-of" && taskIds.length > 1) return [];
  return taskIds.filter((id) => canDrop(target, id, tasks));
}

/** Applies a drop of one or several dragged tasks as one undoable write. */
export function applyTaskDrop(
  store: TaskStore,
  taskIds: string | readonly string[],
  target: TaskDropTarget,
) {
  const dragged = typeof taskIds === "string" ? [taskIds] : taskIds;
  const ids = droppable(target, dragged, store.getState().tasks);
  if (!ids.length) return Promise.resolve(null);
  switch (target.kind) {
    case "project":
      return updateTasks(store, ids, [{ project_id: target.id }]);
    case "epic":
      return updateTasks(store, ids, [{ epic_id: target.id }]);
    case "today":
      return updateTasks(store, ids, [{ today_on: isoDate() }]);
    case "subtask-of":
      return setParents(store, ids, target.id);
    case "parent-of":
      return setParent(store, target.id, ids[0] as string);
  }
}

// ---------------------------------------------------------------------------------------
// Drag state shared by the dragging view and the targets.

interface DragState {
  /** The task under the pointer, or null. */
  dragging: string | null;
  /** Every dragged task (several when a multi-selection is dragged), `dragging` first. */
  group: readonly string[];
  /** The key of the target under the pointer, or null. */
  over: string | null;
}

const IDLE: DragState = { dragging: null, group: [], over: null };
let state: DragState = IDLE;
const listeners = new Set<() => void>();

function set(next: DragState) {
  const same =
    next.dragging === state.dragging && next.group === state.group && next.over === state.over;
  if (same) return;
  state = next;
  for (const l of listeners) l();
}

/** The target key under a point: the topmost marked element (the drag overlay is skipped). */
export function hitTest(x: number, y: number): string | null {
  if (typeof document.elementsFromPoint !== "function") return null;
  for (const el of document.elementsFromPoint(x, y)) {
    const target = el.closest(`[${DROP_ATTR}]`);
    if (target) return target.getAttribute(DROP_ATTR);
  }
  return null;
}

// Capture on window: runs before dnd-kit's document listeners, so a view's collision
// detection already sees the target under the pointer.
function onPointerMove(e: PointerEvent) {
  if (state.dragging) set({ ...state, over: hitTest(e.clientX, e.clientY) });
}

/** Starts a drag of `taskId`, with the other tasks dragged along with it (a selection). */
export function startTaskDrag(taskId: string, along: readonly string[] = []) {
  set({ dragging: taskId, group: [taskId, ...along.filter((id) => id !== taskId)], over: null });
  window.addEventListener("pointermove", onPointerMove, { capture: true });
}

/** Ends the drag; returns the target it was dropped on, if any. */
export function finishTaskDrag(): TaskDropTarget | null {
  const over = state.over;
  window.removeEventListener("pointermove", onPointerMove, { capture: true });
  set(IDLE);
  return over ? parseDropKey(over) : null;
}

/** The target key under the pointer during a drag (for collision detection). */
export function taskDropOver(): string | null {
  return state.over;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTaskDrag(): DragState {
  return useSyncExternalStore(subscribe, () => state);
}

/**
 * Marks an element as a drop target while a task it can take (`canDrop`) is dragged.
 * Spread `props` on the element; `isOver` is true while the pointer is over it.
 */
export function useTaskDropTarget(target: TaskDropTarget) {
  const store = useTaskStore();
  const { dragging, group, over } = useTaskDrag();
  const key = dropKey(target);
  const active = dragging !== null && droppable(target, group, store.getState().tasks).length > 0;
  return {
    active,
    isOver: active && over === key,
    props: (active ? { [DROP_ATTR]: key } : {}) as Record<string, string>,
  };
}
