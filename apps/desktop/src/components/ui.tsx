import { ChevronDown, ChevronUp } from "lucide-react";
import { Select as RadixSelect } from "radix-ui";
import { type ComponentProps, type CSSProperties, type KeyboardEvent, type ReactNode, useRef } from "react";
import type { Priority } from "../lib/types";
import { CheckIcon as Check } from "./TaskIcons";

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
  urgent: "text-urgent",
  high: "text-high",
  normal: "text-ink-3",
  low: "text-ink-3",
};

/** Tinted pill backgrounds for urgent and high priority. */
export const PRIORITY_PILL: Record<Priority, string> = {
  urgent: "bg-urgent/14 text-urgent",
  high: "bg-high/14 text-high",
  normal: "bg-hover text-ink-2",
  low: "bg-hover text-ink-3",
};

/** Focus ring shared by every control. */
export const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/* One look for every floating list: dropdowns, ⋯ menus, context menus, pickers. The
   `tm-menu` class (index.css) adds the paper texture, layered shadow and open animation. */
/** A menu or list panel. */
export const MENU =
  "tm-menu tex-sheet z-50 overflow-hidden rounded-xl border border-line-strong bg-overlay p-1 text-sm text-ink";
/** A row in a menu; highlighted rows take a faint accent wash. */
export const MENU_ITEM =
  "relative flex min-h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1 text-sm text-ink outline-none select-none data-disabled:opacity-40 data-highlighted:bg-accent/10 data-[state=checked]:bg-accent/8 [&_svg]:shrink-0 [&_svg]:text-ink-3 data-highlighted:[&_svg]:text-ink";
/** A destructive row (delete). */
export const MENU_DANGER =
  "text-danger! data-highlighted:bg-danger/10 [&_svg]:text-danger! data-highlighted:[&_svg]:text-danger!";
export const MENU_SEPARATOR = "-mx-1 my-1 h-px bg-line";
/** A small heading inside a menu. */
export const MENU_LABEL = "px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-ink-3";

export type SelectOption<T extends string = string> = {
  value: T;
  label: string;
  /** Shown before the label, in the list and on the trigger (a dot, an emoji). */
  icon?: ReactNode;
  /** Extra classes for the label (a priority color). */
  className?: string;
};

/** Radix refuses "" as an item value; the empty choice ("None", "Inbox") maps to this. */
const NONE = "\u0000none";

/** The list part of a select, shared by `Select` and custom triggers (property pills). */
/** Typeahead for an open list: typed letters jump to the first label starting with them,
 * else the first containing them (Radix alone matches prefixes only). */
export function typeaheadMatch(labels: string[], query: string): number {
  const q = query.toLowerCase();
  const lower = labels.map((l) => l.trim().toLowerCase());
  const at = lower.findIndex((l) => l.startsWith(q));
  return at >= 0 ? at : lower.findIndex((l) => l.includes(q));
}

export function SelectRoot<T extends string>({
  value,
  onValueChange,
  options,
  children,
}: {
  value: T;
  onValueChange(value: T): void;
  options: SelectOption<T>[];
  children: ReactNode;
}) {
  const typed = useRef({ text: "", at: 0 });
  const onTypeahead = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === " " && !typed.current.text) return;
    const now = Date.now();
    const text = (now - typed.current.at > 800 ? "" : typed.current.text) + e.key;
    typed.current = { text, at: now };
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[role=option]"));
    const hit = typeaheadMatch(
      items.map((i) => i.textContent ?? ""),
      text,
    );
    e.stopPropagation();
    e.preventDefault();
    if (hit >= 0) items[hit]?.focus();
  };
  return (
    <RadixSelect.Root
      value={value === "" ? NONE : value}
      onValueChange={(v) => {
        const next = (v === NONE ? "" : v) as T;
        if (next !== value) onValueChange(next);
      }}
    >
      {children}
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          onKeyDownCapture={onTypeahead}
          className={cx(
            MENU,
            "max-h-[min(20rem,var(--radix-select-content-available-height))] min-w-[max(11rem,var(--radix-select-trigger-width))] max-w-[calc(100vw-1.5rem)]",
          )}
        >
          <RadixSelect.ScrollUpButton className="flex h-6 items-center justify-center text-ink-3">
            <ChevronUp size={14} />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="space-y-0.5">
            {options.map((o) => (
              <RadixSelect.Item
                key={o.value}
                value={o.value === "" ? NONE : o.value}
                className={cx(MENU_ITEM, "pr-8")}
              >
                {o.icon}
                <RadixSelect.ItemText>
                  <span className={cx("break-words", o.className)}>{o.label}</span>
                </RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="absolute right-2.5 inline-flex">
                  <Check size={14} className="text-accent!" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="flex h-6 items-center justify-center text-ink-3">
            <ChevronDown size={14} />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

/** A compact select: a quiet trigger with the chosen label, opening a styled list. */
export function Select<T extends string>({
  value,
  onValueChange,
  options,
  className,
  style,
  title,
  "aria-label": ariaLabel,
}: {
  value: T;
  onValueChange(value: T): void;
  options: SelectOption<T>[];
  className?: string;
  style?: CSSProperties;
  title?: string;
  "aria-label": string;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <SelectRoot value={value} onValueChange={onValueChange} options={options}>
      <RadixSelect.Trigger
        aria-label={ariaLabel}
        title={title}
        style={style}
        className={cx(
          "group/select inline-flex min-w-0 items-center gap-1.5 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-left text-ink",
          "transition-colors hover:border-line-strong hover:bg-hover data-[state=open]:border-accent/40 data-[state=open]:bg-selected",
          FOCUS,
          className,
        )}
      >
        {current?.icon}
        <span className={cx("min-w-0 flex-1 truncate", current?.className)}>
          {current?.label ?? ""}
        </span>
        <ChevronDown
          size={13}
          className="shrink-0 text-ink-3 transition-transform group-data-[state=open]/select:rotate-180"
        />
      </RadixSelect.Trigger>
    </SelectRoot>
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
        "relative inline-flex shrink-0 items-center justify-center rounded-full transition-colors",
        size === "lg" ? "size-6 border-2" : "size-[19px] border-[1.6px]",
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
