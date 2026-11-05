import { CalendarDays, Clock, Diamond, Flag, Sun } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import { cx, Dot, PRIORITIES, PRIORITY_PILL } from "../../components/ui";
import { daysFrom, formatDueLong } from "../../lib/dates";
import type { Epic, Priority, Status, Task, TaskChange } from "../../lib/types";
import { ProjectMark } from "../organize/ProjectMark";
import { GHOST, OVERLAY, PILL, SET } from "./pill";
import { TagPicker } from "./TagPicker";

/**
 * The full page's properties, as in the mockup: set values are compact tinted pills
 * ("In progress", "High", "Due Fri, Nov 6", "◆ Launch v2", "#copy"); unset ones follow
 * as quiet labels. Every pill keeps a native control (an invisible select or date input
 * laid over it), so keyboard use and accessible names are unchanged.
 */

/** Background and text tinted with a status or project color. */
function tint(color: string | null): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
    color: `color-mix(in srgb, ${color} 70%, var(--tm-ink))`,
  };
}

function SelectPill({
  label,
  ariaLabel,
  value,
  onChange,
  options,
  icon,
  className,
  style,
}: {
  label: ReactNode;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  icon?: ReactNode;
  className: string;
  style?: CSSProperties;
}) {
  return (
    <span className={cx(PILL, className)} style={style}>
      {icon}
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={OVERLAY}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

function DuePill({ task, today, change }: PillProps) {
  const due = task.due_date;
  const overdue = due !== null && daysFrom(today, due) < 0;
  return (
    <span
      className={cx(PILL, due ? (overdue ? "bg-urgent/14 text-urgent" : SET) : GHOST)}
      title={due ? "Change the due date (Delete clears it)" : undefined}
    >
      {!due && <CalendarDays size={13} />}
      {due ? formatDueLong(due, today) : "Due date"}
      <input
        type="date"
        aria-label="Due date"
        value={due ?? ""}
        onChange={(e) => change([{ due_date: e.target.value || null }])}
        onClick={(e) => {
          // A transparent date input would only focus a segment; open the picker.
          try {
            e.currentTarget.showPicker?.();
          } catch {
            // Not allowed (not a user gesture, or unsupported): typing still works.
          }
        }}
        className={OVERLAY}
      />
    </span>
  );
}

function EstimatePill({ task, change }: PillProps) {
  const [editing, setEditing] = useState(false);
  const minutes = task.estimate_min;
  if (editing) {
    return (
      <span className={cx(PILL, SET)}>
        <Clock size={13} />
        <input
          type="number"
          min={0}
          step={5}
          // biome-ignore lint/a11y/noAutofocus: opened by a click on the pill
          autoFocus
          aria-label="Estimate in minutes"
          defaultValue={minutes ?? ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = String(minutes ?? "");
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            setEditing(false);
            const raw = e.currentTarget.value;
            const value = raw === "" ? null : Math.max(0, Math.round(Number(raw)));
            if (value !== minutes && !Number.isNaN(value)) change([{ estimate_min: value }]);
          }}
          className="w-12 bg-transparent text-right outline-none"
        />
        min
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      aria-label={minutes === null ? "Add an estimate" : `Estimate: ${minutes} minutes`}
      className={cx(PILL, minutes === null ? GHOST : SET)}
    >
      <Clock size={13} />
      {minutes === null ? "Estimate" : `${minutes} min`}
    </button>
  );
}

interface PillProps {
  task: Task;
  today: string;
  change: (changes: TaskChange[]) => void;
}

export function PropertyPills({
  task,
  today,
  change,
  statuses,
  epics,
  projects,
}: PillProps & {
  statuses: Status[];
  epics: Epic[];
  projects: {
    id: string;
    label: string;
    name: string;
    color: string | null;
    icon: string | null;
  }[];
}) {
  const status = statuses.find((s) => s.id === task.status_id);
  const epic = epics.find((e) => e.id === task.epic_id);
  const project = projects.find((p) => p.id === task.project_id);
  const pickedToday = task.today_on === today;
  const priority = PRIORITIES.find((p) => p.value === task.priority);
  const prioritySet = task.priority !== "normal";

  const pills: { set: boolean; node: ReactNode }[] = [
    {
      set: true,
      node: (
        <SelectPill
          key="status"
          ariaLabel="Status"
          label={status?.name ?? "Status"}
          icon={<Dot color={status?.color ?? null} />}
          value={task.status_id}
          onChange={(status_id) => change([{ status_id }])}
          options={statuses.map((s) => ({ value: s.id, label: s.name }))}
          className={status?.color ? "hover:brightness-95" : SET}
          style={tint(status?.color ?? null)}
        />
      ),
    },
    {
      set: prioritySet,
      node: (
        <SelectPill
          key="priority"
          ariaLabel="Priority"
          label={prioritySet ? priority?.label : "Priority"}
          icon={prioritySet ? undefined : <Flag size={13} />}
          value={task.priority}
          onChange={(p) => change([{ priority: p as Priority }])}
          options={PRIORITIES.map((p) => ({ value: p.value, label: `${p.label} priority` }))}
          className={
            task.priority === "low" ? SET : prioritySet ? PRIORITY_PILL[task.priority] : GHOST
          }
        />
      ),
    },
    {
      set: task.due_date !== null,
      node: <DuePill key="due" task={task} today={today} change={change} />,
    },
    {
      set: pickedToday,
      node: (
        <button
          key="today"
          type="button"
          aria-pressed={pickedToday}
          onClick={() => change([{ today_on: pickedToday ? null : today }])}
          className={cx(PILL, pickedToday ? SET : GHOST)}
        >
          {!pickedToday && <Sun size={13} />}
          {pickedToday ? "On Today" : "Add to Today"}
        </button>
      ),
    },
    {
      set: true,
      node: (
        <SelectPill
          key="project"
          ariaLabel="Project"
          label={project?.name ?? "Inbox"}
          icon={project ? <ProjectMark project={project} /> : undefined}
          value={task.project_id ?? ""}
          onChange={(id) => change([{ project_id: id || null }])}
          options={[
            { value: "", label: "Inbox" },
            ...projects.map((p) => ({ value: p.id, label: p.label })),
          ]}
          className={SET}
        />
      ),
    },
    {
      set: epic !== undefined,
      node: (
        <SelectPill
          key="epic"
          ariaLabel="Epic"
          label={epic?.name ?? "Epic"}
          icon={<Diamond size={11} className={epic ? "fill-current" : undefined} />}
          value={task.epic_id ?? ""}
          onChange={(id) => change([{ epic_id: id || null }])}
          options={[
            { value: "", label: "No epic" },
            ...epics.map((e) => ({ value: e.id, label: e.name })),
          ]}
          className={
            epic
              ? "bg-violet-600/12 text-violet-800 hover:bg-violet-600/18 dark:bg-violet-400/15 dark:text-violet-200"
              : GHOST
          }
        />
      ),
    },
    {
      set: task.estimate_min !== null,
      node: <EstimatePill key="estimate" task={task} today={today} change={change} />,
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {pills.filter((p) => p.set).map((p) => p.node)}
      <TagPicker task={task} variant="pill" />
      {pills.filter((p) => !p.set).map((p) => p.node)}
    </div>
  );
}
