// The Roadmap page's settings (ADR 030): kept on this machine for the plain page, or in a
// saved view's spec, which syncs and undoes like any other view.

import type { RoadmapSpec, ViewSpec } from "../../lib/types";
import { EMPTY_FILTER } from "../../lib/views";
import type { Completion } from "../lineage/graph";
import { DEFAULT_DISPLAY, SPEC_VERSION } from "../shell/useViewPrefs";
import type { Group, Zoom } from "./timeline";

/** What the header picks: filters, grouping and timescale. */
export type RoadmapFilter = {
  project: string;
  /** Epic ids, or `FILTER_NONE` for tasks without an epic; empty shows all. */
  epics: string[];
  /** Tag ids, or `FILTER_NONE` for tasks without tags; empty shows all. */
  tags: string[];
  completion: Completion;
  subtasks: boolean;
  unscheduled: boolean;
  group: Group;
  zoom: Zoom;
};

/** What the chart edits beside the tasks' own dates: where bars start, folded groups. */
export type RoadmapLayout = { starts: Record<string, string>; collapsed: string[] };

export const DEFAULT_FILTER: RoadmapFilter = {
  project: "",
  epics: [],
  tags: [],
  completion: "open",
  subtasks: true,
  unscheduled: true,
  group: "epic",
  zoom: "week",
};

export const FILTER_KEY = "task-master.roadmap-filter";
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

export function loadFilter(): RoadmapFilter {
  const raw = readJson(FILTER_KEY);
  return {
    project: typeof raw.project === "string" ? raw.project : "",
    epics: ids(raw.epics),
    tags: ids(raw.tags),
    completion: oneOf(raw.completion, ["all", "open", "ready"], DEFAULT_FILTER.completion),
    subtasks: raw.subtasks !== false,
    unscheduled: raw.unscheduled !== false,
    group: oneOf(raw.group, ["epic", "project", "none"], DEFAULT_FILTER.group),
    zoom: oneOf(raw.zoom, ["day", "week", "month", "quarter"], DEFAULT_FILTER.zoom),
  };
}

export function saveFilter(filter: RoadmapFilter) {
  writeJson(FILTER_KEY, filter);
}

export function loadLayout(): RoadmapLayout {
  const raw = readJson(LAYOUT_KEY);
  return { starts: readStarts(raw.starts), collapsed: ids(raw.collapsed) };
}

export function saveLayout(layout: RoadmapLayout) {
  writeJson(LAYOUT_KEY, layout);
}

/** The spec of a saved Roadmap: its filters, and the starts of the bars it shows now. */
export function roadmapSpec(
  filter: RoadmapFilter,
  layout: RoadmapLayout,
  shown: ReadonlySet<string>,
): ViewSpec {
  const roadmap: RoadmapSpec = {
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
      project_ids: filter.project ? [filter.project] : [],
      epic_ids: [...filter.epics],
      tag_ids: [...filter.tags],
    },
    show_subtasks: filter.subtasks,
    roadmap,
  };
}

export function filterOf(spec: ViewSpec): RoadmapFilter {
  const roadmap = spec.roadmap;
  return {
    project: spec.filter.project_ids[0] ?? "",
    epics: [...spec.filter.epic_ids],
    tags: [...spec.filter.tag_ids],
    completion: roadmap?.completion ?? DEFAULT_FILTER.completion,
    subtasks: spec.show_subtasks,
    unscheduled: !roadmap?.hide_unscheduled,
    group: roadmap?.group ?? DEFAULT_FILTER.group,
    zoom: roadmap?.zoom ?? DEFAULT_FILTER.zoom,
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
    a.project === b.project &&
    sameIds(a.epics, b.epics) &&
    sameIds(a.tags, b.tags) &&
    a.completion === b.completion &&
    a.subtasks === b.subtasks &&
    a.unscheduled === b.unscheduled &&
    a.group === b.group &&
    a.zoom === b.zoom
  );
}
