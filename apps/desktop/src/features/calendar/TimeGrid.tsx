// Day and week views: an all-day lane per day (tasks planned or due that day) above a
// 24-hour grid of time blocks. Blocks move by drag, resize from their top or bottom edge
// (or Shift+↑/↓ for the end), and open a small menu on click (outcome and replanning, open the task, remove). Clicking or dragging on an
// empty spot creates a task there (NewBlock.tsx).

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Popover } from "radix-ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon as Check,
  EstimateIcon as Clock,
  ExternalIcon as ExternalLink,
  DeleteIcon as Trash2,
  CloseIcon as X,
} from "../../components/TaskIcons";
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
import type { ProposedBlock } from "../../lib/planner";
import type { CalendarEvent, Task, TimeBlock } from "../../lib/types";
import { deleteBlock, moveBlock } from "../../store/actions";
import { useTaskStore } from "../../store/context";
import { BlockOutcomes } from "./BlockOutcome";
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
  proposals = [],
  onDropProposal,
}: {
  days: string[];
  blocks: TimeBlock[];
  /** Read-only events of the user's calendars. */
  events?: CalendarEvent[];
  preview: DropPreview | null;
  onPickDay?(iso: string): void;
  /** The planner's suggested blocks, not yet approved. */
  proposals?: ProposedBlock[];
  onDropProposal?(id: string): void;
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

  // A new plan: bring its first suggestion into view.
  const firstProposal = proposals.reduce<ProposedBlock | null>(
    (min, p) => (min === null || p.start_at < min.start_at ? p : min),
    null,
  );
  const firstProposalId = firstProposal?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when the plan changes
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !firstProposal) return;
    const minute = Math.max(minuteOfDay(firstProposal.start_at) - 30, 0);
    el.scrollTop = (minute / 60) * HOUR_PX;
  }, [firstProposalId]);

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
                <span className="text-[14px] tracking-wide text-rubric uppercase">
                  {date.toLocaleDateString(undefined, { weekday: "short" })}
                </span>
                <span
                  className={cx(
                    "font-display text-[22px] leading-8",
                    isToday
                      ? "inline-flex size-8 items-center justify-center rounded-full bg-accent text-accent-ink"
                      : "text-rubric",
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
              proposals={proposals}
              onDropProposal={onDropProposal}
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
  proposals,
  onDropProposal,
  preview,
  showNow,
}: {
  iso: string;
  blocks: TimeBlock[];
  events: EventSpan[];
  proposals: ProposedBlock[];
  onDropProposal?(id: string): void;
  preview: DropPreview | null;
  showNow: boolean;
}) {
  const { now } = useCalendar();
  const { setNodeRef } = useDroppable({ id: dropId.time(iso) });
  const { draft, setDraft, onPointerDown } = useDrawBlock();
  // Blocks, events and proposals share the day's width where they overlap.
  const placed = useMemo(
    () =>
      layoutDay(
        segmentsOn<TimeBlock | EventSpan | ProposedBlock>(
          [...blocks, ...events, ...proposals],
          iso,
        ),
      ),
    [blocks, events, proposals, iso],
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
        ) : "outcome" in p.item ? (
          <BlockView key={p.item.id} iso={iso} placed={p as Placed<TimeBlock>} />
        ) : (
          <ProposalView
            key={p.item.id}
            placed={p as Placed<ProposedBlock>}
            onDrop={onDropProposal}
          />
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

function BlockView({ iso, placed }: { iso: string; placed: Placed<TimeBlock> }) {
  const store = useTaskStore();
  const { tasks, projects, openTask, justDragged } = useCalendar();
  const block = placed.item;
  const task = tasks[block.task_id];
  const color = projectColor(task, projects);
  const [open, setOpen] = useState(false);
  // The edge being dragged and where it is, until the pointer is released.
  const [resize, setResize] = useState<{ edge: "start" | "end"; minute: number } | null>(null);
  // The click that ends a resize must not open the menu.
  const resizedAt = useRef(0);
  const data: DragData = { ref: `block:${block.id}`, label: task?.title ?? "", color };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `block:${block.id}`,
    data,
  });

  const startMin = resize?.edge === "start" ? resize.minute : placed.startMin;
  const endMin = resize?.edge === "end" ? resize.minute : placed.endMin;
  const top = (startMin / 60) * HOUR_PX;
  const height = Math.max(((endMin - startMin) / 60) * HOUR_PX - 2, 16);
  const minutes = Math.round((block.end_at - block.start_at) / 60_000);
  const title = task?.title ?? "Deleted task";
  const label = `${title}, ${formatRange(block.start_at, block.end_at)}`;
  const shownStart = resize?.edge === "start" ? atMinute(iso, resize.minute) : block.start_at;
  const shownEnd = resize?.edge === "end" ? atMinute(iso, resize.minute) : block.end_at;

  const startResize = (edge: "start" | "end") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const column = (e.currentTarget as HTMLElement).closest("[data-time-column]");
    const columnTop = column?.getBoundingClientRect().top ?? 0;
    const initial = edge === "start" ? placed.startMin : placed.endMin;
    let latest = initial;
    const move = (ev: PointerEvent) => {
      const minute = snapMinute(minuteAt(ev.clientY, columnTop));
      latest =
        edge === "start"
          ? Math.max(Math.min(minute, placed.endMin - SNAP_MIN), 0)
          : Math.min(Math.max(minute, placed.startMin + SNAP_MIN), DAY_MIN);
      setResize({ edge, minute: latest });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResize(null);
      resizedAt.current = Date.now();
      if (latest === initial) return;
      if (edge === "start") void moveBlock(store, block.id, atMinute(iso, latest), block.end_at);
      else void moveBlock(store, block.id, block.start_at, atMinute(iso, latest));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Shift+↑/↓ shortens or lengthens the block by a quarter hour. */
  const resizeByKey = (e: React.KeyboardEvent) => {
    if (!e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return false;
    e.preventDefault();
    const step = (e.key === "ArrowDown" ? SNAP_MIN : -SNAP_MIN) * 60_000;
    const end = block.end_at + step;
    if (end - block.start_at >= SNAP_MIN * 60_000) {
      void moveBlock(store, block.id, block.start_at, end);
    }
    return true;
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
          onClick={() => {
            if (justDragged() || Date.now() - resizedAt.current < 250) return;
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (resizeByKey(e)) return;
            listeners?.onKeyDown?.(e);
            if (e.key === "Enter") setOpen(true);
            if (e.key === "Delete" || e.key === "Backspace") void deleteBlock(store, block.id);
          }}
          className={cx(
            "absolute flex flex-col items-stretch overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-left text-[12px] leading-4 text-ink shadow-sm",
            "group cursor-grab select-none hover:brightness-110",
            resize && "z-20 shadow-md",
            block.outcome === "cancelled" && "text-ink-3 line-through",
            block.outcome === "missed" && "text-ink-3",
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
              {resize
                ? `${formatTime(shownStart)} – ${formatTime(shownEnd)} · ${formatDuration(
                    Math.round((shownEnd - shownStart) / 60_000),
                  )}`
                : formatRange(block.start_at, block.end_at)}
            </span>
          )}
          {/* Short blocks keep their middle free to move them: only the bottom edge resizes. */}
          {!placed.continuesBefore && height >= 28 && (
            <ResizeHandle
              edge="start"
              active={resize?.edge === "start"}
              onPointerDown={startResize("start")}
            />
          )}
          {!placed.continuesAfter && (
            <ResizeHandle
              edge="end"
              active={resize?.edge === "end"}
              onPointerDown={startResize("end")}
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
          <BlockOutcomes
            block={block}
            withPlanned
            onChosen={(outcome) => {
              // After the replan step the menu has done its job.
              if (outcome === "worked" || outcome === "missed") setOpen(false);
            }}
          />
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

/** A suggested block: dashed, not draggable; × leaves it out of the plan. */
function ProposalView({
  placed,
  onDrop,
}: {
  placed: Placed<ProposedBlock>;
  onDrop?(id: string): void;
}) {
  const { tasks, projects, openTask } = useCalendar();
  const proposal = placed.item;
  const task = tasks[proposal.task_id];
  const color = projectColor(task, projects) ?? "var(--tm-accent)";
  const title = task?.title ?? "Deleted task";
  const top = (placed.startMin / 60) * HOUR_PX;
  const height = Math.max(((placed.endMin - placed.startMin) / 60) * HOUR_PX - 2, 16);
  return (
    <div
      data-testid="proposed-block"
      // Not a place to draw a new block.
      onPointerDown={(e) => e.stopPropagation()}
      className="group absolute flex items-start gap-1 overflow-hidden rounded-md border border-dashed px-1.5 py-0.5 text-[12px] leading-4 text-ink"
      style={{
        top,
        height,
        left: `calc(${(placed.column / placed.columns) * 100}% + 2px)`,
        width: `calc(${100 / placed.columns}% - 4px)`,
        borderColor: color,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}
    >
      <button
        type="button"
        onClick={() => task && openTask(task.id)}
        aria-label={`Suggested: ${title}, ${formatRange(proposal.start_at, proposal.end_at)}`}
        className={cx("min-w-0 flex-1 text-left", FOCUS)}
      >
        <span className="block truncate font-medium">{title}</span>
        {height >= 34 && (
          <span className="block truncate text-[11px] text-ink-2 tabular-nums">
            {formatRange(proposal.start_at, proposal.end_at)}
          </span>
        )}
      </button>
      {onDrop && (
        <button
          type="button"
          aria-label={`Leave ${title} out of the plan`}
          onClick={() => onDrop(proposal.id)}
          className={cx(
            "shrink-0 rounded p-0.5 text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100",
            FOCUS,
          )}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

/** A strip along a block's top or bottom edge; dragging it moves that edge. */
function ResizeHandle({
  edge,
  active,
  onPointerDown,
}: {
  edge: "start" | "end";
  active: boolean;
  onPointerDown(e: React.PointerEvent): void;
}) {
  return (
    <span
      aria-hidden
      data-testid={edge === "start" ? "resize-handle-start" : "resize-handle"}
      onPointerDown={onPointerDown}
      className={cx(
        "absolute inset-x-0 flex h-2 cursor-ns-resize justify-center",
        edge === "start" ? "top-0 items-start" : "bottom-0 items-end",
      )}
    >
      <span
        className={cx(
          "mx-auto my-0.5 h-[3px] w-6 rounded-full bg-current transition-opacity",
          active ? "opacity-60" : "opacity-0 group-hover:opacity-40",
        )}
      />
    </span>
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
