import { useEffect, useState } from "react";
import { formatRange } from "../../lib/calendar";
import { formatAgo } from "../../lib/dates";
import type { Activity, FieldChange, Task } from "../../lib/types";
import { useApi, useStoreState } from "../../store/context";
import type { TaskStoreState } from "../../store/store";

const LABELS: Record<string, string> = {
  title: "Title",
  status_id: "Status",
  priority: "Priority",
  due_date: "Due",
  today_on: "Today",
  estimate_min: "Estimate",
  project_id: "Project",
  epic_id: "Epic",
  parent_id: "Parent",
};

type Lookup = Pick<TaskStoreState, "statuses" | "projects" | "epics" | "tasks" | "tags">;

function display(field: string, json: string, lookup: Lookup): string {
  const value: unknown = JSON.parse(json);
  if (value === null) return "none";
  const id = String(value);
  switch (field) {
    case "status_id":
      return lookup.statuses.find((s) => s.id === id)?.name ?? "?";
    case "project_id":
      return lookup.projects[id]?.name ?? "a deleted project";
    case "epic_id":
      return lookup.epics[id]?.name ?? "a deleted epic";
    case "parent_id":
      return lookup.tasks[id]?.title ?? "a deleted task";
    case "estimate_min":
      return `${id} min`;
    default:
      return id;
  }
}

function describe(entry: Activity, lookup: Lookup): string[] {
  switch (entry.kind) {
    case "create":
      return ["Created"];
    case "delete":
      return ["Deleted"];
    case "restore":
      return ["Restored"];
    case "attach":
    case "detach":
    case "rename_attachment": {
      const field = entry.fields[0];
      const name = (field && (JSON.parse(field.after) as string | null)) ?? "a file";
      if (entry.kind === "attach") return [`Attached ${name}`];
      if (entry.kind === "detach") return [`Removed the attachment ${name}`];
      const before = (field && (JSON.parse(field.before) as string | null)) ?? "a file";
      return [`Renamed the attachment ${before} → ${name}`];
    }
    case "schedule":
    case "unschedule":
    case "reschedule": {
      const time = (name: string) => {
        const f = entry.fields.find((x) => x.field === name);
        const ms = f ? (JSON.parse(f.after) as number | null) : null;
        return ms === null ? null : ms;
      };
      const start = time("start_at");
      const end = time("end_at");
      const when =
        start !== null && end !== null
          ? `${new Date(start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${formatRange(start, end)}`
          : "a time";
      if (entry.kind === "schedule") return [`Scheduled for ${when}`];
      if (entry.kind === "unschedule") return [`Removed from the calendar (${when})`];
      return [`Rescheduled to ${when}`];
    }
    case "block_outcome": {
      const outcome = JSON.parse(entry.fields[0]?.after ?? "null") as string | null;
      return [`Marked a time block ${outcome ?? "planned"}`];
    }
    case "link":
    case "unlink": {
      const tagId = JSON.parse(entry.fields[0]?.after ?? "null") as string | null;
      const name = (tagId && lookup.tags[tagId]?.name) ?? "a deleted tag";
      return [`${entry.kind === "link" ? "Added" : "Removed"} tag #${name}`];
    }
    default:
      return entry.fields.flatMap((f: FieldChange) => {
        if (f.field === "description") return ["Edited the description"];
        if (f.field === "rank") return ["Reordered"];
        if (f.field === "completed_at" || f.field === "deleted_at") return [];
        const label = LABELS[f.field] ?? f.field;
        return [
          `${label}: ${display(f.field, f.before, lookup)} → ${display(f.field, f.after, lookup)}`,
        ];
      });
  }
}

/** The task's history from the ops log, refreshed after every change to the task. */
export function ActivityFeed({ task }: { task: Task }) {
  const api = useApi();
  const statuses = useStoreState((s) => s.statuses);
  const projects = useStoreState((s) => s.projects);
  const epics = useStoreState((s) => s.epics);
  const tasks = useStoreState((s) => s.tasks);
  const tags = useStoreState((s) => s.tags);
  const [entries, setEntries] = useState<Activity[]>([]);

  useEffect(() => {
    let live = true;
    // Re-read when the task changes (updated_at moves on every write to it).
    void task.updated_at;
    api.taskActivity(task.id, 50).then(
      (list) => live && setEntries(list),
      () => live && setEntries([]),
    );
    return () => {
      live = false;
    };
  }, [api, task.id, task.updated_at]);

  const lookup = { statuses, projects, epics, tasks, tags };
  return (
    <ol className="flex flex-col gap-1 text-xs text-neutral-500">
      {entries.flatMap((entry) =>
        describe(entry, lookup).map((line) => (
          <li key={`${entry.seq}-${line}`} className="flex gap-2">
            <span className="w-20 shrink-0 text-neutral-400">{formatAgo(entry.at)}</span>
            <span className="min-w-0 flex-1">{line}</span>
          </li>
        )),
      )}
    </ol>
  );
}
