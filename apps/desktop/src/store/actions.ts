// User actions: each builds the core command(s) plus the optimistic entities to show
// immediately. Ids and ranks are computed here and sent, so local and confirmed rows agree.

import { rankBetween } from "../lib/rank";
import type { Priority, Project, Status, Tag, Task, TaskChange } from "../lib/types";
import { uuidv7 } from "../lib/uuid";
import { childrenByParent, compareRank, descendantIds } from "../lib/views";
import type { TaskStore } from "./store";

export interface NewTaskInput {
  title: string;
  project_id?: string | null;
  epic_id?: string | null;
  parent_id?: string | null;
  status_id?: string;
  priority?: Priority;
  due_date?: string | null;
  today_on?: string | null;
}

function firstStatus(statuses: Status[], category: Status["category"]): Status | undefined {
  return statuses.find((s) => s.category === category);
}

function lastRank<T extends { rank: string }>(
  items: Iterable<T>,
  keep: (item: T) => boolean,
): string | null {
  let max: string | null = null;
  for (const item of items) if (keep(item) && (max === null || item.rank > max)) max = item.rank;
  return max;
}

export async function createTask(store: TaskStore, input: NewTaskInput): Promise<string | null> {
  const s = store.getState();
  const title = input.title.trim();
  if (!title) return null;
  const parent = input.parent_id ? s.tasks[input.parent_id] : undefined;
  const status =
    (input.status_id && s.statuses.find((st) => st.id === input.status_id)) ||
    firstStatus(s.statuses, "todo") ||
    s.statuses[0];
  if (!status) return null;
  const now = Date.now();
  const id = uuidv7(now);
  // Subtasks go to the end of their parent's checklist, others to the end of the column.
  const rank = rankBetween(
    parent
      ? lastRank(Object.values(s.tasks), (t) => t.parent_id === parent.id)
      : lastRank(Object.values(s.tasks), (t) => t.status_id === status.id),
    null,
  );
  const task: Task = {
    id,
    project_id: input.project_id ?? parent?.project_id ?? null,
    epic_id: input.epic_id ?? parent?.epic_id ?? null,
    parent_id: input.parent_id ?? null,
    status_id: status.id,
    title,
    description: "",
    priority: input.priority ?? "normal",
    due_date: input.due_date ?? null,
    today_on: input.today_on ?? null,
    estimate_min: null,
    rank,
    tag_ids: [],
    created_at: now,
    updated_at: now,
    completed_at: status.category === "done" ? now : null,
    deleted_at: null,
  };
  const changes = await store.getState().mutate(
    [
      {
        type: "create_task",
        task: {
          id,
          title,
          project_id: task.project_id,
          epic_id: task.epic_id,
          parent_id: task.parent_id,
          status_id: status.id,
          priority: task.priority,
          due_date: task.due_date,
          today_on: task.today_on,
          rank,
        },
      },
    ],
    { upsert: { tasks: [task] } },
  );
  return changes ? id : null;
}

/** Applies changes to a copy of the task the way the core will (for optimistic display). */
export function applyTaskChanges(
  task: Task,
  changes: TaskChange[],
  statuses: Status[],
  now: number,
): Task {
  const next: Task = { ...task, updated_at: now };
  const categoryOf = (id: string) => statuses.find((s) => s.id === id)?.category;
  for (const change of changes) {
    if ("title" in change && change.title !== undefined) next.title = change.title.trim();
    else if ("description" in change && change.description !== undefined)
      next.description = change.description;
    else if ("priority" in change && change.priority !== undefined) next.priority = change.priority;
    else if ("due_date" in change) next.due_date = change.due_date ?? null;
    else if ("today_on" in change) next.today_on = change.today_on ?? null;
    else if ("estimate_min" in change) next.estimate_min = change.estimate_min ?? null;
    else if ("project_id" in change) next.project_id = change.project_id ?? null;
    else if ("epic_id" in change) next.epic_id = change.epic_id ?? null;
    else if ("rank" in change && change.rank !== undefined) next.rank = change.rank;
    else if ("status_id" in change && change.status_id !== undefined) {
      const wasDone = categoryOf(next.status_id) === "done";
      const isDone = categoryOf(change.status_id) === "done";
      if (isDone && !wasDone) next.completed_at = now;
      if (!isDone && wasDone) next.completed_at = null;
      next.status_id = change.status_id;
    }
  }
  return next;
}

export function updateTask(store: TaskStore, id: string, changes: TaskChange[]) {
  const s = store.getState();
  const task = s.tasks[id];
  if (!task || !changes.length) return Promise.resolve(null);
  const updated = applyTaskChanges(task, changes, s.statuses, Date.now());
  return s.mutate([{ type: "update_task", id, changes }], { upsert: { tasks: [updated] } });
}

/** Checkbox: open → first `done` status; done → first `todo` status. */
export function toggleDone(store: TaskStore, id: string) {
  const s = store.getState();
  const task = s.tasks[id];
  if (!task) return Promise.resolve(null);
  const current = s.statuses.find((st) => st.id === task.status_id)?.category;
  const target =
    current === "done" ? firstStatus(s.statuses, "todo") : firstStatus(s.statuses, "done");
  if (!target) return Promise.resolve(null);
  return updateTask(store, id, [{ status_id: target.id }]);
}

/** Soft-deletes the task and its subtasks (undo restores them). */
export function deleteTask(store: TaskStore, id: string) {
  const s = store.getState();
  if (!s.tasks[id]) return Promise.resolve(null);
  const ids = [id, ...descendantIds(id, childrenByParent(Object.values(s.tasks)))];
  return s.mutate([{ type: "delete_task", id }], { remove: { tasks: ids } });
}

/** Makes `id` a subtask of `parentId`, or a top-level task when null. */
export function setParent(store: TaskStore, id: string, parentId: string | null) {
  const s = store.getState();
  const task = s.tasks[id];
  if (!task) return Promise.resolve(null);
  const parent = parentId ? s.tasks[parentId] : undefined;
  const updated: Task = {
    ...task,
    parent_id: parentId,
    project_id: parent ? parent.project_id : task.project_id,
    epic_id: parent ? parent.epic_id : task.epic_id,
    updated_at: Date.now(),
  };
  return s.mutate([{ type: "set_parent", id, parent_id: parentId }], {
    upsert: { tasks: [updated] },
  });
}

/** Moves a subtask one step up or down its parent's checklist. */
export function moveSubtask(store: TaskStore, id: string, direction: -1 | 1) {
  const s = store.getState();
  const task = s.tasks[id];
  if (!task?.parent_id) return Promise.resolve(null);
  const siblings = Object.values(s.tasks)
    .filter((t) => t.parent_id === task.parent_id)
    .sort(compareRank);
  const index = siblings.findIndex((t) => t.id === id);
  const target = index + direction;
  if (target < 0 || target >= siblings.length) return Promise.resolve(null);
  // New neighbours once moved: [target-1, target] going up, [target, target+1] going down.
  const before = direction < 0 ? siblings[target - 1] : siblings[target];
  const after = direction < 0 ? siblings[target] : siblings[target + 1];
  const rank = rankBetween(before?.rank ?? null, after?.rank ?? null);
  return updateTask(store, id, [{ rank }]);
}

export function setTagged(store: TaskStore, taskId: string, tagId: string, tagged: boolean) {
  const s = store.getState();
  const task = s.tasks[taskId];
  if (!task || task.tag_ids.includes(tagId) === tagged) return Promise.resolve(null);
  const tag_ids = tagged
    ? [...task.tag_ids, tagId].sort()
    : task.tag_ids.filter((t) => t !== tagId);
  return s.mutate([{ type: tagged ? "tag_task" : "untag_task", task_id: taskId, tag_id: tagId }], {
    upsert: { tasks: [{ ...task, tag_ids, updated_at: Date.now() }] },
  });
}

/** Creates a tag and adds it to a task in one undoable batch. */
export async function createTagOnTask(store: TaskStore, taskId: string, rawName: string) {
  const name = rawName.trim().replace(/^#/, "");
  const s = store.getState();
  const task = s.tasks[taskId];
  if (!name || !task) return null;
  const now = Date.now();
  const tag: Tag = {
    id: uuidv7(now),
    name,
    color: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  return s.mutate(
    [
      { type: "create_tag", tag: { id: tag.id, name } },
      { type: "tag_task", task_id: taskId, tag_id: tag.id },
    ],
    {
      upsert: {
        tags: [tag],
        tasks: [{ ...task, tag_ids: [...task.tag_ids, tag.id].sort(), updated_at: now }],
      },
    },
  );
}

export async function createProject(
  store: TaskStore,
  rawName: string,
  parentId: string | null = null,
): Promise<string | null> {
  const name = rawName.trim();
  const s = store.getState();
  if (!name) return null;
  const now = Date.now();
  const rank = rankBetween(
    lastRank(Object.values(s.projects), (p) => p.parent_id === parentId),
    null,
  );
  const project: Project = {
    id: uuidv7(now),
    parent_id: parentId,
    name,
    color: null,
    icon: null,
    rank,
    archived_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  const changes = await s.mutate(
    [{ type: "create_project", project: { id: project.id, name, parent_id: parentId, rank } }],
    { upsert: { projects: [project] } },
  );
  return changes ? project.id : null;
}

export async function createEpic(store: TaskStore, rawName: string): Promise<string | null> {
  const name = rawName.trim();
  const s = store.getState();
  if (!name) return null;
  const now = Date.now();
  const rank = rankBetween(
    lastRank(Object.values(s.epics), () => true),
    null,
  );
  const id = uuidv7(now);
  const changes = await s.mutate([{ type: "create_epic", epic: { id, name, rank } }], {
    upsert: {
      epics: [
        {
          id,
          project_id: null,
          name,
          description: null,
          target_date: null,
          state: "active",
          rank,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        },
      ],
    },
  });
  return changes ? id : null;
}
