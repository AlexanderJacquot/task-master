import { useCallback, useState } from "react";

const STORAGE_KEY = "task-master.board.lanes";

export function loadCollapsedLanes(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((key): key is string => typeof key === "string"));
  } catch {
    // Storage unavailable or corrupt: every lane open.
    return new Set();
  }
}

export interface CollapsedLanes {
  isCollapsed(laneKey: string): boolean;
  setCollapsed(laneKey: string, collapsed: boolean): void;
}

/**
 * Collapsed swimlanes, by lane key (`epic:<id>`, `project:none`, `priority:high`...). The
 * keys carry their kind, so one list serves every board; remembered on this machine like the
 * column layout (`useBoardColumns`).
 */
export function useCollapsedLanes(): CollapsedLanes {
  const [collapsed, setState] = useState(loadCollapsedLanes);
  const setCollapsed = useCallback((key: string, value: boolean) => {
    setState((prev) => {
      if (prev.has(key) === value) return prev;
      const next = new Set(prev);
      if (value) next.add(key);
      else next.delete(key);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Not persisted; the layout still applies until the app is closed.
      }
      return next;
    });
  }, []);
  return { isCollapsed: (key) => collapsed.has(key), setCollapsed };
}
