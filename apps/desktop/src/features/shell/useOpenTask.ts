import { useRouter } from "@tanstack/react-router";
import { createContext, useCallback, useContext } from "react";

/**
 * Replaces navigation in a window without a router: the quick-capture window opens a
 * subtask in place. Unset in the main window.
 */
export const OpenTaskContext = createContext<((taskId: string | null) => void) | null>(null);

/**
 * Opens the detail panel for a task (or closes it with null), keeping the current view.
 * The full task page has no panel: there a task opens on its own full page instead.
 */
export function useOpenTask(): (taskId: string | null) => void {
  const override = useContext(OpenTaskContext);
  const router = useRouter({ warn: override === null });
  return useCallback(
    (taskId) => {
      if (override) return override(taskId);
      if (taskId && router.state.location.pathname.startsWith("/task/")) {
        void router.navigate({ to: "/task/$taskId", params: { taskId }, search: {} });
        return;
      }
      void router.navigate({
        to: ".",
        // `focus` belongs to the task that was just created, never to the next one opened.
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          task: taskId ?? undefined,
          focus: undefined,
        }),
      });
    },
    [override, router],
  );
}
