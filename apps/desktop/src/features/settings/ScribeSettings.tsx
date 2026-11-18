// Settings → Scribe (ADR 025, ADR 026): which microphone records, whether the computer's
// sound is recorded too, the consent reminder, the transcription models (download, pick,
// delete), and the meeting audio kept on this device.

import { useCallback, useEffect, useState } from "react";
import { Button, Select } from "../../components/ui";
import { formatSize } from "../../lib/attachments";
import {
  type AudioDevice,
  type AudioUsage,
  formatClock,
  type ModelInfo,
  type ModelProgress,
  type ScribeSettings as Settings,
  useScribe,
  useScribeApi,
  useScribeStore,
} from "../../lib/scribe";
import { useStoreState } from "../../store/context";
import { Section } from "./SettingsPage";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Meeting audio on this device, largest first, each deletable. */
export function MeetingAudioList() {
  const api = useScribeApi();
  const scribe = useScribeStore();
  const meetings = useStoreState((s) => s.meetings);
  const [usage, setUsage] = useState<AudioUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    if (!api) return;
    api.usage().then(setUsage, (e) => setError(message(e)));
  };
  useEffect(load, [api]);
  if (!api || !scribe || usage === null) return null;
  const total = usage.reduce((sum, u) => sum + u.bytes, 0);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink-2">
        {usage.length === 0
          ? "No meeting audio on this device."
          : `${usage.length} recording${usage.length === 1 ? "" : "s"}, ${formatSize(total)}. Audio stays on this device and is never synced.`}
      </p>
      {usage.length > 0 && (
        <ul aria-label="Meeting audio" className="flex flex-col gap-1">
          {usage.map((u) => (
            <li key={u.meeting_id} className="flex items-center gap-3 text-[13px]">
              <span className="min-w-0 flex-1 truncate">
                {meetings[u.meeting_id]?.title ?? "Deleted meeting"}
              </span>
              <span className="w-16 text-right text-ink-3 tabular-nums">
                {formatClock(u.duration_ms)}
              </span>
              <span className="w-20 text-right text-ink-3 tabular-nums">{formatSize(u.bytes)}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void scribe.getState().purge(u.meeting_id).then(load)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

const LANGUAGES = [
  { value: "", label: "Detect it" },
  { value: "en", label: "English" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" },
  { value: "it", label: "Italian" },
  { value: "nl", label: "Dutch" },
  { value: "pt", label: "Portuguese" },
];

/** The transcription models: download (resumable), use, delete. */
export function ModelList({ onActive }: { onActive(id: string): Promise<unknown> }) {
  const api = useScribeApi();
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [progress, setProgress] = useState<ModelProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api?.models().then(setModels, (e) => setError(message(e)));
  }, [api]);
  useEffect(() => {
    if (!api) return;
    reload();
    let stop: (() => void) | null = null;
    let gone = false;
    void api
      .onModelProgress((p) => {
        if (p.finished) {
          setProgress(null);
          if (p.error) setError(`The download stopped: ${p.error}. Download again to resume.`);
          reload();
        } else setProgress(p);
      })
      .then((unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, [api, reload]);
  if (!api || !models) return null;
  const run = (work: Promise<unknown>) => {
    setError(null);
    work.then(reload, (e) => setError(message(e)));
  };
  const downloading = models.find((m) => m.downloading !== null)?.id ?? progress?.model ?? null;

  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Transcription models" className="flex flex-col gap-2">
        {models.map((m) => {
          const here = downloading === m.id;
          const done = progress?.model === m.id ? progress.done : (m.downloading ?? 0);
          const total = progress?.model === m.id ? progress.total : m.download_bytes;
          return (
            <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2">
                  {m.label}
                  {m.active && (
                    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11.5px] text-accent">
                      In use
                    </span>
                  )}
                </p>
                <p className="text-xs text-ink-3">{m.description}</p>
              </div>
              {here ? (
                <>
                  <progress
                    aria-label={`Downloading ${m.label}`}
                    max={Math.max(total, 1)}
                    value={done}
                    className="h-1.5 w-32 accent-accent"
                  />
                  <span className="text-xs text-ink-3 tabular-nums">
                    {formatSize(done)} / {formatSize(total)}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => run(api.cancelDownload())}>
                    Stop
                  </Button>
                </>
              ) : m.installed ? (
                <>
                  {!m.active && (
                    <Button size="sm" onClick={() => run(onActive(m.id))}>
                      Use
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => run(api.deleteModel(m.id))}>
                    Delete
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={downloading !== null}
                  onClick={() => run(api.downloadModel(m.id))}
                >
                  Download ({formatSize(m.download_bytes)})
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

export function ScribeSettings() {
  const api = useScribeApi();
  const support = useScribe((s) => s.support);
  const transcription = useScribe((s) => s.transcription);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let live = true;
    api.settings().then(
      (s) => live && setSettings(s),
      (e) => live && setError(message(e)),
    );
    api.devices().then(
      (d) => live && setDevices(d),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  if (!api || !settings) return null;
  const save = async (next: Settings) => {
    setError(null);
    setSettings(next);
    try {
      setSettings(await api.saveSettings(next));
    } catch (e) {
      setError(message(e));
    }
  };
  const defaultName = devices.find((d) => d.is_default)?.name;
  const micOptions = [
    { value: "", label: defaultName ? `System default (${defaultName})` : "System default" },
    ...devices.map((d) => ({ value: d.id, label: d.name })),
  ];
  // A saved device that is unplugged now still shows.
  if (settings.mic_device && !devices.some((d) => d.id === settings.mic_device)) {
    micOptions.push({ value: settings.mic_device, label: "A microphone not connected now" });
  }

  return (
    <>
      <Section
        title="Recording"
        hint="Meetings are recorded on this device: your microphone, and the computer's sound so everyone else on a call is in it too."
      >
        {support && !support.recording && <p className="text-sm text-ink-3">{support.note}</p>}
        {support?.recording && (
          <>
            <div className="flex items-center gap-2 text-sm">
              Microphone
              <Select
                aria-label="Microphone"
                value={settings.mic_device ?? ""}
                onValueChange={(id) => void save({ ...settings, mic_device: id || null })}
                options={micOptions}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.capture_system}
                onChange={() =>
                  void save({ ...settings, capture_system: !settings.capture_system })
                }
                className="size-4 accent-accent"
              />
              Record the computer's sound (the other people on a call)
            </label>
            {support.note && <p className="text-xs text-ink-3">{support.note}</p>}
          </>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.consent_reminder}
            onChange={() =>
              void save({ ...settings, consent_reminder: !settings.consent_reminder })
            }
            className="size-4 accent-accent"
          />
          Remind me to tell participants they are being recorded
        </label>
        {error && <p className="text-xs text-danger">{error}</p>}
      </Section>
      <Section
        title="Transcription"
        hint="Recordings are transcribed on this device: nothing is sent anywhere. Models are downloaded once; the first one downloaded is used."
      >
        {!transcription ? (
          <p className="text-sm text-ink-3">Transcription runs on Windows and macOS.</p>
        ) : (
          <>
            <ModelList onActive={(model) => save({ ...settings, model })} />
            <div className="flex items-center gap-2 text-sm">
              Language spoken
              <Select
                aria-label="Language spoken"
                value={settings.language ?? ""}
                onValueChange={(language) => void save({ ...settings, language: language || null })}
                options={
                  settings.language && !LANGUAGES.some((l) => l.value === settings.language)
                    ? [...LANGUAGES, { value: settings.language, label: settings.language }]
                    : LANGUAGES
                }
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.auto_transcribe}
                onChange={() =>
                  void save({ ...settings, auto_transcribe: !settings.auto_transcribe })
                }
                className="size-4 accent-accent"
              />
              Transcribe meetings as soon as the recording stops
            </label>
          </>
        )}
        <label className="flex items-center gap-2 text-sm">
          Keep the audio
          <input
            type="number"
            aria-label="Days the audio is kept"
            min={1}
            max={365}
            defaultValue={settings.retention_days}
            key={settings.retention_days}
            onBlur={(e) => {
              const days = Math.round(Number(e.currentTarget.value));
              if (days >= 1 && days <= 365 && days !== settings.retention_days)
                void save({ ...settings, retention_days: days });
              else e.currentTarget.value = String(settings.retention_days);
            }}
            className="w-16 rounded-lg border border-line-strong bg-raised px-2 py-1 text-ink focus:border-accent focus:outline-none"
          />
          days after the transcript is checked (or made, when it never is)
        </label>
      </Section>
      <Section title="Meeting audio" hint="Recordings kept on this device.">
        <MeetingAudioList />
      </Section>
    </>
  );
}
