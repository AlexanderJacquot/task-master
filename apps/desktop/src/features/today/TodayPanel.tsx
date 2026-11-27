import { useSearch } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useMemo, useRef, useState } from "react";
import { MinusIcon as Minus, TodayIcon as Sun, CloseIcon as X } from "../../components/TaskIcons";
import { cx, IconButton, TaskCheck } from "../../components/ui";
import { formatDue, isoDate } from "../../lib/dates";
import type { Task } from "../../lib/types";
import { isOpen, isOverdue, todayTasks, type ViewContext } from "../../lib/views";
import { toggleDone, updateTask } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { DROP_OVER_CLASS, useTaskDropTarget } from "../shell/taskDrop";
import { useOpenTask } from "../shell/useOpenTask";

const OPEN_KEY = "task-master.today-panel";

/** Whether the Today panel is open; remembered per machine. */
export function useTodayPanelOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      // Not remembered; fine.
    }
  }, []);
  return [open, set];
}

const ROW_HEIGHT = 34;

/**
 * Today, beside a view: the tasks planned for today (and due), and a drop target that plans
 * the tasks dragged onto it from the list or the board for today.
 */
export function TodayPanel({ onClose }: { onClose(): void }) {
  const store = useTaskStore();
  const tasks = useStoreState((s) => s.tasks);
  const statuses = useStoreState((s) => s.statuses);
  const projects = useStoreState((s) => s.projects);
  const { task: selectedId } = useSearch({ strict: false }) as { task?: string };
  const openTask = useOpenTask();
  const today = isoDate();
  const ctx: ViewContext = useMemo(
    () => ({ today, statuses: Object.fromEntries(statuses.map((s) => [s.id, s])), projects }),
    [today, statuses, projects],
  );
  const list = useMemo(() => todayTasks(Object.values(tasks), ctx), [tasks, ctx]);
  const open = list.filter((t) => isOpen(t, ctx)).length;
  const drop = useTaskDropTarget({ kind: "today" });

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: list.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => list[i]?.id ?? i,
    overscan: 8,
  });

  return (
    <aside
      aria-label="Today panel"
      {...drop.props}
      className={cx(
        "tex-sheet m-2 ml-0 flex w-72 shrink-0 flex-col overflow-hidden rounded-2xl border bg-raised shadow-xl shadow-black/10 transition-colors",
        drop.isOver
          ? DROP_OVER_CLASS
          : drop.active
            ? "border-dashed border-accent/70"
            : "border-line",
      )}
    >
      <header className="flex items-center gap-2 border-b border-line py-2 pr-2 pl-4">
        <Sun size={16} className="shrink-0 text-rubric" aria-hidden />
        <h2 className="flex-1 font-display text-[17px] tracking-wide">Today</h2>
        <span className="text-[12.5px] text-ink-3 tabular-nums" title="Open tasks today">
          {open}
        </span>
        <IconButton label="Close the Today panel" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>
      {drop.active && (
        <p className="border-b border-line px-4 py-2 text-[12.5px] text-accent">
          Drop to plan for today
        </p>
      )}
      {list.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-ink-3">
          Nothing planned yet. Drag tasks here from the list to plan them for today.
        </p>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          <ul style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const task = list[item.index];
              if (!task) return null;
              return (
                <li
                  key={item.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <TodayRow
                    task={task}
                    ctx={ctx}
                    selected={task.id === selectedId}
                    onOpen={() => openTask(task.id)}
                    onToggleDone={() => void toggleDone(store, task.id)}
                    onUnplan={() => void updateTask(store, task.id, [{ today_on: null }])}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </aside>
  );
}

function TodayRow({
  task,
  ctx,
  selected,
  onOpen,
  onToggleDone,
  onUnplan,
}: {
  task: Task;
  ctx: ViewContext;
  selected: boolean;
  onOpen(): void;
  onToggleDone(): void;
  onUnplan(): void;
}) {
  const done = !isOpen(task, ctx);
  const status = ctx.statuses[task.status_id];
  const planned = task.today_on === ctx.today;
  return (
    <div
      data-testid="today-row"
      className={cx(
        "group mx-2 flex h-[32px] items-center gap-2.5 rounded-[9px] pr-1 pl-2 transition-colors",
        selected ? "bg-selected" : "hover:bg-hover",
      )}
    >
      <TaskCheck
        checked={done}
        onChange={onToggleDone}
        label={`Done: ${task.title}`}
        color={status?.color ?? null}
      />
      <button
        type="button"
        onClick={onOpen}
        className={cx(
          "min-w-0 flex-1 truncate rounded-sm text-left text-[13.5px] focus-visible:outline-2 focus-visible:outline-accent",
          done ? "text-ink-3 line-through" : "text-ink",
        )}
      >
        {task.title}
      </button>
      {/* In Today because it is due, not picked: no "remove", its due date says why. */}
      {!planned && task.due_date && (
        <span
          className={cx(
            "shrink-0 text-[12px] tabular-nums",
            isOverdue(task, ctx) ? "text-danger" : "text-ink-3",
          )}
        >
          {formatDue(task.due_date, ctx.today)}
        </span>
      )}
      {planned && (
        <IconButton
          label={`Remove ${task.title} from today`}
          onClick={onUnplan}
          className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Minus size={13} />
        </IconButton>
      )}
    </div>
  );
}
