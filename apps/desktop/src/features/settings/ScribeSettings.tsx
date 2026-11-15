// Settings → Scribe (ADR 025): which microphone records, whether the computer's sound is
// recorded too, the consent reminder, and the meeting audio kept on this device.

import { useEffect, useState } from "react";
import { Button, Select } from "../../components/ui";
import { formatSize } from "../../lib/attachments";
import {
  type AudioDevice,
  type AudioUsage,
  formatClock,
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

export function ScribeSettings() {
  const api = useScribeApi();
  const support = useScribe((s) => s.support);
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
      <Section title="Meeting audio" hint="Recordings kept on this device.">
        <MeetingAudioList />
      </Section>
    </>
  );
}
