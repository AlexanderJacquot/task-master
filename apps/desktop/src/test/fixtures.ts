import type {
  AgentSession,
  Attachment,
  Capture,
  Project,
  Snapshot,
  Status,
  Task,
  TimeBlock,
} from "../lib/types";

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
    rank: `a${counter}`,
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
    rank: `a${counter}`,
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
    error: null,
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
