import { useCallback, useState } from "react";

/** Default column width in px (the board's original 17.5rem). */
export const COLUMN_WIDTH = 280;
export const MIN_COLUMN_WIDTH = 224;
export const MAX_COLUMN_WIDTH = 960;
/** Width of a collapsed column strip. */
export const COLLAPSED_WIDTH = 44;
/** A column gets one more lane of cards per this many px of width. */
const LANE_WIDTH = 256;
const MAX_LANES = 3;

export interface ColumnPref {
  collapsed?: boolean;
  width?: number;
}
export type ColumnPrefs = Record<string, ColumnPref>;

export const clampWidth = (px: number) =>
  Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, px)));

/** Cards side by side in a column this wide: 1 up to 511 px, 2 from 512, 3 from 768. */
export const lanesFor = (width: number) =>
  Math.max(1, Math.min(MAX_LANES, Math.floor(width / LANE_WIDTH)));

const STORAGE_KEY = "task-master.board.columns";

export function loadColumnPrefs(): ColumnPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const prefs: ColumnPrefs = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const { collapsed, width } = value as Record<string, unknown>;
      prefs[id] = {
        ...(collapsed === true && { collapsed: true }),
        ...(typeof width === "number" && Number.isFinite(width) && { width: clampWidth(width) }),
      };
    }
    return prefs;
  } catch {
    // Storage unavailable or corrupt: every column open at the default width.
    return {};
  }
}

export interface BoardColumns {
  isCollapsed(statusId: string): boolean;
  widthOf(statusId: string): number;
  setCollapsed(statusId: string, collapsed: boolean): void;
  /** Clamped; `null` goes back to the default width. */
  setWidth(statusId: string, width: number | null): void;
}

/**
 * Collapsed columns and column widths, by status. Remembered on this machine and shared by
 * every board (statuses are global), like the other layout conveniences in `localStorage`.
 */
export function useBoardColumns(): BoardColumns {
  const [prefs, setPrefs] = useState(loadColumnPrefs);

  const patch = useCallback((statusId: string, change: ColumnPref) => {
    setPrefs((prev) => {
      const merged: ColumnPref = { ...prev[statusId], ...change };
      if (!merged.collapsed) delete merged.collapsed;
      if (merged.width === undefined || merged.width === COLUMN_WIDTH) delete merged.width;
      const next = { ...prev, [statusId]: merged };
      if (Object.keys(merged).length === 0) delete next[statusId];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Not persisted; the layout still applies until the app is closed.
      }
      return next;
    });
  }, []);

  return {
    isCollapsed: (id) => prefs[id]?.collapsed === true,
    widthOf: (id) => prefs[id]?.width ?? COLUMN_WIDTH,
    setCollapsed: (id, collapsed) => patch(id, { collapsed }),
    setWidth: (id, width) => patch(id, { width: width === null ? undefined : clampWidth(width) }),
  };
}
