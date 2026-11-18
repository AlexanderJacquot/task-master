// Transcripts (Scribe, M20), pure: speaker names, the order of a meeting's lines, edits
// shown before the core confirms them, and when the audio goes.

import type { SegmentChange, TranscriptSegment } from "./types";

export const DAY = 24 * 60 * 60 * 1000;
/** The meeting page warns this long before the audio is deleted. */
export const WARN_BEFORE = 2 * DAY;

/** "Me", the name given to a voice, or "Speaker 2". */
export function speakerLabel(key: string, names: Record<string, string>): string {
  const named = names[key]?.trim();
  if (named) return named;
  if (key === "me") return "Me";
  const n = /^s(\d+)$/.exec(key)?.[1];
  return n ? `Speaker ${n}` : key;
}

/** Me first, then s1, s2, … by number. */
export function compareSpeakers(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "me") return -1;
  if (b === "me") return 1;
  const num = (k: string) => Number(/^s(\d+)$/.exec(k)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return num(a) - num(b) || a.localeCompare(b);
}

/** A meeting's lines in time order. */
export function transcriptOf(
  segments: Record<string, TranscriptSegment>,
  meetingId: string,
): TranscriptSegment[] {
  return Object.values(segments)
    .filter((s) => s.meeting_id === meetingId)
    .sort((a, b) => a.start_ms - b.start_ms || (a.id < b.id ? -1 : 1));
}

export interface SpeakerStat {
  key: string;
  lines: number;
  /** Time spoken. */
  ms: number;
}

/** Each speaker of a transcript with how much they said, me first. */
export function speakerStats(lines: TranscriptSegment[]): SpeakerStat[] {
  const stats = new Map<string, SpeakerStat>();
  for (const s of lines) {
    const stat = stats.get(s.speaker) ?? { key: s.speaker, lines: 0, ms: 0 };
    stat.lines += 1;
    stat.ms += Math.max(0, s.end_ms - s.start_ms);
    stats.set(s.speaker, stat);
  }
  return [...stats.values()].sort((a, b) => compareSpeakers(a.key, b.key));
}

/** A speaker key not used yet ("s4" after s1–s3), for "a new voice". */
export function nextSpeaker(keys: string[]): string {
  let max = 0;
  for (const k of keys) {
    const n = Number(/^s(\d+)$/.exec(k)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return `s${max + 1}`;
}

export function applySegmentChanges(
  seg: TranscriptSegment,
  changes: SegmentChange[],
  now: number,
): TranscriptSegment {
  const next = { ...seg, updated_at: now };
  for (const c of changes) {
    if ("text" in c && c.text !== undefined) {
      next.text = c.text.trim();
      next.edited = true;
    } else if ("speaker" in c && c.speaker !== undefined) next.speaker = c.speaker;
  }
  return next;
}

/** The two parts of a split at character `at`, with the time shared in proportion (as the
 * core does); null when either part would be empty. */
export function splitSegment(
  seg: TranscriptSegment,
  at: number,
  newId: string,
  now: number,
): [TranscriptSegment, TranscriptSegment] | null {
  const chars = [...seg.text];
  const first = chars.slice(0, at).join("").trim();
  const second = chars.slice(at).join("").trim();
  if (!first || !second) return null;
  const cut = seg.start_ms + Math.trunc(((seg.end_ms - seg.start_ms) * at) / chars.length);
  return [
    { ...seg, text: first, end_ms: cut, edited: true, updated_at: now },
    {
      ...seg,
      id: newId,
      text: second,
      start_ms: cut,
      edited: true,
      created_at: now,
      updated_at: now,
    },
  ];
}

/** The segment playing at `ms`: the last one started by then. */
export function segmentAt(lines: TranscriptSegment[], ms: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = lines[mid];
    if (line && line.start_ms <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** When the audio goes, for the meeting page: null while it is kept. */
export function purgeNotice(
  purgeAt: number | null,
  now: number,
): { at: number; soon: boolean } | null {
  if (purgeAt === null) return null;
  return { at: purgeAt, soon: purgeAt - now <= WARN_BEFORE };
}

/** Links the meeting's player and its transcript: a line asks the player to play from its
 * start, and the player tells the transcript where it is. */
export interface PlayerControl {
  /** The player registers how to play from `ms`; returns the unregister function. */
  attach(play: (ms: number) => void): () => void;
  /** A player is attached (there is audio to play). */
  attached(): boolean;
  /** Called when a player attaches or goes (for `useSyncExternalStore`). */
  onAttach(listener: () => void): () => void;
  /** Plays from `ms`; false when no player is attached (no audio here). */
  play(ms: number): boolean;
  /** The player's position, a few times a second while it plays. */
  publish(ms: number): void;
  subscribe(listener: (ms: number) => void): () => void;
}

export function createPlayerControl(): PlayerControl {
  let player: ((ms: number) => void) | null = null;
  const listeners = new Set<(ms: number) => void>();
  const attachListeners = new Set<() => void>();
  const attachChanged = () => {
    for (const l of attachListeners) l();
  };
  return {
    attach(play) {
      player = play;
      attachChanged();
      return () => {
        if (player !== play) return;
        player = null;
        attachChanged();
      };
    },
    attached: () => player !== null,
    onAttach(listener) {
      attachListeners.add(listener);
      return () => {
        attachListeners.delete(listener);
      };
    },
    play(ms) {
      if (!player) return false;
      player(ms);
      return true;
    },
    publish(ms) {
      for (const l of listeners) l(ms);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A search snippet without its match markers (`[word]` → `word`). */
export function plainSnippet(snippet: string): string {
  return snippet.replace(/[[\]]/g, "");
}
