// Recording a meeting (Scribe, ADR 025, M19): the bar shown on every page while a meeting
// is recorded, and the meeting page's audio panel (record, stop, keep an interrupted
// recording, play it back, delete it).

import { Link } from "@tanstack/react-router";
import { Mic, Pause, Volume2, VolumeX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PlayIcon, StopIcon } from "../../components/TaskIcons";
import { Button, cx, IconButton, SectionLabel } from "../../components/ui";
import { formatSize } from "../../lib/attachments";
import {
  formatClock,
  formatDuration,
  type MeetingAudio,
  type ScribeSettings,
  type Step,
  type TrackedProgress,
  timeLeft,
  useScribe,
  useScribeApi,
  useScribeStore,
} from "../../lib/scribe";
import { type PlayerControl, purgeNotice } from "../../lib/transcript";
import type { Meeting } from "../../lib/types";
import { useStoreState } from "../../store/context";

/** A horizontal meter, 0 to 1. */
export function LevelMeter({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
      {label}
      <meter className="sr-only" aria-label={`${label} level`} min={0} max={100} value={pct} />
      <span aria-hidden className="relative h-1.5 w-16 overflow-hidden rounded-full bg-hover">
        <span
          className={cx(
            "absolute inset-y-0 left-0 rounded-full transition-[width] duration-100",
            pct > 92 ? "bg-danger" : "bg-accent",
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}

/** Seconds since `since`, updated every second. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, now - since);
}

function RecDot() {
  return (
    <span aria-hidden className="relative flex size-2.5">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger opacity-60" />
      <span className="relative inline-flex size-2.5 rounded-full bg-danger" />
    </span>
  );
}

/** Live levels and clock of the recording in progress. */
function LiveLevels({ startedAt }: { startedAt: number }) {
  const levels = useScribe((s) => s.levels);
  const live = useScribe((s) => s.live);
  const elapsed = useElapsed(startedAt);
  return (
    <>
      <span className="font-mono text-[13px] text-ink tabular-nums">{formatClock(elapsed)}</span>
      <LevelMeter label="You" value={levels?.mic ?? 0} />
      {live?.system && <LevelMeter label="Others" value={levels?.system ?? 0} />}
    </>
  );
}

/** On every page while a meeting is being recorded: what, how long, levels, Stop. */
export function RecordingBar() {
  const live = useScribe((s) => s.live);
  const busy = useScribe((s) => s.busy) ?? false;
  const scribe = useScribeStore();
  const meeting = useStoreState((s) => (live ? s.meetings[live.meeting_id] : undefined));
  if (!live || !scribe) return null;
  return (
    <div
      role="status"
      aria-label="Recording"
      className="relative z-20 flex flex-wrap items-center gap-3 border-b border-line bg-raised px-5 py-1.5 text-[13px]"
    >
      <RecDot />
      <span className="text-danger">Recording</span>
      <Link
        to="/meeting/$meetingId"
        params={{ meetingId: live.meeting_id }}
        search={{}}
        className="max-w-80 truncate text-ink hover:underline"
      >
        {meeting?.title ?? "Meeting"}
      </Link>
      <LiveLevels startedAt={live.started_at} />
      <span className="flex-1" />
      <Button size="sm" busy={busy} onClick={() => void scribe.getState().stop()}>
        <StopIcon size={13} /> Stop
      </Button>
    </div>
  );
}

/** Both tracks played together: one position, a mute per track. */
export function TrackPlayer({
  audio,
  url,
  control,
}: {
  audio: MeetingAudio;
  url: (path: string) => string;
  control?: PlayerControl;
}) {
  const refs = useRef<Record<string, HTMLAudioElement | null>>({});
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  // Why the audio cannot play (a blocked or unreadable file), instead of a silent button.
  const [error, setError] = useState<string | null>(null);
  const failed = (err: unknown) => {
    setPlaying(false);
    // Pausing before playback started is not a failure.
    if (err instanceof DOMException && err.name === "AbortError") return;
    setError(playbackError(err));
  };
  const duration = audio.duration_ms / 1000;
  const tracks = audio.tracks;
  const elements = () =>
    tracks.map((t) => refs.current[t.track]).filter((e): e is HTMLAudioElement => !!e);
  const lead = () => elements()[0];

  const toggle = () => {
    const all = elements();
    if (playing) {
      for (const e of all) e.pause();
      setPlaying(false);
      return;
    }
    const at = lead()?.currentTime ?? position;
    setError(null);
    for (const e of all) {
      e.currentTime = at;
      void e.play().catch(failed);
    }
    setPlaying(true);
  };
  const seek = (seconds: number) => {
    for (const e of elements()) e.currentTime = seconds;
    setPosition(seconds);
  };
  // The transcript plays a line from its start.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the elements are read through refs.
  useEffect(() => {
    if (!control) return;
    return control.attach((ms) => {
      const at = Math.max(0, ms / 1000);
      for (const e of elements()) {
        e.currentTime = at;
        void e.play().catch(failed);
      }
      setPosition(at);
      setPlaying(true);
    });
  }, [control, tracks]);
  // Keeps the second track on the first one's clock.
  const onTime = () => {
    const [first, ...rest] = elements();
    if (!first) return;
    setPosition(first.currentTime);
    control?.publish(first.currentTime * 1000);
    for (const e of rest) {
      if (Math.abs(e.currentTime - first.currentTime) > 0.15) e.currentTime = first.currentTime;
    }
  };
  const label = (track: string) => (track === "mic" ? "You" : "Others");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <IconButton label={playing ? "Pause" : "Play"} onClick={toggle}>
          {playing ? <Pause size={15} /> : <PlayIcon size={15} />}
        </IconButton>
        <input
          type="range"
          aria-label="Position"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          value={Math.min(position, duration)}
          onChange={(e) => seek(Number(e.currentTarget.value))}
          className="min-w-0 flex-1 accent-accent"
        />
        <span className="shrink-0 font-mono text-[12.5px] text-ink-3 tabular-nums">
          {formatClock(position * 1000)} / {formatClock(audio.duration_ms)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 pl-1 text-[12.5px] text-ink-3">
        {tracks.map((t) => (
          <button
            key={t.track}
            type="button"
            aria-pressed={!muted[t.track]}
            onClick={() => setMuted((m) => ({ ...m, [t.track]: !m[t.track] }))}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink"
          >
            {muted[t.track] ? <VolumeX size={13} /> : <Volume2 size={13} />}
            {label(t.track)}
          </button>
        ))}
      </div>
      {tracks.map((t, i) => (
        <audio
          key={t.track}
          ref={(e) => {
            refs.current[t.track] = e;
          }}
          src={url(t.path)}
          preload="metadata"
          muted={!!muted[t.track]}
          onTimeUpdate={i === 0 ? onTime : undefined}
          onEnded={i === 0 ? () => setPlaying(false) : undefined}
          onError={(e) => failed(e.currentTarget.error)}
        />
      ))}
      {error && (
        <p role="alert" className="pl-1 text-[12.5px] text-danger">
          The recording cannot be played: {error}
        </p>
      )}
    </div>
  );
}

/** A playback failure in words, from `play()`'s rejection or the element's `MediaError`. */
export function playbackError(err: unknown): string {
  // `play()` rejects with a DOMException (which also has a `code`), e.g. NotSupportedError.
  if (err instanceof DOMException) return err.message ? `${err.name}: ${err.message}` : err.name;
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const { code, message } = err as { code: number; message: string };
    // MediaError codes: 2 network (the file could not be fetched), 3 decode, 4 not supported.
    const what =
      code === 2
        ? "the file could not be read"
        : code === 3
          ? "the file could not be decoded"
          : code === 4
            ? "the file was refused or its format is not supported"
            : "playback failed";
    return message ? `${what} (${message})` : what;
  }
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

const STEP_LABEL: Record<Step, string> = {
  mic: "Transcribing your microphone",
  system: "Transcribing the computer's sound",
  speakers: "Telling the voices apart",
  merge: "Putting the transcript together",
};

/** Transcription of a recorded meeting: start it, follow it, retry it. */
function TranscribeRow({ meeting, audio }: { meeting: Meeting; audio: MeetingAudio }) {
  const scribe = useScribeStore();
  const available = useScribe((s) => s.transcription);
  const live = useScribe((s) => s.progress[meeting.id]);
  const now = useNow(live ? 5_000 : null);
  if (!scribe || !available || (audio.state !== "ready" && audio.state !== "encoding")) return null;
  const actions = scribe.getState();
  const job = audio.job;

  if (job && job.state !== "failed") {
    const step = live?.step ?? job.step;
    const fraction = live?.fraction ?? job.fraction ?? 0;
    const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    return (
      <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-ink-2">
        <span>
          {job.state === "queued" && !live
            ? "Waiting to be transcribed…"
            : `${step ? STEP_LABEL[step] : "Transcribing"}…`}
        </span>
        <progress
          aria-label="Transcription"
          max={100}
          value={pct}
          className="h-1.5 w-40 overflow-hidden rounded-full accent-accent"
        />
        <span className="text-ink-3 tabular-nums">{pct}%</span>
        {live && <Pace progress={live} now={now} />}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void actions.cancelProcess(meeting.id)}>
          Stop
        </Button>
      </div>
    );
  }
  if (job?.state === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
        <span role="alert" className="text-danger">
          The transcription failed{job.error ? `: ${job.error}` : "."}
        </span>
        <Button size="sm" onClick={() => void actions.process(meeting.id)}>
          Try again
        </Button>
      </div>
    );
  }
  const again = meeting.transcribed_at !== null;
  return (
    <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-ink-3">
      <Button
        size="sm"
        variant={again ? "ghost" : "primary"}
        onClick={() => void actions.process(meeting.id)}
      >
        {again ? "Transcribe again" : "Transcribe"}
      </Button>
      {again
        ? "Replaces the transcript and its corrections."
        : "On this device, with the model chosen in Settings → Scribe."}
    </div>
  );
}

/** The clock, every `every` ms while it is not null. */
function useNow(every: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (every === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

/** How long a transcription has run and, at its pace so far, how long it has left. */
function Pace({ progress, now }: { progress: TrackedProgress; now: number }) {
  const left = timeLeft(progress, now);
  return (
    <span className="text-ink-3 tabular-nums">
      {formatDuration(Math.max(0, now - progress.since.at))}
      {left !== null && ` · about ${formatDuration(left)} left`}
    </span>
  );
}

/** When the audio goes, once the transcript is made or checked. */
function PurgeNote({ at }: { at: number | null }) {
  const [now] = useState(() => Date.now());
  const notice = purgeNotice(at, now);
  if (!notice) return null;
  const day = new Date(notice.at).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return (
    <p
      className={cx(
        "text-[12.5px]",
        notice.soon ? "rounded-md bg-danger/10 px-2.5 py-1.5 text-danger" : "text-ink-3",
      )}
    >
      {notice.at <= now
        ? "The audio will be deleted shortly (Settings → Scribe sets how long it is kept)."
        : `The audio will be deleted on ${day}; the transcript stays.`}
    </p>
  );
}

/** The meeting page's audio: record, the live recording, an interrupted one, playback. */
export function RecordPanel({ meeting, control }: { meeting: Meeting; control?: PlayerControl }) {
  const scribe = useScribeStore();
  const api = useScribeApi();
  const support = useScribe((s) => s.support);
  const live = useScribe((s) => s.live);
  const busy = useScribe((s) => s.busy) ?? false;
  const error = useScribe((s) => s.error);
  const audio = useScribe((s) => s.audio[meeting.id]);
  const [settings, setSettings] = useState<ScribeSettings | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (scribe && audio === undefined) void scribe.getState().loadAudio(meeting.id);
  }, [scribe, audio, meeting.id]);
  useEffect(() => {
    if (!api) return;
    let gone = false;
    api
      .settings()
      .then((s) => !gone && setSettings(s))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [api]);

  const recordingHere = live?.meeting_id === meeting.id;
  const urlOf = useMemo(() => api?.url ?? ((p: string) => p), [api]);
  if (!scribe || !support) return null;
  const actions = scribe.getState();

  let body: React.ReactNode;
  if (recordingHere && live) {
    body = (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <RecDot />
          <span className="text-[13.5px] text-danger">Recording</span>
          <LiveLevels startedAt={live.started_at} />
          <span className="flex-1" />
          <Button busy={busy} onClick={() => void actions.stop()}>
            <StopIcon size={13} /> Stop recording
          </Button>
        </div>
        <p className="text-[12.5px] text-ink-3">
          {live.system
            ? `Your microphone (${live.mic}) and the computer's sound (${live.system}).`
            : `Your microphone only (${live.mic}).`}{" "}
          Headphones keep the others' voices out of your microphone.
        </p>
        {settings?.consent_reminder && (
          <p className="rounded-md bg-accent/10 px-2.5 py-1.5 text-[12.5px] text-ink-2">
            Tell everyone in the meeting that it is being recorded.
          </p>
        )}
      </div>
    );
  } else if (audio?.state === "interrupted") {
    body = (
      <div className="flex flex-col gap-2">
        <p className="text-[13.5px] text-ink-2">
          The recording stopped unexpectedly after {formatClock(audio.duration_ms)} (the app or the
          computer stopped). Keep what was recorded?
        </p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void actions.recover(meeting.id, true)}>
            Keep what was recorded
          </Button>
          <Button onClick={() => void actions.recover(meeting.id, false)}>Discard</Button>
        </div>
      </div>
    );
  } else if (audio && audio.tracks.length > 0) {
    body = (
      <div className="flex flex-col gap-2">
        <TrackPlayer audio={audio} url={urlOf} control={control} />
        <TranscribeRow meeting={meeting} audio={audio} />
        <PurgeNote at={audio.purge_at ?? null} />
        <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-ink-3">
          <span>
            {formatSize(audio.bytes)} on this device
            {audio.state === "encoding" && " · compressing…"}
          </span>
          <span className="flex-1" />
          {confirmDelete ? (
            <span className="flex items-center gap-2">
              Delete the recording from this device?
              <Button size="sm" onClick={() => void actions.purge(meeting.id)}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={audio.state === "encoding"}
              onClick={() => setConfirmDelete(true)}
            >
              Delete audio
            </Button>
          )}
        </div>
      </div>
    );
  } else if (meeting.state === "recording") {
    body = <p className="text-[13.5px] text-ink-3">Being recorded on another device.</p>;
  } else if (!support.recording) {
    body = <p className="text-[13px] text-ink-3">{support.note}</p>;
  } else {
    const otherLive = live !== null;
    body = (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            busy={busy}
            disabled={otherLive}
            onClick={() => void actions.start(meeting.id)}
          >
            <Mic size={14} /> Record
          </Button>
          <span className="text-[12.5px] text-ink-3">
            {otherLive
              ? "Another meeting is being recorded."
              : settings && !settings.capture_system
                ? "Records your microphone (Settings → Scribe)."
                : "Records your microphone and the computer's sound. The audio stays on this device."}
          </span>
        </div>
        {support.note && <p className="text-[12px] text-ink-3">{support.note}</p>}
      </div>
    );
  }

  return (
    <section aria-label="Recording" className="flex flex-col gap-2 pl-10">
      <SectionLabel className="block">Recording</SectionLabel>
      {body}
      {audio && audio.warnings.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[12px] text-ink-3">
          {audio.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="flex items-center gap-2 text-[12.5px] text-danger">
          {error}
          <button
            type="button"
            onClick={() => actions.dismissError()}
            className="text-ink-3 hover:text-ink"
          >
            Dismiss
          </button>
        </p>
      )}
    </section>
  );
}
