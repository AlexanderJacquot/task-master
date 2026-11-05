import { Check } from "lucide-react";
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
  urgent: "text-red-700 dark:text-red-400",
  high: "text-orange-700 dark:text-orange-400",
  normal: "text-ink-3",
  low: "text-ink-3",
};

/** Tinted pill backgrounds for urgent and high priority. */
export const PRIORITY_PILL: Record<Priority, string> = {
  urgent: "bg-red-700/12 text-red-800 dark:bg-red-400/15 dark:text-red-300",
  high: "bg-orange-700/12 text-orange-800 dark:bg-orange-400/15 dark:text-orange-300",
  normal: "bg-hover text-ink-2",
  low: "bg-hover text-ink-3",
};

/** Focus ring shared by every control. */
export const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/** Compact native select: fast, keyboard-friendly, no portal. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={cx(
        "rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-ink hover:border-line-strong focus:border-accent focus:outline-none",
        "[&>option]:bg-overlay [&>option]:text-ink",
        className,
      )}
    />
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost";

const BUTTON: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-ink font-display tracking-wide shadow-sm hover:bg-accent-hover disabled:opacity-40",
  secondary: "border border-line-strong text-ink-2 hover:bg-hover hover:text-ink",
  ghost: "text-ink-2 hover:bg-hover hover:text-ink",
};

/** A text button; `primary` uses the accent and the display face. */
export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg transition-colors disabled:cursor-default",
        size === "sm" ? "h-7 px-2.5 text-[13px]" : "h-8 px-3 text-sm",
        BUTTON[variant],
        FOCUS,
        className,
      )}
    />
  );
}

/** A square icon-only button; `label` is its accessible name and tooltip. */
export function IconButton({
  label,
  className,
  children,
  ...props
}: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink",
        FOCUS,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong px-1.5 font-mono text-[11px] leading-4 text-ink-3">
      {children}
    </kbd>
  );
}

/** Kept for settings and other plain boolean fields. */
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
      className="size-4 shrink-0 cursor-pointer accent-accent"
    />
  );
}

/**
 * The round task checkbox: a ring in the status color, filled with a check when done.
 * A native checkbox underneath keeps the role, label and keyboard behavior.
 */
export function TaskCheck({
  checked,
  onChange,
  label,
  color,
  size = "md",
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  color: string | null;
  size?: "md" | "lg";
}) {
  const ring = color ?? "var(--tm-ink-3)";
  return (
    <span
      className={cx(
        "relative inline-flex shrink-0 items-center justify-center rounded-full border-[1.6px] transition-colors",
        size === "lg" ? "size-6" : "size-[19px]",
      )}
      style={{ borderColor: ring, background: checked ? ring : "transparent" }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={label}
        className={cx(
          "absolute inset-0 cursor-pointer appearance-none rounded-full",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        )}
      />
      {checked && (
        <Check
          aria-hidden
          className="pointer-events-none text-canvas"
          size={size === "lg" ? 15 : 12}
          strokeWidth={3.2}
        />
      )}
    </span>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md bg-hover px-2 text-[12.5px] leading-5 text-ink-2",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A colored dot for projects and statuses. */
export function Dot({ color, className }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block size-2 shrink-0 rounded-full bg-ink-3", className)}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

/** Small uppercase-free section label in the display face. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx("font-display text-[14px] tracking-wide text-ink-2", className)}>
      {children}
    </span>
  );
}

export const INPUT =
  "w-full rounded-lg border border-line-strong bg-raised px-2.5 py-1.5 text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none";

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
      className={cx(INPUT, "py-1", className)}
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
