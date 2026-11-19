// What became of a time block (ADR 013), shared by the block menu and the daily review:
// Done, Cancelled, or "Worked, replan" / "Not done, replan", which set the outcome and then
// ask where the next block goes (later today, the next working day, or a picked time).

import { useMemo, useState } from "react";
import { Button, cx, FOCUS, INPUT } from "../../components/ui";
import { addDays, atMinute, formatDuration, formatTime } from "../../lib/calendar";
import { dayLabel, laterToday, nextWorkday, type ReplanInput } from "../../lib/replan";
import type { BlockOutcome, TimeBlock } from "../../lib/types";
import { scheduleTask, setBlockOutcome } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { useCalendar } from "./shared";

interface Choice {
  value: BlockOutcome;
  label: string;
  hint: string;
  /** Asks where the next block goes once the outcome is set. */
  replan?: boolean;
}

const CHOICES: Choice[] = [
  { value: "done", label: "Done", hint: "Logs the time and completes the task" },
  { value: "cancelled", label: "Cancelled", hint: "Not happening: logs no time" },
  {
    value: "worked",
    label: "Worked, replan",
    hint: "Logs the time, then plans the rest",
    replan: true,
  },
  {
    value: "missed",
    label: "Not done, replan",
    hint: "Logs no time, then plans it again",
    replan: true,
  },
];

const PLANNED: Choice = { value: "planned", label: "Planned", hint: "No outcome yet" };

/**
 * The outcome buttons. `withPlanned` adds Planned (back to no outcome). `onChosen` runs
 * after Done, Cancelled or Planned, and after the replan step of the other two.
 */
export function BlockOutcomes({
  block,
  withPlanned = false,
  onChosen,
}: {
  block: TimeBlock;
  withPlanned?: boolean;
  onChosen?(outcome: BlockOutcome): void;
}) {
  const store = useTaskStore();
  const [replanning, setReplanning] = useState<BlockOutcome | null>(null);

  if (replanning) {
    return (
      <ReplanPicker
        block={block}
        worked={replanning === "worked"}
        onDone={() => {
          setReplanning(null);
          onChosen?.(replanning);
        }}
      />
    );
  }

  const choose = (c: Choice) => {
    void setBlockOutcome(store, block.id, c.value);
    if (c.replan) setReplanning(c.value);
    else onChosen?.(c.value);
  };
  return (
    <fieldset aria-label="Outcome" className="grid grid-cols-2 gap-1">
      {[...CHOICES, ...(withPlanned ? [PLANNED] : [])].map((c) => (
        <button
          key={c.value}
          type="button"
          title={c.hint}
          aria-pressed={block.outcome === c.value}
          onClick={() => choose(c)}
          className={cx(
            "rounded-md px-2 py-1 text-[12.5px] transition-colors",
            c.value === "planned" && "col-span-2",
            block.outcome === c.value
              ? "bg-selected text-ink shadow-sm"
              : "text-ink-2 hover:bg-hover",
            FOCUS,
          )}
        >
          {c.label}
        </button>
      ))}
    </fieldset>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Where the task's next block goes: the first free stretch left today, the next working
 * day, or a picked day and time. The new block is as long as this one. "Not now" leaves
 * the task in the tray to plan later.
 */
export function ReplanPicker({
  block,
  worked,
  onDone,
}: {
  block: TimeBlock;
  worked: boolean;
  onDone(): void;
}) {
  const store = useTaskStore();
  const { today, now, hours, busyEvents } = useCalendar();
  const timeBlocks = useStoreState((s) => s.time_blocks);
  const minutes = Math.max(Math.round((block.end_at - block.start_at) / 60_000), 15);
  const { later, next } = useMemo(() => {
    const input: ReplanInput = {
      today,
      now,
      hours,
      blocks: Object.values(timeBlocks),
      events: busyEvents,
      minutes,
    };
    return { later: laterToday(input), next: nextWorkday(input) };
  }, [today, now, hours, timeBlocks, busyEvents, minutes]);
  const [picking, setPicking] = useState(false);
  const [day, setDay] = useState(next?.iso ?? addDays(today, 1));
  const [time, setTime] = useState(
    next ? clock(next.start_at) : `${pad(Math.floor(hours.startMin / 60))}:00`,
  );

  const schedule = async (start: number) => {
    await scheduleTask(store, block.task_id, start, start + minutes * 60_000);
    onDone();
  };
  const picked = () => {
    const [h, m] = time.split(":").map(Number);
    if (!day || h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return;
    void schedule(atMinute(day, h * 60 + m));
  };

  return (
    <fieldset aria-label="Replan" className="flex flex-col gap-1.5">
      <legend className="mb-1 text-[12.5px] text-ink-2">
        {worked ? "Logged. " : ""}Plan {formatDuration(minutes)} more:
      </legend>
      <Button
        size="sm"
        disabled={!later}
        className="justify-between"
        onClick={() => later && void schedule(later.start_at)}
      >
        <span>Later today</span>
        <span className="text-ink-3 tabular-nums">
          {later ? formatTime(later.start_at) : "no free time"}
        </span>
      </Button>
      {next && (
        <Button size="sm" className="justify-between" onClick={() => void schedule(next.start_at)}>
          <span>{dayLabel(next.iso, today)}</span>
          <span className="text-ink-3 tabular-nums">{formatTime(next.start_at)}</span>
        </Button>
      )}
      {picking ? (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            aria-label="Day"
            value={day}
            min={today}
            onChange={(e) => setDay(e.target.value)}
            className={cx(INPUT, "h-7 min-w-0 flex-1 px-1.5 text-[12.5px]")}
          />
          <input
            type="time"
            aria-label="Time"
            step={900}
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className={cx(INPUT, "h-7 w-[5.5rem] px-1.5 text-[12.5px]")}
          />
          <Button size="sm" variant="primary" onClick={picked}>
            Plan
          </Button>
        </div>
      ) : (
        <Button size="sm" onClick={() => setPicking(true)}>
          Pick a time…
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onDone}>
        Not now (keep it in the tray)
      </Button>
    </fieldset>
  );
}
