import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CalendarPlusIcon } from "../../components/TaskIcons";
import { cx, FOCUS } from "../../components/ui";
import type { Epic, Task } from "../../lib/types";
import {
  type Bar,
  DAY_WIDTH,
  dayNumber,
  isoOf,
  isWeekend,
  type Link,
  newBar,
  type Range,
  type Row,
  shiftBar,
  spanBetween,
  ticksOf,
  type Zoom,
} from "./timeline";

export const ROW_HEIGHT = 36;
export const HEADER_HEIGHT = 52;
export const NAME_WIDTH = 288;

/** A bar or milestone being dragged: where it started and what it shows now. */
type Drag =
  | {
      kind: "bar";
      id: string;
      mode: "move" | "start" | "end";
      originX: number;
      from: Bar;
      bar: Bar;
    }
  | { kind: "draw"; id: string; left: number; anchor: string; bar: Bar }
  | { kind: "target"; epic: string; originX: number; from: string; date: string };

export type RoadmapChartProps = {
  rows: Row[];
  links: Link[];
  range: Range;
  zoom: Zoom;
  today: string;
  closed: ReadonlySet<string>;
  selected: string | null;
  busy: boolean;
  /** Changes to `scrollKey` scroll today back into view (a new zoom or range). */
  scrollKey: string;
  /** Bumped by "Today" to scroll back to today. */
  todaySeq: number;
  onSelect(id: string | null): void;
  onOpen(id: string): void;
  onBar(id: string, bar: Bar): void;
  onTarget(epic: string, date: string): void;
  onToggleGroup(key: string): void;
};

/** "Dec 1", with the year when it is not this year's. */
export function dateLabel(iso: string, today: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(iso.slice(0, 4) !== today.slice(0, 4) && { year: "numeric" }),
  });
}

/** "Plan, Dec 1 to Dec 5" (one day: "Plan, Dec 1"). */
function barLabel(task: Task, bar: Bar, today: string) {
  const start = dateLabel(bar.start, today);
  return bar.start === bar.end
    ? `${task.title}, ${start}`
    : `${task.title}, ${start} to ${dateLabel(bar.end, today)}`;
}

export function RoadmapChart({
  rows,
  links,
  range,
  zoom,
  today,
  closed,
  selected,
  busy,
  scrollKey,
  todaySeq,
  onSelect,
  onOpen,
  onBar,
  onTarget,
  onToggleGroup,
}: RoadmapChartProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const markerId = useId();
  const dayWidth = DAY_WIDTH[zoom];
  const from = dayNumber(range.from);
  const width = range.days * dayWidth;
  const x = (iso: string) => (dayNumber(iso) - from) * dayWidth;
  const ticks = useMemo(() => ticksOf(range, zoom), [range, zoom]);
  const todayX = x(today);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const total = rows.length * ROW_HEIGHT;

  const todayRef = useRef(todayX);
  todayRef.current = todayX;
  /** Puts today a third of the way across the visible part of the timeline. */
  const scrollToToday = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, todayRef.current - Math.max(0, el.clientWidth - NAME_WIDTH) / 3);
  }, []);

  // Opens (and re-zooms) on today.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when the key or "Today" changes
  useLayoutEffect(scrollToToday, [scrollKey, todaySeq]);

  // A page opened in a hidden pane has no width yet: center on today once it gets one.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let wide = el.clientWidth > NAME_WIDTH;
    const observer = new ResizeObserver(() => {
      if (!wide && el.clientWidth > NAME_WIDTH) scrollToToday();
      wide = el.clientWidth > NAME_WIDTH;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollToToday]);

  // A range that grows to the left (a bar moved before it) keeps what is in view in place;
  // a new zoom recenters on today instead.
  const previous = useRef({ from, dayWidth });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const shift =
      previous.current.dayWidth === dayWidth ? (previous.current.from - from) * dayWidth : 0;
    previous.current = { from, dayWidth };
    if (el && shift) el.scrollLeft += shift;
  }, [from, dayWidth]);

  /** Where each task's row is, for the dependency arrows. */
  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => {
      if (row.kind === "task") map.set(row.task.id, i);
    });
    return map;
  }, [rows]);

  /** The bar as shown: the one being dragged follows the pointer. */
  const shown = (row: Extract<Row, { kind: "task" }>): Bar | null =>
    drag && drag.kind !== "target" && drag.id === row.task.id ? drag.bar : row.bar;
  const targetShown = (epic: Epic) =>
    drag?.kind === "target" && drag.epic === epic.id ? drag.date : epic.target_date;

  function startBar(event: PointerEvent, task: Task, bar: Bar) {
    if (event.button !== 0 || busy) return;
    event.stopPropagation();
    const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-handle]")?.dataset
      .handle;
    const mode = handle === "start" || handle === "end" ? handle : "move";
    scrollRef.current?.setPointerCapture?.(event.pointerId);
    onSelect(task.id);
    setDrag({ kind: "bar", id: task.id, mode, originX: event.clientX, from: bar, bar });
  }
  /** Drawing a bar on an unscheduled task's empty track. */
  function startDraw(event: PointerEvent<HTMLElement>, task: Task) {
    if (event.button !== 0 || busy) return;
    const left = event.currentTarget.getBoundingClientRect().left;
    const anchor = isoOf(from + Math.floor((event.clientX - left) / dayWidth));
    scrollRef.current?.setPointerCapture?.(event.pointerId);
    onSelect(task.id);
    setDrag({ kind: "draw", id: task.id, left, anchor, bar: { start: anchor, end: anchor } });
  }
  function startTarget(event: PointerEvent, epic: Epic, date: string) {
    if (event.button !== 0 || busy) return;
    event.stopPropagation();
    scrollRef.current?.setPointerCapture?.(event.pointerId);
    setDrag({ kind: "target", epic: epic.id, originX: event.clientX, from: date, date });
  }
  function move(event: PointerEvent) {
    if (!drag) return;
    if (drag.kind === "draw") {
      const day = isoOf(from + Math.floor((event.clientX - drag.left) / dayWidth));
      const bar = spanBetween(drag.anchor, day);
      if (bar.start !== drag.bar.start || bar.end !== drag.bar.end) setDrag({ ...drag, bar });
      return;
    }
    const days = Math.round((event.clientX - drag.originX) / dayWidth);
    if (drag.kind === "target") {
      const date = isoOf(dayNumber(drag.from) + days);
      if (date !== drag.date) setDrag({ ...drag, date });
      return;
    }
    const bar = shiftBar(drag.from, drag.mode, days);
    if (bar.start !== drag.bar.start || bar.end !== drag.bar.end) setDrag({ ...drag, bar });
  }
  function finish() {
    if (!drag) return;
    setDrag(null);
    if (drag.kind === "target") {
      if (drag.date !== drag.from) onTarget(drag.epic, drag.date);
    } else if (drag.kind === "draw") {
      const task = rows.find(
        (row): row is Extract<Row, { kind: "task" }> =>
          row.kind === "task" && row.task.id === drag.id,
      )?.task;
      // A click without dragging gives the task a bar as long as its estimate.
      if (task)
        onBar(task.id, drag.bar.start === drag.bar.end ? newBar(task, drag.bar.start) : drag.bar);
    } else if (drag.bar.start !== drag.from.start || drag.bar.end !== drag.from.end) {
      onBar(drag.id, drag.bar);
    }
  }
  /** ←/→ move a bar a day (with Shift a week); Alt moves its start, Ctrl/⌘ its end. */
  function barKey(event: KeyboardEvent, task: Task, bar: Bar) {
    if (event.key === "Enter") {
      event.preventDefault();
      onOpen(task.id);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    if (busy) return;
    const days = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 7 : 1);
    const mode = event.altKey ? "start" : event.ctrlKey || event.metaKey ? "end" : "move";
    const next = shiftBar(bar, mode, days);
    if (next.start !== bar.start || next.end !== bar.end) onBar(task.id, next);
  }
  function targetKey(event: KeyboardEvent, epic: Epic, date: string) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    if (busy) return;
    const days = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 7 : 1);
    onTarget(epic.id, isoOf(dayNumber(date) + days));
  }

  const lateInto = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const link of links)
      if (link.late) map.set(link.to, [...(map.get(link.to) ?? []), link.from]);
    return map;
  }, [links]);
  /** Each group's epic or project color, for its bars' outline. */
  const colors = useMemo(
    () => new Map(rows.flatMap((row) => (row.kind === "group" ? [[row.key, row.color]] : []))),
    [rows],
  );
  const titleOf = (id: string) => {
    const row = rows[rowIndex.get(id) ?? -1];
    return row?.kind === "task" ? row.task.title : "";
  };

  /** Arrows from a prerequisite's end to its dependent's start, while both rows show. */
  const arrows = links.flatMap((link) => {
    const a = rowIndex.get(link.from);
    const b = rowIndex.get(link.to);
    const fromRow = a === undefined ? undefined : rows[a];
    const toRow = b === undefined ? undefined : rows[b];
    if (a === undefined || b === undefined || fromRow?.kind !== "task" || toRow?.kind !== "task")
      return [];
    const fromBar = shown(fromRow);
    const toBar = shown(toRow);
    if (!fromBar || !toBar) return [];
    const x1 = x(fromBar.end) + dayWidth;
    const y1 = a * ROW_HEIGHT + ROW_HEIGHT / 2;
    const x2 = x(toBar.start);
    const y2 = b * ROW_HEIGHT + ROW_HEIGHT / 2;
    const late = toBar.start <= fromBar.end;
    const bend = Math.max(16, Math.abs(x2 - x1) / 2);
    return [
      {
        key: `${link.from}>${link.to}`,
        late,
        d: `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 2} ${y2}`,
      },
    ];
  });

  return (
    <div
      ref={scrollRef}
      role="application"
      aria-label="Roadmap timeline"
      className="relative min-h-0 flex-1 overflow-auto bg-canvas"
      onPointerMove={move}
      onPointerUp={finish}
      onLostPointerCapture={() => setDrag(null)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag) {
          event.preventDefault();
          setDrag(null);
        }
      }}
    >
      <div
        className="relative"
        style={{ width: NAME_WIDTH + width, height: HEADER_HEIGHT + total }}
      >
        {/* The scale: months or years above, days, weeks, months or quarters below. */}
        <div className="sticky top-0 z-30 flex" style={{ height: HEADER_HEIGHT }}>
          <div
            className="sticky left-0 z-10 flex shrink-0 items-end border-r border-b border-line bg-raised px-4 pb-2 text-xs font-medium text-ink-3"
            style={{ width: NAME_WIDTH }}
          >
            Task
          </div>
          <div
            className="relative shrink-0 border-b border-line bg-raised text-xs"
            style={{ width }}
          >
            {ticks.top.map((tick) => (
              <div
                key={tick.key}
                className="absolute top-0 h-1/2 border-l border-line pt-1 font-medium whitespace-nowrap text-ink-2"
                style={{ left: tick.offset * dayWidth, width: tick.length * dayWidth }}
              >
                {/* Stays in view while its month or year is, beside the task column. */}
                <span className="sticky px-1.5" style={{ left: NAME_WIDTH }}>
                  {tick.label}
                </span>
              </div>
            ))}
            {ticks.bottom.map((tick) => {
              const day = dayNumber(range.from) + tick.offset;
              return (
                <div
                  key={tick.key}
                  className={cx(
                    "absolute bottom-0 h-1/2 truncate border-l border-line px-1 pt-1 text-ink-3",
                    zoom === "day" && isWeekend(day) && "text-ink-3/60",
                    zoom === "day" && isoOf(day) === today && "font-semibold text-accent",
                  )}
                  style={{ left: tick.offset * dayWidth, width: tick.length * dayWidth }}
                >
                  {tick.label}
                </div>
              );
            })}
          </div>
        </div>

        <div className="relative" style={{ height: total }}>
          {/* Grid: a line per tick, weekends shaded when days are wide enough, and today. */}
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0"
            style={{ left: NAME_WIDTH, width }}
          >
            {(zoom === "day" || zoom === "week") &&
              Array.from({ length: range.days }, (_, i) => from + i)
                .filter(isWeekend)
                .map((day) => (
                  <div
                    key={day}
                    className="absolute top-0 bottom-0 bg-ink/[0.035]"
                    style={{ left: (day - from) * dayWidth, width: dayWidth }}
                  />
                ))}
            {ticks.bottom.map((tick) => (
              <div
                key={tick.key}
                className="absolute top-0 bottom-0 border-l border-line/60"
                style={{ left: tick.offset * dayWidth }}
              />
            ))}
            <div
              data-testid="today-line"
              className="absolute top-0 bottom-0 z-[2] border-l-2 border-accent/70"
              style={{ left: todayX + dayWidth / 2 }}
            />
          </div>

          <svg
            aria-hidden
            className="pointer-events-none absolute top-0 z-[3] overflow-visible"
            style={{ left: NAME_WIDTH }}
            width={width}
            height={total}
          >
            <defs>
              {(["ok", "late"] as const).map((kind) => (
                <marker
                  key={kind}
                  id={`${markerId}-${kind}`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path
                    d="M0 0L8 4L0 8Z"
                    className={kind === "late" ? "fill-danger" : "fill-ink-3"}
                  />
                </marker>
              ))}
            </defs>
            {arrows.map((arrow) => (
              <path
                key={arrow.key}
                data-link={arrow.key}
                data-late={arrow.late || undefined}
                d={arrow.d}
                fill="none"
                strokeWidth={1.5}
                strokeDasharray={arrow.late ? "4 3" : undefined}
                className={arrow.late ? "stroke-danger" : "stroke-ink-3/70"}
                markerEnd={`url(#${markerId}-${arrow.late ? "late" : "ok"})`}
              />
            ))}
          </svg>

          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const top = item.index * ROW_HEIGHT;
            if (row.kind === "group") {
              const target = row.epic ? targetShown(row.epic) : null;
              return (
                <div
                  key={`g:${row.key}`}
                  className="absolute left-0 flex"
                  style={{ top, height: ROW_HEIGHT, width: NAME_WIDTH + width }}
                >
                  <div
                    className="sticky left-0 z-20 flex shrink-0 items-center gap-1.5 border-r border-b border-line bg-raised pr-3 pl-2"
                    style={{ width: NAME_WIDTH }}
                  >
                    <button
                      type="button"
                      aria-expanded={!row.collapsed}
                      aria-label={`${row.collapsed ? "Unfold" : "Fold"} ${row.label}`}
                      onClick={() => onToggleGroup(row.key)}
                      className={cx(
                        "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm font-medium text-ink hover:bg-hover",
                        FOCUS,
                      )}
                    >
                      {row.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      <span
                        aria-hidden
                        className="inline-block size-2 shrink-0 rounded-full bg-ink-3"
                        style={row.color ? { backgroundColor: row.color } : undefined}
                      />
                      <span className="truncate">{row.label}</span>
                      <span className="ml-auto shrink-0 text-xs font-normal text-ink-3">
                        {row.count}
                      </span>
                    </button>
                  </div>
                  <div
                    className="relative shrink-0 border-b border-line bg-raised/50"
                    style={{ width }}
                  >
                    {row.span && (
                      <div
                        aria-hidden
                        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-ink-3/40"
                        style={{
                          left: x(row.span.start),
                          width: x(row.span.end) - x(row.span.start) + dayWidth,
                          ...(row.color && { backgroundColor: row.color, opacity: 0.5 }),
                        }}
                      />
                    )}
                    {row.epic && target && (
                      <button
                        type="button"
                        aria-label={`Target date of ${row.label}, ${dateLabel(target, today)}`}
                        title={`Target date: ${target}. Drag, or use ←/→, to move it.`}
                        onPointerDown={(event) =>
                          row.epic && startTarget(event, row.epic, row.epic.target_date ?? target)
                        }
                        onKeyDown={(event) => row.epic && targetKey(event, row.epic, target)}
                        className={cx(
                          "absolute top-1/2 z-[4] size-3.5 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize border-2 border-raised bg-rubric shadow-sm",
                          FOCUS,
                        )}
                        style={{ left: x(target) + dayWidth / 2 }}
                      />
                    )}
                  </div>
                </div>
              );
            }
            const { task } = row;
            const bar = shown(row);
            const done = closed.has(task.id);
            const late = lateInto.get(task.id);
            const overdue = !done && !!bar && bar.end < today;
            const isSelected = selected === task.id;
            return (
              <div
                key={task.id}
                className={cx("absolute left-0 flex", isSelected && "bg-selected/40")}
                style={{ top, height: ROW_HEIGHT, width: NAME_WIDTH + width }}
              >
                <div
                  className={cx(
                    "group/name sticky left-0 z-20 flex shrink-0 items-center gap-1 border-r border-b border-line/70 bg-raised pr-2 pl-7",
                    isSelected && "bg-selected",
                  )}
                  style={{ width: NAME_WIDTH }}
                >
                  <button
                    type="button"
                    onClick={() => onOpen(task.id)}
                    title={task.title}
                    aria-label={`Open ${task.title}`}
                    className={cx(
                      "min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-sm text-ink hover:underline",
                      done && "text-ink-3 line-through",
                      task.parent_id && "pl-3 text-ink-2",
                      FOCUS,
                    )}
                  >
                    {task.title}
                  </button>
                  {!bar && (
                    <button
                      type="button"
                      aria-label={`Schedule ${task.title} from today`}
                      title="Schedule from today (or drag on its row)"
                      disabled={busy}
                      onClick={() => onBar(task.id, newBar(task, today))}
                      className={cx(
                        "flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-0 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/name:opacity-100",
                        FOCUS,
                      )}
                    >
                      <CalendarPlusIcon size={14} />
                    </button>
                  )}
                </div>
                {/* Drawing a bar is a pointer shortcut; the Schedule button does it from the keyboard. */}
                <div
                  data-track={task.id}
                  className={cx(
                    "relative shrink-0 border-b border-line/40",
                    !bar && "cursor-crosshair",
                  )}
                  style={{ width }}
                  onPointerDown={(event) => (bar ? onSelect(task.id) : startDraw(event, task))}
                >
                  {bar && (
                    <button
                      type="button"
                      data-bar={task.id}
                      aria-label={barLabel(task, bar, today)}
                      aria-pressed={isSelected}
                      title={
                        late
                          ? `Starts before ${late.map((id) => `“${titleOf(id)}”`).join(", ")} ends`
                          : `${bar.start} to ${bar.end}. Drag to move, drag an end to resize; ←/→ move, Alt or Ctrl+←/→ resize.`
                      }
                      onPointerDown={(event) => startBar(event, task, bar)}
                      onDoubleClick={() => onOpen(task.id)}
                      onKeyDown={(event) => barKey(event, task, bar)}
                      className={cx(
                        "group/bar absolute top-1.5 bottom-1.5 flex cursor-grab items-center overflow-hidden rounded-md border px-2 text-left text-xs shadow-sm active:cursor-grabbing",
                        done
                          ? "border-line-strong bg-done/25 text-ink-3"
                          : "border-accent/60 bg-accent/20 text-ink",
                        overdue && "border-danger/70",
                        late && "ring-2 ring-danger/60",
                        isSelected && "ring-2 ring-accent",
                        FOCUS,
                      )}
                      style={{
                        left: x(bar.start),
                        width: Math.max(dayWidth, x(bar.end) - x(bar.start) + dayWidth),
                        ...(!done &&
                          !overdue &&
                          colors.get(row.group) && { borderColor: colors.get(row.group) ?? "" }),
                      }}
                    >
                      <span
                        data-handle="start"
                        aria-hidden
                        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-accent/40"
                      />
                      <span className="pointer-events-none truncate">{task.title}</span>
                      <span
                        data-handle="end"
                        aria-hidden
                        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-accent/40"
                      />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
