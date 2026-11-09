import type { Task } from "../../lib/types";
import { FILTER_NONE } from "../../lib/views";
import type { Point, Positions } from "./canvas";
import { COLUMN_GAP, NODE_HEIGHT, NODE_WIDTH, ROW_GAP } from "./graph";

/** How the canvas arranges cards: freely, or in one horizontal lane per epic or project. */
export type Arrange = "free" | "epic" | "project";

export const LANE_HEADER = 44;
export const LANE_PAD = 28;
export const LANE_GAP = 14;
/** A collapsed lane shows only its header. */
export const LANE_COLLAPSED = 40;

/** A lane to draw, in display order: an epic or project id, or `FILTER_NONE` for "none". */
export interface LaneSpec {
  key: string;
  label: string;
  color: string | null;
}
export interface Lane extends LaneSpec {
  top: number;
  height: number;
  count: number;
  collapsed: boolean;
}

export function laneKey(task: Task, arrange: Exclude<Arrange, "free">): string {
  return (arrange === "epic" ? task.epic_id : task.project_id) ?? FILTER_NONE;
}

function overlaps(a: Point, b: Point) {
  return Math.abs(a.x - b.x) < NODE_WIDTH + COLUMN_GAP / 2 && Math.abs(a.y - b.y) < NODE_HEIGHT;
}

/**
 * Cards in lanes. `relative` holds each card's position inside its lane (y from the lane's
 * top); cards without one go in their dependency column (`x` from the free layout), in the
 * first row free of other cards of the lane. Returns world positions, the lanes stacked from
 * y = 0, and `relative` with the new cards added (to save). A dragged card keeps its saved
 * position until it is dropped, so the lanes don't resize under the pointer.
 */
export function layoutLanes(
  nodes: { task: Task; x: number }[],
  arrange: Exclude<Arrange, "free">,
  specs: LaneSpec[],
  relative: Positions,
  collapsed: Set<string>,
) {
  const byLane = new Map<string, { task: Task; x: number }[]>();
  for (const node of nodes) {
    const key = laneKey(node.task, arrange);
    byLane.set(key, [...(byLane.get(key) ?? []), node]);
  }
  // Lanes holding cards but missing from the specs (an epic since deleted) still show.
  const all = [
    ...specs,
    ...[...byLane.keys()]
      .filter((key) => !specs.some((spec) => spec.key === key))
      .map((key) => ({
        key,
        label: arrange === "epic" ? "Unknown epic" : "Unknown project",
        color: null,
      })),
  ];
  const next: Positions = { ...relative };
  const world: Positions = {};
  const lanes: Lane[] = [];
  let top = 0;
  for (const spec of all) {
    const members = byLane.get(spec.key) ?? [];
    const placed: Point[] = [];
    for (const { task } of members) {
      const point = next[task.id];
      if (point) placed.push(point);
    }
    for (const { task, x } of members) {
      if (next[task.id]) continue;
      let y = LANE_HEADER;
      while (placed.some((point) => overlaps(point, { x, y }))) y += NODE_HEIGHT + ROW_GAP;
      next[task.id] = { x, y };
      placed.push({ x, y });
    }
    const isCollapsed = collapsed.has(spec.key);
    const bottom = Math.max(
      LANE_HEADER + NODE_HEIGHT,
      ...placed.map((point) => point.y + NODE_HEIGHT),
    );
    const height = isCollapsed ? LANE_COLLAPSED : bottom + LANE_PAD;
    for (const { task } of members) {
      const point = next[task.id] as Point;
      world[task.id] = { x: point.x, y: top + point.y };
    }
    lanes.push({ ...spec, top, height, count: members.length, collapsed: isCollapsed });
    top += height + LANE_GAP;
  }
  return { lanes, world, relative: next };
}

/** The lane under a world y: the one containing it, else the nearest. */
export function laneAt(lanes: Lane[], y: number): Lane | undefined {
  let best: Lane | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const lane of lanes) {
    const gap =
      y < lane.top ? lane.top - y : y > lane.top + lane.height ? y - lane.top - lane.height : 0;
    if (gap < distance) {
      best = lane;
      distance = gap;
    }
  }
  return best;
}

/** Moves each card off the pinned cards (downward, a row at a time). */
export function avoidPinned(points: Positions, pinned: Positions): Positions {
  const fixed = Object.values(pinned);
  const result: Positions = {};
  const taken = [...fixed];
  for (const [id, point] of Object.entries(points)) {
    let y = point.y;
    while (taken.some((other) => overlaps(other, { x: point.x, y }))) y += NODE_HEIGHT + ROW_GAP;
    result[id] = { x: point.x, y };
    taken.push(result[id]);
  }
  return result;
}
