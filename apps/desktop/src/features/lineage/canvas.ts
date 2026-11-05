import { NODE_HEIGHT, NODE_WIDTH } from "./graph";

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

/** Layout is a local view preference, like board column widths. */
export function loadCanvas(): { positions: Positions; camera?: Camera } {
  try {
    const raw = JSON.parse(localStorage.getItem(CANVAS_KEY) ?? "{}");
    const positions: Positions = {};
    if (raw?.positions && typeof raw.positions === "object") {
      for (const [id, value] of Object.entries(raw.positions))
        if (isPoint(value)) positions[id] = { x: value.x, y: value.y };
    }
    const camera = raw?.camera;
    return {
      positions,
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
    return { positions: {} };
  }
}

export function saveCanvas(positions: Positions, camera: Camera) {
  try {
    localStorage.setItem(CANVAS_KEY, JSON.stringify({ positions, camera }));
  } catch {
    /* Layout still works without storage. */
  }
}
