import { useNavigate } from "@tanstack/react-router";
import { DropdownMenu, Popover } from "radix-ui";
import {
  ArchiveIcon as Archive,
  UnarchiveIcon as ArchiveRestore,
  MoreIcon as MoreHorizontal,
  DeleteIcon as Trash2,
} from "../../components/TaskIcons";
import { cx, IconButton, MENU, MENU_DANGER, MENU_ITEM, Select } from "../../components/ui";
import type { Project } from "../../lib/types";
import { deleteProject, moveProject, updateProject } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { ProjectFolderButton } from "../agents/ProjectFolderButton";
import { EditableTitle } from "../shell/EditableTitle";
import { ViewPage } from "../shell/ViewPage";
import { firstGrapheme, PROJECT_ICONS, ProjectMark } from "./ProjectMark";
import { PROJECT_COLORS } from "./projectColors";

function ColorPicker({ project }: { project: Project }) {
  const store = useTaskStore();
  const setIcon = (icon: string | null) => {
    if (icon !== project.icon) void updateProject(store, project.id, [{ icon }]);
  };
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Project color and icon"
        title="Color and icon"
        className="flex size-7 items-center justify-center rounded-md hover:bg-hover"
      >
        <ProjectMark project={project} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className={cx(MENU, "grid min-w-0 grid-cols-5 gap-1.5 p-2.5")}
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
          <div className="col-span-5 my-1 h-px bg-line" />
          {PROJECT_ICONS.map((icon) => (
            <Popover.Close
              key={icon}
              aria-label={`Icon ${icon}`}
              onClick={() => setIcon(icon)}
              className={cx(
                "flex size-6 items-center justify-center rounded-md text-[15px] leading-none hover:bg-hover",
                project.icon === icon && "bg-hover ring-1 ring-line-strong",
              )}
            >
              {icon}
            </Popover.Close>
          ))}
          <input
            aria-label="Custom icon"
            placeholder="Other emoji…"
            defaultValue={project.icon && !PROJECT_ICONS.includes(project.icon) ? project.icon : ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") setIcon(firstGrapheme(e.currentTarget.value));
            }}
            onBlur={(e) => {
              const icon = firstGrapheme(e.currentTarget.value);
              if (icon) setIcon(icon);
            }}
            className="col-span-5 mt-1 h-7 rounded-md border border-line-strong bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-accent"
          />
          {project.icon && (
            <Popover.Close
              onClick={() => setIcon(null)}
              className="col-span-5 mt-1 text-xs text-ink-3 hover:underline"
            >
              No icon (show the color dot)
            </Popover.Close>
          )}
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
  const item = MENU_ITEM;

  return (
    <ViewPage
      scope={{ kind: "project", id: project.id }}
      eyebrow={area?.name}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ProjectMark project={project} dotClass="size-3" className="text-[0.85em]" />
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
          <ProjectFolderButton projectId={project.id} />
          <ColorPicker project={project} />
          {!isArea && (
            <Select
              aria-label="Area"
              value={project.parent_id ?? ""}
              onValueChange={(id) => void moveProject(store, project.id, id || null, null, null)}
              className="h-7 text-[13px] text-ink-2"
              options={[
                { value: "", label: "No area" },
                ...areas.map((a) => ({
                  value: a.id,
                  label: `In ${a.name}`,
                  icon: <ProjectMark project={a} />,
                })),
              ]}
            />
          )}
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <IconButton label="More project actions">
                <MoreHorizontal size={16} />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className={cx(MENU, "min-w-44")}>
                <DropdownMenu.Item
                  className={item}
                  onSelect={() => void updateProject(store, project.id, [{ archived: !archived }])}
                >
                  {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                  {archived ? "Unarchive" : "Archive"}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={cx(item, MENU_DANGER)}
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
