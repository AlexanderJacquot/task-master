import { useCallback, useState } from "react";
import type { Swimlane } from "../../lib/board";
import type { ViewKey } from "../../lib/views";

export interface ViewPrefs {
  layout: "list" | "board";
  swimlane: Swimlane;
  showSubtasks: boolean;
  showCancelled: boolean;
}

export const DEFAULT_PREFS: ViewPrefs = {
  layout: "list",
  swimlane: "none",
  showSubtasks: false,
  showCancelled: false,
};

export function viewId(view: ViewKey): string {
  return "id" in view ? `${view.kind}:${view.id}` : view.kind;
}

const storageKey = (id: string) => `task-master.view.${id}`;

function load(id: string): ViewPrefs {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ViewPrefs>) };
  } catch {
    // Storage unavailable or corrupt: fall back to defaults.
  }
  return DEFAULT_PREFS;
}

/**
 * Per-view display choices (list or board, swimlanes, toggles), remembered on this machine.
 * Saved views with their own layout come in M4; until then this is a local convenience.
 */
export function useViewPrefs(view: ViewKey): [ViewPrefs, (patch: Partial<ViewPrefs>) => void] {
  const id = viewId(view);
  const [prefs, setPrefs] = useState(() => load(id));
  const update = useCallback(
    (patch: Partial<ViewPrefs>) => {
      setPrefs((prev) => {
        const next = { ...prev, ...patch };
        try {
          localStorage.setItem(storageKey(id), JSON.stringify(next));
        } catch {
          // Not persisted; the choice still applies until the view is left.
        }
        return next;
      });
    },
    [id],
  );
  return [prefs, update];
}
