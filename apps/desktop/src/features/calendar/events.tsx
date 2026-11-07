import {
  ExternalIcon as ExternalLink,
  MapPinIcon as MapPin,
  CloseIcon as X,
} from "../../components/TaskIcons";
// Events from the user's calendars (M10, ADR 014): read-only, drawn outlined in their
// calendar's color so they read as "planned elsewhere". A click shows the details and a
// link to the event in Google Calendar.

import { Popover } from "radix-ui";
import { type ReactNode, useState } from "react";
import { Button, cx, FOCUS } from "../../components/ui";
import {
  addDays,
  type EventSpan,
  formatRange,
  formatTime,
  HOUR_PX,
  type Placed,
  parseIso,
} from "../../lib/calendar";
import type { CalendarEvent } from "../../lib/types";
import { useCalendar } from "./shared";

function edge(event: CalendarEvent) {
  return event.color ?? "var(--tm-ink-3)";
}

function when(event: CalendarEvent): string {
  if (event.start_at !== null && event.end_at !== null) {
    const day = new Date(event.start_at).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    return `${day}, ${formatRange(event.start_at, event.end_at)}`;
  }
  if (event.start_date) {
    const short = (iso: string) =>
      parseIso(iso).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
    const last = event.end_date ? addDays(event.end_date, -1) : event.start_date;
    return last === event.start_date
      ? `${short(event.start_date)}, all day`
      : `${short(event.start_date)} – ${short(last)}`;
  }
  return "";
}

/** The details popover around an event's trigger element. */
function EventDetails({ event, children }: { event: CalendarEvent; children: ReactNode }) {
  const { openUrl, calendarName } = useCalendar();
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label="Calendar event"
          className="z-40 flex w-64 flex-col gap-2 rounded-xl border border-line-strong bg-overlay p-3 text-sm shadow-xl"
        >
          <div className="flex items-start gap-2">
            <span
              aria-hidden
              className="mt-1.5 size-2.5 shrink-0 rounded-full"
              style={{ background: edge(event) }}
            />
            <div className="min-w-0 flex-1">
              <div className="font-medium break-words text-ink">{event.title}</div>
              <div className="text-[12.5px] text-ink-2">{when(event)}</div>
            </div>
            <Popover.Close
              aria-label="Close"
              className={cx("rounded-md p-0.5 text-ink-3 hover:bg-hover", FOCUS)}
            >
              <X size={14} />
            </Popover.Close>
          </div>
          {event.location && (
            <div className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
              <MapPin size={13} className="shrink-0" />
              <span className="min-w-0 break-words">{event.location}</span>
            </div>
          )}
          <div className="text-[12px] text-ink-3">
            {calendarName(event.calendar_id)} · read-only here
          </div>
          {event.link && openUrl && (
            <Button
              size="sm"
              className="self-start"
              onClick={() => {
                setOpen(false);
                if (event.link) openUrl(event.link);
              }}
            >
              <ExternalLink size={13} />
              Open in Google Calendar
            </Button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A timed event in a day column. */
export function EventView({ placed }: { placed: Placed<EventSpan> }) {
  const { event } = placed.item;
  const top = (placed.startMin / 60) * HOUR_PX;
  const height = Math.max(((placed.endMin - placed.startMin) / 60) * HOUR_PX - 2, 16);
  const color = edge(event);
  return (
    <EventDetails event={event}>
      <button
        type="button"
        data-testid="calendar-event"
        aria-label={`${event.title}, ${formatRange(placed.item.start_at, placed.item.end_at)} (calendar event)`}
        className={cx(
          "absolute flex flex-col items-stretch overflow-hidden rounded-md border border-dashed px-1.5 py-0.5 text-left text-[12px] leading-4 text-ink-2",
          FOCUS,
        )}
        style={{
          top,
          height,
          left: `calc(${(placed.column / placed.columns) * 100}% + 2px)`,
          width: `calc(${100 / placed.columns}% - 4px)`,
          borderColor: color,
          background: `color-mix(in srgb, ${color} 8%, transparent)`,
        }}
      >
        <span className="truncate font-medium">{event.title}</span>
        {height >= 34 && (
          <span className="truncate text-[11px] text-ink-3 tabular-nums">
            {formatRange(placed.item.start_at, placed.item.end_at)}
          </span>
        )}
      </button>
    </EventDetails>
  );
}

/** An event in an all-day lane or a month cell. */
export function EventChip({ event }: { event: CalendarEvent }) {
  const color = edge(event);
  return (
    <EventDetails event={event}>
      <button
        type="button"
        data-testid="calendar-event"
        title={event.title}
        className={cx(
          "flex w-full min-w-0 items-center gap-1.5 rounded-md border border-dashed px-1.5 text-left text-[12px] leading-[18px] text-ink-2 hover:bg-hover",
          FOCUS,
        )}
        style={{ borderColor: color }}
      >
        {event.start_at !== null && (
          <span className="shrink-0 text-ink-3 tabular-nums">{formatTime(event.start_at)}</span>
        )}
        <span className="min-w-0 flex-1 truncate">{event.title}</span>
      </button>
    </EventDetails>
  );
}
