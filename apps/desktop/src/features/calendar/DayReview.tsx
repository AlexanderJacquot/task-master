// The daily review (ADR 013): goes through the blocks that ended without an outcome, one
// at a time, and asks what became of each (done, worked or not done and replanned,
// cancelled). The list is taken when the review opens; Skip leaves a block as planned.

import { Dialog } from "radix-ui";
import { useState } from "react";
import { Button, Dot } from "../../components/ui";
import { addDays, formatRange } from "../../lib/calendar";
import { isoDate } from "../../lib/dates";
import { useStoreState } from "../../store/context";
import { BlockOutcomes } from "./BlockOutcome";
import { projectColor, useCalendar } from "./shared";

function dayName(start: number, today: string): string {
  const iso = isoDate(new Date(start));
  if (iso === today) return "Today";
  if (iso === addDays(today, -1)) return "Yesterday";
  return new Date(start).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function DayReview({ ids, onClose }: { ids: string[]; onClose(): void }) {
  const { tasks, projects, today, openTask } = useCalendar();
  const timeBlocks = useStoreState((s) => s.time_blocks);
  const [index, setIndex] = useState(0);
  const [reviewed, setReviewed] = useState(0);
  const block = index < ids.length ? timeBlocks[ids[index] ?? ""] : undefined;
  const task = block && tasks[block.task_id];
  const project = task?.project_id ? projects[task.project_id] : undefined;
  const next = () => setIndex((i) => i + 1);

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="tex-sheet fixed top-[12%] left-1/2 z-50 flex w-[26rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-4 rounded-2xl border border-line-strong bg-overlay p-5 shadow-2xl shadow-black/40"
        >
          <div className="flex items-baseline gap-3">
            <Dialog.Title className="flex-1 font-display text-[19px] tracking-wide text-accent">
              Review the day
            </Dialog.Title>
            {block && (
              <span className="text-[12.5px] text-ink-3 tabular-nums">
                {index + 1} of {ids.length}
              </span>
            )}
          </div>
          {block && task ? (
            <>
              <div className="flex flex-col gap-1">
                <p className="text-[12.5px] text-ink-2 tabular-nums">
                  {dayName(block.start_at, today)} · {formatRange(block.start_at, block.end_at)}
                </p>
                <p className="font-medium break-words text-ink">{task.title}</p>
                {project && (
                  <p className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
                    <Dot color={projectColor(task, projects)} />
                    {project.name}
                  </p>
                )}
              </div>
              <BlockOutcomes
                key={block.id}
                block={block}
                onChosen={() => {
                  setReviewed((n) => n + 1);
                  next();
                }}
              />
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={next}>
                  Skip
                </Button>
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onClose();
                    openTask(task.id);
                  }}
                >
                  Open task
                </Button>
              </div>
            </>
          ) : index < ids.length ? (
            // Removed (or its task deleted) since the review opened.
            <SkipGone onSkip={next} />
          ) : (
            <>
              <p className="text-ink-2">
                {reviewed === 0
                  ? "Nothing reviewed."
                  : `All caught up: ${reviewed} block${reviewed === 1 ? "" : "s"} reviewed.`}
                {reviewed < ids.length &&
                  ` ${ids.length - reviewed} left as planned for the next review.`}
              </p>
              <div className="flex justify-end">
                <Button size="sm" variant="primary" onClick={onClose}>
                  Close
                </Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SkipGone({ onSkip }: { onSkip(): void }) {
  return (
    <div className="flex items-center gap-2">
      <p className="flex-1 text-ink-3">This block was removed.</p>
      <Button size="sm" onClick={onSkip}>
        Next
      </Button>
    </div>
  );
}
