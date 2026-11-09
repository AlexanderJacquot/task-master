import { Popover } from "radix-ui";
import { type ReactNode, useMemo, useState } from "react";
import { SearchIcon as Search } from "../../components/TaskIcons";
import { cx, Dot, INPUT, MENU, MENU_ITEM } from "../../components/ui";
import type { Task } from "../../lib/types";
import { useStoreState } from "../../store/context";
import { rankCandidates } from "./hierarchy";

/**
 * A button opening a searchable list of tasks; picking one calls `onPick` and closes.
 * `candidates` is computed only while the popover is open.
 */
export function TaskPicker({
  label,
  trigger,
  triggerClassName,
  candidates,
  onPick,
}: {
  /** Accessible name of the popover and its search box. */
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  candidates: () => Task[];
  onPick: (task: Task) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={triggerClassName}>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          aria-label={label}
          sideOffset={6}
          collisionPadding={12}
          className={cx(MENU, "w-80 max-w-[calc(100vw-1.5rem)] p-2")}
        >
          {open && (
            <PickerBody
              label={label}
              candidates={candidates}
              onPick={(task) => {
                setOpen(false);
                onPick(task);
              }}
            />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PickerBody({
  label,
  candidates,
  onPick,
}: {
  label: string;
  candidates: () => Task[];
  onPick: (task: Task) => void;
}) {
  const statuses = useStoreState((s) => s.statuses);
  const projects = useStoreState((s) => s.projects);
  const [query, setQuery] = useState("");
  // Read once per opening: the list doesn't shift while picking.
  const [all] = useState(candidates);
  const matches = useMemo(() => rankCandidates(all, query, statuses), [all, query, statuses]);
  const statusById = new Map(statuses.map((s) => [s.id, s]));

  return (
    <>
      <div className="relative mb-2">
        <Search size={14} className="pointer-events-none absolute top-2.5 left-2.5 text-ink-3" />
        <input
          // biome-ignore lint/a11y/noAutofocus: the popover exists to type a search
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !matches[0]) return;
            e.preventDefault();
            onPick(matches[0]);
          }}
          placeholder="Search tasks…"
          aria-label={label}
          className={cx(INPUT, "pl-8 text-[13px]")}
        />
      </div>
      <ul className="max-h-64 space-y-0.5 overflow-y-auto">
        {matches.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onPick(t)}
              className={cx(
                MENU_ITEM,
                "w-full cursor-pointer hover:bg-accent/10 focus-visible:bg-accent/10",
              )}
            >
              <Dot color={statusById.get(t.status_id)?.color ?? null} />
              <span className="min-w-0 flex-1 truncate text-left">{t.title}</span>
              {t.project_id && projects[t.project_id] && (
                <span className="max-w-[40%] shrink-0 truncate text-xs text-ink-3">
                  {projects[t.project_id]?.name}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {!matches.length && <p className="px-2 py-3 text-center text-xs text-ink-3">No tasks.</p>}
    </>
  );
}
