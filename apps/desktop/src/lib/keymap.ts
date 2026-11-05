// Remappable keyboard shortcuts, remembered per machine (like the theme). A binding is one
// or two chords separated by a space: "Ctrl+K", "Ctrl+Shift+Z", "G I" (G, then I). A chord
// lists its modifiers as Ctrl, Alt, Shift (Ctrl also stands for ⌘ on macOS), then the key:
// letters in capitals, "Space", "ArrowUp", "F2", or the character typed ("?", ",").

import { useSyncExternalStore } from "react";

export type ShortcutId =
  | "palette"
  | "newTask"
  | "addLine"
  | "undo"
  | "redo"
  | "goInbox"
  | "goToday"
  | "goCalendar"
  | "goAll"
  | "goSettings"
  | "help";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  defaults: string[];
  /** Also fires while typing in a text field (only for bindings with Ctrl or Alt). */
  inFields?: boolean;
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: "palette", label: "Jump to anything", defaults: ["Ctrl+K"], inFields: true },
  { id: "newTask", label: "New task", defaults: ["Ctrl+N"], inFields: true },
  { id: "addLine", label: "Type into the view's Add task line", defaults: ["N"] },
  { id: "undo", label: "Undo", defaults: ["Ctrl+Z"] },
  { id: "redo", label: "Redo", defaults: ["Ctrl+Shift+Z", "Ctrl+Y"] },
  { id: "goInbox", label: "Go to Inbox", defaults: ["G I"], inFields: true },
  { id: "goToday", label: "Go to Today", defaults: ["G T"], inFields: true },
  { id: "goCalendar", label: "Go to Calendar", defaults: ["G C"], inFields: true },
  { id: "goAll", label: "Go to All tasks", defaults: ["G A"], inFields: true },
  { id: "goSettings", label: "Go to Settings", defaults: ["Ctrl+,", "G S"], inFields: true },
  { id: "help", label: "Show keyboard shortcuts", defaults: ["?"], inFields: true },
];

/** Keys that stay as they are: shown in the help, not remappable. */
export const FIXED_SHORTCUTS: Array<{ keys: string; what: string }> = [
  { keys: "Ctrl+Shift+Space", what: "Quick capture from any app (where the desktop allows it)" },
  { keys: "Ctrl+1 … Ctrl+9", what: "Jump to the first nine projects in the sidebar" },
  { keys: "Shift+Enter", what: "Open a task as a full page (in a list, or when adding one)" },
  { keys: "Esc", what: "Leave a field, close the task panel, or leave the full task page" },
  { keys: "Alt+← / Alt+→", what: "Board: move the focused card to the previous / next column" },
  { keys: "Space, arrows", what: "Board: pick up a card and move it with the keyboard" },
  { keys: "1–9", what: "Plan my day: add the numbered suggestion to Today" },
];

export type Keymap = Record<ShortcutId, string[]>;

export const DEFAULT_KEYMAP = Object.fromEntries(
  SHORTCUT_DEFS.map((d) => [d.id, d.defaults]),
) as Keymap;

const DEFS = new Map(SHORTCUT_DEFS.map((d) => [d.id, d]));

export function labelOf(id: ShortcutId): string {
  return DEFS.get(id)?.label ?? id;
}

type KeyInput = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"]);

/** The chord a key press makes, or null for a lone modifier. */
export function chordOf(e: KeyInput): string | null {
  if (MODIFIER_KEYS.has(e.key) || e.key === "Dead" || e.key === "Unidentified") return null;
  let key = e.key === " " ? "Space" : e.key;
  const letter = /^[a-z]$/i.test(key);
  if (key.length === 1) key = key.toUpperCase();
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  // "?" already says Shift; letters and named keys need it spelled out.
  if (e.shiftKey && (letter || key.length > 1)) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Ctrl or Alt in the chord: safe to catch while typing. */
export function hasCommandModifier(chord: string): boolean {
  return chord.startsWith("Ctrl+") || chord.startsWith("Alt+");
}

/** Plain characters may start a two-key sequence ("G I"); chords with Ctrl or Alt never do. */
function canStartSequence(chord: string): boolean {
  return !hasCommandModifier(chord) && !chord.includes("+", 1);
}

export interface Resolved {
  action?: ShortcutId;
  /** The first chord of a sequence, waiting for its second. */
  pending?: string;
}

/**
 * What `chord` does, given the chord already pending (if any). In a text field only
 * bindings with Ctrl or Alt count, and only for actions marked `inFields`.
 */
export function resolve(
  keymap: Keymap,
  chord: string,
  pending: string | null,
  editing: boolean,
): Resolved {
  const usable = (def: ShortcutDef, binding: string) =>
    !editing || (def.inFields === true && hasCommandModifier(binding));
  const find = (binding: string) =>
    SHORTCUT_DEFS.find((d) => keymap[d.id].includes(binding) && usable(d, binding));

  if (pending) {
    const def = find(`${pending} ${chord}`);
    if (def) return { action: def.id };
  }
  const def = find(chord);
  if (def) return { action: def.id };
  if (
    !editing &&
    canStartSequence(chord) &&
    SHORTCUT_DEFS.some((d) => keymap[d.id].some((b) => b.startsWith(`${chord} `)))
  ) {
    return { pending: chord };
  }
  return {};
}

/** Keys kept for typing, lists and the fixed shortcuts above. */
const RESERVED = new Set([
  "Ctrl+C",
  "Ctrl+V",
  "Ctrl+X",
  "Ctrl+A",
  "Escape",
  "Enter",
  "Shift+Enter",
  "Tab",
  "Shift+Tab",
  "Space",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Alt+ArrowLeft",
  "Alt+ArrowRight",
  "Ctrl+Shift+Space",
  ..."123456789".split("").flatMap((n) => [n, `Ctrl+${n}`]),
]);

export type BindingCheck = { ok: true; takenFrom?: ShortcutId } | { ok: false; reason: string };

/** Whether `binding` can go on `id`; a binding used elsewhere moves (`takenFrom`). */
export function checkBinding(keymap: Keymap, id: ShortcutId, binding: string): BindingCheck {
  const chords = binding.split(" ");
  const reserved = chords.length === 1 && RESERVED.has(binding);
  if (reserved) return { ok: false, reason: "kept for typing and lists" };
  if (keymap[id].includes(binding)) return { ok: false, reason: "already set" };
  const other = SHORTCUT_DEFS.find((d) => d.id !== id && keymap[d.id].includes(binding));
  // A single key that starts someone's sequence ("G" vs "G I") would never fire.
  const shadows = SHORTCUT_DEFS.find((d) =>
    keymap[d.id].some((b) => (chords.length === 1 ? b.startsWith(`${binding} `) : b === chords[0])),
  );
  if (shadows && shadows.id !== id) {
    return { ok: false, reason: `clashes with “${labelOf(shadows.id)}”` };
  }
  return other ? { ok: true, takenFrom: other.id } : { ok: true };
}

/** `keymap` with `binding` added to `id` (and taken off any other action). */
export function withBinding(keymap: Keymap, id: ShortcutId, binding: string): Keymap {
  const next = { ...keymap };
  for (const d of SHORTCUT_DEFS) {
    if (next[d.id].includes(binding)) next[d.id] = next[d.id].filter((b) => b !== binding);
  }
  next[id] = [...next[id], binding];
  return next;
}

export function withoutBinding(keymap: Keymap, id: ShortcutId, binding: string): Keymap {
  return { ...keymap, [id]: keymap[id].filter((b) => b !== binding) };
}

// ---------------------------------------------------------------------------------------
// Storage: only the actions that differ from the defaults are saved.

const KEY = "task-master.shortcuts";

export function loadKeymap(): Keymap {
  const map = { ...DEFAULT_KEYMAP };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    for (const d of SHORTCUT_DEFS) {
      const value = saved[d.id];
      if (Array.isArray(value) && value.every((b) => typeof b === "string")) {
        map[d.id] = value as string[];
      }
    }
  } catch {
    // Unreadable: defaults.
  }
  return map;
}

function persist(map: Keymap) {
  const changed = Object.fromEntries(
    SHORTCUT_DEFS.filter((d) => map[d.id].join("|") !== d.defaults.join("|")).map((d) => [
      d.id,
      map[d.id],
    ]),
  );
  try {
    if (Object.keys(changed).length) localStorage.setItem(KEY, JSON.stringify(changed));
    else localStorage.removeItem(KEY);
  } catch {
    // Not remembered; fine.
  }
}

// A tiny shared store, so the shortcut handler, the help and the settings agree live.
let current: Keymap | null = null;
const listeners = new Set<() => void>();

export function getKeymap(): Keymap {
  current ??= loadKeymap();
  return current;
}

export function setKeymap(map: Keymap) {
  current = map;
  persist(map);
  for (const l of listeners) l();
}

/** Forgets the cached keymap (tests reset localStorage between cases). */
export function reloadKeymap() {
  current = null;
  for (const l of listeners) l();
}

export function useKeymap(): Keymap {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getKeymap,
    getKeymap,
  );
}

/** "New task (Ctrl+N)" for tooltips; just the label when the action has no key. */
export function withKeys(keymap: Keymap, id: ShortcutId, text: string): string {
  const first = keymap[id][0];
  return first ? `${text} (${first.replace(" ", " then ")})` : text;
}

/** While true (the settings recorder is listening), shortcuts do nothing. */
export const recording = { active: false };
