// Scribe (ADR 025): the meetings, upcoming first then past ones newest first, with a
// project filter and a search over titles, participants and notes. "Start meeting" opens
// a meeting that begins now; "Plan a meeting" one at the next quarter hour.

import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { PlayIcon, AddIcon as Plus, ScribeIcon } from "../../components/TaskIcons";
import { Button, cx, FOCUS, INPUT, Select } from "../../components/ui";
import { formatRange } from "../../lib/calendar";
import {
  filterMeetings,
  type MeetingFilter,
  meetingLabel,
  meetingPhase,
  sortMeetings,
} from "../../lib/meetings";
import type { Meeting } from "../../lib/types";
import { useStoreState } from "../../store/context";
import { useNow } from "../calendar/TimeGrid";
import { ProjectMark } from "../organize/ProjectMark";
import { dayLabel, useNewMeeting } from "./newMeeting";

const ROW_HEIGHT = 60;
const HEADER_HEIGHT = 40;

type Row = { kind: "header"; label: string; count: number } | { kind: "meeting"; meeting: Meeting };

export function MeetingRow({ meeting, now }: { meeting: Meeting; now: number }) {
  const navigate = useNavigate();
  const project = useStoreState((s) =>
    meeting.project_id ? s.projects[meeting.project_id] : undefined,
  );
  const files = useStoreState(
    (s) => Object.values(s.attachments).filter((a) => a.meeting_id === meeting.id).length,
  );
  const phase = meetingPhase(meeting, now);
  return (
    <button
      type="button"
      onClick={() =>
        void navigate({
          to: "/meeting/$meetingId",
          params: { meetingId: meeting.id },
          search: {},
        })
      }
      className={cx(
        "flex h-full w-full items-center gap-4 rounded-lg px-3 text-left hover:bg-hover",
        FOCUS,
      )}
    >
      <span className="w-28 shrink-0 text-[12.5px] text-ink-3 tabular-nums">
        <span className="block">{dayLabel(meeting.started_at)}</span>
        <span className="block">
          {meeting.ended_at === null
            ? new Date(meeting.started_at).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })
            : formatRange(meeting.started_at, meeting.ended_at)}
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14.5px] text-ink">{meeting.title}</span>
        <span className="truncate text-[12.5px] text-ink-3">
          {meeting.participants.length ? meeting.participants.join(", ") : "No participants yet"}
          {files > 0 && ` · ${files} file${files === 1 ? "" : "s"}`}
        </span>
      </span>
      {project && (
        <span className="flex max-w-44 shrink-0 items-center gap-1.5 truncate text-[12.5px] text-ink-2">
          <ProjectMark project={project} />
          <span className="truncate">{project.name}</span>
        </span>
      )}
      <span
        className={cx(
          "shrink-0 rounded-full px-2 py-0.5 text-[11.5px]",
          phase === "now" ? "bg-accent/15 text-accent" : "bg-hover text-ink-3",
        )}
      >
        {meetingLabel(meeting, now)}
      </span>
    </button>
  );
}

export function ScribePage() {
  const meetings = useStoreState((s) => s.meetings);
  const projects = useStoreState((s) => s.projects);
  const now = useNow();
  const newMeeting = useNewMeeting();
  const [filter, setFilter] = useState<MeetingFilter>({ project: "", text: "" });
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    const { upcoming, past } = sortMeetings(filterMeetings(Object.values(meetings), filter), now);
    const out: Row[] = [];
    if (upcoming.length) {
      out.push({ kind: "header", label: "Upcoming and now", count: upcoming.length });
      for (const m of upcoming) out.push({ kind: "meeting", meeting: m });
    }
    if (past.length) {
      out.push({ kind: "header", label: "Past", count: past.length });
      for (const m of past) out.push({ kind: "meeting", meeting: m });
    }
    return out;
  }, [meetings, filter, now]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
    getItemKey: (i) => {
      const row = rows[i];
      return !row ? i : row.kind === "header" ? `h:${row.label}` : row.meeting.id;
    },
  });

  const projectOptions = [
    { value: "", label: "All projects" },
    { value: "none", label: "No project" },
    ...Object.values(projects)
      .filter((p) => p.archived_at === null)
      .sort((a, b) => (a.rank < b.rank ? -1 : 1))
      .map((p) => ({ value: p.id, label: p.name, icon: <ProjectMark project={p} /> })),
  ];
  const total = Object.keys(meetings).length;

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-10 py-7">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 font-display text-[34px] font-normal tracking-wide">
            <ScribeIcon size={28} className="text-rubric" />
            Scribe
          </h1>
          <p className="mt-1 text-sm text-ink-3">
            Your meetings: who was there, what was said and decided, and what it was about.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void newMeeting(false)}>
            <Plus size={14} /> Plan a meeting
          </Button>
          <Button variant="primary" onClick={() => void newMeeting(true)}>
            <PlayIcon size={14} /> Start meeting
          </Button>
        </div>
      </header>
      {total > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            type="search"
            aria-label="Search meetings"
            placeholder="Search titles, people and notes"
            value={filter.text}
            onChange={(e) => setFilter({ ...filter, text: e.currentTarget.value })}
            className={cx(INPUT, "w-72 py-1 text-[13.5px]")}
          />
          <Select
            aria-label="Project"
            value={filter.project}
            onValueChange={(project) => setFilter({ ...filter, project })}
            options={projectOptions}
          />
        </div>
      )}
      {total === 0 ? (
        <div className="mt-16 flex flex-col items-center gap-2 text-center text-ink-3">
          <ScribeIcon size={40} className="text-ink-3" />
          <p className="text-[15px] text-ink-2">No meetings yet.</p>
          <p className="max-w-md text-sm">
            Start one when a call begins, or plan one ahead: it shows on your calendar, and you can
            link it to a project, an epic or a task.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-8 text-sm text-ink-3">No meetings match.</p>
      ) : (
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <div
                key={item.key}
                className="absolute inset-x-0"
                style={{ top: item.start, height: item.size }}
              >
                {row.kind === "header" ? (
                  <h2 className="flex h-full items-end gap-2 px-3 pb-1.5 font-display text-[15px] tracking-wide text-rubric">
                    {row.label}
                    <span className="text-[12px] text-ink-3">{row.count}</span>
                  </h2>
                ) : (
                  <MeetingRow meeting={row.meeting} now={now} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
