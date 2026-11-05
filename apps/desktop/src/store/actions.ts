// User actions: each builds the core command(s) plus the optimistic entities to show
// immediately. Ids and ranks are computed here and sent, so local and confirmed rows agree.

import { ranksForDrop } from "../lib/board";
import type { RestorePlan } from "../lib/history";
import { rankBetween } from "../lib/rank";
import type {
  Attachment,
  BlockOutcome,
  Capture,
  Command,
  Epic,
  EpicChange,
  Priority,
  Project,
  ProjectChange,
  Status,
  StatusChange,
  StoredUpload,
  Tag,
  Task,
  TaskChange,
  TimeBlock,
  TimeBlockChange,
  View,
  ViewChange,
  ViewSpec,
} from "../lib/types";
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
  tag_ids?: string[];
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

/** Commands and entities to send in the same batch as a new task (capture's new tags...). */
export interface WithTask {
  before?: Command[];
  upsert?: { tags?: Tag[]; projects?: Project[]; epics?: Epic[] };
  /** Also puts the new task on the calendar (same batch, so one undo removes both). */
  schedule?: { start_at: number; end_at: number };
}

export async function createTask(
  store: TaskStore,
  input: NewTaskInput,
  extra: WithTask = {},
): Promise<string | null> {
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
    owner: "me",
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
    dependency_ids: [],
    tag_ids: [...new Set(input.tag_ids ?? [])].sort(),
    created_at: now,
    updated_at: now,
    completed_at: status.category === "done" ? now : null,
    deleted_at: null,
  };
  const block: TimeBlock | null =
    extra.schedule && extra.schedule.end_at > extra.schedule.start_at
      ? {
          id: uuidv7(now),
          task_id: id,
          start_at: extra.schedule.start_at,
          end_at: extra.schedule.end_at,
          outcome: "planned",
          created_at: now,
          updated_at: now,
          deleted_at: null,
        }
      : null;
  const changes = await store.getState().mutate(
    [
      ...(extra.before ?? []),
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
          tag_ids: task.tag_ids,
        },
      },
      ...(block
        ? [
            {
              type: "create_time_block" as const,
              block: {
                id: block.id,
                task_id: id,
                start_at: block.start_at,
                end_at: block.end_at,
                outcome: "planned" as const,
              },
            },
          ]
        : []),
    ],
    { upsert: { ...extra.upsert, tasks: [task], ...(block && { time_blocks: [block] }) } },
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
    if ("dependency_ids" in change && change.dependency_ids !== undefined)
      next.dependency_ids = [...new Set(change.dependency_ids)].sort();
    else if ("title" in change && change.title !== undefined) next.title = change.title.trim();
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

/** Puts a task back to an earlier version (lib/history.ts) as one undoable batch. */
export function restoreTask(store: TaskStore, id: string, plan: RestorePlan) {
  const s = store.getState();
  const task = s.tasks[id];
  if (!task) return Promise.resolve(null);
  const commands: Command[] = [];
  if (plan.changes.length) commands.push({ type: "update_task", id, changes: plan.changes });
  for (const tag_id of plan.addTags) commands.push({ type: "tag_task", task_id: id, tag_id });
  for (const tag_id of plan.removeTags) commands.push({ type: "untag_task", task_id: id, tag_id });
  if (!commands.length) return Promise.resolve(null);
  const updated = applyTaskChanges(task, plan.changes, s.statuses, Date.now());
  const tag_ids = [
    ...updated.tag_ids.filter((t) => !plan.removeTags.includes(t)),
    ...plan.addTags.filter((t) => !updated.tag_ids.includes(t)),
  ].sort();
  return s.mutate(commands, { upsert: { tasks: [{ ...updated, tag_ids }] } });
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

/** Deletes a tag; the core takes it off every task in the same undoable batch. */
export function deleteTag(store: TaskStore, id: string) {
  const s = store.getState();
  if (!s.tags[id]) return Promise.resolve(null);
  const now = Date.now();
  const untagged = Object.values(s.tasks)
    .filter((t) => t.tag_ids.includes(id))
    .map((t) => ({ ...t, tag_ids: t.tag_ids.filter((x) => x !== id), updated_at: now }));
  return s.mutate([{ type: "delete_tag", id }], {
    remove: { tags: [id] },
    upsert: { tasks: untagged },
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
          color: null,
          icon: null,
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

export interface CardDrop {
  id: string;
  statusId: string;
  /** The target cell's card ids, top to bottom, the moved card included. */
  order: string[];
  /** What the target swimlane sets (project, epic or priority); empty without lanes. */
  laneChanges?: TaskChange[];
}

/** True when `change` would leave the task as it is. */
function isNoop(task: Task, change: TaskChange): boolean {
  if ("project_id" in change) return (change.project_id ?? null) === task.project_id;
  if ("epic_id" in change) return (change.epic_id ?? null) === task.epic_id;
  if ("priority" in change) return change.priority === task.priority;
  return false;
}

/**
 * A board drop: new column, position and (with swimlanes) lane, as one undoable batch.
 * The rank comes from the new neighbours; the core rebalances the column if it grows long.
 */
export function moveCard(store: TaskStore, drop: CardDrop) {
  const s = store.getState();
  const task = s.tasks[drop.id];
  if (!task) return Promise.resolve(null);
  const ranks: Record<string, string> = {};
  for (const id of drop.order) {
    const rank = s.tasks[id]?.rank;
    if (rank !== undefined) ranks[id] = rank;
  }
  const order = drop.order.filter((id) => id in ranks);
  const newRanks = ranksForDrop(order, drop.id, ranks);
  const laneChanges = (drop.laneChanges ?? []).filter((c) => !isNoop(task, c));

  const now = Date.now();
  const commands: Command[] = [];
  const upserts: Task[] = [];
  const rank = newRanks[drop.id] as string;
  if (laneChanges.length) {
    const changes: TaskChange[] = [{ status_id: drop.statusId }, { rank }, ...laneChanges];
    commands.push({ type: "update_task", id: drop.id, changes });
    upserts.push(applyTaskChanges(task, changes, s.statuses, now));
  } else {
    commands.push({ type: "move_task", id: drop.id, status_id: drop.statusId, rank });
    upserts.push(applyTaskChanges(task, [{ status_id: drop.statusId }, { rank }], s.statuses, now));
  }
  for (const [id, key] of Object.entries(newRanks)) {
    const other = s.tasks[id];
    if (id === drop.id || !other) continue;
    commands.push({ type: "update_task", id, changes: [{ rank: key }] });
    upserts.push(applyTaskChanges(other, [{ rank: key }], s.statuses, now));
  }
  return s.mutate(commands, { upsert: { tasks: upserts } });
}

// ---------------------------------------------------------------------------------------
// Saved views

export async function createView(
  store: TaskStore,
  rawName: string,
  spec: ViewSpec,
): Promise<string | null> {
  const name = rawName.trim();
  const s = store.getState();
  if (!name) return null;
  const now = Date.now();
  const rank = rankBetween(
    lastRank(Object.values(s.views), () => true),
    null,
  );
  const view: View = {
    id: uuidv7(now),
    name,
    spec,
    rank,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  const changes = await s.mutate(
    [{ type: "create_view", view: { id: view.id, name, spec, rank } }],
    { upsert: { views: [view] } },
  );
  return changes ? view.id : null;
}

export function updateView(store: TaskStore, id: string, changes: ViewChange[]) {
  const s = store.getState();
  const view = s.views[id];
  if (!view || !changes.length) return Promise.resolve(null);
  const next: View = { ...view, updated_at: Date.now() };
  for (const change of changes) {
    if ("name" in change && change.name !== undefined) next.name = change.name.trim();
    else if ("spec" in change && change.spec !== undefined) next.spec = change.spec as ViewSpec;
    else if ("rank" in change && change.rank !== undefined) next.rank = change.rank;
  }
  return s.mutate([{ type: "update_view", id, changes }], { upsert: { views: [next] } });
}

export function deleteView(store: TaskStore, id: string) {
  const s = store.getState();
  if (!s.views[id]) return Promise.resolve(null);
  return s.mutate([{ type: "delete_view", id }], { remove: { views: [id] } });
}

// ---------------------------------------------------------------------------------------
// Projects and epics

export function updateProject(store: TaskStore, id: string, changes: ProjectChange[]) {
  const s = store.getState();
  const project = s.projects[id];
  if (!project || !changes.length) return Promise.resolve(null);
  const now = Date.now();
  const next: Project = { ...project, updated_at: now };
  for (const c of changes) {
    if ("name" in c && c.name !== undefined) next.name = c.name.trim();
    else if ("color" in c) next.color = c.color ?? null;
    else if ("icon" in c) next.icon = c.icon ?? null;
    else if ("parent_id" in c) next.parent_id = c.parent_id ?? null;
    else if ("rank" in c && c.rank !== undefined) next.rank = c.rank;
    else if ("archived" in c && c.archived !== undefined)
      next.archived_at = c.archived ? (project.archived_at ?? now) : null;
  }
  return s.mutate([{ type: "update_project", id, changes }], { upsert: { projects: [next] } });
}

/** Refused by the core while the project holds tasks, epics or projects (shown as a toast). */
export function deleteProject(store: TaskStore, id: string) {
  const s = store.getState();
  if (!s.projects[id]) return Promise.resolve(null);
  return s.mutate([{ type: "delete_project", id }], { remove: { projects: [id] } });
}

/**
 * Moves a project among its siblings (same area, or the top level), or into another area
 * (`parentId`), landing between `before` and `after` (ids of its new neighbours).
 */
export function moveProject(
  store: TaskStore,
  id: string,
  parentId: string | null,
  before: string | null,
  after: string | null,
) {
  const s = store.getState();
  const project = s.projects[id];
  if (!project) return Promise.resolve(null);
  const rankOf = (pid: string | null) => (pid ? (s.projects[pid]?.rank ?? null) : null);
  let low = rankOf(before);
  let high = rankOf(after);
  if (low !== null && high !== null && low >= high) high = null;
  if (low === null && high === null && parentId !== project.parent_id) {
    // Into another area with no neighbours given: append.
    low = lastRank(Object.values(s.projects), (p) => p.parent_id === parentId && p.id !== id);
  }
  const rank = rankBetween(low, high);
  const changes: ProjectChange[] = [{ rank }];
  if (parentId !== project.parent_id) changes.unshift({ parent_id: parentId });
  return updateProject(store, id, changes);
}

export function updateEpic(store: TaskStore, id: string, changes: EpicChange[]) {
  const s = store.getState();
  const epic = s.epics[id];
  if (!epic || !changes.length) return Promise.resolve(null);
  const next: Epic = { ...epic, updated_at: Date.now() };
  for (const c of changes) {
    if ("name" in c && c.name !== undefined) next.name = c.name.trim();
    else if ("color" in c) next.color = c.color ?? null;
    else if ("icon" in c) next.icon = c.icon ?? null;
    else if ("description" in c) next.description = c.description ?? null;
    else if ("target_date" in c) next.target_date = c.target_date ?? null;
    else if ("state" in c && c.state !== undefined) next.state = c.state;
    else if ("project_id" in c) next.project_id = c.project_id ?? null;
    else if ("rank" in c && c.rank !== undefined) next.rank = c.rank;
  }
  return s.mutate([{ type: "update_epic", id, changes }], { upsert: { epics: [next] } });
}

/** Deletes the epic; its tasks stay, without an epic (undo restores both). */
export function deleteEpic(store: TaskStore, id: string) {
  const s = store.getState();
  if (!s.epics[id]) return Promise.resolve(null);
  const now = Date.now();
  const detached = Object.values(s.tasks)
    .filter((t) => t.epic_id === id)
    .map((t) => ({ ...t, epic_id: null, updated_at: now }));
  return s.mutate([{ type: "delete_epic", id }], {
    remove: { epics: [id] },
    upsert: { tasks: detached },
  });
}

// ---------------------------------------------------------------------------------------
// Quick capture

/** What a capture still needs the user to confirm: names that match nothing yet. */
export function missingContainers(capture: Capture): string[] {
  const out: string[] = [];
  if (capture.project && !capture.project.id) out.push(`project "${capture.project.name}"`);
  if (capture.epic && !capture.epic.id) out.push(`epic "${capture.epic.name}"`);
  return out;
}

/**
 * Creates the task a capture line describes, as one undoable batch: unknown tags are
 * created; an unknown project or epic is created too (the caller asks first, see
 * `missingContainers`). Markers in the line win over the view's defaults.
 */
export async function captureTask(
  store: TaskStore,
  capture: Capture,
  defaults: Omit<NewTaskInput, "title"> = {},
  schedule?: WithTask["schedule"],
): Promise<string | null> {
  const s = store.getState();
  const title = capture.title.trim();
  if (!title) return null;
  const now = Date.now();
  const commands: Command[] = [];
  const upsert: { tags: Tag[]; projects: Project[]; epics: Epic[] } = {
    tags: [],
    projects: [],
    epics: [],
  };

  const tagIds = capture.tags.map((t) => {
    if (t.id) return t.id;
    const tag: Tag = {
      id: uuidv7(now),
      name: t.name,
      color: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    commands.push({ type: "create_tag", tag: { id: tag.id, name: tag.name } });
    upsert.tags.push(tag);
    return tag.id;
  });

  let projectId = defaults.project_id ?? null;
  if (capture.project) {
    projectId = capture.project.id;
    if (!projectId) {
      const rank = rankBetween(
        lastRank(Object.values(s.projects), (p) => p.parent_id === null),
        null,
      );
      const project: Project = {
        id: uuidv7(now),
        parent_id: null,
        name: capture.project.name,
        color: null,
        icon: null,
        rank,
        archived_at: null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };
      commands.push({
        type: "create_project",
        project: { id: project.id, name: project.name, parent_id: null, rank },
      });
      upsert.projects.push(project);
      projectId = project.id;
    }
  }

  let epicId = defaults.epic_id ?? null;
  if (capture.epic) {
    epicId = capture.epic.id;
    if (!epicId) {
      const rank = rankBetween(
        lastRank(Object.values(s.epics), () => true),
        null,
      );
      const epic: Epic = {
        id: uuidv7(now),
        project_id: null,
        name: capture.epic.name,
        description: null,
        target_date: null,
        state: "active",
        color: null,
        icon: null,
        rank,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };
      commands.push({ type: "create_epic", epic: { id: epic.id, name: epic.name, rank } });
      upsert.epics.push(epic);
      epicId = epic.id;
    }
  }

  const input: NewTaskInput = {
    ...defaults,
    title,
    project_id: projectId,
    epic_id: epicId,
    priority: capture.priority ?? defaults.priority,
    due_date: capture.due_date ?? defaults.due_date ?? null,
    tag_ids: [...new Set([...(defaults.tag_ids ?? []), ...tagIds])],
  };
  return createTask(store, input, { before: commands, upsert, schedule });
}

// ---------------------------------------------------------------------------------------
// Statuses (settings)

export function createStatus(store: TaskStore, rawName: string, category: Status["category"]) {
  const name = rawName.trim();
  const s = store.getState();
  if (!name) return Promise.resolve(null);
  const now = Date.now();
  const rank = rankBetween(
    lastRank(s.statuses, () => true),
    null,
  );
  const status: Status = {
    id: uuidv7(now),
    name,
    category,
    color: null,
    rank,
    wip_limit: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  return s.mutate([{ type: "create_status", status: { id: status.id, name, category, rank } }], {
    upsert: { statuses: [status] },
  });
}

export function updateStatus(store: TaskStore, id: string, changes: StatusChange[]) {
  const s = store.getState();
  const status = s.statuses.find((st) => st.id === id);
  if (!status || !changes.length) return Promise.resolve(null);
  const next: Status = { ...status, updated_at: Date.now() };
  for (const c of changes) {
    if ("name" in c && c.name !== undefined) next.name = c.name.trim();
    else if ("category" in c && c.category !== undefined) next.category = c.category;
    else if ("color" in c) next.color = c.color ?? null;
    else if ("rank" in c && c.rank !== undefined) next.rank = c.rank;
    else if ("wip_limit" in c) next.wip_limit = c.wip_limit ?? null;
  }
  return s.mutate([{ type: "update_status", id, changes }], { upsert: { statuses: [next] } });
}

/** Moves a column one step left (-1) or right (1) in the workflow. */
export function moveStatus(store: TaskStore, id: string, direction: -1 | 1) {
  const list = store.getState().statuses;
  const index = list.findIndex((st) => st.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= list.length) return Promise.resolve(null);
  const before = direction < 0 ? list[target - 1] : list[target];
  const after = direction < 0 ? list[target] : list[target + 1];
  return updateStatus(store, id, [
    { rank: rankBetween(before?.rank ?? null, after?.rank ?? null) },
  ]);
}

/** Refused by the core while tasks are in it, or for the last todo/done column. */
export function deleteStatus(store: TaskStore, id: string) {
  const s = store.getState();
  if (!s.statuses.some((st) => st.id === id)) return Promise.resolve(null);
  return s.mutate([{ type: "delete_status", id }], { remove: { statuses: [id] } });
}

// ---------------------------------------------------------------------------------------
// Attachments (ADR 011). The content is stored first (`FilesApi.store*`); these record it.

/**
 * Attaches stored files to a task in one undoable batch. Resolves to the new attachments
 * (empty when the core refused them).
 */
export async function attachFiles(
  store: TaskStore,
  taskId: string,
  uploads: StoredUpload[],
): Promise<Attachment[]> {
  const s = store.getState();
  const task = s.tasks[taskId];
  if (!task || !uploads.length) return [];
  const now = Date.now();
  const attachments: Attachment[] = uploads.map((u, i) => ({
    id: uuidv7(now + i),
    task_id: taskId,
    hash: u.hash,
    name: u.name,
    mime: u.mime,
    size: u.size,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }));
  const changes = await s.mutate(
    attachments.map((a) => ({
      type: "create_attachment" as const,
      attachment: {
        id: a.id,
        task_id: taskId,
        hash: a.hash,
        name: a.name,
        mime: a.mime,
        size: a.size,
      },
    })),
    { upsert: { attachments, tasks: [{ ...task, updated_at: now }] } },
  );
  if (!changes) return [];
  const confirmed = store.getState().attachments;
  return attachments.map((a) => confirmed[a.id] ?? a);
}

export function renameAttachment(store: TaskStore, id: string, rawName: string) {
  const s = store.getState();
  const attachment = s.attachments[id];
  const name = rawName.trim();
  if (!attachment || !name || name === attachment.name) return Promise.resolve(null);
  return s.mutate([{ type: "update_attachment", id, changes: [{ name }] }], {
    upsert: { attachments: [{ ...attachment, name, updated_at: Date.now() }] },
  });
}

export function deleteAttachment(store: TaskStore, id: string) {
  const s = store.getState();
  if (!s.attachments[id]) return Promise.resolve(null);
  return s.mutate([{ type: "delete_attachment", id }], { remove: { attachments: [id] } });
}

// ---------------------------------------------------------------------------------------
// Time blocks (M9, ADR 013)

/** Puts a task on the calendar. Resolves to the new block's id, or null when refused. */
export async function scheduleTask(
  store: TaskStore,
  taskId: string,
  start_at: number,
  end_at: number,
): Promise<string | null> {
  const s = store.getState();
  const task = s.tasks[taskId];
  if (!task || end_at <= start_at) return null;
  const now = Date.now();
  const block: TimeBlock = {
    id: uuidv7(now),
    task_id: taskId,
    start_at,
    end_at,
    outcome: "planned",
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  const changes = await s.mutate(
    [
      {
        type: "create_time_block",
        block: { id: block.id, task_id: taskId, start_at, end_at, outcome: "planned" },
      },
    ],
    { upsert: { time_blocks: [block], tasks: [{ ...task, updated_at: now }] } },
  );
  return changes ? block.id : null;
}

/** Moves or resizes a block. */
export function moveBlock(store: TaskStore, id: string, start_at: number, end_at: number) {
  const s = store.getState();
  const block = s.time_blocks[id];
  if (!block || end_at <= start_at) return Promise.resolve(null);
  const changes: TimeBlockChange[] = [];
  if (start_at !== block.start_at) changes.push({ start_at });
  if (end_at !== block.end_at) changes.push({ end_at });
  if (!changes.length) return Promise.resolve(null);
  const task = s.tasks[block.task_id];
  const now = Date.now();
  return s.mutate([{ type: "update_time_block", id, changes }], {
    upsert: {
      time_blocks: [{ ...block, start_at, end_at, updated_at: now }],
      ...(task && { tasks: [{ ...task, updated_at: now }] }),
    },
  });
}

/**
 * Sets what became of a block. `done` also completes the task (one undo), since the
 * outcome says it was finished then.
 */
export function setBlockOutcome(store: TaskStore, id: string, outcome: BlockOutcome) {
  const s = store.getState();
  const block = s.time_blocks[id];
  if (!block || block.outcome === outcome) return Promise.resolve(null);
  const now = Date.now();
  const commands: Command[] = [{ type: "update_time_block", id, changes: [{ outcome }] }];
  let task = s.tasks[block.task_id];
  const done = firstStatus(s.statuses, "done");
  const category = task && s.statuses.find((st) => st.id === task?.status_id)?.category;
  if (task && outcome === "done" && done && category !== "done" && category !== "cancelled") {
    const change: TaskChange = { status_id: done.id };
    commands.push({ type: "update_task", id: task.id, changes: [change] });
    task = applyTaskChanges(task, [change], s.statuses, now);
  }
  return s.mutate(commands, {
    upsert: {
      time_blocks: [{ ...block, outcome, updated_at: now }],
      ...(task && { tasks: [{ ...task, updated_at: now }] }),
    },
  });
}

/** Takes a block off the calendar (the task stays). */
export function deleteBlock(store: TaskStore, id: string) {
  const s = store.getState();
  const block = s.time_blocks[id];
  if (!block) return Promise.resolve(null);
  const task = s.tasks[block.task_id];
  return s.mutate([{ type: "delete_time_block", id }], {
    remove: { time_blocks: [id] },
    ...(task && { upsert: { tasks: [{ ...task, updated_at: Date.now() }] } }),
  });
}
