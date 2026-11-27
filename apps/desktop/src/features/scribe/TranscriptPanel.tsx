// A meeting's transcript (Scribe, M20): who said what, checked by hand. A line's time plays
// the recording from there; its speaker can be changed, its text corrected, split or
// deleted; a voice can be named or merged into another. "Validate" marks the transcript
// checked, which starts the audio's retention period.

import { useVirtualizer } from "@tanstack/react-virtual";
import { Scissors } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DeleteIcon as Trash2 } from "../../components/TaskIcons";
import {
  Button,
  cx,
  IconButton,
  INPUT,
  InlineInput,
  SectionLabel,
  Select,
} from "../../components/ui";
import { formatClock } from "../../lib/scribe";
import {
  deduceSpeaker,
  nameChoices,
  nextSpeaker,
  type PlayerControl,
  segmentAt,
  speakerLabel,
  speakerStats,
  transcriptOf,
  voiceNamed,
} from "../../lib/transcript";
import type { Meeting, TranscriptSegment } from "../../lib/types";
import {
  deleteSegment,
  nameSpeaker,
  reassignSpeaker,
  splitTranscriptSegment,
  updateMeeting,
  updateSegment,
} from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";

const NEW_VOICE = "__new__";
const SOMEONE_ELSE = "__other__";

/**
 * A voice's name: picked from the meeting's participants, or typed ("Someone else…", or
 * when the meeting lists nobody). Picking a name another voice has merges the two.
 */
function SpeakerName({
  meeting,
  speaker,
  keys,
}: {
  meeting: Meeting;
  speaker: string;
  keys: string[];
}) {
  const store = useTaskStore();
  const current = meeting.speakers[speaker]?.trim() ?? "";
  const [typing, setTyping] = useState(false);
  const choices = nameChoices(meeting.participants, current);
  const commit = (raw: string) => {
    setTyping(false);
    const name = raw.trim();
    if (name === current) return;
    const other = voiceNamed(name, speaker, keys, meeting.speakers);
    if (other) void reassignSpeaker(store, meeting.id, speaker, other);
    else void nameSpeaker(store, meeting.id, speaker, name);
  };
  if (typing || choices.length === 0)
    return (
      <InlineInput
        key={current}
        initial={current}
        autoFocus={typing}
        placeholder={speakerLabel(speaker, {})}
        onCommit={commit}
        onCancel={() => setTyping(false)}
        className="w-44"
      />
    );
  return (
    <Select
      aria-label={`Name of ${speakerLabel(speaker, {})}`}
      value={current}
      onValueChange={(v) => (v === SOMEONE_ELSE ? setTyping(true) : commit(v))}
      options={[
        { value: "", label: speakerLabel(speaker, {}) },
        ...choices.map((name) => {
          const other = voiceNamed(name, speaker, keys, meeting.speakers);
          return {
            value: name,
            label: other ? `${name} (same voice as ${speakerLabel(other, {})})` : name,
          };
        }),
        { value: SOMEONE_ELSE, label: "Someone else…" },
      ]}
      className={cx("w-44 text-[13px]", !current && "text-ink-3")}
    />
  );
}

/** The voices of the transcript: a name for each, and "is the same as" to merge two. */
function Speakers({ meeting, lines }: { meeting: Meeting; lines: TranscriptSegment[] }) {
  const store = useTaskStore();
  const stats = useMemo(() => speakerStats(lines), [lines]);
  if (stats.length === 0) return null;
  const keys = stats.map((s) => s.key);
  const guess = deduceSpeaker(keys, meeting.speakers, meeting.participants);
  return (
    <ul aria-label="Speakers" className="flex flex-col gap-1.5">
      {stats.map((s) => {
        const others = stats.filter((o) => o.key !== s.key);
        return (
          <li key={s.key} className="flex flex-wrap items-center gap-2 text-[13px]">
            <SpeakerName meeting={meeting} speaker={s.key} keys={keys} />
            {guess?.key === s.key && (
              <Button
                size="sm"
                variant="ghost"
                title="Every other participant has a voice"
                onClick={() => void nameSpeaker(store, meeting.id, s.key, guess.name)}
              >
                {guess.name}?
              </Button>
            )}
            <span className="text-[12px] text-ink-3 tabular-nums">
              {formatClock(s.ms)} · {s.lines} line{s.lines === 1 ? "" : "s"}
            </span>
            {others.length > 0 && (
              <Select
                aria-label={`Merge ${speakerLabel(s.key, meeting.speakers)} into`}
                value=""
                onValueChange={(to) => to && void reassignSpeaker(store, meeting.id, s.key, to)}
                options={[
                  { value: "", label: "Same voice as…" },
                  ...others.map((o) => ({
                    value: o.key,
                    label: speakerLabel(o.key, meeting.speakers),
                  })),
                ]}
                className="text-[12.5px] text-ink-3"
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One line: time (plays from there), speaker, text (click to correct). */
function Line({
  line,
  meeting,
  speakers,
  current,
  onPlay,
}: {
  line: TranscriptSegment;
  meeting: Meeting;
  speakers: string[];
  current: boolean;
  onPlay: ((ms: number) => void) | null;
}) {
  const store = useTaskStore();
  const [editing, setEditing] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const fresh = nextSpeaker(speakers);
  const options = [
    ...speakers.map((k) => ({ value: k, label: speakerLabel(k, meeting.speakers) })),
    { value: NEW_VOICE, label: "Another voice" },
  ];
  const commit = (text: string) => {
    setEditing(false);
    const clean = text.trim();
    if (!clean) void deleteSegment(store, line.id);
    else if (clean !== line.text) void updateSegment(store, line.id, [{ text: clean }]);
  };
  const split = () => {
    const el = area.current;
    if (!el) return;
    // The cut is counted in characters of the saved text, as the core counts it.
    const typed = el.value;
    if (typed.trim() !== line.text) commit(typed);
    const at = [...typed.slice(0, el.selectionStart)].length;
    setEditing(false);
    void splitTranscriptSegment(store, line.id, at);
  };

  return (
    <div
      data-line={line.id}
      aria-current={current || undefined}
      className={cx(
        "group/line flex gap-3 rounded-lg px-2 py-1.5",
        current ? "bg-selected" : "hover:bg-hover/60",
      )}
    >
      <div className="flex w-36 shrink-0 flex-col items-start gap-0.5">
        <button
          type="button"
          disabled={!onPlay}
          onClick={() => onPlay?.(line.start_ms)}
          title={onPlay ? "Play from here" : "No audio on this device"}
          className="font-mono text-[12px] text-ink-3 tabular-nums hover:text-accent disabled:hover:text-ink-3"
        >
          {formatClock(line.start_ms)}
        </button>
        <Select
          aria-label="Speaker"
          value={line.speaker}
          onValueChange={(k) =>
            void updateSegment(store, line.id, [{ speaker: k === NEW_VOICE ? fresh : k }])
          }
          options={options}
          className={cx(
            "max-w-full text-[12.5px]",
            line.speaker === "me" ? "text-accent" : "text-rubric",
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-col gap-1">
            <textarea
              ref={(el) => {
                area.current = el;
                if (el && document.activeElement !== el) el.focus();
              }}
              aria-label="Line text"
              defaultValue={line.text}
              rows={Math.max(2, Math.ceil(line.text.length / 70))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commit(e.currentTarget.value);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
              onBlur={(e) => {
                // A click on "Split here" keeps the cursor where it was.
                if ((e.relatedTarget as HTMLElement | null)?.dataset.split) return;
                commit(e.currentTarget.value);
              }}
              className={cx(INPUT, "resize-y py-1 text-[14px] leading-relaxed")}
            />
            <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
              <Button size="sm" variant="ghost" data-split onClick={split}>
                <Scissors size={13} /> Split here
              </Button>
              Enter saves, Escape cancels; Split cuts the line at the cursor.
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Click to correct"
            className="w-full cursor-text text-left text-[14px] leading-relaxed text-ink"
          >
            {line.text}
            {line.edited && <span className="ml-1.5 text-[11px] text-ink-3">(corrected)</span>}
          </button>
        )}
      </div>
      <IconButton
        label="Delete the line"
        onClick={() => void deleteSegment(store, line.id)}
        className="self-start opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100 hover:text-danger"
      >
        <Trash2 size={13} />
      </IconButton>
    </div>
  );
}

export function TranscriptPanel({
  meeting,
  control,
  line,
}: {
  meeting: Meeting;
  control: PlayerControl;
  /** A line to show first (a search result). */
  line?: string;
}) {
  const store = useTaskStore();
  const segments = useStoreState((s) => s.transcript_segments);
  const lines = useMemo(() => transcriptOf(segments, meeting.id), [segments, meeting.id]);
  const speakers = useMemo(() => speakerStats(lines).map((s) => s.key), [lines]);
  const [position, setPosition] = useState<number | null>(null);
  const canPlay = useSyncExternalStore(control.onAttach, control.attached);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Read when shown and again after each new transcription.
  // biome-ignore lint/correctness/useExhaustiveDependencies: transcribed_at marks a new transcript.
  useEffect(() => {
    void store.getState().loadTranscript(meeting.id);
  }, [store, meeting.id, meeting.transcribed_at]);
  useEffect(() => control.subscribe(setPosition), [control]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    getItemKey: (i) => lines[i]?.id ?? i,
    overscan: 8,
  });

  const playing = position === null ? -1 : segmentAt(lines, position);
  // Follows the recording while it plays.
  useEffect(() => {
    if (playing >= 0) virtualizer.scrollToIndex(playing, { align: "auto" });
  }, [playing, virtualizer]);
  // Opens on the searched line.
  const shown = useRef(false);
  useEffect(() => {
    if (!line || shown.current) return;
    const i = lines.findIndex((l) => l.id === line);
    if (i < 0) return;
    shown.current = true;
    virtualizer.scrollToIndex(i, { align: "center" });
    requestAnimationFrame(() =>
      document.getElementById("meeting-transcript")?.scrollIntoView?.({ block: "start" }),
    );
  }, [line, lines, virtualizer]);

  if (meeting.transcribed_at === null && lines.length === 0) return null;
  const validated = meeting.state === "validated";
  const inReview = meeting.state === "review";

  return (
    <section id="meeting-transcript" aria-label="Transcript" className="flex flex-col gap-3 pl-10">
      <div className="flex flex-wrap items-center gap-3">
        <SectionLabel>Transcript</SectionLabel>
        {validated && (
          <span className="rounded-full bg-hover px-2 py-0.5 text-[12px] text-ink-2">Checked</span>
        )}
        {inReview && (
          <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[12px] text-accent">
            To check
          </span>
        )}
        <span className="flex-1" />
        {inReview && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void updateMeeting(store, meeting.id, [{ state: "validated" }])}
          >
            Validate
          </Button>
        )}
        {validated && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void updateMeeting(store, meeting.id, [{ state: "review" }])}
          >
            Check again
          </Button>
        )}
      </div>
      {inReview && (
        <p className="text-[12.5px] text-ink-3">
          Name the voices from the participants (the last one follows once the others are named),
          fix what was misheard, then Validate. Click a time to hear that line.
        </p>
      )}
      <Speakers meeting={meeting} lines={lines} />
      {lines.length === 0 ? (
        <p className="text-[13px] text-ink-3">Nothing was said, or every line was deleted.</p>
      ) : (
        <div ref={scrollRef} className="max-h-[70vh] overflow-y-auto rounded-lg border border-line">
          <ul
            aria-label="Transcript lines"
            className="relative"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const seg = lines[item.index];
              if (!seg) return null;
              return (
                <li
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 px-1"
                  style={{ top: item.start }}
                >
                  <Line
                    line={seg}
                    meeting={meeting}
                    speakers={speakers}
                    current={item.index === playing || seg.id === line}
                    onPlay={canPlay ? (ms) => control.play(ms) : null}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
