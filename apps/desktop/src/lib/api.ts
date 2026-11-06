import { convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { commands, events } from "../bindings";
import type {
  Activity,
  AgentActivity,
  AgentNote,
  AgentSession,
  AgentSettings,
  AgentStart,
  CalendarEvent,
  CalendarStatus,
  Capture,
  Changed,
  Changes,
  ClaudeCheck,
  Command,
  CommandError,
  EventRange,
  JoinMode,
  ProjectFolder,
  Snapshot,
  StoredUpload,
  SyncStatus,
} from "./types";

/** A failure reported by the core (`invalid`, `not_found`, `internal`) or by Tauri itself. */
export class ApiError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: CommandError | string };

async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const result = await call;
  if (result.status === "ok") return result.data;
  const { error } = result;
  // Framework failures (unknown command, bad argument) arrive as plain strings.
  if (typeof error === "string") throw new ApiError("internal", error);
  throw new ApiError(error.kind, error.message);
}

/** Everything the UI may ask of the core. Injected into the store so tests can fake it. */
export interface Api {
  snapshot(): Promise<Snapshot>;
  execute(commands: Command[]): Promise<Changes>;
  undo(): Promise<Changes | null>;
  redo(): Promise<Changes | null>;
  search(text: string, limit: number): Promise<string[]>;
  taskActivity(taskId: string, limit: number): Promise<Activity[]>;
  /** Reads a quick-capture line (read-only). `today` is the local date. */
  parseCapture(text: string, today: string): Promise<Capture>;
  onChanged(handler: (event: Changed) => void): Promise<() => void>;
  /** Attachments and links; absent where there is no file system (some tests). */
  files?: FilesApi;
  /** The calendar connection (ADR 014); absent in tests that do not need it. */
  calendar?: CalendarApi;
  /** The sync server (ADR 015); absent in tests that do not need it. */
  sync?: SyncApi;
  /** Claude Code sessions (ADR 017); absent in tests that do not need it. */
  agents?: AgentsApi;
}

/** Claude Code sessions started from tasks, their settings and project folders. */
export interface AgentsApi {
  /** Starts a session; it is recorded (as failed) even when Claude Code cannot start. */
  start(input: AgentStart): Promise<AgentSession>;
  /** A follow-up message to an ended session. */
  send(sessionId: string, message: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  openTerminal(sessionId: string): Promise<void>;
  /** What running sessions are doing now. */
  live(): Promise<AgentActivity[]>;
  /** The opening context a session on this task would get. */
  brief(taskId: string): Promise<string>;
  notes(taskId: string, sessionId: string | null, limit: number): Promise<AgentNote[]>;
  settings(): Promise<AgentSettings>;
  saveSettings(settings: AgentSettings): Promise<AgentSettings>;
  /** Checks Claude Code runs with these settings (not saved). */
  detect(settings: AgentSettings): Promise<ClaudeCheck>;
  /** Installed WSL distributions (empty outside Windows). */
  distros(): Promise<string[]>;
  folders(): Promise<ProjectFolder[]>;
  setFolder(projectId: string, path: string | null): Promise<ProjectFolder[]>;
  /** Asks for a folder; null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Called with each activity update (`activity: null` when a run stopped). */
  onActivity(handler: (event: AgentActivity) => void): Promise<() => void>;
}

export const tauriAgents: AgentsApi = {
  start: (input) => unwrap(commands.agentStart(input)),
  send: async (sessionId, message) => {
    await unwrap(commands.agentSend(sessionId, message));
  },
  cancel: async (sessionId) => {
    await unwrap(commands.agentCancel(sessionId));
  },
  openTerminal: async (sessionId) => {
    await unwrap(commands.agentOpenTerminal(sessionId));
  },
  live: () => unwrap(commands.agentLive()),
  brief: (taskId) => unwrap(commands.agentBrief(taskId)),
  notes: (taskId, sessionId, limit) => unwrap(commands.agentNotes(taskId, sessionId, limit)),
  settings: () => unwrap(commands.agentSettings()),
  saveSettings: (settings) => unwrap(commands.setAgentSettings(settings)),
  detect: (settings) => unwrap(commands.detectClaude(settings)),
  distros: () => commands.listWslDistros(),
  folders: () => unwrap(commands.projectFolders()),
  setFolder: (projectId, path) => unwrap(commands.setProjectFolder(projectId, path)),
  pickFolder: async () => {
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  },
  onActivity: (handler) => events.agentActivity.listen((event) => handler(event.payload)),
};

/** Sync with a task-master server: connect, sign in, join, status. */
export interface SyncApi {
  status(): Promise<SyncStatus>;
  /** Reads the server's `/info` and saves its address. */
  connect(url: string): Promise<SyncStatus>;
  /** Saves (after checking) a token made on the server. */
  setToken(token: string): Promise<SyncStatus>;
  /** Signs in with the server's OpenID provider in the browser (up to 5 minutes). */
  signIn(): Promise<SyncStatus>;
  /** Starts syncing: merge this device's data with the server's, or replace it. */
  join(mode: JoinMode): Promise<SyncStatus>;
  syncNow(): Promise<SyncStatus>;
  disconnect(): Promise<SyncStatus>;
  /** Called when a round starts and ends, and when the account changes. */
  onChanged(handler: (status: SyncStatus) => void): Promise<() => void>;
}

export const tauriSync: SyncApi = {
  status: () => commands.syncStatus(),
  connect: (url) => unwrap(commands.syncConnect(url)),
  setToken: (token) => unwrap(commands.syncSetToken(token)),
  signIn: () => unwrap(commands.syncSignIn()),
  join: (mode) => unwrap(commands.syncJoin(mode)),
  syncNow: () => commands.syncNow(),
  disconnect: () => unwrap(commands.syncDisconnect()),
  onChanged: (handler) => events.syncChanged.listen((event) => handler(event.payload)),
};

/** Google Calendar sync: settings, status and the read-only events of shown calendars. */
export interface CalendarApi {
  status(): Promise<CalendarStatus>;
  /** Opens the Google sign-in in the browser and waits for it (up to 5 minutes). */
  connect(clientId: string, clientSecret: string): Promise<CalendarStatus>;
  disconnect(): Promise<CalendarStatus>;
  setShown(calendarId: string, shown: boolean): Promise<CalendarStatus>;
  syncNow(): Promise<CalendarStatus>;
  setRunner?(runner: "this_device" | "server"): Promise<CalendarStatus>;
  events(range: EventRange): Promise<CalendarEvent[]>;
  /** Called when a sync starts and ends. */
  onSynced(handler: (status: CalendarStatus) => void): Promise<() => void>;
}

export const tauriCalendar: CalendarApi = {
  status: () => unwrap(commands.calendarStatus()),
  setRunner: (runner) => unwrap(commands.setCalendarRunner(runner)),
  connect: (clientId, clientSecret) => unwrap(commands.googleConnect(clientId, clientSecret)),
  disconnect: () => unwrap(commands.googleDisconnect()),
  setShown: (calendarId, shown) => unwrap(commands.setCalendarShown(calendarId, shown)),
  syncNow: () => unwrap(commands.calendarSyncNow()),
  events: (range) => unwrap(commands.calendarEvents(range)),
  onSynced: (handler) => events.calendarSynced.listen((event) => handler(event.payload)),
};

/**
 * Attachment content and the OS around it (ADR 011). Storing content is not a data edit:
 * the attachment row is then created through `execute`.
 */
export interface FilesApi {
  /** Copies a file from disk into the attachment folder. */
  storeFile(path: string): Promise<StoredUpload>;
  /** Stores pasted bytes (base64). */
  storeData(name: string, mime: string, base64: string): Promise<StoredUpload>;
  /** Opens the attachment in its default app. */
  open(id: string): Promise<void>;
  /** Asks where to save a copy, then writes it. Resolves false when cancelled. */
  saveCopy(id: string, name: string): Promise<boolean>;
  /** Opens an http(s)/mailto link outside the app. */
  openUrl(url: string): Promise<void>;
  /** Asks for files to attach; empty when cancelled. */
  pickFiles(): Promise<string[]>;
  /** URL the webview loads the attachment from. */
  url(id: string): string;
}

export const tauriFiles: FilesApi = {
  storeFile: (path) => unwrap(commands.storeFile(path)),
  storeData: (name, mime, base64) => unwrap(commands.storeData(name, mime, base64)),
  open: async (id) => {
    await unwrap(commands.openAttachment(id));
  },
  saveCopy: async (id, name) => {
    const path = await save({ defaultPath: name });
    if (!path) return false;
    await unwrap(commands.saveAttachment(id, path));
    return true;
  },
  openUrl: async (url) => {
    await unwrap(commands.openUrl(url));
  },
  pickFiles: async () => {
    const picked = await open({ multiple: true, directory: false });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  },
  url: (id) => convertFileSrc(id, "tm"),
};

export const tauriApi: Api = {
  snapshot: () => unwrap(commands.snapshot()),
  execute: (list) => unwrap(commands.execute(list)),
  undo: () => unwrap(commands.undo()),
  redo: () => unwrap(commands.redo()),
  search: (text, limit) => unwrap(commands.search(text, limit)),
  taskActivity: (taskId, limit) => unwrap(commands.taskActivity(taskId, limit)),
  parseCapture: (text, today) => unwrap(commands.parseCapture(text, today)),
  onChanged: (handler) => events.storeChanged.listen((event) => handler(event.payload)),
  files: tauriFiles,
  calendar: tauriCalendar,
  sync: tauriSync,
  agents: tauriAgents,
};
