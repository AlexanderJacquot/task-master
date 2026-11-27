import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { LineageIcon } from "../../components/TaskIcons";
import { cx, Dot, FOCUS, SectionLabel } from "../../components/ui";
import type { Task } from "../../lib/types";
import { useStoreState } from "../../store/context";
import { closedTaskIds } from "../lineage/graph";
import { useOpenTask } from "../shell/useOpenTask";

/**
 * What a task waits on and what waits on it (its Lineage links), with a way to plan
 * them on the Lineage canvas.
 */
export function DependencyList({ task, page }: { task: Task; page: boolean }) {
  const tasks = useStoreState((s) => s.tasks);
  const statuses = useStoreState((s) => s.statuses);
  const openTask = useOpenTask();
  const navigate = useNavigate();
  const { prerequisites, dependents, closed } = useMemo(() => {
    const prerequisites = (task.dependency_ids ?? []).flatMap((id) => tasks[id] ?? []);
    const dependents = Object.values(tasks).filter((t) => t.dependency_ids?.includes(task.id));
    const closed = closedTaskIds([...prerequisites, ...dependents], statuses);
    return { prerequisites, dependents, closed };
  }, [task.id, task.dependency_ids, tasks, statuses]);
  const blockers = prerequisites.filter((t) => !closed.has(t.id));
  const statusById = new Map(statuses.map((s) => [s.id, s]));

  const row = (t: Task) => (
    <li key={t.id}>
      <button
        type="button"
        onClick={() => openTask(t.id)}
        className={cx(
          "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13.5px] hover:bg-hover",
          closed.has(t.id) ? "text-ink-3 line-through" : "text-ink-2",
          FOCUS,
        )}
      >
        <Dot color={statusById.get(t.status_id)?.color ?? null} />
        <span className="min-w-0 flex-1 truncate">{t.title}</span>
        <span className="shrink-0 text-xs text-ink-3 no-underline">
          {statusById.get(t.status_id)?.name}
        </span>
      </button>
    </li>
  );

  return (
    <section aria-label="Lineage" className={page ? "pl-10" : undefined}>
      <div className="mb-1.5 flex items-center gap-2">
        <SectionLabel className="flex-1">Lineage</SectionLabel>
        <button
          type="button"
          onClick={() => void navigate({ to: "/lineage", search: { around: task.id } })}
          title="Open the Lineage canvas on this task"
          className={cx(
            "flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[13px] text-accent hover:bg-hover",
            FOCUS,
          )}
        >
          <LineageIcon size={13} /> Plan in Lineage
        </button>
      </div>
      {!prerequisites.length && !dependents.length && (
        <p className="px-1.5 text-[13px] text-ink-3">No prerequisites or dependents.</p>
      )}
      {prerequisites.length > 0 && (
        <>
          <p className={cx("px-1.5 text-[13px]", blockers.length ? "text-danger" : "text-ink-3")}>
            {blockers.length
              ? `Blocked by ${blockers.length} open ${blockers.length === 1 ? "task" : "tasks"}`
              : "Ready: every prerequisite is done"}
          </p>
          <ul aria-label="Prerequisites">{prerequisites.map(row)}</ul>
        </>
      )}
      {dependents.length > 0 && (
        <>
          <p className="mt-2 px-1.5 text-[13px] text-ink-3">
            Waiting on this ({dependents.length})
          </p>
          <ul aria-label="Dependents">{dependents.map(row)}</ul>
        </>
      )}
    </section>
  );
}
