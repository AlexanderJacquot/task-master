import { Popover } from "radix-ui";
import { cx, Dot, PRIORITIES, Select } from "../../components/ui";
import type { DueFilter, Epic, Priority, Project, Status, Tag, ViewFilter } from "../../lib/types";
import { EMPTY_FILTER, filterIsEmpty } from "../../lib/views";

interface Option {
  value: string;
  label: string;
  color?: string | null;
}

/** A chip that opens a checklist; shows how many values are picked. */
function MultiPick({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Option[];
  selected: string[];
  onChange(next: string[]): void;
}) {
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  const names = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Filter by ${label.toLowerCase()}`}
        className={cx(
          "max-w-48 truncate rounded border px-2 py-0.5 text-xs",
          selected.length
            ? "border-blue-400 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-200"
            : "border-neutral-300 text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900",
        )}
      >
        {label}
        {names.length > 0 &&
          `: ${names.length > 2 ? `${names.length} selected` : names.join(", ")}`}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 max-h-72 w-56 overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          {options.length === 0 && (
            <p className="px-2 py-1 text-xs text-neutral-400">Nothing yet</p>
          )}
          {options.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => toggle(o.value)}
              />
              {o.color !== undefined && <Dot color={o.color} />}
              <span className="truncate">{o.label}</span>
            </label>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const DUE_OPTIONS: Array<{ value: DueFilter | ""; label: string }> = [
  { value: "", label: "Any due date" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today or earlier" },
  { value: "week", label: "Due within 7 days" },
  { value: "none", label: "No due date" },
];

/** Filters on top of the view's scope: status, priority, project, epic, tags, due date. */
export function FilterBar({
  filter,
  onChange,
  statuses,
  projects,
  epics,
  tags,
}: {
  filter: ViewFilter;
  onChange(filter: ViewFilter): void;
  statuses: Status[];
  projects: Record<string, Project>;
  epics: Record<string, Epic>;
  tags: Record<string, Tag>;
}) {
  const set = (patch: Partial<ViewFilter>) => onChange({ ...filter, ...patch });
  const byRank = <T extends { rank: string }>(a: T, b: T) => (a.rank < b.rank ? -1 : 1);
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-200 px-4 py-1.5 dark:border-neutral-800">
      <span className="text-xs text-neutral-400">Filter</span>
      <MultiPick
        label="Status"
        options={statuses.map((s) => ({ value: s.id, label: s.name, color: s.color }))}
        selected={filter.status_ids}
        onChange={(status_ids) => set({ status_ids })}
      />
      <MultiPick
        label="Priority"
        options={PRIORITIES}
        selected={filter.priorities}
        onChange={(priorities) => set({ priorities: priorities as Priority[] })}
      />
      <MultiPick
        label="Project"
        options={Object.values(projects)
          .filter((p) => p.archived_at === null)
          .sort(byRank)
          .map((p) => ({ value: p.id, label: p.name, color: p.color }))}
        selected={filter.project_ids}
        onChange={(project_ids) => set({ project_ids })}
      />
      <MultiPick
        label="Epic"
        options={Object.values(epics)
          .sort(byRank)
          .map((e) => ({ value: e.id, label: e.name }))}
        selected={filter.epic_ids}
        onChange={(epic_ids) => set({ epic_ids })}
      />
      <MultiPick
        label="Tags"
        options={Object.values(tags)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t) => ({ value: t.id, label: `#${t.name}` }))}
        selected={filter.tag_ids}
        onChange={(tag_ids) => set({ tag_ids })}
      />
      <Select
        aria-label="Filter by due date"
        value={filter.due ?? ""}
        onChange={(e) => set({ due: (e.target.value || null) as DueFilter | null })}
        className={cx(
          "text-xs",
          filter.due ? "text-blue-700 dark:text-blue-300" : "text-neutral-500",
        )}
      >
        {DUE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      {!filterIsEmpty(filter) && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTER)}
          className="text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          Clear
        </button>
      )}
    </div>
  );
}
