// Day and week views: an all-day lane per day (tasks planned or due that day) above a
// 24-hour grid of time blocks. Blocks move by drag, resize from their bottom edge, and
// open a small menu on click (outcome, open the task, remove). Clicking or dragging on an
// empty spot creates a task there (NewBlock.tsx).

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Check, Clock, ExternalLink, Trash2, X } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, cx, FOCUS } from "../../components/ui";
import {
  allDayOn,
  atMinute,
  DAY_MIN,
  dropId,
  type EventSpan,
  formatDuration,
  formatHour,
  formatRange,
  formatTime,
  HOUR_PX,
  layoutDay,
  minuteAt,
  minuteOfDay,
  type Placed,
  parseIso,
  SNAP_MIN,
  segmentsOn,
  snapMinute,
  timedSpans,
} from "../../lib/calendar";
import type { BlockOutcome, CalendarEvent, Task, TimeBlock } from "../../lib/types";
import { deleteBlock, moveBlock, setBlockOutcome } from "../../store/actions";
import { useTaskStore } from "../../store/context";
import { EventChip, EventView } from "./events";
import { DraftBlock, useDrawBlock } from "./NewBlock";
import { blockStyle, DayChip, type DragData, dayTasks, projectColor, useCalendar } from "./shared";

/** Where a dragged item would land, drawn as a ghost in that day's column. */
export interface DropPreview {
  iso: string;
  startMin: number;
  endMin: number;
}

const GUTTER = "w-14 shrink-0";
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function TimeGrid({
  days,
  blocks,
  events = [],
  preview,
  onPickDay,
}: {
  days: string[];
  blocks: TimeBlock[];
  /** Read-only events of the user's calendars. */
  events?: CalendarEvent[];
  preview: DropPreview | null;
  onPickDay?(iso: string): void;
}) {
  const { tasks, statuses, today, now } = useCalendar();
  const scroller = useRef<HTMLDivElement>(null);
  const showsToday = days.includes(today);
  const allTasks = useMemo(() => Object.values(tasks), [tasks]);
  const spans = useMemo(() => timedSpans(events), [events]);

  // Open on the working day, or just before now when today is shown.
  const firstDay = days[0];
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll only when the range changes
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const minute = showsToday ? Math.max(minuteOfDay(now) - 90, 0) : 7 * 60;
    el.scrollTop = (minute / 60) * HOUR_PX;
  }, [firstDay, days.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day headers and all-day lanes share the grid's scrollbar gutter, so columns line up. */}
      <div className="flex border-b border-line [scrollbar-gutter:stable] overflow-y-hidden">
        <div className={GUTTER} />
        {days.map((iso) => {
          const date = parseIso(iso);
          const isToday = iso === today;
          return (
            <div key={iso} className="min-w-0 flex-1 border-l border-line px-2 py-1.5">
              <button
                type="button"
                disabled={!onPickDay}
                onClick={() => onPickDay?.(iso)}
                aria-label={date.toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
                className={cx(
                  "flex items-baseline gap-1.5 rounded-md px-1 text-left",
                  onPickDay && "hover:bg-hover",
                  FOCUS,
                )}
              >
                <span className="text-[12px] tracking-wide text-ink-3 uppercase">
                  {date.toLocaleDateString(undefined, { weekday: "short" })}
                </span>
                <span
                  className={cx(
                    "font-display text-[19px] leading-7",
                    isToday ? "rounded-full bg-accent px-1.5 text-accent-ink" : "text-ink",
                  )}
                >
                  {date.getDate()}
                </span>
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex border-b border-line [scrollbar-gutter:stable] overflow-y-hidden">
        <div className={cx(GUTTER, "pt-1.5 pr-2 text-right text-[11px] text-ink-3")}>All day</div>
        {days.map((iso) => (
          <DayLane key={iso} iso={iso} tasks={allTasks} statuses={statuses} events={events} />
        ))}
      </div>
      <div
        ref={scroller}
        data-testid="time-grid"
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      >
        <div className="relative flex" style={{ height: 24 * HOUR_PX }}>
          <div className={cx(GUTTER, "relative")}>
            {HOURS.slice(1).map((h) => (
              <span
                key={h}
                className="absolute right-2 -translate-y-1/2 text-[11px] whitespace-nowrap text-ink-3 tabular-nums"
                style={{ top: h * HOUR_PX }}
              >
                {formatHour(atMinute(today, h * 60))}
              </span>
            ))}
          </div>
          {days.map((iso) => (
            <TimeColumn
              key={iso}
              iso={iso}
              blocks={blocks}
              events={spans}
              preview={preview?.iso === iso ? preview : null}
              showNow={iso === today}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Tasks planned for (draggable) or due on a day; dropping a task here plans it. */
function DayLane({
  iso,
  tasks,
  statuses,
  events,
}: {
  iso: string;
  tasks: Task[];
  statuses: ReturnType<typeof useCalendar>["statuses"];
  events: CalendarEvent[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId.day(iso) });
  const { planned, due } = useMemo(() => dayTasks(tasks, iso, statuses), [tasks, iso, statuses]);
  const allDay = useMemo(() => allDayOn(events, iso), [events, iso]);
  return (
    <div
      ref={setNodeRef}
      data-testid={`day-lane-${iso}`}
      className={cx(
        "flex max-h-24 min-h-8 min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto border-l border-line p-1",
        isOver && "bg-accent/10",
      )}
    >
      {allDay.map((e) => (
        <EventChip key={`${e.calendar_id}:${e.id}`} event={e} />
      ))}
      {planned.map((t) => (
        <DayChip key={t.id} task={t} dragKey={`lane:${iso}:${t.id}`} />
      ))}
      {due.map((t) => (
        <DayChip key={t.id} task={t} due />
      ))}
    </div>
  );
}

function TimeColumn({
  iso,
  blocks,
  events,
  preview,
  showNow,
}: {
  iso: string;
  blocks: TimeBlock[];
  events: EventSpan[];
  preview: DropPreview | null;
  showNow: boolean;
}) {
  const { now } = useCalendar();
  const { setNodeRef } = useDroppable({ id: dropId.time(iso) });
  const { draft, setDraft, onPointerDown } = useDrawBlock();
  // Blocks and events share the day's width where they overlap.
  const placed = useMemo(
    () => layoutDay(segmentsOn<TimeBlock | EventSpan>([...blocks, ...events], iso)),
    [blocks, events, iso],
  );
  return (
    <div
      ref={setNodeRef}
      data-time-column={iso}
      data-testid={`time-column-${iso}`}
      onPointerDown={onPointerDown}
      className="relative min-w-0 flex-1 cursor-cell border-l border-line"
      style={{
        backgroundImage: `repeating-linear-gradient(to bottom, var(--tm-line) 0 1px, transparent 1px ${HOUR_PX}px)`,
      }}
    >
      {placed.map((p) =>
        "event" in p.item ? (
          <EventView key={p.item.id} placed={p as Placed<EventSpan>} />
        ) : (
          <BlockView key={p.item.id} iso={iso} placed={p as Placed<TimeBlock>} />
        ),
      )}
      {draft && <DraftBlock iso={iso} draft={draft} onClose={() => setDraft(null)} />}
      {preview && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-1 rounded-md border-2 border-dashed border-accent bg-accent/10 px-1.5 text-[11px] text-accent"
          style={{
            top: (preview.startMin / 60) * HOUR_PX,
            height: Math.max(((preview.endMin - preview.startMin) / 60) * HOUR_PX, 14),
          }}
        >
          {formatTime(atMinute(iso, preview.startMin))}
        </div>
      )}
      {showNow && (
        <div
          aria-hidden
          data-testid="now-line"
          className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-danger"
          style={{ top: (minuteOfDay(now) / 60) * HOUR_PX }}
        >
          <span className="absolute -top-[3px] -left-1 size-2 rounded-full bg-danger" />
        </div>
      )}
    </div>
  );
}

const OUTCOMES: Array<{ value: BlockOutcome; label: string }> = [
  { value: "planned", label: "Planned" },
  { value: "done", label: "Done" },
  { value: "worked", label: "Worked" },
  { value: "cancelled", label: "Cancelled" },
];

function BlockView({ iso, placed }: { iso: string; placed: Placed<TimeBlock> }) {
  const store = useTaskStore();
  const { tasks, projects, openTask, justDragged } = useCalendar();
  const block = placed.item;
  const task = tasks[block.task_id];
  const color = projectColor(task, projects);
  const [open, setOpen] = useState(false);
  const [resizeEnd, setResizeEnd] = useState<number | null>(null);
  const data: DragData = { ref: `block:${block.id}`, label: task?.title ?? "", color };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `block:${block.id}`,
    data,
  });

  const endMin = resizeEnd ?? placed.endMin;
  const top = (placed.startMin / 60) * HOUR_PX;
  const height = Math.max(((endMin - placed.startMin) / 60) * HOUR_PX - 2, 16);
  const minutes = Math.round((block.end_at - block.start_at) / 60_000);
  const title = task?.title ?? "Deleted task";
  const label = `${title}, ${formatRange(block.start_at, block.end_at)}`;

  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const column = (e.currentTarget as HTMLElement).closest("[data-time-column]");
    const columnTop = column?.getBoundingClientRect().top ?? 0;
    let latest = placed.endMin;
    const move = (ev: PointerEvent) => {
      const minute = snapMinute(minuteAt(ev.clientY, columnTop));
      latest = Math.min(Math.max(minute, placed.startMin + SNAP_MIN), DAY_MIN);
      setResizeEnd(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResizeEnd(null);
      if (latest !== placed.endMin) {
        void moveBlock(store, block.id, block.start_at, atMinute(iso, latest));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <button
          type="button"
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          aria-label={label}
          data-testid="time-block"
          onClick={() => !justDragged() && setOpen(true)}
          onKeyDown={(e) => {
            listeners?.onKeyDown?.(e);
            if (e.key === "Enter") setOpen(true);
            if (e.key === "Delete" || e.key === "Backspace") void deleteBlock(store, block.id);
          }}
          className={cx(
            "absolute flex flex-col items-stretch overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-left text-[12px] leading-4 text-ink shadow-sm",
            "cursor-grab select-none hover:brightness-110",
            block.outcome === "cancelled" && "text-ink-3 line-through",
            block.outcome === "done" && "text-ink-2",
            isDragging && "opacity-40",
            FOCUS,
          )}
          style={{
            top,
            height,
            left: `calc(${(placed.column / placed.columns) * 100}% + 2px)`,
            width: `calc(${100 / placed.columns}% - 4px)`,
            ...blockStyle(color, block.outcome),
          }}
        >
          <span className="flex items-start gap-1">
            {block.outcome === "done" && <Check size={12} className="mt-0.5 shrink-0" />}
            {block.outcome === "worked" && <Clock size={12} className="mt-0.5 shrink-0" />}
            <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
          </span>
          {height >= 34 && (
            <span className="truncate text-[11px] text-ink-2 tabular-nums">
              {resizeEnd !== null
                ? `${formatTime(block.start_at)} – ${formatTime(atMinute(iso, resizeEnd))}`
                : formatRange(block.start_at, block.end_at)}
            </span>
          )}
          {!placed.continuesAfter && (
            <span
              aria-hidden
              data-testid="resize-handle"
              onPointerDown={startResize}
              className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
            />
          )}
        </button>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label="Time block"
          className="z-40 flex w-64 flex-col gap-2.5 rounded-xl border border-line-strong bg-overlay p-3 text-sm shadow-xl"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium break-words text-ink">{title}</div>
              <div className="text-[12.5px] text-ink-2 tabular-nums">
                {formatRange(block.start_at, block.end_at)} · {formatDuration(minutes)}
              </div>
            </div>
            <Popover.Close
              aria-label="Close"
              className={cx("rounded-md p-0.5 text-ink-3 hover:bg-hover", FOCUS)}
            >
              <X size={14} />
            </Popover.Close>
          </div>
          <fieldset aria-label="Outcome" className="grid grid-cols-2 gap-1">
            {OUTCOMES.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={block.outcome === o.value}
                onClick={() => void setBlockOutcome(store, block.id, o.value)}
                className={cx(
                  "rounded-md px-2 py-1 text-[12.5px] transition-colors",
                  block.outcome === o.value
                    ? "bg-selected text-ink shadow-sm"
                    : "text-ink-2 hover:bg-hover",
                  FOCUS,
                )}
              >
                {o.label}
              </button>
            ))}
          </fieldset>
          <div className="flex gap-2">
            {task && (
              <Button
                size="sm"
                onClick={() => {
                  setOpen(false);
                  openTask(task.id);
                }}
              >
                <ExternalLink size={13} />
                Open task
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                void deleteBlock(store, block.id);
              }}
            >
              <Trash2 size={13} />
              Remove
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A clock that ticks every minute, for the now line. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
