// Scribe recording on this device (ADR 025, M19): the recording in progress, its levels,
// and each meeting's audio here. Audio is per device and never synced, so it lives in this
// small store beside the task store, behind `ScribeApi` so tests use a fake. Levels arrive
// ten times a second and only re-render the meters.

import { convertFileSrc } from "@tauri-apps/api/core";
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  type AudioDevice,
  type AudioUsage,
  type CaptureSupport_Serialize,
  commands,
  events,
  type LiveRecording_Serialize,
  type MeetingAudio,
  type ModelInfo_Serialize,
  type ScribeSettings_Serialize,
  type ScribeStatus_Serialize,
  type Step,
} from "../bindings";
import { ApiError } from "./api";
import type { CommandError } from "./types";

export type CaptureSupport = CaptureSupport_Serialize;
export type LiveRecording = LiveRecording_Serialize;
export type ScribeSettings = ScribeSettings_Serialize;
export type ScribeStatus = ScribeStatus_Serialize;
export type ModelInfo = ModelInfo_Serialize;
export type { AudioDevice, AudioUsage, MeetingAudio, Step };

export interface Progress {
  meetingId: string;
  step: Step;
  fraction: number;
}

/** A running transcription's progress, with when this app first saw it move. */
export interface TrackedProgress extends Progress {
  /** First progress seen (a resumed run starts part way). */
  since: { at: number; fraction: number };
}

/**
 * Milliseconds left at the pace so far, or null until there is enough to go on (20 s and
 * 1% of progress since the first event).
 */
export function timeLeft(p: TrackedProgress, now: number): number | null {
  const took = now - p.since.at;
  const done = p.fraction - p.since.fraction;
  if (took < 20_000 || done < 0.01) return null;
  return Math.max(0, ((1 - p.fraction) * took) / done);
}

/** "12 s", "4 min", "1 h 05 min". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

export interface ModelProgress {
  model: string;
  done: number;
  total: number;
  finished: boolean;
  error: string | null;
}

export interface Levels {
  meetingId: string;
  elapsedMs: number;
  mic: number;
  system: number | null;
}

export interface ScribeApi {
  status(): Promise<ScribeStatus>;
  devices(): Promise<AudioDevice[]>;
  settings(): Promise<ScribeSettings>;
  saveSettings(settings: ScribeSettings): Promise<ScribeSettings>;
  /** Records the meeting with the saved device settings; it starts now. */
  start(meetingId: string): Promise<ScribeStatus>;
  /** Stops the recording in progress; resolves once its files are complete. */
  stop(): Promise<ScribeStatus>;
  /** The meeting's audio on this device, or null. */
  audio(meetingId: string): Promise<MeetingAudio | null>;
  /** After an interrupted recording: keep what was recorded, or delete it. */
  recover(meetingId: string, keep: boolean): Promise<void>;
  /** Deletes the meeting's audio from this device. */
  purge(meetingId: string): Promise<void>;
  usage(): Promise<AudioUsage[]>;
  /** URL the webview plays a track from (`meeting-audio/<id>/<track>`). */
  url(path: string): string;
  onLevels(handler: (levels: Levels) => void): Promise<() => void>;
  onChanged(handler: (meetingId: string) => void): Promise<() => void>;
  /** Transcription models (M20). */
  models(): Promise<ModelInfo[]>;
  /** Starts a download in the background; progress comes through `onModelProgress`. */
  downloadModel(id: string): Promise<void>;
  cancelDownload(): Promise<void>;
  deleteModel(id: string): Promise<ModelInfo[]>;
  /** Queues the meeting's transcription (again, when it has one). */
  process(meetingId: string): Promise<void>;
  cancelProcess(meetingId: string): Promise<void>;
  onProgress(handler: (progress: Progress) => void): Promise<() => void>;
  onModelProgress(handler: (progress: ModelProgress) => void): Promise<() => void>;
}

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: CommandError | string };

async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const result = await call;
  if (result.status === "ok") return result.data;
  const { error } = result;
  if (typeof error === "string") throw new ApiError("internal", error);
  throw new ApiError(error.kind, error.message);
}

export const tauriScribe: ScribeApi = {
  status: () => unwrap(commands.scribeStatus()),
  devices: () => unwrap(commands.scribeDevices()),
  settings: () => unwrap(commands.scribeSettings()),
  saveSettings: (settings) => unwrap(commands.setScribeSettings(settings)),
  start: (meetingId) => unwrap(commands.scribeStart(meetingId)),
  stop: () => unwrap(commands.scribeStop()),
  audio: (meetingId) => unwrap(commands.scribeAudio(meetingId)),
  recover: async (meetingId, keep) => {
    await unwrap(commands.scribeRecover(meetingId, keep));
  },
  purge: async (meetingId) => {
    await unwrap(commands.scribePurgeAudio(meetingId));
  },
  usage: () => unwrap(commands.scribeAudioUsage()),
  url: (path) => convertFileSrc(path, "tm"),
  onLevels: (handler) =>
    events.scribeLevels.listen(({ payload }) =>
      handler({
        meetingId: payload.meeting_id,
        elapsedMs: payload.elapsed_ms,
        mic: payload.mic ?? 0,
        system: payload.system ?? null,
      }),
    ),
  onChanged: (handler) => events.scribeChanged.listen(({ payload }) => handler(payload.meeting_id)),
  models: () => unwrap(commands.scribeModels()),
  downloadModel: async (id) => {
    await unwrap(commands.scribeDownloadModel(id));
  },
  cancelDownload: async () => {
    await unwrap(commands.scribeCancelDownload());
  },
  deleteModel: (id) => unwrap(commands.scribeDeleteModel(id)),
  process: async (meetingId) => {
    await unwrap(commands.scribeProcess(meetingId));
  },
  cancelProcess: async (meetingId) => {
    await unwrap(commands.scribeCancelProcess(meetingId));
  },
  onProgress: (handler) =>
    events.scribeProgress.listen(({ payload }) =>
      handler({
        meetingId: payload.meeting_id,
        step: payload.step,
        fraction: payload.fraction ?? 0,
      }),
    ),
  onModelProgress: (handler) =>
    events.scribeModelProgress.listen(({ payload }) =>
      handler({
        model: payload.model,
        done: payload.done,
        total: payload.total,
        finished: payload.finished,
        error: payload.error ?? null,
      }),
    ),
};

export interface ScribeState {
  support: CaptureSupport | null;
  /** Transcription runs on this system. */
  transcription: boolean;
  /** Running transcriptions, by meeting id. */
  progress: Record<string, TrackedProgress>;
  live: LiveRecording | null;
  levels: Levels | null;
  /** By meeting id: its audio here, null for none, absent until read. */
  audio: Record<string, MeetingAudio | null>;
  /** Start or stop under way. */
  busy: boolean;
  error: string | null;
  /** Reads the status and follows the shell's events. */
  connect(): Promise<() => void>;
  start(meetingId: string): Promise<boolean>;
  stop(): Promise<void>;
  loadAudio(meetingId: string): Promise<void>;
  recover(meetingId: string, keep: boolean): Promise<void>;
  purge(meetingId: string): Promise<void>;
  /** Queues a transcription (or a new one). */
  process(meetingId: string): Promise<void>;
  cancelProcess(meetingId: string): Promise<void>;
  dismissError(): void;
}

export type ScribeStore = StoreApi<ScribeState>;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createScribeStore(api: ScribeApi): ScribeStore {
  return createStore<ScribeState>((set, get) => {
    const refreshStatus = async () => {
      const status = await api.status();
      set({
        support: status.support,
        transcription: status.transcription,
        live: status.live,
        levels: status.live ? get().levels : null,
      });
    };
    const loadAudio = async (meetingId: string) => {
      try {
        const audio = await api.audio(meetingId);
        set((s) => ({ audio: { ...s.audio, [meetingId]: audio } }));
      } catch (err) {
        set({ error: message(err) });
      }
    };
    return {
      support: null,
      transcription: false,
      progress: {},
      live: null,
      levels: null,
      audio: {},
      busy: false,
      error: null,

      async connect() {
        const stopLevels = await api.onLevels((levels) => {
          if (get().live?.meeting_id === levels.meetingId) set({ levels });
        });
        const stopChanged = await api.onChanged((meetingId) => {
          void refreshStatus().catch(() => undefined);
          // A job that ended stops showing its progress.
          set((s) => {
            if (!(meetingId in s.progress)) return {};
            const progress = { ...s.progress };
            delete progress[meetingId];
            return { progress };
          });
          // Only meetings someone looked at are kept up to date.
          if (meetingId in get().audio) void loadAudio(meetingId);
        });
        const stopProgress = await api.onProgress((p) =>
          set((s) => {
            const before = s.progress[p.meetingId];
            const since = before?.since ?? { at: Date.now(), fraction: p.fraction };
            return { progress: { ...s.progress, [p.meetingId]: { ...p, since } } };
          }),
        );
        try {
          await refreshStatus();
        } catch (err) {
          set({ error: message(err) });
        }
        return () => {
          stopLevels();
          stopChanged();
          stopProgress();
        };
      },

      async start(meetingId) {
        set({ busy: true, error: null });
        try {
          const status = await api.start(meetingId);
          set({ support: status.support, live: status.live, levels: null, busy: false });
          void loadAudio(meetingId);
          return true;
        } catch (err) {
          set({ busy: false, error: message(err) });
          return false;
        }
      },

      async stop() {
        const meetingId = get().live?.meeting_id;
        set({ busy: true, error: null });
        try {
          const status = await api.stop();
          set({ support: status.support, live: status.live, levels: null, busy: false });
          if (meetingId) void loadAudio(meetingId);
        } catch (err) {
          set({ busy: false, error: message(err) });
        }
      },

      loadAudio,

      async recover(meetingId, keep) {
        try {
          await api.recover(meetingId, keep);
        } catch (err) {
          set({ error: message(err) });
        }
        await loadAudio(meetingId);
      },

      async purge(meetingId) {
        try {
          await api.purge(meetingId);
        } catch (err) {
          set({ error: message(err) });
        }
        await loadAudio(meetingId);
      },

      async process(meetingId) {
        set({ error: null });
        try {
          await api.process(meetingId);
        } catch (err) {
          set({ error: message(err) });
        }
        await loadAudio(meetingId);
      },

      async cancelProcess(meetingId) {
        try {
          await api.cancelProcess(meetingId);
        } catch (err) {
          set({ error: message(err) });
        }
        await loadAudio(meetingId);
      },

      dismissError: () => set({ error: null }),
    };
  });
}

const ScribeContext = createContext<{ store: ScribeStore; api: ScribeApi } | null>(null);
export const ScribeProvider = ScribeContext.Provider;

const EMPTY = createStore<ScribeState>(() => ({
  support: null,
  transcription: false,
  progress: {},
  live: null,
  levels: null,
  audio: {},
  busy: false,
  error: null,
  connect: async () => () => undefined,
  start: async () => false,
  stop: async () => undefined,
  loadAudio: async () => undefined,
  recover: async () => undefined,
  purge: async () => undefined,
  process: async () => undefined,
  cancelProcess: async () => undefined,
  dismissError: () => undefined,
}));

/** Scribe state, or null outside the desktop app (tests that provide none). */
export function useScribe<T>(selector: (s: ScribeState) => T): T | null {
  const ctx = useContext(ScribeContext);
  const value = useStore(ctx?.store ?? EMPTY, selector);
  return ctx ? value : null;
}

/** The API behind the store (devices, settings, playback URLs), or null. */
export function useScribeApi(): ScribeApi | null {
  return useContext(ScribeContext)?.api ?? null;
}

/** The store itself, for actions; null outside the desktop app. */
export function useScribeStore(): ScribeStore | null {
  return useContext(ScribeContext)?.store ?? null;
}

/** "4:05", "1:02:09". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
