// The Roadmap page's settings (ADR 030): kept on this machine for the plain pages, or in a
// saved view's spec, which syncs and undoes like any other view.

import type { RoadmapSpec, ViewSpec } from "../../lib/types";
import { EMPTY_FILTER } from "../../lib/views";
import type { Completion } from "../lineage/graph";
import { DEFAULT_DISPLAY, SPEC_VERSION } from "../shell/useViewPrefs";
import type { Group, Zoom } from "./timeline";

/** The two levels: the epics across projects, or one epic's tasks. */
export type Level = "epics" | "tasks";

/**
 * What the header picks. The roadmap of epics uses `projects` and `group`; an epic's
 * timeline uses `tags` and `subtasks`. Both use the rest.
 */
export type RoadmapFilter = {
  /** Project ids, or `FILTER_NONE` for epics without a home project; empty shows all. */
  projects: string[];
  /** Tag ids, or `FILTER_NONE` for tasks without tags; empty shows all. */
  tags: string[];
  /** For epics, "open" is the active ones. */
  completion: Completion;
  subtasks: boolean;
  unscheduled: boolean;
  group: Group;
  zoom: Zoom;
};

/** What the chart edits beside the epics' and tasks' own dates: where bars start, folds. */
export type RoadmapLayout = { starts: Record<string, string>; collapsed: string[] };

export const DEFAULT_FILTER: Record<Level, RoadmapFilter> = {
  epics: {
    projects: [],
    tags: [],
    completion: "open",
    subtasks: true,
    unscheduled: true,
    group: "project",
    zoom: "month",
  },
  tasks: {
    projects: [],
    tags: [],
    completion: "open",
    subtasks: true,
    unscheduled: true,
    group: "none",
    zoom: "week",
  },
};

export const FILTER_KEY: Record<Level, string> = {
  epics: "task-master.roadmap-filter",
  tasks: "task-master.epic-timeline-filter",
};
/** One layout for both levels: epic and task ids never collide. */
export const LAYOUT_KEY = "task-master.roadmap-layout";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

function readStarts(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object")
    for (const [id, iso] of Object.entries(value))
      if (typeof iso === "string" && ISO.test(iso)) out[id] = iso;
  return out;
}

function readJson(key: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* The page still works without storage. */
  }
}

export function loadFilter(level: Level): RoadmapFilter {
  const raw = readJson(FILTER_KEY[level]);
  const fallback = DEFAULT_FILTER[level];
  return {
    projects: ids(raw.projects),
    tags: ids(raw.tags),
    completion: oneOf(raw.completion, ["all", "open", "ready"], fallback.completion),
    subtasks: raw.subtasks !== false,
    unscheduled: raw.unscheduled !== false,
    group: oneOf(raw.group, ["project", "none"], fallback.group),
    zoom: oneOf(raw.zoom, ["day", "week", "month", "quarter"], fallback.zoom),
  };
}

export function saveFilter(level: Level, filter: RoadmapFilter) {
  writeJson(FILTER_KEY[level], filter);
}

export function loadLayout(): RoadmapLayout {
  const raw = readJson(LAYOUT_KEY);
  return { starts: readStarts(raw.starts), collapsed: ids(raw.collapsed) };
}

export function saveLayout(layout: RoadmapLayout) {
  writeJson(LAYOUT_KEY, layout);
}

/**
 * The spec of a saved roadmap: its filters, and the starts of the bars it shows now. With
 * `epic`, it is that epic's task timeline.
 */
export function roadmapSpec(
  filter: RoadmapFilter,
  layout: RoadmapLayout,
  shown: ReadonlySet<string>,
  epic: string | null,
): ViewSpec {
  const roadmap: RoadmapSpec = {
    epic,
    completion: filter.completion,
    group: filter.group,
    zoom: filter.zoom,
    starts: Object.fromEntries(Object.entries(layout.starts).filter(([id]) => shown.has(id))),
    collapsed: [...layout.collapsed],
    hide_unscheduled: !filter.unscheduled,
  };
  return {
    ...DEFAULT_DISPLAY,
    version: SPEC_VERSION,
    scope: { kind: "all" },
    filter: {
      ...EMPTY_FILTER,
      project_ids: epic ? [] : [...filter.projects],
      tag_ids: epic ? [...filter.tags] : [],
    },
    show_subtasks: filter.subtasks,
    roadmap,
  };
}

export function filterOf(spec: ViewSpec): RoadmapFilter {
  const roadmap = spec.roadmap;
  const fallback = DEFAULT_FILTER[roadmap?.epic ? "tasks" : "epics"];
  return {
    projects: [...spec.filter.project_ids],
    tags: [...spec.filter.tag_ids],
    completion: roadmap?.completion ?? fallback.completion,
    subtasks: spec.show_subtasks,
    unscheduled: !roadmap?.hide_unscheduled,
    group: roadmap?.group ?? fallback.group,
    zoom: roadmap?.zoom ?? fallback.zoom,
  };
}

export function layoutOf(spec: ViewSpec): RoadmapLayout {
  return {
    starts: readStarts(spec.roadmap?.starts),
    collapsed: [...(spec.roadmap?.collapsed ?? [])],
  };
}

const sameIds = (x: string[], y: string[]) =>
  x.length === y.length && [...x].sort().join("\n") === [...y].sort().join("\n");

export function sameFilter(a: RoadmapFilter, b: RoadmapFilter): boolean {
  return (
    sameIds(a.projects, b.projects) &&
    sameIds(a.tags, b.tags) &&
    a.completion === b.completion &&
    a.subtasks === b.subtasks &&
    a.unscheduled === b.unscheduled &&
    a.group === b.group &&
    a.zoom === b.zoom
  );
}
