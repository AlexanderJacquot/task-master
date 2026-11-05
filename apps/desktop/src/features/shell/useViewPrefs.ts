import { useCallback, useState } from "react";
import type { ViewScope, ViewSpec } from "../../lib/types";
import { EMPTY_FILTER } from "../../lib/views";

/** Everything in a spec but its version and scope: what the header and filter bar edit. */
export type ViewDisplay = Omit<ViewSpec, "version" | "scope">;

export const DEFAULT_DISPLAY: ViewDisplay = {
  filter: EMPTY_FILTER,
  group_by: "status",
  sort: "default",
  layout: "list",
  swimlane: "none",
  show_subtasks: false,
  show_cancelled: false,
  show_agent_tasks: false,
};

export const SPEC_VERSION = 1;

export function specOf(scope: ViewScope, display: ViewDisplay): ViewSpec {
  return { version: SPEC_VERSION, scope, ...display };
}

export function displayOf(spec: ViewSpec): ViewDisplay {
  const { version: _version, scope: _scope, ...display } = spec;
  return display;
}

export function viewId(scope: ViewScope): string {
  return "id" in scope ? `${scope.kind}:${scope.id}` : scope.kind;
}

const storageKey = (id: string) => `task-master.view.${id}`;

function load(id: string): ViewDisplay {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (!raw) return DEFAULT_DISPLAY;
    const stored = JSON.parse(raw) as Partial<ViewDisplay> & {
      // M3 stored camelCase toggles.
      showSubtasks?: boolean;
      showCancelled?: boolean;
    };
    const { showSubtasks, showCancelled, ...rest } = stored;
    return {
      ...DEFAULT_DISPLAY,
      ...(showSubtasks !== undefined && { show_subtasks: showSubtasks }),
      ...(showCancelled !== undefined && { show_cancelled: showCancelled }),
      ...rest,
      filter: { ...EMPTY_FILTER, ...rest.filter },
    };
  } catch {
    // Storage unavailable or corrupt: fall back to defaults.
    return DEFAULT_DISPLAY;
  }
}

/**
 * Display choices for a built-in view (Inbox, Today, a project...), remembered on this
 * machine. Saved views keep theirs in the database instead.
 */
export function useViewPrefs(
  scope: ViewScope,
): [ViewDisplay, (patch: Partial<ViewDisplay>) => void] {
  const id = viewId(scope);
  const [prefs, setPrefs] = useState(() => load(id));
  const update = useCallback(
    (patch: Partial<ViewDisplay>) => {
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
