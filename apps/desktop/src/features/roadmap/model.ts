// What the Roadmap shows (ADR 031), as pure functions of the store's entities and the
// page's filters: the epics or one epic's tasks, their bars, and the image of it (ADR 034).
// The core has a port for the sync server (`crates/core/src/roadmap.rs`, ADR 035); both
// pass the cases in `crates/core/test-vectors/roadmap.json` (`model.test.ts`).

import type {
  Epic,
  ImageTheme,
  Project,
  RoadmapImage,
  Status,
  Task,
  ViewSpec,
} from "../../lib/types";
import { compareStrings, FILTER_NONE } from "../../lib/views";
import { closedTaskIds, filterLineage } from "../lineage/graph";
import { imageLinks, imageRows } from "./exportImage";
import { filterOf, type Level, layoutOf, type RoadmapFilter } from "./saved";
import { barOf, epicItems, type Item, linksOf, rowsOf, taskItem } from "./timeline";

const NO_PROJECT = "No project";

/** The tasks a roadmap can show: not agents' own steps (they stay out of lists too), by rank. */
export function roadmapTasks(tasks: Record<string, Task>): Task[] {
  return Object.values(tasks)
    .filter((task) => task.owner !== "agent")
    .sort((a, b) => compareStrings(a.rank, b.rank) || compareStrings(a.id, b.id));
}

/** Tasks in a cancelled status. */
export function cancelledTaskIds(tasks: Iterable<Task>, statuses: Status[]): Set<string> {
  const ids = new Set(statuses.filter((s) => s.category === "cancelled").map((s) => s.id));
  const out = new Set<string>();
  for (const task of tasks) if (ids.has(task.status_id)) out.add(task.id);
  return out;
}

export type ItemsInput = {
  level: Level;
  epicId: string | null;
  /** `roadmapTasks` of the store. */
  all: Task[];
  /** Every task in the store (agents' too: a prerequisite can be one). */
  tasks: Record<string, Task>;
  epics: Record<string, Epic>;
  /** Done or cancelled, of every task in the store. */
  closed: Set<string>;
  /** Cancelled, of `all`. */
  cancelled: Set<string>;
  filter: RoadmapFilter;
  starts: Readonly<Record<string, string>>;
};

/**
 * The epics the filters pick (projects, completion) with their bars and groups, or the
 * tasks of `epicId` (tags, completion, subtasks). Unscheduled ones too unless the filter
 * leaves them out.
 */
export function roadmapItems(input: ItemsInput): Item[] {
  const { level, epicId, all, tasks, epics, closed, cancelled, filter, starts } = input;
  if (level === "epics") {
    const picked = filter.projects;
    const inPicked = (id: string) =>
      all.some((task) => task.epic_id === id && picked.includes(task.project_id ?? ""));
    const shown = Object.values(epics).filter(
      (e) =>
        (filter.completion === "all" || e.state === "active") &&
        (!picked.length ||
          picked.includes(e.project_id ?? FILTER_NONE) ||
          // An epic without a home project shows with the projects of its tasks.
          (!e.project_id && inPicked(e.id))),
    );
    return epicItems(shown, all, starts, { done: closed, cancelled }, (e) =>
      filter.group === "project" ? (e.project_id ?? FILTER_NONE) : "",
    ).filter((item) => filter.unscheduled || item.bar);
  }
  if (!epicId) return [];
  return filterLineage(all, tasks, closed, {
    project: "",
    epics: [epicId],
    tags: filter.tags,
    completion: filter.completion,
    linkedOnly: false,
    subtasks: filter.subtasks,
  })
    .filter((task) => filter.unscheduled || task.due_date)
    .map((task) => taskItem(task, barOf(task, starts), closed.has(task.id)));
}

/** "Nov 21, 2026" in the locale (the system's unless given). */
export function asOfLabel(today: string, locale?: string): string {
  return new Date(`${today}T00:00:00Z`).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export type ImageInput = {
  level: Level;
  /** The epic whose timeline it is. */
  epic: Epic | undefined;
  /** A saved view's name. */
  viewName: string | null;
  items: Item[];
  filter: RoadmapFilter;
  collapsed: ReadonlySet<string>;
  projects: Readonly<Record<string, Project | undefined>>;
  today: string;
  asOf: string;
  theme: ImageTheme;
};

/**
 * The page as an image (ADR 034): the same rows, filters, timescale, starts and folds, but
 * only what has a bar. Unscheduled epics or tasks, and groups left empty, stay out.
 */
export function roadmapImage(input: ImageInput): RoadmapImage {
  const { level, epic, viewName, filter, projects } = input;
  const scheduled = input.items.filter((item) => item.bar);
  const owners = level === "epics" && filter.group === "project" ? projects : null;
  const rows = imageRows(rowsOf(scheduled, owners, NO_PROJECT, input.collapsed));
  const picked = filter.projects.map((id) =>
    id === FILTER_NONE ? NO_PROJECT : (projects[id]?.name ?? ""),
  );
  const noun =
    level === "epics"
      ? scheduled.length === 1
        ? "epic"
        : "epics"
      : scheduled.length === 1
        ? "task"
        : "tasks";
  const what =
    level === "epics"
      ? picked.length
        ? `Epics of ${picked.filter(Boolean).join(", ")}`
        : "Epics across projects"
      : viewName !== null && epic
        ? `The tasks of ${epic.name}`
        : "Epic timeline";
  const deadline = level === "tasks" && epic?.target_date ? epic.target_date : null;
  return {
    title: viewName ?? epic?.name ?? "Roadmap",
    subtitle: `${what} · ${scheduled.length} ${noun} · ${input.asOf}`,
    name_header: level === "epics" ? "Epic" : "Task",
    zoom: filter.zoom,
    today: input.today,
    deadline: deadline && epic ? { date: deadline, label: epic.name } : null,
    rows,
    links: imageLinks(linksOf(input.items), rows),
    theme: input.theme,
  };
}

export type RoadmapData = {
  tasks: Task[];
  epics: Epic[];
  projects: Project[];
  statuses: Status[];
};

/**
 * A roadmap's image from its spec alone, as the sync server builds it (the starts are the
 * spec's, nothing from this machine). The fixture's entry point; the page builds the same
 * from its draft filters.
 */
export function imageFromSpec(
  data: RoadmapData,
  spec: ViewSpec,
  options: { view_name: string | null; today: string; theme: ImageTheme },
  locale?: string,
): RoadmapImage {
  const byId = <T extends { id: string }>(list: T[]) =>
    Object.fromEntries(list.map((x) => [x.id, x])) as Record<string, T>;
  const tasks = byId(data.tasks);
  const epics = byId(data.epics);
  const epicId = spec.roadmap?.epic ?? null;
  const level: Level = epicId ? "tasks" : "epics";
  const filter = filterOf(spec);
  const layout = layoutOf(spec);
  const all = roadmapTasks(tasks);
  const items = roadmapItems({
    level,
    epicId,
    all,
    tasks,
    epics,
    closed: closedTaskIds(data.tasks, data.statuses),
    cancelled: cancelledTaskIds(all, data.statuses),
    filter,
    starts: layout.starts,
  });
  return roadmapImage({
    level,
    epic: epicId ? epics[epicId] : undefined,
    viewName: options.view_name,
    items,
    filter,
    collapsed: new Set(layout.collapsed),
    projects: byId(data.projects),
    today: options.today,
    asOf: asOfLabel(options.today, locale),
    theme: options.theme,
  });
}
