// Month view: one cell per day with its blocks (by start time) and the tasks planned for
// or due on it. Dropping a task on a day plans it for that day; dropping a block moves it
// there at the same time of day.

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useMemo } from "react";
import { cx, FOCUS } from "../../components/ui";
import {
  allDayOn,
  dropId,
  type EventSpan,
  formatTime,
  monthWeeks,
  parseIso,
  segmentsOn,
  timedSpans,
} from "../../lib/calendar";
import type { CalendarEvent, Task, TimeBlock } from "../../lib/types";
import { EventChip } from "./events";
import { blockStyle, DayChip, type DragData, dayTasks, projectColor, useCalendar } from "./shared";

/** Items shown in a cell before "+N more". */
const VISIBLE = 4;

export function MonthGrid({
  date,
  blocks,
  events = [],
  onPickDay,
}: {
  date: string;
  blocks: TimeBlock[];
  /** Read-only events of the user's calendars. */
  events?: CalendarEvent[];
  onPickDay(iso: string): void;
}) {
  const { tasks } = useCalendar();
  const spans = useMemo(() => timedSpans(events), [events]);
  const weeks = useMemo(() => monthWeeks(date), [date]);
  const allTasks = useMemo(() => Object.values(tasks), [tasks]);
  const weekdays = (weeks[0] ?? []).map((iso) =>
    parseIso(iso).toLocaleDateString(undefined, { weekday: "short" }),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b border-line">
        {weekdays.map((name) => (
          <div key={name} className="px-2 py-1.5 text-[12px] tracking-wide text-ink-3 uppercase">
            {name}
          </div>
        ))}
      </div>
      <div
        className="grid min-h-0 flex-1 grid-cols-7"
        style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
      >
        {weeks.flat().map((iso) => (
          <MonthCell
            key={iso}
            iso={iso}
            inMonth={iso.slice(0, 7) === date.slice(0, 7)}
            tasks={allTasks}
            blocks={blocks}
            events={events}
            spans={spans}
            onPickDay={onPickDay}
          />
        ))}
      </div>
    </div>
  );
}

function MonthCell({
  iso,
  inMonth,
  tasks,
  blocks,
  events,
  spans,
  onPickDay,
}: {
  iso: string;
  inMonth: boolean;
  tasks: Task[];
  blocks: TimeBlock[];
  events: CalendarEvent[];
  spans: EventSpan[];
  onPickDay(iso: string): void;
}) {
  const { statuses, today } = useCalendar();
  const { setNodeRef, isOver } = useDroppable({ id: dropId.day(iso) });
  // Blocks and timed events by start time; an item spanning midnight shows on its first day.
  const timed = useMemo(
    () =>
      segmentsOn<TimeBlock | EventSpan>([...blocks, ...spans], iso).filter(
        (s) => !s.continuesBefore,
      ),
    [blocks, spans, iso],
  );
  const allDay = useMemo(() => allDayOn(events, iso), [events, iso]);
  const { planned, due } = useMemo(() => dayTasks(tasks, iso, statuses), [tasks, iso, statuses]);
  const items = [
    ...allDay.map((e) => <EventChip key={`${e.calendar_id}:${e.id}`} event={e} />),
    ...timed.map((s) =>
      "event" in s.item ? (
        <EventChip key={s.item.id} event={s.item.event} />
      ) : (
        <MonthBlock key={s.item.id} block={s.item} />
      ),
    ),
    ...planned.map((t) => <DayChip key={t.id} task={t} dragKey={`month:${iso}:${t.id}`} />),
    ...due.map((t) => <DayChip key={t.id} task={t} due />),
  ];
  const hidden = items.length - VISIBLE;
  const date = parseIso(iso);
  return (
    <div
      ref={setNodeRef}
      data-testid={`month-cell-${iso}`}
      className={cx(
        "flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-r border-b border-line p-1",
        !inMonth && "bg-hover/40",
        isOver && "bg-accent/10",
      )}
    >
      <button
        type="button"
        onClick={() => onPickDay(iso)}
        aria-label={`Open ${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`}
        className={cx(
          "self-start rounded-full px-1.5 text-[13px] leading-6 tabular-nums hover:bg-hover",
          iso === today
            ? "bg-accent text-accent-ink hover:bg-accent-hover"
            : inMonth
              ? "text-ink"
              : "text-ink-3",
          FOCUS,
        )}
      >
        {date.getDate()}
      </button>
      {items.slice(0, hidden > 0 ? VISIBLE - 1 : VISIBLE)}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => onPickDay(iso)}
          className={cx("rounded-md px-1.5 text-left text-[12px] text-ink-3 hover:bg-hover", FOCUS)}
        >
          +{hidden + 1} more
        </button>
      )}
    </div>
  );
}

function MonthBlock({ block }: { block: TimeBlock }) {
  const { tasks, projects, openTask, justDragged } = useCalendar();
  const task = tasks[block.task_id];
  const color = projectColor(task, projects);
  const title = task?.title ?? "Deleted task";
  const data: DragData = { ref: `block:${block.id}`, label: title, color };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `month-block:${block.id}`,
    data,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onClick={() => !justDragged() && task && openTask(task.id)}
      className={cx(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md border-l-[3px] px-1.5 text-left text-[12px] leading-5",
        block.outcome === "cancelled" && "text-ink-3 line-through",
        isDragging && "opacity-40",
        FOCUS,
      )}
      style={blockStyle(color, block.outcome)}
    >
      <span className="shrink-0 text-ink-2 tabular-nums">{formatTime(block.start_at)}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </button>
  );
}
