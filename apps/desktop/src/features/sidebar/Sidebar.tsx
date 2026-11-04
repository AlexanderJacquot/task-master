import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { Dot, InlineInput } from "../../components/ui";
import { isoDate } from "../../lib/dates";
import type { Project } from "../../lib/types";
import { inView, isOpen, type ViewContext } from "../../lib/views";
import { createEpic, createProject } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";
import { ProjectTree } from "./ProjectTree";

const itemClass =
  "flex items-center gap-2 rounded px-2 py-1 text-neutral-700 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800";
const activeClass =
  "bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-white";

function NavItem({
  to,
  params,
  children,
  count,
}: {
  to: string;
  params?: Record<string, string>;
  children: ReactNode;
  count?: number;
}) {
  return (
    <Link
      to={to}
      params={params as never}
      search={{}}
      className={itemClass}
      activeProps={{ className: activeClass }}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && count > 0 && (
        <span className="text-xs text-neutral-500">{count}</span>
      )}
    </Link>
  );
}

function Section({
  title,
  onAdd,
  children,
}: {
  title: string;
  onAdd?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="mt-5">
      <div className="flex items-center justify-between px-2 pb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
        {title}
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            aria-label={`Add ${title.toLowerCase().replace(/s$/, "")}`}
            className="rounded px-1 text-base leading-none hover:bg-neutral-200 dark:hover:bg-neutral-800"
          >
            +
          </button>
        )}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

export function Sidebar() {
  const store = useTaskStore();
  const tasks = useStoreState((s) => s.tasks);
  const projects = useStoreState((s) => s.projects);
  const epics = useStoreState((s) => s.epics);
  const tags = useStoreState((s) => s.tags);
  const views = useStoreState((s) => s.views);
  const statusList = useStoreState((s) => s.statuses);
  const [adding, setAdding] = useState<"project" | "epic" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showFinished, setShowFinished] = useState(false);

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

  const projectCount = (id: string, children: Project[]) =>
    (counts.perProject.get(id) ?? 0) +
    children.reduce((n, c) => n + (counts.perProject.get(c.id) ?? 0), 0);

  return (
    <nav className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-col gap-0.5">
        <NavItem to="/inbox" count={counts.inbox}>
          Inbox
        </NavItem>
        <NavItem to="/today" count={counts.today}>
          Today
        </NavItem>
        <NavItem to="/all">All tasks</NavItem>
      </div>

      <Section title="Projects" onAdd={() => setAdding("project")}>
        <ProjectTree
          nodes={areas}
          renderProject={(p, children) => (
            <NavItem
              to="/project/$projectId"
              params={{ projectId: p.id }}
              count={projectCount(p.id, children)}
            >
              <span className="flex items-center gap-2">
                <Dot color={p.color} />
                {p.name}
              </span>
            </NavItem>
          )}
        />
        {adding === "project" && (
          <InlineInput
            initial=""
            placeholder="Project name"
            onCommit={(name) => {
              setAdding(null);
              void createProject(store, name);
            }}
            onCancel={() => setAdding(null)}
            className="mt-1"
          />
        )}
        {!areas.length && adding !== "project" && <Empty>No projects yet</Empty>}
        {archived.length > 0 && (
          <Disclosure
            open={showArchived}
            onToggle={() => setShowArchived((v) => !v)}
            label={`Archived (${archived.length})`}
          >
            {archived.map((p) => (
              <NavItem key={p.id} to="/project/$projectId" params={{ projectId: p.id }}>
                <span className="flex items-center gap-2 text-neutral-500">
                  <Dot color={p.color} />
                  {p.name}
                </span>
              </NavItem>
            ))}
          </Disclosure>
        )}
      </Section>

      <Section title="Epics" onAdd={() => setAdding("epic")}>
        {epicList.map((epic) => {
          const progress = counts.perEpic.get(epic.id) ?? { done: 0, total: 0 };
          return (
            <NavItem key={epic.id} to="/epic/$epicId" params={{ epicId: epic.id }}>
              <span className="block truncate">{epic.name}</span>
              <span
                className="mt-1 block h-1 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-700"
                title={`${progress.done} of ${progress.total} done`}
              >
                <span
                  className="block h-full bg-green-500"
                  style={{
                    width: progress.total ? `${(100 * progress.done) / progress.total}%` : 0,
                  }}
                />
              </span>
            </NavItem>
          );
        })}
        {adding === "epic" && (
          <InlineInput
            initial=""
            placeholder="Epic name"
            onCommit={(name) => {
              setAdding(null);
              void createEpic(store, name);
            }}
            onCancel={() => setAdding(null)}
            className="mt-1"
          />
        )}
        {!epicList.length && adding !== "epic" && <Empty>No active epics</Empty>}
        {finishedEpics.length > 0 && (
          <Disclosure
            open={showFinished}
            onToggle={() => setShowFinished((v) => !v)}
            label={`Done and dropped (${finishedEpics.length})`}
          >
            {finishedEpics.map((epic) => (
              <NavItem key={epic.id} to="/epic/$epicId" params={{ epicId: epic.id }}>
                <span className="text-neutral-500">
                  {epic.state === "done" ? "✓ " : "✕ "}
                  {epic.name}
                </span>
              </NavItem>
            ))}
          </Disclosure>
        )}
      </Section>

      <Section title="Views">
        {Object.values(views)
          .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
          .map((view) => (
            <NavItem key={view.id} to="/view/$viewId" params={{ viewId: view.id }}>
              {view.name}
            </NavItem>
          ))}
        {Object.keys(views).length === 0 && <Empty>Use "Save as view" on any view</Empty>}
      </Section>

      {Object.keys(tags).length > 0 && (
        <Section title="Tags">
          <div className="flex flex-wrap gap-1 px-2">
            {Object.values(tags)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((tag) => (
                <Link
                  key={tag.id}
                  to="/tag/$tagId"
                  params={{ tagId: tag.id }}
                  search={{}}
                  className="rounded px-1 text-xs text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-400 dark:hover:bg-neutral-800"
                  activeProps={{
                    className: "bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-800",
                  }}
                >
                  #{tag.name}
                  {counts.perTag.get(tag.id) ? ` ${counts.perTag.get(tag.id)}` : ""}
                </Link>
              ))}
          </div>
        </Section>
      )}
    </nav>
  );
}

function Disclosure({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle(): void;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
      >
        <span className="w-3">{open ? "▾" : "▸"}</span>
        {label}
      </button>
      {open && <div className="flex flex-col gap-0.5">{children}</div>}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 text-xs text-neutral-400">{children}</p>;
}
