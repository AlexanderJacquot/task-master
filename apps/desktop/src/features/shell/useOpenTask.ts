import { useRouter } from "@tanstack/react-router";
import { createContext, useCallback, useContext } from "react";

/**
 * Replaces navigation in a window without a router: the quick-capture window opens a
 * subtask in place. Unset in the main window.
 */
export const OpenTaskContext = createContext<((taskId: string | null) => void) | null>(null);

/** Opens the detail panel for a task (or closes it with null), keeping the current view. */
export function useOpenTask(): (taskId: string | null) => void {
  const override = useContext(OpenTaskContext);
  const router = useRouter({ warn: override === null });
  return useCallback(
    (taskId) => {
      if (override) return override(taskId);
      void router.navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, task: taskId ?? undefined }),
      });
    },
    [override, router],
  );
}
