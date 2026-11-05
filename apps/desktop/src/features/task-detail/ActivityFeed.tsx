import { Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cx } from "../../components/ui";
import { formatRange } from "../../lib/calendar";
import { formatAgo } from "../../lib/dates";
import { diffLines } from "../../lib/diff";
import {
  isEmptyPlan,
  isRestorable,
  type Known,
  planRestore,
  type RestorePlan,
} from "../../lib/history";
import type { Activity, FieldChange, Task } from "../../lib/types";
import { restoreTask } from "../../store/actions";
import { useApi, useStoreState, useTaskStore } from "../../store/context";
import type { TaskStoreState } from "../../store/store";

const DESCRIPTION_LINE = "Edited the description";

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
        if (f.field === "description") return [DESCRIPTION_LINE];
        if (f.field === "rank") return ["Reordered"];
        if (f.field === "completed_at" || f.field === "deleted_at") return [];
        const label = LABELS[f.field] ?? f.field;
        return [
          `${label}: ${display(f.field, f.before, lookup)} → ${display(f.field, f.after, lookup)}`,
        ];
      });
  }
}

/** A description edit, line by line: removed lines struck through, added ones tinted. */
function DescriptionDiff({ field }: { field: FieldChange }) {
  const before = (JSON.parse(field.before) as string | null) ?? "";
  const after = (JSON.parse(field.after) as string | null) ?? "";
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const changed = lines.some((l) => l.kind !== "same");
  return (
    <pre className="mt-1 max-h-60 overflow-auto rounded-md border border-line bg-hover/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
      {!changed && <span className="text-ink-3">Only whitespace changed.</span>}
      {lines.map((l, i) => (
        <div
          // Lines repeat, so position is part of the identity here.
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff is a fixed, ordered list
          key={i}
          className={cx(
            l.kind === "add" && "bg-emerald-600/12 text-emerald-800 dark:text-emerald-200",
            l.kind === "del" && "bg-danger/10 text-danger line-through",
            l.kind === "same" && "text-ink-3",
          )}
        >
          {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}
          {l.text || " "}
        </div>
      ))}
    </pre>
  );
}

const quiet =
  "rounded px-1 text-ink-3 underline-offset-2 hover:text-ink hover:underline focus-visible:outline-1 focus-visible:outline-accent";

/**
 * The task's history from the ops log, refreshed after every change to the task. Each
 * change can be expanded (description diffs), and the task can go back to how it was
 * after any of them ("Restore", on hover) or just before the latest ("Undo last change").
 */
export function ActivityFeed({ task }: { task: Task }) {
  const api = useApi();
  const store = useTaskStore();
  const statuses = useStoreState((s) => s.statuses);
  const projects = useStoreState((s) => s.projects);
  const epics = useStoreState((s) => s.epics);
  const tasks = useStoreState((s) => s.tasks);
  const tags = useStoreState((s) => s.tags);
  const [entries, setEntries] = useState<Activity[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
  const known: Known = useMemo(
    () => ({
      statuses: new Set(statuses.map((s) => s.id)),
      projects: new Set(Object.keys(projects)),
      epics: new Set(Object.keys(epics)),
      tags: new Set(Object.keys(tags)),
    }),
    [statuses, projects, epics, tags],
  );

  // Restoring entry i's version: possible when something after it can be put back.
  const plans = useMemo(
    () => entries.map((_, i) => (i === 0 ? null : planRestore(task, entries, i, known))),
    [entries, task, known],
  );
  const lastIndex = entries.findIndex(isRestorable);
  const undoPlan = lastIndex >= 0 ? planRestore(task, entries, lastIndex + 1, known) : null;
  const lastEntry = lastIndex >= 0 ? entries[lastIndex] : undefined;

  const restore = async (plan: RestorePlan, done: string) => {
    if ((await restoreTask(store, task.id, plan)) === null) return;
    const skipped = plan.skipped.length ? ` Not put back: ${plan.skipped.join(", ")}.` : "";
    setNote(`${done} Ctrl+Z takes it back.${skipped}`);
  };

  return (
    <div className="flex flex-col gap-1.5 text-xs text-ink-3">
      {undoPlan && lastEntry && !isEmptyPlan(undoPlan) && (
        <div className="flex justify-end">
          <button
            type="button"
            title={`Undo: ${describe(lastEntry, lookup).join("; ")}`}
            onClick={() => void restore(undoPlan, "Undid the last change.")}
            className={cx(quiet, "inline-flex items-center gap-1")}
          >
            <Undo2 size={12} /> Undo last change
          </button>
        </div>
      )}
      <ol className="flex flex-col">
        {entries.map((entry, i) => {
          const lines = describe(entry, lookup);
          if (!lines.length) return null;
          const description = entry.fields.find((f) => f.field === "description");
          const plan = plans[i];
          const restorable = plan && !isEmptyPlan(plan);
          return (
            <li
              key={entry.seq}
              className="group/entry -mx-1 flex gap-2 rounded px-1 py-0.5 hover:bg-hover/60"
            >
              <span className="w-20 shrink-0 text-ink-3/80">{formatAgo(entry.at)}</span>
              <div className="min-w-0 flex-1">
                {lines.map((line) =>
                  description && line === DESCRIPTION_LINE ? (
                    <div key={line}>
                      <button
                        type="button"
                        aria-expanded={open === entry.seq}
                        onClick={() => setOpen(open === entry.seq ? null : entry.seq)}
                        className="text-left text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink"
                      >
                        {line}
                      </button>
                      {open === entry.seq && <DescriptionDiff field={description} />}
                    </div>
                  ) : (
                    <div key={line} className="text-ink-2">
                      {line}
                    </div>
                  ),
                )}
              </div>
              {restorable && (
                <button
                  type="button"
                  aria-label={`Restore the version from ${formatAgo(entry.at)}`}
                  title="Put the task back as it was right after this change"
                  onClick={() => void restore(plan, "Restored that version.")}
                  className={cx(
                    quiet,
                    "shrink-0 self-start opacity-0 group-hover/entry:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  Restore
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {note && (
        <p role="status" className="text-ink-2">
          {note}
        </p>
      )}
    </div>
  );
}
