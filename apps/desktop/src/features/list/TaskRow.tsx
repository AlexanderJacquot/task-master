import { ChevronDown, ChevronRight, Flag } from "lucide-react";
import { memo, useState } from "react";
import { Chip, cx, Dot, PRIORITIES, PRIORITY_STYLE, Select, TaskCheck } from "../../components/ui";
import { formatDue } from "../../lib/dates";
import type { Priority, Project, Status, Tag, Task, TaskChange } from "../../lib/types";

export interface RowHandlers {
  onOpen(id: string): void;
  /** Opens the full task page. */
  onOpenPage(id: string): void;
  onToggleDone(id: string): void;
  onToggleCollapse(id: string): void;
  onChange(id: string, changes: TaskChange[]): void;
}

export interface RowLookups {
  statuses: Status[];
  projects: Record<string, Project>;
  tags: Record<string, Tag>;
  today: string;
  /** Hide the project label in a project's own view. */
  showProject: boolean;
}

interface Props extends RowHandlers, RowLookups {
  task: Task;
  depth: 0 | 1;
  childCount: number;
  childDone: number;
  visibleChildren: number;
  collapsed: boolean;
  selected: boolean;
}

/** One task line. Memoized: re-renders only when its task (or the lookups) change. */
export const TaskRow = memo(function TaskRow(p: Props) {
  const { task } = p;
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDue, setEditingDue] = useState(false);
  const category = p.statuses.find((s) => s.id === task.status_id)?.category;
  const done = category === "done" || category === "cancelled";
  const overdue = !done && task.due_date !== null && task.due_date < p.today;
  const project = task.project_id ? p.projects[task.project_id] : undefined;

  const status = p.statuses.find((s) => s.id === task.status_id);
  const hasFlag = !done && (task.priority === "urgent" || task.priority === "high");

  return (
    <div
      className={cx(
        "group mx-6 flex h-[34px] items-center gap-3 rounded-[9px] pr-2 transition-colors",
        p.selected ? "bg-selected" : "hover:bg-hover",
      )}
      style={{ paddingLeft: p.depth ? "2.9rem" : "0.5rem" }}
      data-testid="task-row"
    >
      <button
        type="button"
        aria-label={p.collapsed ? "Expand subtasks" : "Collapse subtasks"}
        onClick={() => p.onToggleCollapse(task.id)}
        className={cx(
          "-mr-1.5 flex w-4 shrink-0 justify-center text-ink-3 hover:text-ink",
          (p.depth || !p.visibleChildren) && "invisible",
        )}
      >
        {p.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>
      <TaskCheck
        checked={done}
        onChange={() => p.onToggleDone(task.id)}
        label={`Done: ${task.title}`}
        color={status?.color ?? null}
      />

      {editingTitle ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: entered by an explicit double-click
          autoFocus
          defaultValue={task.title}
          aria-label="Title"
          className="min-w-0 flex-1 rounded-md border border-accent bg-raised px-1.5 text-ink focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = task.title;
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            const title = e.currentTarget.value.trim();
            setEditingTitle(false);
            if (title && title !== task.title) p.onChange(task.id, [{ title }]);
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => p.onOpen(task.id)}
          onDoubleClick={() => setEditingTitle(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.shiftKey) {
              e.preventDefault();
              p.onOpenPage(task.id);
            }
          }}
          className={cx(
            "min-w-0 flex-1 truncate rounded-sm text-left focus-visible:outline-2 focus-visible:outline-accent",
            done ? "text-ink-3 line-through" : "text-ink",
          )}
          title="Click to open · Shift+Enter for the full page · double-click to rename"
        >
          {task.title}
        </button>
      )}

      {p.childCount > 0 && (
        <span className="text-[12.5px] text-ink-3 tabular-nums" title="Subtasks done">
          {p.childDone}/{p.childCount}
        </span>
      )}
      {task.tag_ids.map((id) => (p.tags[id] ? <Chip key={id}>#{p.tags[id].name}</Chip> : null))}
      {p.showProject && project && (
        <span className="hidden max-w-36 items-center gap-1.5 truncate text-[12.5px] text-ink-3 md:flex">
          <Dot color={project.color} />
          {project.name}
        </span>
      )}

      {editingDue ? (
        <input
          type="date"
          // biome-ignore lint/a11y/noAutofocus: entered by an explicit click
          autoFocus
          aria-label="Due date"
          defaultValue={task.due_date ?? ""}
          className="w-32 rounded-md border border-accent bg-raised px-1 text-xs text-ink"
          onBlur={(e) => {
            setEditingDue(false);
            const value = e.currentTarget.value || null;
            if (value !== task.due_date) p.onChange(task.id, [{ due_date: value }]);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditingDue(true)}
          className={cx(
            "shrink-0 rounded px-1 text-right text-[12.5px] tabular-nums",
            overdue ? "text-danger" : "text-ink-2",
            !task.due_date && "w-0 overflow-hidden group-hover:w-auto",
          )}
          aria-label="Set due date"
        >
          {task.due_date ? formatDue(task.due_date, p.today) : "Due…"}
        </button>
      )}
      {hasFlag && (
        <Flag
          size={14}
          aria-label={`${task.priority} priority`}
          className={cx("shrink-0 fill-current", PRIORITY_STYLE[task.priority])}
        />
      )}

      <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Select
          aria-label="Priority"
          value={task.priority}
          onChange={(e) => p.onChange(task.id, [{ priority: e.target.value as Priority }])}
          className={cx("w-[5.5rem] text-xs", PRIORITY_STYLE[task.priority])}
        >
          {PRIORITIES.map((pr) => (
            <option key={pr.value} value={pr.value}>
              {pr.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Status"
          value={task.status_id}
          onChange={(e) => p.onChange(task.id, [{ status_id: e.target.value }])}
          className="w-28 text-xs text-ink-2"
        >
          {p.statuses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </span>
    </div>
  );
});
