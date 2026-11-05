import { Popover } from "radix-ui";
import { cx, Dot, MENU, MENU_ITEM, MENU_LABEL, PRIORITIES, Select } from "../../components/ui";
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
          "max-w-52 truncate rounded-full border px-3 py-0.5 text-[13px]",
          selected.length
            ? "border-accent/60 bg-accent/10 text-accent"
            : "border-line-strong text-ink-2 hover:bg-hover",
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
          className={cx(MENU, "max-h-72 w-56 overflow-y-auto")}
        >
          {options.length === 0 && <p className={MENU_LABEL}>Nothing yet</p>}
          {options.map((o) => (
            <label key={o.value} className={cx(MENU_ITEM, "cursor-pointer hover:bg-accent/10")}>
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
    <div className="flex flex-wrap items-center gap-2 px-10 pb-2">
      <span className="text-[13px] text-ink-3">Filter by</span>
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
        onValueChange={(due) => set({ due: due || null })}
        className={cx(
          "rounded-full! border px-3 text-[13px]",
          filter.due
            ? "border-accent/60 bg-accent/10 text-accent"
            : "border-line-strong text-ink-2 hover:bg-hover",
        )}
        options={DUE_OPTIONS}
      />
      {!filterIsEmpty(filter) && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTER)}
          className="text-[13px] text-ink-3 underline hover:text-ink"
        >
          Clear
        </button>
      )}
    </div>
  );
}
