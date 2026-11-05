import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { Dot } from "../../components/ui";
import { isoDate } from "../../lib/dates";
import { planCandidates } from "../../lib/planDay";
import { updateTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { HeaderButton, ViewPage } from "../shell/ViewPage";

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** Suggestions to pick for today; `1`–`9` adds one, as does its button. */
function PlanMyDay({ onClose }: { onClose(): void }) {
  const store = useTaskStore();
  const tasks = useStoreState((s) => s.tasks);
  const statuses = useStoreState((s) => s.statuses);
  const projects = useStoreState((s) => s.projects);
  const today = isoDate();
  const candidates = useMemo(
    () =>
      planCandidates(Object.values(tasks), {
        today,
        statuses: Object.fromEntries(statuses.map((s) => [s.id, s])),
        projects,
      }),
    [tasks, statuses, projects, today],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const n = Number(e.key);
      const pick = Number.isInteger(n) && n >= 1 ? candidates[n - 1] : undefined;
      if (!pick) return;
      e.preventDefault();
      void updateTask(store, pick.task.id, [{ today_on: today }]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [candidates, store, today]);

  return (
    <section
      aria-label="Plan my day"
      className="mx-10 mb-3 rounded-xl border border-amber-700/25 bg-amber-500/8 px-4 py-3 dark:border-amber-400/20"
    >
      <div className="mb-1 flex items-center gap-2">
        <h2 className="flex-1 font-display text-[17px] tracking-wide text-amber-900 dark:text-amber-200">
          Plan my day
        </h2>
        <span className="text-xs text-neutral-500">Press 1–9 to add</span>
        <HeaderButton onClick={onClose}>Done</HeaderButton>
      </div>
      {candidates.length === 0 ? (
        <p className="py-1 text-sm text-neutral-500">
          Nothing pressing: no overdue, due-soon, high-priority or in-progress tasks left.
        </p>
      ) : (
        <ol className="flex flex-col">
          {candidates.map((c, i) => {
            const project = c.task.project_id ? projects[c.task.project_id] : undefined;
            return (
              <li key={c.task.id} className="flex items-center gap-2 py-0.5 text-sm">
                <kbd className="w-5 rounded border border-line-strong text-center font-mono text-xs text-ink-3">
                  {i + 1}
                </kbd>
                <span className="min-w-0 flex-1 truncate">{c.task.title}</span>
                {project && (
                  <span className="flex items-center gap-1 text-xs text-neutral-500">
                    <Dot color={project.color} />
                    {project.name}
                  </span>
                )}
                <span className="text-xs text-amber-800 dark:text-amber-300">
                  {c.reasons.join(" · ")}
                </span>
                <button
                  type="button"
                  aria-label={`Add ${c.task.title} to today`}
                  onClick={() => void updateTask(store, c.task.id, [{ today_on: today }])}
                  className="rounded-md px-2 text-xs text-accent hover:bg-hover"
                >
                  + Today
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** The Today view, with the "Plan my day" picker (`?plan=1`, or the header button). */
export function TodayPage() {
  const { plan } = useSearch({ strict: false }) as { plan?: "1" };
  const navigate = useNavigate();
  const setPlan = (open: boolean) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) =>
        ({ ...prev, plan: open ? "1" : undefined }) as never,
    });
  return (
    <ViewPage
      scope={{ kind: "today" }}
      title="Today"
      actions={!plan && <HeaderButton onClick={() => setPlan(true)}>Plan my day</HeaderButton>}
      details={plan && <PlanMyDay onClose={() => setPlan(false)} />}
    />
  );
}
