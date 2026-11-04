import type { ComponentProps, ReactNode } from "react";
import type { Priority } from "../lib/types";

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export const PRIORITIES: Array<{ value: Priority; label: string }> = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
];

export const PRIORITY_STYLE: Record<Priority, string> = {
  urgent: "text-red-600 dark:text-red-400",
  high: "text-orange-600 dark:text-orange-400",
  normal: "text-neutral-500",
  low: "text-neutral-400 dark:text-neutral-500",
};

/** Compact native select: fast, keyboard-friendly, no portal. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={cx(
        "rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-neutral-300 focus:border-blue-500 focus:outline-none dark:hover:border-neutral-700",
        className,
      )}
    />
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className="size-4 shrink-0 cursor-pointer accent-blue-600"
    />
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded bg-neutral-100 px-1.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A colored dot for projects and statuses. */
export function Dot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full bg-neutral-400"
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

/** An input that commits on Enter or blur and cancels on Escape. */
export function InlineInput({
  initial,
  onCommit,
  onCancel,
  placeholder,
  className,
  id,
  clearOnCommit,
  autoFocus,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel?: () => void;
  placeholder?: string;
  className?: string;
  id?: string;
  clearOnCommit?: boolean;
  /** Focus and select the text on mount (an input that replaces what was clicked). */
  autoFocus?: boolean;
}) {
  return (
    <input
      id={id}
      ref={(el) => {
        if (autoFocus && el && document.activeElement !== el) {
          el.focus();
          el.select();
        }
      }}
      defaultValue={initial}
      placeholder={placeholder}
      className={cx(
        "w-full rounded border border-neutral-300 bg-white px-2 py-1 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900",
        className,
      )}
      onKeyDown={(e) => {
        const input = e.currentTarget;
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(input.value);
          if (clearOnCommit) input.value = "";
        } else if (e.key === "Escape") {
          input.value = initial;
          onCancel?.();
        }
      }}
      onBlur={(e) => {
        if (!clearOnCommit && e.currentTarget.value !== initial) onCommit(e.currentTarget.value);
        else onCancel?.();
      }}
    />
  );
}
