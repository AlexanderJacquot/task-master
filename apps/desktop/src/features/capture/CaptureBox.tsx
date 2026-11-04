import { forwardRef, useCallback, useRef, useState } from "react";
import { Chip, cx, PRIORITY_STYLE } from "../../components/ui";
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
  const known = "text-green-700 dark:text-green-400";
  const unknown = "text-amber-700 dark:text-amber-400";
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
        <Chip className={PRIORITY_STYLE[capture.priority]}>!{capture.priority}</Chip>
      )}
      {capture.due_date && <Chip>Due {formatDue(capture.due_date, today)}</Chip>}
      {capture.warnings.map((w) => (
        <span key={w} className="text-red-600 dark:text-red-400">
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
    onCaptured?(taskId: string): void;
    onEscape?(): void;
    className?: string;
  }
>(function CaptureBox(p, ref) {
  const store = useTaskStore();
  const api = useApi();
  const [text, setText] = useState("");
  const [capture, setCapture] = useState<Capture | null>(null);
  const [confirming, setConfirming] = useState(false);
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

  const submit = async () => {
    // Parse the exact text being saved, even if a keystroke's parse is still in flight.
    const result = await parse(text);
    if (!result?.title.trim()) return;
    const missing = missingContainers(result);
    if (missing.length && !confirming) {
      setConfirming(true);
      return;
    }
    const id = await captureTask(store, result, p.defaults);
    setText("");
    setCapture(null);
    setConfirming(false);
    if (id) p.onCaptured?.(id);
  };

  const missing = capture ? missingContainers(capture) : [];

  return (
    <div className={cx("flex flex-col gap-1", p.className)}>
      <input
        ref={ref}
        id={p.id}
        value={text}
        // biome-ignore lint/a11y/noAutofocus: the capture window exists to type into
        autoFocus={p.autoFocus}
        aria-label="New task"
        placeholder={p.placeholder ?? `New task… (press n)   ${CAPTURE_HINT}`}
        className="w-full rounded border border-neutral-300 bg-white px-2 py-1 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900"
        onChange={(e) => {
          setText(e.target.value);
          setConfirming(false);
          if (e.target.value.trim()) void parse(e.target.value);
          else {
            seq.current += 1;
            setCapture(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            if (confirming) {
              e.stopPropagation();
              setConfirming(false);
            } else p.onEscape?.();
          }
        }}
      />
      {capture && text.trim() && hasMarkers(capture) && <Preview capture={capture} today={today} />}
      {confirming && missing.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400" role="alert">
          Create {missing.join(" and ")}? Enter to create, Esc to edit.
        </p>
      )}
    </div>
  );
});
