// A saved Lineage view (ADR 022): the page's filters and the canvas layout, kept in a
// saved view's spec so it syncs and undoes like any other view.

import type { LineageSpec, ViewSpec } from "../../lib/types";
import { EMPTY_FILTER } from "../../lib/views";
import { DEFAULT_DISPLAY, SPEC_VERSION } from "../shell/useViewPrefs";
import type { Positions, SavedCanvas } from "./canvas";
import type { Completion } from "./graph";
import type { Arrange } from "./lanes";

/** The Lineage page's filters (remembered on this machine, or held by a saved view). */
export type LineageFilter = {
  project: string;
  /** Epic ids, or `FILTER_NONE` for tasks without an epic; empty shows all. */
  epics: string[];
  /** Tag ids, or `FILTER_NONE` for tasks without tags; empty shows all. */
  tags: string[];
  completion: Completion;
  linkedOnly: boolean;
  /** Show subtasks (tasks with a parent) on the canvas. */
  subtasks: boolean;
  arrange: Arrange;
};

type PointMap = Readonly<Record<string, { x: number; y: number } | undefined>>;

/** Whole pixels, only for the cards on the canvas now (the rest is history). */
function keep(positions: Positions, ids: ReadonlySet<string>): Positions {
  const out: Positions = {};
  for (const [id, point] of Object.entries(positions))
    if (ids.has(id) && Number.isFinite(point.x) && Number.isFinite(point.y))
      out[id] = { x: Math.round(point.x), y: Math.round(point.y) };
  return out;
}

function read(points: PointMap | undefined): Positions {
  const out: Positions = {};
  for (const [id, point] of Object.entries(points ?? {}))
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y))
      out[id] = { x: point.x, y: point.y };
  return out;
}

/**
 * The spec of a saved Lineage view: the filters, the task it centers on, and where the
 * cards in `onCanvas` sit. The camera is not kept: a saved view opens framed on its cards.
 */
export function lineageSpec(
  filter: LineageFilter,
  around: string | null,
  canvas: SavedCanvas,
  onCanvas: ReadonlySet<string>,
): ViewSpec {
  const lineage: LineageSpec = {
    around,
    completion: filter.completion,
    linked_only: filter.linkedOnly,
    arrange: filter.arrange,
    positions: keep(canvas.positions, onCanvas),
    lanes: {
      epic: keep(canvas.lanes.epic, onCanvas),
      project: keep(canvas.lanes.project, onCanvas),
    },
    pinned: canvas.pinned.filter((id) => onCanvas.has(id)),
    collapsed: { epic: [...canvas.collapsed.epic], project: [...canvas.collapsed.project] },
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
    lineage,
  };
}

/** A saved Lineage view's filters (a plain view's spec reads as the page's defaults). */
export function filterOf(spec: ViewSpec): LineageFilter {
  const lineage = spec.lineage;
  return {
    project: spec.filter.project_ids[0] ?? "",
    epics: [...spec.filter.epic_ids],
    tags: [...spec.filter.tag_ids],
    completion: lineage?.completion ?? "all",
    linkedOnly: lineage?.linked_only ?? false,
    subtasks: spec.show_subtasks,
    arrange: lineage?.arrange ?? "free",
  };
}

/** A saved Lineage view's layout, as the canvas keeps it. */
export function canvasOf(spec: ViewSpec): SavedCanvas {
  const lineage = spec.lineage;
  return {
    positions: read(lineage?.positions),
    pinned: [...(lineage?.pinned ?? [])],
    lanes: { epic: read(lineage?.lanes.epic), project: read(lineage?.lanes.project) },
    collapsed: {
      epic: [...(lineage?.collapsed.epic ?? [])],
      project: [...(lineage?.collapsed.project ?? [])],
    },
  };
}

export function sameFilter(a: LineageFilter, b: LineageFilter): boolean {
  const ids = (x: string[], y: string[]) =>
    x.length === y.length && [...x].sort().join("\n") === [...y].sort().join("\n");
  return (
    a.project === b.project &&
    ids(a.epics, b.epics) &&
    ids(a.tags, b.tags) &&
    a.completion === b.completion &&
    a.linkedOnly === b.linkedOnly &&
    a.subtasks === b.subtasks &&
    a.arrange === b.arrange
  );
}
