import { useEffect, useRef } from "react";
import { useTaskStore } from "../../store/context";

export const NEW_TASK_INPUT_ID = "new-task-input";

/** Every app-wide key, for the `?` overlay. Board keys live on the cards. */
export const SHORTCUTS: Array<{ keys: string; what: string }> = [
  { keys: "Ctrl+Shift+Space", what: "Quick capture from any app (where the desktop allows it)" },
  { keys: "Ctrl+N", what: "New task (in the current project, epic, tag or Today)" },
  { keys: "n", what: "Type into the Add task line of the current view" },
  { keys: "Ctrl+K", what: "Jump to anything: projects, views, tasks, actions" },
  { keys: "Ctrl+1 … Ctrl+9", what: "Jump to the first nine projects in the sidebar" },
  { keys: "Shift+Enter", what: "Open a task as a full page (in a list, or when adding one)" },
  {
    keys: "g i / g t / g c / g a / g s",
    what: "Go to Inbox / Today / Calendar / All tasks / Settings",
  },
  { keys: "Ctrl+Z / Ctrl+Shift+Z", what: "Undo / redo the last action" },
  { keys: "Esc", what: "Leave a field, close the task panel, or leave the full task page" },
  { keys: "Alt+← / Alt+→", what: "Board: move the focused card to the previous / next column" },
  { keys: "Space, arrows", what: "Board: pick up a card and move it with the keyboard" },
  { keys: "1–9", what: "Plan my day: add the numbered suggestion to Today" },
  { keys: "?", what: "Show these shortcuts" },
];

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

export interface ShortcutActions {
  closeDetail(): void;
  openPalette(): void;
  showHelp(): void;
  newTask(): void;
  /** 1-based position in the sidebar's project order. */
  goToProject(n: number): void;
  go(to: "/inbox" | "/today" | "/calendar" | "/all" | "/settings"): void;
}

/**
 * App-wide keys. Text fields keep their own keys (Ctrl+K still opens the palette);
 * so do Ctrl+N (new task) and Ctrl+1–9 (projects). Elsewhere Ctrl+Z / Ctrl+Shift+Z undo
 * and redo, `n` starts a new task, `g` + a letter navigates and Escape closes the detail
 * panel or leaves the full task page.
 */
export function useShortcuts(actions: ShortcutActions) {
  const store = useTaskStore();
  const latest = useRef(actions);
  latest.current = actions;

  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      const a = latest.current;
      const editing = isEditable(e.target);
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "k") {
        e.preventDefault();
        a.openPalette();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && key === "n") {
        e.preventDefault();
        a.newTask();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        a.goToProject(Number(e.key));
        return;
      }
      if (e.key === "Escape") {
        if (editing && e.target instanceof HTMLElement) e.target.blur();
        else a.closeDetail();
        return;
      }
      if (editing || e.defaultPrevented) return;
      if (mod && key === "z") {
        e.preventDefault();
        void (e.shiftKey ? store.getState().redo() : store.getState().undo());
      } else if (mod && key === "y") {
        e.preventDefault();
        void store.getState().redo();
      } else if (mod || e.altKey) {
        return;
      } else if (Date.now() - pendingG < 1000 && ["i", "t", "c", "a", "s"].includes(key)) {
        e.preventDefault();
        pendingG = 0;
        const to = {
          i: "/inbox",
          t: "/today",
          c: "/calendar",
          a: "/all",
          s: "/settings",
        } as const;
        a.go(to[key as keyof typeof to]);
      } else if (key === "g") {
        pendingG = Date.now();
      } else if (key === "n") {
        e.preventDefault();
        const input = document.getElementById(NEW_TASK_INPUT_ID);
        if (input) input.focus();
        else a.newTask();
      } else if (e.key === "?") {
        e.preventDefault();
        a.showHelp();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}
