import { COLUMN_GAP, NODE_HEIGHT, NODE_WIDTH, ROW_GAP } from "./graph";

export interface Point {
  x: number;
  y: number;
}
export interface Camera extends Point {
  zoom: number;
}
export type Positions = Record<string, Point>;
export interface Connector {
  id: string;
  side: "in" | "out";
}

export const CANVAS_KEY = "task-master.lineage-canvas";
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;

export function worldPoint(point: Point, camera: Camera): Point {
  return { x: (point.x - camera.x) / camera.zoom, y: (point.y - camera.y) / camera.zoom };
}

/** Zoom around a point without moving the thing underneath it. */
export function zoomAt(camera: Camera, point: Point, zoom: number): Camera {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const world = worldPoint(point, camera);
  return { x: point.x - world.x * next, y: point.y - world.y * next, zoom: next };
}

export function fitCamera(points: Point[], width: number, height: number): Camera {
  if (!points.length) return { x: 40, y: 40, zoom: 1 };
  const left = Math.min(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y));
  const right = Math.max(...points.map((p) => p.x + NODE_WIDTH));
  const bottom = Math.max(...points.map((p) => p.y + NODE_HEIGHT));
  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(
      1,
      Math.max(1, width - 100) / (right - left),
      Math.max(1, height - 160) / (bottom - top),
    ),
  );
  return {
    x: (width - (right - left) * zoom) / 2 - left * zoom,
    y: (height - (bottom - top) * zoom) / 2 - top * zoom,
    zoom,
  };
}

/** The camera that puts a card in the middle of the view, keeping the zoom. */
export function centerOn(point: Point, camera: Camera, width: number, height: number): Camera {
  return {
    ...camera,
    x: width / 2 - (point.x + NODE_WIDTH / 2) * camera.zoom,
    y: height / 2 - (point.y + NODE_HEIGHT / 2) * camera.zoom,
  };
}

/** Whether at least one card is (at least partly) on screen with this camera. */
export function anyInView(points: Point[], camera: Camera, width: number, height: number) {
  return points.some(
    (p) =>
      (p.x + NODE_WIDTH) * camera.zoom + camera.x > 0 &&
      p.x * camera.zoom + camera.x < width &&
      (p.y + NODE_HEIGHT) * camera.zoom + camera.y > 0 &&
      p.y * camera.zoom + camera.y < height,
  );
}

/**
 * Where a task created from a card's plus button goes: one column to the side
 * (right for a dependent, left for a prerequisite), in the first row no card covers.
 */
export function freeSlot(origin: Point, side: Connector["side"], taken: Point[]): Point {
  const x = origin.x + (side === "out" ? 1 : -1) * (NODE_WIDTH + COLUMN_GAP);
  const overlaps = (y: number) =>
    taken.some(
      (p) => Math.abs(p.x - x) < NODE_WIDTH + COLUMN_GAP / 2 && Math.abs(p.y - y) < NODE_HEIGHT,
    );
  for (let row = 0; row < 200; row++) {
    // Search downward and upward from the card's own row, nearest first.
    for (const y of [
      origin.y + row * (NODE_HEIGHT + ROW_GAP),
      origin.y - row * (NODE_HEIGHT + ROW_GAP),
    ])
      if (!overlaps(y)) return { x, y };
  }
  return { x, y: origin.y };
}

export function connectorPoint(position: Point, side: Connector["side"]): Point {
  return { x: position.x + (side === "out" ? NODE_WIDTH : 0), y: position.y + NODE_HEIGHT / 2 };
}

export function connectionPath(from: Point, to: Point): string {
  if (to.x < from.x + 60) {
    const routeY = Math.max(from.y, to.y) + NODE_HEIGHT / 2 + 40;
    return `M ${from.x} ${from.y} C ${from.x + 60} ${from.y}, ${from.x + 60} ${routeY}, ${from.x} ${routeY} L ${to.x} ${routeY} C ${to.x - 60} ${routeY}, ${to.x - 60} ${to.y}, ${to.x} ${to.y}`;
  }
  const bend = Math.max(60, Math.min(180, (to.x - from.x) * 0.45));
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

/** The middle of a connection drawn by `connectionPath`: where its remove button goes. */
export function connectionMidpoint(from: Point, to: Point): Point {
  if (to.x < from.x + 60)
    return { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + NODE_HEIGHT / 2 + 40 };
  // A cubic Bezier at t = 0.5, with the control points of `connectionPath`.
  const bend = Math.max(60, Math.min(180, (to.x - from.x) * 0.45));
  return {
    x: (from.x + 3 * (from.x + bend) + 3 * (to.x - bend) + to.x) / 8,
    y: (from.y + to.y) / 2,
  };
}

function isPoint(value: unknown): value is Point {
  return (
    !!value &&
    typeof value === "object" &&
    "x" in value &&
    "y" in value &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y)
  );
}

function readPositions(value: unknown): Positions {
  const positions: Positions = {};
  if (value && typeof value === "object")
    for (const [id, point] of Object.entries(value))
      if (isPoint(point)) positions[id] = { x: point.x, y: point.y };
  return positions;
}
function readIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The canvas layout, saved on this machine only (the webview's storage), like board column
 * widths: links live in the core and sync, where the cards sit does not.
 */
export interface SavedCanvas {
  /** Freeform positions. */
  positions: Positions;
  camera?: Camera;
  /** Cards that stay where they are: no dragging, and arranging leaves them alone. */
  pinned: string[];
  /** Positions inside a lane (y from the lane's top), per arrangement. */
  lanes: { epic: Positions; project: Positions };
  /** Collapsed lanes, per arrangement. */
  collapsed: { epic: string[]; project: string[] };
}

export function loadCanvas(): SavedCanvas {
  const empty: SavedCanvas = {
    positions: {},
    pinned: [],
    lanes: { epic: {}, project: {} },
    collapsed: { epic: [], project: [] },
  };
  try {
    const raw = JSON.parse(localStorage.getItem(CANVAS_KEY) ?? "{}");
    const camera = raw?.camera;
    return {
      positions: readPositions(raw?.positions),
      pinned: readIds(raw?.pinned),
      lanes: { epic: readPositions(raw?.lanes?.epic), project: readPositions(raw?.lanes?.project) },
      collapsed: {
        epic: readIds(raw?.collapsed?.epic),
        project: readIds(raw?.collapsed?.project),
      },
      ...(isPoint(camera) &&
        "zoom" in camera &&
        typeof camera.zoom === "number" &&
        Number.isFinite(camera.zoom) && {
          camera: {
            x: camera.x,
            y: camera.y,
            zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom)),
          },
        }),
    };
  } catch {
    return empty;
  }
}

export function saveCanvas(canvas: SavedCanvas) {
  try {
    localStorage.setItem(CANVAS_KEY, JSON.stringify(canvas));
  } catch {
    /* Layout still works without storage. */
  }
}
