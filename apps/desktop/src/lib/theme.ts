// Dark, parchment ("light") or system theme, remembered per machine (settings). Applied as
// a `dark` class on <html> (see index.css), following the OS when set to "system". Dark is
// the default (ADR 008).

export type Theme = "system" | "light" | "dark";

const KEY = "task-master.theme";

export const THEME_LABELS: Record<Theme, string> = {
  dark: "Dark",
  light: "Parchment",
  system: "Follow the system",
};

export function loadTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "system" ? value : "dark";
  } catch {
    return "dark";
  }
}

let unlisten: (() => void) | null = null;

/** Applies `theme` now and keeps following the OS while it is "system". */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement) {
  unlisten?.();
  unlisten = null;
  const media =
    typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const set = () => {
    const dark = theme === "dark" || (theme === "system" && !!media?.matches);
    root.classList.toggle("dark", dark);
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
