// Meetings on the calendar (ADR 025): their own kind of item, not time blocks. Drawn solid
// in their project's color with the Scribe mark; a click opens the meeting. Tentative and
// free meetings are lighter with a broken edge, private ones carry a padlock (ADR 038).

import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { LockIcon, ScribeIcon } from "../../components/TaskIcons";
import { cx, FOCUS } from "../../components/ui";
import { formatRange, formatTime, HOUR_PX, type Placed, type Span } from "../../lib/calendar";
import { availabilityNote, edgeStyle, fillShare } from "../../lib/showAs";
import type { Meeting } from "../../lib/types";
import { useStoreState } from "../../store/context";

export interface MeetingSpan extends Span {
  meeting: Meeting;
}

/** A meeting still going on without an end is drawn up to now, at least 15 minutes. */
export function meetingSpans(meetings: Meeting[], now: number): MeetingSpan[] {
  return meetings.map((meeting) => ({
    id: `meeting:${meeting.id}`,
    start_at: meeting.started_at,
    end_at: meeting.ended_at ?? Math.max(now, meeting.started_at + 15 * 60_000),
    meeting,
  }));
}

/** The store's meetings as calendar spans. */
export function useMeetingSpans(now: number): MeetingSpan[] {
  const meetings = useStoreState((s) => s.meetings);
  return useMemo(() => meetingSpans(Object.values(meetings), now), [meetings, now]);
}

function useMeetingColor(meeting: Meeting): string {
  const color = useStoreState((s) =>
    meeting.project_id ? s.projects[meeting.project_id]?.color : null,
  );
  return color ?? "var(--tm-accent)";
}

/** "meeting" or "meeting, tentative, private", for labels. */
function kindLabel(meeting: Meeting): string {
  const note = availabilityNote(meeting.show_as, meeting.private);
  return note ? `meeting, ${note}` : "meeting";
}

function PrivateMark() {
  return <LockIcon size={11} className="shrink-0 text-ink-3" aria-label="Private" />;
}

function useOpenMeeting(id: string) {
  const navigate = useNavigate();
  return () => void navigate({ to: "/meeting/$meetingId", params: { meetingId: id }, search: {} });
}

/** A meeting in a day column. */
export function MeetingView({ placed }: { placed: Placed<MeetingSpan> }) {
  const { meeting, start_at, end_at } = placed.item;
  const color = useMeetingColor(meeting);
  const open = useOpenMeeting(meeting.id);
  const top = (placed.startMin / 60) * HOUR_PX;
  const height = Math.max(((placed.endMin - placed.startMin) / 60) * HOUR_PX - 2, 16);
  return (
    <button
      type="button"
      data-testid="calendar-meeting"
      aria-label={`${meeting.title}, ${formatRange(start_at, end_at)} (${kindLabel(meeting)})`}
      // Not a place to draw a new block.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={open}
      className={cx(
        "absolute flex flex-col items-stretch overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-left text-[12px] leading-4 text-ink",
        FOCUS,
      )}
      style={{
        top,
        height,
        left: `calc(${(placed.column / placed.columns) * 100}% + 2px)`,
        width: `calc(${100 / placed.columns}% - 4px)`,
        borderLeftColor: color,
        borderLeftStyle: edgeStyle(meeting.show_as, "solid"),
        background: `color-mix(in srgb, ${color} ${fillShare(meeting.show_as, 22)}%, var(--tm-raised))`,
      }}
    >
      <span className="flex min-w-0 items-center gap-1 font-medium">
        <ScribeIcon size={12} className="shrink-0" aria-hidden />
        <span className="truncate">{meeting.title}</span>
        {meeting.private && <PrivateMark />}
      </span>
      {height >= 34 && (
        <span className="truncate text-[11px] text-ink-2 tabular-nums">
          {formatRange(start_at, end_at)}
          {meeting.participants.length > 0 && ` · ${meeting.participants.join(", ")}`}
        </span>
      )}
    </button>
  );
}

/** A meeting in a month cell. */
export function MeetingChip({ meeting }: { meeting: Meeting }) {
  const color = useMeetingColor(meeting);
  const open = useOpenMeeting(meeting.id);
  return (
    <button
      type="button"
      data-testid="calendar-meeting"
      title={meeting.title}
      aria-label={`${meeting.title}, ${formatTime(meeting.started_at)} (${kindLabel(meeting)})`}
      onClick={open}
      className={cx(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md border-l-[3px] px-1.5 text-left text-[12px] leading-[18px] text-ink hover:bg-hover",
        FOCUS,
      )}
      style={{
        borderLeftColor: color,
        borderLeftStyle: edgeStyle(meeting.show_as, "solid"),
        background: `color-mix(in srgb, ${color} ${fillShare(meeting.show_as, 14)}%, transparent)`,
      }}
    >
      <span className="shrink-0 text-ink-3 tabular-nums">{formatTime(meeting.started_at)}</span>
      <span className="min-w-0 flex-1 truncate">{meeting.title}</span>
      {meeting.private && <PrivateMark />}
    </button>
  );
}
