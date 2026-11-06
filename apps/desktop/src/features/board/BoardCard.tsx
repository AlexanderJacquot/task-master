import { ListChecks } from "lucide-react";
import { memo } from "react";
import { EstimateIcon as Clock } from "../../components/TaskIcons";
import { Chip, cx, Dot, PRIORITY_PILL } from "../../components/ui";
import { daysFrom, formatDue, isoDate } from "../../lib/dates";
import type { Epic, Project, Status, Tag, Task } from "../../lib/types";
import { SessionChip } from "../agents/SessionChip";
import { EpicMark } from "../organize/EpicMark";

/** Height of a card plus the gap below it; fixed so columns virtualize without measuring. */
export const CARD_SLOT = 98;

export interface CardLookups {
  statuses: Status[];
  projects: Record<string, Project>;
  epics: Record<string, Epic>;
  tags: Record<string, Tag>;
  today: string;
  /** Hide the project label in a project's own view. */
  showProject: boolean;
}

interface Props extends CardLookups {
  task: Task;
  childCount: number;
  childDone: number;
  selected?: boolean;
  /** The card left in place while its overlay is dragged. */
  placeholder?: boolean;
  /** The floating copy under the pointer. */
  overlay?: boolean;
}

/** The face of a card: title, project, epic, tags, priority, due date, subtask progress. */
export const CardFace = memo(function CardFace(p: Props) {
  const { task } = p;
  const category = p.statuses.find((s) => s.id === task.status_id)?.category;
  const done = category === "done" || category === "cancelled";
  const overdue = !done && task.due_date !== null && task.due_date < p.today;
  const untouchedDays = daysFrom(isoDate(new Date(task.updated_at)), p.today);
  const stale = !done && untouchedDays >= 30;
  const project = task.project_id ? p.projects[task.project_id] : undefined;
  const epic = task.epic_id ? p.epics[task.epic_id] : undefined;
  const tags = task.tag_ids.flatMap((id) => (p.tags[id] ? [p.tags[id]] : []));

  return (
    <div
      className={cx(
        "flex h-[88px] flex-col gap-1.5 overflow-hidden rounded-[11px] border bg-raised px-3 py-2.5 shadow-sm shadow-black/10 transition-colors",
        p.selected ? "border-accent ring-1 ring-accent" : "border-line hover:border-line-strong",
        p.placeholder && "opacity-40",
        p.overlay && "rotate-1 shadow-xl shadow-black/30",
      )}
    >
      <p
        className={cx(
          "line-clamp-2 min-h-0 leading-snug text-ink",
          done && "text-ink-3 line-through",
        )}
      >
        {task.title}
      </p>
      <div className="mt-auto flex min-w-0 items-center gap-1.5 text-xs text-ink-2">
        {(task.priority === "urgent" || task.priority === "high") && !done && (
          <span className={cx("shrink-0 rounded-md px-1.5", PRIORITY_PILL[task.priority])}>
            {task.priority === "urgent" ? "Urgent" : "High"}
          </span>
        )}
        {p.showProject && project && (
          <span className="flex max-w-28 shrink-0 items-center gap-1 truncate">
            <Dot color={project.color} />
            <span className="truncate">{project.name}</span>
          </span>
        )}
        {epic && (
          <span className="flex max-w-24 shrink-0 items-center gap-1 truncate text-violet-800 dark:text-violet-300">
            <EpicMark epic={epic} size={10} />
            <span className="truncate">{epic.name}</span>
          </span>
        )}
        <SessionChip taskId={task.id} className="max-w-36 shrink-0" />
        <span className="flex min-w-0 flex-1 gap-1 overflow-hidden">
          {tags.map((tag) => (
            <Chip key={tag.id}>#{tag.name}</Chip>
          ))}
        </span>
        {stale && (
          <span
            className="flex shrink-0 items-center gap-1 text-ink-3"
            title={`Not updated for ${untouchedDays} days`}
          >
            <Clock size={12} aria-hidden="true" />
            Stale
            <span className="sr-only">: not updated for {untouchedDays} days</span>
          </span>
        )}
        {p.childCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 tabular-nums" title="Subtasks done">
            <ListChecks size={12} /> {p.childDone}/{p.childCount}
          </span>
        )}
        {task.due_date && (
          <span className={cx("shrink-0 tabular-nums", overdue && "text-danger")}>
            {formatDue(task.due_date, p.today)}
          </span>
        )}
      </div>
    </div>
  );
});
