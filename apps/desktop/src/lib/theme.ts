// Dark, parchment ("light"), clean or system theme, remembered per machine (settings).
// Applied as classes on <html> (see index.css): `dark` for the dark theme, `clean` for the
// clean light one, neither for parchment. "Follow the system" switches between dark and the
// chosen light theme (parchment or clean). Dark is the default (ADR 008, ADR 021).
//
// The look (`medieval` or `clean`) is also kept in a small store, so components that draw
// differently per look (icons, ornaments, the logo) re-render when it changes.

import { create } from "zustand";

export type Theme = "system" | "light" | "dark" | "clean";
/** The light theme "Follow the system" uses. */
export type LightTheme = "light" | "clean";
/** What the UI is drawn with: the medieval set (dark, parchment) or the clean one. */
export type Look = "medieval" | "clean";

const KEY = "task-master.theme";
const LIGHT_KEY = "task-master.theme-light";

export const THEMES: readonly Theme[] = ["dark", "light", "clean", "system"];

export const THEME_LABELS: Record<Theme, string> = {
  dark: "Dark",
  light: "Parchment",
  clean: "Clean",
  system: "Follow the system",
};

export function loadTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "system" || value === "clean" ? value : "dark";
  } catch {
    return "dark";
  }
}

export function loadLightTheme(): LightTheme {
  try {
    return localStorage.getItem(LIGHT_KEY) === "clean" ? "clean" : "light";
  } catch {
    return "light";
  }
}

export const useLook = create<{ look: Look }>(() => ({ look: "medieval" }));

/** The current look, for components that draw differently in the clean theme. */
export function useIsClean(): boolean {
  return useLook((s) => s.look === "clean");
}

let unlisten: (() => void) | null = null;

/** Applies `theme` now and keeps following the OS while it is "system". */
export function applyTheme(
  theme: Theme,
  root: HTMLElement = document.documentElement,
  light: LightTheme = loadLightTheme(),
) {
  unlisten?.();
  unlisten = null;
  const media =
    typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const set = () => {
    const resolved = theme === "system" ? (media?.matches ? "dark" : light) : theme;
    root.classList.toggle("dark", resolved === "dark");
    root.classList.toggle("clean", resolved === "clean");
    const look: Look = resolved === "clean" ? "clean" : "medieval";
    if (useLook.getState().look !== look) useLook.setState({ look });
  };
  set();
  if (theme === "system" && media) {
    media.addEventListener("change", set);
    unlisten = () => media.removeEventListener("change", set);
  }
}

export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not persisted; still applied for this session.
  }
  applyTheme(theme);
}

export function saveLightTheme(light: LightTheme) {
  try {
    localStorage.setItem(LIGHT_KEY, light);
  } catch {
    // Not persisted; still applied for this session.
  }
  applyTheme(loadTheme(), document.documentElement, light);
}
