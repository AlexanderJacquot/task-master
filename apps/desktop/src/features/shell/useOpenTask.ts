import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

/** Opens the detail panel for a task (or closes it with null), keeping the current view. */
export function useOpenTask(): (taskId: string | null) => void {
  const navigate = useNavigate();
  return useCallback(
    (taskId) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, task: taskId ?? undefined }),
      });
    },
    [navigate],
  );
}
