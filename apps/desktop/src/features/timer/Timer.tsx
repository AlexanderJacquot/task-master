import { EstimateIcon, PlayIcon, StopIcon } from "../../components/TaskIcons";
import { cx, FOCUS, IconButton } from "../../components/ui";
import {
  formatClock,
  formatLogged,
  loggedMs,
  MIN_LOGGED_MS,
  type RunningTimer,
  useNow,
  useTimers,
} from "../../lib/timer";
import type { Task } from "../../lib/types";
import { startTimer, stopTimer } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { useOpenTask } from "../shell/useOpenTask";

/**
 * The task's timer and logged time: Start timer, or the running clock with Stop. Logged
 * time is the task's done and worked blocks (the calendar's), the running one excluded.
 */
export function TaskTimer({ task }: { task: Task }) {
  const store = useTaskStore();
  const timers = useTimers();
  const timer = timers.find((t) => t.task_id === task.id);
  const running = timer !== undefined;
  const now = useNow(running);
  const blocks = useStoreState((s) => s.time_blocks);
  const logged = loggedMs(Object.values(blocks), task.id);
  const elapsed = running && timer ? now - timer.started_at : 0;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
      {running ? (
        <button
          type="button"
          onClick={() => void stopTimer(store, task.id)}
          title={
            elapsed < MIN_LOGGED_MS
              ? "Stop the timer (under a minute: nothing is logged)"
              : "Stop the timer and log the time"
          }
          className={cx(
            "inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-0.5 text-accent hover:bg-accent/25",
            FOCUS,
          )}
        >
          <StopIcon size={13} />
          Stop
          <span className="font-mono tabular-nums">{formatClock(elapsed)}</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void startTimer(store, task.id)}
          title="Start a timer on this task"
          className={cx(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-ink-2 hover:bg-hover hover:text-ink",
            FOCUS,
          )}
        >
          <PlayIcon size={13} />
          Start timer
        </button>
      )}
      {logged > 0 && (
        <span className="inline-flex items-center gap-1 text-ink-3">
          <EstimateIcon size={13} aria-hidden />
          {formatLogged(logged)} logged
          {task.estimate_min ? ` of ${formatLogged(task.estimate_min * 60_000)}` : ""}
        </span>
      )}
    </div>
  );
}


/**
 * The running timers in the sidebar, on every page: one row per timer (opens its task) with
 * Stop. Nothing when no timer runs.
 */
export function TimerPill({ compact = false }: { compact?: boolean }) {
  const timers = useTimers();
  if (timers.length === 0) return null;
  return (
    <section aria-label="Timers" className="flex flex-col gap-1">
      {timers.map((timer) => (
        <TimerRow key={timer.task_id} timer={timer} compact={compact} />
      ))}
    </section>
  );
}

function TimerRow({ timer, compact }: { timer: RunningTimer; compact: boolean }) {
  const store = useTaskStore();
  const task = useStoreState((s) => s.tasks[timer.task_id]);
  const now = useNow(true);
  const openTask = useOpenTask();
  const clock = formatClock(now - timer.started_at);
  const title = task?.title ?? "A deleted task";
  const stop = (
    <IconButton
      label={`Stop the timer on ${title} and log the time`}
      onClick={() => void stopTimer(store, timer.task_id)}
      className="text-accent"
    >
      <StopIcon size={compact ? 13 : 15} />
    </IconButton>
  );

  if (compact) {
    return (
      <div
        data-testid="timer"
        className="flex flex-col items-center rounded-lg border border-accent/50 bg-accent/10 py-1"
      >
        <button
          type="button"
          disabled={!task}
          onClick={() => task && openTask(task.id)}
          title={`${title}: ${clock}`}
          className={cx("font-mono text-[10.5px] text-accent tabular-nums", FOCUS)}
        >
          {clock}
        </button>
        {stop}
      </div>
    );
  }

  return (
    <div
      data-testid="timer"
      className="flex items-center gap-1 rounded-lg border border-accent/50 bg-accent/10 py-0.5 pr-1 pl-2.5 text-[13.5px]"
    >
      <button
        type="button"
        disabled={!task}
        onClick={() => task && openTask(task.id)}
        title={task ? `Open ${task.title}` : undefined}
        className={cx("flex min-w-0 flex-1 items-center gap-2 text-left", FOCUS)}
      >
        <PlayIcon size={13} className="shrink-0 animate-pulse text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-ink">{title}</span>
        <span className="font-mono text-accent tabular-nums">{clock}</span>
      </button>
      {stop}
    </div>
  );
}
