// How the Roadmap chart behaves, remembered per machine (Settings → General → Roadmap).

const DOUBLE_CLICK_KEY = "task-master.roadmap.open-on-double-click";

/** True (the default): double-clicking a bar opens its epic's timeline, or its task. */
export function loadOpenOnDoubleClick(): boolean {
  try {
    return localStorage.getItem(DOUBLE_CLICK_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveOpenOnDoubleClick(open: boolean) {
  try {
    localStorage.setItem(DOUBLE_CLICK_KEY, open ? "1" : "0");
  } catch {
    // Not persisted; the default applies next time.
  }
}
