import { useEffect, useRef } from "react";
import { useTaskStore } from "../../store/context";

export const NEW_TASK_INPUT_ID = "new-task-input";

/** Every app-wide key, for the `?` overlay. Board keys live on the cards. */
export const SHORTCUTS: Array<{ keys: string; what: string }> = [
  { keys: "Ctrl+Shift+Space", what: "Quick capture from any app (where the desktop allows it)" },
  { keys: "n", what: "New task in the current view" },
  { keys: "Ctrl+K", what: "Command palette: jump anywhere, search tasks, run actions" },
  { keys: "g i / g t / g a / g s", what: "Go to Inbox / Today / All tasks / Settings" },
  { keys: "Ctrl+Z / Ctrl+Shift+Z", what: "Undo / redo the last action" },
  { keys: "Esc", what: "Leave a field, or close the task panel" },
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
  go(to: "/inbox" | "/today" | "/all" | "/settings"): void;
}

/**
 * App-wide keys. Text fields keep their own keys (Ctrl+K still opens the palette);
 * elsewhere Ctrl+Z / Ctrl+Shift+Z undo and redo, `n` starts a new task, `g` + a letter
 * navigates and Escape closes the detail panel.
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
      } else if (Date.now() - pendingG < 1000 && ["i", "t", "a", "s"].includes(key)) {
        e.preventDefault();
        pendingG = 0;
        const to = { i: "/inbox", t: "/today", a: "/all", s: "/settings" } as const;
        a.go(to[key as keyof typeof to]);
      } else if (key === "g") {
        pendingG = Date.now();
      } else if (key === "n") {
        e.preventDefault();
        document.getElementById(NEW_TASK_INPUT_ID)?.focus();
      } else if (e.key === "?") {
        e.preventDefault();
        a.showHelp();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}
