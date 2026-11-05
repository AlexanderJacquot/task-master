import { forwardRef, useCallback, useRef, useState } from "react";
import { AddIcon as Plus } from "../../components/TaskIcons";
import { Button, Chip, cx, PRIORITY_PILL } from "../../components/ui";
import { formatDue, isoDate } from "../../lib/dates";
import type { Capture } from "../../lib/types";
import { captureTask, missingContainers, type NewTaskInput } from "../../store/actions";
import { useApi, useTaskStore } from "../../store/context";

export const CAPTURE_HINT = "#tag  @Project  +epic:Name  !high  ^fri";

function hasMarkers(c: Capture): boolean {
  return (
    c.tags.length > 0 ||
    c.project !== null ||
    c.epic !== null ||
    c.priority !== null ||
    c.due_date !== null ||
    c.warnings.length > 0
  );
}

/** What the line will create, read by the core parser as you type. */
function Preview({ capture, today }: { capture: Capture; today: string }) {
  const known = "text-green-800 dark:text-green-300";
  const unknown = "text-amber-800 dark:text-amber-300";
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="capture-preview">
      {capture.project && (
        <Chip className={capture.project.id ? known : unknown}>
          @{capture.project.name}
          {!capture.project.id && " (new project)"}
        </Chip>
      )}
      {capture.epic && (
        <Chip className={capture.epic.id ? known : unknown}>
          ◆ {capture.epic.name}
          {!capture.epic.id && " (new epic)"}
        </Chip>
      )}
      {capture.tags.map((t) => (
        <Chip key={t.name} className={t.id ? undefined : unknown}>
          #{t.name}
          {!t.id && " (new)"}
        </Chip>
      ))}
      {capture.priority && (
        <Chip className={PRIORITY_PILL[capture.priority]}>!{capture.priority}</Chip>
      )}
      {capture.due_date && <Chip>Due {formatDue(capture.due_date, today)}</Chip>}
      {capture.warnings.map((w) => (
        <span key={w} className="text-danger">
          {w}
        </span>
      ))}
    </div>
  );
}

/**
 * The capture input used everywhere (every view and the quick-capture window): plain text
 * plus inline markers, previewed live. An unknown project or epic needs a second Enter.
 */
export const CaptureBox = forwardRef<
  HTMLInputElement,
  {
    id?: string;
    /** What the current view adds (its project, epic, tag or today). Markers win. */
    defaults?: Omit<NewTaskInput, "title">;
    placeholder?: string;
    autoFocus?: boolean;
    /** `open`: Shift+Enter was used, so the caller may open the new task. */
    onCaptured?(taskId: string, how: { open: boolean }): void;
    onEscape?(): void;
    className?: string;
    /** `inline`: the row above a list; `dialog` / `window`: large input with a footer. */
    variant?: "inline" | "dialog" | "window";
    /** Footer text for the large variants. */
    footer?: string;
  }
>(function CaptureBox(p, ref) {
  const store = useTaskStore();
  const api = useApi();
  const [text, setText] = useState("");
  const [capture, setCapture] = useState<Capture | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const today = isoDate();

  const parse = useCallback(
    async (value: string) => {
      const mine = ++seq.current;
      try {
        const result = await api.parseCapture(value, isoDate());
        if (mine === seq.current) setCapture(result);
        return result;
      } catch {
        return null;
      }
    },
    [api],
  );

  const submit = async (open = false) => {
    // Parse the exact text being saved, even if a keystroke's parse is still in flight.
    if (!text.trim()) return;
    const result = await parse(text);
    if (!result) {
      setError("Could not read this line. Try again, or check the markers.");
      return;
    }
    if (!result.title.trim()) {
      setError("The task needs a title, not only markers.");
      return;
    }
    setError(null);
    const missing = missingContainers(result);
    if (missing.length && !confirming) {
      setConfirming(true);
      return;
    }
    const id = await captureTask(store, result, p.defaults);
    setText("");
    setCapture(null);
    setConfirming(false);
    if (id) p.onCaptured?.(id, { open });
  };

  const missing = capture ? missingContainers(capture) : [];

  const variant = p.variant ?? "inline";
  const big = variant !== "inline";

  return (
    <div className={cx("flex flex-col", big ? "gap-0" : "gap-1.5", p.className)}>
      <div
        className={cx(
          "flex items-center gap-3",
          variant === "inline" &&
            "rounded-[10px] border border-dashed border-line-strong px-3.5 py-1.5 transition-colors focus-within:border-solid focus-within:border-accent focus-within:bg-raised/60",
          big && "border-b border-line px-5 py-4",
        )}
      >
        <Plus
          aria-hidden
          size={big ? 18 : 16}
          strokeWidth={1.75}
          className="shrink-0 text-accent"
        />
        <input
          ref={ref}
          id={p.id}
          value={text}
          // biome-ignore lint/a11y/noAutofocus: the capture window and dialog exist to type into
          autoFocus={p.autoFocus}
          aria-label="New task"
          placeholder={p.placeholder ?? `New task… (press n)   ${CAPTURE_HINT}`}
          className={cx(
            "min-w-0 flex-1 bg-transparent text-ink placeholder:text-ink-3 focus:outline-none",
            big ? "text-[19px]" : "py-0.5",
          )}
          onChange={(e) => {
            setText(e.target.value);
            setConfirming(false);
            setError(null);
            if (e.target.value.trim()) void parse(e.target.value);
            else {
              seq.current += 1;
              setCapture(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit(e.shiftKey);
            } else if (e.key === "Escape") {
              if (confirming) {
                e.stopPropagation();
                setConfirming(false);
              } else p.onEscape?.();
            }
          }}
        />
        {variant === "inline" && (
          <Button variant="primary" size="sm" onClick={() => void submit()} disabled={!text.trim()}>
            {confirming ? "Create" : "Add task"}
          </Button>
        )}
      </div>
      <div className={cx("flex flex-col gap-1.5", big && "px-5 py-3", !big && "px-1")}>
        {capture && text.trim() && hasMarkers(capture) ? (
          <Preview capture={capture} today={today} />
        ) : (
          big && <p className="font-mono text-[12px] text-ink-3">{CAPTURE_HINT}</p>
        )}
        {error && (
          <p className="text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        {confirming && missing.length > 0 && (
          <p className="text-[13px] text-amber-800 dark:text-amber-300" role="alert">
            Create {missing.join(" and ")}? Enter or Create to confirm, Esc to edit.
          </p>
        )}
      </div>
      {big && (
        <div className="flex items-center gap-2.5 border-t border-line bg-hover/50 px-5 py-3 text-[12.5px] text-ink-3">
          <span className="flex-1">
            {p.footer ?? "Enter adds · Shift+Enter adds and opens · Esc closes"}
          </span>
          {p.onEscape && (
            <Button size="sm" onClick={p.onEscape}>
              Cancel
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={() => void submit()} disabled={!text.trim()}>
            {confirming ? "Create" : "Add task"}
          </Button>
        </div>
      )}
    </div>
  );
});
