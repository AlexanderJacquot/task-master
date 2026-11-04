import type { Project, Snapshot, Status, Task } from "../lib/types";

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
  },
  { id: STATUS.todo, name: "To do", category: "todo", color: null, rank: "a1", wip_limit: null },
  {
    id: STATUS.inProgress,
    name: "In progress",
    category: "in_progress",
    color: null,
    rank: "a2",
    wip_limit: null,
  },
  {
    id: STATUS.waiting,
    name: "Waiting",
    category: "in_progress",
    color: null,
    rank: "a3",
    wip_limit: null,
  },
  { id: STATUS.done, name: "Done", category: "done", color: null, rank: "a4", wip_limit: null },
  {
    id: STATUS.cancelled,
    name: "Cancelled",
    category: "cancelled",
    color: null,
    rank: "a5",
    wip_limit: null,
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
    priority: "normal",
    due_date: null,
    today_on: null,
    estimate_min: null,
    rank: `a${counter}`,
    tag_ids: [],
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

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { tasks: [], projects: [], epics: [], statuses, tags: [], views: [], ...overrides };
}
