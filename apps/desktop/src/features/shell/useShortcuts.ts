import { useEffect, useRef } from "react";
import {
  chordOf,
  getKeymap,
  hasCommandModifier,
  recording,
  resolve,
  type ShortcutId,
} from "../../lib/keymap";
import { useTaskStore } from "../../store/context";

export const NEW_TASK_INPUT_ID = "new-task-input";

/** How long the first key of a sequence ("G" of "G I") waits for the second. */
const SEQUENCE_MS = 1000;

export function isEditable(target: EventTarget | null): boolean {
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
 * App-wide keys. The remappable ones come from the keymap (lib/keymap.ts, Settings →
 * Keyboard shortcuts); Escape and Ctrl+1–9 (projects) are fixed. In a text field only
 * Ctrl/Alt bindings of actions marked `inFields` fire, so typing is never hijacked.
 */
export function useShortcuts(actions: ShortcutActions) {
  const store = useTaskStore();
  const latest = useRef(actions);
  latest.current = actions;

  useEffect(() => {
    let pending: { chord: string; at: number } | null = null;

    const run = (id: ShortcutId) => {
      const a = latest.current;
      switch (id) {
        case "palette":
          return a.openPalette();
        case "newTask":
          return a.newTask();
        case "addLine": {
          const input = document.getElementById(NEW_TASK_INPUT_ID);
          if (input) input.focus();
          else a.newTask();
          return;
        }
        case "undo":
          return void store.getState().undo();
        case "redo":
          return void store.getState().redo();
        case "goInbox":
          return a.go("/inbox");
        case "goToday":
          return a.go("/today");
        case "goCalendar":
          return a.go("/calendar");
        case "goAll":
          return a.go("/all");
        case "goSettings":
          return a.go("/settings");
        case "help":
          return a.showHelp();
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (recording.active) return;
      const a = latest.current;
      const editing = isEditable(e.target);
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        pending = null;
        if (editing && e.target instanceof HTMLElement) e.target.blur();
        else a.closeDetail();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        a.goToProject(Number(e.key));
        return;
      }
      const chord = chordOf(e);
      if (!chord) return;
      // A key an editor already handled stays its own, except Ctrl/Alt app shortcuts.
      if (e.defaultPrevented && !hasCommandModifier(chord)) return;
      const waiting = pending && Date.now() - pending.at < SEQUENCE_MS ? pending.chord : null;
      const result = resolve(getKeymap(), chord, waiting, editing);
      pending = result.pending ? { chord: result.pending, at: Date.now() } : null;
      if (result.action) {
        e.preventDefault();
        run(result.action);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}
