import { useEffect } from "react";
import { useTaskStore } from "../../store/context";

export const NEW_TASK_INPUT_ID = "new-task-input";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/**
 * App-wide keys. Text fields keep their own undo; elsewhere Ctrl+Z / Ctrl+Shift+Z undo and
 * redo the last action, `n` starts a new task and Escape closes the detail panel.
 */
export function useShortcuts(closeDetail: () => void) {
  const store = useTaskStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const editing = isEditable(e.target);
      if (e.key === "Escape") {
        if (editing && e.target instanceof HTMLElement) e.target.blur();
        else closeDetail();
        return;
      }
      if (editing) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        void (e.shiftKey ? store.getState().redo() : store.getState().undo());
      } else if (mod && key === "y") {
        e.preventDefault();
        void store.getState().redo();
      } else if (!mod && !e.altKey && key === "n") {
        e.preventDefault();
        document.getElementById(NEW_TASK_INPUT_ID)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, closeDetail]);
}
