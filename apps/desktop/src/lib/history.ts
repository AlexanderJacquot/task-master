// Task versions from the activity feed: "restore this version" undoes, field by field, every
// change recorded after it. The result is an ordinary edit (update_task, tag_task,
// untag_task) in one batch, so it shows in the activity and Ctrl+Z takes it back.

import type { Activity, Task, TaskChange } from "./types";

/** Fields an update can put back. Rank, timestamps and the parent are left alone. */
const REVERTIBLE = [
  "title",
  "description",
  "status_id",
  "priority",
  "due_date",
  "today_on",
  "estimate_min",
  "project_id",
  "epic_id",
] as const;
type Field = (typeof REVERTIBLE)[number];

const isRevertible = (field: string): field is Field =>
  (REVERTIBLE as readonly string[]).includes(field);

/** Ids that still exist, so a restore never points at a deleted status, project, epic or tag. */
export interface Known {
  statuses: Set<string>;
  projects: Set<string>;
  epics: Set<string>;
  tags: Set<string>;
}

export interface RestorePlan {
  changes: TaskChange[];
  addTags: string[];
  removeTags: string[];
  /** What could not be put back, in words ("an attachment", "a deleted project"). */
  skipped: string[];
}

export function isEmptyPlan(plan: RestorePlan): boolean {
  return !plan.changes.length && !plan.addTags.length && !plan.removeTags.length;
}

/** Whether an entry changed something a restore can act on. */
export function isRestorable(entry: Activity): boolean {
  if (entry.kind === "link" || entry.kind === "unlink") return true;
  return entry.kind === "update" && entry.fields.some((f) => isRevertible(f.field));
}

/**
 * The edit that brings `task` back to how it was right after `entries[index]`, undoing
 * `entries[0..index-1]`. `entries` is newest first, as task_activity returns it.
 */
export function planRestore(
  task: Task,
  entries: Activity[],
  index: number,
  known: Known,
): RestorePlan {
  const later = entries.slice(0, index);
  // Oldest later change first: its `before` is the value the version had.
  const fields = new Map<Field, unknown>();
  const tags = new Map<string, boolean>();
  const skipped = new Set<string>();
  for (const entry of [...later].reverse()) {
    if (entry.kind === "link" || entry.kind === "unlink") {
      const tagId = JSON.parse(entry.fields[0]?.after ?? "null") as string | null;
      // Before a link the tag was absent; before an unlink it was there.
      if (tagId && !tags.has(tagId)) tags.set(tagId, entry.kind === "unlink");
      continue;
    }
    if (entry.kind !== "update") {
      if (["attach", "detach", "rename_attachment"].includes(entry.kind)) skipped.add("files");
      else if (["schedule", "unschedule", "reschedule", "block_outcome"].includes(entry.kind))
        skipped.add("calendar blocks");
      continue;
    }
    for (const f of entry.fields) {
      if (isRevertible(f.field) && !fields.has(f.field)) {
        fields.set(f.field, JSON.parse(f.before) as unknown);
      }
    }
  }

  const changes: TaskChange[] = [];
  for (const [field, value] of fields) {
    if (value === (task[field] ?? null)) continue;
    const missing =
      (field === "status_id" && !known.statuses.has(String(value))) ||
      (field === "project_id" && value !== null && !known.projects.has(String(value))) ||
      (field === "epic_id" && value !== null && !known.epics.has(String(value)));
    if (missing) {
      skipped.add(`a deleted ${field.replace("_id", "")}`);
      continue;
    }
    changes.push({ [field]: value } as TaskChange);
  }

  const addTags: string[] = [];
  const removeTags: string[] = [];
  for (const [tagId, present] of tags) {
    const now = task.tag_ids.includes(tagId);
    if (present === now) continue;
    if (present && !known.tags.has(tagId)) {
      skipped.add("a deleted tag");
      continue;
    }
    (present ? addTags : removeTags).push(tagId);
  }
  return { changes, addTags, removeTags, skipped: [...skipped] };
}
