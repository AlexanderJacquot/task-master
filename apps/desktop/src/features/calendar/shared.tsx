// Pieces shared by the calendar's grids and task tray.

import { useDraggable } from "@dnd-kit/core";
import { createContext, useContext } from "react";
import { DueDateIcon as Flag } from "../../components/TaskIcons";
import { cx, Dot, FOCUS } from "../../components/ui";
import type { Span } from "../../lib/calendar";
import type { PlanHours } from "../../lib/planner";
import type { Project, Status, Task, TimeBlock } from "../../lib/types";

/** What draggables carry: the calendar ref (`task:<id>` or `block:<id>`) and a label. */
export interface DragData {
  ref: string;
  label: string;
  /** Project color, for the overlay. */
  color: string | null;
}

export interface CalendarData {
  tasks: Record<string, Task>;
  projects: Record<string, Project>;
  statuses: Status[];
  today: string;
  now: number;
  openTask(id: string): void;
  /** True right after a drag, so the click that ends it does not also open things. */
  justDragged(): boolean;
  /** Opens a link outside the app (absent in tests). */
  openUrl?(url: string): void;
  /** A synced calendar's name, for event details. */
  calendarName(id: string): string;
  /** Working hours (set in Plan mode), where replanning looks for free time. */
  hours: PlanHours;
  /** Timed events of the shown range, busy for replanning. */
  busyEvents: Span[];
}

export const CalendarContext = createContext<CalendarData | null>(null);

export function useCalendar(): CalendarData {
  const data = useContext(CalendarContext);
  if (!data) throw new Error("useCalendar outside the calendar page");
  return data;
}

export function isClosed(task: Task, statuses: Status[]): boolean {
  const category = statuses.find((s) => s.id === task.status_id)?.category;
  return category === "done" || category === "cancelled";
}

export function projectColor(task: Task | undefined, projects: Record<string, Project>) {
  const id = task?.project_id;
  return (id && projects[id]?.color) || null;
}

/** Fill and edge of a block, from its project's color and outcome. */
export function blockStyle(color: string | null, outcome: TimeBlock["outcome"]) {
  const edge = color ?? "var(--tm-accent)";
  const strength = outcome === "planned" ? 22 : outcome === "missed" ? 6 : 12;
  return {
    borderLeftColor: edge,
    background: `color-mix(in srgb, ${edge} ${strength}%, var(--tm-raised))`,
    ...(outcome === "missed" && { borderLeftStyle: "dashed" as const }),
  };
}

/** A task planned for a day (draggable) or due that day (fixed), in a lane or month cell. */
export function DayChip({
  task,
  dragKey,
  due,
}: {
  task: Task;
  /** Unique draggable id; the chip is fixed when absent. */
  dragKey?: string;
  due?: boolean;
}) {
  const { projects, statuses, openTask, justDragged } = useCalendar();
  const color = projectColor(task, projects);
  const closed = isClosed(task, statuses);
  const data: DragData = { ref: `task:${task.id}`, label: task.title, color };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragKey ?? `fixed:${task.id}`,
    data,
    disabled: !dragKey,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...(dragKey ? attributes : {})}
      {...(dragKey ? listeners : {})}
      title={due ? `Due: ${task.title}` : task.title}
      onClick={() => !justDragged() && openTask(task.id)}
      className={cx(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] leading-5",
        due ? "text-ink-2 hover:bg-hover" : "bg-hover text-ink hover:bg-selected",
        closed && "text-ink-3 line-through",
        isDragging && "opacity-40",
        FOCUS,
      )}
    >
      {due ? (
        <Flag size={11} className="shrink-0 text-high" aria-label="Due" />
      ) : (
        <Dot color={color} />
      )}
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
    </button>
  );
}

/** Tasks shown on a day without a time: planned for it, then due on it (and not planned). */
export function dayTasks(tasks: Task[], iso: string, statuses: Status[]) {
  const planned: Task[] = [];
  const due: Task[] = [];
  for (const t of tasks) {
    if (t.today_on === iso) planned.push(t);
    else if (t.due_date === iso && !isClosed(t, statuses)) due.push(t);
  }
  const byRank = (a: Task, b: Task) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0);
  return { planned: planned.sort(byRank), due: due.sort(byRank) };
}
