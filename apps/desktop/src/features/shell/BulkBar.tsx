import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import { DatePicker } from "../../components/DatePicker";
import {
  CloseIcon,
  DeleteIcon,
  DueDateIcon,
  LozengeIcon,
  PriorityIcon,
  ProjectsIcon,
  TagIcon,
} from "../../components/TaskIcons";
import {
  Button,
  cx,
  Dot,
  IconButton,
  MENU,
  MENU_ITEM,
  MENU_LABEL,
  PRIORITIES,
  PRIORITY_STYLE,
} from "../../components/ui";
import { common } from "../../lib/selection";
import type { Task, TaskChange } from "../../lib/types";
import { deleteTasks, setTaggedMany, updateTasks } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { EpicMark } from "../organize/EpicMark";

interface Choice {
  value: string;
  label: string;
  icon?: ReactNode;
  className?: string;
}

/** The radio value when the picked tasks differ: matches no choice, so none is checked. */
const MIXED = "\u0000mixed";

const byRank = <T extends { rank: string }>(a: T, b: T) =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;

/** A bar button opening a list of values; the one every picked task shares is checked. */
function PickMenu({
  label,
  icon,
  choices,
  current,
  onPick,
}: {
  label: string;
  icon: ReactNode;
  choices: Choice[];
  current: string | null;
  onPick(value: string): void;
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="ghost">
          {icon}
          {label}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          sideOffset={8}
          collisionPadding={12}
          className={cx(MENU, "max-h-80 min-w-48 overflow-y-auto")}
        >
          <DropdownMenu.Label className={MENU_LABEL}>{label}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={current ?? MIXED} onValueChange={onPick}>
            {choices.map((c) => (
              <DropdownMenu.RadioItem key={c.value} value={c.value} className={MENU_ITEM}>
                {c.icon}
                <span className={cx("truncate", c.className)}>{c.label}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Shown while tasks are picked in a list or board (Ctrl/Shift+click, Ctrl+A): sets status,
 * priority, project, epic, due date or tags on all of them, or deletes them. Each action
 * is one batch, so Ctrl+Z undoes it at once.
 */
export function BulkBar({ ids, onClear }: { ids: ReadonlySet<string>; onClear(): void }) {
  const store = useTaskStore();
  const allTasks = useStoreState((s) => s.tasks);
  const statuses = useStoreState((s) => s.statuses);
  const projects = useStoreState((s) => s.projects);
  const epics = useStoreState((s) => s.epics);
  const tags = useStoreState((s) => s.tags);
  const picked = [...ids].flatMap((id) => (allTasks[id] ? [allTasks[id] as Task] : []));
  if (picked.length === 0) return null;

  const set = (changes: TaskChange[]) => void updateTasks(store, ids, changes);
  const shared = <T,>(f: (t: Task) => T) => common(picked.map(f));
  const tagList = Object.values(tags).sort((a, b) => a.name.localeCompare(b.name));
  const sharedDue = shared((t) => t.due_date);
  const sharedStatus = statuses.find((s) => s.id === shared((t) => t.status_id));

  return (
    <div
      role="toolbar"
      aria-label="Selected tasks"
      className="tm-menu tex-sheet absolute bottom-5 left-1/2 z-30 flex max-w-[calc(100%-2.5rem)] -translate-x-1/2 flex-wrap items-center gap-1 rounded-xl border border-line-strong bg-overlay px-2 py-1.5 text-sm shadow-xl"
    >
      <span className="px-2 font-display tracking-wide text-ink" aria-live="polite">
        {picked.length} selected
      </span>
      <span className="mx-1 h-5 w-px bg-line" />
      <PickMenu
        label="Status"
        icon={<Dot color={sharedStatus?.color ?? null} />}
        current={sharedStatus?.id ?? null}
        choices={statuses.map((s) => ({
          value: s.id,
          label: s.name,
          icon: <Dot color={s.color ?? null} />,
        }))}
        onPick={(status_id) => set([{ status_id }])}
      />
      <PickMenu
        label="Priority"
        icon={<PriorityIcon size={14} />}
        current={shared((t) => t.priority)}
        choices={PRIORITIES.map((p) => ({ ...p, className: PRIORITY_STYLE[p.value] }))}
        onPick={(priority) => set([{ priority: priority as Task["priority"] }])}
      />
      <PickMenu
        label="Project"
        icon={<ProjectsIcon size={14} />}
        current={shared((t) => t.project_id ?? "")}
        choices={[
          { value: "", label: "No project" },
          ...Object.values(projects)
            .sort(byRank)
            .map((p) => ({ value: p.id, label: p.name, icon: <Dot color={p.color} /> })),
        ]}
        onPick={(id) => set([{ project_id: id || null }])}
      />
      {Object.keys(epics).length > 0 && (
        <PickMenu
          label="Epic"
          icon={<LozengeIcon size={14} />}
          current={shared((t) => t.epic_id ?? "")}
          choices={[
            { value: "", label: "No epic" },
            ...Object.values(epics)
              .sort(byRank)
              .map((e) => ({
                value: e.id,
                label: e.name,
                icon: <EpicMark epic={e} size={12} />,
              })),
          ]}
          onPick={(id) => set([{ epic_id: id || null }])}
        />
      )}
      <DatePicker
        value={sharedDue}
        onValueChange={(due_date) => set([{ due_date }])}
        aria-label="Set due date of the selected tasks"
        className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
      >
        <DueDateIcon size={14} />
        Due
      </DatePicker>
      {tagList.length > 0 && (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <Button size="sm" variant="ghost">
              <TagIcon size={14} />
              Tags
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="top"
              sideOffset={8}
              collisionPadding={12}
              className={cx(MENU, "max-h-80 min-w-48 overflow-y-auto")}
            >
              <DropdownMenu.Label className={MENU_LABEL}>
                Add to all, or take off all
              </DropdownMenu.Label>
              {tagList.map((tag) => {
                const count = picked.filter((t) => t.tag_ids.includes(tag.id)).length;
                const all = count === picked.length;
                return (
                  <DropdownMenu.CheckboxItem
                    key={tag.id}
                    checked={all ? true : count > 0 ? "indeterminate" : false}
                    // Keep the menu open to tag several at once.
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => void setTaggedMany(store, ids, tag.id, !all)}
                    className={MENU_ITEM}
                  >
                    <span className="w-3.5 text-accent">{all ? "✓" : count > 0 ? "–" : ""}</span>
                    <span className="truncate">#{tag.name}</span>
                  </DropdownMenu.CheckboxItem>
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      <span className="mx-1 h-5 w-px bg-line" />
      <Button
        size="sm"
        variant="ghost"
        className="text-danger! hover:bg-danger/10"
        onClick={() => {
          void deleteTasks(store, ids);
          onClear();
        }}
        title="Delete the selected tasks and their subtasks (Ctrl+Z brings them back)"
      >
        <DeleteIcon size={14} />
        Delete
      </Button>
      <IconButton label="Clear selection (Esc)" onClick={onClear}>
        <CloseIcon size={14} />
      </IconButton>
    </div>
  );
}
