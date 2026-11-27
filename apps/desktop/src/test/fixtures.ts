import type {
  Levels,
  MeetingAudio,
  ModelInfo,
  ModelProgress,
  Progress,
  ScribeApi,
  ScribeSettings,
  ScribeStatus,
} from "../lib/scribe";
import type {
  AgentSession,
  Attachment,
  Capture,
  Meeting,
  Note,
  NoteFolder,
  Project,
  Snapshot,
  Status,
  Task,
  TerminalSession,
  TimeBlock,
} from "../lib/types";

/** Valid, increasing fractional keys ("a0" + fixed-width digits + "V"), unlike `a${n}` past 9. */
function fixtureRank(): string {
  return `a0${String(counter).padStart(5, "0")}V`;
}

export const STATUS = {
  backlog: "00000000-0000-7000-8000-000000000001",
  todo: "00000000-0000-7000-8000-000000000002",
  inProgress: "00000000-0000-7000-8000-000000000003",
  waiting: "00000000-0000-7000-8000-000000000004",
  done: "00000000-0000-7000-8000-000000000005",
  cancelled: "00000000-0000-7000-8000-000000000006",
} as const;

/** The default workflow seeded by migration 0001. */
export const statuses: Status[] = [
  {
    id: STATUS.backlog,
    name: "Backlog",
    category: "backlog",
    color: null,
    rank: "a0",
    wip_limit: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  },
  {
    id: STATUS.todo,
    name: "To do",
    category: "todo",
    color: null,
    rank: "a1",
    wip_limit: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  },
  {
    id: STATUS.inProgress,
    name: "In progress",
    category: "in_progress",
    color: null,
    rank: "a2",
    wip_limit: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  },
  {
    id: STATUS.waiting,
    name: "Waiting",
    category: "in_progress",
    color: null,
    rank: "a3",
    wip_limit: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  },
  {
    id: STATUS.done,
    name: "Done",
    category: "done",
    color: null,
    rank: "a4",
    wip_limit: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  },
  {
    id: STATUS.cancelled,
    name: "Cancelled",
    category: "cancelled",
    color: null,
    rank: "a5",
    wip_limit: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  },
];

let counter = 0;

export function task(overrides: Partial<Task> = {}): Task {
  counter += 1;
  return {
    id: `t${counter}`,
    project_id: null,
    epic_id: null,
    parent_id: null,
    status_id: STATUS.todo,
    title: `Task ${counter}`,
    description: "",
    owner: "me",
    priority: "normal",
    due_date: null,
    today_on: null,
    estimate_min: null,
    rank: fixtureRank(),
    tag_ids: [],
    dependency_ids: [],
    created_at: 1,
    updated_at: 1,
    completed_at: null,
    deleted_at: null,
    ...overrides,
  };
}

export function project(overrides: Partial<Project> = {}): Project {
  counter += 1;
  return {
    id: `p${counter}`,
    parent_id: null,
    name: `Project ${counter}`,
    color: null,
    icon: null,
    rank: fixtureRank(),
    archived_at: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    ...overrides,
  };
}

/** Attachment ids are uuids: descriptions only resolve `attachment:<uuid>` links. */
export function attachment(overrides: Partial<Attachment> = {}): Attachment {
  counter += 1;
  return {
    id: `0192f0c4-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    task_id: "t0",
    meeting_id: null,
    note_id: null,
    hash: "a".repeat(64),
    name: `file-${counter}.png`,
    mime: "image/png",
    size: 1234,
    created_at: counter,
    updated_at: counter,
    deleted_at: null,
    ...overrides,
  };
}

/** A one-hour planned block on `task_id`, starting at `start_at`. */
export function timeBlock(overrides: Partial<TimeBlock> = {}): TimeBlock {
  counter += 1;
  const start_at = overrides.start_at ?? new Date(2026, 10, 5, 9).getTime();
  return {
    id: `0192f0c5-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    task_id: "t0",
    start_at,
    end_at: start_at + 3_600_000,
    outcome: "planned",
    created_at: counter,
    updated_at: counter,
    deleted_at: null,
    ...overrides,
  };
}

/** An agent session of this device on `task_id` (ADR 017), done unless overridden. */
export function agentSession(overrides: Partial<AgentSession> = {}): AgentSession {
  counter += 1;
  return {
    id: `s${counter}`,
    task_id: "t0",
    device_id: "this-device",
    claude_session_id: `c${counter}`,
    folder: "/home/me/code/app",
    runtime: "native",
    permission_mode: "acceptEdits",
    model: null,
    prompt: "",
    state: "done",
    started_at: 1_000 + counter,
    ended_at: 61_000 + counter,
    summary: null,
    cost_usd_micros: null,
    turns: null,
    duration_ms: null,
    error: null,
    created_at: counter,
    updated_at: counter,
    deleted_at: null,
    ...overrides,
  };
}

/** A Claude Code session run in a terminal (M21), without a project unless given one. */
export function terminalSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  counter += 1;
  return {
    id: `ts${counter}`,
    claude_session_id: `tc${counter}`,
    device_id: "this-device",
    folder: "/home/me/code/site",
    project_id: null,
    task_id: null,
    title: `Terminal session ${counter}`,
    model: "claude-opus-5-5",
    started_at: 1_000 + counter,
    ended_at: 61_000 + counter,
    cost_usd_micros: null,
    duration_ms: null,
    turns: null,
    created_at: counter,
    updated_at: counter,
    deleted_at: null,
    ...overrides,
  };
}

/** A held meeting of one hour, 2026-11-05 10:00 local unless overridden. */
export function meeting(overrides: Partial<Meeting> = {}): Meeting {
  counter += 1;
  const started_at = overrides.started_at ?? new Date(2026, 10, 5, 10).getTime();
  return {
    id: `0192f0c6-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    title: `Meeting ${counter}`,
    started_at,
    ended_at: started_at + 3_600_000,
    project_id: null,
    epic_id: null,
    task_id: null,
    state: "held",
    participants: [],
    notes: "",
    summary: null,
    transcribed_at: null,
    validated_at: null,
    speakers: {},
    show_as: "busy",
    private: true,
    created_at: counter,
    updated_at: counter,
    deleted_at: null,
    ...overrides,
  };
}

export function note(overrides: Partial<Note> = {}): Note {
  counter += 1;
  return {
    id: `0192f0c7-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    title: `Note ${counter}`,
    body: "",
    folder_id: null,
    task_id: null,
    rank: fixtureRank(),
    created_at: counter,
    updated_at: counter,
    deleted_at: null,
    ...overrides,
  };
}

export function noteFolder(overrides: Partial<NoteFolder> = {}): NoteFolder {
  counter += 1;
  return {
    id: `0192f0c8-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    name: `Folder ${counter}`,
    parent_id: null,
    rank: fixtureRank(),
    created_at: counter,
    updated_at: counter,
    deleted_at: null,
    ...overrides,
  };
}

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    tasks: [],
    projects: [],
    epics: [],
    statuses,
    tags: [],
    views: [],
    attachments: [],
    time_blocks: [],
    agent_sessions: [],
    meetings: [],
    terminal_sessions: [],
    notes: [],
    note_folders: [],
    ...overrides,
  };
}

/**
 * A small stand-in for the core's capture parser (`crates/core/src/parse.rs`): `#tag`,
 * `@Project`, `+epic:Name`, `!priority`, matched by exact name against `snap`. The real
 * grammar is covered by the core's snapshot tests.
 */
export function fakeParse(text: string, snap: Partial<Snapshot> = {}): Capture {
  const byName = <T extends { id: string; name: string }>(list: T[] | undefined, name: string) =>
    list?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.id ?? null;
  const capture: Capture = {
    title: "",
    tags: [],
    project: null,
    epic: null,
    priority: null,
    due_date: null,
    warnings: [],
  };
  const title: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.startsWith("#") && word.length > 1) {
      const name = word.slice(1);
      capture.tags.push({ name, id: byName(snap.tags, name) });
    } else if (word.startsWith("@") && word.length > 1) {
      const name = word.slice(1);
      capture.project = { name, id: byName(snap.projects, name) };
    } else if (word.startsWith("+epic:") && word.length > 6) {
      const name = word.slice(6);
      capture.epic = { name, id: byName(snap.epics, name) };
    } else if (/^!(urgent|high|normal|low)$/.test(word)) {
      capture.priority = word.slice(1) as Capture["priority"];
    } else title.push(word);
  }
  capture.title = title.join(" ");
  return capture;
}

/** A fake recording backend (Scribe, M19): records calls, emits levels and changes. */
export function fakeScribe(overrides: Partial<ScribeApi> = {}) {
  type Api = ScribeApi;
  type Status = ScribeStatus;
  type Audio = MeetingAudio;
  const calls: string[] = [];
  const levelHandlers: Array<(l: Levels) => void> = [];
  const progressHandlers: Array<(p: Progress) => void> = [];
  const modelHandlers: Array<(p: ModelProgress) => void> = [];
  let models: ModelInfo[] = [
    {
      id: "large-v3-turbo",
      label: "Accurate (large-v3-turbo)",
      description: "Best results.",
      download_bytes: 1_657_963_836,
      installed: false,
      active: false,
      downloading: null,
    },
    {
      id: "small",
      label: "Fast (small)",
      description: "Faster.",
      download_bytes: 521_010_528,
      installed: false,
      active: false,
      downloading: null,
    },
  ];
  const changedHandlers: Array<(id: string) => void> = [];
  const audio: Record<string, Audio | null> = {};
  let status: Status = {
    support: { recording: true, system_audio: true, note: null },
    transcription: true,
    live: null,
  };
  let settings: ScribeSettings = {
    mic_device: null,
    capture_system: true,
    consent_reminder: true,
    model: null,
    language: null,
    auto_transcribe: true,
    retention_days: 10,
  };
  const api: Api = {
    status: async () => status,
    devices: async () => [{ id: "mic-1", name: "Desk mic", is_default: true }],
    settings: async () => settings,
    saveSettings: async (next) => {
      calls.push(`save:${next.mic_device ?? ""}:${next.capture_system}`);
      settings = next;
      return next;
    },
    start: async (meetingId) => {
      calls.push(`start:${meetingId}`);
      status = {
        ...status,
        live: {
          meeting_id: meetingId,
          started_at: Date.now(),
          mic: "Desk mic",
          system: "Speakers",
        },
      };
      audio[meetingId] = {
        state: "recording",
        started_at: Date.now(),
        duration_ms: 0,
        bytes: 44,
        tracks: [],
        warnings: [],
        job: null,
        purge_at: null,
      };
      return status;
    },
    stop: async () => {
      const id = status.live?.meeting_id;
      calls.push(`stop:${id}`);
      status = { ...status, live: null };
      if (id) {
        audio[id] = {
          state: "encoding",
          started_at: 0,
          duration_ms: 65_000,
          bytes: 2_000_000,
          tracks: [
            { track: "mic", path: `meeting-audio/${id}/mic` },
            { track: "system", path: `meeting-audio/${id}/system` },
          ],
          warnings: [],
          job: null,
          purge_at: null,
        };
      }
      return status;
    },
    audio: async (meetingId) => audio[meetingId] ?? null,
    recover: async (meetingId, keep) => {
      calls.push(`recover:${meetingId}:${keep}`);
      audio[meetingId] = keep
        ? {
            state: "ready",
            started_at: 0,
            duration_ms: 30_000,
            bytes: 100_000,
            tracks: [{ track: "mic", path: `meeting-audio/${meetingId}/mic` }],
            warnings: ["The recording was interrupted; what was recorded was kept."],
            job: null,
            purge_at: null,
          }
        : null;
    },
    purge: async (meetingId) => {
      calls.push(`purge:${meetingId}`);
      audio[meetingId] = null;
    },
    usage: async () =>
      Object.entries(audio)
        .filter((e): e is [string, Audio] => e[1] !== null)
        .map(([meeting_id, a]) => ({ meeting_id, bytes: a.bytes, duration_ms: a.duration_ms })),
    url: (path) => `tm://localhost/${path}`,
    onLevels: async (handler) => {
      levelHandlers.push(handler);
      return () => undefined;
    },
    onChanged: async (handler) => {
      changedHandlers.push(handler);
      return () => undefined;
    },
    models: async () => models,
    downloadModel: async (id) => {
      calls.push(`download:${id}`);
      models = models.map((m) => (m.id === id ? { ...m, downloading: 0 } : m));
    },
    cancelDownload: async () => {
      calls.push("cancel-download");
    },
    deleteModel: async (id) => {
      calls.push(`delete-model:${id}`);
      models = models.map((m) => (m.id === id ? { ...m, installed: false, active: false } : m));
      return models;
    },
    process: async (meetingId) => {
      calls.push(`process:${meetingId}`);
      const current = audio[meetingId];
      if (current) {
        audio[meetingId] = {
          ...current,
          job: { state: "queued", step: null, fraction: 0, error: null },
        };
      }
    },
    cancelProcess: async (meetingId) => {
      calls.push(`cancel-process:${meetingId}`);
      const current = audio[meetingId];
      if (current) audio[meetingId] = { ...current, job: null };
    },
    onProgress: async (handler) => {
      progressHandlers.push(handler);
      return () => undefined;
    },
    onModelProgress: async (handler) => {
      modelHandlers.push(handler);
      return () => undefined;
    },
    ...overrides,
  };
  return {
    api,
    calls,
    audio,
    setStatus: (s: Status) => {
      status = s;
    },
    emitLevels: (l: Levels) => {
      for (const h of levelHandlers) h(l);
    },
    emitChanged: (id: string) => {
      for (const h of changedHandlers) h(id);
    },
    emitProgress: (p: Progress) => {
      for (const h of progressHandlers) h(p);
    },
    emitModelProgress: (p: ModelProgress) => {
      for (const h of modelHandlers) h(p);
    },
    setModels: (next: ModelInfo[]) => {
      models = next;
    },
    models: () => models,
  };
}
