import { createContext, useContext } from "react";

// Interface zoom per region (Ctrl + mouse wheel over the sidebar or over the page), applied
// with CSS `zoom` and remembered per machine, like the theme.
//
// Inside a zoomed box, layout lengths (CSS px, scrollTop, offsetWidth) stay unscaled while
// getBoundingClientRect, pointer coordinates and position: fixed are in screen px. Code that
// turns a pointer distance into a layout length divides it by the zoom (`zoomOf`), and
// dnd-kit transforms applied inside the box go through `unzoomTransform`.

export type ZoomRegion = "sidebar" | "main";

/**
 * The steps Ctrl+wheel walks through, 30% to 200%: 5% apart around 100% for fine tuning,
 * wider at the ends. 1 is always one of them.
 */
export const ZOOM_STEPS = [
  0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15,
  1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.75, 2,
] as const;

const KEY = (region: ZoomRegion) => `task-master.zoom.${region}`;

/** The nearest step to `zoom`, so a stored value always lands on the scale. */
function nearestStep(zoom: number): number {
  let best: number = ZOOM_STEPS[0];
  for (const step of ZOOM_STEPS) if (Math.abs(step - zoom) < Math.abs(best - zoom)) best = step;
  return best;
}

/** The next step in a direction (+1 zooms in, -1 out), clamped to the ends of the scale. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const index = ZOOM_STEPS.indexOf(nearestStep(zoom) as (typeof ZOOM_STEPS)[number]);
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction));
  return ZOOM_STEPS[next] ?? zoom;
}

export function loadZoom(region: ZoomRegion): number {
  try {
    const saved = Number(localStorage.getItem(KEY(region)));
    return saved > 0 ? nearestStep(saved) : 1;
  } catch {
    return 1;
  }
}

export function saveZoom(region: ZoomRegion, zoom: number) {
  try {
    if (zoom === 1) localStorage.removeItem(KEY(region));
    else localStorage.setItem(KEY(region), String(zoom));
  } catch {
    // Not remembered; 100% next time.
  }
}

/** Wheel distance (in px) that makes one step; a mouse notch is about 100. */
export const WHEEL_STEP_PX = 100;

/**
 * Accumulates Ctrl+wheel deltas (touchpad pinches send many small ones) and returns the
 * direction of a step once enough has built up, or 0.
 */
export function wheelAccumulator() {
  let total = 0;
  let lastAt = 0;
  return (deltaY: number, deltaMode: number, now: number): 1 | -1 | 0 => {
    if (now - lastAt > 400) total = 0;
    lastAt = now;
    // Lines and pages count as a full notch each.
    total += deltaMode === 0 ? deltaY : Math.sign(deltaY) * WHEEL_STEP_PX;
    if (Math.abs(total) < WHEEL_STEP_PX / 2) return 0;
    const direction = total < 0 ? 1 : -1;
    total = 0;
    return direction;
  };
}

/** The region's zoom, for code that renders transforms or overlays inside it. */
export const RegionZoomContext = createContext(1);

export function useRegionZoom(): number {
  return useContext(RegionZoomContext);
}

/**
 * The effective zoom of an element: what its pointer distances must be divided by to get
 * layout px.
 */
export function zoomOf(element: Element | null | undefined): number {
  if (!element) return 1;
  const own = (element as Element & { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof own === "number" && own > 0) return own;
  const host = element.closest<HTMLElement>("[data-zoom]");
  const value = host ? Number(host.dataset.zoom) : 1;
  return value > 0 ? value : 1;
}

/** A dnd-kit transform (screen px) to apply inside a box zoomed by `zoom`. */
export function unzoomTransform<T extends { x: number; y: number } | null>(
  transform: T,
  zoom: number,
): T {
  if (!transform || zoom === 1) return transform;
  return { ...transform, x: transform.x / zoom, y: transform.y / zoom };
}
