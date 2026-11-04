import { memo, useState } from "react";
import { Checkbox, Chip, cx, Dot, PRIORITIES, PRIORITY_STYLE, Select } from "../../components/ui";
import { formatDue } from "../../lib/dates";
import type { Priority, Project, Status, Tag, Task, TaskChange } from "../../lib/types";

export interface RowHandlers {
  onOpen(id: string): void;
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

  return (
    <div
      className={cx(
        "group flex h-9 items-center gap-2 border-b border-neutral-100 pr-3 dark:border-neutral-900",
        p.selected
          ? "bg-blue-50 dark:bg-blue-950/40"
          : "hover:bg-neutral-50 dark:hover:bg-neutral-900",
      )}
      style={{ paddingLeft: p.depth ? "2.75rem" : "0.75rem" }}
      data-testid="task-row"
    >
      <button
        type="button"
        aria-label={p.collapsed ? "Expand subtasks" : "Collapse subtasks"}
        onClick={() => p.onToggleCollapse(task.id)}
        className={cx(
          "w-4 shrink-0 text-neutral-400 hover:text-neutral-700",
          (p.depth || !p.visibleChildren) && "invisible",
        )}
      >
        {p.collapsed ? "▸" : "▾"}
      </button>
      <Checkbox
        checked={done}
        onChange={() => p.onToggleDone(task.id)}
        label={`Done: ${task.title}`}
      />

      {editingTitle ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: entered by an explicit double-click
          autoFocus
          defaultValue={task.title}
          aria-label="Title"
          className="min-w-0 flex-1 rounded border border-blue-500 bg-white px-1 dark:bg-neutral-900"
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
          className={cx(
            "min-w-0 flex-1 truncate text-left",
            done && "text-neutral-400 line-through",
          )}
          title="Click to open, double-click to rename"
        >
          {task.title}
        </button>
      )}

      {p.childCount > 0 && (
        <span className="text-xs text-neutral-500" title="Subtasks done">
          {p.childDone}/{p.childCount}
        </span>
      )}
      {task.tag_ids.map((id) => (p.tags[id] ? <Chip key={id}>#{p.tags[id].name}</Chip> : null))}
      {p.showProject && project && (
        <span className="hidden max-w-32 items-center gap-1 truncate text-xs text-neutral-500 md:flex">
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
          className="w-32 rounded border border-blue-500 bg-white px-1 text-xs dark:bg-neutral-900"
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
            "w-20 shrink-0 text-right text-xs",
            overdue ? "font-medium text-red-600 dark:text-red-400" : "text-neutral-500",
            !task.due_date && "invisible group-hover:visible",
          )}
          aria-label="Set due date"
        >
          {task.due_date ? formatDue(task.due_date, p.today) : "Due…"}
        </button>
      )}

      <Select
        aria-label="Priority"
        value={task.priority}
        onChange={(e) => p.onChange(task.id, [{ priority: e.target.value as Priority }])}
        className={cx("w-20 shrink-0 text-xs", PRIORITY_STYLE[task.priority])}
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
        className="w-28 shrink-0 text-xs"
      >
        {p.statuses.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </div>
  );
});
