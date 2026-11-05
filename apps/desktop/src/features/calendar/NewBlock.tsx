// Creating a task straight on the time grid: press on an empty spot and drag to draw its
// time (a plain click makes a one-hour block), then type the task in the box that opens.
// The task and its block are one batch, so a single undo takes both away.

import { Popover } from "radix-ui";
import { useState } from "react";
import { Button, cx } from "../../components/ui";
import {
  atMinute,
  DAY_MIN,
  DEFAULT_BLOCK_MIN,
  formatDuration,
  formatTime,
  HOUR_PX,
  minuteAt,
  SNAP_MIN,
} from "../../lib/calendar";
import { isoDate } from "../../lib/dates";
import { captureTask, missingContainers } from "../../store/actions";
import { useApi, useTaskStore } from "../../store/context";

export interface Draft {
  startMin: number;
  endMin: number;
  /** False while the pointer is still down. */
  drawn: boolean;
}

/** Below this many pixels of movement, a press is a click, not a drag. */
const CLICK_PX = 4;

const floorSnap = (minute: number) => Math.floor(minute / SNAP_MIN) * SNAP_MIN;
const clampMin = (minute: number) => Math.min(Math.max(minute, 0), DAY_MIN);

/** Pointer handling for drawing a new block on a day column. */
export function useDrawBlock() {
  const [draft, setDraft] = useState<Draft | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    // Only on the empty grid: blocks, events and their handles keep their own gestures.
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    e.preventDefault();
    const columnTop = e.currentTarget.getBoundingClientRect().top;
    const startY = e.clientY;
    const anchor = clampMin(floorSnap(minuteAt(e.clientY, columnTop)));
    let moved = false;
    let current: Draft = {
      startMin: anchor,
      endMin: Math.min(anchor + DEFAULT_BLOCK_MIN, DAY_MIN),
      drawn: false,
    };
    setDraft(current);

    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < CLICK_PX) return;
      moved = true;
      const at = clampMin(floorSnap(minuteAt(ev.clientY, columnTop)));
      // Dragging up draws from the pointer down to the anchor's slot.
      const startMin = Math.min(anchor, at);
      const endMin = Math.max(anchor, at) + SNAP_MIN;
      current = { startMin, endMin: Math.min(endMin, DAY_MIN), drawn: false };
      setDraft(current);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraft({ ...current, drawn: true });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return { draft, setDraft, onPointerDown };
}

/** The drawn range on its column, with the "new task" box once the pointer is up. */
export function DraftBlock({
  iso,
  draft,
  onClose,
}: {
  iso: string;
  draft: Draft;
  onClose(): void;
}) {
  const store = useTaskStore();
  const api = useApi();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = atMinute(iso, draft.startMin);
  const end = atMinute(iso, draft.endMin);
  const range = `${formatTime(start)} – ${formatTime(end)}`;
  const minutes = draft.endMin - draft.startMin;

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const capture = await api.parseCapture(text, isoDate());
      if (!capture.title.trim()) {
        setError("The task needs a title, not only markers.");
        return;
      }
      const missing = missingContainers(capture);
      if (missing.length && confirm === null) {
        setConfirm(`Enter again to also create ${missing.join(" and ")}.`);
        return;
      }
      const id = await captureTask(store, capture, {}, { start_at: start, end_at: end });
      if (id) onClose();
    } catch {
      setError("Could not read this line. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover.Root open={draft.drawn} onOpenChange={(open) => !open && onClose()}>
      <Popover.Anchor asChild>
        <div
          aria-hidden
          data-testid="draft-block"
          className="pointer-events-none absolute inset-x-1 z-20 rounded-md border-l-[3px] border-accent bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent shadow-sm tabular-nums"
          style={{
            top: (draft.startMin / 60) * HOUR_PX,
            height: Math.max((minutes / 60) * HOUR_PX - 2, 14),
          }}
        >
          {range}
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="New task on the calendar"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector("input")?.focus();
          }}
          className="tm-menu tex-sheet z-40 flex w-72 flex-col gap-2 rounded-xl border border-line-strong bg-overlay p-3 text-sm"
        >
          <div className="text-[12.5px] text-ink-2 tabular-nums">
            {range} · {formatDuration(minutes)}
          </div>
          <input
            aria-label="New task"
            placeholder="Task name… #tag !high +Project"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
              setConfirm(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            className="h-8 rounded-md border border-line-strong bg-transparent px-2 text-ink outline-none placeholder:text-ink-3 focus:border-accent"
          />
          {(error || confirm) && (
            <p role="status" className={cx("text-xs", error ? "text-danger" : "text-ink-2")}>
              {error ?? confirm}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[11px] text-ink-3">Esc cancels</span>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!text.trim() || busy}
              onClick={() => void submit()}
            >
              Add to calendar
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
