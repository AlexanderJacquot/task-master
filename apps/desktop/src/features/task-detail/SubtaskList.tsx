import { useMemo } from "react";
import { AgentsIcon as Bot, DoneIcon } from "../../components/TaskIcons";
import { cx, InlineInput } from "../../components/ui";
import type { Task } from "../../lib/types";
import { compareRank } from "../../lib/views";
import { createTask, moveSubtask, setParent, toggleDone } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { useOpenTask } from "../shell/useOpenTask";

/** A subtask box: an empty square, replaced by a red wax seal once done. */
function SquareCheck({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <span
      className={cx(
        "relative inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] transition-colors",
        !checked && "border-[1.5px] border-ink-3",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={label}
        className="absolute inset-0 cursor-pointer appearance-none rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
      {checked && <DoneIcon aria-hidden size={20} className="pointer-events-none text-rubric" />}
    </span>
  );
}

/**
 * Checklist of direct subtasks: add, tick off, reorder, open, promote to a full task.
 * `page`: the full page's look, with a "2 of 4" progress header as in the mockup.
 */
export function SubtaskList({
  parent,
  variant = "panel",
}: {
  parent: Task;
  variant?: "panel" | "page";
}) {
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

  const page = variant === "page";
  const doneCount = children.filter(isDone).length;
  const Box = SquareCheck;

  return (
    <div>
      {page && (
        <div className="mb-1 flex items-center gap-3 border-b border-line pb-2">
          <span className="font-display text-[17px] tracking-wide text-rubric">Subtasks</span>
          {children.length > 0 && (
            <>
              <span className="text-[13px] text-ink-3">
                {doneCount} of {children.length}
              </span>
              <span
                role="progressbar"
                aria-label="Subtasks done"
                aria-valuemin={0}
                aria-valuemax={children.length}
                aria-valuenow={doneCount}
                className="h-[3px] flex-1 overflow-hidden rounded-full bg-line"
              >
                <span
                  className="block h-full rounded-full bg-done transition-[width]"
                  style={{ width: `${(doneCount / children.length) * 100}%` }}
                />
              </span>
            </>
          )}
        </div>
      )}
      <ul className="flex flex-col">
        {children.map((child, i) => (
          <li
            key={child.id}
            className={cx(
              "group flex items-center rounded hover:bg-hover",
              page ? "gap-3 px-0.5 py-1.5 text-[15.5px]" : "gap-2 px-1 py-1",
            )}
          >
            <Box
              checked={isDone(child)}
              onChange={() => void toggleDone(store, child.id)}
              label={`Done: ${child.title}`}
            />
            <button
              type="button"
              onClick={() => openTask(child.id)}
              className={cx(
                "min-w-0 flex-1 truncate text-left",
                isDone(child) && "text-ink-3 line-through",
              )}
            >
              {child.owner === "agent" && (
                <Bot
                  size={13}
                  className="mr-1 inline align-[-2px] text-accent"
                  aria-label="Agent task"
                />
              )}
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
        className={
          page
            ? "mt-1 border-transparent bg-transparent px-0.5 hover:border-line focus:px-2.5"
            : "mt-1"
        }
        onCommit={(title) => void createTask(store, { title, parent_id: parent.id })}
      />
    </div>
  );
}
