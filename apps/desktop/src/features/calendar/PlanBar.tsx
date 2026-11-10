// The calendar's planning bar (Plan mode): working hours, and Suggest / Approve / Clear for
// a proposed plan of the shown day or week. The plan draws from the tasks the tray's
// filter (the focus: project, epic, status, drawn by `FocusFilter`) lists.

import { Dices } from "lucide-react";
import { CheckIcon as Check, CloseIcon as X } from "../../components/TaskIcons";
import { Button, Select, type SelectOption } from "../../components/ui";
import { atMinute, formatDuration, formatHour } from "../../lib/calendar";
import type { Plan, PlanFocus, PlanHours } from "../../lib/planner";
import type { Epic, Project, Status } from "../../lib/types";

const ANY = "any";

/** The focus selects (project, epic, open status), stacked. Shown in the calendar's tray. */
export function FocusFilter({
  focus,
  onFocus,
  projects,
  epics,
  statuses,
}: {
  focus: PlanFocus;
  onFocus(focus: PlanFocus): void;
  projects: Project[];
  epics: Epic[];
  statuses: Status[];
}) {
  const projectOptions: SelectOption[] = [
    { value: ANY, label: "Any project" },
    { value: "inbox", label: "Inbox" },
    ...projects.map((p) => ({ value: p.id, label: p.name })),
  ];
  const epicOptions: SelectOption[] = [
    { value: ANY, label: "Any epic" },
    ...epics
      .filter(
        (e) =>
          e.id === focus.epicId ||
          focus.projectId === null ||
          e.project_id === null ||
          e.project_id === focus.projectId,
      )
      .map((e) => ({ value: e.id, label: e.name })),
  ];
  const statusOptions: SelectOption[] = [
    { value: ANY, label: "Any open status" },
    ...statuses.map((s) => ({ value: s.id, label: s.name })),
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <Select
        aria-label="Filter project"
        value={focus.projectId ?? ANY}
        options={projectOptions}
        onValueChange={(v) => onFocus({ ...focus, projectId: v === ANY ? null : v })}
        className="w-full"
      />
      <Select
        aria-label="Filter epic"
        value={focus.epicId ?? ANY}
        options={epicOptions}
        onValueChange={(v) => onFocus({ ...focus, epicId: v === ANY ? null : v })}
        className="w-full"
      />
      <Select
        aria-label="Filter status"
        value={focus.statusId ?? ANY}
        options={statusOptions}
        onValueChange={(v) => onFocus({ ...focus, statusId: v === ANY ? null : v })}
        className="w-full"
      />
    </div>
  );
}

export function PlanBar({
  hours,
  onHours,
  week,
  matching,
  freeMin,
  plan,
  onSuggest,
  onApprove,
  onClear,
  today,
}: {
  hours: PlanHours;
  onHours(hours: PlanHours): void;
  /** The week view is shown (weekends can be included). */
  week: boolean;
  /** Tasks the focus offers to the plan. */
  matching: number;
  /** Free working minutes left in the shown days. */
  freeMin: number;
  plan: Plan | null;
  onSuggest(): void;
  onApprove(): void;
  onClear(): void;
  today: string;
}) {
  const hourOptions = (from: number, to: number): SelectOption[] =>
    Array.from({ length: to - from + 1 }, (_, i) => {
      const h = from + i;
      return {
        value: String(h),
        label: h === 24 ? "Midnight" : formatHour(atMinute(today, h * 60)),
      };
    });
  const startHour = Math.floor(hours.startMin / 60);
  const endHour = Math.ceil(hours.endMin / 60);
  const plannedMin = plan
    ? plan.blocks.reduce((sum, b) => sum + (b.end_at - b.start_at) / 60_000, 0)
    : 0;
  const plannedTasks = plan ? new Set(plan.blocks.map((b) => b.task_id)).size : 0;

  return (
    <section
      aria-label="Plan"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-hover/40 px-10 py-2.5 text-[13px]"
    >
      <span className="text-ink-3">Hours</span>
      <Select
        aria-label="Plan from"
        value={String(startHour)}
        options={hourOptions(0, Math.max(endHour - 1, 0))}
        onValueChange={(v) => onHours({ ...hours, startMin: Number(v) * 60 })}
      />
      <span className="text-ink-3">to</span>
      <Select
        aria-label="Plan until"
        value={String(endHour)}
        options={hourOptions(Math.min(startHour + 1, 24), 24)}
        onValueChange={(v) => onHours({ ...hours, endMin: Number(v) * 60 })}
      />
      {week && (
        <label className="flex items-center gap-1.5 text-ink-2">
          <input
            type="checkbox"
            checked={hours.weekends}
            onChange={(e) => onHours({ ...hours, weekends: e.target.checked })}
            className="accent-[var(--tm-accent)]"
          />
          Weekends
        </label>
      )}
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        <span className="text-[12.5px] text-ink-3" aria-live="polite" data-testid="plan-summary">
          {plan
            ? `${plan.blocks.length === 0 ? "Nothing to place" : `${plannedTasks} ${plannedTasks === 1 ? "task" : "tasks"}, ${formatDuration(plannedMin)}`} of ${formatDuration(freeMin)} free${
                plan.unplaced.length ? ` · ${plan.unplaced.length} didn't fit` : ""
              }`
            : `${matching} ${matching === 1 ? "task" : "tasks"} to plan · ${formatDuration(freeMin)} free`}
        </span>
        <Button size="sm" onClick={onSuggest} disabled={matching === 0 || freeMin === 0}>
          <Dices size={14} />
          {plan ? "Reshuffle" : "Suggest"}
        </Button>
        {plan && (
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={onApprove}
              disabled={plan.blocks.length === 0}
            >
              <Check size={13} />
              Approve
            </Button>
            <Button size="sm" variant="ghost" onClick={onClear}>
              <X size={13} />
              Clear
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
