import { useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, MoreHorizontal, Trash2 } from "lucide-react";
import { DropdownMenu, Popover } from "radix-ui";
import { cx, Dot, IconButton, Select } from "../../components/ui";
import type { Project } from "../../lib/types";
import { deleteProject, moveProject, updateProject } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { EditableTitle } from "../shell/EditableTitle";
import { ViewPage } from "../shell/ViewPage";
import { PROJECT_COLORS } from "./projectColors";

function ColorPicker({ project }: { project: Project }) {
  const store = useTaskStore();
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Project color"
        className="flex size-7 items-center justify-center rounded-md hover:bg-hover"
      >
        <Dot color={project.color} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="z-50 grid grid-cols-5 gap-1.5 rounded-xl border border-line-strong bg-overlay p-2.5 shadow-xl"
        >
          {PROJECT_COLORS.map((color) => (
            <Popover.Close
              key={color}
              aria-label={`Color ${color}`}
              onClick={() => void updateProject(store, project.id, [{ color }])}
              className={cx(
                "h-5 w-5 rounded-full",
                project.color === color && "ring-2 ring-ink ring-offset-1 ring-offset-overlay",
              )}
              style={{ background: color }}
            />
          ))}
          <Popover.Close
            onClick={() => void updateProject(store, project.id, [{ color: null }])}
            className="col-span-5 mt-1 text-xs text-ink-3 hover:underline"
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
  const area = project.parent_id ? projects[project.parent_id] : undefined;
  const item =
    "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink outline-none data-highlighted:bg-hover";

  return (
    <ViewPage
      scope={{ kind: "project", id: project.id }}
      eyebrow={area?.name}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <Dot color={project.color} className="size-3" />
          <EditableTitle
            value={project.name}
            placeholder="Project name"
            onRename={(name) => void updateProject(store, project.id, [{ name }])}
          />
          {archived && (
            <span className="rounded-md bg-hover px-2 font-sans text-xs text-ink-2">Archived</span>
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
              className="h-7 text-[13px] text-ink-2"
            >
              <option value="">No area</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  In {a.name}
                </option>
              ))}
            </Select>
          )}
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <IconButton label="More project actions">
                <MoreHorizontal size={16} />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-50 min-w-44 rounded-xl border border-line-strong bg-overlay p-1 shadow-xl"
              >
                <DropdownMenu.Item
                  className={item}
                  onSelect={() => void updateProject(store, project.id, [{ archived: !archived }])}
                >
                  {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                  {archived ? "Unarchive" : "Archive"}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={cx(item, "text-danger")}
                  onSelect={async () => {
                    if ((await deleteProject(store, project.id)) !== null) {
                      void navigate({ to: "/inbox" });
                    }
                  }}
                >
                  <Trash2 size={14} /> Delete project
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </>
      }
    />
  );
}
