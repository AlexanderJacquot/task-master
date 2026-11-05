import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { Popover } from "radix-ui";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { isoDate } from "../lib/dates";
import { DueDateIcon } from "./TaskIcons";
import { Button, cx, FOCUS, IconButton, INPUT, MENU } from "./ui";

function dateFrom(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function offsetDate(value: string, days: number): string {
  const date = dateFrom(value);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function monthOf(value: string): Date {
  const date = dateFrom(value);
  date.setDate(1);
  return date;
}

/** The same themed, keyboard-accessible calendar wherever a calendar date is edited. */
export function DatePicker({
  value,
  onValueChange,
  "aria-label": label,
  today = isoDate(),
  placeholder = "Set date",
  className,
  children,
}: {
  value: string | null;
  onValueChange: (value: string | null) => void;
  "aria-label": string;
  today?: string;
  placeholder?: string;
  className?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => monthOf(value ?? today));
  const [focused, setFocused] = useState(value ?? today);
  const [draft, setDraft] = useState(value ?? "");
  const [error, setError] = useState("");
  const focusRequested = useRef(false);
  const activeDay = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const errorId = useId();

  function changeOpen(next: boolean) {
    if (next) {
      setMonth(monthOf(value ?? today));
      setFocused(value ?? today);
      setDraft(value ?? "");
      setError("");
    }
    setOpen(next);
  }

  function choose(next: string | null) {
    if (next !== value) onValueChange(next);
    setOpen(false);
  }

  function moveFocus(next: string) {
    focusRequested.current = true;
    setFocused(next);
    setMonth(monthOf(next));
  }

  function calendarKey(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    let next: string;
    switch (event.key) {
      case "ArrowLeft":
        next = offsetDate(date, -1);
        break;
      case "ArrowRight":
        next = offsetDate(date, 1);
        break;
      case "ArrowUp":
        next = offsetDate(date, -7);
        break;
      case "ArrowDown":
        next = offsetDate(date, 7);
        break;
      case "Home":
        next = offsetDate(date, -((dateFrom(date).getDay() + 6) % 7));
        break;
      case "End":
        next = offsetDate(date, 6 - ((dateFrom(date).getDay() + 6) % 7));
        break;
      case "PageUp":
      case "PageDown": {
        const target = dateFrom(date);
        const day = target.getDate();
        target.setDate(1);
        target.setMonth(target.getMonth() + (event.key === "PageUp" ? -1 : 1));
        const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
        target.setDate(Math.min(day, last));
        next = isoDate(target);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    moveFocus(next);
  }

  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const start = offsetDate(isoDate(month), -((month.getDay() + 6) % 7));
  const weeks = Array.from({ length: open ? 6 : 0 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => offsetDate(start, week * 7 + day)),
  );
  const quickDates = [
    { label: "Today", date: today },
    { label: "Tomorrow", date: offsetDate(today, 1) },
    { label: "In a week", date: offsetDate(today, 7) },
  ];

  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger
        aria-label={label}
        className={cx(
          !children &&
            "inline-flex min-w-0 items-center gap-2 rounded-md border border-transparent px-1.5 py-1 text-left text-sm text-ink transition-colors hover:border-line-strong hover:bg-hover data-[state=open]:bg-selected",
          FOCUS,
          className,
        )}
      >
        {children ?? (
          <>
            <DueDateIcon size={14} />
            <span className={cx("truncate", !value && "text-ink-3")}>
              {value
                ? dateFrom(value).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : placeholder}
            </span>
          </>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label={`Choose ${label.toLowerCase()}`}
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            activeDay.current?.focus();
          }}
          className={cx(
            MENU,
            "max-h-(--radix-popover-content-available-height) w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto p-3",
          )}
        >
          <div className="mb-3 flex gap-1.5">
            {quickDates.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => choose(item.date)}
                className={cx(
                  "flex-1 rounded-lg border border-line-strong px-1 py-1.5 text-xs text-ink-2 transition-colors hover:border-accent/40 hover:bg-accent/10 hover:text-ink",
                  FOCUS,
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="mb-1 flex items-center justify-between">
            <span id={headingId} aria-live="polite" className="pl-1 text-sm font-medium">
              {monthLabel}
            </span>
            <div className="flex gap-0.5">
              <IconButton
                label="Previous month"
                onClick={() => {
                  const previous = new Date(month.getFullYear(), month.getMonth() - 1, 1);
                  setMonth(previous);
                  setFocused(isoDate(previous));
                }}
              >
                <ChevronLeft size={15} />
              </IconButton>
              <IconButton
                label="Next month"
                onClick={() => {
                  const next = new Date(month.getFullYear(), month.getMonth() + 1, 1);
                  setMonth(next);
                  setFocused(isoDate(next));
                }}
              >
                <ChevronRight size={15} />
              </IconButton>
            </div>
          </div>
          <table
            aria-labelledby={headingId}
            className="w-full table-fixed border-separate border-spacing-0.5 text-center text-[13px]"
          >
            <thead>
              <tr>
                {weeks[0]?.map((date) => (
                  <th
                    key={date}
                    scope="col"
                    className="h-7 text-[11px] font-normal text-ink-3"
                    abbr={dateFrom(date).toLocaleDateString(undefined, { weekday: "long" })}
                  >
                    {dateFrom(date).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={week[0]}>
                  {week.map((date) => (
                    <td key={date}>
                      <button
                        type="button"
                        aria-pressed={date === value}
                        tabIndex={date === focused ? 0 : -1}
                        ref={
                          date === focused
                            ? (element) => {
                                activeDay.current = element;
                                if (element && focusRequested.current) {
                                  focusRequested.current = false;
                                  element.focus();
                                }
                              }
                            : undefined
                        }
                        aria-label={dateFrom(date).toLocaleDateString(undefined, {
                          weekday: "long",
                          month: "long",
                          day: "numeric",
                          year: "numeric",
                        })}
                        aria-current={date === today ? "date" : undefined}
                        onFocus={() => setFocused(date)}
                        onKeyDown={(event) => calendarKey(event, date)}
                        onClick={() => choose(date)}
                        className={cx(
                          "flex aspect-square w-full items-center justify-center rounded-lg tabular-nums transition-colors",
                          FOCUS,
                          date === value
                            ? "bg-accent font-semibold text-accent-ink"
                            : "hover:bg-hover",
                          date !== value &&
                            (date.slice(0, 7) === isoDate(month).slice(0, 7)
                              ? "text-ink"
                              : "text-ink-3/60"),
                          date === today &&
                            date !== value &&
                            "font-semibold text-accent ring-1 ring-inset ring-accent/40",
                        )}
                      >
                        {dateFrom(date).getDate()}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <form
            className="mt-3 border-t border-line pt-3"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = dateFrom(draft);
              if (
                !/^\d{4}-\d{2}-\d{2}$/.test(draft) ||
                Number.isNaN(parsed.getTime()) ||
                isoDate(parsed) !== draft
              ) {
                setError("Enter a valid date as YYYY-MM-DD.");
                return;
              }
              choose(draft);
            }}
          >
            <div className="flex items-center gap-2">
              <input
                aria-label="Enter date"
                placeholder="YYYY-MM-DD"
                value={draft}
                aria-invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError("");
                }}
                className={cx(INPUT, "min-w-0 flex-1 py-1 text-xs tabular-nums")}
              />
              <Button type="submit" size="sm" aria-label="Apply date">
                <ArrowRight size={14} />
              </Button>
            </div>
            {error && (
              <p id={errorId} role="alert" className="mt-1.5 text-xs text-danger">
                {error}
              </p>
            )}
          </form>
          {value && (
            <button
              type="button"
              onClick={() => choose(null)}
              className={cx(
                "mt-2 w-full rounded-lg py-1.5 text-xs text-ink-3 hover:bg-hover hover:text-ink",
                FOCUS,
              )}
            >
              Clear date
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
