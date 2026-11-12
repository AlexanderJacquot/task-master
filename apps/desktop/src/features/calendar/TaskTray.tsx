import { CalendarPlusIcon as CalendarPlus } from "../../components/TaskIcons";
// The calendar's side list: today's tasks, then other open tasks (searchable), to drag
// onto the calendar or schedule with a button. A filter (project, epic, status) narrows
// both lists; it is also Plan mode's focus. The tray's width can be dragged.

import { useDraggable } from "@dnd-kit/core";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useMemo, useState } from "react";
import { cx, Dot, FOCUS, IconButton, INPUT, SectionLabel } from "../../components/ui";
import { addDays, atMinute, blockMinutes, formatDuration, holdsTime } from "../../lib/calendar";
import { DEFAULT_FOCUS, type PlanFocus } from "../../lib/planner";
import type { Epic, Project, Status, Task } from "../../lib/types";
import { compareTasks, inView, isOpen, type ViewContext } from "../../lib/views";
import { useStoreState } from "../../store/context";
import { FocusFilter } from "./PlanBar";
import { type DragData, projectColor, useCalendar } from "./shared";

/** Rows shown in "Other tasks"; typing narrows them. Keeps the list short (no virtualizer). */
const MAX_OTHERS = 50;

const WIDTH_KEY = "task-master.calendar-tray-width";
export const TRAY_DEFAULT = 256;
export const TRAY_MIN = 200;
export const TRAY_MAX = 640;

function loadWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return saved >= TRAY_MIN && saved <= TRAY_MAX ? saved : TRAY_DEFAULT;
  } catch {
    return TRAY_DEFAULT;
  }
}

function saveWidth(px: number | null) {
  try {
    if (px === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(px));
  } catch {
    // Not remembered; fine.
  }
}

export function TaskTray({
  onSchedule,
  filter,
  planning = false,
  focus = DEFAULT_FOCUS,
  onFocus,
  projects: projectList = [],
  epics = [],
  statuses: statusList = [],
}: {
  onSchedule(task: Task): void;
  /** The filter (the plan's focus): only these tasks are listed. */
  filter?: (task: Task) => boolean;
  /** Plan mode is on: the plan draws from the listed tasks. */
  planning?: boolean;
  focus?: PlanFocus;
  /** Without it, the filter's selects are not shown. */
  onFocus?(focus: PlanFocus): void;
  projects?: Project[];
  epics?: Epic[];
  statuses?: Status[];
}) {
  const { tasks, projects, statuses, today } = useCalendar();
  const timeBlocks = useStoreState((s) => s.time_blocks);
  const [query, setQuery] = useState("");
  const [width, setWidth] = useState(loadWidth);
  const active = [focus.projectId, focus.epicId, focus.statusId].filter((v) => v !== null).length;
  const [showFilter, setShowFilter] = useState(active > 0);
  const ctx: ViewContext = useMemo(
    () => ({
      today,
      statuses: Object.fromEntries(statuses.map((s) => [s.id, s])),
      projects,
      epics: {},
    }),
    [today, statuses, projects],
  );
  const { todayTasks, others, more } = useMemo(() => {
    const start = atMinute(today, 0);
    const end = atMinute(addDays(today, 1), 0);
    const scheduled = new Set<string>();
    const scheduledToday = new Set<string>();
    for (const block of Object.values(timeBlocks)) {
      if (!holdsTime(block) || block.end_at <= start) continue;
      scheduled.add(block.task_id);
      if (block.start_at < end) scheduledToday.add(block.task_id);
    }
    const open = Object.values(tasks).filter((t) => isOpen(t, ctx) && (!filter || filter(t)));
    const todayTasks = open
      .filter((t) => scheduledToday.has(t.id) || inView({ kind: "today" }, t, ctx))
      .sort((a, b) => compareTasks(a, b, ctx));
    const inToday = new Set(todayTasks.map((t) => t.id));
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = open
      .filter(
        (t) => !inToday.has(t.id) && !scheduled.has(t.id) && !(t.today_on && t.today_on > today),
      )
      .filter((t) => words.every((w) => t.title.toLowerCase().includes(w)))
      .sort((a, b) => compareTasks(a, b, ctx));
    return {
      todayTasks,
      others: matching.slice(0, MAX_OTHERS),
      more: Math.max(matching.length - MAX_OTHERS, 0),
    };
  }, [tasks, timeBlocks, today, ctx, query, filter]);

  const onResizeStart = (e: ReactPointerEvent<HTMLHRElement>) => {
    e.preventDefault();
    const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    let last: number | null = null;
    const move = (ev: PointerEvent) => {
      last = Math.round(Math.min(TRAY_MAX, Math.max(TRAY_MIN, ev.clientX - left)));
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      if (last !== null) saveWidth(last);
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside
      aria-label="Tasks to schedule"
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-line"
    >
      <div className="px-4 pt-1 pb-2 text-[12.5px] text-ink-3">
        {planning
          ? "Suggest fills the free time with the tasks listed here. Filter them to focus the plan."
          : "Drag a task onto the calendar, or onto a day to plan it."}
      </div>
      {onFocus && (
        <div className="px-2 pb-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-expanded={showFilter}
              onClick={() => setShowFilter((s) => !s)}
              className={cx(
                "flex flex-1 items-center gap-1 rounded-md px-2 py-0.5 text-left text-[12.5px] text-ink-2 hover:bg-hover",
                FOCUS,
              )}
            >
              {showFilter ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              Filter
              {active > 0 && <span className="text-accent"> · {active}</span>}
            </button>
            {active > 0 && (
              <button
                type="button"
                onClick={() => onFocus(DEFAULT_FOCUS)}
                className={cx(
                  "rounded-md px-2 py-0.5 text-[12px] text-ink-3 hover:bg-hover hover:text-ink",
                  FOCUS,
                )}
              >
                Clear filter
              </button>
            )}
          </div>
          {showFilter && (
            <div className="px-1 pt-1.5">
              <FocusFilter
                focus={focus}
                onFocus={onFocus}
                projects={projectList}
                epics={epics}
                statuses={statusList}
              />
            </div>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <SectionLabel className="block px-2 pb-1">Today</SectionLabel>
        {todayTasks.length === 0 ? (
          <p className="px-2 pb-2 text-[12.5px] text-ink-3">Nothing planned for today.</p>
        ) : (
          <ul aria-label="Today's tasks" className="mb-3">
            {todayTasks.map((t) => (
              <TrayTask key={t.id} task={t} onSchedule={onSchedule} />
            ))}
          </ul>
        )}
        <SectionLabel className="block px-2 pb-1">Other tasks</SectionLabel>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a task…"
          aria-label="Find a task"
          className={cx(INPUT, "mb-1.5 py-1 text-[13px]")}
        />
        <ul aria-label="Other tasks">
          {others.map((t) => (
            <TrayTask key={t.id} task={t} onSchedule={onSchedule} />
          ))}
        </ul>
        {others.length === 0 && (
          <p className="px-2 text-[12.5px] text-ink-3">
            {query || filter ? "No open task matches." : "No other open tasks."}
          </p>
        )}
        {more > 0 && (
          <p className="px-2 pt-1 text-[12px] text-ink-3">{more} more. Type to narrow the list.</p>
        )}
      </div>
      <hr
        aria-orientation="vertical"
        aria-label="Resize task list"
        title="Drag to resize; double-click to reset"
        onPointerDown={onResizeStart}
        onDoubleClick={() => {
          setWidth(TRAY_DEFAULT);
          saveWidth(null);
        }}
        className="absolute inset-y-0 -right-[3px] z-20 m-0 h-full w-1.5 cursor-col-resize border-0 hover:bg-accent/30"
      />
    </aside>
  );
}

function TrayTask({ task, onSchedule }: { task: Task; onSchedule(task: Task): void }) {
  const { projects, openTask, justDragged } = useCalendar();
  const color = projectColor(task, projects);
  const data: DragData = { ref: `task:${task.id}`, label: task.title, color };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tray:${task.id}`,
    data,
  });
  return (
    <li
      className={cx(
        "group flex items-center gap-1 rounded-lg pr-1 hover:bg-hover",
        isDragging && "opacity-40",
      )}
    >
      <button
        type="button"
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        title="Drag onto the calendar, or click to open"
        onClick={() => !justDragged() && openTask(task.id)}
        className={cx(
          "flex min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded-md py-1 pl-1 text-left text-[13.5px]",
          FOCUS,
        )}
      >
        <GripVertical size={13} className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100" />
        <Dot color={color} />
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        {task.estimate_min ? (
          <span className="shrink-0 text-[11.5px] text-ink-3">
            {formatDuration(blockMinutes(task))}
          </span>
        ) : null}
      </button>
      <IconButton
        label={`Schedule ${task.title}`}
        onClick={() => onSchedule(task)}
        className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <CalendarPlus size={14} />
      </IconButton>
    </li>
  );
}
