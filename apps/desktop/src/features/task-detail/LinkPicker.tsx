import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ScribeIcon, SearchIcon as Search } from "../../components/TaskIcons";
import { cx, Dot, INPUT, MENU, MENU_ITEM, NO_TEXT_PREDICTION } from "../../components/ui";
import { isoDate } from "../../lib/dates";
import { type EntityKind, linkMarkdown } from "../../lib/notes";
import type { Epic, Meeting, Project, Status, Task } from "../../lib/types";
import { useStoreState, useTaskStore } from "../../store/context";
import { EpicMark } from "../organize/EpicMark";
import { ProjectMark } from "../organize/ProjectMark";
import { rankCandidates } from "./hierarchy";

/** Where the `[[` search opens, in viewport coordinates, and where `[[` starts. */
export interface LinkPick {
  from: number;
  left: number;
  top: number;
}

/** Something a note can link (ADR 042). */
export type LinkTarget =
  | { kind: "task"; item: Task }
  | { kind: "project"; item: Project }
  | { kind: "epic"; item: Epic }
  | { kind: "meeting"; item: Meeting };

const KIND_LABEL: Record<EntityKind, string> = {
  task: "Task",
  project: "Project",
  epic: "Epic",
  meeting: "Meeting",
};

/** Most rows of each kind besides tasks. */
const OTHERS_LIMIT = 6;

export function targetLabel(t: LinkTarget): string {
  if (t.kind === "task") return t.item.title;
  if (t.kind === "meeting") return t.item.title;
  return t.item.name;
}

/** The markdown a picked target inserts. */
export function targetMarkdown(t: LinkTarget): string {
  return linkMarkdown(t.kind, t.item.id, targetLabel(t));
}

/**
 * What `[[` offers for `query`: tasks (open ones first, recent first, as before), then
 * projects, epics and meetings whose name has every word. A name that starts with the
 * query comes first whatever its kind, so typing an epic's name puts it on top.
 */
export function rankLinkTargets(
  query: string,
  source: {
    tasks: Task[];
    projects: Project[];
    epics: Epic[];
    meetings: Meeting[];
    statuses: Status[];
  },
): LinkTarget[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const has = (name: string) => {
    const n = name.toLowerCase();
    return words.every((w) => n.includes(w));
  };
  const tasks: LinkTarget[] = rankCandidates(source.tasks, query, source.statuses).map((item) => ({
    kind: "task",
    item,
  }));
  const projects: LinkTarget[] = source.projects
    .filter((p) => p.deleted_at === null && p.archived_at === null && has(p.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, OTHERS_LIMIT)
    .map((item) => ({ kind: "project", item }));
  const epics: LinkTarget[] = source.epics
    .filter((e) => e.deleted_at === null && has(e.name))
    .sort(
      (a, b) =>
        Number(b.state === "active") - Number(a.state === "active") || a.name.localeCompare(b.name),
    )
    .slice(0, OTHERS_LIMIT)
    .map((item) => ({ kind: "epic", item }));
  const meetings: LinkTarget[] = source.meetings
    .filter((m) => m.deleted_at === null && has(m.title))
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, OTHERS_LIMIT)
    .map((item) => ({ kind: "meeting", item }));
  const all = [...tasks, ...projects, ...epics, ...meetings];
  if (!q) return all;
  const starts = (t: LinkTarget) => (targetLabel(t).toLowerCase().startsWith(q) ? 0 : 1);
  // Array.sort is stable: within a group the order above stays.
  return all.sort((a, b) => starts(a) - starts(b));
}

function TargetRow({ target, statuses }: { target: LinkTarget; statuses: Map<string, Status> }) {
  const projects = useStoreState((s) => s.projects);
  let mark: React.ReactNode;
  let detail: string | null = null;
  if (target.kind === "task") {
    mark = <Dot color={statuses.get(target.item.status_id)?.color ?? null} />;
    detail = target.item.project_id ? (projects[target.item.project_id]?.name ?? null) : null;
  } else if (target.kind === "project") {
    mark = <ProjectMark project={target.item} dotClass="size-2" className="text-[12px]" />;
  } else if (target.kind === "epic") {
    mark = <EpicMark epic={target.item} size={12} />;
    detail = target.item.project_id ? (projects[target.item.project_id]?.name ?? null) : null;
  } else {
    mark = <ScribeIcon size={13} className="shrink-0 text-ink-3" />;
    detail = isoDate(new Date(target.item.started_at));
  }
  return (
    <>
      <span className="inline-flex w-4 shrink-0 justify-center">{mark}</span>
      <span className="min-w-0 flex-1 truncate text-left">{targetLabel(target)}</span>
      <span className="max-w-[45%] shrink-0 truncate text-xs text-ink-3">
        {target.kind === "task"
          ? detail
          : [KIND_LABEL[target.kind], detail].filter(Boolean).join(" · ")}
      </span>
    </>
  );
}

/**
 * The search opened by typing `[[` (ADR 032, ADR 042): tasks, projects, epics and
 * meetings. Picking inserts the matching link; Esc or a click outside leaves the brackets
 * as typed.
 */
export function LinkPicker({
  at,
  onPick,
  onCancel,
}: {
  at: LinkPick;
  onPick(markdown: string): void;
  onCancel(): void;
}) {
  const store = useTaskStore();
  const statuses = useStoreState((s) => s.statuses);
  const [query, setQuery] = useState("");
  // Read once per opening: the list doesn't shift while picking.
  const [source] = useState(() => {
    const s = store.getState();
    return {
      tasks: Object.values(s.tasks).sort((a, b) => b.updated_at - a.updated_at),
      projects: Object.values(s.projects),
      epics: Object.values(s.epics),
      meetings: Object.values(s.meetings),
    };
  });
  const matches = useMemo(
    () => rankLinkTargets(query, { ...source, statuses }),
    [query, source, statuses],
  );
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);
  const left = Math.max(8, Math.min(at.left, window.innerWidth - 376));
  return createPortal(
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click outside closes the search; Esc in its box is the keyboard path */}
      <div className="fixed inset-0 z-40" onMouseDown={onCancel} />
      <div
        role="dialog"
        aria-label="Link a task, project, epic or meeting"
        style={{ left, top: at.top + 6 }}
        className={cx(MENU, "fixed z-50 w-[22rem] max-w-[calc(100vw-1rem)] p-2")}
      >
        <div className="relative mb-2">
          <Search size={14} className="pointer-events-none absolute top-2.5 left-2.5 text-ink-3" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the popover exists to type a search
            autoFocus
            {...NO_TEXT_PREDICTION}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
                return;
              }
              if (e.key !== "Enter" || !matches[0]) return;
              e.preventDefault();
              onPick(targetMarkdown(matches[0]));
            }}
            placeholder="Search tasks, projects, epics, meetings…"
            aria-label="Link a task, project, epic or meeting"
            className={cx(INPUT, "pl-8 text-[13px]")}
          />
        </div>
        <ul className="max-h-72 space-y-0.5 overflow-y-auto">
          {matches.map((t) => (
            <li key={`${t.kind}:${t.item.id}`}>
              <button
                type="button"
                onClick={() => onPick(targetMarkdown(t))}
                className={cx(
                  MENU_ITEM,
                  "w-full cursor-pointer hover:bg-accent/10 focus-visible:bg-accent/10",
                )}
              >
                <TargetRow target={t} statuses={statusById} />
              </button>
            </li>
          ))}
        </ul>
        {!matches.length && (
          <p className="px-2 py-3 text-center text-xs text-ink-3">Nothing found.</p>
        )}
      </div>
    </>,
    document.body,
  );
}
