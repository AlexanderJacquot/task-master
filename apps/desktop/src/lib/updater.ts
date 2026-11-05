// In-app updates (ADR 009). The app asks GitHub for the latest signed release, downloads
// and installs it, then relaunches. The Tauri calls sit behind `UpdateSource` so the UI and
// this state machine are tested with a fake.

import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

/** This build, baked in by Vite (`vite.config.ts`). */
export const BUILD = {
  version: __APP_VERSION__,
  commit: __APP_COMMIT__,
  builtAt: __APP_BUILT_AT__,
};

export interface AvailableUpdate {
  version: string;
  notes: string | null;
  date: string | null;
  /** Downloads and installs; `progress` gets 0–1, or null while the size is unknown. */
  install(progress: (fraction: number | null) => void): Promise<void>;
}

export interface UpdateSource {
  /** The newer release, or null when this build is the latest. */
  check(): Promise<AvailableUpdate | null>;
  relaunch(): Promise<void>;
}

export const tauriUpdates: UpdateSource = {
  async check() {
    const update: Update | null = await check();
    if (!update) return null;
    return {
      version: update.version,
      notes: update.body ?? null,
      date: update.date ?? null,
      async install(progress) {
        let total = 0;
        let done = 0;
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            total = event.data.contentLength ?? 0;
            progress(total ? 0 : null);
          } else if (event.event === "Progress") {
            done += event.data.chunkLength;
            progress(total ? Math.min(1, done / total) : null);
          } else {
            progress(1);
          }
        });
      },
    };
  },
  relaunch: () => relaunch(),
};

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; checkedAt: number }
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "installing"; update: AvailableUpdate; progress: number | null }
  | { kind: "ready"; update: AvailableUpdate }
  | { kind: "error"; message: string; during: "check" | "install" };

export interface UpdateState {
  status: UpdateStatus;
  /** `quiet`: the startup check, which never shows an error. */
  check(options?: { quiet?: boolean }): Promise<void>;
  install(): Promise<void>;
  restart(): Promise<void>;
}

export type UpdateStore = StoreApi<UpdateState>;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createUpdateStore(source: UpdateSource): UpdateStore {
  // The update an install failed on, so "Try again" can retry it.
  let lastUpdate: AvailableUpdate | null = null;
  return createStore<UpdateState>()((set, get) => ({
    status: { kind: "idle" },
    async check({ quiet = false } = {}) {
      const before = get().status.kind;
      if (before === "checking" || before === "installing" || before === "ready") return;
      set({ status: { kind: "checking" } });
      try {
        const update = await source.check();
        set({
          status: update
            ? { kind: "available", update }
            : { kind: "current", checkedAt: Date.now() },
        });
      } catch (err) {
        set({
          status: quiet
            ? { kind: "idle" }
            : { kind: "error", message: message(err), during: "check" },
        });
      }
    },
    async install() {
      const status = get().status;
      if (status.kind !== "available" && !(status.kind === "error" && status.during === "install"))
        return;
      const update = status.kind === "available" ? status.update : lastUpdate;
      if (!update) return;
      lastUpdate = update;
      set({ status: { kind: "installing", update, progress: null } });
      try {
        await update.install((progress) =>
          set({ status: { kind: "installing", update, progress } }),
        );
        // On Windows the installer closes the app itself; elsewhere we restart.
        set({ status: { kind: "ready", update } });
      } catch (err) {
        set({ status: { kind: "error", message: message(err), during: "install" } });
      }
    },
    async restart() {
      await source.relaunch();
    },
  }));
}

const UpdateContext = createContext<UpdateStore | null>(null);
export const UpdateProvider = UpdateContext.Provider;

/** The update state, or null outside the desktop app (tests that do not provide one). */
export function useUpdates(): UpdateState | null {
  const store = useContext(UpdateContext);
  const state = useStore(store ?? EMPTY);
  return store ? state : null;
}

const EMPTY_STATE: UpdateState = {
  status: { kind: "idle" },
  check: async () => {},
  install: async () => {},
  restart: async () => {},
};
const EMPTY: UpdateStore = createStore<UpdateState>()(() => EMPTY_STATE);
