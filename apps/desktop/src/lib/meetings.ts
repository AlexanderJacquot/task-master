// Scribe meetings (ADR 025): pure helpers for the meetings list, the meeting page and
// the calendar. Meetings live in the store like other entities.

import type { Meeting, MeetingChange, MeetingState } from "./types";

export const MINUTE = 60_000;
/** A new meeting lasts this long unless changed. */
export const DEFAULT_MEETING_MIN = 30;

/** Most participants a meeting may list (the core's `MAX_PARTICIPANTS`). */
export const MAX_PARTICIPANTS = 100;

/** Where a meeting stands now, for labels and filters. */
export type MeetingPhase = "upcoming" | "now" | "past";

export function meetingPhase(m: Meeting, now: number): MeetingPhase {
  if (m.state === "recording") return "now";
  if (m.started_at > now) return "upcoming";
  if (m.ended_at === null || m.ended_at > now) return "now";
  return "past";
}

const STATE_LABEL: Record<MeetingState, string> = {
  scheduled: "Scheduled",
  held: "Held",
  recording: "Recording",
  processing: "Transcribing",
  review: "Transcript to check",
  validated: "Transcript checked",
  failed: "Failed",
};

/** A short label of where the meeting is. A scheduled meeting that is over reads "Held". */
export function meetingLabel(m: Meeting, now: number): string {
  const phase = meetingPhase(m, now);
  if (m.state === "scheduled" || m.state === "held") {
    if (phase === "now") return "In progress";
    if (phase === "upcoming") return "Upcoming";
    return "Held";
  }
  return STATE_LABEL[m.state];
}

/** The next quarter hour at or after `now`, as Unix ms. */
export function nextQuarter(now: number): number {
  const q = 15 * MINUTE;
  return Math.ceil(now / q) * q;
}

/** Start and end of a meeting started now (to the minute) or planned at the next quarter. */
export function defaultTimes(
  now: number,
  startNow: boolean,
): { started_at: number; ended_at: number } {
  const started_at = startNow ? Math.floor(now / MINUTE) * MINUTE : nextQuarter(now);
  return { started_at, ended_at: started_at + DEFAULT_MEETING_MIN * MINUTE };
}

/** Names tidied as the core does: spaces collapsed, blanks and repeats (any case) dropped. */
export function cleanParticipants(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.split(/\s+/).filter(Boolean).join(" ");
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.slice(0, MAX_PARTICIPANTS);
}

/**
 * Names used in earlier meetings, most used first (then most recent), without those
 * already listed, matching `query` anywhere in the name (any case).
 */
export function participantSuggestions(
  meetings: Meeting[],
  query: string,
  exclude: string[] = [],
  limit = 8,
): string[] {
  const skip = new Set(exclude.map((n) => n.toLowerCase()));
  const q = query.trim().toLowerCase();
  const stats = new Map<string, { name: string; count: number; last: number }>();
  for (const m of meetings) {
    for (const name of m.participants) {
      const key = name.toLowerCase();
      if (skip.has(key) || (q && !key.includes(q))) continue;
      const s = stats.get(key);
      if (s) {
        s.count += 1;
        if (m.started_at > s.last) {
          s.last = m.started_at;
          s.name = name;
        }
      } else stats.set(key, { name, count: 1, last: m.started_at });
    }
  }
  return [...stats.values()]
    .sort((a, b) => b.count - a.count || b.last - a.last || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((s) => s.name);
}

export interface MeetingFilter {
  /** A project id, `"none"` for meetings without one, or `""` for all. */
  project: string;
  /** Words matched against the title, participants and notes. */
  text: string;
}

export function filterMeetings(meetings: Meeting[], f: MeetingFilter): Meeting[] {
  const words = f.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return meetings.filter((m) => {
    if (f.project === "none" ? m.project_id !== null : f.project && m.project_id !== f.project)
      return false;
    if (!words.length) return true;
    const hay = `${m.title}\n${m.participants.join("\n")}\n${m.notes}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Upcoming and ongoing meetings soonest first, then past ones newest first. */
export function sortMeetings(
  meetings: Meeting[],
  now: number,
): {
  upcoming: Meeting[];
  past: Meeting[];
} {
  const upcoming: Meeting[] = [];
  const past: Meeting[] = [];
  for (const m of meetings) (meetingPhase(m, now) === "past" ? past : upcoming).push(m);
  upcoming.sort((a, b) => a.started_at - b.started_at || (a.id < b.id ? -1 : 1));
  past.sort((a, b) => b.started_at - a.started_at || (a.id < b.id ? 1 : -1));
  return { upcoming, past };
}

/** Meetings linked to a project, an epic or a task, newest first. */
export function meetingsLinkedTo(
  meetings: Meeting[],
  link: { project?: string; epic?: string; task?: string },
): Meeting[] {
  return meetings
    .filter(
      (m) =>
        (link.project !== undefined && m.project_id === link.project) ||
        (link.epic !== undefined && m.epic_id === link.epic) ||
        (link.task !== undefined && m.task_id === link.task),
    )
    .sort((a, b) => b.started_at - a.started_at);
}

/** A meeting with `changes` applied, as the core would store it (optimistic copy). */
export function applyMeetingChanges(m: Meeting, changes: MeetingChange[], now: number): Meeting {
  const next: Meeting = { ...m, updated_at: now };
  for (const c of changes) {
    if ("title" in c && c.title !== undefined) next.title = c.title.trim();
    else if ("started_at" in c && c.started_at !== undefined) next.started_at = c.started_at;
    else if ("ended_at" in c) next.ended_at = c.ended_at ?? null;
    else if ("project_id" in c) next.project_id = c.project_id ?? null;
    else if ("epic_id" in c) next.epic_id = c.epic_id ?? null;
    else if ("task_id" in c) next.task_id = c.task_id ?? null;
    else if ("state" in c && c.state !== undefined) {
      next.state = c.state;
      next.validated_at = c.state === "validated" ? (m.validated_at ?? now) : null;
    } else if ("participants" in c && c.participants !== undefined)
      next.participants = cleanParticipants(c.participants);
    else if ("notes" in c && c.notes !== undefined) next.notes = c.notes;
    else if ("summary" in c) next.summary = c.summary?.trim() || null;
    else if ("show_as" in c && c.show_as !== undefined) next.show_as = c.show_as;
    else if ("private" in c && c.private !== undefined) next.private = c.private;
    else if ("speaker_name" in c && c.speaker_name) {
      const { speaker, name } = c.speaker_name;
      const speakers = { ...next.speakers };
      const clean = name?.trim();
      if (clean) speakers[speaker] = clean;
      else delete speakers[speaker];
      next.speakers = speakers;
    }
  }
  return next;
}

/** `HH:MM` local of a Unix ms time, for `<input type="time">`. */
export function timeValue(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** `ms` moved to the local time `hhmm` on the same day; null when `hhmm` is not a time. */
export function withTime(ms: number, hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;
  const [h, m] = [Number(match[1]), Number(match[2])];
  if (h > 23 || m > 59) return null;
  const d = new Date(ms);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** `ms` moved to the local date `iso` (YYYY-MM-DD), keeping its time of day. */
export function withDate(ms: number, iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const d = new Date(ms);
  d.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return d.getTime();
}

/** New start and end for a meeting moved to start at `started_at`, keeping its length. */
export function moveStart(m: Meeting, started_at: number): MeetingChange[] {
  const length = m.ended_at === null ? null : m.ended_at - m.started_at;
  return length === null ? [{ started_at }] : [{ started_at }, { ended_at: started_at + length }];
}

/** The task a "Send to Claude" session on a meeting works on. */
export function followUpTitle(m: Meeting): string {
  return `Follow up: ${m.title.trim() || "meeting"}`;
}

/**
 * What a "Send to Claude" session on a meeting is asked (editable before it starts): read
 * the meeting with its transcript, write the summary, and create the tasks it calls for in
 * the meeting's project. Tasks are the user's own, since the user asked for them here.
 */
export function followUpPrompt(m: Meeting, project: { id: string; name: string } | null): string {
  const where = project
    ? `in the project ${project.name} (project_id \`${project.id}\`)`
    : "in the Inbox (no project)";
  return [
    `Follow up the meeting "${m.title.trim() || "meeting"}" (meeting_id \`${m.id}\`).`,
    "",
    `1. Read it with get_meeting (meeting_id \`${m.id}\`, transcript: true): notes, participants and what was said.`,
    "2. Write a short summary with set_meeting_summary: the decisions, the open questions, and the action items with who takes each.",
    `3. For each action item, create a task ${where} with create_task (owner me, top_level true): a clear title, who asked and who does it, and the meeting in the description. Search first and skip what already has a task.`,
    "4. Finish with complete_session, listing the tasks you created.",
    "",
    "If creating my own tasks is refused, create them as agent tasks instead and say so.",
  ].join("\n");
}
