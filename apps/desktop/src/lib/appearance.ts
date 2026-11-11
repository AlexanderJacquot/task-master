// Theme and weathering, applied together. Each window applies them at start; the
// quick-capture window is created hidden when the app starts and lives on, so it also has
// to follow changes made later in the main window (Settings > Appearance).

import { applyTheme, loadTheme } from "./theme";
import { applyWeathering, loadWeathering } from "./weathering";

export function applyAppearance(root: HTMLElement = document.documentElement) {
  applyTheme(loadTheme(), root);
  applyWeathering(loadWeathering(), root);
}

/**
 * Applies the stored appearance now and again whenever another window of the app saves a
 * new one (`storage` events fire in every other same-origin window). Returns a stop function.
 */
export function followAppearance(target: Window = window): () => void {
  applyAppearance(target.document.documentElement);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith("task-master.")) {
      applyAppearance(target.document.documentElement);
    }
  };
  target.addEventListener("storage", onStorage);
  return () => target.removeEventListener("storage", onStorage);
}
