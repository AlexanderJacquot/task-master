// Light, dark or system theme, and the optional medieval look, remembered per machine.
// Applied as classes on <html> (see index.css): `dark` for a dark theme, `clean` for the
// clean look. Clean is the default (ADR 039): light, dark, or following the system. The
// medieval look (ADR 008) is an easter egg turned on in Settings → Appearance: Parchment by
// day (neither class), the candlelit dark theme by night (`dark` alone).
//
// The look (`medieval` or `clean`) is also kept in a small store, so components that draw
// differently per look (icons, ornaments, the logo) re-render when it changes.

import { create } from "zustand";

export type Theme = "light" | "dark" | "system";
/** What the UI is drawn with: the clean set, or the medieval one (dark, parchment). */
export type Look = "medieval" | "clean";

const KEY = "task-master.appearance";
const MEDIEVAL_KEY = "task-master.medieval";
/** Before ADR 039: "dark" (medieval), "light" (parchment), "clean" or "system". */
const LEGACY_KEY = "task-master.theme";

export const THEMES: readonly Theme[] = ["light", "dark", "system"];

export const THEME_LABELS: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "Follow the system",
};

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not persisted; still applied for this session.
  }
}

export function loadTheme(): Theme {
  const value = read(KEY) ?? read(LEGACY_KEY);
  if (value === "dark" || value === "system") return value;
  return "light";
}

/** Whether the medieval look is on. Off by default; a Parchment choice made before it
 *  became an option keeps it. */
export function loadMedieval(): boolean {
  const value = read(MEDIEVAL_KEY);
  if (value !== null) return value === "on";
  return read(KEY) === null && read(LEGACY_KEY) === "light";
}

export const useLook = create<{ look: Look }>(() => ({ look: "clean" }));

/** The current look, for components that draw differently in the clean theme. */
export function useIsClean(): boolean {
  return useLook((s) => s.look === "clean");
}

let unlisten: (() => void) | null = null;

/** Applies `theme` now and keeps following the OS while it is "system". */
export function applyTheme(
  theme: Theme,
  root: HTMLElement = document.documentElement,
  medieval: boolean = loadMedieval(),
) {
  unlisten?.();
  unlisten = null;
  const media =
    typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const set = () => {
    const dark = theme === "system" ? media?.matches === true : theme === "dark";
    root.classList.toggle("dark", dark);
    root.classList.toggle("clean", !medieval);
    const look: Look = medieval ? "medieval" : "clean";
    if (useLook.getState().look !== look) useLook.setState({ look });
  };
  set();
  if (theme === "system" && media) {
    media.addEventListener("change", set);
    unlisten = () => media.removeEventListener("change", set);
  }
}

export function saveTheme(theme: Theme) {
  const medieval = loadMedieval();
  write(KEY, theme);
  write(MEDIEVAL_KEY, medieval ? "on" : "off");
  applyTheme(theme, document.documentElement, medieval);
}

export function saveMedieval(on: boolean) {
  const theme = loadTheme();
  write(KEY, theme);
  write(MEDIEVAL_KEY, on ? "on" : "off");
  applyTheme(theme, document.documentElement, on);
}
