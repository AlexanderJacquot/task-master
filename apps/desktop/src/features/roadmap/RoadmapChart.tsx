import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ContextMenu } from "radix-ui";
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
import { CalendarPlusIcon, CloseIcon, ExternalIcon } from "../../components/TaskIcons";
import { cx, FOCUS, MENU, MENU_ITEM } from "../../components/ui";
import {
  addWorkingDays,
  type Bar,
  DAY_WIDTH,
  dayNumber,
  type Item,
  isoOf,
  isWeekend,
  type Link,
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
/** Two clicks on the same bar within this many milliseconds are a double-click. */
export const DOUBLE_CLICK_MS = 500;

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
  | { kind: "deadline"; originX: number; from: string; date: string };

/** An epic's target date across its task timeline: a line, and a handle on the scale. */
export type Deadline = { date: string; label: string };

export type RoadmapChartProps = {
  rows: Row[];
  links: Link[];
  range: Range;
  zoom: Zoom;
  today: string;
  /** The name column's heading: "Epic" or "Task". */
  nameHeader: string;
  /** What a bar's end is: "target date" or "due date". */
  dateName: string;
  deadline: Deadline | null;
  selected: string | null;
  busy: boolean;
  /** Changes to `scrollKey` scroll today back into view (a new zoom or range). */
  scrollKey: string;
  /** Bumped by "Today" to scroll back to today. */
  todaySeq: number;
  onSelect(id: string | null): void;
  /** The name's button: open the task, or the epic's timeline. */
  openLabel(item: Item): string;
  onOpen(id: string): void;
  /** Double-clicking a bar opens it too (Settings → General → Roadmap). */
  openOnDoubleClick?: boolean;
  onBar(id: string, bar: Bar): void;
  /** Takes a bar off the chart: the item has no end date any more (a mistake, undoable). */
  onClear(id: string): void;
  onDeadline(date: string): void;
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
function barLabel(item: Item, bar: Bar, today: string) {
  const start = dateLabel(bar.start, today);
  return bar.start === bar.end
    ? `${item.title}, ${start}`
    : `${item.title}, ${start} to ${dateLabel(bar.end, today)}`;
}

/** A bar drawn with one click: as long as the item takes. */
function newBar(item: Item, start: string): Bar {
  return { start, end: addWorkingDays(start, item.length - 1) };
}

export function RoadmapChart({
  rows,
  links,
  range,
  zoom,
  today,
  nameHeader,
  dateName,
  deadline,
  selected,
  busy,
  scrollKey,
  todaySeq,
  onSelect,
  openLabel,
  onOpen,
  openOnDoubleClick = false,
  onBar,
  onClear,
  onDeadline,
  onToggleGroup,
}: RoadmapChartProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /**
   * The last click on a bar that did not move it. Pressing a bar captures the pointer on
   * the chart, so the browser's dblclick never reaches the bar: two such clicks make one.
   */
  const lastClick = useRef<{ id: string; at: number } | null>(null);
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

  /** Where each item's row is, for the dependency arrows. */
  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => {
      if (row.kind === "item") map.set(row.item.id, i);
    });
    return map;
  }, [rows]);

  /** The bar as shown: the one being dragged follows the pointer. */
  const shown = (item: Item): Bar | null =>
    drag && drag.kind !== "deadline" && drag.id === item.id ? drag.bar : item.bar;
  const deadlineDate = drag?.kind === "deadline" ? drag.date : deadline?.date;

  function startBar(event: PointerEvent, item: Item, bar: Bar) {
    // Ctrl+click is a right-click on macOS: it opens the row's menu, not a drag.
    if (event.button !== 0 || event.ctrlKey || busy) return;
    event.stopPropagation();
    const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-handle]")?.dataset
      .handle;
    const mode = handle === "start" || handle === "end" ? handle : "move";
    scrollRef.current?.setPointerCapture?.(event.pointerId);
    onSelect(item.id);
    setDrag({ kind: "bar", id: item.id, mode, originX: event.clientX, from: bar, bar });
  }
  /** Drawing a bar on an unscheduled item's empty track. */
  function startDraw(event: PointerEvent<HTMLElement>, item: Item) {
    if (event.button !== 0 || event.ctrlKey || busy) return;
    const left = event.currentTarget.getBoundingClientRect().left;
    const anchor = isoOf(from + Math.floor((event.clientX - left) / dayWidth));
    scrollRef.current?.setPointerCapture?.(event.pointerId);
    onSelect(item.id);
    setDrag({ kind: "draw", id: item.id, left, anchor, bar: { start: anchor, end: anchor } });
  }
  function startDeadline(event: PointerEvent, date: string) {
    if (event.button !== 0 || busy) return;
    event.stopPropagation();
    scrollRef.current?.setPointerCapture?.(event.pointerId);
    setDrag({ kind: "deadline", originX: event.clientX, from: date, date });
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
    if (drag.kind === "deadline") {
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
    if (drag.kind === "deadline") {
      if (drag.date !== drag.from) onDeadline(drag.date);
    } else if (drag.kind === "draw") {
      const item = rows.find(
        (row): row is Extract<Row, { kind: "item" }> =>
          row.kind === "item" && row.item.id === drag.id,
      )?.item;
      // A click without dragging gives it a bar as long as it takes (its estimate).
      if (item)
        onBar(item.id, drag.bar.start === drag.bar.end ? newBar(item, drag.bar.start) : drag.bar);
    } else if (drag.bar.start !== drag.from.start || drag.bar.end !== drag.from.end) {
      lastClick.current = null;
      onBar(drag.id, drag.bar);
    } else if (openOnDoubleClick) {
      const now = Date.now();
      const previous = lastClick.current;
      if (previous && previous.id === drag.id && now - previous.at <= DOUBLE_CLICK_MS) {
        lastClick.current = null;
        onOpen(drag.id);
      } else lastClick.current = { id: drag.id, at: now };
    }
  }
  /**
   * ←/→ move a bar a day (with Shift a week); Alt moves its start, Ctrl/⌘ its end.
   * Delete or Backspace takes it off the chart.
   */
  function barKey(event: KeyboardEvent, item: Item, bar: Bar) {
    if (event.key === "Enter") {
      event.preventDefault();
      onOpen(item.id);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (!busy) onClear(item.id);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    if (busy) return;
    const days = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 7 : 1);
    const mode = event.altKey ? "start" : event.ctrlKey || event.metaKey ? "end" : "move";
    const next = shiftBar(bar, mode, days);
    if (next.start !== bar.start || next.end !== bar.end) onBar(item.id, next);
  }
  function deadlineKey(event: KeyboardEvent, date: string) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    if (busy) return;
    const days = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 7 : 1);
    onDeadline(isoOf(dayNumber(date) + days));
  }

  const lateInto = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const link of links)
      if (link.late) map.set(link.to, [...(map.get(link.to) ?? []), link.from]);
    return map;
  }, [links]);
  const titleOf = (id: string) => {
    const row = rows[rowIndex.get(id) ?? -1];
    return row?.kind === "item" ? row.item.title : "";
  };

  /** Arrows from a prerequisite's end to its dependent's start, while both rows show. */
  const arrows = links.flatMap((link) => {
    const a = rowIndex.get(link.from);
    const b = rowIndex.get(link.to);
    const fromRow = a === undefined ? undefined : rows[a];
    const toRow = b === undefined ? undefined : rows[b];
    if (a === undefined || b === undefined || fromRow?.kind !== "item" || toRow?.kind !== "item")
      return [];
    const fromBar = shown(fromRow.item);
    const toBar = shown(toRow.item);
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
      className="relative min-h-0 flex-1 overflow-auto bg-canvas select-none"
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
            {nameHeader}
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
            {deadline && deadlineDate && (
              <button
                type="button"
                aria-label={`Target date of ${deadline.label}, ${dateLabel(deadlineDate, today)}`}
                title={`Target date: ${deadlineDate}. Drag, or use ←/→, to move it.`}
                onPointerDown={(event) => startDeadline(event, deadline.date)}
                onKeyDown={(event) => deadlineKey(event, deadline.date)}
                className={cx(
                  "absolute bottom-1 z-[4] size-3.5 -translate-x-1/2 rotate-45 cursor-ew-resize border-2 border-raised bg-rubric shadow-sm",
                  FOCUS,
                )}
                style={{ left: x(deadlineDate) + dayWidth }}
              />
            )}
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
            {deadlineDate && (
              <div
                data-testid="deadline-line"
                className="absolute top-0 bottom-0 z-[2] border-l-2 border-dashed border-rubric/70"
                style={{ left: x(deadlineDate) + dayWidth }}
              />
            )}
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

          {virtualizer.getVirtualItems().map((virtual) => {
            const row = rows[virtual.index];
            if (!row) return null;
            const top = virtual.index * ROW_HEIGHT;
            if (row.kind === "group") {
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
                  </div>
                </div>
              );
            }
            const { item, depth } = row;
            const bar = shown(item);
            const { done } = item;
            const late = lateInto.get(item.id);
            const overdue = !done && !!bar && bar.end < today;
            const pastDeadline = !done && !!bar && !!deadlineDate && bar.end > deadlineDate;
            const isSelected = selected === item.id;
            const warning = [
              late && `Starts before ${late.map((id) => `“${titleOf(id)}”`).join(", ")} ends`,
              pastDeadline && "Ends after the epic's target date",
            ]
              .filter(Boolean)
              .join(". ");
            const progress =
              item.progress === null ? "" : ` · ${Math.round(item.progress * 100)}% done`;
            return (
              <ContextMenu.Root key={item.id} modal={false}>
                <ContextMenu.Trigger asChild>
                  <div
                    data-row={item.id}
                    className={cx("absolute left-0 flex", isSelected && "bg-selected/40")}
                    style={{ top, height: ROW_HEIGHT, width: NAME_WIDTH + width }}
                  >
                    <div
                      className={cx(
                        "group/name sticky left-0 z-20 flex shrink-0 items-center gap-1 border-r border-b border-line/70 bg-raised pr-2 pl-7",
                        isSelected && "bg-selected",
                      )}
                      style={{ width: NAME_WIDTH, paddingLeft: 28 + depth * 14 }}
                    >
                      {item.progress !== null && (
                        <span
                          aria-hidden
                          className="inline-block size-2 shrink-0 rounded-full bg-ink-3"
                          style={item.color ? { backgroundColor: item.color } : undefined}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => onOpen(item.id)}
                        title={item.title}
                        aria-label={openLabel(item)}
                        className={cx(
                          "min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-sm text-ink hover:underline",
                          done && "text-ink-3 line-through",
                          depth > 0 && "text-ink-2",
                          FOCUS,
                        )}
                      >
                        {item.title}
                      </button>
                      {!bar && (
                        <button
                          type="button"
                          aria-label={`Schedule ${item.title} from today`}
                          title="Schedule from today (or drag across its row)"
                          disabled={busy}
                          onClick={() => onBar(item.id, newBar(item, today))}
                          className={cx(
                            "flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-0 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/name:opacity-100",
                            FOCUS,
                          )}
                        >
                          <CalendarPlusIcon size={14} />
                        </button>
                      )}
                      {bar && (
                        <button
                          type="button"
                          aria-label={`Remove ${item.title} from the roadmap`}
                          title={`Remove from the roadmap: clears its ${dateName} (or select its bar and press Delete)`}
                          disabled={busy}
                          onClick={() => onClear(item.id)}
                          className={cx(
                            "flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-0 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/name:opacity-100",
                            FOCUS,
                          )}
                        >
                          <CloseIcon size={14} />
                        </button>
                      )}
                    </div>
                    {/* Drawing a bar is a pointer shortcut; the Schedule button does it from the keyboard. */}
                    <div
                      data-track={item.id}
                      className={cx(
                        "relative shrink-0 border-b border-line/40",
                        !bar && "cursor-crosshair",
                      )}
                      style={{ width }}
                      onPointerDown={(event) => (bar ? onSelect(item.id) : startDraw(event, item))}
                    >
                      {!bar && item.span && (
                        <div
                          aria-hidden
                          data-span={item.id}
                          title="Where its tasks are planned"
                          className="pointer-events-none absolute top-2 bottom-2 rounded-md border border-dashed border-ink-3/50"
                          style={{
                            left: x(item.span.start),
                            width: x(item.span.end) - x(item.span.start) + dayWidth,
                          }}
                        />
                      )}
                      {bar && (
                        <button
                          type="button"
                          data-bar={item.id}
                          aria-label={barLabel(item, bar, today)}
                          aria-pressed={isSelected}
                          title={
                            warning ||
                            `${bar.start} to ${bar.end}${progress}. Drag to move, drag an end to resize; ←/→ move, Alt or Ctrl+←/→ resize${openOnDoubleClick ? "; double-click or Enter opens it" : "; Enter opens it"}; Delete or right-click to remove it from the roadmap.`
                          }
                          onPointerDown={(event) => startBar(event, item, bar)}
                          onKeyDown={(event) => barKey(event, item, bar)}
                          className={cx(
                            "group/bar absolute top-1.5 bottom-1.5 flex cursor-grab items-center overflow-hidden rounded-md border px-2 text-left text-xs shadow-sm active:cursor-grabbing",
                            done
                              ? "border-line-strong bg-done/25 text-ink-3"
                              : "border-accent/60 bg-accent/20 text-ink",
                            (overdue || pastDeadline) && "border-danger/70",
                            warning && "ring-2 ring-danger/60",
                            isSelected && "ring-2 ring-accent",
                            FOCUS,
                          )}
                          style={{
                            left: x(bar.start),
                            width: Math.max(dayWidth, x(bar.end) - x(bar.start) + dayWidth),
                            ...(!done &&
                              !overdue &&
                              !pastDeadline &&
                              item.color && { borderColor: item.color }),
                          }}
                        >
                          {item.progress !== null && (
                            <span
                              aria-hidden
                              data-progress={Math.round(item.progress * 100)}
                              className="pointer-events-none absolute inset-y-0 left-0 bg-accent/35"
                              style={{
                                width: `${item.progress * 100}%`,
                                ...(item.color && { backgroundColor: item.color, opacity: 0.35 }),
                              }}
                            />
                          )}
                          <span
                            data-handle="start"
                            aria-hidden
                            className="absolute inset-y-0 left-0 z-[1] w-1.5 cursor-ew-resize hover:bg-accent/40"
                          />
                          <span className="pointer-events-none relative truncate">
                            {item.title}
                            {item.progress !== null && (
                              <span className="text-ink-3">{progress}</span>
                            )}
                          </span>
                          <span
                            data-handle="end"
                            aria-hidden
                            className="absolute inset-y-0 right-0 z-[1] w-1.5 cursor-ew-resize hover:bg-accent/40"
                          />
                        </button>
                      )}
                    </div>
                  </div>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content className={cx(MENU, "min-w-52")}>
                    <ContextMenu.Item className={MENU_ITEM} onSelect={() => onOpen(item.id)}>
                      <ExternalIcon size={14} /> {openLabel(item)}
                    </ContextMenu.Item>
                    {bar ? (
                      <ContextMenu.Item
                        className={MENU_ITEM}
                        disabled={busy}
                        onSelect={() => onClear(item.id)}
                      >
                        <CloseIcon size={14} /> Remove from the roadmap
                        <span className="ml-auto pl-4 text-xs text-ink-3">Del</span>
                      </ContextMenu.Item>
                    ) : (
                      <ContextMenu.Item
                        className={MENU_ITEM}
                        disabled={busy}
                        onSelect={() => onBar(item.id, newBar(item, today))}
                      >
                        <CalendarPlusIcon size={14} /> Schedule from today
                      </ContextMenu.Item>
                    )}
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            );
          })}
        </div>
      </div>
    </div>
  );
}
