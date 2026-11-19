// Settings-screen calls (data folder, backups, export/import). Desktop-only, so they are
// not part of the injected `Api` the store and its tests use.

import { commands, type FilesOverview_Serialize, type PurgeReport } from "../bindings";
import { ApiError } from "./api";
import type {
  BackupStatus,
  CommandError,
  ConfigView,
  ImportSummary,
  RemoteInput,
  Schedule,
} from "./types";

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: CommandError | string };

async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const result = await call;
  if (result.status === "ok") return result.data;
  const { error } = result;
  if (typeof error === "string") throw new ApiError("internal", error);
  throw new ApiError(error.kind, error.message);
}

export const settingsApi = {
  getConfig: (): Promise<ConfigView> => unwrap(commands.getConfig()),
  setRemoteBackup: (input: RemoteInput): Promise<ConfigView> =>
    unwrap(commands.setRemoteBackup(input)),
  setSchedule: (schedule: Schedule): Promise<ConfigView> => unwrap(commands.setSchedule(schedule)),
  testRemoteBackup: (input: RemoteInput): Promise<null> => unwrap(commands.testRemoteBackup(input)),
  backupStatus: (): Promise<BackupStatus> => unwrap(commands.backupStatus()),
  backupNow: (): Promise<BackupStatus> => unwrap(commands.backupNow()),
  exportTo: (path: string): Promise<null> => unwrap(commands.exportTo(path)),
  importFrom: (path: string): Promise<ImportSummary> => unwrap(commands.importFrom(path)),
  /** Files on this device and on the sync server (Settings → Files, ADR 023). */
  filesOverview: (): Promise<FilesOverview_Serialize> => unwrap(commands.filesOverview()),
  /** Permanently deletes unused content here, then everywhere at the next sync. */
  purgeFiles: (hashes: string[]): Promise<PurgeReport> => unwrap(commands.purgeFiles(hashes)),
  /** Copies the data there (unless a database already exists) and restarts the app. */
  setDataDir: (path: string | null): Promise<null> => unwrap(commands.setDataDir(path)),
};
