import { useCallback, useState } from "react";

const STORAGE_KEY = "task-master.board.lanes";

/**
 * Lanes the user opened (`false`) or collapsed (`true`) by hand. Lanes without a choice
 * follow their default. An array (the earlier format) lists collapsed lanes.
 */
export function loadCollapsedLanes(): Map<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (Array.isArray(parsed)) {
      return new Map(
        parsed.filter((key): key is string => typeof key === "string").map((key) => [key, true]),
      );
    }
    if (parsed === null || typeof parsed !== "object") return new Map();
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    // Storage unavailable or corrupt: every lane follows its default.
    return new Map();
  }
}

export interface CollapsedLanes {
  /** The user's choice for this lane, else `byDefault`. */
  isCollapsed(laneKey: string, byDefault?: boolean): boolean;
  setCollapsed(laneKey: string, collapsed: boolean): void;
}

/**
 * Collapsed swimlanes, by lane key (`epic:<id>`, `project:none`, `priority:high`...). The
 * keys carry their kind, so one list serves every board; remembered on this machine like the
 * column layout (`useBoardColumns`). A choice is kept even when it matches the default, so
 * a lane opened by hand stays open when its default changes.
 */
export function useCollapsedLanes(): CollapsedLanes {
  const [choices, setState] = useState(loadCollapsedLanes);
  const setCollapsed = useCallback((key: string, value: boolean) => {
    setState((prev) => {
      if (prev.get(key) === value) return prev;
      const next = new Map(prev).set(key, value);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(next)));
      } catch {
        // Not persisted; the layout still applies until the app is closed.
      }
      return next;
    });
  }, []);
  return {
    isCollapsed: (key, byDefault = false) => choices.get(key) ?? byDefault,
    setCollapsed,
  };
}
