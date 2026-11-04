import { useNavigate } from "@tanstack/react-router";
import { Popover } from "radix-ui";
import { cx, Dot, Select } from "../../components/ui";
import type { Project } from "../../lib/types";
import { deleteProject, moveProject, updateProject } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { EditableTitle } from "../shell/EditableTitle";
import { HeaderButton, ViewPage } from "../shell/ViewPage";

export const PROJECT_COLORS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
  "#64748b",
];

function ColorPicker({ project }: { project: Project }) {
  const store = useTaskStore();
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Project color"
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <Dot color={project.color} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="z-50 grid grid-cols-5 gap-1 rounded-md border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          {PROJECT_COLORS.map((color) => (
            <Popover.Close
              key={color}
              aria-label={`Color ${color}`}
              onClick={() => void updateProject(store, project.id, [{ color }])}
              className={cx(
                "h-5 w-5 rounded-full",
                project.color === color && "ring-2 ring-neutral-900 ring-offset-1 dark:ring-white",
              )}
              style={{ background: color }}
            />
          ))}
          <Popover.Close
            onClick={() => void updateProject(store, project.id, [{ color: null }])}
            className="col-span-5 mt-1 text-xs text-neutral-500 hover:underline"
          >
            No color
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A project's tasks, with its settings in the header: name, color, area, archive, delete. */
export function ProjectPage({ project }: { project: Project }) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const projects = useStoreState((s) => s.projects);
  const isArea = Object.values(projects).some((p) => p.parent_id === project.id);
  // One level of areas: a project with children stays at the top; areas are top-level ones.
  const areas = Object.values(projects)
    .filter((p) => p.parent_id === null && p.id !== project.id && p.archived_at === null)
    .sort((a, b) => (a.rank < b.rank ? -1 : 1));
  const archived = project.archived_at !== null;

  return (
    <ViewPage
      scope={{ kind: "project", id: project.id }}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <EditableTitle
            value={project.name}
            placeholder="Project name"
            onRename={(name) => void updateProject(store, project.id, [{ name }])}
          />
          {archived && (
            <span className="rounded bg-neutral-200 px-1.5 text-xs font-normal text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
              Archived
            </span>
          )}
        </span>
      }
      actions={
        <>
          <ColorPicker project={project} />
          {!isArea && (
            <Select
              aria-label="Area"
              value={project.parent_id ?? ""}
              onChange={(e) =>
                void moveProject(store, project.id, e.target.value || null, null, null)
              }
              className="text-xs text-neutral-600 dark:text-neutral-400"
            >
              <option value="">No area</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  In {a.name}
                </option>
              ))}
            </Select>
          )}
          <HeaderButton
            onClick={() => void updateProject(store, project.id, [{ archived: !archived }])}
          >
            {archived ? "Unarchive" : "Archive"}
          </HeaderButton>
          <HeaderButton
            onClick={async () => {
              if ((await deleteProject(store, project.id)) !== null) {
                void navigate({ to: "/inbox" });
              }
            }}
          >
            Delete
          </HeaderButton>
        </>
      }
    />
  );
}
