import { useMemo } from "react";
import { Checkbox, cx, InlineInput } from "../../components/ui";
import type { Task } from "../../lib/types";
import { compareRank } from "../../lib/views";
import { createTask, moveSubtask, setParent, toggleDone } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { useOpenTask } from "../shell/useOpenTask";

/** Checklist of direct subtasks: add, tick off, reorder, open, promote to a full task. */
export function SubtaskList({ parent }: { parent: Task }) {
  const store = useTaskStore();
  const tasks = useStoreState((s) => s.tasks);
  const statuses = useStoreState((s) => s.statuses);
  const openTask = useOpenTask();
  const children = useMemo(
    () =>
      Object.values(tasks)
        .filter((t) => t.parent_id === parent.id)
        .sort(compareRank),
    [tasks, parent.id],
  );
  const isDone = (t: Task) => {
    const c = statuses.find((s) => s.id === t.status_id)?.category;
    return c === "done" || c === "cancelled";
  };

  return (
    <div>
      <ul className="flex flex-col">
        {children.map((child, i) => (
          <li
            key={child.id}
            className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-900"
          >
            <Checkbox
              checked={isDone(child)}
              onChange={() => void toggleDone(store, child.id)}
              label={`Done: ${child.title}`}
            />
            <button
              type="button"
              onClick={() => openTask(child.id)}
              className={cx(
                "min-w-0 flex-1 truncate text-left",
                isDone(child) && "text-neutral-400 line-through",
              )}
            >
              {child.title}
            </button>
            <span className="invisible flex gap-1 text-xs text-neutral-500 group-hover:visible">
              <button
                type="button"
                disabled={i === 0}
                onClick={() => void moveSubtask(store, child.id, -1)}
                aria-label="Move up"
                className="px-1 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                disabled={i === children.length - 1}
                onClick={() => void moveSubtask(store, child.id, 1)}
                aria-label="Move down"
                className="px-1 disabled:opacity-30"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => void setParent(store, child.id, null)}
                title="Make it a top-level task"
                className="px-1"
              >
                Promote
              </button>
            </span>
          </li>
        ))}
      </ul>
      <InlineInput
        initial=""
        clearOnCommit
        placeholder="Add subtask…"
        className="mt-1"
        onCommit={(title) => void createTask(store, { title, parent_id: parent.id })}
      />
    </div>
  );
}
