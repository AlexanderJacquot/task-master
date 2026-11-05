import { Link, useRouterState } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ArrowDownCircle,
  Bookmark,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Diamond,
  Hash,
  Inbox,
  Layers,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sun,
  Trash2,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { type ReactNode, useMemo, useState } from "react";
import {
  cx,
  FOCUS,
  IconButton,
  InlineInput,
  MENU,
  MENU_DANGER,
  MENU_ITEM,
  MENU_SEPARATOR,
} from "../../components/ui";
import { isoDate } from "../../lib/dates";
import { useKeymap, withKeys } from "../../lib/keymap";
import type { Project, Tag } from "../../lib/types";
import { useUpdates } from "../../lib/updater";
import { inView, isOpen, type ViewContext } from "../../lib/views";
import { createEpic, createProject, deleteProject, updateProject } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { ProjectMark } from "../organize/ProjectMark";
import { PROJECT_COLORS } from "../organize/projectColors";
import { TagMenu } from "../organize/TagMenu";
import { useShell } from "../shell/shellContext";
import { ProjectTree } from "./ProjectTree";
import { useProjectOrder } from "./useProjectOrder";

/** Sidebar widths in px, open and folded to a rail (the Windows title bar matches them). */
export const SIDEBAR_WIDTH = { open: 264, rail: 60 } as const;

const rowClass =
  "group flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-[5px] text-ink-2 transition-colors hover:bg-hover hover:text-ink";
const activeClass = "bg-selected text-ink";

function NavItem({
  to,
  params,
  icon,
  children,
  count,
  title,
}: {
  to: string;
  params?: Record<string, string>;
  icon?: ReactNode;
  children: ReactNode;
  count?: number;
  title?: string;
}) {
  return (
    <Link
      to={to}
      params={params as never}
      search={{}}
      title={title}
      className={cx(rowClass, FOCUS)}
      activeProps={{ className: activeClass }}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && count > 0 && (
        <span className="text-[12.5px] text-ink-3 tabular-nums">{count}</span>
      )}
    </Link>
  );
}

/** A tag in the sidebar: link, open-task count, ⋯ menu (also on right-click). */
function TagRow({ tag, count }: { tag: Tag; count?: number }) {
  const [menu, setMenu] = useState(false);
  const active = useRouterState({
    select: (r) => r.location.pathname === `/tag/${tag.id}`,
  });
  return (
    <div className={cx(rowClass, "py-0 pr-1", active && activeClass)}>
      <Link
        to="/tag/$tagId"
        params={{ tagId: tag.id }}
        search={{}}
        className={cx("flex min-w-0 flex-1 items-center gap-2.5 py-[5px]", FOCUS)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
      >
        <Hash size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{tag.name}</span>
        {count !== undefined && count > 0 && (
          <span className="text-[12.5px] text-ink-3 tabular-nums">{count}</span>
        )}
      </Link>
      <TagMenu
        tag={tag}
        open={menu}
        onOpenChange={setMenu}
        trigger={
          <button
            type="button"
            aria-label={`${tag.name} actions`}
            title="Delete tag"
            className={cx(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink",
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
              FOCUS,
            )}
          >
            <MoreHorizontal size={15} />
          </button>
        }
      />
    </div>
  );
}

/** The "?" box: opens the keyboard shortcuts overlay. */
function ShortcutsButton({ onClick, className }: { onClick(): void; className?: string }) {
  const keymap = useKeymap();
  return (
    <button
      type="button"
      aria-label="Keyboard shortcuts"
      title={withKeys(keymap, "help", "Keyboard shortcuts")}
      onClick={onClick}
      className={cx(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-line-strong font-mono text-[13px] text-ink-3 transition-colors hover:border-ink-3 hover:bg-hover hover:text-ink",
        FOCUS,
        className,
      )}
    >
      ?
    </button>
  );
}

const SECTIONS_KEY = "task-master.sidebar-sections";

function loadOpenSections(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** A collapsible sidebar section whose open state is remembered per machine. */
function Collapsible({
  id,
  title,
  count,
  defaultOpen = false,
  onAdd,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  defaultOpen?: boolean;
  onAdd?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => loadOpenSections()[id] ?? defaultOpen);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify({ ...loadOpenSections(), [id]: next }));
    } catch {
      // Not remembered; fine.
    }
  };
  return (
    <section className="mt-1">
      <div className="group/section flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className={cx(
            "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-[5px] text-left text-ink-2 hover:bg-hover hover:text-ink",
            FOCUS,
          )}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="flex-1 font-display tracking-wide">{title}</span>
          {count !== undefined && count > 0 && (
            <span className="text-[12.5px] text-ink-3 tabular-nums">{count}</span>
          )}
        </button>
        {onAdd && (
          <IconButton
            label={`New ${title.toLowerCase().replace(/s$/, "")}`}
            onClick={onAdd}
            className="size-6 opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100"
          >
            <Plus size={14} />
          </IconButton>
        )}
      </div>
      {open && <div className="mt-0.5 flex flex-col gap-px">{children}</div>}
    </section>
  );
}

/** The ⋯ menu of a project (also opened with a right-click on the row). */
function ProjectMenu({
  project,
  open,
  onOpenChange,
  onRename,
}: {
  project: Project;
  open: boolean;
  onOpenChange(open: boolean): void;
  onRename(): void;
}) {
  const store = useTaskStore();
  const archived = project.archived_at !== null;
  const item = MENU_ITEM;
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenu.Trigger
        aria-label={`${project.name} actions`}
        title="Rename, color, archive, delete"
        className={cx(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink",
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
          FOCUS,
        )}
      >
        <MoreHorizontal size={15} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={cx(MENU, "min-w-48")}>
          <DropdownMenu.Item className={item} onSelect={onRename}>
            <Pencil size={14} /> Rename
          </DropdownMenu.Item>
          <div className="grid grid-cols-5 gap-1.5 px-2 py-2">
            {PROJECT_COLORS.map((color) => (
              <DropdownMenu.Item
                key={color}
                aria-label={`Color ${color}`}
                onSelect={() => void updateProject(store, project.id, [{ color }])}
                className={cx(
                  "size-5 rounded-full outline-none data-highlighted:ring-2 data-highlighted:ring-ink-3",
                  project.color === color && "ring-2 ring-ink ring-offset-1 ring-offset-overlay",
                )}
                style={{ background: color }}
              />
            ))}
          </div>
          <DropdownMenu.Separator className={MENU_SEPARATOR} />
          <DropdownMenu.Item
            className={item}
            onSelect={() => void updateProject(store, project.id, [{ archived: !archived }])}
          >
            {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {archived ? "Unarchive" : "Archive"}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={cx(item, MENU_DANGER)}
            onSelect={() => void deleteProject(store, project.id)}
          >
            <Trash2 size={14} /> Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** A project in the sidebar: link, hover tools (+ add task, ⋯ menu), inline rename. */
function ProjectRow({
  project,
  count,
  shortcut,
  muted,
}: {
  project: Project;
  count: number;
  shortcut?: number;
  muted?: boolean;
}) {
  const store = useTaskStore();
  const shell = useShell();
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  const active = useRouterState({
    select: (r) => r.location.pathname === `/project/${project.id}`,
  });

  if (renaming) {
    return (
      <InlineInput
        initial={project.name}
        placeholder="Project name"
        autoFocus
        className="my-px"
        onCommit={(name) => {
          setRenaming(false);
          const next = name.trim();
          if (next && next !== project.name)
            void updateProject(store, project.id, [{ name: next }]);
        }}
        onCancel={() => setRenaming(false)}
      />
    );
  }

  return (
    <div className={cx(rowClass, "py-0 pr-1", active && activeClass, muted && "text-ink-3")}>
      <Link
        to="/project/$projectId"
        params={{ projectId: project.id }}
        search={{}}
        title={shortcut ? `${project.name}  (Ctrl+${shortcut})` : project.name}
        className={cx("flex min-w-0 flex-1 items-center gap-2.5 py-[5px]", FOCUS)}
        onDoubleClick={(e) => {
          e.preventDefault();
          setRenaming(true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
      >
        <ProjectMark project={project} dotClass="size-[9px]" className="text-[13px]" />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
      </Link>
      <IconButton
        label={`Add task to ${project.name}`}
        onClick={() => shell.openNewTask({ project_id: project.id })}
        className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Plus size={14} />
      </IconButton>
      <ProjectMenu
        project={project}
        open={menu}
        onOpenChange={setMenu}
        onRename={() => setRenaming(true)}
      />
      <span className="w-5 text-right text-[12.5px] text-ink-3 tabular-nums">
        {count > 0 ? count : ""}
      </span>
    </div>
  );
}

export function Sidebar({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed(): void;
}) {
  const store = useTaskStore();
  const shell = useShell();
  const keymap = useKeymap();
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const epics = useStoreState((s) => s.epics);
  const tags = useStoreState((s) => s.tags);
  const views = useStoreState((s) => s.views);
  const statusList = useStoreState((s) => s.statuses);
  const [adding, setAdding] = useState<"project" | "epic" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const order = useProjectOrder();

  const ctx: ViewContext = useMemo(
    () => ({
      today: isoDate(),
      statuses: Object.fromEntries(statusList.map((s) => [s.id, s])),
      projects,
    }),
    [statusList, projects],
  );

  const counts = useMemo(() => {
    const all = Object.values(tasks);
    const open = (t: (typeof all)[number]) => isOpen(t, ctx);
    const perProject = new Map<string, number>();
    const perEpic = new Map<string, { done: number; total: number }>();
    const perTag = new Map<string, number>();
    for (const t of all) {
      if (t.project_id && open(t))
        perProject.set(t.project_id, (perProject.get(t.project_id) ?? 0) + 1);
      if (t.epic_id && ctx.statuses[t.status_id]?.category !== "cancelled") {
        const e = perEpic.get(t.epic_id) ?? { done: 0, total: 0 };
        e.total += 1;
        if (!open(t)) e.done += 1;
        perEpic.set(t.epic_id, e);
      }
      if (open(t)) for (const tag of t.tag_ids) perTag.set(tag, (perTag.get(tag) ?? 0) + 1);
    }
    return {
      inbox: all.filter((t) => inView({ kind: "inbox" }, t, ctx)).length,
      today: all.filter((t) => inView({ kind: "today" }, t, ctx) && open(t)).length,
      perProject,
      perEpic,
      perTag,
    };
  }, [tasks, ctx]);

  const areas = useMemo(() => {
    const list = Object.values(projects).filter((p) => p.archived_at === null);
    const byRank = (a: Project, b: Project) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0);
    return list
      .filter((p) => p.parent_id === null)
      .sort(byRank)
      .map((area) => ({
        area,
        children: list.filter((p) => p.parent_id === area.id).sort(byRank),
      }));
  }, [projects]);

  const archived = useMemo(
    () =>
      Object.values(projects)
        .filter((p) => p.archived_at !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );

  const [epicList, finishedEpics] = useMemo(() => {
    const sorted = Object.values(epics).sort((a, b) => (a.rank < b.rank ? -1 : 1));
    return [sorted.filter((e) => e.state === "active"), sorted.filter((e) => e.state !== "active")];
  }, [epics]);

  const viewList = useMemo(
    () => Object.values(views).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)),
    [views],
  );
  const tagList = useMemo(
    () => Object.values(tags).sort((a, b) => a.name.localeCompare(b.name)),
    [tags],
  );

  const projectCount = (id: string, children: Project[]) =>
    (counts.perProject.get(id) ?? 0) +
    children.reduce((n, c) => n + (counts.perProject.get(c.id) ?? 0), 0);
  const shortcutOf = (id: string) => {
    const i = order.indexOf(id);
    return i >= 0 && i < 9 ? i + 1 : undefined;
  };

  if (collapsed) {
    return (
      <nav
        aria-label="Sidebar"
        style={{ width: SIDEBAR_WIDTH.rail }}
        className="tex-sidebar flex shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line bg-sidebar py-4"
      >
        <IconButton label="Expand sidebar" onClick={onToggleCollapsed} className="mb-1 size-8">
          <PanelLeftOpen size={17} />
        </IconButton>
        <button
          type="button"
          aria-label="New task"
          title={withKeys(keymap, "newTask", "New task")}
          onClick={() => shell.openNewTask()}
          className={cx(
            "mb-2 flex size-9 items-center justify-center rounded-[10px] bg-accent text-accent-ink shadow-sm hover:bg-accent-hover",
            FOCUS,
          )}
        >
          <Plus size={18} strokeWidth={2.4} />
        </button>
        <RailLink to="/inbox" label="Inbox">
          <Inbox size={18} className="text-sky-700 dark:text-sky-300" />
        </RailLink>
        <RailLink to="/today" label="Today">
          <Sun size={18} className="text-amber-700 dark:text-amber-300" />
        </RailLink>
        <RailLink to="/calendar" label="Calendar">
          <CalendarDays size={18} className="text-rubric" />
        </RailLink>
        <RailLink to="/all" label="All tasks">
          <Layers size={18} />
        </RailLink>
        <div className="my-2 h-px w-6 bg-line" />
        {order.map((id, i) => {
          const p = projects[id];
          if (!p) return null;
          return (
            <RailLink
              key={id}
              to="/project/$projectId"
              params={{ projectId: id }}
              label={i < 9 ? `${p.name}  (Ctrl+${i + 1})` : p.name}
            >
              <ProjectMark project={p} dotClass="size-2.5" className="text-[15px]" />
            </RailLink>
          );
        })}
        <div className="flex-1" />
        <UpdatePill compact />
        <ShortcutsButton onClick={shell.showShortcuts} className="mb-1" />
        <RailLink to="/settings" label="Settings">
          <Settings2 size={17} />
        </RailLink>
      </nav>
    );
  }

  return (
    <nav
      aria-label="Sidebar"
      style={{ width: SIDEBAR_WIDTH.open }}
      className="tex-sidebar flex shrink-0 flex-col overflow-y-auto border-r border-line bg-sidebar px-3 pt-4 pb-3"
    >
      <div className="flex items-center gap-2 px-2 pb-3">
        <span className="flex-1 font-display text-[21px] tracking-wide text-accent">
          Task Master
        </span>
        <IconButton label="Collapse sidebar" onClick={onToggleCollapsed}>
          <PanelLeftClose size={16} />
        </IconButton>
      </div>
      <div className="flex gap-1.5 px-0.5 pb-4">
        <button
          type="button"
          onClick={() => shell.openNewTask()}
          title={withKeys(keymap, "newTask", "New task")}
          className={cx(
            "flex h-9 flex-1 items-center justify-center gap-2 rounded-[10px] bg-accent font-display text-[15px] tracking-wide text-accent-ink shadow-sm transition-colors hover:bg-accent-hover",
            FOCUS,
          )}
        >
          <Plus size={16} strokeWidth={2.4} />
          New task
        </button>
        <button
          type="button"
          aria-label="Jump to"
          title={withKeys(keymap, "palette", "Jump to…")}
          onClick={shell.openPalette}
          className={cx(
            "flex size-9 items-center justify-center rounded-[10px] border border-line-strong text-ink-2 transition-colors hover:bg-hover hover:text-ink",
            FOCUS,
          )}
        >
          <Search size={16} />
        </button>
      </div>

      <div className="flex flex-col gap-px">
        <NavItem
          to="/inbox"
          count={counts.inbox}
          icon={<Inbox size={17} className="shrink-0 text-sky-700 dark:text-sky-300" />}
        >
          Inbox
        </NavItem>
        <NavItem
          to="/today"
          count={counts.today}
          icon={<Sun size={17} className="shrink-0 text-amber-700 dark:text-amber-300" />}
        >
          Today
        </NavItem>
        <NavItem to="/calendar" icon={<CalendarDays size={17} className="shrink-0 text-rubric" />}>
          Calendar
        </NavItem>
        <NavItem to="/all" icon={<Layers size={17} className="shrink-0" />}>
          All tasks
        </NavItem>
      </div>

      <section className="mt-5">
        <div className="group/section flex items-center justify-between px-2.5 pb-1.5">
          <span className="font-display text-[14px] tracking-wide text-rubric">Projects</span>
          <IconButton label="New project" onClick={() => setAdding("project")} className="size-6">
            <Plus size={14} />
          </IconButton>
        </div>
        <div className="flex flex-col gap-px">
          <ProjectTree
            nodes={areas}
            renderProject={(p, children) => (
              <ProjectRow
                project={p}
                count={projectCount(p.id, children)}
                shortcut={shortcutOf(p.id)}
              />
            )}
          />
          {adding === "project" && (
            <InlineInput
              initial=""
              placeholder="Project name"
              autoFocus
              onCommit={(name) => {
                setAdding(null);
                void createProject(store, name);
              }}
              onCancel={() => setAdding(null)}
              className="mt-1"
            />
          )}
          {!areas.length && adding !== "project" && (
            <button
              type="button"
              onClick={() => setAdding("project")}
              className="rounded-lg px-2.5 py-1 text-left text-[13px] text-ink-3 hover:bg-hover"
            >
              Create your first project
            </button>
          )}
          {archived.length > 0 && (
            <>
              <button
                type="button"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((v) => !v)}
                className="mt-1 flex items-center gap-1.5 px-2.5 py-0.5 text-left text-[12.5px] text-ink-3 hover:text-ink"
              >
                {showArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Archived ({archived.length})
              </button>
              {showArchived &&
                archived.map((p) => <ProjectRow key={p.id} project={p} count={0} muted />)}
            </>
          )}
        </div>
      </section>

      <div className="mx-2 mt-4 mb-2 h-px bg-line" />

      <Collapsible
        id="epics"
        title="Epics"
        count={epicList.length}
        onAdd={() => setAdding("epic")}
        defaultOpen={false}
      >
        {epicList.map((epic) => {
          const progress = counts.perEpic.get(epic.id) ?? { done: 0, total: 0 };
          return (
            <NavItem
              key={epic.id}
              to="/epic/$epicId"
              params={{ epicId: epic.id }}
              icon={<Diamond size={13} className="shrink-0 text-violet-700 dark:text-violet-300" />}
              title={`${progress.done} of ${progress.total} done`}
            >
              <span className="flex items-center gap-2">
                <span className="truncate">{epic.name}</span>
                <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-line-strong">
                  <span
                    className="block h-full bg-green-700 dark:bg-green-500"
                    style={{
                      width: progress.total ? `${(100 * progress.done) / progress.total}%` : 0,
                    }}
                  />
                </span>
              </span>
            </NavItem>
          );
        })}
        {finishedEpics.map((epic) => (
          <NavItem
            key={epic.id}
            to="/epic/$epicId"
            params={{ epicId: epic.id }}
            icon={<Diamond size={13} className="shrink-0 text-ink-3" />}
          >
            <span className="text-ink-3">
              {epic.name} · {epic.state}
            </span>
          </NavItem>
        ))}
        {!epicList.length && !finishedEpics.length && (
          <p className="px-2.5 py-1 text-[12.5px] text-ink-3">No epics yet</p>
        )}
      </Collapsible>
      {adding === "epic" && (
        <InlineInput
          initial=""
          placeholder="Epic name"
          autoFocus
          onCommit={(name) => {
            setAdding(null);
            void createEpic(store, name);
          }}
          onCancel={() => setAdding(null)}
          className="mt-1"
        />
      )}

      <Collapsible id="views" title="Saved views" count={viewList.length}>
        {viewList.map((view) => (
          <NavItem
            key={view.id}
            to="/view/$viewId"
            params={{ viewId: view.id }}
            icon={<Bookmark size={14} className="shrink-0" />}
          >
            {view.name}
          </NavItem>
        ))}
        {viewList.length === 0 && (
          <p className="px-2.5 py-1 text-[12.5px] text-ink-3">
            Use "Save as view" in any view's Display menu
          </p>
        )}
      </Collapsible>

      <Collapsible id="tags" title="Tags" count={tagList.length}>
        {tagList.map((tag) => (
          <TagRow key={tag.id} tag={tag} count={counts.perTag.get(tag.id)} />
        ))}
        {tagList.length === 0 && (
          <p className="px-2.5 py-1 text-[12.5px] text-ink-3">Type #tag when adding a task</p>
        )}
      </Collapsible>

      <div className="mt-auto flex flex-col gap-1 pt-4">
        <UpdatePill />
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <NavItem
              to="/settings"
              icon={<Settings2 size={16} className="shrink-0" />}
              title={withKeys(keymap, "goSettings", "Settings")}
            >
              Settings
            </NavItem>
          </div>
          <ShortcutsButton onClick={shell.showShortcuts} />
        </div>
      </div>
    </nav>
  );
}

/** Shown above Settings when a newer release is waiting (or installed and needs a restart). */
function UpdatePill({ compact }: { compact?: boolean }) {
  const updates = useUpdates();
  const status = updates?.status;
  if (!status || (status.kind !== "available" && status.kind !== "ready")) return null;
  const label =
    status.kind === "ready"
      ? `Restart to use ${status.update.version}`
      : `Update to ${status.update.version}`;
  return (
    <Link
      to="/settings"
      search={{}}
      aria-label={label}
      title={label}
      className={cx(
        "flex items-center gap-2 rounded-lg border border-accent/50 bg-accent/10 text-accent hover:bg-accent/15",
        compact ? "size-9 justify-center" : "px-2.5 py-1.5 text-[13.5px]",
        FOCUS,
      )}
    >
      <ArrowDownCircle size={compact ? 17 : 15} className="shrink-0" />
      {!compact && label}
    </Link>
  );
}

function RailLink({
  to,
  params,
  label,
  children,
}: {
  to: string;
  params?: Record<string, string>;
  label: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      params={params as never}
      search={{}}
      aria-label={label}
      title={label}
      className={cx(
        "flex size-9 shrink-0 items-center justify-center rounded-[9px] text-ink-2 hover:bg-hover hover:text-ink",
        FOCUS,
      )}
      activeProps={{ className: "bg-selected text-ink" }}
    >
      {children}
    </Link>
  );
}
