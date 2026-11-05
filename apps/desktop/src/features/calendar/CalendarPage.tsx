// The calendar (M9, ADR 013): day, week and month views of time blocks and day plans,
// with a tray of tasks to drag onto it. Drops are resolved by `resolveDrop`
// (lib/calendar.ts); this file only measures where the pointer is.

import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Button, cx, Dot, FOCUS, IconButton } from "../../components/ui";
import {
  atMinute,
  blockMinutes,
  type CalendarMode,
  DAY_MIN,
  type DropAction,
  formatTime,
  minuteAt,
  nextSlot,
  periodLabel,
  resolveDrop,
  SNAP_MIN,
  shiftPeriod,
  snapMinute,
  visibleDays,
} from "../../lib/calendar";
import { isoDate } from "../../lib/dates";
import type { Task } from "../../lib/types";
import { moveBlock, scheduleTask, updateTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { useOpenTask } from "../shell/useOpenTask";
import { MonthGrid } from "./MonthGrid";
import { CalendarContext, type CalendarData, type DragData } from "./shared";
import { TaskTray } from "./TaskTray";
import { type DropPreview, TimeGrid, useNow } from "./TimeGrid";

const MODE_KEY = "task-master.calendar-mode";
const MODES: CalendarMode[] = ["day", "week", "month"];

function loadMode(): CalendarMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return MODES.includes(saved as CalendarMode) ? (saved as CalendarMode) : "week";
  } catch {
    return "week";
  }
}

function saveMode(mode: CalendarMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Not remembered; fine.
  }
}

/** Time columns first: a pointer over a day's grid means a time, not the whole day. */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

function columnTop(iso: string): number | null {
  const el = document.querySelector(`[data-time-column="${iso}"]`);
  return el ? el.getBoundingClientRect().top : null;
}

export function CalendarPage() {
  const store = useTaskStore();
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const statuses = useStoreState((s) => s.statuses);
  const timeBlocks = useStoreState((s) => s.time_blocks);
  const openTaskPanel = useOpenTask();
  const now = useNow();
  const today = isoDate(new Date(now));
  const [mode, setModeState] = useState<CalendarMode>(loadMode);
  const [date, setDate] = useState(() => isoDate());
  const [dragging, setDragging] = useState<DragData | null>(null);
  const [preview, setPreview] = useState<DropPreview | null>(null);
  const grabMinute = useRef(0);
  // The pointer's latest position during a drag. dnd-kit's delta also counts scrolling of
  // the containers involved, so the real pointer is tracked instead.
  const pointer = useRef<number | null>(null);
  const stopTracking = useRef<() => void>(() => {});
  const lastDragEnd = useRef(0);

  const setMode = (next: CalendarMode) => {
    setModeState(next);
    saveMode(next);
  };
  const pickDay = useCallback((iso: string) => {
    setDate(iso);
    setModeState("day");
    saveMode("day");
  }, []);

  const blocks = useMemo(() => Object.values(timeBlocks), [timeBlocks]);
  const data: CalendarData = useMemo(
    () => ({
      tasks,
      projects,
      statuses,
      today,
      now,
      openTask: (id) => openTaskPanel(id),
      justDragged: () => Date.now() - lastDragEnd.current < 250,
    }),
    [tasks, projects, statuses, today, now, openTaskPanel],
  );

  const sensors = useSensors(
    // A short travel before a drag starts keeps clicks (open a task or block) working.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  /** The drop for the current pointer position, plus the preview to draw for it. */
  const measure = (event: DragMoveEvent | DragEndEvent) => {
    const ref = (event.active.data.current as DragData | undefined)?.ref ?? "";
    const over = event.over ? String(event.over.id) : null;
    let pointerMinute: number | undefined;
    if (over?.startsWith("time:")) {
      const iso = over.slice(5);
      const top = columnTop(iso);
      const y = pointer.current;
      if (top !== null && y !== null) pointerMinute = minuteAt(y, top);
    }
    const action = resolveDrop(
      { active: ref, over, pointerMinute, grabMinute: grabMinute.current },
      { tasks: store.getState().tasks, time_blocks: store.getState().time_blocks },
    );
    let next: DropPreview | null = null;
    if (over?.startsWith("time:") && pointerMinute !== undefined) {
      const iso = over.slice(5);
      const [kind, id] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
      const s = store.getState();
      const length =
        kind === "task"
          ? s.tasks[id]
            ? blockMinutes(s.tasks[id])
            : 60
          : ((s.time_blocks[id]?.end_at ?? 0) - (s.time_blocks[id]?.start_at ?? 0)) / 60_000;
      const startMin = Math.min(
        Math.max(snapMinute(pointerMinute - grabMinute.current), 0),
        DAY_MIN - SNAP_MIN,
      );
      next = { iso, startMin, endMin: Math.min(startMin + length, DAY_MIN) };
    }
    return { action, preview: next };
  };

  const onDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const drag = active.data.current as DragData | undefined;
    setDragging(drag ?? null);
    grabMinute.current = 0;
    pointer.current = "clientY" in activatorEvent ? (activatorEvent as PointerEvent).clientY : null;
    const track = (e: PointerEvent) => {
      pointer.current = e.clientY;
    };
    window.addEventListener("pointermove", track, true);
    stopTracking.current = () => window.removeEventListener("pointermove", track, true);
    // A block keeps the point it was grabbed at under the pointer.
    const initial = active.rect.current.initial;
    if (drag?.ref.startsWith("block:") && initial && "clientY" in activatorEvent) {
      const offset = minuteAt((activatorEvent as PointerEvent).clientY, initial.top);
      const block = store.getState().time_blocks[drag.ref.slice(6)];
      // Grabbed from a month cell (a one-line chip): no offset.
      grabMinute.current = block && initial.height > 24 ? Math.max(offset, 0) : 0;
    }
  };

  const onDragMove = (event: DragMoveEvent) => {
    const { preview: next } = measure(event);
    setPreview((prev) =>
      prev?.iso === next?.iso && prev?.startMin === next?.startMin && prev?.endMin === next?.endMin
        ? prev
        : next,
    );
  };

  const finish = () => {
    stopTracking.current();
    pointer.current = null;
    setDragging(null);
    setPreview(null);
    lastDragEnd.current = Date.now();
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { action } = measure(event);
    finish();
    if (action) void apply(action);
  };

  const apply = (action: DropAction) => {
    switch (action.kind) {
      case "schedule":
        return scheduleTask(store, action.taskId, action.start_at, action.end_at);
      case "move":
        return moveBlock(store, action.blockId, action.start_at, action.end_at);
      case "plan":
        return updateTask(store, action.taskId, [{ today_on: action.date }]);
    }
  };

  /**
   * The tray's button: the next quarter hour from now when today is shown (or in the month
   * view), else 09:00 on the shown day (the first day of a shown week).
   */
  const schedule = (task: Task) => {
    const shownDays = mode === "month" ? [today] : visibleDays(mode, date);
    const day = shownDays.includes(today) ? today : (shownDays[0] ?? today);
    const start = nextSlot(day, Date.now());
    void scheduleTask(store, task.id, start, start + blockMinutes(task) * 60_000);
  };

  const days = mode === "month" ? [] : visibleDays(mode, date);
  const shown = mode === "month" ? date.slice(0, 7) === today.slice(0, 7) : days.includes(today);

  return (
    <CalendarContext.Provider value={data}>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex flex-wrap items-end gap-x-4 gap-y-3 px-10 pt-7 pb-4">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-3 font-display text-[34px] leading-tight font-normal tracking-wide">
              <CalendarDays size={28} className="text-rubric" aria-hidden />
              Calendar
            </h1>
            <div className="mt-1 text-[13.5px] text-ink-2" aria-live="polite">
              {periodLabel(mode, date)}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={shown && mode !== "day"} onClick={() => setDate(today)}>
              Today
            </Button>
            <div className="flex">
              <IconButton
                label={`Previous ${mode}`}
                onClick={() => setDate((d) => shiftPeriod(mode, d, -1))}
              >
                <ChevronLeft size={16} />
              </IconButton>
              <IconButton
                label={`Next ${mode}`}
                onClick={() => setDate((d) => shiftPeriod(mode, d, 1))}
              >
                <ChevronRight size={16} />
              </IconButton>
            </div>
            <fieldset
              aria-label="Calendar range"
              className="flex rounded-[9px] bg-hover p-0.5 text-[13px]"
            >
              {MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                  className={cx(
                    "rounded-[7px] px-3 py-1 capitalize transition-colors",
                    FOCUS,
                    mode === m ? "bg-selected text-ink shadow-sm" : "text-ink-2 hover:text-ink",
                  )}
                >
                  {m}
                </button>
              ))}
            </fieldset>
          </div>
        </header>
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={finish}
        >
          <div className="flex min-h-0 flex-1 border-t border-line">
            <TaskTray onSchedule={schedule} />
            {mode === "month" ? (
              <MonthGrid date={date} blocks={blocks} onPickDay={pickDay} />
            ) : (
              <TimeGrid
                days={days}
                blocks={blocks}
                preview={preview}
                onPickDay={mode === "week" ? pickDay : undefined}
              />
            )}
          </div>
          <DragOverlay dropAnimation={null}>
            {dragging && (
              <div className="flex max-w-56 items-center gap-1.5 rounded-md border border-line-strong bg-overlay px-2 py-1 text-[13px] shadow-lg">
                <Dot color={dragging.color} />
                <span className="truncate">{dragging.label}</span>
                {preview && (
                  <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">
                    {formatTime(atMinute(preview.iso, preview.startMin))}
                  </span>
                )}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
    </CalendarContext.Provider>
  );
}
