import { useNavigate } from "@tanstack/react-router";
import { Popover } from "radix-ui";
import { useMemo } from "react";
import { DatePicker } from "../../components/DatePicker";
import { cx, MENU, Select } from "../../components/ui";
import { isoDate } from "../../lib/dates";
import type { Epic, EpicState } from "../../lib/types";
import { categoryOf } from "../../lib/views";
import { deleteEpic, updateEpic } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { EditableTitle } from "../shell/EditableTitle";
import { HeaderButton, ViewPage } from "../shell/ViewPage";
import { EPIC_SHAPES, EpicMark } from "./EpicMark";
import { ProjectMark } from "./ProjectMark";
import { PROJECT_COLORS } from "./projectColors";

const STATES: Array<{ value: EpicState; label: string }> = [
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "dropped", label: "Dropped" },
];

/** Done / total over the epic's tasks, cancelled ones left out. */
export function useEpicProgress(epicId: string): { done: number; total: number } {
  const tasks = useStoreState((s) => s.tasks);
  const statuses = useStoreState((s) => s.statuses);
  return useMemo(() => {
    const byId = Object.fromEntries(statuses.map((s) => [s.id, s]));
    let done = 0;
    let total = 0;
    for (const t of Object.values(tasks)) {
      if (t.epic_id !== epicId) continue;
      const category = categoryOf(t, { statuses: byId });
      if (category === "cancelled") continue;
      total += 1;
      if (category === "done") done += 1;
    }
    return { done, total };
  }, [tasks, statuses, epicId]);
}

/** The mark beside the epic's name; click to pick its color and shape (like a project's). */
function EpicIconPicker({ epic }: { epic: Epic }) {
  const store = useTaskStore();
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Epic color and icon"
        title="Color and icon"
        className="flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-hover"
      >
        <EpicMark epic={epic} size={24} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className={cx(MENU, "grid min-w-0 grid-cols-5 gap-1.5 p-2.5")}
        >
          {PROJECT_COLORS.map((color) => (
            <Popover.Close
              key={color}
              aria-label={`Color ${color}`}
              onClick={() => void updateEpic(store, epic.id, [{ color }])}
              className={cx(
                "h-5 w-5 rounded-full",
                epic.color === color && "ring-2 ring-ink ring-offset-1 ring-offset-overlay",
              )}
              style={{ background: color }}
            />
          ))}
          <Popover.Close
            onClick={() => void updateEpic(store, epic.id, [{ color: null }])}
            className="col-span-5 mt-1 text-xs text-ink-3 hover:underline"
          >
            Default color
          </Popover.Close>
          <div className="col-span-5 my-1 h-px bg-line" />
          {Object.entries(EPIC_SHAPES).map(([value, Shape]) => (
            <Popover.Close
              key={value}
              aria-label={`Shape ${value}`}
              title={value.charAt(0).toUpperCase() + value.slice(1)}
              onClick={() =>
                void updateEpic(store, epic.id, [{ icon: value === "diamond" ? null : value }])
              }
              className={cx(
                "flex size-8 items-center justify-center rounded-md hover:bg-hover",
                (epic.icon ?? "diamond") === value && "bg-hover ring-1 ring-line-strong",
              )}
            >
              <Shape size={18} style={epic.color ? { color: epic.color } : undefined} />
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function EpicDetails({ epic }: { epic: Epic }) {
  const store = useTaskStore();
  const projects = useStoreState((s) => s.projects);
  const { done, total } = useEpicProgress(epic.id);
  const late = epic.state === "active" && epic.target_date !== null && epic.target_date < isoDate();

  return (
    <div className="flex flex-col gap-2 px-10 pb-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-3 text-ink-2">
        <Select
          aria-label="Epic state"
          value={epic.state}
          onValueChange={(state) => void updateEpic(store, epic.id, [{ state }])}
          options={STATES}
        />
        <div className="flex items-center gap-1">
          <span>Target</span>
          <DatePicker
            aria-label="Target date"
            value={epic.target_date}
            onValueChange={(target_date) => void updateEpic(store, epic.id, [{ target_date }])}
            className={late ? "text-danger" : undefined}
          />
        </div>
        <Select
          aria-label="Home project"
          value={epic.project_id ?? ""}
          onValueChange={(id) => void updateEpic(store, epic.id, [{ project_id: id || null }])}
          options={[
            { value: "", label: "No home project" },
            ...Object.values(projects)
              .filter((p) => p.archived_at === null || p.id === epic.project_id)
              .sort((a, b) => (a.rank < b.rank ? -1 : 1))
              .map((p) => ({ value: p.id, label: p.name, icon: <ProjectMark project={p} /> })),
          ]}
        />
        <span className="ml-auto flex items-center gap-2" title={`${done} of ${total} done`}>
          <span className="block h-1.5 w-32 overflow-hidden rounded-full bg-line-strong">
            <span
              className="block h-full bg-green-700 dark:bg-green-500"
              style={{ width: total ? `${(100 * done) / total}%` : 0 }}
            />
          </span>
          {done}/{total} done
        </span>
      </div>
      <textarea
        aria-label="Epic description"
        defaultValue={epic.description ?? ""}
        placeholder="What does done look like?"
        rows={2}
        onBlur={(e) => {
          const description = e.currentTarget.value.trim() || null;
          if (description !== epic.description) {
            void updateEpic(store, epic.id, [{ description }]);
          }
        }}
        className="w-full resize-y rounded-lg border border-transparent bg-transparent px-1.5 py-1 text-[14.5px] text-ink-2 hover:border-line-strong focus:border-accent focus:outline-none"
      />
    </div>
  );
}

/** An epic's tasks, with its fields and progress under the header. */
export function EpicPage({ epic }: { epic: Epic }) {
  const store = useTaskStore();
  const navigate = useNavigate();
  return (
    <ViewPage
      scope={{ kind: "epic", id: epic.id }}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <EpicIconPicker epic={epic} />
          <EditableTitle
            value={epic.name}
            placeholder="Epic name"
            onRename={(name) => void updateEpic(store, epic.id, [{ name }])}
          />
        </span>
      }
      details={<EpicDetails key={epic.id} epic={epic} />}
      actions={
        <HeaderButton
          onClick={async () => {
            if ((await deleteEpic(store, epic.id)) !== null) void navigate({ to: "/inbox" });
          }}
        >
          Delete epic
        </HeaderButton>
      }
    />
  );
}
