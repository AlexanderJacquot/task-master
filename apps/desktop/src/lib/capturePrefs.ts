// How adding a task from a view's top row behaves, remembered per machine (Settings →
// Adding tasks), like the theme.

const OPEN_KEY = "task-master.capture.open-in-panel";

/** True (the default): a task added from a view's top row opens in the side panel. */
export function loadOpenInPanel(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveOpenInPanel(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Not persisted; the default applies next time.
  }
}
