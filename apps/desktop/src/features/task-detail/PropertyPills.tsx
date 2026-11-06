import { Diamond } from "lucide-react";
import { Select as RadixSelect } from "radix-ui";
import { type CSSProperties, type ReactNode, useState } from "react";
import { DatePicker } from "../../components/DatePicker";
import {
  DueDateIcon as CalendarDays,
  EstimateIcon as Clock,
  PriorityIcon as Flag,
  TodayIcon as Sun,
} from "../../components/TaskIcons";
import {
  cx,
  Dot,
  PRIORITIES,
  PRIORITY_PILL,
  PRIORITY_STYLE,
  type SelectOption,
  SelectRoot,
} from "../../components/ui";
import { daysFrom, formatDueLong } from "../../lib/dates";
import type { Epic, Status, Task, TaskChange } from "../../lib/types";
import { EpicMark } from "../organize/EpicMark";
import { ProjectMark } from "../organize/ProjectMark";
import { GHOST, PILL, SET } from "./pill";
import { TagPicker } from "./TagPicker";

/**
 * The full page's properties, as in the mockup: set values are compact tinted pills
 * ("In progress", "High", "Due Fri, Nov 6", "◆ Launch v2", "#copy"); unset ones follow
 * as quiet labels. Choice pills open the shared menu list; dates use the shared calendar.
 */

/** Background and text tinted with a status or project color. */
function tint(color: string | null): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
    color: `color-mix(in srgb, ${color} 70%, var(--tm-ink))`,
  };
}

function SelectPill<T extends string>({
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
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  icon?: ReactNode;
  className: string;
  style?: CSSProperties;
}) {
  return (
    <SelectRoot value={value} onValueChange={onChange} options={options}>
      <RadixSelect.Trigger
        aria-label={ariaLabel}
        className={cx(PILL, "cursor-pointer outline-none", className)}
        style={style}
      >
        {icon}
        {label}
      </RadixSelect.Trigger>
    </SelectRoot>
  );
}

function DuePill({ task, today, change }: PillProps) {
  const due = task.due_date;
  const overdue = due !== null && daysFrom(today, due) < 0;
  return (
    <DatePicker
      aria-label="Due date"
      value={due}
      today={today}
      onValueChange={(due_date) => change([{ due_date }])}
      className={cx(PILL, due ? (overdue ? "bg-urgent/14 text-urgent" : SET) : GHOST)}
    >
      <CalendarDays size={13} />
      <span>{due ? formatDueLong(due, today) : "Due date"}</span>
    </DatePicker>
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
          options={statuses.map((s) => ({
            value: s.id,
            label: s.name,
            icon: <Dot color={s.color ?? null} />,
          }))}
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
          onChange={(priority) => change([{ priority }])}
          options={PRIORITIES.map((p) => ({
            value: p.value,
            label: `${p.label} priority`,
            className: PRIORITY_STYLE[p.value],
          }))}
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
            ...projects.map((p) => ({
              value: p.id,
              label: p.label.trim(),
              icon: <ProjectMark project={p} />,
            })),
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
          icon={epic ? <EpicMark epic={epic} size={11} /> : <Diamond size={11} />}
          value={task.epic_id ?? ""}
          onChange={(id) => change([{ epic_id: id || null }])}
          options={[
            { value: "", label: "No epic" },
            ...epics.map((e) => ({ value: e.id, label: e.name, icon: <EpicMark epic={e} /> })),
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
