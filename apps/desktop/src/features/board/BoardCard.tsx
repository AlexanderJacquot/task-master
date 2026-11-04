import { memo } from "react";
import { Chip, cx, Dot, PRIORITY_STYLE } from "../../components/ui";
import { formatDue } from "../../lib/dates";
import type { Epic, Project, Status, Tag, Task } from "../../lib/types";

/** Height of a card plus the gap below it; fixed so columns virtualize without measuring. */
export const CARD_SLOT = 92;

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
  const project = task.project_id ? p.projects[task.project_id] : undefined;
  const epic = task.epic_id ? p.epics[task.epic_id] : undefined;
  const tags = task.tag_ids.flatMap((id) => (p.tags[id] ? [p.tags[id]] : []));

  return (
    <div
      className={cx(
        "flex h-[84px] flex-col gap-1 overflow-hidden rounded-md border bg-white px-2.5 py-2 text-sm dark:bg-neutral-900",
        p.selected
          ? "border-blue-500 ring-1 ring-blue-500"
          : "border-neutral-200 dark:border-neutral-800",
        p.placeholder && "opacity-40",
        p.overlay && "shadow-lg",
      )}
    >
      <p
        className={cx("line-clamp-2 min-h-0 leading-snug", done && "text-neutral-400 line-through")}
      >
        {task.priority !== "normal" && (
          <span className={cx("mr-1 text-xs font-semibold", PRIORITY_STYLE[task.priority])}>
            {task.priority === "urgent" ? "!!" : task.priority === "high" ? "!" : "↓"}
          </span>
        )}
        {task.title}
      </p>
      <div className="mt-auto flex min-w-0 items-center gap-1.5 text-xs text-neutral-500">
        {p.showProject && project && (
          <span className="flex max-w-28 shrink-0 items-center gap-1 truncate">
            <Dot color={project.color} />
            <span className="truncate">{project.name}</span>
          </span>
        )}
        {epic && <span className="max-w-24 shrink-0 truncate">◆ {epic.name}</span>}
        <span className="flex min-w-0 flex-1 gap-1 overflow-hidden">
          {tags.map((tag) => (
            <Chip key={tag.id}>#{tag.name}</Chip>
          ))}
        </span>
        {p.childCount > 0 && (
          <span className="shrink-0" title="Subtasks done">
            ☑ {p.childDone}/{p.childCount}
          </span>
        )}
        {task.due_date && (
          <span className={cx("shrink-0", overdue && "font-medium text-red-600 dark:text-red-400")}>
            {formatDue(task.due_date, p.today)}
          </span>
        )}
      </div>
    </div>
  );
});
