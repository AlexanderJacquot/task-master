import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { Select } from "../../components/ui";
import { isoDate } from "../../lib/dates";
import type { Epic, EpicState } from "../../lib/types";
import { categoryOf } from "../../lib/views";
import { deleteEpic, updateEpic } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { EditableTitle } from "../shell/EditableTitle";
import { HeaderButton, ViewPage } from "../shell/ViewPage";
import { ProjectMark } from "./ProjectMark";

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
        <label className="flex items-center gap-1">
          Target
          <input
            type="date"
            aria-label="Target date"
            value={epic.target_date ?? ""}
            onChange={(e) =>
              void updateEpic(store, epic.id, [{ target_date: e.target.value || null }])
            }
            className={
              late
                ? "rounded border border-red-300 bg-transparent px-1 text-red-600"
                : "rounded border border-neutral-300 bg-transparent px-1 dark:border-neutral-700"
            }
          />
        </label>
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
        <EditableTitle
          value={epic.name}
          placeholder="Epic name"
          onRename={(name) => void updateEpic(store, epic.id, [{ name }])}
        />
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
